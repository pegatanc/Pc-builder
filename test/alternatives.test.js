/**
 * Alternatives discovery. The fixture is a real Canopy search response for the
 * PSU query — 10 results, 3 of them sponsored — so these tests check the code
 * against what the API actually sends rather than against what the docs say.
 * The last adapter written from docs alone returned nothing for every part.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Importing the module opens a database, so point it at a scratch directory
// before the import runs. Hoisted static imports would be too late.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-test-'));
process.env.DATA_DIR = dataDir;
const { searchResults, normalise, medianPrice, filterCandidates, stalePartIds, refreshAlternatives } =
  await import('../src/alternatives.js');
const { db } = await import('../src/db.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/canopy-search.json'), 'utf8'));
const raw = searchResults(payload);

/* ---------- parsing ---------- */

test('unwraps the live search envelope', () => {
  assert.equal(raw.length, 10);
  assert.ok(raw.every((r) => r.asin));
});

test('tolerates a flatter envelope and an empty response', () => {
  assert.deepEqual(searchResults({ results: [{ asin: 'X' }] }), [{ asin: 'X' }]);
  assert.deepEqual(searchResults({}), []);
  assert.deepEqual(searchResults(null), []);
});

test('normalises a search hit to the stored fields', () => {
  const item = normalise(raw[0]);
  assert.equal(item.asin, 'B0FBX9VS3B');
  assert.equal(item.price, 89.9);
  assert.equal(item.currency, 'USD');
  assert.equal(item.rating, 4.6);
  assert.equal(item.ratingsTotal, 155);
  assert.equal(item.sponsored, true);
});

test('normalise falls back to the display string when value is missing', () => {
  const item = normalise({ asin: 'A1', title: 'Thing', price: { display: '$129.99' } });
  assert.equal(item.price, 129.99);
});

test('normalise rejects hits without an asin or title', () => {
  assert.equal(normalise({ title: 'no asin' }), null);
  assert.equal(normalise({ asin: 'A1' }), null);
  assert.equal(normalise(null), null);
});

test('normalise stores the canonical product url, not the search link', () => {
  // The live response hands back a search-result URL with an expiring qid and a
  // tracking blob, and an /sspa/click redirect for ads. Neither is worth keeping.
  const hit = raw.find((r) => r.url?.includes('/sspa/click')) ?? raw[0];
  assert.equal(normalise(hit).url, `https://www.amazon.com/dp/${hit.asin}`);
  assert.equal(
    normalise({ asin: 'B000000001', title: 'Thing', price: { value: 10 } }).url,
    'https://www.amazon.com/dp/B000000001'
  );
});

/* ---------- the price anchor ---------- */

test('medianPrice ignores unpriced entries', () => {
  assert.equal(medianPrice([{ price: 10 }, { price: null }, { price: 30 }]), 20);
  assert.equal(medianPrice([{ price: 10 }, { price: 20 }, { price: 30 }]), 20);
  assert.equal(medianPrice([{ price: null }]), null);
});

/* ---------- filtering ---------- */

const permissive = { minRating: null, minReviews: null, perPart: 50, priceBand: [0, Infinity] };

test('drops sponsored results, keeping the organic copy where there is one', () => {
  // Two of the three sponsored hits in this real page reappear further down as
  // organic results — dropping the ad does not lose the product, it removes the
  // duplicate. Only the ad-exclusive one disappears entirely.
  const kept = filterCandidates(raw, { options: permissive });
  const sponsored = raw.filter((r) => r.sponsored).map((r) => r.asin);
  const organic = new Set(raw.filter((r) => !r.sponsored).map((r) => r.asin));
  assert.equal(sponsored.length, 3, 'fixture should carry sponsored hits');

  for (const asin of sponsored) {
    const alsoOrganic = organic.has(asin);
    assert.equal(
      kept.some((k) => k.asin === asin),
      alsoOrganic,
      `${asin} was ${alsoOrganic ? 'organic too and should survive' : 'ad-only and should be dropped'}`
    );
  }
  assert.ok(!kept.some((k) => k.asin === 'B0C6T6XB36'), 'the ad-only hit must be dropped');
});

test('drops the part you already track and any duplicate asin', () => {
  const own = raw.find((r) => !r.sponsored).asin;
  const kept = filterCandidates(raw, { excludeAsins: [own, null], options: permissive });
  assert.ok(!kept.some((k) => k.asin === own));

  const doubled = filterCandidates([...raw, ...raw], { options: permissive });
  assert.equal(new Set(doubled.map((k) => k.asin)).size, doubled.length);
});

test('applies the rating and review floors', () => {
  const items = [
    { asin: 'A', title: 'good', price: { value: 100 }, rating: 4.5, ratingsTotal: 900 },
    { asin: 'B', title: 'poorly rated', price: { value: 100 }, rating: 3.2, ratingsTotal: 900 },
    { asin: 'C', title: 'barely reviewed', price: { value: 100 }, rating: 4.8, ratingsTotal: 4 },
    { asin: 'D', title: 'unrated', price: { value: 100 }, ratingsTotal: 900 },
  ];
  const kept = filterCandidates(items, { options: { ...permissive, minRating: 4, minReviews: 50 } });
  assert.deepEqual(kept.map((k) => k.asin), ['A']);
});

test('the band is anchored on the tracked price when there is one', () => {
  const items = [
    { asin: 'A', title: 'cable', price: { value: 9 }, rating: 4.6, ratingsTotal: 900 },
    { asin: 'B', title: 'psu', price: { value: 95 }, rating: 4.6, ratingsTotal: 900 },
    { asin: 'C', title: 'workstation psu', price: { value: 600 }, rating: 4.6, ratingsTotal: 900 },
  ];
  const kept = filterCandidates(items, { reference: 100, options: { perPart: 50 } });
  assert.deepEqual(kept.map((k) => k.asin), ['B'], 'accessories and far-dearer items are out');
});

test('with no tracked price the band calibrates on the median of the results', () => {
  // This is the RAM failure: a stale $75 target rejected every real kit on the
  // page. The median is self-calibrating, so the market sets its own scale.
  const items = [180, 199, 210, 240, 9].map((value, i) => ({
    asin: `A${i}`,
    title: `kit ${i}`,
    price: { value },
    rating: 4.5,
    ratingsTotal: 900,
  }));
  const kept = filterCandidates(items, { options: { perPart: 50 } });
  assert.deepEqual(kept.map((k) => k.price), [180, 199, 210, 240], 'the $9 accessory is out');
});

test('unpriced results never survive', () => {
  const kept = filterCandidates([{ asin: 'A', title: 'no price', rating: 4.9, ratingsTotal: 900 }], {
    options: permissive,
  });
  assert.deepEqual(kept, []);
});

test('returns cheapest first, capped at perPart', () => {
  const kept = filterCandidates(raw, { options: { ...permissive, perPart: 3 } });
  assert.equal(kept.length, 3);
  assert.deepEqual([...kept].sort((a, b) => a.price - b.price), kept);
});

test('the defaults keep real results from a real search', () => {
  // The point of the feature: with shipped defaults the PSU query still yields
  // suggestions. A filter that rejects everything is the failure mode here.
  const kept = filterCandidates(raw, { reference: 99.99 });
  assert.ok(kept.length >= 3, `expected several alternatives, got ${kept.length}`);
  assert.ok(kept.every((k) => k.price >= 99.99 * 0.4 && k.price <= 99.99 * 2.5));
});

/* ---------- staleness ---------- */

test('parts are due when never discovered or older than refreshDays', () => {
  db.prepare(`INSERT INTO parts (id, name, category) VALUES ('cpu', 'CPU', 'cpu'), ('gpu', 'GPU', 'gpu')`).run();
  const insert = db.prepare(`
    INSERT INTO alternatives (part_id, asin, title, discovered_at) VALUES (?, ?, ?, ?)
  `);
  const now = Date.now();
  const daysAgo = (d) => new Date(now - d * 86400_000).toISOString();
  insert.run('cpu', 'A1', 'fresh', daysAgo(2));
  insert.run('gpu', 'A2', 'stale', daysAgo(30));

  assert.deepEqual(stalePartIds(['cpu', 'gpu', 'psu'], { refreshDays: 7, now }), ['gpu', 'psu']);
  assert.deepEqual(stalePartIds(['cpu', 'gpu'], { refreshDays: 60, now }), []);
});

/* ---------- cost ---------- */

test('discovery costs one request per part, not one per alternative', async () => {
  // The whole cost argument for this feature rests on this: a search returns
  // ~26 products for the price of a single product lookup. If it ever became
  // one request per candidate the monthly bill would go up roughly 25×.
  const calls = [];
  const realFetch = globalThis.fetch;
  const realKey = process.env.CANOPY_API_KEY;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => payload, text: async () => '' };
  };
  process.env.CANOPY_API_KEY = 'test-key';

  try {
    const parts = [
      { id: 'a', name: 'Part A', listings: [{ retailer: 'Amazon', query: 'part a' }] },
      { id: 'b', name: 'Part B', listings: [{ retailer: 'Amazon', altQuery: 'better terms for b' }] },
      { id: 'c', name: 'Part C', listings: [] },
    ];
    const result = await refreshAlternatives(parts, { log: () => {}, dryRun: true });

    assert.equal(calls.length, 3, 'one search per part');
    assert.equal(result.requests, 3, 'the reported count must match what was sent');
    assert.ok(result.found > 3, 'each request should yield several alternatives');
    // altQuery wins over query, and the part name is the last resort.
    assert.match(calls[1], /better\+terms\+for\+b|better%20terms%20for%20b/);
    assert.match(calls[2], /Part(\+|%20)C/);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.CANOPY_API_KEY;
    else process.env.CANOPY_API_KEY = realKey;
  }
});

test('discovery skips silently without an api key', async () => {
  const realKey = process.env.CANOPY_API_KEY;
  delete process.env.CANOPY_API_KEY;
  try {
    const result = await refreshAlternatives([{ id: 'a', name: 'A', listings: [] }], { log: () => {} });
    assert.equal(result.requests, 0);
  } finally {
    if (realKey !== undefined) process.env.CANOPY_API_KEY = realKey;
  }
});
