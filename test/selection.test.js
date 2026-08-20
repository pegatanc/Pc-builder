/**
 * Swapping an alternative into the build.
 *
 * applySelections() is the one place a swap takes effect — the summary cards,
 * the table and the copy-links list all read its output — so the arithmetic and
 * the honesty rules are worth testing directly rather than through the DOM.
 *
 * The function is pure and depends on nothing else in app.js, so it is lifted
 * out of the shipped file and evaluated here. That means these tests exercise
 * the real code; if it is renamed or grows a dependency, they fail loudly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

function lift(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `public/app.js no longer defines ${name}()`);
  // Balance braces from the first one, so the extraction survives edits inside.
  const open = app.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) {
      // This context, not a new one: a fresh realm gives the returned arrays a
      // different Array constructor, and assert/strict compares by realm.
      return vm.runInThisContext(`${app.slice(start, i + 1)}; ${name}`);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}()`);
}

const applySelections = lift('applySelections');

function alt(overrides = {}) {
  return {
    asin: 'B0ALT00001',
    title: 'A cheaper board',
    price: 100,
    currency: 'USD',
    url: 'https://www.amazon.com/dp/B0ALT00001',
    rating: 4.5,
    ratingsTotal: 900,
    discoveredAt: '2026-08-01T00:00:00.000Z',
    deltaVsBest: -50,
    ...overrides,
  };
}

function item(overrides = {}) {
  return {
    id: 'mobo',
    name: 'Original board',
    category: 'Motherboard',
    target: 160,
    best: {
      retailer: 'Amazon',
      source: 'canopy',
      price: 150,
      currency: 'USD',
      inStock: true,
      url: 'https://example.test/original',
      stale: false,
    },
    series: [{ day: '2026-08-01', price: 150 }, { day: '2026-08-02', price: 150 }],
    stats: { windowDays: 30, avgWindow: 150, samples: 9, low: 140, lowDay: '2026-08-01', dropPercent: 0 },
    flags: { drop: false, atOrBelowTarget: true, atLowest: false, noPrice: false, stale: false },
    alternatives: [alt()],
    ...overrides,
  };
}

function build(items) {
  const priced = items.filter((i) => i.best);
  const total = priced.reduce((sum, i) => sum + i.best.price, 0);
  return {
    currency: 'USD',
    items,
    totalSeries: [{ day: '2026-08-01', price: total }],
    summary: {
      total,
      totalLow: total,
      totalLowDay: '2026-08-01',
      pricedParts: priced.length,
      totalParts: items.length,
      baseline: 1000,
      baselineDelta: total - 1000,
      baselineDeltaPercent: 0,
      targetTotal: items.reduce((s, i) => s + (i.target ?? 0), 0),
      alerts: 0,
      atTarget: priced.length,
    },
    alertRule: { dropPercent: 10, windowDays: 30, minSamples: 3 },
  };
}

test('no selections returns the data untouched', () => {
  const data = build([item()]);
  assert.equal(applySelections(data, {}), data, 'the same object, not a copy');
});

test('a swap replaces the price and recomputes the total', () => {
  const data = build([item(), item({ id: 'cpu', name: 'CPU', target: 200, alternatives: [] })]);
  const view = applySelections(data, { mobo: 'B0ALT00001' });

  assert.equal(view.summary.total, 250, '150 + 150 becomes 100 + 150');
  assert.equal(view.summary.baselineDelta, -750);
  assert.equal(view.selection.count, 1);
  assert.deepEqual(view.selection.partIds, ['mobo']);
  // The source data must not be mutated — a later render reads it back.
  assert.equal(data.summary.total, 300);
  assert.equal(data.items[0].name, 'Original board');
});

test('a swapped part carries the new title and what it replaced', () => {
  const view = applySelections(build([item()]), { mobo: 'B0ALT00001' });
  const swapped = view.items[0];

  assert.equal(swapped.name, 'A cheaper board');
  assert.equal(swapped.replaces, 'Original board');
  assert.equal(swapped.best.price, 100);
  assert.equal(swapped.best.source, 'alternative');
  assert.equal(swapped.best.url, 'https://www.amazon.com/dp/B0ALT00001');
});

test('a swapped part shows no history, because the history is the old part\'s', () => {
  const view = applySelections(build([item()]), { mobo: 'B0ALT00001' });
  const swapped = view.items[0];

  assert.deepEqual(swapped.series, [], 'the sparkline must not describe a different product');
  assert.equal(swapped.stats.avgWindow, null);
  assert.equal(swapped.stats.low, null);
  assert.equal(swapped.stats.dropPercent, null);
  assert.equal(swapped.flags.drop, false, 'a drop alert needs an average to measure against');
  assert.equal(swapped.flags.atLowest, false);
  // Same reasoning one level up: the build's trend is not evidence about a
  // build that now contains something else.
  assert.deepEqual(view.totalSeries, []);
  assert.equal(view.summary.totalLow, null);
});

test('the target comparison follows the new price', () => {
  const overTarget = applySelections(build([item()]), { mobo: 'B0ALT00001' });
  assert.equal(overTarget.items[0].flags.atOrBelowTarget, true, '100 is under the 160 target');

  const dearer = build([item({ alternatives: [alt({ price: 400 })] })]);
  const view = applySelections(dearer, { mobo: 'B0ALT00001' });
  assert.equal(view.items[0].flags.atOrBelowTarget, false);
  assert.equal(view.summary.atTarget, 0);
});

test('swapping into an unpriced part completes the total', () => {
  // The reason this feature answers "avoid items you don't know the price of":
  // a part with no price is excluded from the total, and choosing a priced
  // alternative is how it gets back in.
  const unpriced = item({ best: null, series: [], flags: { ...item().flags, noPrice: true } });
  const data = build([unpriced]);
  assert.equal(data.summary.pricedParts, 0);

  const view = applySelections(data, { mobo: 'B0ALT00001' });
  assert.equal(view.summary.pricedParts, 1);
  assert.equal(view.summary.total, 100);
  assert.equal(view.items[0].flags.noPrice, false);
});

test('an alternative with no price is never swapped in', () => {
  // It would silently drop the part out of the total instead of changing it.
  const data = build([item({ alternatives: [alt({ price: null })] })]);
  const view = applySelections(data, { mobo: 'B0ALT00001' });

  assert.equal(view, data, 'nothing changes');
  assert.equal(view.summary.total, 150);
});

test('a selection whose asin is gone after a refresh is ignored', () => {
  const data = build([item()]);
  const view = applySelections(data, { mobo: 'B0VANISHED' });
  assert.equal(view, data);
});

test('a selection for an unknown part is ignored', () => {
  const data = build([item()]);
  assert.equal(applySelections(data, { 'no-such-part': 'B0ALT00001' }), data);
});

test('several swaps all land in the total', () => {
  const data = build([
    item(),
    item({ id: 'cpu', name: 'CPU', target: 200, alternatives: [alt({ asin: 'B0ALT00002', price: 75 })] }),
  ]);
  const view = applySelections(data, { mobo: 'B0ALT00001', cpu: 'B0ALT00002' });

  assert.equal(view.selection.count, 2);
  assert.equal(view.summary.total, 175);
  assert.equal(view.summary.pricedParts, 2);
});
