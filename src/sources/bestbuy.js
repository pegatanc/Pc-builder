/**
 * Best Buy Developer API — free key, documented, no scraping.
 * https://developer.bestbuy.com/
 *
 * Gives real US retail prices for the generic parts (RAM kit, PSU, SSD) where
 * an Amazon ASIN was never pinned down, and a second retailer to compare
 * against for everything else.
 *
 * Env: BESTBUY_API_KEY
 */
import { fetchJson } from '../lib/http.js';

const BASE = 'https://api.bestbuy.com/v1/products';
const SHOW = 'sku,name,salePrice,regularPrice,onlineAvailability,url';

/** Best Buy's query syntax ANDs repeated `search=` terms. */
function buildSearch(query) {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9 .+-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 6);
  return terms.map((t) => `search=${encodeURIComponent(t)}`).join('&');
}

export default {
  name: 'bestbuy',
  label: 'Best Buy API',
  retailer: 'Best Buy',
  requires: ['BESTBUY_API_KEY'],
  notes: 'Free API key. Matches listings by SKU, or by search terms when no SKU is set.',

  isConfigured: () => !!process.env.BESTBUY_API_KEY,

  async fetch(parts) {
    const out = [];
    const errors = [];
    const observedAt = new Date().toISOString();

    for (const part of parts) {
      const listing = part.listings.find((l) => l.retailer === 'Best Buy');
      if (!listing || (!listing.sku && !listing.query)) continue;

      const selector = listing.sku ? `(sku=${listing.sku})` : `(${buildSearch(listing.query)})`;
      const url =
        `${BASE}${selector}?apiKey=${encodeURIComponent(process.env.BESTBUY_API_KEY)}` +
        `&format=json&show=${SHOW}&pageSize=5&sort=salePrice.asc`;

      let payload;
      try {
        payload = await fetchJson(url);
      } catch (err) {
        errors.push(`bestbuy: ${part.id} (${err.message})`);
        continue;
      }

      const product = (payload.products || []).find((p) => Number(p.salePrice) > 0);
      if (!product) {
        errors.push(`bestbuy: no match for ${part.id}`);
        continue;
      }

      out.push({
        part_id: part.id,
        retailer: 'Best Buy',
        source: 'bestbuy',
        price_cents: Math.round(Number(product.salePrice) * 100),
        currency: 'USD',
        in_stock: product.onlineAvailability === false ? 0 : 1,
        url: product.url ?? listing.url ?? null,
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
