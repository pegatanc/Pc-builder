/**
 * Deterministic synthetic prices so the app is useful the moment you clone it,
 * with zero API keys. Prices are a seeded walk around a plausible street price,
 * so restarts reproduce the same history rather than inventing new noise.
 *
 * This is demo data. The UI badges it as such — never mistake it for a real quote.
 */

const BASE_PRICES = {
  'cpu-ryzen-7-5700x': 159,
  'mobo-msi-b550-tomahawk': 169,
  'ram-ddr4-3600-cl16-32gb': 79,
  'ssd-sk-hynix-p41-1tb': 89,
  'psu-750w-gold-modular': 99,
  'gpu-asrock-rx-7900-xt': 649,
  'cooler-hyper-212-black': 39,
  'case-nzxt-h6-flow': 109,
  'fan-arctic-p12': 9,
};

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const unit = (str) => hash(str) / 0xffffffff;

const dayIndex = (date) => Math.floor(date.getTime() / 86400_000);

const TODAY = () => dayIndex(new Date());

function priceFor(partId, retailer, date) {
  const base = BASE_PRICES[partId] ?? 50;
  const day = dayIndex(date);
  const seed = unit(partId) * Math.PI * 2;

  // Two overlapping slow waves so the trend wanders instead of looking periodic.
  const drift = 0.05 * Math.sin(day / 17 + seed) + 0.025 * Math.sin(day / 6 + seed * 3);

  // Prices move in steps, not every day: hold for a few days, then re-roll.
  const step = Math.floor(day / 4);
  const jitter = (unit(`${partId}:${retailer}:${step}`) - 0.5) * 0.02;

  // A brief sale every few weeks.
  const promo = hash(`${partId}:${retailer}:promo:${step}`) % 17 === 0 ? -0.07 : 0;

  // Each retailer sits at its own price level per part, so the cheapest
  // retailer differs across the build rather than always being the same one.
  const bias = 0.97 + unit(`${partId}:${retailer}:bias`) * 0.08;

  // One rotating "deal of the day", applied only to the current day so history
  // stays clean and the drop alert has a genuine dip to detect.
  const partIds = Object.keys(BASE_PRICES);
  const isDeal =
    day === TODAY() &&
    retailer === 'Amazon' &&
    partIds[hash(`deal:${day}`) % partIds.length] === partId;

  const price = base * bias * (1 + drift + jitter + promo) * (isDeal ? 0.82 : 1);
  return Math.max(1, Math.round(price * 100) / 100);
}

function observationsFor(parts, date) {
  const out = [];
  for (const part of parts) {
    if (!(part.id in BASE_PRICES)) continue;
    for (const listing of part.listings) {
      out.push({
        part_id: part.id,
        retailer: listing.retailer,
        source: 'sample',
        price_cents: Math.round(priceFor(part.id, listing.retailer, date) * 100),
        currency: 'USD',
        in_stock: 1,
        url: listing.url ?? null,
        observed_at: date.toISOString(),
      });
    }
  }
  return out;
}

export default {
  name: 'sample',
  label: 'Sample data (synthetic)',
  synthetic: true,
  requires: [],
  notes: 'Deterministic demo prices. Configure a real source to replace it.',

  isConfigured: () => true,

  async fetch(parts) {
    return observationsFor(parts, new Date());
  },

  /** Backfills history so the sparkline and 30-day average work on first run. */
  backfill(parts, days) {
    const out = [];
    for (let i = days; i >= 1; i--) {
      const date = new Date(Date.now() - i * 86400_000);
      date.setUTCHours(12, 0, 0, 0);
      out.push(...observationsFor(parts, date));
    }
    return out;
  },
};
