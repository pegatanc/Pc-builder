import { db } from './db.js';
import { getTrackedListings, recordObservations, startRun, finishRun } from './repo.js';
import { activeSources, usingSampleData, registry } from './sources/index.js';
import sample from './sources/sample.js';

const BACKFILL_DAYS = 90;

let running = null;

/**
 * Once a real source is configured, drop any synthetic history left over from
 * the demo run — otherwise sample prices would skew the 30-day average and
 * alerting for weeks. Runs once; after the purge there is nothing left to find.
 */
export function purgeSyntheticHistory({ log = console.log } = {}) {
  if (usingSampleData()) return 0;

  const { count } = db
    .prepare(`SELECT COUNT(*) AS count FROM price_history WHERE source = 'sample'`)
    .get();
  if (!count) return 0;

  db.prepare(`DELETE FROM price_history WHERE source = 'sample'`).run();
  log(`[data] real price source configured — removed ${count} synthetic observation(s).`);
  return count;
}

/**
 * Runs every active source and appends observations. Sources are ordered by
 * config; the first source to report a price for a (part, retailer) pair wins,
 * so a real API always beats a fallback for the same retailer.
 */
export async function runFetch({ trigger = 'manual', log = console.log } = {}) {
  if (running) {
    log('Fetch already in progress — joining the running one.');
    return running;
  }

  running = (async () => {
    const sources = activeSources();
    const parts = getTrackedListings();
    const runId = startRun(trigger, sources.map((s) => s.name));
    const errors = [];
    const claimed = new Set();
    const accepted = [];

    log(`[fetch] ${trigger} run — sources: ${sources.map((s) => s.name).join(', ') || 'none'}`);

    for (const source of sources) {
      let observations = [];
      try {
        observations = await source.fetch(parts);
      } catch (err) {
        // A source may report a usable subset alongside its errors.
        observations = err.partial || [];
        errors.push(`${source.name}: ${err.message}`);
        log(`[fetch] ${source.name} reported errors: ${err.message}`);
      }

      let kept = 0;
      for (const observation of observations) {
        const key = `${observation.part_id}::${observation.retailer}`;
        if (claimed.has(key)) continue; // higher-priority source already covered it
        if (!observation.price_cents || observation.price_cents <= 0) continue;
        claimed.add(key);
        accepted.push(observation);
        kept++;
      }
      log(`[fetch] ${source.name}: ${kept} price(s)`);
    }

    if (accepted.length) recordObservations(accepted);
    finishRun(runId, accepted.length, errors);
    log(`[fetch] recorded ${accepted.length} observation(s)${errors.length ? `, ${errors.length} error(s)` : ''}`);

    return { observations: accepted.length, errors, sources: sources.map((s) => s.name) };
  })();

  try {
    return await running;
  } finally {
    running = null;
  }
}

/**
 * On a fresh database with only synthetic data available, lay down 90 days of
 * history so the sparkline, 30-day average and alert rule have something to
 * work with immediately.
 */
export function backfillIfEmpty({ log = console.log } = {}) {
  if (!usingSampleData()) return 0;

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM price_history').get();
  if (count > 0) return 0;

  const observations = sample.backfill(getTrackedListings(), BACKFILL_DAYS);
  recordObservations(observations);
  log(`[seed] backfilled ${observations.length} synthetic observations over ${BACKFILL_DAYS} days.`);
  return observations.length;
}

export { registry };
