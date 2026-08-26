/**
 * Builds a product URL for a listing.
 *
 * Five parts were specified by ASIN and link straight to the product page. The
 * rest were specified by class rather than SKU (the RAM kit, SSD and PSU), so
 * there is no single product to point at — those get a search URL built from
 * the listing's query, which is the honest equivalent of "here's where to look"
 * rather than inventing an ASIN for a product nobody picked.
 */
export function amazonListingUrl({ asin, query }, domain = 'www.amazon.com') {
  if (asin) return `https://${domain}/dp/${encodeURIComponent(asin)}`;
  if (query) return `https://${domain}/s?k=${encodeURIComponent(query)}`;
  return null;
}

/**
 * eBay listings are marketplace search results, never a fixed product page —
 * the item that is cheapest today is gone next week. So the fallback link is
 * the search itself, filtered the way the source filters: new, buy-it-now.
 */
export function ebayListingUrl({ query }, domain = 'www.ebay.com') {
  if (!query) return null;
  // LH_ItemCondition=3 is New, LH_BIN=1 is Buy It Now, in eBay's own URL grammar.
  return `https://${domain}/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_ItemCondition=3&LH_BIN=1`;
}

/** Whether a URL points at a specific product rather than a search results page. */
export function isProductUrl(url) {
  return typeof url === 'string' && /\/dp\/|\/gp\/product\//.test(url);
}

export function listingUrl(listing, { amazonDomain, ebayDomain } = {}) {
  if (listing.url) return listing.url;
  if (listing.retailer === 'Amazon') return amazonListingUrl(listing, amazonDomain);
  if (listing.retailer === 'eBay') return ebayListingUrl(listing, ebayDomain);
  return null;
}
