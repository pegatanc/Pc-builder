import { config } from '../config.js';
import { checkRobots } from './robots.js';

const { userAgent, minDelayMsPerHost, timeoutMs, maxRetries } = config.sources.http;

/** Per-host serialised queue so we never issue concurrent requests to one host. */
const hostChains = new Map();
const lastHit = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function throttle(host, delayMs = 0) {
  const prev = hostChains.get(host) || Promise.resolve();
  const next = prev.then(async () => {
    const since = Date.now() - (lastHit.get(host) || 0);
    const wait = Math.max(delayMs, minDelayMsPerHost) - since;
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
  });
  hostChains.set(
    host,
    next.catch(() => {})
  );
  return next;
}

/**
 * Rate-limited fetch. Set `respectRobots: true` for anything that touches a
 * retail page — the request is refused outright if robots.txt disallows it.
 */
export async function politeFetch(url, { respectRobots = false, headers = {}, ...init } = {}) {
  const target = new URL(url);
  let crawlDelayMs = 0;

  if (respectRobots) {
    const verdict = await checkRobots(url, { userAgent, timeoutMs });
    if (!verdict.allowed) {
      const err = new Error(`Blocked: ${verdict.reason} (${url})`);
      err.code = 'ROBOTS_DISALLOWED';
      throw err;
    }
    crawlDelayMs = verdict.crawlDelayMs;
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttle(target.host, crawlDelayMs);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': userAgent, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });

      // Back off on throttling / transient server errors, give up on the rest.
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} from ${target.host}`);
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function fetchJson(url, options) {
  const res = await politeFetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export { userAgent };
