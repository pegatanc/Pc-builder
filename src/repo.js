import { db, fromCents } from './db.js';
import { config } from './config.js';

const SPARKLINE_DAYS = 90;
const STALE_AFTER_DAYS = 7;

const listParts = db.prepare(`
  SELECT id, name, category, brand, model, spec
  FROM parts
  ORDER BY sort_order, name
`);

/**
 * Both queries join `listings`, which restricts them to retailers the part is
 * still tracked at. History is append-only and retains observations from
 * retailers since removed from parts.json — those stay in the record, but must
 * not resurface as a current offer, win "cheapest", or skew the 30-day average
 * the drop alert is measured against.
 */
const latestPerRetailer = db.prepare(`
  SELECT part_id, retailer, source, price_cents, currency, in_stock, url, observed_at
  FROM (
    SELECT ph.*, ROW_NUMBER() OVER (
      PARTITION BY ph.part_id, ph.retailer ORDER BY ph.observed_at DESC, ph.id DESC
    ) AS rn
    FROM price_history ph
    JOIN listings l ON l.part_id = ph.part_id AND l.retailer = ph.retailer
  )
  WHERE rn = 1
`);

/**
 * Daily cheapest price per part over the sparkline window. One point per day
 * keeps the sparkline honest when a fetch runs twice in a day.
 */
const dailySeries = db.prepare(`
  SELECT ph.part_id                AS part_id,
         DATE(ph.observed_at)      AS day,
         MIN(ph.price_cents)       AS price_cents
  FROM price_history ph
  JOIN listings l ON l.part_id = ph.part_id AND l.retailer = ph.retailer
  WHERE ph.observed_at >= DATETIME('now', ?)
    AND ph.in_stock = 1
  GROUP BY ph.part_id, day
  ORDER BY ph.part_id, day
`);

const listingsStmt = db.prepare(`
  SELECT part_id, retailer, asin, sku, query, alt_query, url, allow_html
  FROM listings
  ORDER BY part_id, retailer
`);

const alternativesStmt = db.prepare(`
  SELECT part_id, asin, title, price_cents, currency, url, image_url, rating, ratings_total, discovered_at
  FROM alternatives
  ORDER BY part_id, price_cents
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
  const alternativesByPart = groupBy(alternativesStmt.all(), 'part_id');

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

    // Extremes over the whole tracked window, with the day they happened —
    // "is this actually a good price?" is the question a tracker exists to answer.
    const extreme = (pick) =>
      series.length ? series.reduce((a, b) => (pick(b.price, a.price) ? b : a)) : null;
    const lowest = extreme((candidate, current) => candidate < current);
    const highest = extreme((candidate, current) => candidate > current);

    // Within a cent counts as matching, so rounding never hides the badge.
    const atLowest = !!(best && lowest && Math.abs(best.price - lowest.price) < 0.01);

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
        altQuery: l.alt_query,
        url: l.url,
        allowHtml: !!l.allow_html,
      })),
      alternatives: (alternativesByPart.get(part.id) || []).map((a) => ({
        asin: a.asin,
        title: a.title,
        price: fromCents(a.price_cents),
        currency: a.currency,
        url: a.url,
        imageUrl: a.image_url,
        rating: a.rating,
        ratingsTotal: a.ratings_total,
        discoveredAt: a.discovered_at,
        // Precomputed so the UI never has to know which offer "best" was.
        deltaVsBest:
          best && a.price_cents != null
            ? Number((fromCents(a.price_cents) - best.price).toFixed(2))
            : null,
      })),
      stats: {
        windowDays: alerts.windowDays,
        avgWindow,
        samples: windowPoints.length,
        low: lowest?.price ?? null,
        lowDay: lowest?.day ?? null,
        high: highest?.price ?? null,
        highDay: highest?.day ?? null,
        dropPercent: dropPercent == null ? null : Number(dropPercent.toFixed(1)),
        // How far above the cheapest it has ever been, in percent.
        aboveLowPercent:
          best && lowest?.price
            ? Number((((best.price - lowest.price) / lowest.price) * 100).toFixed(1))
            : null,
      },
      flags: {
        drop: dropAlert,
        atOrBelowTarget: !!(best && target != null && best.price <= target),
        atLowest,
        noPrice: !best,
        stale: !!best?.stale,
      },
    };
  });

  const priced = items.filter((i) => i.best);
  const total = priced.reduce((sum, i) => sum + i.best.price, 0);
  const targetTotal = items.reduce((sum, i) => sum + (i.target ?? 0), 0);

  // Build total per day, over only the days where every tracked part has a
  // price. A day missing one part would otherwise read as a sudden discount.
  const tracked = items.filter((i) => i.series.length);
  const byDay = new Map();
  for (const item of tracked) {
    for (const point of item.series) {
      const entry = byDay.get(point.day) || { sum: 0, parts: 0 };
      entry.sum += point.price;
      entry.parts += 1;
      byDay.set(point.day, entry);
    }
  }
  const totalSeries = [...byDay.entries()]
    .filter(([, entry]) => entry.parts === tracked.length)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, entry]) => ({ day, price: Number(entry.sum.toFixed(2)) }));

  const totalLow = totalSeries.length
    ? totalSeries.reduce((a, b) => (b.price < a.price ? b : a))
    : null;

  return {
    currency,
    generatedAt: new Date().toISOString(),
    items,
    totalSeries,
    summary: {
      total: Number(total.toFixed(2)),
      totalLow: totalLow?.price ?? null,
      totalLowDay: totalLow?.day ?? null,
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
      altQuery: l.alt_query,
      url: l.url,
      allowHtml: !!l.allow_html,
    })),
  }));
}
