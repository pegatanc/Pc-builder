import { db } from './db.js';
import { loadParts } from './config.js';

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
          url: listing.url ?? null,
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
