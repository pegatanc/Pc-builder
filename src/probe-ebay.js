/**
 * `npm run ebay:probe [search terms]` — one live Browse API call, dumped raw.
 *
 * This exists because of what happened with the Canopy adapter: it was written
 * from the published docs, returned nothing for every part, and the tests passed
 * because they encoded the same wrong assumption from the same docs. The eBay
 * adapter was likewise written against a schema rather than a captured response,
 * so before trusting it, run this and read what actually comes back.
 *
 * It saves the full payload to data/ebay-probe.json — use that to build test
 * fixtures from real data, not from documentation.
 */
import './lib/fatal.js';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { fetchJson } from './lib/http.js';
import ebay, { accessToken, searchUrl, settings, itemSummaries, deliveredPrice } from './sources/ebay.js';

if (!ebay.isConfigured()) {
  console.error(
    'Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET first.\n\n' +
      '  1. Sign up (free): https://developer.ebay.com/join\n' +
      '  2. Create a production keyset under Application Keys\n' +
      '  3. App ID -> EBAY_CLIENT_ID, Cert ID -> EBAY_CLIENT_SECRET\n'
  );
  process.exit(1);
}

const query = process.argv.slice(2).join(' ') || 'AMD Ryzen 7 5700X';
const opts = settings();

console.log(`\nRequesting an application token…`);
const token = await accessToken();
console.log(`  got one (${token.slice(0, 12)}…)\n`);

const url = searchUrl(query, opts);
console.log(`Searching "${query}"\n  ${url}\n`);

const payload = await fetchJson(url, {
  headers: {
    authorization: `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID': opts.marketplace,
    accept: 'application/json',
  },
});

const file = path.join(DATA_DIR, 'ebay-probe.json');
fs.writeFileSync(file, JSON.stringify(payload, null, 2));

const items = itemSummaries(payload);
console.log(`total reported: ${payload.total ?? '(absent)'} · summaries returned: ${items.length}\n`);

for (const item of items.slice(0, 15)) {
  const delivered = deliveredPrice(item, opts);
  const total = delivered ? `$${delivered.total.toFixed(2)}` : '(no delivered price)';
  const ship = delivered?.shipping ? ` (+$${delivered.shipping.toFixed(2)} ship)` : '';
  console.log(
    `  ${total.padStart(12)}${ship.padEnd(16)} ${String(item.condition ?? '?').padEnd(12)} ` +
      `${(item.buyingOptions || []).join('/').padEnd(22)} ${String(item.title).slice(0, 60)}`
  );
}

console.log(`\nFull payload written to ${file}`);
if (!items.length) {
  console.log('\nNothing came back. Check the filter in the URL above before assuming the code is wrong.');
}
