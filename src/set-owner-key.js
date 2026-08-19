/**
 * `npm run owner-key <key>` — records a personal key so the page can recognise
 * you, and `npm run owner-key clear` removes it.
 *
 * Only the SHA-256 digest is written to config. The key itself never enters the
 * repository, which matters because this repo is public: a random UUID has ~122
 * bits of entropy, so publishing its digest does not disclose it.
 *
 * Read the README before relying on this. It is a recognition marker, not
 * access control — the site is static, so there is no server to check anything
 * and build.json stays publicly readable regardless.
 */
import './lib/fatal.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR, ConfigError } from './config.js';

const FILE = path.join(CONFIG_DIR, 'config.json');

export const sha256Hex = (value) =>
  crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

const args = process.argv.slice(2);
if (!args.length) {
  const current = JSON.parse(fs.readFileSync(FILE, 'utf8')).site?.ownerKeyHash;
  console.log(
    current
      ? `\n  An owner key is set.\n  digest: ${current}\n\n  Open the site with ?key=<your key> to be recognised.\n` +
          `  Replace it with:  npm run owner-key <new key>\n`
      : '\n  No owner key set.  Set one with:  npm run owner-key <key>\n'
  );
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const clearing = ['clear', 'none', 'off', '-'].includes(args[0].toLowerCase());

if (clearing) {
  delete config.site?.ownerKeyHash;
  if (config.site && !Object.keys(config.site).length) delete config.site;
  console.log('Owner key cleared — the page will no longer show a recognition badge.');
} else {
  const key = args[0];
  if (key.length < 12) {
    throw new ConfigError(
      'Use something long and random — a short key is guessable, and this digest is published.'
    );
  }
  config.site = { ...config.site, ownerKeyHash: sha256Hex(key) };
  console.log(`Owner key set.\n  digest committed: ${config.site.ownerKeyHash}`);
  console.log('  the key itself is NOT written to the repo.');
  console.log('\nOpen the site with  ?key=<your key>  once, on each device.');
}

fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + '\n');
