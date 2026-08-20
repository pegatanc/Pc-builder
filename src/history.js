/**
 * Round-trips the state worth keeping — price history and the alternatives
 * snapshot — between SQLite and plain-text NDJSON files.
 *
 * GitHub Actions gets a fresh checkout every run, so the repo has to carry the
 * history. A committed SQLite file would be a fresh ~1MB binary blob per run;
 * NDJSON appends instead, so a twice-daily fetch adds a couple of KB that git
 * stores as a small delta.
 *
 * Import is a merge, not a replace — running it against a populated database
 * won't destroy anything.
 *
 * Price history is append-only, so its file only ever grows. Alternatives are a
 * snapshot per part, so theirs is rewritten wholesale; without it the table
 * starts empty on every CI run, which both hides the suggestions from the
 * published site and defeats the staleness check that keeps the API bill down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { ROOT } from './config.js';
import { seed } from './seed.js';

/**
 * Deliberately NOT inside data/. That directory holds the disposable SQLite
 * database and gets wiped routinely (`rm -rf data` to start over); this file is
 * the committed record and the only copy of the price history, so it lives in
 * its own directory where a reset cannot take it with it.
 */
export const HISTORY_DIR = process.env.HISTORY_DIR || path.join(ROOT, 'history');
export const HISTORY_FILE = path.join(HISTORY_DIR, 'price-history.ndjson');
export const ALTERNATIVES_FILE = path.join(HISTORY_DIR, 'alternatives.ndjson');

/** Non-blank lines, the only shape either file comes in. */
function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
}

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

  const lines = readLines(file);

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

/* ---------- alternatives snapshot ---------- */

const ALT_COLUMNS = [
  'part_id',
  'asin',
  'title',
  'brand',
  'price_cents',
  'currency',
  'url',
  'image_url',
  'rating',
  'ratings_total',
  'discovered_at',
];

export function exportAlternatives(file = ALTERNATIVES_FILE, { log = console.log, force = false } = {}) {
  const rows = db
    .prepare(`SELECT ${ALT_COLUMNS.join(', ')} FROM alternatives ORDER BY part_id, price_cents, asin`)
    .all();

  // Same guard as the price history: a run that discovered nothing must not be
  // able to wipe the committed snapshot.
  if (!rows.length && !force && fs.existsSync(file) && fs.statSync(file).size > 0) {
    throw new Error(
      `refusing to overwrite ${path.basename(file)} with an empty export — ` +
        `the database has no alternatives. Run the import first, or pass --force if this is intended.`
    );
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  log(`[history] exported ${rows.length} alternative(s) → ${path.basename(file)}`);
  return rows.length;
}

/**
 * Restores the snapshot per part. Unlike the price history this is a replace,
 * because a snapshot has no meaningful union: two discoveries a week apart are
 * competing answers to the same question, not two observations.
 *
 * A part is only replaced when the file's snapshot is newer than the database's,
 * so importing a stale file over a fresh local refresh cannot undo it.
 */
export function importAlternatives(file = ALTERNATIVES_FILE, { log = console.log } = {}) {
  seed({ log: () => {} });

  if (!fs.existsSync(file)) {
    log(`[history] no ${path.basename(file)} to import — no alternatives yet.`);
    return 0;
  }

  const known = new Set(db.prepare('SELECT id FROM parts').all().map((r) => r.id));
  const byPart = new Map();
  let skipped = 0;

  for (const [i, line] of readLines(file).entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      log(`[history] skipping malformed line ${i + 1}`);
      skipped++;
      continue;
    }
    // A part dropped from parts.json takes its suggestions with it; the foreign
    // key would reject them anyway, and less loudly than this.
    if (!row.part_id || !known.has(row.part_id)) {
      skipped++;
      continue;
    }
    if (!byPart.has(row.part_id)) byPart.set(row.part_id, []);
    byPart.get(row.part_id).push(row);
  }

  const newestInDb = new Map(
    db
      .prepare('SELECT part_id, MAX(discovered_at) AS newest FROM alternatives GROUP BY part_id')
      .all()
      .map((r) => [r.part_id, r.newest])
  );

  const remove = db.prepare('DELETE FROM alternatives WHERE part_id = ?');
  const insert = db.prepare(
    `INSERT OR REPLACE INTO alternatives (${ALT_COLUMNS.join(', ')})
     VALUES (${ALT_COLUMNS.map((c) => `@${c}`).join(', ')})`
  );

  let imported = 0;

  const run = db.transaction(() => {
    for (const [partId, rows] of byPart) {
      const incoming = rows.reduce((a, r) => (r.discovered_at > a ? r.discovered_at : a), '');
      const current = newestInDb.get(partId);
      if (current && current >= incoming) {
        skipped += rows.length;
        continue;
      }

      remove.run(partId);
      for (const row of rows) {
        insert.run({
          part_id: row.part_id,
          asin: row.asin,
          title: row.title,
          brand: row.brand ?? null,
          price_cents: row.price_cents ?? null,
          currency: row.currency ?? 'USD',
          url: row.url ?? null,
          image_url: row.image_url ?? null,
          rating: row.rating ?? null,
          ratings_total: row.ratings_total ?? null,
          discovered_at: row.discovered_at,
        });
        imported++;
      }
    }
  });

  run();
  log(`[history] imported ${imported} alternative(s)${skipped ? `, ${skipped} skipped` : ''}.`);
  return imported;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  const force = process.argv.includes('--force');
  try {
    // Both files move together: the workflow restores state before fetching and
    // saves it after, and forgetting one is how the alternatives went missing.
    if (mode === 'export') {
      exportHistory(HISTORY_FILE, { force });
      exportAlternatives(ALTERNATIVES_FILE, { force });
    } else if (mode === 'import') {
      importHistory();
      importAlternatives();
    } else {
      console.error('usage: node src/history.js <import|export> [--force]');
      process.exit(1);
    }
  } catch (err) {
    console.error(`[history] ${err.message}`);
    process.exit(1);
  }
}
