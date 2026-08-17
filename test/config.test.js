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
