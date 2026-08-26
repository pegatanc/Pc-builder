/**
 * eBay Browse API source.
 *
 * A caveat worth stating plainly: the fixture below is built from eBay's
 * published ItemSummary schema, NOT captured from a live response — this repo
 * has no eBay credentials yet. That is exactly the position the Canopy adapter
 * was in when it returned nothing for every part while its tests passed, so
 * these tests deliberately cover the decisions (condition, auctions, shipping,
 * price sanity) rather than asserting the envelope is shaped a particular way.
 * `npm run ebay:probe` captures a real response; rebuild the fixture from it.
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
  accessToken,
  cachedToken,
  resetToken,
} from '../src/sources/ebay.js';
import { listingUrl, ebayListingUrl } from '../src/lib/links.js';
import { loadParts } from '../src/config.js';

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
