/**
 * Round-trips price history between SQLite and a plain-text NDJSON file.
 *
 * GitHub Actions gets a fresh checkout every run, so the repo has to carry the
 * history. A committed SQLite file would be a fresh ~1MB binary blob per run;
 * NDJSON appends instead, so a twice-daily fetch adds a couple of KB that git
 * stores as a small delta.
 *
 * Import is a merge, not a replace — running it against a populated database
 * won't destroy anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { seed } from './seed.js';

export const HISTORY_FILE = path.join(DATA_DIR, 'price-history.ndjson');

const COLUMNS = [
  'part_id',
  'retailer',
  'source',
  'price_cents',
  'currency',
  'in_stock',
  'url',
  'observed_at',
];

export function exportHistory(file = HISTORY_FILE, { log = console.log, force = false } = {}) {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS.join(', ')} FROM price_history
       ORDER BY observed_at, part_id, retailer, id`
    )
    .all();

  // Refuse to replace a populated history with nothing. In CI this file is the
  // only copy of the record, and a failed fetch must not be able to erase it.
  if (!rows.length && !force && fs.existsSync(file) && fs.statSync(file).size > 0) {
    throw new Error(
      `refusing to overwrite ${path.basename(file)} with an empty export — ` +
        `the database has no observations. Run the import first, or pass --force if this is intended.`
    );
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  log(`[history] exported ${rows.length} observation(s) → ${path.basename(file)}`);
  return rows.length;
}

export function importHistory(file = HISTORY_FILE, { log = console.log } = {}) {
  // price_history.part_id is a foreign key into parts, so the catalogue has to
  // exist before any observation can be inserted into a fresh database.
  seed({ log: () => {} });

  if (!fs.existsSync(file)) {
    log(`[history] no ${path.basename(file)} to import — starting empty.`);
    return 0;
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());

  // Natural key: the same observation re-imported must not duplicate.
  const exists = db.prepare(
    `SELECT 1 FROM price_history
     WHERE part_id = ? AND retailer = ? AND source = ? AND observed_at = ? AND price_cents = ?
     LIMIT 1`
  );
  const insert = db.prepare(
    `INSERT INTO price_history (${COLUMNS.join(', ')})
     VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`
  );

  let imported = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const [i, line] of lines.entries()) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        log(`[history] skipping malformed line ${i + 1}`);
        skipped++;
        continue;
      }

      if (exists.get(row.part_id, row.retailer, row.source, row.observed_at, row.price_cents)) {
        skipped++;
        continue;
      }

      insert.run({
        part_id: row.part_id,
        retailer: row.retailer,
        source: row.source,
        price_cents: row.price_cents,
        currency: row.currency ?? 'USD',
        in_stock: row.in_stock ?? 1,
        url: row.url ?? null,
        observed_at: row.observed_at,
      });
      imported++;
    }
  });

  run();
  log(`[history] imported ${imported} observation(s)${skipped ? `, ${skipped} already present` : ''}.`);
  return imported;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  try {
    if (mode === 'export') exportHistory(HISTORY_FILE, { force: process.argv.includes('--force') });
    else if (mode === 'import') importHistory();
    else {
      console.error('usage: node src/history.js <import|export> [--force]');
      process.exit(1);
    }
  } catch (err) {
    console.error(`[history] ${err.message}`);
    process.exit(1);
  }
}
