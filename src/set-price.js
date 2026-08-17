/**
 * `npm run price` — read and write manual prices without hand-editing JSON.
 *
 *   npm run price                        list every part and its current entry
 *   npm run price cpu 148.99             set by id, or any unambiguous fragment
 *   npm run price cpu-ryzen-7-5700x 149  set by full id
 *   npm run price cpu --clear            back to null
 *
 * Writes config/manual-prices.json in place, preserving its comment block and
 * row order so the file stays reviewable in a diff.
 */
import './lib/fatal.js';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, ConfigError } from './config.js';

const FILE = path.join(CONFIG_DIR, 'manual-prices.json');

function load() {
  if (!fs.existsSync(FILE)) {
    throw new ConfigError(
      `${path.basename(FILE)} not found. Run \`npm run seed\` first, or create it from ` +
        `config/manual-prices.example.json.`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(parsed.prices)) {
    throw new ConfigError(`${path.basename(FILE)} has no "prices" array.`);
  }
  return parsed;
}

/** Exact id first, then a unique substring match, so `cpu` is enough to mean the CPU. */
export function resolvePart(rows, query) {
  const needle = String(query).toLowerCase();

  const exact = rows.find((row) => row.partId.toLowerCase() === needle);
  if (exact) return exact;

  const matches = rows.filter(
    (row) =>
      row.partId.toLowerCase().includes(needle) ||
      String(row.name || '').toLowerCase().includes(needle)
  );

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new ConfigError(
      `No part matches "${query}".\n  Known ids: ${rows.map((r) => r.partId).join(', ')}`
    );
  }
  throw new ConfigError(
    `"${query}" is ambiguous — matches ${matches.map((m) => m.partId).join(', ')}`
  );
}

export function parseAmount(input) {
  // Tolerate a pasted "$1,234.56" as readily as a bare number.
  const cleaned = String(input).replace(/[$£€,\s]/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`"${input}" is not a valid price.`);
  }
  return Math.round(value * 100) / 100;
}

function list(data) {
  const filled = data.prices.filter((r) => r.price != null).length;
  console.log(`\nManual prices — ${filled}/${data.prices.length} filled\n`);
  for (const row of data.prices) {
    const price = row.price == null ? '—' : `$${Number(row.price).toFixed(2)}`;
    console.log(`  ${row.partId.padEnd(26)} ${price.padStart(9)}   ${row.name || ''}`);
  }
  console.log(
    filled === 0
      ? '\n  All blank, so the tracker is still using sample data.\n' +
          '  Set one with:  npm run price cpu 148.99\n'
      : filled < data.prices.length
        ? `\n  ${data.prices.length - filled} still blank — those parts will show as unpriced.\n`
        : '\n  All filled.\n'
  );
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
}

const args = process.argv.slice(2);
const data = load();

if (!args.length) {
  list(data);
  process.exit(0);
}

const row = resolvePart(data.prices, args[0]);

// `npm run price x --clear` never reaches us — npm eats the flag unless you
// write `npm run price -- x --clear`. Accept bare words so that trap is moot.
const CLEAR_WORDS = new Set(['clear', 'none', 'null', 'blank', '-']);
const clearing =
  args.includes('--clear') || (args[1] != null && CLEAR_WORDS.has(args[1].toLowerCase()));

if (!clearing && args.length < 2) {
  throw new ConfigError(
    `Give a price:  npm run price ${row.partId} 148.99\n` +
      `Or clear it:   npm run price ${row.partId} clear`
  );
}

const previous = row.price;
row.price = clearing ? null : parseAmount(args[1]);
row.observedAt = clearing ? undefined : new Date().toISOString().slice(0, 10);
if (row.observedAt === undefined) delete row.observedAt;

save(data);

const was = previous == null ? '—' : `$${Number(previous).toFixed(2)}`;
const now = row.price == null ? '—' : `$${row.price.toFixed(2)}`;
console.log(`${row.partId}: ${was} → ${now}`);

const remaining = data.prices.filter((r) => r.price == null).length;
if (remaining) {
  console.log(
    `${remaining} part${remaining === 1 ? '' : 's'} still blank; ` +
      `those will show as unpriced until filled.`
  );
}
console.log('Run `npm run fetch` to record it, then commit config/manual-prices.json.');
