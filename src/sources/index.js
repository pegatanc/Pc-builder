import { config } from '../config.js';
import canopy from './canopy.js';
import paapi from './paapi.js';
import keepa from './keepa.js';
import bestbuy from './bestbuy.js';
import jsonld from './jsonld.js';
import browser from './browser.js';
import manual from './manual.js';
import sample from './sample.js';

export const registry = { canopy, paapi, keepa, bestbuy, jsonld, browser, manual, sample };

/** Sources in config order, annotated with whether they can actually run. */
export function describeSources() {
  const { order, enabled } = config.sources;
  const names = [...order, ...Object.keys(registry).filter((n) => !order.includes(n))];

  const described = names
    .filter((name) => registry[name])
    .map((name) => {
      const source = registry[name];
      const isEnabled = enabled[name] !== false;
      const configured = source.isConfigured();
      return {
        name,
        label: source.label,
        notes: source.notes,
        requires: source.requires,
        synthetic: !!source.synthetic,
        enabled: isEnabled,
        configured,
        active: isEnabled && configured,
        missingEnv: (source.requires || []).filter((key) => !process.env[key]),
      };
    });

  // Synthetic data stands down as soon as a real source can run — demo prices
  // should never sit alongside real ones in the same history.
  const hasReal = described.some((s) => s.active && !s.synthetic);
  for (const source of described) {
    source.willRun = source.active && !(source.synthetic && hasReal);
    source.standby = source.active && !source.willRun;
  }

  return described;
}

export function activeSources() {
  return describeSources()
    .filter((s) => s.willRun)
    .map((s) => registry[s.name]);
}

/** True when nothing but synthetic data is available. */
export function usingSampleData() {
  const running = describeSources().filter((s) => s.willRun);
  return running.length > 0 && running.every((s) => s.synthetic);
}
