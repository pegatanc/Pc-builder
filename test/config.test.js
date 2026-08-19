/**
 * Config robustness. These files are hand-edited, so the failure modes matter:
 * a broken optional file must not take the app down, a broken required one must
 * say what's wrong without a stack trace, and parts.json mistakes must name the
 * offending entry rather than surfacing as a SQLite constraint error.
 *
 * Each case runs in a child process against a temporary config directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runs a command in a sandbox copy of the repo config so we can corrupt it. */
function inSandbox(mutate, argv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-config-'));
  const configDir = path.join(dir, 'config');
  fs.cpSync(path.join(ROOT, 'config'), configDir, { recursive: true });
  mutate(configDir);

  const result = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: path.join(dir, 'data'), CONFIG_DIR: configDir },
  });

  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test('a malformed optional manual-prices.json warns but does not stop the run', () => {
  const { status, output } = inSandbox(
    (dir) => fs.writeFileSync(path.join(dir, 'manual-prices.json'), '{ "prices": [ broken'),
    ['src/fetch-once.js']
  );

  assert.equal(status, 0, 'fetch must still succeed');
  assert.match(output, /\[config\] ignoring .*manual-prices\.json/);
  assert.match(output, /recorded \d+ observation/);
});

test('the malformed-optional-file warning is printed once, not once per check', () => {
  const { output } = inSandbox(
    (dir) => fs.writeFileSync(path.join(dir, 'manual-prices.json'), '{ "prices": [ broken'),
    ['src/fetch-once.js', '--list']
  );

  const occurrences = output.match(/\[config\] ignoring/g) || [];
  assert.equal(occurrences.length, 1, `warned ${occurrences.length} times`);
});

test('a malformed required config.json fails cleanly, without a stack trace', () => {
  const { status, output } = inSandbox(
    (dir) => fs.writeFileSync(path.join(dir, 'config.json'), '{ "targets": broken }'),
    ['--import', './src/lib/fatal.js', 'src/fetch-once.js', '--list']
  );

  assert.equal(status, 1);
  assert.match(output, /Configuration problem/);
  assert.match(output, /Could not parse .*config\.json/);
  assert.doesNotMatch(output, /\bat .*\.js:\d+:\d+/, 'should not print a stack trace');
});

test('parts.json validation names every offending entry', () => {
  const { status, output } = inSandbox(
    (dir) => {
      const file = path.join(dir, 'parts.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete parsed.parts[0].listings[0].retailer;
      parsed.parts[1].id = parsed.parts[0].id; // duplicate
      delete parsed.parts[2].name;
      fs.writeFileSync(file, JSON.stringify(parsed));
    },
    ['--import', './src/lib/fatal.js', 'src/seed.js']
  );

  assert.equal(status, 1);
  assert.match(output, /listings\[0\] is missing "retailer"/);
  assert.match(output, /duplicate id/);
  assert.match(output, /missing "name"/);
  // The point of validating: not an opaque database error.
  assert.doesNotMatch(output, /SqliteError|NOT NULL constraint/);
});

test('the seeded config is valid', () => {
  const { status, output } = inSandbox(() => {}, ['src/seed.js']);
  assert.equal(status, 0, output);
  assert.match(output, /Seeded 9 parts/);
});

/**
 * The manual-prices template ships blank and committed. It must behave as a
 * no-op until a real price is entered — activating it early would stand `sample`
 * down, purge the synthetic history, and leave every part unpriced.
 */
test('a blank manual-prices template does not activate the manual source', () => {
  const { status, output } = inSandbox(() => {}, ['src/fetch-once.js', '--list']);
  assert.equal(status, 0);
  assert.match(output, /manual\s+not configured/);
  assert.match(output, /sample\s+ACTIVE/);
});

test('filling one price activates manual and stands sample down', () => {
  const { status, output } = inSandbox((dir) => {
    const file = path.join(dir, 'manual-prices.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.prices.find((p) => p.partId === 'cpu-ryzen-7-5700x').price = 199.99;
    fs.writeFileSync(file, JSON.stringify(parsed));
  }, ['src/fetch-once.js', '--list']);

  assert.equal(status, 0);
  assert.match(output, /manual\s+ACTIVE/);
  assert.match(output, /sample\s+standby/);
});

test('unfilled rows are skipped quietly, not reported as errors', () => {
  const { status, output } = inSandbox((dir) => {
    const file = path.join(dir, 'manual-prices.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.prices.find((p) => p.partId === 'fan-arctic-p12').price = 8.99;
    fs.writeFileSync(file, JSON.stringify(parsed));
  }, ['src/fetch-once.js']);

  assert.equal(status, 0);
  assert.match(output, /manual: 1 price/);
  assert.doesNotMatch(output, /bad price/, 'null rows must not be reported as bad');
});

test('the shipped template covers every seeded part, with a link each', () => {
  const template = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config/manual-prices.json'), 'utf8')
  );
  const parts = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/parts.json'), 'utf8')).parts;

  assert.equal(template.prices.length, parts.length);
  assert.deepEqual(
    template.prices.map((p) => p.partId).sort(),
    parts.map((p) => p.id).sort()
  );
  for (const row of template.prices) {
    assert.equal(row.price, null, `${row.partId} must ship blank`);
    assert.ok(row.url?.startsWith('https://'), `${row.partId} needs a link`);
  }
});

/** `npm run price` — manual entry without hand-editing JSON. */
test('the price CLI resolves a part by unambiguous fragment and writes it', () => {
  const { status, output } = inSandbox(() => {}, ['src/set-price.js', 'cpu', '148.99']);
  assert.equal(status, 0, output);
  assert.match(output, /cpu-ryzen-7-5700x: — → \$148\.99/);
});

test('the price CLI accepts a pasted currency string', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-price-'));
  const configDir = path.join(dir, 'config');
  fs.cpSync(path.join(ROOT, 'config'), configDir, { recursive: true });

  const run = spawnSync(process.execPath, ['src/set-price.js', 'gpu', '$1,234.56'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: path.join(dir, 'data'), CONFIG_DIR: configDir },
  });

  assert.equal(run.status, 0, run.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(configDir, 'manual-prices.json'), 'utf8'));
  assert.equal(written.prices.find((p) => p.partId === 'gpu-asrock-rx-7900-xt').price, 1234.56);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the price CLI refuses an ambiguous fragment rather than guessing', () => {
  const { status, output } = inSandbox(() => {}, ['src/set-price.js', 'a', '10']);
  assert.equal(status, 1);
  assert.match(output, /ambiguous/);
});

test('the price CLI clears with a bare word, since npm swallows --clear', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-price-'));
  const configDir = path.join(dir, 'config');
  fs.cpSync(path.join(ROOT, 'config'), configDir, { recursive: true });
  const env = { ...process.env, DATA_DIR: path.join(dir, 'data'), CONFIG_DIR: configDir };
  const file = path.join(configDir, 'manual-prices.json');

  spawnSync(process.execPath, ['src/set-price.js', 'fan', '9.99'], { cwd: ROOT, env });
  assert.equal(
    JSON.parse(fs.readFileSync(file, 'utf8')).prices.find((p) => p.partId === 'fan-arctic-p12').price,
    9.99
  );

  spawnSync(process.execPath, ['src/set-price.js', 'fan', 'clear'], { cwd: ROOT, env });
  assert.equal(
    JSON.parse(fs.readFileSync(file, 'utf8')).prices.find((p) => p.partId === 'fan-arctic-p12').price,
    null
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the price CLI rejects a nonsense amount', () => {
  const { status, output } = inSandbox(() => {}, ['src/set-price.js', 'cpu', 'free']);
  assert.equal(status, 1);
  assert.match(output, /not a valid price/);
});

/**
 * Owner recognition. This is a marker, not access control — but the digest is
 * published, so the key itself must never reach the repository.
 */
test('any configured owner key is a digest, never the key in the clear', () => {
  // Unset is a valid state — the feature is opt-in. What must never happen is a
  // readable secret sitting in a config file that ships to a public repo.
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/config.json'), 'utf8'));
  const digest = config.site?.ownerKeyHash;
  if (digest === undefined) return;
  assert.match(digest, /^[a-f0-9]{64}$/, 'must be a SHA-256 hex digest, not a key');
});

test('no credential-shaped value is committed anywhere in config', () => {
  // An API key pasted into config instead of .env is the mistake this catches.
  for (const name of ['config.json', 'parts.json', 'manual-prices.json']) {
    const file = path.join(ROOT, 'config', name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      text,
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
      `${name} contains a UUID — credentials belong in .env or repo secrets`
    );
  }
});

test('the owner-key CLI round-trips a key to its digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-owner-'));
  const configDir = path.join(dir, 'config');
  fs.cpSync(path.join(ROOT, 'config'), configDir, { recursive: true });
  const env = { ...process.env, DATA_DIR: path.join(dir, 'data'), CONFIG_DIR: configDir };
  const file = path.join(configDir, 'config.json');

  const secret = 'a-long-enough-test-key-0001';
  const expected = createHash('sha256').update(secret, 'utf8').digest('hex');

  spawnSync(process.execPath, ['src/set-owner-key.js', secret], { cwd: ROOT, env });
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.site.ownerKeyHash, expected);
  assert.doesNotMatch(JSON.stringify(written), new RegExp(secret), 'key must not be stored in the clear');

  spawnSync(process.execPath, ['src/set-owner-key.js', 'clear'], { cwd: ROOT, env });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).site?.ownerKeyHash, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a too-short owner key is refused, since the digest is public', () => {
  const { status, output } = inSandbox(() => {}, ['--import', './src/lib/fatal.js', 'src/set-owner-key.js', 'abc']);
  assert.equal(status, 1);
  assert.match(output, /long and random/);
});
