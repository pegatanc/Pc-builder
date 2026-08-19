/**
 * Canopy API — Amazon product data over REST.
 * https://www.canopyapi.co/  ·  docs.canopyapi.co
 *
 *   GET https://rest.canopyapi.co/api/amazon/product?asin=<ASIN>
 *   API-KEY: <key>
 *
 * The price object carries a numeric `value` alongside a formatted string, and
 * availability comes back as a status like "IN_STOCK". Field naming has varied
 * between the marketing examples and the docs (`display` vs `displayString`),
 * so the numeric value is preferred and the formatted string is only parsed as
 * a fallback.
 *
 * Env: CANOPY_API_KEY
 */
import { fetchJson } from '../lib/http.js';
import { parsePrice } from '../lib/price.js';

const ENDPOINT = 'https://rest.canopyapi.co/api/amazon/product';

// It's a paid API, not a retail page — the 5s scraping floor is inappropriate.
const MIN_DELAY_MS = 250;

/** Tolerates either the numeric field or the display string. */
export function extractPrice(payload) {
  const price = payload?.price;
  if (!price) return null;

  const numeric = Number(price.value ?? price.amount);
  const value = Number.isFinite(numeric) && numeric > 0
    ? numeric
    : parsePrice(price.displayString ?? price.display ?? price.formatted);

  if (value == null) return null;
  return { value, currency: price.currency || 'USD' };
}

/** Absent availability is treated as in stock; only an explicit negative isn't. */
export function isInStock(payload) {
  const status = payload?.availability?.status ?? payload?.availability?.displayString;
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
          url: payload?.url ?? listing.url ?? null,
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
        url: payload?.url ?? listing.url ?? null,
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
