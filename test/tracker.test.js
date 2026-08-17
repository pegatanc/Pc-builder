import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, selectGroup, isAllowedBy } from '../src/lib/robots.js';
import { findOffer } from '../src/sources/jsonld.js';
import { parsePrice } from '../src/lib/price.js';

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
