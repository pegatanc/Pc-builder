/**
 * History round-trip. These cover the two ways the GitHub Pages workflow could
 * lose data: importing into a fresh database (where the parts catalogue does not
 * exist yet) and exporting from an empty one (which would erase the only copy
 * of the record committed in the repo).
 *
 * Each test runs against its own DATA_DIR in a child process, because the
 * database connection is established at module load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNode(script, dataDir) {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, HISTORY_DIR: dataDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pc-tracker-'));
}

test('import seeds the catalogue so a fresh database accepts observations', () => {
  const dir = tempDir();
  const file = path.join(dir, 'price-history.ndjson');

  fs.writeFileSync(
    file,
    JSON.stringify({
      part_id: 'cpu-ryzen-7-5700x',
      retailer: 'Amazon',
      source: 'manual',
      price_cents: 14899,
      currency: 'USD',
      in_stock: 1,
      url: null,
      observed_at: '2026-08-01T12:00:00.000Z',
    }) + '\n'
  );

  // No seed() call here — importHistory must handle the foreign key itself.
  const out = runNode(
    `import('./src/history.js').then(async (m) => {
       const n = m.importHistory();
       const { db } = await import('./src/db.js');
       const { c } = db.prepare('SELECT COUNT(*) AS c FROM price_history').get();
       console.log(JSON.stringify({ imported: n, rows: c }));
     })`,
    dir
  );

  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { imported: 1, rows: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('re-importing the same file does not duplicate observations', () => {
  const dir = tempDir();
  const file = path.join(dir, 'price-history.ndjson');
  const row = {
    part_id: 'fan-arctic-p12',
    retailer: 'Amazon',
    source: 'manual',
    price_cents: 899,
    currency: 'USD',
    in_stock: 1,
    url: null,
    observed_at: '2026-08-02T12:00:00.000Z',
  };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');

  const out = runNode(
    `import('./src/history.js').then(async (m) => {
       m.importHistory(undefined, { log: () => {} });
       m.importHistory(undefined, { log: () => {} });
       const { db } = await import('./src/db.js');
       const { c } = db.prepare('SELECT COUNT(*) AS c FROM price_history').get();
       console.log(JSON.stringify({ rows: c }));
     })`,
    dir
  );

  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { rows: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('export refuses to overwrite existing history with an empty database', () => {
  const dir = tempDir();
  const file = path.join(dir, 'price-history.ndjson');
  const original =
    JSON.stringify({
      part_id: 'cpu-ryzen-7-5700x',
      retailer: 'Amazon',
      source: 'manual',
      price_cents: 14899,
      currency: 'USD',
      in_stock: 1,
      url: null,
      observed_at: '2026-08-01T12:00:00.000Z',
    }) + '\n';
  fs.writeFileSync(file, original);

  // Export from an empty database: must throw and leave the file untouched.
  const out = runNode(
    `import('./src/history.js').then((m) => {
       let threw = null;
       try { m.exportHistory(undefined, { log: () => {} }); }
       catch (e) { threw = e.message; }
       console.log(JSON.stringify({ threw }));
     })`,
    dir
  );

  const { threw } = JSON.parse(out.trim().split('\n').pop());
  assert.match(threw ?? '', /refusing to overwrite/);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'history file must be unchanged');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a full round-trip preserves every observation', () => {
  const dir = tempDir();

  const out = runNode(
    `import('./src/history.js').then(async (m) => {
       const { seed } = await import('./src/seed.js');
       const { recordObservations } = await import('./src/repo.js');
       seed({ log: () => {} });
       recordObservations([
         { part_id: 'fan-arctic-p12', retailer: 'Amazon', source: 'manual', price_cents: 899,
           currency: 'USD', in_stock: 1, url: null, observed_at: '2026-08-01T12:00:00.000Z' },
         { part_id: 'fan-arctic-p12', retailer: 'Best Buy', source: 'manual', price_cents: 999,
           currency: 'USD', in_stock: 0, url: null, observed_at: '2026-08-02T12:00:00.000Z' },
       ]);
       const written = m.exportHistory(undefined, { log: () => {} });
       const { db } = await import('./src/db.js');
       db.prepare('DELETE FROM price_history').run();
       const read = m.importHistory(undefined, { log: () => {} });
       const rows = db.prepare('SELECT part_id, retailer, price_cents, in_stock FROM price_history ORDER BY observed_at').all();
       console.log(JSON.stringify({ written, read, rows }));
     })`,
    dir
  );

  const result = JSON.parse(out.trim().split('\n').pop());
  assert.equal(result.written, 2);
  assert.equal(result.read, 2);
  assert.deepEqual(result.rows, [
    { part_id: 'fan-arctic-p12', retailer: 'Amazon', price_cents: 899, in_stock: 1 },
    { part_id: 'fan-arctic-p12', retailer: 'Best Buy', price_cents: 999, in_stock: 0 },
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('history from a de-listed retailer stays in the record but not in the build view', () => {
  const dir = tempDir();
  const file = path.join(dir, 'price-history.ndjson');

  // Best Buy was removed from parts.json, but its past observations remain in
  // the history file — and are cheaper, so they would win "cheapest" if shown.
  const rows = [
    { part_id: 'fan-arctic-p12', retailer: 'Amazon', source: 'manual', price_cents: 999,
      currency: 'USD', in_stock: 1, url: null, observed_at: '2026-08-01T12:00:00.000Z' },
    { part_id: 'fan-arctic-p12', retailer: 'Best Buy', source: 'manual', price_cents: 500,
      currency: 'USD', in_stock: 1, url: null, observed_at: '2026-08-01T12:00:00.000Z' },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const out = runNode(
    `import('./src/history.js').then(async (m) => {
       m.importHistory(undefined, { log: () => {} });
       const { db } = await import('./src/db.js');
       const stored = db.prepare('SELECT COUNT(*) AS c FROM price_history').get().c;
       const { getBuild } = await import('./src/repo.js');
       const item = getBuild().items.find((i) => i.id === 'fan-arctic-p12');
       console.log(JSON.stringify({
         stored,
         retailers: item.offers.map((o) => o.retailer),
         bestRetailer: item.best?.retailer ?? null,
         bestPrice: item.best?.price ?? null,
       }));
     })`,
    dir
  );

  const result = JSON.parse(out.trim().split('\n').pop());
  assert.equal(result.stored, 2, 'both observations are kept in the database');
  assert.deepEqual(result.retailers, ['Amazon'], 'only tracked retailers are offered');
  assert.equal(result.bestRetailer, 'Amazon');
  assert.equal(result.bestPrice, 9.99, 'the cheaper de-listed price must not win');
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The alternatives snapshot. Before this round-trip existed, the table started
 * empty on every CI run: the suggestions never reached the published site, and
 * every part looked stale, so the weekly cadence became a search for all nine
 * parts twice a day.
 */
function altLine(overrides = {}) {
  return JSON.stringify({
    part_id: 'cpu-ryzen-7-5700x',
    asin: 'B0TEST0001',
    title: 'A different CPU',
    price_cents: 15999,
    currency: 'USD',
    url: 'https://www.amazon.com/dp/B0TEST0001',
    rating: 4.5,
    ratings_total: 900,
    discovered_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  });
}

test('alternatives survive a fresh database, and the staleness check with them', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'alternatives.ndjson'), altLine() + '\n');

  const out = runNode(
    `
    const { importAlternatives } = await import('./src/history.js');
    const { stalePartIds } = await import('./src/alternatives.js');
    importAlternatives(undefined, { log: () => {} });
    const { db } = await import('./src/db.js');
    const rows = db.prepare('SELECT part_id, asin, price_cents FROM alternatives').all();
    console.log(JSON.stringify({
      rows,
      // Restored from a week-old snapshot: not due yet at 30 days, due at 1.
      dueAt30: stalePartIds(['cpu-ryzen-7-5700x'], { refreshDays: 30 }),
      dueAt1: stalePartIds(['cpu-ryzen-7-5700x'], { refreshDays: 1 }),
    }));
    `,
    dir
  );

  const result = JSON.parse(out.trim().split('\n').pop());
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].asin, 'B0TEST0001');
  assert.equal(result.rows[0].price_cents, 15999);
  assert.deepEqual(result.dueAt30, [], 'a restored snapshot must not look stale');
  assert.deepEqual(result.dueAt1, ['cpu-ryzen-7-5700x'], 'and must still expire on schedule');
});

test('a stale snapshot never overwrites a fresher one', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'alternatives.ndjson'), altLine() + '\n');

  const out = runNode(
    `
    const { importAlternatives } = await import('./src/history.js');
    const { db } = await import('./src/db.js');
    const { seed } = await import('./src/seed.js');
    seed({ log: () => {} });
    db.prepare(\`INSERT INTO alternatives (part_id, asin, title, price_cents, discovered_at)
                VALUES ('cpu-ryzen-7-5700x', 'B0FRESH001', 'Discovered later', 9999, '2026-08-15T00:00:00.000Z')\`).run();
    importAlternatives(undefined, { log: () => {} });
    console.log(JSON.stringify(db.prepare('SELECT asin FROM alternatives').all()));
    `,
    dir
  );

  const rows = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(rows.map((r) => r.asin), ['B0FRESH001'], 'the newer local refresh must win');
});

test('exporting an empty table refuses to erase a populated snapshot', () => {
  const dir = tempDir();
  const file = path.join(dir, 'alternatives.ndjson');
  fs.writeFileSync(file, altLine() + '\n');

  assert.throws(
    () =>
      runNode(
        `
        const { exportAlternatives } = await import('./src/history.js');
        exportAlternatives(undefined, { log: () => {} });
        `,
        dir
      ),
    /refusing to overwrite/
  );
  assert.ok(fs.readFileSync(file, 'utf8').includes('B0TEST0001'), 'the file must be untouched');
});

test('an alternative for a part no longer in the catalogue is dropped', () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'alternatives.ndjson'),
    [altLine(), altLine({ part_id: 'part-that-was-removed', asin: 'B0GONE0001' })].join('\n') + '\n'
  );

  const out = runNode(
    `
    const { importAlternatives } = await import('./src/history.js');
    const { db } = await import('./src/db.js');
    importAlternatives(undefined, { log: () => {} });
    console.log(JSON.stringify(db.prepare('SELECT part_id FROM alternatives').all()));
    `,
    dir
  );

  const rows = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(rows.map((r) => r.part_id), ['cpu-ryzen-7-5700x']);
});
