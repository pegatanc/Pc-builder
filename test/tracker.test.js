import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, selectGroup, isAllowedBy } from '../src/lib/robots.js';
import { findOffer } from '../src/sources/jsonld.js';
import { parsePrice } from '../src/lib/price.js';
import { amazonListingUrl, listingUrl, isProductUrl } from '../src/lib/links.js';
import { loadParts } from '../src/config.js';
import {
  extractPrice as extractCanopyPrice,
  isInStock as canopyInStock,
} from '../src/sources/canopy.js';

/**
 * robots.txt handling — the gate that keeps the HTML source honest. These
 * cases mirror the shape of a real retailer robots.txt, including a named
 * crawler group that is blocked outright while `*` is allowed.
 */
const ROBOTS = `
# comment
User-agent: *
Disallow: /checkout/
Disallow: /dp/rate-this-item/
Allow: /dp/
Crawl-delay: 4

User-agent: SomeBot
User-agent: OtherBot
Disallow: /

User-agent: PartialBot
Disallow:
`;

test('parses groups, rules and crawl-delay', () => {
  const groups = parseRobots(ROBOTS);
  assert.equal(groups.length, 3);

  const wildcard = groups[0];
  assert.deepEqual(wildcard.agents, ['*']);
  assert.equal(wildcard.crawlDelay, 4);
  assert.equal(wildcard.rules.length, 3);

  // Consecutive User-agent lines share one group.
  assert.deepEqual(groups[1].agents, ['somebot', 'otherbot']);
});

test('an empty Disallow means allow everything', () => {
  const groups = parseRobots(ROBOTS);
  assert.equal(groups[2].rules.length, 0);
  assert.equal(isAllowedBy(groups[2], '/anything'), true);
});

test('selects the most specific matching user-agent group', () => {
  const groups = parseRobots(ROBOTS);
  assert.deepEqual(selectGroup(groups, 'SomeBot/2.0').agents, ['somebot', 'otherbot']);
  assert.deepEqual(selectGroup(groups, 'price-tracker/1.0').agents, ['*']);
});

test('a named crawler blocked with Disallow: / is refused everywhere', () => {
  const group = selectGroup(parseRobots(ROBOTS), 'OtherBot');
  assert.equal(isAllowedBy(group, '/dp/B09VCHQHZ6'), false);
  assert.equal(isAllowedBy(group, '/'), false);
});

test('longest matching rule wins, Allow beats Disallow at equal length', () => {
  const group = selectGroup(parseRobots(ROBOTS), 'price-tracker/1.0');
  assert.equal(isAllowedBy(group, '/dp/B09VCHQHZ6'), true, 'product page allowed');
  assert.equal(isAllowedBy(group, '/dp/rate-this-item/x'), false, 'longer Disallow wins');
  assert.equal(isAllowedBy(group, '/checkout/cart'), false);
  assert.equal(isAllowedBy(group, '/some/other/path'), true, 'unmatched path defaults to allowed');
});

test('supports * and $ wildcards', () => {
  const group = selectGroup(parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b'), 'x');
  assert.equal(isAllowedBy(group, '/files/manual.pdf'), false);
  assert.equal(isAllowedBy(group, '/files/manual.pdf?x=1'), true, '$ anchors the end');
  assert.equal(isAllowedBy(group, '/a/anything/b'), false);
});

/** JSON-LD offer extraction. */
test('finds the cheapest offer in nested structured data', () => {
  const blocks = [
    {
      '@type': 'Product',
      name: 'Widget',
      offers: [
        { '@type': 'Offer', price: '199.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
        { '@type': 'Offer', price: '189.50', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
      ],
    },
  ];
  assert.deepEqual(findOffer(blocks), { price: 189.5, currency: 'USD', inStock: true });
});

test('reads AggregateOffer lowPrice and out-of-stock availability', () => {
  const blocks = [{ '@type': 'AggregateOffer', lowPrice: 74, priceCurrency: 'USD', availability: 'OutOfStock' }];
  assert.deepEqual(findOffer(blocks), { price: 74, currency: 'USD', inStock: false });
});

test('returns null when there is no usable price', () => {
  assert.equal(findOffer([{ '@type': 'Product', name: 'No offers' }]), null);
  assert.equal(findOffer([{ '@type': 'Offer', price: '0' }]), null);
});

/** Price strings as retailers actually render them. */
test('parses common US price formats', () => {
  assert.equal(parsePrice('$203.00'), 203);
  assert.equal(parsePrice('$1,234.56'), 1234.56);
  assert.equal(parsePrice('US$99'), 99);
  assert.equal(parsePrice('From $89.99'), 89.99);
  assert.equal(parsePrice('  $7.35  '), 7.35);
  assert.equal(parsePrice(629.99), 629.99);
});

test('parses European formats where , is the decimal separator', () => {
  assert.equal(parsePrice('1.234,56 €'), 1234.56);
  assert.equal(parsePrice('89,99 EUR'), 89.99);
});

test('treats a comma with three trailing digits as a thousands separator', () => {
  assert.equal(parsePrice('1,234'), 1234);
  assert.equal(parsePrice('$2,499'), 2499);
});

test('rejects unusable input rather than guessing', () => {
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('Currently unavailable'), null);
  assert.equal(parsePrice('$0.00'), null);
  assert.equal(parsePrice(-5), null);
});

/** Listing links. Every part must be clickable in the UI. */
test('an ASIN listing links to the product page', () => {
  assert.equal(
    amazonListingUrl({ asin: 'B09VCHQHZ6' }),
    'https://www.amazon.com/dp/B09VCHQHZ6'
  );
});

test('a query-only listing links to a search, since no single product was chosen', () => {
  assert.equal(
    amazonListingUrl({ query: 'SK hynix Platinum P41 1TB' }),
    'https://www.amazon.com/s?k=SK%20hynix%20Platinum%20P41%201TB'
  );
});

test('links follow the configured Amazon domain', () => {
  assert.equal(
    amazonListingUrl({ asin: 'B09VCHQHZ6' }, 'www.amazon.co.uk'),
    'https://www.amazon.co.uk/dp/B09VCHQHZ6'
  );
});

test('an explicit url always wins over a derived one', () => {
  assert.equal(
    listingUrl({ retailer: 'Amazon', asin: 'B09VCHQHZ6', url: 'https://example.com/x' }),
    'https://example.com/x'
  );
});

test('product URLs are distinguishable from search URLs', () => {
  assert.equal(isProductUrl('https://www.amazon.com/dp/B09VCHQHZ6'), true);
  assert.equal(isProductUrl('https://www.amazon.com/s?k=ram'), false);
  assert.equal(isProductUrl(null), false);
});

test('every seeded part resolves to a link, and none point at Best Buy', () => {
  const parts = loadParts();
  assert.equal(parts.length, 9);
  for (const part of parts) {
    assert.ok(part.listings.length > 0, `${part.id} has no listings`);
    for (const listing of part.listings) {
      assert.notEqual(listing.retailer, 'Best Buy', `${part.id} still lists Best Buy`);
      assert.ok(
        listingUrl(listing, { amazonDomain: 'www.amazon.com' }),
        `${part.id} @ ${listing.retailer} has no resolvable link`
      );
    }
  }
});

/** Canopy API response parsing. Field naming varies between their examples. */
test('canopy prefers the numeric price value', () => {
  assert.deepEqual(
    extractCanopyPrice({ price: { value: 203.0, currency: 'USD', displayString: '$203.00' } }),
    { value: 203, currency: 'USD' }
  );
});

test('canopy falls back to the display string when there is no numeric value', () => {
  assert.deepEqual(extractCanopyPrice({ price: { displayString: '$49.99' } }), {
    value: 49.99,
    currency: 'USD',
  });
  assert.deepEqual(extractCanopyPrice({ price: { display: '£1,234.56', currency: 'GBP' } }), {
    value: 1234.56,
    currency: 'GBP',
  });
});

test('canopy reports no price rather than guessing one', () => {
  assert.equal(extractCanopyPrice({}), null);
  assert.equal(extractCanopyPrice({ price: {} }), null);
  assert.equal(extractCanopyPrice({ price: { value: 0 } }), null);
});

test('canopy availability defaults to in stock unless told otherwise', () => {
  assert.equal(canopyInStock({ availability: { status: 'IN_STOCK' } }), true);
  assert.equal(canopyInStock({}), true, 'absent availability must not read as out of stock');
  assert.equal(canopyInStock({ availability: { status: 'OUT_OF_STOCK' } }), false);
  assert.equal(canopyInStock({ availability: { displayString: 'Currently unavailable' } }), false);
});
