/**
 * eBay Browse API — official, free, and the right answer for eBay prices.
 * https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
 *
 *   POST https://api.ebay.com/identity/v1/oauth2/token      (client credentials)
 *   GET  https://api.ebay.com/buy/browse/v1/item_summary/search?q=…
 *
 * The legacy Finding API is retired; Browse is its replacement. It reads public
 * listing data, so it needs only an *application* token from the client
 * credentials grant — no user consent, no affiliate account. 5,000 calls a day
 * on the default tier, against the 18 this build makes.
 *
 * eBay is a marketplace, not a retailer, which makes three things load-bearing:
 *
 *   1. Condition. A used 5700X at $120 sitting next to a new one at $203 would
 *      quietly make the build look cheaper than it is. Only NEW counts unless
 *      the config says otherwise.
 *   2. Auctions. A current bid is not a price you can pay, so FIXED_PRICE only.
 *   3. Shipping. eBay prices routinely exclude it while the Amazon prices we
 *      compare against do not, so delivery is added in. A like-for-like total
 *      is the whole point of the column.
 *
 * Env: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET (eBay calls these App ID and Cert ID)
 */
import { config } from '../config.js';
import { politeFetch, fetchJson } from '../lib/http.js';

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';

// A metered API, not a retail page — the 5s scraping floor does not apply.
const MIN_DELAY_MS = 250;

const defaults = {
  marketplace: 'EBAY_US',
  conditions: ['NEW'],
  includeShipping: true,
  // Guards against a search for "Ryzen 7 5700X" matching a $9 sticker: nothing
  // below this fraction of the part's reference price is believable.
  minPriceRatio: 0.4,
  maxPriceRatio: 2.5,
  limit: 20,
};

export const settings = () => ({ ...defaults, ...config.sources?.ebay });

/* ---------- auth ---------- */

// Application tokens last two hours. Cached for the life of the process so a
// nine-part run spends one token request, not nine.
let cached = null;

export function cachedToken(now = Date.now()) {
  return cached && cached.expiresAt > now + 60_000 ? cached.token : null;
}

export function resetToken() {
  cached = null;
}

export async function accessToken() {
  const existing = cachedToken();
  if (existing) return existing;

  const basic = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const res = await politeFetch(TOKEN_URL, {
    method: 'POST',
    minDelayMs: MIN_DELAY_MS,
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
  });

  if (!res.ok) {
    // 400 here is nearly always bad credentials rather than a bad request, and
    // saying so saves an hour of staring at the query string.
    const detail = res.status === 400 || res.status === 401 ? ' — check EBAY_CLIENT_ID/EBAY_CLIENT_SECRET' : '';
    throw new Error(`eBay token request failed: HTTP ${res.status}${detail}`);
  }

  const payload = await res.json();
  if (!payload?.access_token) throw new Error('eBay token response carried no access_token');

  cached = {
    token: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in ?? 7200) * 1000,
  };
  return cached.token;
}

/* ---------- request ---------- */

/**
 * Browse's filter grammar: comma-separated clauses, `{}` around an enumerated
 * set, `[..]` around a range. The price clause needs priceCurrency alongside it
 * or eBay rejects the request.
 */
export function buildFilter({ conditions, buyingOptions = ['FIXED_PRICE'], priceRange, currency = 'USD' }) {
  const clauses = [];
  if (conditions?.length) clauses.push(`conditions:{${conditions.join('|')}}`);
  if (buyingOptions?.length) clauses.push(`buyingOptions:{${buyingOptions.join('|')}}`);
  if (priceRange) {
    const [min, max] = priceRange;
    clauses.push(`price:[${min ?? ''}..${max ?? ''}]`);
    clauses.push(`priceCurrency:${currency}`);
  }
  return clauses.join(',');
}

export function searchUrl(query, options) {
  const opts = { ...defaults, ...options };
  const params = new URLSearchParams({
    q: query,
    limit: String(opts.limit),
    sort: 'price', // cheapest first; we still re-sort by delivered total below
  });
  const filter = buildFilter(opts);
  if (filter) params.set('filter', filter);
  return `${SEARCH_URL}?${params}`;
}

/* ---------- response ---------- */

/**
 * eBay types money as a string, not a number — `"203.00"`, not `203`. Coercing
 * every amount through here is what keeps that from becoming string concatenation
 * the first time a price is added to a shipping cost.
 */
export function amount(money) {
  const value = Number(money?.value);
  return Number.isFinite(value) ? value : null;
}

/**
 * What the item actually costs to have delivered.
 *
 * An absent shippingOptions array means eBay could not calculate delivery for
 * an unknown destination, not that delivery is free — those are skipped rather
 * than counted as zero, which would flatter them into winning "cheapest".
 */
export function deliveredPrice(item, { includeShipping = true } = {}) {
  const price = amount(item?.price);
  if (price == null || price <= 0) return null;
  if (!includeShipping) return { total: price, price, shipping: 0 };

  const options = item?.shippingOptions;
  if (!Array.isArray(options) || !options.length) return null;

  const costs = options.map((o) => amount(o?.shippingCost)).filter((c) => c != null);
  if (!costs.length) return null;

  const shipping = Math.min(...costs);
  return { total: Number((price + shipping).toFixed(2)), price, shipping };
}

export function itemSummaries(payload) {
  return Array.isArray(payload?.itemSummaries) ? payload.itemSummaries : [];
}

/**
 * The cheapest delivered listing that survives the guards.
 *
 * Server-side filters already ask for new fixed-price items, but a filter eBay
 * silently ignores is indistinguishable from one it honoured, so condition and
 * buying option are checked again here. `reference` is the part's target or last
 * known price; without one, the price band is not applied at all rather than
 * guessed at.
 */
export function pickBest(items, { reference = null, options = {} } = {}) {
  const opts = { ...defaults, ...options };
  const priced = [];

  for (const item of items) {
    if (opts.conditions?.length && item?.condition && !opts.conditions.includes(conditionKey(item.condition))) {
      continue;
    }
    if (Array.isArray(item?.buyingOptions) && !item.buyingOptions.includes('FIXED_PRICE')) continue;

    const delivered = deliveredPrice(item, opts);
    if (!delivered) continue;

    if (reference) {
      if (delivered.total < reference * opts.minPriceRatio) continue;
      if (delivered.total > reference * opts.maxPriceRatio) continue;
    }

    priced.push({ item, ...delivered });
  }

  priced.sort((a, b) => a.total - b.total);
  return priced[0] ?? null;
}

/** "New" / "Brand New" / "NEW" all mean the same thing to a buyer. */
function conditionKey(condition) {
  return String(condition).trim().toUpperCase().replace(/^BRAND\s+/, '').replace(/\s+/g, '_');
}

/* ---------- source ---------- */

export default {
  name: 'ebay',
  label: 'eBay Browse API',
  retailer: 'eBay',
  requires: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'],
  notes: 'Free official API. New, fixed-price listings only; delivery included in the price.',

  isConfigured: () => !!(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET),

  async fetch(parts) {
    const opts = settings();
    const targets = [];
    for (const part of parts) {
      const listing = part.listings.find((l) => l.retailer === 'eBay');
      const query = listing?.query || part.name;
      if (listing && query) targets.push({ part, listing, query });
    }
    if (!targets.length) return [];

    const out = [];
    const errors = [];
    const observedAt = new Date().toISOString();

    let token;
    try {
      token = await accessToken();
    } catch (err) {
      // One failure for the whole source, not one per part: the credentials are
      // either right or they are not.
      throw new Error(`ebay: ${err.message}`);
    }

    for (const { part, listing, query } of targets) {
      const reference = config.targets?.[part.id] ?? null;
      const url = searchUrl(query, {
        ...opts,
        priceRange: reference ? [Math.floor(reference * opts.minPriceRatio), null] : null,
      });

      let payload;
      try {
        payload = await fetchJson(url, {
          minDelayMs: MIN_DELAY_MS,
          headers: {
            authorization: `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': opts.marketplace,
            accept: 'application/json',
          },
        });
      } catch (err) {
        errors.push(`ebay: ${part.id} (${err.message})`);
        continue;
      }

      const best = pickBest(itemSummaries(payload), { reference, options: opts });
      if (!best) {
        // Nothing new and fixed-price on the marketplace today is a real answer
        // about eBay, not a failure to record.
        out.push({
          part_id: part.id,
          retailer: 'eBay',
          source: 'ebay',
          price_cents: 0,
          currency: 'USD',
          in_stock: 0,
          url: listing.url ?? null,
          observed_at: observedAt,
        });
        continue;
      }

      out.push({
        part_id: part.id,
        retailer: 'eBay',
        source: 'ebay',
        price_cents: Math.round(best.total * 100),
        currency: best.item.price?.currency || 'USD',
        in_stock: 1,
        url: best.item.itemWebUrl ?? listing.url ?? null,
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
