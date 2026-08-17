/**
 * Integration test for the `browser` source against a local fixture that
 * renders its price client-side — the case a plain fetch cannot handle.
 *
 * Playwright is an optional dependency, so this whole file skips when it isn't
 * installed rather than failing the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let havePlaywright = true;
try {
  await import('playwright');
} catch {
  havePlaywright = false;
}

test(
  'browser source reads a client-rendered price',
  { skip: havePlaywright ? false : 'playwright not installed (npm i playwright)' },
  async () => {
    const html = fs.readFileSync(path.join(HERE, 'fixtures/product.html'), 'utf8');

    // No robots.txt here: a 404 means "allowed", which the source must honour.
    const server = http.createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(404).end('nope');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const { default: browserSource } = await import('../src/sources/browser.js');

      const parts = [
        {
          id: 'fan-arctic-p12',
          listings: [
            {
              retailer: 'Example',
              url: `http://127.0.0.1:${port}/product`,
              allowBrowser: true,
            },
          ],
        },
      ];

      const observations = await browserSource.fetch(parts);

      assert.equal(observations.length, 1);
      const [observation] = observations;
      assert.equal(observation.part_id, 'fan-arctic-p12');
      assert.equal(observation.retailer, 'Example');
      assert.equal(observation.source, 'browser');
      assert.equal(observation.currency, 'USD');
      assert.equal(observation.in_stock, 1);
      // 8.99 from JSON-LD, not the $24.99 accessory alongside it.
      assert.equal(observation.price_cents, 899);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

test(
  'browser source refuses a URL robots.txt disallows',
  { skip: havePlaywright ? false : 'playwright not installed (npm i playwright)' },
  async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>$1.00</h1>');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const { clearRobotsCache } = await import('../src/lib/robots.js');
      clearRobotsCache();

      const { default: browserSource } = await import('../src/sources/browser.js');
      const parts = [
        {
          id: 'fan-arctic-p12',
          listings: [
            { retailer: 'Blocked', url: `http://127.0.0.1:${port}/product`, allowBrowser: true },
          ],
        },
      ];

      await assert.rejects(
        () => browserSource.fetch(parts),
        (err) => {
          assert.match(err.message, /disallowed by robots\.txt/);
          assert.deepEqual(err.partial, [], 'nothing recorded for a blocked URL');
          return true;
        }
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      const { clearRobotsCache } = await import('../src/lib/robots.js');
      clearRobotsCache();
    }
  }
);
