import { db } from './db.js';
import { loadParts, ConfigError, config } from './config.js';
import { listingUrl } from './lib/links.js';

/**
 * Catches config mistakes here, where we can name the offending entry, rather
 * than letting them surface as an opaque NOT NULL / UNIQUE constraint error.
 */
function validate(parts) {
  const problems = [];
  const seen = new Set();

  parts.forEach((part, i) => {
    const label = part?.id ? `part "${part.id}"` : `parts[${i}]`;

    for (const field of ['id', 'name', 'category']) {
      if (!part?.[field]) problems.push(`${label}: missing "${field}"`);
    }

    if (part?.id) {
      if (seen.has(part.id)) problems.push(`${label}: duplicate id`);
      seen.add(part.id);
    }

    const listings = part?.listings;
    if (listings && !Array.isArray(listings)) {
      problems.push(`${label}: "listings" must be an array`);
      return;
    }

    const retailers = new Set();
    (listings || []).forEach((listing, j) => {
      if (!listing?.retailer) {
        problems.push(`${label}: listings[${j}] is missing "retailer"`);
        return;
      }
      if (retailers.has(listing.retailer)) {
        problems.push(`${label}: duplicate listing for retailer "${listing.retailer}"`);
      }
      retailers.add(listing.retailer);
    });
  });

  if (problems.length) {
    throw new ConfigError(`config/parts.json is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

const upsertPart = db.prepare(`
  INSERT INTO parts (id, name, category, brand, model, spec, sort_order)
  VALUES (@id, @name, @category, @brand, @model, @spec, @sort_order)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    category = excluded.category,
    brand = excluded.brand,
    model = excluded.model,
    spec = excluded.spec,
    sort_order = excluded.sort_order
`);

const upsertListing = db.prepare(`
  INSERT INTO listings (part_id, retailer, asin, sku, query, url, allow_html)
  VALUES (@part_id, @retailer, @asin, @sku, @query, @url, @allow_html)
  ON CONFLICT(part_id, retailer) DO UPDATE SET
    asin = excluded.asin,
    sku = excluded.sku,
    query = excluded.query,
    url = excluded.url,
    allow_html = excluded.allow_html
`);

export function seed({ log = console.log } = {}) {
  const parts = loadParts();
  validate(parts);
  let listingCount = 0;

  const run = db.transaction(() => {
    parts.forEach((part, i) => {
      upsertPart.run({
        id: part.id,
        name: part.name,
        category: part.category,
        brand: part.brand ?? null,
        model: part.model ?? null,
        spec: part.spec ?? null,
        sort_order: i,
      });

      for (const listing of part.listings || []) {
        upsertListing.run({
          part_id: part.id,
          retailer: listing.retailer,
          asin: listing.asin ?? null,
          sku: listing.sku ?? null,
          query: listing.query ?? null,
          // Derived when not given, so every part is clickable in the UI.
          url: listingUrl(listing, { amazonDomain: config.sources.amazonDomain }),
          allow_html: listing.allowHtml ? 1 : 0,
        });
        listingCount++;
      }
    });
  });

  run();
  log(`Seeded ${parts.length} parts / ${listingCount} listings.`);
  return { parts: parts.length, listings: listingCount };
}

// Allow `npm run seed`.
if (import.meta.url === `file://${process.argv[1]}`) {
  seed();
}
