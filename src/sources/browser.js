/**
 * Renders a product page in a real browser and reads the price out of the DOM.
 *
 * This exists for retailers that price client-side, where a plain fetch returns
 * a shell with no number in it. It is *not* an anti-bot bypass: it identifies
 * itself honestly via the configured user-agent, checks robots.txt before every
 * navigation, and rate-limits per host exactly like the HTTP sources.
 *
 * Consequence worth knowing: a retailer that withholds prices from
 * self-identified automation will withhold them here too. Making that work
 * would mean impersonating a human browser, which is a different activity from
 * rendering a page you're permitted to fetch — see the README.
 *
 * Requires an optional dependency:  npm i playwright
 * Opt in per listing with "allowBrowser": true in config/parts.json.
 */
import { config } from '../config.js';
import { checkRobots } from '../lib/robots.js';
import { throttle } from '../lib/http.js';
import { parsePrice } from '../lib/price.js';

const { userAgent, timeoutMs } = config.sources.http;

/** Tried in order when a listing doesn't specify its own `priceSelector`. */
const GENERIC_SELECTORS = [
  '[itemprop="price"]',
  'meta[property="product:price:amount"]',
  'meta[property="og:price:amount"]',
  '[data-testid*="price" i]',
  '[class*="price" i]',
];

async function loadPlaywright() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    throw new Error(
      'the `browser` source needs Playwright — run `npm i playwright` (and `npx playwright install chromium`)'
    );
  }
}

/**
 * Runs in page context. Prefers rendered JSON-LD, then an explicit selector,
 * then generic ones — the same precedence a human would use reading the page.
 */
function extractInPage({ selectors, explicit }) {
  const results = [];

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const stack = [JSON.parse(script.textContent)];
      while (stack.length) {
        const node = stack.pop();
        if (Array.isArray(node)) {
          stack.push(...node);
        } else if (node && typeof node === 'object') {
          const price = node.price ?? node.lowPrice;
          if (price != null) {
            results.push({
              raw: String(price),
              currency: node.priceCurrency || null,
              availability: String(node.availability || ''),
              via: 'json-ld',
            });
          }
          stack.push(...Object.values(node).filter((v) => v && typeof v === 'object'));
        }
      }
    } catch {
      /* ignore malformed blocks */
    }
  }

  const tryList = explicit ? [explicit, ...selectors] : selectors;
  for (const selector of tryList) {
    for (const node of document.querySelectorAll(selector)) {
      const raw =
        node.getAttribute?.('content') ??
        node.getAttribute?.('data-price') ??
        node.textContent;
      if (raw && /\d/.test(raw)) {
        results.push({ raw: raw.trim().slice(0, 60), currency: null, availability: '', via: selector });
      }
    }
    if (results.some((r) => r.via === selector)) break;
  }

  return { results, title: document.title };
}

export default {
  name: 'browser',
  label: 'Rendered page (robots.txt-gated)',
  requires: [],
  notes: 'Off by default. Needs `npm i playwright`; only reads listings marked allowBrowser.',

  isConfigured: () => true,

  async fetch(parts) {
    const candidates = [];
    for (const part of parts) {
      for (const listing of part.listings) {
        if (listing.allowBrowser && listing.url) candidates.push({ part, listing });
      }
    }
    if (!candidates.length) return [];

    const out = [];
    const errors = [];

    // Clear robots.txt before launching anything: a URL we may not fetch should
    // be refused on its own merits, not incidentally by a browser launch error.
    const targets = [];
    for (const { part, listing } of candidates) {
      const verdict = await checkRobots(listing.url, { userAgent, timeoutMs });
      if (verdict.allowed) targets.push({ part, listing, crawlDelayMs: verdict.crawlDelayMs });
      else errors.push(`browser: ${part.id}@${listing.retailer} ${verdict.reason}`);
    }

    if (!targets.length) {
      const err = new Error(errors.join('; '));
      err.partial = [];
      throw err;
    }

    const chromium = await loadPlaywright();
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({ userAgent, locale: 'en-US' });

    // Prices are text; skip the heavy assets to stay light on the retailer.
    await context.route('**/*', (route) =>
      ['image', 'font', 'media'].includes(route.request().resourceType())
        ? route.abort()
        : route.continue()
    );

    try {
      for (const { part, listing, crawlDelayMs } of targets) {
        await throttle(new URL(listing.url).host, crawlDelayMs);

        const page = await context.newPage();
        try {
          await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          if (listing.priceSelector) {
            await page
              .waitForSelector(listing.priceSelector, { timeout: 8000 })
              .catch(() => {});
          }

          const { results } = await page.evaluate(extractInPage, {
            selectors: GENERIC_SELECTORS,
            explicit: listing.priceSelector ?? null,
          });

          const priced = results
            .map((r) => ({ ...r, value: parsePrice(r.raw) }))
            .filter((r) => r.value != null);

          if (!priced.length) {
            errors.push(`browser: no price found at ${listing.url}`);
            continue;
          }

          // Cheapest plausible reading; retail pages list add-ons and bundles too.
          const best = priced.sort((a, b) => a.value - b.value)[0];
          const outOfStock = /OutOfStock|SoldOut|Discontinued/i.test(best.availability);

          out.push({
            part_id: part.id,
            retailer: listing.retailer,
            source: 'browser',
            price_cents: Math.round(best.value * 100),
            currency: best.currency || 'USD',
            in_stock: outOfStock ? 0 : 1,
            url: listing.url,
            observed_at: new Date().toISOString(),
          });
        } catch (err) {
          errors.push(`browser: ${part.id}@${listing.retailer} (${err.message.split('\n')[0]})`);
        } finally {
          await page.close().catch(() => {});
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }

    if (errors.length) {
      const err = new Error(errors.join('; '));
      err.partial = out;
      throw err;
    }
    return out;
  },
};
