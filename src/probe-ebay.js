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
import ebay, {
  accessToken,
  searchUrl,
  settings,
  itemSummaries,
  deliveredPrice,
  environment,
  isSandbox,
  browseHeaders,
  endUserContext,
} from './sources/ebay.js';

if (!ebay.isConfigured()) {
  console.error(
    'Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET first.\n\n' +
      '  1. Sign up (free): https://developer.ebay.com/join\n' +
      '  2. Create a keyset under Application Keys\n' +
      '  3. App ID -> EBAY_CLIENT_ID, Cert ID -> EBAY_CLIENT_SECRET\n\n' +
      'Set EBAY_ENV=sandbox to probe the sandbox instead. Sandbox keysets are\n' +
      'issued without production gating, and answer with the same envelope — so\n' +
      'they verify the adapter even when production access is not sorted yet.\n'
  );
  process.exit(1);
}

const query = process.argv.slice(2).join(' ') || 'AMD Ryzen 7 5700X';
const opts = settings();

console.log(`\nEnvironment: ${environment()}`);
if (isSandbox()) {
  console.log('  Sandbox listings are test data — good for checking the response');
  console.log('  shape, useless as prices. Nothing here is recorded.');
}
console.log(`\nRequesting an application token…`);
const token = await accessToken();
console.log(`  got one (${token.slice(0, 12)}…)\n`);

const url = searchUrl(query, opts);
console.log(`Searching "${query}"\n  ${url}`);
console.log(
  endUserContext()
    ? `  delivery calculated for ${process.env.EBAY_POSTAL_CODE}\n`
    : '  no EBAY_POSTAL_CODE — listings with CALCULATED shipping will have no price\n'
);

const payload = await fetchJson(url, { headers: browseHeaders(token, opts.marketplace) });

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
console.log('\nField check against what the adapter expects:');
const sample = items[0];
if (sample) {
  const report = [
    ['itemSummaries[]', true],
    ['price.value is a string', typeof sample.price?.value === 'string'],
    ['price.currency', !!sample.price?.currency],
    ['shippingOptions[]', Array.isArray(sample.shippingOptions)],
    ['shippingOptions[].shippingCost.value', typeof sample.shippingOptions?.[0]?.shippingCost?.value === 'string'],
    ['condition', !!sample.condition],
    ['buyingOptions[]', Array.isArray(sample.buyingOptions)],
    ['itemWebUrl', !!sample.itemWebUrl],
  ];
  for (const [field, ok] of report) console.log(`  ${ok ? 'ok  ' : 'MISS'} ${field}`);
  console.log('\nFirst item, raw:');
  console.log(JSON.stringify(sample, null, 2).split('\n').slice(0, 40).join('\n'));
}
if (!items.length) {
  console.log('\nNothing came back. Check the filter in the URL above before assuming the code is wrong.');
}
