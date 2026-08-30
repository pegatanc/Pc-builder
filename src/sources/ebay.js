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
 * Nothing identifying an eBay user or an individual listing is stored. Each
 * observation keeps a price, a currency, a timestamp and a link to the filtered
 * search — no seller, no item id, no item URL. eBay's Marketplace Account
 * Deletion exemption is declared on that basis, so keep it true.
 *
 * Env: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET (eBay calls these App ID and Cert ID)
 */
import { config } from '../config.js';
import { politeFetch, fetchJson } from '../lib/http.js';

/*
 * Sandbox speaks the same API version and returns the same envelope as
 * production, so it is the way to verify the adapter's field names without
 * production access. What it does NOT have is real inventory — its listings are
 * synthetic test data — so it is a verification tool, never a price source.
 * `EBAY_ENV=sandbox` switches hosts; the scope is the same string either way.
 */
const HOSTS = {
  production: 'https://api.ebay.com',
  sandbox: 'https://api.sandbox.ebay.com',
};

export function environment() {
  return String(process.env.EBAY_ENV || 'production').toLowerCase() === 'sandbox'
    ? 'sandbox'
    : 'production';
}

export const isSandbox = () => environment() === 'sandbox';

const host = () => HOSTS[environment()];
export const tokenUrl = () => `${host()}/identity/v1/oauth2/token`;
export const browseUrl = () => `${host()}/buy/browse/v1/item_summary/search`;

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

/**
 * eBay cannot price CALCULATED shipping without knowing where it is going, and
 * returns the option with no cost at all — which this source treats as unknown
 * and skips. Seen live: both SK hynix P41 listings on the page were CALCULATED,
 * so the part got no eBay price whatsoever.
 *
 * Setting EBAY_POSTAL_CODE makes eBay do the sum. It stays an env var rather
 * than config because a home postcode has no business in a public repo; unset
 * simply means today's behaviour.
 */
export function endUserContext() {
  const zip = process.env.EBAY_POSTAL_CODE?.trim();
  const country = (process.env.EBAY_COUNTRY || 'US').trim();
  if (!zip) return null;
  return `contextualLocation=${encodeURIComponent(`country=${country},zip=${zip}`)}`;
}

/** The headers every Browse call needs, given a token. */
export function browseHeaders(token, marketplace) {
  const headers = {
    authorization: `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID': marketplace,
    accept: 'application/json',
  };
  const context = endUserContext();
  if (context) headers['X-EBAY-C-ENDUSERCTX'] = context;
  return headers;
}

/* ---------- auth ---------- */

// Application tokens last two hours. Cached for the life of the process so a
// nine-part run spends one token request, not nine.
let cached = null;

export function cachedToken(now = Date.now()) {
  // Sandbox and production have separate credentials, so a token minted for one
  // is worthless to the other — the environment is part of the cache key.
  if (cached?.environment !== environment()) return null;
  return cached.expiresAt > now + 60_000 ? cached.token : null;
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

  const res = await politeFetch(tokenUrl(), {
    method: 'POST',
    minDelayMs: MIN_DELAY_MS,
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
  });

  if (!res.ok) {
    // A 400/401 here is never a malformed request — it means eBay would not
    // accept the pair. Observed with credentials that were transcribed
    // correctly, so the message names the other cause too: a production keyset
    // that exists in the portal but is not yet active for the account.
    const detail =
      res.status === 400 || res.status === 401
        ? ' — eBay rejected the credentials. Check EBAY_CLIENT_ID/EBAY_CLIENT_SECRET, and that the' +
          ' production keyset is active (account verified, API License Agreement accepted).'
        : '';
    throw new Error(`eBay token request failed: HTTP ${res.status}${detail}`);
  }

  const payload = await res.json();
  if (!payload?.access_token) throw new Error('eBay token response carried no access_token');

  cached = {
    token: payload.access_token,
    environment: environment(),
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
  return `${browseUrl()}?${params}`;
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
 * Server-side filters already ask for new fixed-price items, but re-checking
 * here is not paranoia: a live search sent with `conditions:{NEW}` came back
 * with Open box items in it. eBay's condition filter groups condition IDs more
 * loosely than the name suggests, so condition and buying option are checked
 * again against each item. `reference` is the part's target or last
 * known price; without one, the price band is not applied at all rather than
 * guessed at.
 */
export function pickBest(items, { reference = null, options = {} } = {}) {
  const opts = { ...defaults, ...options };
  const candidates = [];

  for (const item of items) {
    if (opts.conditions?.length && item?.condition && !opts.conditions.includes(conditionKey(item.condition))) {
      continue;
    }
    if (Array.isArray(item?.buyingOptions) && !item.buyingOptions.includes('FIXED_PRICE')) continue;

    // A multi-variant listing quotes its cheapest variant, which is often a
    // different product entirely. Seen live: one listing titled "RYZEN 9 5900X
    // R7 5800X 5700X 5700GE R5 5600X 5600GE Pro 5650GE 4650G AM4 CPU" quoted
    // $109.80 while every genuine 5700X on the page was $176-185. It passed the
    // price band, and would have been recorded as the 5700X's price. eBay marks
    // these with itemGroupType; a plain listing has no such field.
    if (item?.itemGroupType) continue;

    const delivered = deliveredPrice(item, opts);
    if (!delivered) continue;
    candidates.push({ item, ...delivered });
  }

  // The band needs something to measure against. A configured target is the
  // best answer; failing that, the middle of the page — the same trick
  // alternatives.js uses, and for the same reason. Keyword search puts
  // accessories next to the product: a live search for "AMD Ryzen 7 5700X"
  // returned a $21.99 CPU cooler alongside chips at $176-185, and with no
  // anchor at all the cheapest-wins rule would record the cooler as the CPU.
  const anchor = reference ?? medianTotal(candidates);

  const priced = anchor
    ? candidates.filter(
        (c) => c.total >= anchor * opts.minPriceRatio && c.total <= anchor * opts.maxPriceRatio
      )
    : candidates;

  priced.sort((a, b) => a.total - b.total);
  return priced[0] ?? null;
}

/** Middle delivered price of the candidates, used when no target is configured. */
export function medianTotal(candidates) {
  const totals = candidates.map((c) => c.total).sort((a, b) => a - b);
  if (!totals.length) return null;
  const mid = Math.floor(totals.length / 2);
  return totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
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
  get notes() {
    return isSandbox()
      ? 'EBAY_ENV=sandbox — verification only, records no prices (sandbox listings are test data).'
      : 'Free official API. New, fixed-price listings only; delivery included in the price.';
  },

  isConfigured: () => !!(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET),

  async fetch(parts) {
    // Sandbox listings are invented test data. Recording them as observations
    // would put fiction in the price history and skew the 30-day average the
    // drop alert is measured against — the same reason the sample source stands
    // down as soon as a real one can run.
    if (isSandbox()) {
      console.warn('[ebay] EBAY_ENV=sandbox — verification only, recording no prices.');
      return [];
    }
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
          headers: browseHeaders(token, opts.marketplace),
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
        // Deliberately the filtered search, not best.item.itemWebUrl. Two
        // reasons, and the second is the one that matters: the cheapest listing
        // today is gone next week, so a stored item URL rots — and recording
        // one would persist data about a specific eBay listing, which this
        // application declares to eBay that it does not do. The price is a
        // number; the link is a place to look.
        url: listing.url ?? null,
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
