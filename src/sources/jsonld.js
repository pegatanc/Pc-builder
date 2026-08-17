/**
 * Generic schema.org reader for retailers that publish structured product data
 * and permit automated access.
 *
 * Deliberately hard to misuse:
 *   - disabled in config by default;
 *   - only touches a listing that sets `"allowHtml": true` in parts.json;
 *   - every request is checked against robots.txt first and refused if
 *     disallowed for our user-agent (see src/lib/robots.js);
 *   - one request at a time per host, honouring Crawl-delay.
 *
 * robots.txt permission is not the only question — a retailer's terms of
 * service can forbid automated access even where robots.txt is silent.
 * Amazon's do, which is why no Amazon listing opts into this source and the
 * Amazon path stays on Keepa / PA-API / manual entry.
 */
import { politeFetch } from '../lib/http.js';

function collectJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      /* a malformed block is not worth failing the whole page over */
    }
  }
  return blocks;
}

function* walk(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item);
  } else if (node && typeof node === 'object') {
    yield node;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') yield* walk(value);
    }
  }
}

/** Pulls the cheapest offer out of any Product/Offer/AggregateOffer node. */
export function findOffer(blocks) {
  const found = [];

  for (const block of blocks) {
    for (const node of walk(block)) {
      const type = [].concat(node['@type'] || []).map(String);
      if (!type.some((t) => /Offer/i.test(t))) continue;

      const raw = node.price ?? node.lowPrice ?? node.highPrice;
      const price = Number(String(raw ?? '').replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(price) || price <= 0) continue;

      const availability = String(node.availability || '');
      found.push({
        price,
        currency: node.priceCurrency || 'USD',
        inStock: availability ? /InStock|LimitedAvailability|PreOrder/i.test(availability) : true,
      });
    }
  }

  if (!found.length) return null;
  return found.sort((a, b) => a.price - b.price)[0];
}

export default {
  name: 'jsonld',
  label: 'Structured data (robots.txt-gated)',
  requires: [],
  notes: 'Off by default. Only reads listings marked allowHtml and allowed by robots.txt.',

  isConfigured: () => true,

  async fetch(parts) {
    const out = [];
    const errors = [];

    for (const part of parts) {
      for (const listing of part.listings) {
        if (!listing.allowHtml || !listing.url) continue;

        let html;
        try {
          const res = await politeFetch(listing.url, {
            respectRobots: true,
            headers: { accept: 'text/html,application/xhtml+xml' },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          html = await res.text();
        } catch (err) {
          errors.push(`jsonld: ${part.id}@${listing.retailer} (${err.message})`);
          continue;
        }

        const offer = findOffer(collectJsonLd(html));
        if (!offer) {
          errors.push(`jsonld: no structured price at ${listing.url}`);
          continue;
        }

        out.push({
          part_id: part.id,
          retailer: listing.retailer,
          source: 'jsonld',
          price_cents: Math.round(offer.price * 100),
          currency: offer.currency,
          in_stock: offer.inStock ? 1 : 0,
          url: listing.url,
          observed_at: new Date().toISOString(),
        });
      }
    }

    if (errors.length) {
      const err = new Error(errors.join('; '));
      err.partial = out;
      throw err;
    }
    return out;
  },
};
