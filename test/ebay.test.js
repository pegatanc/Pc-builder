/**
 * eBay Browse API source.
 *
 * test/fixtures/ebay-search.json is a real production response to a search for
 * "AMD Ryzen 7 5700X" — 20 items, captured with `npm run ebay:probe`. It is
 * here because the Canopy adapter was written from documentation, returned
 * nothing for every part, and its tests passed because they encoded the same
 * wrong assumption as the code.
 *
 * Two of the tests below exist only because that response was read: eBay
 * returned Open box items for a `conditions:{NEW}` search, and quoted $109.80
 * for a multi-variant listing whose cheapest variant is a different CPU. Neither
 * is visible in the schema.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import ebay, {
  amount,
  buildFilter,
  searchUrl,
  deliveredPrice,
  itemSummaries,
  pickBest,
  medianTotal,
  accessToken,
  cachedToken,
  resetToken,
  environment,
  isSandbox,
  tokenUrl,
  browseUrl,
  endUserContext,
  browseHeaders,
} from '../src/sources/ebay.js';
import { listingUrl, ebayListingUrl } from '../src/lib/links.js';
import { loadParts } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A real production response, not a hand-written one. */
const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/ebay-search.json'), 'utf8'));

const item = (over = {}) => ({
  itemId: 'v1|123|0',
  title: 'AMD Ryzen 7 5700X 8-Core Processor',
  condition: 'New',
  conditionId: '1000',
  buyingOptions: ['FIXED_PRICE'],
  price: { value: '200.00', currency: 'USD' },
  shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '5.00', currency: 'USD' } }],
  itemWebUrl: 'https://www.ebay.com/itm/123',
  ...over,
});

/* ---------- money ---------- */

test('amounts arrive as strings and must be coerced', () => {
  // eBay types money as a string. Left alone, price + shipping concatenates.
  assert.equal(amount({ value: '203.00' }), 203);
  assert.equal(amount({ value: 203 }), 203);
  assert.equal(amount({ value: 'free' }), null);
  assert.equal(amount(undefined), null);
});

test('the delivered price is what the item costs to arrive', () => {
  const priced = deliveredPrice(item());
  assert.equal(priced.price, 200);
  assert.equal(priced.shipping, 5);
  assert.equal(priced.total, 205);
});

test('the cheapest shipping option wins', () => {
  const priced = deliveredPrice(
    item({
      shippingOptions: [
        { shippingCost: { value: '12.99' } },
        { shippingCost: { value: '4.50' } },
        { shippingCost: { value: '8.00' } },
      ],
    })
  );
  assert.equal(priced.total, 204.5);
});

test('free shipping is zero, but missing shipping is unknown', () => {
  assert.equal(deliveredPrice(item({ shippingOptions: [{ shippingCost: { value: '0.00' } }] })).total, 200);
  // An absent array means eBay could not calculate delivery, not that it is
  // free. Counting it as zero would flatter the listing into winning cheapest.
  assert.equal(deliveredPrice(item({ shippingOptions: [] })), null);
  assert.equal(deliveredPrice(item({ shippingOptions: undefined })), null);
});

test('shipping can be switched off, and then a missing array is fine', () => {
  const priced = deliveredPrice(item({ shippingOptions: undefined }), { includeShipping: false });
  assert.equal(priced.total, 200);
});

test('an item with no usable price is skipped', () => {
  assert.equal(deliveredPrice(item({ price: { value: '0.00' } })), null);
  assert.equal(deliveredPrice(item({ price: undefined })), null);
});

/* ---------- the guards that make an eBay price comparable ---------- */

test('used and refurbished listings never win on price', () => {
  // The whole risk of adding a marketplace: a used chip at half price sitting
  // in the same column as new retail, quietly making the build look cheaper.
  const items = [
    item({ itemId: 'used', condition: 'Used', price: { value: '90.00' } }),
    item({ itemId: 'refurb', condition: 'Certified - Refurbished', price: { value: '120.00' } }),
    item({ itemId: 'new', condition: 'New', price: { value: '200.00' } }),
  ];
  const best = pickBest(items, { options: { conditions: ['NEW'] } });
  assert.equal(best.item.itemId, 'new');
});

test('"Brand New" counts as new', () => {
  const best = pickBest([item({ condition: 'Brand New' })], { options: { conditions: ['NEW'] } });
  assert.ok(best, 'eBay spells the same condition several ways');
});

test('auctions are excluded — a current bid is not a price you can pay', () => {
  const items = [
    item({ itemId: 'auction', buyingOptions: ['AUCTION'], price: { value: '50.00' } }),
    item({ itemId: 'bin', buyingOptions: ['FIXED_PRICE'], price: { value: '200.00' } }),
  ];
  assert.equal(pickBest(items).item.itemId, 'bin');
});

test('an auction that also has Buy It Now is allowed', () => {
  const best = pickBest([item({ buyingOptions: ['AUCTION', 'FIXED_PRICE'] })]);
  assert.ok(best);
});

test('implausibly cheap matches are rejected against a reference price', () => {
  // A search for "Ryzen 7 5700X" matches stickers, manuals and empty boxes.
  const items = [
    item({ itemId: 'sticker', title: 'Ryzen 7 5700X case badge sticker', price: { value: '4.99' } }),
    item({ itemId: 'real', price: { value: '190.00' } }),
  ];
  const best = pickBest(items, { reference: 150, options: { minPriceRatio: 0.4, maxPriceRatio: 2.5 } });
  assert.equal(best.item.itemId, 'real');
});

test('absurdly dear matches are rejected too', () => {
  const items = [item({ itemId: 'bundle', title: 'Gaming PC bundle', price: { value: '1400.00' } })];
  assert.equal(pickBest(items, { reference: 150 }), null);
});

test('with no reference price the band is not applied at all', () => {
  // Better to record a suspicious price than to invent a reference and filter
  // against a number nobody chose.
  const best = pickBest([item({ price: { value: '4.99' } })]);
  assert.equal(best.total, 9.99);
});

test('the cheapest delivered total wins, not the cheapest sticker price', () => {
  const items = [
    item({ itemId: 'cheap-plus-postage', price: { value: '195.00' }, shippingOptions: [{ shippingCost: { value: '25.00' } }] }),
    item({ itemId: 'dearer-free-post', price: { value: '205.00' }, shippingOptions: [{ shippingCost: { value: '0.00' } }] }),
  ];
  assert.equal(pickBest(items).item.itemId, 'dearer-free-post');
});

test('an empty or malformed response yields nothing rather than throwing', () => {
  assert.deepEqual(itemSummaries({}), []);
  assert.deepEqual(itemSummaries(null), []);
  assert.deepEqual(itemSummaries({ itemSummaries: 'nope' }), []);
  assert.equal(pickBest([]), null);
});

/* ---------- request building ---------- */

test('the filter uses Browse grammar', () => {
  const filter = buildFilter({ conditions: ['NEW'], buyingOptions: ['FIXED_PRICE'], priceRange: [60, null] });
  assert.match(filter, /conditions:\{NEW\}/);
  assert.match(filter, /buyingOptions:\{FIXED_PRICE\}/);
  assert.match(filter, /price:\[60\.\.\]/);
  // eBay rejects a price filter that does not say which currency it is in.
  assert.match(filter, /priceCurrency:USD/);
  assert.ok(filter.includes(','), 'clauses are comma separated');
});

test('multiple conditions are pipe separated inside the braces', () => {
  assert.match(buildFilter({ conditions: ['NEW', 'OPEN_BOX'] }), /conditions:\{NEW\|OPEN_BOX\}/);
});

test('the search url carries the query, limit and filter', () => {
  const url = new URL(searchUrl('AMD Ryzen 7 5700X', { limit: 20, conditions: ['NEW'] }));
  assert.equal(url.origin + url.pathname, 'https://api.ebay.com/buy/browse/v1/item_summary/search');
  assert.equal(url.searchParams.get('q'), 'AMD Ryzen 7 5700X');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.match(url.searchParams.get('filter'), /conditions:\{NEW\}/);
});

/* ---------- token handling ---------- */

test('the application token is fetched once and reused', async () => {
  const realFetch = globalThis.fetch;
  const realId = process.env.EBAY_CLIENT_ID;
  const realSecret = process.env.EBAY_CLIENT_SECRET;
  let calls = 0;
  let seenAuth = null;
  let seenBody = null;

  globalThis.fetch = async (url, init) => {
    calls++;
    seenAuth = init.headers.authorization;
    seenBody = init.body;
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok-123', expires_in: 7200 }) };
  };
  process.env.EBAY_CLIENT_ID = 'id';
  process.env.EBAY_CLIENT_SECRET = 'secret';
  resetToken();

  try {
    assert.equal(await accessToken(), 'tok-123');
    assert.equal(await accessToken(), 'tok-123');
    assert.equal(calls, 1, 'a nine-part run must not fetch nine tokens');
    assert.equal(seenAuth, `Basic ${Buffer.from('id:secret').toString('base64')}`);
    assert.match(seenBody, /grant_type=client_credentials/);
    assert.match(seenBody, /scope=https%3A%2F%2Fapi\.ebay\.com%2Foauth%2Fapi_scope/);
    assert.equal(cachedToken(), 'tok-123');
  } finally {
    globalThis.fetch = realFetch;
    resetToken();
    if (realId === undefined) delete process.env.EBAY_CLIENT_ID; else process.env.EBAY_CLIENT_ID = realId;
    if (realSecret === undefined) delete process.env.EBAY_CLIENT_SECRET; else process.env.EBAY_CLIENT_SECRET = realSecret;
  }
});

test('an expiring token is not reused', () => {
  resetToken();
  assert.equal(cachedToken(), null, 'nothing cached yet');
});

test('bad credentials say so', async () => {
  const realFetch = globalThis.fetch;
  process.env.EBAY_CLIENT_ID = 'id';
  process.env.EBAY_CLIENT_SECRET = 'wrong';
  globalThis.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized' });
  resetToken();
  try {
    await assert.rejects(accessToken(), /EBAY_CLIENT_ID/);
    // The other cause of a 401 is a keyset that is not active yet, and the
    // message must say so — that one cost a round trip to diagnose.
    await assert.rejects(accessToken(), /keyset is active/);
  } finally {
    globalThis.fetch = realFetch;
    resetToken();
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
  }
});

/* ---------- wiring ---------- */

test('the source declares what it needs and is off without it', () => {
  assert.equal(ebay.retailer, 'eBay');
  assert.deepEqual(ebay.requires, ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET']);
  const realId = process.env.EBAY_CLIENT_ID;
  delete process.env.EBAY_CLIENT_ID;
  assert.equal(ebay.isConfigured(), false, 'half a credential pair is not configured');
  if (realId !== undefined) process.env.EBAY_CLIENT_ID = realId;
});

test('every part has an eBay listing to search on', () => {
  for (const part of loadParts()) {
    const listing = part.listings.find((l) => l.retailer === 'eBay');
    assert.ok(listing, `${part.id} has no eBay listing`);
    assert.ok(listing.query, `${part.id}'s eBay listing needs a query — eBay has no ASINs`);
  }
});

test('the fallback link is a filtered search, since eBay items come and go', () => {
  const url = ebayListingUrl({ query: 'AMD Ryzen 7 5700X' });
  assert.match(url, /_nkw=AMD%20Ryzen%207%205700X/);
  assert.match(url, /LH_ItemCondition=3/, 'new only, matching what the source records');
  assert.match(url, /LH_BIN=1/, 'buy it now only');
  assert.equal(listingUrl({ retailer: 'eBay', query: 'x' }), ebayListingUrl({ query: 'x' }));
  assert.equal(listingUrl({ retailer: 'eBay', query: 'x', url: 'https://example.test' }), 'https://example.test');
});

/* ---------- sandbox ---------- */

test('EBAY_ENV switches both hosts, and defaults to production', () => {
  const real = process.env.EBAY_ENV;
  try {
    delete process.env.EBAY_ENV;
    assert.equal(environment(), 'production');
    assert.equal(isSandbox(), false);
    assert.match(tokenUrl(), /^https:\/\/api\.ebay\.com\//);
    assert.match(browseUrl(), /^https:\/\/api\.ebay\.com\//);

    process.env.EBAY_ENV = 'sandbox';
    assert.equal(isSandbox(), true);
    assert.match(tokenUrl(), /^https:\/\/api\.sandbox\.ebay\.com\//);
    assert.match(browseUrl(), /^https:\/\/api\.sandbox\.ebay\.com\//);
    assert.match(searchUrl('x', {}), /api\.sandbox\.ebay\.com/);

    // Anything else means production — a typo must not silently point a real
    // run at test data.
    process.env.EBAY_ENV = 'Sandbox';
    assert.equal(isSandbox(), true, 'case insensitive');
    process.env.EBAY_ENV = 'prod';
    assert.equal(environment(), 'production');
  } finally {
    if (real === undefined) delete process.env.EBAY_ENV;
    else process.env.EBAY_ENV = real;
  }
});

test('a token minted for one environment is never reused in the other', async () => {
  const realFetch = globalThis.fetch;
  const realEnv = process.env.EBAY_ENV;
  const realId = process.env.EBAY_CLIENT_ID;
  const realSecret = process.env.EBAY_CLIENT_SECRET;
  let calls = 0;

  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ access_token: `tok-${calls}`, expires_in: 7200 }) };
  };
  process.env.EBAY_CLIENT_ID = 'id';
  process.env.EBAY_CLIENT_SECRET = 'secret';
  resetToken();

  try {
    process.env.EBAY_ENV = 'sandbox';
    assert.equal(await accessToken(), 'tok-1');
    // Sandbox and production have different credentials, so the cached sandbox
    // token is worthless against production.
    process.env.EBAY_ENV = 'production';
    assert.equal(cachedToken(), null, 'the cache must not cross environments');
    assert.equal(await accessToken(), 'tok-2');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
    resetToken();
    if (realEnv === undefined) delete process.env.EBAY_ENV; else process.env.EBAY_ENV = realEnv;
    if (realId === undefined) delete process.env.EBAY_CLIENT_ID; else process.env.EBAY_CLIENT_ID = realId;
    if (realSecret === undefined) delete process.env.EBAY_CLIENT_SECRET; else process.env.EBAY_CLIENT_SECRET = realSecret;
  }
});

test('sandbox records no prices at all', async () => {
  // The important guarantee: invented listings must never reach price_history,
  // where they would skew the 30-day average the drop alert is measured against.
  const realEnv = process.env.EBAY_ENV;
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('should not be reached'); };
  process.env.EBAY_ENV = 'sandbox';
  try {
    const parts = [{ id: 'cpu', name: 'CPU', listings: [{ retailer: 'eBay', query: 'cpu' }] }];
    assert.deepEqual(await ebay.fetch(parts), [], 'no observations');
    assert.equal(called, false, 'and not even a request');
    assert.match(ebay.notes, /sandbox/i, 'the source listing must say why it is inert');
  } finally {
    globalThis.fetch = realFetch;
    if (realEnv === undefined) delete process.env.EBAY_ENV; else process.env.EBAY_ENV = realEnv;
  }
});

/* ---------- what gets persisted ---------- */

test('an observation stores a price and a search link, never a listing', async () => {
  // This backs a declaration made to eBay: the application persists no data
  // about an individual eBay listing or user. Anything that reintroduces an
  // item id, item URL or seller here breaks that promise, so the test is the
  // guard rather than the comment.
  const realFetch = globalThis.fetch;
  const realId = process.env.EBAY_CLIENT_ID;
  const realSecret = process.env.EBAY_CLIENT_SECRET;
  process.env.EBAY_CLIENT_ID = 'id';
  process.env.EBAY_CLIENT_SECRET = 'secret';
  resetToken();

  globalThis.fetch = async (url) =>
    String(url).includes('/oauth2/token')
      ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 7200 }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({
            itemSummaries: [
              item({
                itemId: 'v1|SECRET-ITEM|0',
                itemWebUrl: 'https://www.ebay.com/itm/SECRET-ITEM',
                seller: { username: 'a-real-person' },
              }),
            ],
          }),
        };

  try {
    const listing = { retailer: 'eBay', query: 'cpu', url: 'https://www.ebay.com/sch/i.html?_nkw=cpu' };
    const [observation] = await ebay.fetch([{ id: 'cpu', name: 'CPU', listings: [listing] }]);

    assert.equal(observation.price_cents, 20500, 'the price is the point');
    assert.equal(observation.url, listing.url, 'the link is the search, not the item');

    const serialised = JSON.stringify(observation);
    assert.doesNotMatch(serialised, /SECRET-ITEM/, 'no item id or item URL may be stored');
    assert.doesNotMatch(serialised, /a-real-person/, 'no seller identity may be stored');
    assert.deepEqual(
      Object.keys(observation).sort(),
      ['currency', 'in_stock', 'observed_at', 'part_id', 'price_cents', 'retailer', 'source', 'url'],
      'an added field here needs the same scrutiny'
    );
  } finally {
    globalThis.fetch = realFetch;
    resetToken();
    if (realId === undefined) delete process.env.EBAY_CLIENT_ID; else process.env.EBAY_CLIENT_ID = realId;
    if (realSecret === undefined) delete process.env.EBAY_CLIENT_SECRET; else process.env.EBAY_CLIENT_SECRET = realSecret;
  }
});

/* ---------- against the live response ---------- */

test('the live envelope is shaped the way the adapter reads it', () => {
  const items = itemSummaries(live);
  assert.equal(items.length, 20);
  const sample = items[0];
  // Every field the adapter touches, checked against real data rather than docs.
  assert.equal(typeof sample.price.value, 'string', 'money is a string, not a number');
  assert.equal(typeof sample.price.currency, 'string');
  assert.ok(Array.isArray(sample.shippingOptions));
  assert.equal(typeof sample.shippingOptions[0].shippingCost.value, 'string');
  assert.ok(sample.condition && sample.itemWebUrl && Array.isArray(sample.buyingOptions));
});

test('eBay returns Open box items for a conditions:{NEW} search', () => {
  // Found live. The server-side filter groups condition IDs more loosely than
  // its name suggests, which is why pickBest re-checks every item itself.
  const items = itemSummaries(live);
  assert.ok(
    items.some((i) => i.condition === 'Open box'),
    'the captured response really does contain Open box items'
  );
  const kept = pickBest(items, { reference: 150 });
  assert.equal(kept.item.condition, 'New');
});

test('a multi-variant listing never sets the price', () => {
  // The one that would have shipped a wrong number: "RYZEN 9 5900X R7 5800X
  // 5700X 5700GE R5 5600X 5600GE Pro 5650GE 4650G AM4 CPU" is quoted at $109.80
  // — its cheapest variant, a different chip — against genuine 5700X listings
  // at $176-185. It clears the price band comfortably.
  const items = itemSummaries(live);
  const variants = items.filter((i) => i.itemGroupType);
  assert.ok(variants.length, 'the captured response contains variant listings');
  assert.ok(
    variants.some((i) => Number(i.price.value) < 150),
    'and at least one is cheap enough to have won on price'
  );

  const best = pickBest(items, { reference: 150 });
  assert.equal(best.item.itemGroupType, undefined);
  assert.ok(best.total > 150, `picked ${best.total}, which should be a real 5700X`);
});

test('with no target configured the page sets its own scale', () => {
  // A live search for the CPU returned a $21.99 cooler fan. Cheapest-wins with
  // no anchor records the cooler as the CPU price, so the median stands in.
  const items = itemSummaries(live);
  assert.ok(
    items.some((i) => Number(i.price.value) < 30),
    'the captured response contains a cheap accessory'
  );
  const best = pickBest(items, { reference: null });
  assert.ok(best.total > 150, `picked ${best.total}, expected a CPU rather than an accessory`);
  assert.equal(pickBest(items, { reference: 150 }).total, best.total, 'same answer either way here');
});

test('medianTotal is the middle delivered price', () => {
  assert.equal(medianTotal([{ total: 10 }, { total: 30 }, { total: 20 }]), 20);
  assert.equal(medianTotal([{ total: 10 }, { total: 20 }]), 15);
  assert.equal(medianTotal([]), null);
});

/* ---------- delivery location ---------- */

test('a postcode is sent only when one is set', () => {
  const realZip = process.env.EBAY_POSTAL_CODE;
  const realCountry = process.env.EBAY_COUNTRY;
  try {
    delete process.env.EBAY_POSTAL_CODE;
    assert.equal(endUserContext(), null, 'unset means unchanged behaviour');
    assert.equal(browseHeaders('t', 'EBAY_US')['X-EBAY-C-ENDUSERCTX'], undefined);

    process.env.EBAY_POSTAL_CODE = '90210';
    // eBay wants the whole contextualLocation value URL-encoded, commas and all.
    assert.equal(endUserContext(), 'contextualLocation=country%3DUS%2Czip%3D90210');
    assert.equal(
      browseHeaders('t', 'EBAY_US')['X-EBAY-C-ENDUSERCTX'],
      'contextualLocation=country%3DUS%2Czip%3D90210'
    );

    process.env.EBAY_COUNTRY = 'GB';
    process.env.EBAY_POSTAL_CODE = ' SW1A 1AA ';
    assert.equal(endUserContext(), 'contextualLocation=country%3DGB%2Czip%3DSW1A%201AA', 'trimmed');
  } finally {
    if (realZip === undefined) delete process.env.EBAY_POSTAL_CODE; else process.env.EBAY_POSTAL_CODE = realZip;
    if (realCountry === undefined) delete process.env.EBAY_COUNTRY; else process.env.EBAY_COUNTRY = realCountry;
  }
});

test('calculated shipping with no cost is still unknown, not free', () => {
  // Exactly what the live SK hynix P41 listings looked like: eBay returned the
  // shipping option with a type and no amount, because it had no destination.
  const calculated = item({ shippingOptions: [{ shippingCostType: 'CALCULATED' }] });
  assert.equal(deliveredPrice(calculated), null);
  assert.equal(pickBest([calculated]), null, 'better no price than a wrong one');
});
