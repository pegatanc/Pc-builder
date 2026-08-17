/**
 * Manual prices from config/manual-prices.json.
 *
 * This is the zero-cost path to *real* Amazon numbers: open the product page in
 * a browser like a human, paste what you see, and the tracker keeps the history,
 * stats and alerting exactly as it would for an API-backed source.
 */
import { loadManualPrices } from '../config.js';

export default {
  name: 'manual',
  label: 'Manual entry (config/manual-prices.json)',
  requires: [],
  notes: 'Optional file. Prices you enter by hand; no network access.',

  isConfigured() {
    return loadManualPrices().length > 0;
  },

  async fetch(parts) {
    const known = new Map(parts.map((p) => [p.id, p]));
    const rows = loadManualPrices();
    const out = [];
    const errors = [];

    for (const row of rows) {
      const part = known.get(row.partId);
      if (!part) {
        errors.push(`manual: unknown partId "${row.partId}"`);
        continue;
      }
      const price = Number(row.price);
      if (!Number.isFinite(price) || price <= 0) {
        errors.push(`manual: bad price for "${row.partId}"`);
        continue;
      }

      const listing = part.listings.find((l) => l.retailer === row.retailer);
      const observedAt = row.observedAt ? new Date(row.observedAt) : new Date();

      out.push({
        part_id: part.id,
        retailer: row.retailer || 'Manual',
        source: 'manual',
        price_cents: Math.round(price * 100),
        currency: row.currency || 'USD',
        in_stock: row.inStock === false ? 0 : 1,
        url: row.url ?? listing?.url ?? null,
        observed_at: (Number.isNaN(observedAt.getTime()) ? new Date() : observedAt).toISOString(),
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
