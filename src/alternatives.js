/**
 * Discovers alternative products per part using Canopy's Amazon search.
 *
 * This is not a price source: it produces suggestions for parts you might buy
 * instead, not observations for the parts you already track, so it stays out of
 * src/sources/ and the fetch pipeline's registry.
 *
 *   GET https://rest.canopyapi.co/api/amazon/search?searchTerm=<terms>
 *   API-KEY: <key>
 *
 * Endpoint and parameter both confirmed against the live API — Canopy's blog
 * documents `/v1/amazon/search?keywords=`, which 404s. Results arrive under
 * data.amazonProductSearchResults.productResults.results.
 *
 * Cost: one request returns ~26 products, so discovery costs one request per
 * part rather than one per alternative. Combined with the staleness check in
 * refreshAlternatives(), that is roughly 40 requests a month for nine parts.
 */
import { config } from './config.js';
import { db } from './db.js';
import { fetchJson } from './lib/http.js';
import { parsePrice } from './lib/price.js';
import { amazonListingUrl } from './lib/links.js';

const ENDPOINT = 'https://rest.canopyapi.co/api/amazon/search';
const MIN_DELAY_MS = 250;

const defaults = {
  enabled: true,
  perPart: 5,
  refreshDays: 7,
  minRating: 4.0,
  minReviews: 50,
  priceBand: [0.4, 2.5],
};

export const settings = () => ({ ...defaults, ...config.alternatives });

/** Unwraps the search envelope, tolerating a flatter shape if it ever changes. */
export function searchResults(payload) {
  return (
    payload?.data?.amazonProductSearchResults?.productResults?.results ??
    payload?.data?.amazonProductSearchResults?.results ??
    payload?.results ??
    []
  );
}

/** One search hit reduced to the fields worth storing. */
export function normalise(item) {
  if (!item?.asin || !item?.title) return null;
  const value = Number(item.price?.value);
  const price = Number.isFinite(value) && value > 0 ? value : parsePrice(item.price?.display);

  return {
    asin: item.asin,
    title: item.title,
    // The response's own `url` is a search-result link carrying a session id, an
    // expiring `qid` and a tracking blob — or, for an ad, an /sspa/click
    // redirect. Store the canonical product URL instead: it is stable, short,
    // and follows sources.amazonDomain like every other link on the page.
    url: amazonListingUrl({ asin: item.asin }, config.sources.amazonDomain),
    price,
    currency: item.price?.currency || 'USD',
    rating: Number.isFinite(Number(item.rating)) ? Number(item.rating) : null,
    ratingsTotal: Number.isFinite(Number(item.ratingsTotal)) ? Number(item.ratingsTotal) : null,
    imageUrl: item.mainImageUrl ?? null,
    sponsored: !!item.sponsored,
  };
}

/** Middle price of the candidates, used to calibrate the sanity band. */
export function medianPrice(items) {
  const prices = items.map((i) => i?.price).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
}

/**
 * Amazon search returns ads, accessories and no-name listings next to real
 * matches, so this is what decides whether the feature is useful.
 *
 * Sponsored hits are dropped rather than ranked down: in practice they are
 * duplicates of organic results on the same page, so removing them also
 * deduplicates.
 *
 * The price band is anchored on the part's tracked price, or failing that on
 * the median of the results themselves — deliberately NOT on the configured
 * target. A target is a wish, and a stale one silently suppresses everything:
 * the $75 target for 32GB DDR4-3600 rejected every real kit on the page, all of
 * which sit at $179–$250 now that DDR4 is end-of-life. The median is
 * self-calibrating, and still throws out the cables and single sticks that
 * cluster far below whatever the part actually costs.
 */
export function filterCandidates(items, { excludeAsins = [], reference = null, options = {} } = {}) {
  const opts = { ...defaults, ...options };
  const [lowBand, highBand] = opts.priceBand;
  const excluded = new Set(excludeAsins.filter(Boolean));
  const seen = new Set();
  const kept = [];

  const normalised = items.map(normalise).filter(Boolean).filter((i) => !i.sponsored);
  const anchor = reference ?? medianPrice(normalised);

  for (const raw of items) {
    const item = normalise(raw);
    if (!item) continue;
    if (item.sponsored) continue;
    if (excluded.has(item.asin) || seen.has(item.asin)) continue;
    if (item.price == null) continue;

    // Unrated listings are indistinguishable from bad ones; require evidence.
    if (opts.minRating != null && (item.rating == null || item.rating < opts.minRating)) continue;
    if (opts.minReviews != null && (item.ratingsTotal ?? 0) < opts.minReviews) continue;

    if (anchor) {
      if (item.price < anchor * lowBand || item.price > anchor * highBand) continue;
    }

    seen.add(item.asin);
    kept.push(item);
  }

  return kept.sort((a, b) => a.price - b.price).slice(0, opts.perPart);
}

/* ---------- storage ---------- */

const replaceForPart = db.transaction((partId, items, discoveredAt) => {
  db.prepare('DELETE FROM alternatives WHERE part_id = ?').run(partId);
  const insert = db.prepare(`
    INSERT INTO alternatives
      (part_id, asin, title, brand, price_cents, currency, url, image_url, rating, ratings_total, discovered_at)
    VALUES
      (@part_id, @asin, @title, @brand, @price_cents, @currency, @url, @image_url, @rating, @ratings_total, @discovered_at)
  `);
  for (const item of items) {
    insert.run({
      part_id: partId,
      asin: item.asin,
      title: item.title,
      brand: item.brand ?? null,
      price_cents: Math.round(item.price * 100),
      currency: item.currency,
      url: item.url,
      image_url: item.imageUrl,
      rating: item.rating,
      ratings_total: item.ratingsTotal,
      discovered_at: discoveredAt,
    });
  }
});

/** Parts whose newest row is older than refreshDays, or which have none at all. */
export function stalePartIds(partIds, { refreshDays = defaults.refreshDays, now = Date.now() } = {}) {
  const rows = db
    .prepare('SELECT part_id, MAX(discovered_at) AS newest FROM alternatives GROUP BY part_id')
    .all();
  const newest = new Map(rows.map((r) => [r.part_id, r.newest]));
  const cutoff = new Date(now - refreshDays * 86400_000).toISOString();

  return partIds.filter((id) => {
    const seen = newest.get(id);
    return !seen || seen < cutoff;
  });
}

/* ---------- refresh ---------- */

/**
 * @returns {Promise<{requests:number, parts:number, found:number, errors:string[], preview:object[]}>}
 */
export async function refreshAlternatives(parts, { log = console.log, dryRun = false, force = false } = {}) {
  const opts = settings();
  const empty = { requests: 0, parts: 0, found: 0, errors: [], preview: [] };

  if (!opts.enabled) {
    log('[alternatives] disabled in config.');
    return empty;
  }
  if (!process.env.CANOPY_API_KEY) {
    log('[alternatives] no CANOPY_API_KEY — skipping.');
    return empty;
  }

  const due = force || dryRun ? parts : parts.filter((p) => stalePartIds([p.id], opts).length);
  if (!due.length) {
    log(`[alternatives] all ${parts.length} parts refreshed within ${opts.refreshDays} days.`);
    return empty;
  }

  const result = { ...empty, errors: [], preview: [] };
  const discoveredAt = new Date().toISOString();

  for (const part of due) {
    const listing = part.listings?.find((l) => l.retailer === 'Amazon');
    // `altQuery` overrides the tracking query where that makes a poor search —
    // an exact-product query returns near-duplicates, and a query tuned for
    // matching one SKU can drift on capacity or tier when used to find others.
    const terms = listing?.altQuery || listing?.query || part.name;
    if (!terms) continue;

    let payload;
    try {
      result.requests++;
      payload = await fetchJson(`${ENDPOINT}?searchTerm=${encodeURIComponent(terms)}`, {
        minDelayMs: MIN_DELAY_MS,
        headers: { 'API-KEY': process.env.CANOPY_API_KEY, accept: 'application/json' },
      });
    } catch (err) {
      result.errors.push(`alternatives: ${part.id} (${err.message})`);
      continue;
    }

    const raw = searchResults(payload);
    const items = filterCandidates(raw, {
      excludeAsins: (part.listings || []).map((l) => l.asin),
      reference: part.currentPrice ?? null,
      options: opts,
    });

    result.parts++;
    result.found += items.length;
    result.preview.push({ partId: part.id, name: part.name, terms, returned: raw.length, items });

    if (!dryRun) replaceForPart(part.id, items, discoveredAt);
    log(`[alternatives] ${part.id}: ${raw.length} returned → ${items.length} kept`);
  }

  log(
    `[alternatives] ${dryRun ? 'dry run — nothing written. ' : ''}` +
      `${result.requests} request(s), ${result.found} alternative(s) across ${result.parts} part(s)`
  );
  return result;
}
