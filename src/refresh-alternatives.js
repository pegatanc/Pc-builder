/**
 * `npm run alternatives` — discover alternative products per part.
 *
 *   npm run alternatives            refresh parts whose snapshot is stale
 *   npm run alternatives dry        preview every part, write nothing
 *   npm run alternatives force      refresh all parts regardless of staleness
 *
 * Each run costs one metered Canopy request per part refreshed, so the request
 * count is reported. (`dry`/`force` are bare words because `npm run` swallows
 * `--flags` before they reach the script.)
 */
import './lib/fatal.js';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { seed } from './seed.js';
import { getTrackedListings, getBuild } from './repo.js';
import { refreshAlternatives, settings } from './alternatives.js';

const args = process.argv.slice(2).map((a) => a.toLowerCase().replace(/^--/, ''));
const dryRun = args.includes('dry') || args.includes('dry-run') || args.includes('preview');
const force = args.includes('force');

seed({ log: () => {} });

// Give the filter a price to judge "same class" against: the configured target
// first, then whatever the part currently costs.
const build = getBuild();
// Only a real observation anchors the price band. A synthetic sample price is
// fiction, and anchoring on it rejects the genuine market: the sample $55.75 for
// the 32GB DDR4 kit filtered out every real kit on the page, which all sit
// around $200. Same principle as purgeSyntheticHistory — demo data must never
// shape a real decision.
const priced = new Map(
  build.items.map((i) => [
    i.id,
    { target: i.target, current: i.best && i.best.source !== 'sample' ? i.best.price : null },
  ])
);

const parts = getTrackedListings().map((part) => ({
  ...part,
  target: priced.get(part.id)?.target ?? null,
  currentPrice: priced.get(part.id)?.current ?? null,
}));

const opts = settings();
console.log(
  `\nSearching alternatives for ${parts.length} parts ` +
    `(keep ${opts.perPart} each, rating ≥${opts.minRating}, ≥${opts.minReviews} reviews, ` +
    `price ${opts.priceBand[0]}×–${opts.priceBand[1]}× reference)\n`
);

const result = await refreshAlternatives(parts, { dryRun, force });

if (dryRun && result.preview.length) {
  // Every dry run spends one metered request per part, so the output is written
  // out too: re-reading the file costs nothing, re-running the command does not.
  const previewFile = path.join(DATA_DIR, 'alternatives-preview.json');
  fs.writeFileSync(previewFile, JSON.stringify(result.preview, null, 2));

  console.log('\n--- preview (nothing written) ---');
  for (const row of result.preview) {
    console.log(`\n${row.name}`);
    console.log(`  search: "${row.terms}"  →  ${row.returned} returned, ${row.items.length} kept`);
    for (const item of row.items) {
      const rating = item.rating ? `${item.rating}★ ${item.ratingsTotal}` : 'unrated';
      console.log(`    $${String(item.price.toFixed(2)).padStart(8)}  ${rating.padEnd(12)} ${item.title.slice(0, 62)}`);
    }
    if (!row.items.length) console.log('    (nothing passed the filters)');
  }
  console.log(`\nSaved to ${previewFile} — read that instead of re-running.\n`);
}

if (result.errors.length) {
  console.error('\nErrors:');
  for (const e of result.errors) console.error(`  - ${e}`);
}

if (result.outOfCredit) {
  console.error(
    '\nThe Canopy account has no credit left, so nothing was refreshed and the\n' +
      'existing suggestions were left untouched. Top it up at https://canopyapi.co\n' +
      'and run this again — every part is already marked for refresh.'
  );
}
process.exit(0);
