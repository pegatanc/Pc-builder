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
npm run price     # list manual prices; `npm run price cpu 148.99` sets one
npm run site      # build the static site into ./site (see GitHub Pages below)
npm test          # robots.txt precedence, price parsing, history round-trip
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
| `canopy`  | Amazon    | paid API                | `CANOPY_API_KEY` from [canopyapi.co](https://www.canopyapi.co/) |
| `paapi`   | Amazon    | free, but gated         | Approved Associates account → `PAAPI_ACCESS_KEY`, `PAAPI_SECRET_KEY`, `PAAPI_PARTNER_TAG` |
| `keepa`   | Amazon    | paid subscription       | `KEEPA_API_KEY`                                            |
| `bestbuy` | Best Buy  | free                    | `BESTBUY_API_KEY` — **disabled by default** (US-only retailer) |
| `manual`  | any       | free                    | `config/manual-prices.json`                                |
| `jsonld`  | any       | free                    | off by default — reads structured data from static HTML     |
| `browser` | any       | free                    | off by default — renders the page in Chromium; `npm i playwright` |
| `sample`  | —         | free                    | nothing; synthetic demo data                               |

Copy `.env.example` to `.env` and run `node --env-file=.env src/server.js` to load keys.

### About Amazon

Amazon has no free price API and blocks scrapers aggressively, so there are four
honest ways to get its prices, in descending order of convenience:

0. **Canopy API** (`canopy`) — a paid REST API, no affiliate account needed, works
   as soon as you have a key. This is the default first choice in `sources.order`.

   ```bash
   CANOPY_API_KEY=… npm run fetch
   ```

   One request per ASIN against `rest.canopyapi.co/api/amazon/product`, keyed by an
   `API-KEY` header. The numeric `price.value` is preferred and the formatted string
   is only parsed as a fallback, since field naming differs between Canopy's examples
   and their docs. A product with no Buy Box price is recorded as out of stock rather
   than as an error. Being a metered API rather than a retail page, it uses a 250ms
   floor between calls instead of the 5s one meant for scraping.

1. **Product Advertising API v5** (`paapi`) — the official route. Free, but it
   requires an approved Associates account, and Amazon revokes access if the
   account doesn't generate sales. The adapter signs its own SigV4 requests, so
   there's no AWS SDK dependency.
2. **Keepa** (`keepa`) — a paid API that already tracks Amazon price history.
   No affiliate account, works immediately, costs money.
3. **Manual entry** (`manual`) — the zero-cost fallback, and the fastest way to
   replace the sample data. `config/manual-prices.json` ships pre-filled with all
   nine parts and their links; open each one, read the price, type it in:

   ```jsonc
   { "prices": [
       { "partId": "cpu-ryzen-7-5700x", "name": "AMD Ryzen 7 5700X",
         "retailer": "Amazon", "price": null,
         "url": "https://www.amazon.com/dp/B09VCHQHZ6" }
   ] }
   ```

   Everything downstream — history, 30-day average, drop alerts, totals — works
   identically to an API-backed source. For a nine-part build checked twice a week,
   this is genuinely practical.

   Three things to know:

   - The source only activates once **at least one** price is non-null, so the blank
     template is a no-op and the site keeps showing sample data until you fill it in.
   - **Fill in all nine at once.** The first real price purges the synthetic history
     (by design — so demo numbers can't skew your averages), and any part still left
     at `null` will show as unpriced rather than falling back to sample data.
   - Sparklines restart from the day you switch. Ninety days of synthetic history is
     removed and real history accumulates from there.

   Unlike `.env`, this file **is** committed — the Pages workflow runs on a fresh
   checkout and can only see prices that are in the repo. It holds prices, not secrets.

   You don't have to edit the JSON by hand:

   ```bash
   npm run price                  # what's filled in, what isn't
   npm run price cpu 148.99       # any unambiguous fragment of the id or name
   npm run price gpu '$1,234.56'  # pasted currency strings are fine
   npm run price cpu clear        # back to null
   ```

   It refuses an ambiguous fragment rather than guessing, and stamps `observedAt`
   with the date. (`clear` is a bare word because `npm run` swallows `--clear`
   before it reaches the script.)

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

## Publishing to GitHub Pages

The app also runs as a static site. `.github/workflows/prices.yml` fetches prices
on a 12-hour cron, commits the history back to the repo, builds a static copy and
publishes it to Pages — no server, no bill.

**Enable it once, by hand:** repo **Settings → Pages → Build and deployment → Source:
GitHub Actions**. Then run the workflow (Actions tab → *Update prices and publish* →
*Run workflow*) or wait for the schedule. It publishes to `https://<user>.github.io/<repo>/`.

Two things that make this step easy to get stuck on:

- The **Source** dropdown only exists if the repository is public, or private on a
  paid plan. On a private repo on the free plan the page shows an upgrade prompt and
  no dropdown at all — so if you make the repo public, you have to come *back* to this
  page afterwards to set the Source.
- It genuinely cannot be automated from inside the workflow. `actions/configure-pages`
  has an `enablement: true` option, but the default `GITHUB_TOKEN` is allowed to
  deploy to Pages and not to create the site, so it fails with *"Create Pages site
  failed: Resource not accessible by integration"*. Until the setting is changed, every
  run fails at that step with *"Get Pages site failed"* — while every step before it
  (tests, fetch, history commit, static build) succeeds.

To use real prices instead of sample data, add whichever you have under
**Settings → Secrets and variables → Actions**: `KEEPA_API_KEY`, `BESTBUY_API_KEY`,
or `PAAPI_ACCESS_KEY` + `PAAPI_SECRET_KEY` + `PAAPI_PARTNER_TAG`. The workflow picks
up whatever is present and falls back to sample data otherwise.

How it holds price history without a database server: each run restores SQLite from
`history/price-history.ndjson`, fetches, and writes the file back. It's append-only text,
so a twice-daily fetch adds a couple of KB that git stores as a small delta — where a
committed SQLite file would be a fresh ~1 MB binary blob every run.

```bash
npm run history:import   # NDJSON  → SQLite
npm run history:export   # SQLite  → NDJSON
npm run site             # build ./site for Pages
```

Two differences in the published build:

- **No Refresh button.** There's no server to fetch on demand — use *Run workflow* in
  the Actions tab instead. `npm run site` rewrites a mode flag in `index.html`, so the
  static page knows this up front and never requests an API that isn't there.
- **Nothing is writable from the web,** which is what makes publishing safe given the
  app has no auth. Don't instead deploy the Express server to a public host as-is:
  `POST /api/refresh` is unauthenticated, and with a metered source like Keepa that's
  strangers spending your money.

Worth knowing:

- Scheduled workflows only run from the **default branch**, so Pages won't start
  updating until this is merged to `main`.
- GitHub suspends scheduled workflows after 60 days without repo activity; the commits
  the workflow itself makes count, so an active tracker keeps itself alive.
- Vercel is a poor fit for this app: its filesystem is ephemeral, so SQLite writes
  vanish between invocations and history never accumulates. Its Hobby tier also caps
  cron at once per day — `0 */12 * * *` fails deployment outright rather than degrading.
  Vercel would need a hosted database (Turso/Postgres) and an async rewrite of the
  data layer.

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
are guessed.

Every part links out from the table. Where an ASIN was supplied the link goes straight to
the product page; the RAM kit, SSD and PSU were specified by class rather than exact SKU,
so those resolve to an Amazon search built from the listing's `query` — the honest
equivalent of "here's where to look" instead of inventing an ASIN for a product nobody
picked. Links are derived at seed time from `sources.amazonDomain`, so pointing the whole
build at another storefront (`www.amazon.co.uk`, `www.amazon.de`, …) is a one-line config
change. Set `url` on a listing to override it.

Best Buy is disabled by default, being US-only. Re-enable it in
`sources.enabled.bestbuy` and add a `{ "retailer": "Best Buy", "query": "..." }` listing
to any part if you want it back. If you switch `amazonDomain`, remember to update
`currency`, `baselineTotal` and the `targets`, and set `KEEPA_DOMAIN` to match.

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

## Recognising your own copy

`npm run owner-key <key>` records a personal key, and opening the site once with
`?key=<key>` marks that browser — after which the header shows a `✓ your tracker`
badge. The key is stripped from the address bar immediately so it doesn't linger in
a screenshot or a copied URL.

Only the SHA-256 digest goes into `config.json`; the key itself is never written to
the repo. That matters because this repo is public, and a random UUID has enough
entropy that publishing its digest doesn't disclose it.

**This is a recognition marker, not access control, and it must not be mistaken for
one.** The site is static, so there is no server to check anything against; the
comparison happens in the visitor's own browser, and `build.json` is readable by
anyone with the URL. It tells you that *you* opened your own link. It does not keep
anybody out.

If you need the data actually private, the options are a private repo on a paid plan
(Pages then serves it, though the published site is still public), or not publishing
at all and running `npm start` locally.

`npm run owner-key` with no arguments shows the current state; `npm run owner-key
clear` removes it.

## Reading the table

- **Copy all links** — copies every part as `Name — url`, one per line, in the
  order currently displayed. Uses the clipboard API where the page is served
  over HTTPS or localhost, and falls back to a textarea on a plain-HTTP origin.
  Works in the published static build too, where Refresh is hidden.
- **Sorting** — click any column header to sort; click again to reverse, and a
  third time to return to catalogue order (CPU, board, memory…). The choice is
  remembered across reloads, and headers are keyboard-operable.
- **On a phone** — below 720px each row becomes its own card with inline labels
  and a full-width sparkline, instead of a horizontally scrolling table.
- **90-day history** — hover any sparkline for the exact price and date on that day.
  The build total card carries its own trend line, so you can see whether the build
  as a whole is getting cheaper.
- **Lowest seen** — the cheapest that part has been in the tracked window, with how
  far above it the current price sits. A part matching its own record gets a
  `★ lowest yet` badge; the footer shows the cheapest the whole build has ever been.
- **Status** — `▼ n% drop` when the alert rule fires, `at target` when at or below
  the configured target, `stale` when the last observation is over a week old.

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
  history.js    SQLite ⇄ NDJSON, so GitHub Actions can carry history between runs
  export-static.js  builds ./site for GitHub Pages
public/       index.html · app.js (canvas sparklines) · styles.css
data/         prices.db — disposable, gitignored, rebuilt from history/ on demand
history/      price-history.ndjson — the committed record, deliberately outside data/
              so `rm -rf data` to reset the database cannot take the history with it
.github/      workflows/prices.yml — 12h fetch, commit history, publish to Pages
```

Delete `data/prices.db` to start over.
