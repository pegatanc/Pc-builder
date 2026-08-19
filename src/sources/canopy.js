/**
 * Canopy API — Amazon product data over REST.
 * https://www.canopyapi.co/  ·  docs.canopyapi.co
 *
 *   GET https://rest.canopyapi.co/api/amazon/product?asin=<ASIN>
 *   API-KEY: <key>
 *
 * The REST endpoint returns a GraphQL-shaped envelope even though it is REST:
 * the product sits under `data.amazonProduct`, not at the top level, and stock
 * is a plain `isInStock` boolean rather than the `availability.status` object
 * the published examples show. Both were confirmed against the live API. The
 * unwrapping and the field lookups are written defensively so a future flattening
 * of the response, or a rename back to the documented names, keeps working.
 *
 * Env: CANOPY_API_KEY
 */
import { fetchJson } from '../lib/http.js';
import { parsePrice } from '../lib/price.js';

const ENDPOINT = 'https://rest.canopyapi.co/api/amazon/product';

// It's a paid API, not a retail page — the 5s scraping floor is inappropriate.
const MIN_DELAY_MS = 250;

/** Unwraps the `data.amazonProduct` envelope, tolerating an already-flat payload. */
export function product(payload) {
  return payload?.data?.amazonProduct ?? payload?.amazonProduct ?? payload ?? null;
}

/** Tolerates the numeric field or any of the formatted-string spellings. */
export function extractPrice(payload) {
  const price = product(payload)?.price;
  if (!price) return null;

  const numeric = Number(price.value ?? price.amount);
  const value = Number.isFinite(numeric) && numeric > 0
    ? numeric
    : parsePrice(price.displayString ?? price.display ?? price.formatted);

  if (value == null) return null;
  return { value, currency: price.currency || 'USD' };
}

/**
 * The live API answers with a boolean; the documented shape is an availability
 * object. Prefer the boolean, fall back to the object, and treat a payload that
 * says nothing at all as in stock rather than silently zeroing the build.
 */
export function isInStock(payload) {
  const item = product(payload);
  if (typeof item?.isInStock === 'boolean') return item.isInStock;

  const status = item?.availability?.status ?? item?.availability?.displayString;
  if (!status) return true;
  return !/OUT_OF_STOCK|UNAVAILABLE|out of stock|currently unavailable/i.test(String(status));
}

export default {
  name: 'canopy',
  label: 'Canopy API (Amazon)',
  retailer: 'Amazon',
  requires: ['CANOPY_API_KEY'],
  notes: 'Paid REST API. Covers Amazon listings that have an ASIN configured.',

  isConfigured: () => !!process.env.CANOPY_API_KEY,

  async fetch(parts) {
    const targets = [];
    for (const part of parts) {
      const listing = part.listings.find((l) => l.retailer === 'Amazon' && l.asin);
      if (listing) targets.push({ part, listing });
    }
    if (!targets.length) return [];

    const out = [];
    const errors = [];
    const observedAt = new Date().toISOString();

    // One ASIN per request — the endpoint has no batch form.
    for (const { part, listing } of targets) {
      const url = `${ENDPOINT}?asin=${encodeURIComponent(listing.asin)}`;

      let payload;
      try {
        payload = await fetchJson(url, {
          minDelayMs: MIN_DELAY_MS,
          headers: { 'API-KEY': process.env.CANOPY_API_KEY, accept: 'application/json' },
        });
      } catch (err) {
        errors.push(`canopy: ${part.id} (${err.message})`);
        continue;
      }

      const price = extractPrice(payload);
      if (!price) {
        // A live product with no Buy Box price is out of stock, not an error.
        out.push({
          part_id: part.id,
          retailer: 'Amazon',
          source: 'canopy',
          price_cents: 0,
          currency: 'USD',
          in_stock: 0,
          url: product(payload)?.url ?? listing.url ?? null,
          observed_at: observedAt,
        });
        continue;
      }

      out.push({
        part_id: part.id,
        retailer: 'Amazon',
        source: 'canopy',
        price_cents: Math.round(price.value * 100),
        currency: price.currency,
        in_stock: isInStock(payload) ? 1 : 0,
        url: product(payload)?.url ?? listing.url ?? null,
        observed_at: observedAt,
      });
    }

    if (errors.length) {
      const err = new Error(errors.join('; '));
      err.partial = out;
      throw err;
    }
    return out;
  },
};
