/**
 * Static consistency checks on the frontend. No DOM here — these guard the
 * couplings that broke silently while the table grew a column: the colspans
 * used for empty states, and the sort keys shared between markup and script.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

const headerCount = (html.match(/<th\b/g) || []).length;

test('every colspan matches the number of columns', () => {
  assert.ok(headerCount > 0, 'no <th> found');

  for (const [, value] of html.matchAll(/colspan="(\d+)"/gi)) {
    assert.equal(Number(value), headerCount, `markup colspan ${value} ≠ ${headerCount} columns`);
  }
  for (const [, value] of app.matchAll(/colSpan = (\d+)/g)) {
    // The footer spacer deliberately spans a subset; everything else spans all.
    if (Number(value) === headerCount) continue;
    assert.ok(
      Number(value) < headerCount,
      `app.js colSpan ${value} exceeds ${headerCount} columns`
    );
  }
});

test('the footer row spans exactly the full width', () => {
  // 4 labelled cells plus one spacer, which must cover the remainder.
  const spacer = Number(app.match(/spacer\.colSpan = (\d+)/)[1]);
  const labelled = (app.match(/totalRow\.append\(/g) || []).length - 1; // minus the spacer
  assert.equal(labelled + spacer, headerCount, 'footer cells do not span the table');
});

test('every sortable header has a matching sort key in app.js', () => {
  const headers = [...html.matchAll(/data-sort="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(headers.length >= 5, `expected several sortable headers, got ${headers.length}`);

  const block = app.slice(app.indexOf('const SORTS = {'), app.indexOf('const SORT_KEY'));
  for (const header of headers) {
    assert.match(block, new RegExp(`\\b${header}:\\s*\\{`), `SORTS is missing "${header}"`);
  }
});

test('each sortable header renders an arrow slot', () => {
  const sortable = (html.match(/data-sort="/g) || []).length;
  const arrows = (html.match(/class="sort-arrow"/g) || []).length;
  assert.equal(arrows, sortable, 'every sortable header needs a .sort-arrow span');
});

test('the phone layout resets the desktop column widths', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 720px)'));
  // .col-spark/.col-part are class selectors and outrank the `td` reset, so
  // they have to be cleared explicitly or cells keep their desktop widths.
  assert.match(phone, /\.col-spark/, 'phone layout must reset .col-spark width');
  assert.match(phone, /\.col-part/, 'phone layout must reset .col-part width');
});

test('the wide sparkline rule follows the base rule it overrides', () => {
  // Equal specificity, so source order is what makes spark-wide win.
  assert.ok(
    css.indexOf('canvas.spark-wide') > css.indexOf('canvas.spark {'),
    'canvas.spark-wide must come after canvas.spark'
  );
});
