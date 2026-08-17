/**
 * Keepa API — the pragmatic way to get Amazon prices without scraping.
 * https://keepa.com/#!discuss/t/product-object/116
 *
 * Needs KEEPA_API_KEY. Keepa returns prices in cents already; -1 means
 * "no offer". Index 0 of stats.current is Amazon itself, index 1 is the
 * cheapest new marketplace offer — we take the cheaper of the two.
 */
import { fetchJson } from '../lib/http.js';

const DOMAIN = Number(process.env.KEEPA_DOMAIN || 1); // 1 = amazon.com
const AMAZON = 0;
const NEW = 1;

export default {
  name: 'keepa',
  label: 'Keepa API (Amazon)',
  retailer: 'Amazon',
  requires: ['KEEPA_API_KEY'],
  notes: 'Paid API. Covers Amazon listings that have an ASIN configured.',

  isConfigured: () => !!process.env.KEEPA_API_KEY,

  async fetch(parts) {
    const targets = [];
    for (const part of parts) {
      const listing = part.listings.find((l) => l.retailer === 'Amazon' && l.asin);
      if (listing) targets.push({ part, listing });
    }
    if (!targets.length) return [];

    const out = [];
    const errors = [];

    // Keepa accepts up to 100 ASINs per call; batch conservatively.
    for (let i = 0; i < targets.length; i += 20) {
      const batch = targets.slice(i, i + 20);
      const asins = batch.map((t) => t.listing.asin).join(',');
      const url =
        `https://api.keepa.com/product?key=${encodeURIComponent(process.env.KEEPA_API_KEY)}` +
        `&domain=${DOMAIN}&asin=${asins}&stats=1&history=0`;

      let payload;
      try {
        payload = await fetchJson(url);
      } catch (err) {
        errors.push(`keepa: batch failed (${err.message})`);
        continue;
      }

      const byAsin = new Map((payload.products || []).map((p) => [p.asin, p]));
      const observedAt = new Date().toISOString();

      for (const { part, listing } of batch) {
        const product = byAsin.get(listing.asin);
        if (!product) {
          errors.push(`keepa: no product for ${listing.asin}`);
          continue;
        }

        const current = product.stats?.current || [];
        const candidates = [current[AMAZON], current[NEW]].filter((c) => Number.isFinite(c) && c > 0);
        if (!candidates.length) {
          out.push({
            part_id: part.id,
            retailer: 'Amazon',
            source: 'keepa',
            price_cents: 0,
            currency: 'USD',
            in_stock: 0,
            url: listing.url ?? `https://www.amazon.com/dp/${listing.asin}`,
            observed_at: observedAt,
          });
          continue;
        }

        out.push({
          part_id: part.id,
          retailer: 'Amazon',
          source: 'keepa',
          price_cents: Math.min(...candidates),
          currency: 'USD',
          in_stock: 1,
          url: listing.url ?? `https://www.amazon.com/dp/${listing.asin}`,
          observed_at: observedAt,
        });
      }
    }

    if (errors.length) {
      const err = new Error(errors.join('; '));
      err.partial = out;
      throw err;
    }
    return out;
  },
};
