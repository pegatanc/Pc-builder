# PC Build Price Tracker

Self-hosted price tracker for a specific PC build. Node + SQLite on the back end,
plain HTML/CSS/JS on the front (no framework, no build step, no auth, localhost only).

Tracks the cheapest current price per part across retailers, keeps full price
history in SQLite, draws a canvas sparkline per part, totals the build against a
**$1,315 baseline**, and flags any part that drops 10%+ below its own 30-day average.

## Run it

```bash
npm install
npm start
```

Then open <http://127.0.0.1:3000>.

On first start it seeds the parts list, lays down 90 days of sample history so the
sparklines and alert rule have something to work with, and schedules a price check
every 12 hours.

**Out of the box it runs on synthetic sample data** — the UI says so with an amber
`sample data` badge. Wire up a real source below to replace it.

Other commands:

```bash
npm run sources   # which price sources are configured, and what each one needs
npm run fetch     # fetch prices once and exit
npm run seed      # re-sync config/parts.json into the database
npm test          # robots.txt precedence, price parsing, structured-data extraction
```

## Price sources

Prices come from pluggable source adapters in `src/sources/`. Each one exports the
same shape, so adding a retailer means dropping in one file and listing it in
`config.json`:

```js
export default {
  name: 'myshop',
  label: 'My Shop API',
  requires: ['MYSHOP_KEY'],          // env vars the source needs
  isConfigured: () => !!process.env.MYSHOP_KEY,
  async fetch(parts) { /* → [{ part_id, retailer, source, price_cents, … }] */ },
};
```

Sources run in the order set by `sources.order` in `config/config.json`. The first
source to return a price for a given (part, retailer) pair wins, so a real API always
takes precedence over a fallback for the same retailer.

| Source    | Retailer  | Cost                    | Needs                                                     |
| --------- | --------- | ----------------------- | --------------------------------------------------------- |
| `paapi`   | Amazon    | free, but gated         | Approved Associates account → `PAAPI_ACCESS_KEY`, `PAAPI_SECRET_KEY`, `PAAPI_PARTNER_TAG` |
| `keepa`   | Amazon    | paid subscription       | `KEEPA_API_KEY`                                            |
| `bestbuy` | Best Buy  | free                    | `BESTBUY_API_KEY` from [developer.bestbuy.com](https://developer.bestbuy.com/) |
| `manual`  | any       | free                    | `config/manual-prices.json`                                |
| `jsonld`  | any       | free                    | off by default — reads structured data from static HTML     |
| `browser` | any       | free                    | off by default — renders the page in Chromium; `npm i playwright` |
| `sample`  | —         | free                    | nothing; synthetic demo data                               |

Copy `.env.example` to `.env` and run `node --env-file=.env src/server.js` to load keys.

### About Amazon

Amazon has no free price API and blocks scrapers aggressively, so there are three
honest ways to get its prices, in descending order of convenience:

1. **Product Advertising API v5** (`paapi`) — the official route. Free, but it
   requires an approved Associates account, and Amazon revokes access if the
   account doesn't generate sales. The adapter signs its own SigV4 requests, so
   there's no AWS SDK dependency.
2. **Keepa** (`keepa`) — a paid API that already tracks Amazon price history.
   No affiliate account, works immediately, costs money.
3. **Manual entry** (`manual`) — the zero-cost fallback. Copy
   `config/manual-prices.example.json` to `config/manual-prices.json`, check the
   page in a browser yourself, and paste the number:

   ```json
   { "prices": [
       { "partId": "cpu-ryzen-7-5700x", "retailer": "Amazon", "price": 148.99 }
   ] }
   ```

   Everything downstream — history, 30-day average, drop alerts, totals — works
   identically to an API-backed source. For a nine-part build checked twice a week,
   this is genuinely practical.

#### Why not just render the page in a browser?

Reasonable question — there's a `browser` source that does exactly that, and it
works well on retailers that price client-side. It does not solve Amazon, and the
reason is worth stating precisely, because it isn't the reason people usually assume.

Amazon's `robots.txt` actually **allows** `/dp/` for `User-agent: *` (it blocks
named crawlers like `GPTBot` and `Scrapy` with `Disallow: /`, and disallows a
handful of `/dp/…` subpaths). And a plain request is not CAPTCHA-walled. Fetching
the same product page twice, changing only the `User-Agent`:

| User-Agent                                  | HTTP | Page size | Price in HTML |
| ------------------------------------------- | ---- | --------- | ------------- |
| `pc-builder-price-tracker/1.0` (honest)      | 200  | 356 KB    | **absent**    |
| `Mozilla/5.0 … Chrome/131.0.0.0 Safari/537` | 200  | 2.1 MB    | **present**   |

Both succeed. The self-identified client is simply served a stripped page with the
price removed. So the price isn't behind JavaScript, and it isn't behind bot
detection you could out-render — it's behind *not disclosing that you're a bot*.

That's why a headless browser doesn't unlock it, and why anti-detection browsers
(Camoufox, `puppeteer-extra-stealth`, and friends) aren't wired in either. Those
tools exist specifically to defeat fingerprint-based bot detection; using one is
choosing to misrepresent the client, and each escalation invites the next. This
project stops at the line where a source has to lie about what it is.

`sources.http.userAgent` in `config.json` is yours to set — it's your machine and
your Amazon account. Just make the choice knowingly rather than by accident.
The API and manual routes above exist precisely so you don't have to.

The first real source you configure automatically deletes the synthetic sample
history, so demo prices never contaminate your averages.

### The `browser` source

Renders a product page in real Chromium and reads the price from the DOM — for
retailers that inject prices client-side, where a plain fetch returns a shell with
no number in it. Newegg and B&H, for instance, both permit product pages under
`User-agent: *`.

```bash
npm i playwright && npx playwright install chromium
```

Then enable it in `config.json` (`sources.enabled.browser`) and opt in per listing:

```jsonc
{
  "retailer": "Newegg",
  "url": "https://www.newegg.com/p/...",
  "allowBrowser": true,
  "priceSelector": ".price-current"   // optional; generic fallbacks are tried first
}
```

It reuses one browser across a run, blocks images/fonts/media to stay light on the
retailer, prefers rendered JSON-LD over CSS selectors, and takes the cheapest
plausible reading so an accessory or bundle price doesn't win. `robots.txt` is
checked *before* the browser launches, so a disallowed URL is refused on its own
merits. Set `PLAYWRIGHT_CHROMIUM_PATH` to use a system Chromium instead of
Playwright's own download.

Playwright stays an optional dependency — the base install is small, and the
browser tests skip themselves when it isn't present.

### The `jsonld` source

A generic reader for retailers that publish schema.org product data in static HTML
and permit automated access. Cheaper than `browser` when it works. It's off by
default and hard to misuse:

- disabled in `config.json` (`sources.enabled.jsonld`);
- only touches a listing that explicitly sets `"allowHtml": true` in `parts.json`;
- checks `robots.txt` before every request and refuses if disallowed for our
  user-agent — including correct handling of named-crawler groups, longest-match
  rule precedence, and `*` / `$` wildcards (`src/lib/robots.js`, covered by tests);
- honours `Crawl-delay`, serialises requests per host, and enforces a floor of
  `sources.http.minDelayMsPerHost` (default 5s) between hits;
- treats an unreachable `robots.txt` as "disallowed", not "allowed".

`robots.txt` permission isn't the whole question — a retailer's terms of service can
forbid automated access even where `robots.txt` is silent. Check before enabling it
for a given site.

## Configuration

**`config/config.json`** — schedule, alert rule, baseline, and **target prices per part**:

```jsonc
{
  "baselineTotal": 1315.00,
  "schedule": { "cron": "0 */12 * * *", "timezone": "America/New_York", "runOnStart": true },
  "alerts":   { "dropPercent": 10, "windowDays": 30, "minSamples": 3 },
  "targets":  { "cpu-ryzen-7-5700x": 150.00, "gpu-asrock-rx-7900-xt": 620.00 }
}
```

**`config/parts.json`** — the parts catalogue and their listings. `npm run seed` upserts
it into SQLite and runs automatically at startup, so edits take effect on restart.

A part can have several listings; the tracker records a price per (part, retailer) and
displays the cheapest in-stock one. ASINs are only set where they were supplied — none
are guessed. Listings without an ASIN (the RAM kit, SSD and PSU, which were specified by
class rather than by exact SKU) carry a `query` string that search-capable sources like
Best Buy match on.

## The build

| Part           | Item                                          | Target |
| -------------- | --------------------------------------------- | ------ |
| CPU            | AMD Ryzen 7 5700X (`B09VCHQHZ6`)               | $150   |
| Motherboard    | MSI MAG B550 Tomahawk (`B089CWDHFZ`)           | $160   |
| Memory         | G.Skill Ripjaws V 32GB (2x16) DDR4-3600 CL16   | $75    |
| Storage        | SK hynix Platinum P41 1TB NVMe                 | $80    |
| Power Supply   | 750W 80+ Gold fully modular                    | $90    |
| Graphics       | ASRock RX 7900 XT 20GB (`B0BRYWWDH2`)          | $620   |
| CPU Cooler     | Cooler Master Hyper 212 Black (`B07H25DYM3`)   | $35    |
| Case           | NZXT H6 Flow (`B0C89FCDFP`)                    | $95    |
| Case Fan       | Arctic P12 (`B07GB16RK7`)                      | $8     |

## How alerting works

Every observation is appended to `price_history` — rows are never updated. For the
sparkline and the statistics, prices are collapsed to one point per day (the cheapest
seen that day across retailers), so a double fetch in one day can't skew the average.

A part is flagged when its current cheapest price sits at or below
`(30-day average) × (1 − dropPercent/100)`, provided at least `minSamples` daily points
exist in the window. Flagged rows are tinted in the table, badged with the drop
percentage, and counted in the "Price drops" card. A separate `at target` badge appears
whenever the price is at or below that part's configured target.

## API

| Endpoint         | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `GET /api/build` | Everything the UI renders: parts, offers, series, stats, totals |
| `GET /api/sources` | Source status and the current schedule                       |
| `POST /api/refresh` | Fetch prices now (what the Refresh button calls)            |
| `GET /api/health` | Liveness                                                      |

## Layout

```
config/       config.json (targets, schedule, alerts) · parts.json (catalogue)
src/
  server.js     express app + static hosting
  scheduler.js  node-cron job
  fetcher.js    runs sources, dedupes, writes history
  repo.js       queries: cheapest offer, daily series, 30-day stats, alerts
  db.js         schema + connection
  sources/      paapi · keepa · bestbuy · jsonld · browser · manual · sample
  lib/          robots.js (robots.txt) · http.js (rate-limited fetch) · price.js (price parsing)
public/       index.html · app.js (canvas sparklines) · styles.css
data/         prices.db — created on first run, gitignored
```

Delete `data/prices.db` to start over.
