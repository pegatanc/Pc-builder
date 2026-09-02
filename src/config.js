import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = process.env.CONFIG_DIR || path.join(ROOT, 'config');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

/** Repo-relative where possible, absolute when the file lives outside the repo. */
function displayPath(file) {
  const rel = path.relative(ROOT, file);
  return rel.startsWith('..') ? file : rel;
}

/** A config problem the user can fix by editing a file — reported without a stack. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.isConfigError = true;
  }
}

/**
 * @param {string} file
 * @param {object} [options]
 * @param {*} [options.fallback]  value to use when the file is absent
 * @param {boolean} [options.required]  when false, a malformed file degrades to
 *   `fallback` with a warning instead of taking the process down. Optional files
 *   are hand-edited, so one stray comma must not brick the app.
 */
function readJson(file, { fallback, required = true } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new ConfigError(`Could not read ${displayPath(file)}: ${err.message}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    const where = `${displayPath(file)}: ${err.message}`;
    if (required) throw new ConfigError(`Could not parse ${where}`);
    // isConfigured() re-reads on every call; say it once, not once per check.
    if (!warned.has(file)) {
      warned.add(file);
      console.warn(`[config] ignoring ${where}`);
    }
    return fallback;
  }
}

const warned = new Set();

const defaults = {
  currency: 'USD',
  baselineTotal: 0,
  schedule: { cron: '0 */12 * * *', timezone: 'UTC', runOnStart: true },
  alerts: { dropPercent: 10, windowDays: 30, minSamples: 3 },
  alternatives: { enabled: true, perPart: 5, refreshDays: 7, minRating: 4.0, minReviews: 50, priceBand: [0.4, 2.5] },
  sources: {
    order: ['paapi', 'keepa', 'bestbuy', 'jsonld', 'manual', 'sample'],
    ebay: {
      marketplace: 'EBAY_US',
      conditions: ['NEW'],
      includeShipping: true,
      minPriceRatio: 0.4,
      maxPriceRatio: 2.5,
      limit: 20,
    },
    enabled: {},
    http: { userAgent: 'pc-builder-price-tracker/1.0', minDelayMsPerHost: 5000, timeoutMs: 15000, maxRetries: 2 },
  },
  targets: {},
  site: {},
};

export function loadConfig() {
  const raw = readJson(path.join(CONFIG_DIR, 'config.json'), { fallback: {} });
  return {
    ...defaults,
    ...raw,
    schedule: { ...defaults.schedule, ...raw.schedule },
    alerts: { ...defaults.alerts, ...raw.alerts },
    alternatives: { ...defaults.alternatives, ...raw.alternatives },
    sources: {
      ...defaults.sources,
      ...raw.sources,
      enabled: { ...defaults.sources.enabled, ...raw.sources?.enabled },
      ebay: { ...defaults.sources.ebay, ...raw.sources?.ebay },
      http: { ...defaults.sources.http, ...raw.sources?.http },
    },
    targets: { ...defaults.targets, ...raw.targets },
    site: { ...defaults.site, ...raw.site },
  };
}

export function loadParts() {
  const raw = readJson(path.join(CONFIG_DIR, 'parts.json'), { fallback: { parts: [] } });
  return raw.parts || [];
}

/**
 * Manual price overrides. Optional and hand-written, so a malformed file
 * disables the `manual` source with a warning rather than stopping everything.
 */
export function loadManualPrices() {
  const raw = readJson(path.join(CONFIG_DIR, 'manual-prices.json'), {
    fallback: null,
    required: false,
  });
  return raw?.prices || [];
}

export const config = loadConfig();
