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

/** Copy-all-links button. */
test('the copy button exists and is not the one hidden in static mode', () => {
  assert.match(html, /id="copy-links"/, 'markup needs the copy button');
  // applyMode hides #refresh when there is no API behind the page; the copy
  // button is pure client-side and must keep working in the published build.
  const applyMode = app.slice(app.indexOf('function applyMode'), app.indexOf('function applyMode') + 600);
  assert.match(applyMode, /getElementById\('refresh'\)/);
  assert.doesNotMatch(applyMode, /copy-links/, 'copy button must not be hidden in static mode');
});

test('the copied list is built from the displayed order', () => {
  const fn = app.slice(app.indexOf('function partLinkList'), app.indexOf('async function copyText'));
  assert.match(fn, /sortItems\(data\.items, sortState\)/, 'must copy in the order shown');
  assert.match(fn, /\.filter\(Boolean\)/, 'parts without a link must be dropped');
});

test('clipboard copy falls back when there is no secure context', () => {
  const fn = app.slice(app.indexOf('async function copyText'), app.indexOf('function wireCopyLinks'));
  assert.match(fn, /isSecureContext/, 'must check for a secure context');
  assert.match(fn, /execCommand\('copy'\)/, 'needs a fallback for plain-HTTP origins');
});

/** Alternatives expansion row. */
test('the alternatives row spans the whole table', () => {
  const fn = app.slice(app.indexOf('function renderAlternativesRow'));
  assert.match(fn, /cell\.colSpan = columnCount/, 'the expansion cell must span every column');
  // columnCount is read from the live header, so adding a column cannot leave a
  // stale literal behind — the trap the colspan test above exists to catch.
  assert.match(app, /#parts-table thead th'\)\.length/, 'columnCount must come from the header');
});

test('the alternatives toggle is a real button with its expanded state', () => {
  assert.match(app, /el\('button', 'alt-toggle'\)/, 'the disclosure must be a button, not a div');
  assert.match(app, /toggle\.setAttribute\('aria-expanded'/, 'the state must be exposed to AT');
  assert.match(app, /toggle\.type = 'button'/, 'a bare button inside a form would submit it');
});

test('alternative links open safely in a new tab', () => {
  const fn = app.slice(app.indexOf('function renderAlternativesRow'), app.indexOf('/* ---------- owner'));
  assert.match(fn, /rel = 'noopener noreferrer'/, 'outbound links need noopener');
});

test('the phone layout resets the alternatives cell out of the flex row', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 720px)'));
  // Same class-versus-`td` specificity trap as .col-part: the `td` flex rule
  // would otherwise put the title, price and note on one baseline.
  assert.match(phone, /td\.alt-cell\s*\{/, 'phone layout must reset td.alt-cell to a block');
  assert.match(phone, /\.alt-item\s*\{/, 'phone layout must restack the alternative rows');
});

/** Swapping alternatives into the build. */
test('the selection bar exists and can actually hide', () => {
  assert.match(html, /id="selection-bar"/, 'markup needs the selection bar');
  // `display: flex` outranks the UA stylesheet's `[hidden] { display: none }`,
  // so without this rule the bar stays on screen with nothing in it.
  assert.match(css, /\.selection-bar\[hidden\]\s*\{\s*display:\s*none/, 'the bar must honour [hidden]');
});

test('everything rendered goes through the selection view', () => {
  // A render that reads lastData directly would show the tracked part in one
  // place and the swapped one in another.
  const boot = app.slice(app.indexOf('let lastData = null;'));
  assert.doesNotMatch(boot, /renderTable\(lastData\)/, 'renderTable must take the derived view');
  assert.doesNotMatch(boot, /renderSummary\(lastData\)/, 'renderSummary must take the derived view');
  assert.match(app, /partLinkList\(currentView\(\)\)/, 'copied links must reflect swaps too');
});

test('a swap is saved under a versioned key and survives a reload', () => {
  assert.match(app, /const SELECTION_KEY = 'pc-tracker-selections'/);
  const fn = app.slice(app.indexOf('function loadSelections'), app.indexOf('function saveSelections'));
  assert.match(fn, /try\s*\{/, 'a corrupt or hand-edited entry must not break boot');
});

test('an alternative with no price cannot be swapped in', () => {
  const fn = app.slice(app.indexOf('function renderAlternativesRow'));
  assert.match(fn, /alt\.price == null/, 'the button must check for a price');
  assert.match(fn, /use\.disabled = true/, 'and disable itself when there is none');
});
