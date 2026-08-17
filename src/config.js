import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`Could not read ${path.relative(ROOT, file)}: ${err.message}`);
  }
}

const defaults = {
  currency: 'USD',
  baselineTotal: 0,
  schedule: { cron: '0 */12 * * *', timezone: 'UTC', runOnStart: true },
  alerts: { dropPercent: 10, windowDays: 30, minSamples: 3 },
  sources: {
    order: ['paapi', 'keepa', 'bestbuy', 'jsonld', 'manual', 'sample'],
    enabled: {},
    http: { userAgent: 'pc-builder-price-tracker/1.0', minDelayMsPerHost: 5000, timeoutMs: 15000, maxRetries: 2 },
  },
  targets: {},
};

export function loadConfig() {
  const raw = readJson(path.join(CONFIG_DIR, 'config.json'), {});
  return {
    ...defaults,
    ...raw,
    schedule: { ...defaults.schedule, ...raw.schedule },
    alerts: { ...defaults.alerts, ...raw.alerts },
    sources: {
      ...defaults.sources,
      ...raw.sources,
      enabled: { ...defaults.sources.enabled, ...raw.sources?.enabled },
      http: { ...defaults.sources.http, ...raw.sources?.http },
    },
    targets: { ...defaults.targets, ...raw.targets },
  };
}

export function loadParts() {
  const raw = readJson(path.join(CONFIG_DIR, 'parts.json'), { parts: [] });
  return raw.parts || [];
}

/** Manual price overrides. Optional file — absent is the normal case. */
export function loadManualPrices() {
  const raw = readJson(path.join(CONFIG_DIR, 'manual-prices.json'), null);
  return raw?.prices || [];
}

export const config = loadConfig();
