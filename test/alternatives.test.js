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
const {
  searchResults,
  normalise,
  medianPrice,
  filterCandidates,
  stalePartIds,
  refreshAlternatives,
  partSettings,
  compileRejects,
  discoveryFingerprint,
  searchTerms,
} = await import('../src/alternatives.js');
const { db } = await import('../src/db.js');
const { loadParts, config } = await import('../src/config.js');

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

/* ---------- per-part limits ---------- */

test('perPartOverrides raises the cap for one part only', () => {
  const options = { perPart: 8, perPartOverrides: { 'cpu-ryzen-7-5700x': 12 } };
  assert.equal(partSettings('cpu-ryzen-7-5700x', options).perPart, 12);
  assert.equal(partSettings('case-nzxt-h6-flow', options).perPart, 8);
  assert.equal(partSettings('anything', { perPart: 8 }).perPart, 8);
});

test('the configured overrides name parts that exist', () => {
  // A typo here fails silently — the part just keeps the default cap.
  const ids = new Set(loadParts().map((p) => p.id));
  for (const id of Object.keys(config.alternatives.perPartOverrides || {})) {
    assert.ok(ids.has(id), `perPartOverrides names unknown part "${id}"`);
  }
});

/* ---------- compatibility rejects ---------- */

// Real titles from a live search for "AMD Ryzen 7 5700X". The build's board is
// AM4, so the AM5 chips on the same page are not alternatives at any price.
const CPU_TITLES = {
  keep: [
    'AMD Ryzen 7 5800X 8-core, 16-thread unlocked desktop processor',
    'AMD Ryzen™ 7 5800XT 8-Core, 16-Thread Unlocked Desktop Processor',
    'AMD Ryzen 7 5700 8 Cores / 16 Thread 65W TDP Socket AM4 L2+L3 Cache 20MB',
    'AMD Ryzen™ 7 5700G 8-Core, 16-Thread Desktop Processor with Radeon™ Graphics',
    'AMD Ryzen 5 5500 6-Core, 12-Thread Unlocked Desktop Processor',
    'AMD Ryzen™ 9 5900XT 16-Core, 32-Thread Unlocked Desktop Processor',
    'AMD Ryzen 5 5600X 6-core, 12-thread unlocked desktop processor',
    'Ryzen 7 5800X3D 8-core, 16-Thread Desktop Processor with AMD 3D V-Cache',
    'AMD Ryzen 9 3950X 16-Core, 32-Thread Unlocked Desktop Processor',
    'AMD Ryzen 9 5900X 12-core, 24-Thread Unlocked Desktop Processor',
  ],
  drop: [
    'AMD Ryzen 5 7600X 6-Core, 12-Thread Unlocked Desktop Processor',
    'AMD RYZEN 7 9800X3D 8-Core, 16-Thread Desktop Processor',
    'AMD Ryzen™ 5 9600X 6-Core, 12-Thread Unlocked Desktop Processor',
    'AMD Ryzen™ 9 9950X 16-Core, 32-Thread Unlocked Desktop Processor',
    'AMD Ryzen Threadripper 1920X (12-Core/24-Thread) Desktop Processor',
    'Intel Boxed Core I7-6700 FC-LGA14C 3.40 GHz 8 M Processor Cache',
    'Micro Center AMD 5500 Processor with ASUS TUF Gaming A520M Plus Motherboard',
    'GEEKOM GT1 Mega AI Mini PC 14th Gen Intel Ultra9 185H',
  ],
};

test('the AM4 guard keeps same-socket chips and drops the rest', () => {
  const cpu = loadParts().find((p) => p.id === 'cpu-ryzen-7-5700x');
  const patterns = cpu.listings.find((l) => l.retailer === 'Amazon').altReject;
  assert.ok(patterns?.length, 'the CPU listing must carry altReject patterns');

  const items = [...CPU_TITLES.keep, ...CPU_TITLES.drop].map((title, i) => ({
    asin: `A${i}`,
    title,
    price: { value: 200 },
    rating: 4.8,
    ratingsTotal: 5000,
  }));

  const kept = filterCandidates(items, {
    reject: patterns,
    reference: 200,
    options: { perPart: 50 },
  });
  const keptTitles = kept.map((k) => k.title);

  for (const title of CPU_TITLES.keep) {
    assert.ok(keptTitles.includes(title), `should have kept: ${title}`);
  }
  for (const title of CPU_TITLES.drop) {
    assert.ok(!keptTitles.includes(title), `should have dropped: ${title}`);
  }
});

test('an unparseable reject pattern is skipped, not fatal', () => {
  // The patterns are hand-written regex in config; one stray bracket must not
  // take the whole refresh down.
  assert.deepEqual(compileRejects(['('] ).length, 0);
  const kept = filterCandidates(
    [{ asin: 'A', title: 'A fine part', price: { value: 100 }, rating: 4.8, ratingsTotal: 900 }],
    { reject: ['('], options: { perPart: 5 } }
  );
  assert.equal(kept.length, 1, 'a broken pattern must not filter everything out');
});

test('rejects match case-insensitively and only on the title', () => {
  const items = [
    { asin: 'A', title: 'DDR5 memory kit', price: { value: 100 }, rating: 4.8, ratingsTotal: 900 },
    { asin: 'B', title: 'ddr5 memory kit', price: { value: 100 }, rating: 4.8, ratingsTotal: 900 },
    { asin: 'C', title: 'DDR4 memory kit', price: { value: 100 }, rating: 4.8, ratingsTotal: 900 },
  ];
  const kept = filterCandidates(items, { reject: ['ddr5'], options: { perPart: 5 } });
  assert.deepEqual(kept.map((k) => k.asin), ['C']);
});

/* ---------- config changes invalidate the snapshot ---------- */

test('the fingerprint tracks everything that changes what a search returns', () => {
  const base = { terms: 'a cpu', reject: ['ddr5'], options: { perPart: 8, minRating: 4, minReviews: 50, priceBand: [0.4, 2.5] } };
  const same = discoveryFingerprint({ ...base, options: { ...base.options } });
  assert.equal(discoveryFingerprint(base), same, 'equal settings must hash equally');

  const differs = [
    { ...base, terms: 'a different cpu' },
    { ...base, reject: [] },
    { ...base, options: { ...base.options, perPart: 12 } },
    { ...base, options: { ...base.options, minRating: 4.5 } },
    { ...base, options: { ...base.options, minReviews: 10 } },
    { ...base, options: { ...base.options, priceBand: [0.5, 2.5] } },
  ];
  for (const variant of differs) {
    assert.notEqual(discoveryFingerprint(variant), same, `should differ: ${JSON.stringify(variant)}`);
  }
});

test('searchTerms prefers altQuery, then query, then the part name', () => {
  const amazon = (listing) => ({ name: 'Fallback Name', listings: listing ? [listing] : [] });
  assert.equal(searchTerms(amazon({ retailer: 'Amazon', altQuery: 'alt', query: 'q' })).terms, 'alt');
  assert.equal(searchTerms(amazon({ retailer: 'Amazon', query: 'q' })).terms, 'q');
  assert.equal(searchTerms(amazon(null)).terms, 'Fallback Name');
});

test('a part is due again when its discovery settings change', () => {
  // The trap this closes: edit a query or a reject pattern and the snapshot is
  // wrong immediately, but `discovered_at` still says fresh for another week.
  db.prepare(`INSERT INTO parts (id, name, category) VALUES ('psu', 'PSU', 'psu')`).run();
  const now = Date.now();
  db.prepare(
    `INSERT INTO alternatives (part_id, asin, title, discovered_at, config_hash)
     VALUES ('psu', 'A9', 'a psu', ?, 'hash-v1')`
  ).run(new Date(now - 86400_000).toISOString());

  const opts = { refreshDays: 7, now };
  assert.deepEqual(stalePartIds(['psu'], { ...opts, fingerprints: { psu: 'hash-v1' } }), []);
  assert.deepEqual(stalePartIds(['psu'], { ...opts, fingerprints: { psu: 'hash-v2' } }), ['psu']);
  // No fingerprint supplied means "don't judge on settings" — age still applies.
  assert.deepEqual(stalePartIds(['psu'], opts), []);
});

test('a snapshot from before fingerprinting is refreshed once', () => {
  db.prepare(`INSERT INTO parts (id, name, category) VALUES ('fan', 'Fan', 'fan')`).run();
  db.prepare(
    `INSERT INTO alternatives (part_id, asin, title, discovered_at) VALUES ('fan', 'A8', 'a fan', ?)`
  ).run(new Date().toISOString());

  assert.deepEqual(
    stalePartIds(['fan'], { refreshDays: 7, now: Date.now(), fingerprints: { fan: 'hash-v1' } }),
    ['fan'],
    'a NULL stored hash differs from the current one, so it refreshes'
  );
});

test('a 402 stops the run instead of spending a request per part', () => {
  // Out of credit is an account-level failure. Carrying on would count eight
  // more requests, log eight more identical errors, and change nothing.
  const realFetch = globalThis.fetch;
  const realKey = process.env.CANOPY_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 402, statusText: 'Payment Required', text: async () => '', json: async () => ({}) };
  };
  process.env.CANOPY_API_KEY = 'test-key';

  const parts = ['a', 'b', 'c'].map((id) => ({ id, name: `Part ${id}`, listings: [] }));
  return refreshAlternatives(parts, { log: () => {}, dryRun: true })
    .then((result) => {
      assert.equal(result.outOfCredit, true, 'the run must report why it stopped');
      assert.equal(result.requests, 1, 'it must not keep paying for the same error');
      assert.ok(calls <= 3, 'retries are bounded');
    })
    .finally(() => {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.CANOPY_API_KEY;
      else process.env.CANOPY_API_KEY = realKey;
    });
});
