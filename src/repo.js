import { db, fromCents } from './db.js';
import { config } from './config.js';

const SPARKLINE_DAYS = 90;
const STALE_AFTER_DAYS = 7;

const listParts = db.prepare(`
  SELECT id, name, category, brand, model, spec
  FROM parts
  ORDER BY sort_order, name
`);

/** Most recent observation for each (part, retailer) pair. */
const latestPerRetailer = db.prepare(`
  SELECT part_id, retailer, source, price_cents, currency, in_stock, url, observed_at
  FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY part_id, retailer ORDER BY observed_at DESC, id DESC
    ) AS rn
    FROM price_history
  )
  WHERE rn = 1
`);

/**
 * Daily cheapest price per part over the sparkline window. One point per day
 * keeps the sparkline honest when a fetch runs twice in a day.
 */
const dailySeries = db.prepare(`
  SELECT part_id,
         DATE(observed_at) AS day,
         MIN(price_cents)  AS price_cents
  FROM price_history
  WHERE observed_at >= DATETIME('now', ?)
    AND in_stock = 1
  GROUP BY part_id, day
  ORDER BY part_id, day
`);

const listingsStmt = db.prepare(`
  SELECT part_id, retailer, asin, sku, query, url, allow_html
  FROM listings
  ORDER BY part_id, retailer
`);

const lastRun = db.prepare(`
  SELECT started_at, finished_at, trigger, sources, observations, errors
  FROM fetch_runs
  ORDER BY id DESC
  LIMIT 1
`);

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

/**
 * Assembles the full build view: cheapest current price per part, retailer,
 * sparkline series, 30-day stats, target/baseline deltas and alert flags.
 */
export function getBuild() {
  const { alerts, targets, baselineTotal, currency } = config;
  const parts = listParts.all();
  const offersByPart = groupBy(latestPerRetailer.all(), 'part_id');
  const seriesByPart = groupBy(dailySeries.all(`-${SPARKLINE_DAYS} days`), 'part_id');
  const listingsByPart = groupBy(listingsStmt.all(), 'part_id');

  const windowStart = daysAgoIso(alerts.windowDays);
  const staleBefore = daysAgoIso(STALE_AFTER_DAYS);

  const items = parts.map((part) => {
    const offers = (offersByPart.get(part.id) || [])
      .map((o) => ({
        retailer: o.retailer,
        source: o.source,
        price: fromCents(o.price_cents),
        currency: o.currency,
        inStock: !!o.in_stock,
        url: o.url,
        observedAt: o.observed_at,
        stale: o.observed_at < staleBefore,
      }))
      .sort((a, b) => a.price - b.price);

    const available = offers.filter((o) => o.inStock);
    const best = available[0] || offers[0] || null;

    const series = (seriesByPart.get(part.id) || []).map((r) => ({
      day: r.day,
      price: fromCents(r.price_cents),
    }));

    const windowPoints = (seriesByPart.get(part.id) || [])
      .filter((r) => r.day >= windowStart.slice(0, 10))
      .map((r) => r.price_cents);

    const avgCents = average(windowPoints);
    const avgWindow = fromCents(avgCents == null ? null : Math.round(avgCents));
    const target = targets[part.id] ?? null;

    // Drop alert: current cheapest is >= dropPercent below the window average.
    let dropPercent = null;
    if (best && avgCents != null && avgCents > 0) {
      dropPercent = ((avgCents - best.price * 100) / avgCents) * 100;
    }
    const enoughSamples = windowPoints.length >= alerts.minSamples;
    const dropAlert =
      enoughSamples && dropPercent != null && dropPercent >= alerts.dropPercent;

    const allPrices = series.map((p) => p.price);

    return {
      id: part.id,
      name: part.name,
      category: part.category,
      brand: part.brand,
      model: part.model,
      spec: part.spec,
      target,
      best,
      offers,
      series,
      listings: (listingsByPart.get(part.id) || []).map((l) => ({
        retailer: l.retailer,
        asin: l.asin,
        sku: l.sku,
        query: l.query,
        url: l.url,
        allowHtml: !!l.allow_html,
      })),
      stats: {
        windowDays: alerts.windowDays,
        avgWindow,
        samples: windowPoints.length,
        low: allPrices.length ? Math.min(...allPrices) : null,
        high: allPrices.length ? Math.max(...allPrices) : null,
        dropPercent: dropPercent == null ? null : Number(dropPercent.toFixed(1)),
      },
      flags: {
        drop: dropAlert,
        atOrBelowTarget: !!(best && target != null && best.price <= target),
        noPrice: !best,
        stale: !!best?.stale,
      },
    };
  });

  const priced = items.filter((i) => i.best);
  const total = priced.reduce((sum, i) => sum + i.best.price, 0);
  const targetTotal = items.reduce((sum, i) => sum + (i.target ?? 0), 0);

  return {
    currency,
    generatedAt: new Date().toISOString(),
    items,
    summary: {
      total: Number(total.toFixed(2)),
      pricedParts: priced.length,
      totalParts: items.length,
      baseline: baselineTotal,
      baselineDelta: Number((total - baselineTotal).toFixed(2)),
      baselineDeltaPercent: baselineTotal
        ? Number((((total - baselineTotal) / baselineTotal) * 100).toFixed(1))
        : null,
      targetTotal: Number(targetTotal.toFixed(2)),
      alerts: items.filter((i) => i.flags.drop).length,
      atTarget: items.filter((i) => i.flags.atOrBelowTarget).length,
    },
    alertRule: {
      dropPercent: alerts.dropPercent,
      windowDays: alerts.windowDays,
      minSamples: alerts.minSamples,
    },
    lastRun: lastRun.get() || null,
  };
}

const insertPrice = db.prepare(`
  INSERT INTO price_history
    (part_id, retailer, source, price_cents, currency, in_stock, url, observed_at)
  VALUES
    (@part_id, @retailer, @source, @price_cents, @currency, @in_stock, @url, @observed_at)
`);

export const recordObservations = db.transaction((observations) => {
  for (const o of observations) insertPrice.run(o);
  return observations.length;
});

export function startRun(trigger, sources) {
  const info = db
    .prepare(`INSERT INTO fetch_runs (started_at, trigger, sources) VALUES (?, ?, ?)`)
    .run(new Date().toISOString(), trigger, sources.join(','));
  return info.lastInsertRowid;
}

export function finishRun(id, observations, errors) {
  db.prepare(
    `UPDATE fetch_runs SET finished_at = ?, observations = ?, errors = ? WHERE id = ?`
  ).run(new Date().toISOString(), observations, errors.length ? errors.join(' | ') : null, id);
}

export function getTrackedListings() {
  const parts = listParts.all();
  const byPart = groupBy(listingsStmt.all(), 'part_id');
  return parts.map((part) => ({
    ...part,
    listings: (byPart.get(part.id) || []).map((l) => ({
      retailer: l.retailer,
      asin: l.asin,
      sku: l.sku,
      query: l.query,
      url: l.url,
      allowHtml: !!l.allow_html,
    })),
  }));
}
