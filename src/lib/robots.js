/**
 * Minimal but faithful robots.txt client: group selection by most-specific
 * user-agent token, longest-match rule precedence with Allow winning ties,
 * `*` / `$` wildcards, and Crawl-delay.
 *
 * Fetch failures are treated conservatively: a 4xx (no robots.txt) means
 * "allowed", anything else (5xx, network error) means "disallowed", which is
 * what the spec recommends for an unreachable robots.txt.
 */

const cache = new Map(); // origin -> { rules, fetchedAt }
const TTL_MS = 12 * 60 * 60 * 1000;

function patternToRegex(pattern) {
  let anchoredEnd = false;
  let p = pattern;
  if (p.endsWith('$')) {
    anchoredEnd = true;
    p = p.slice(0, -1);
  }
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + (anchoredEnd ? '$' : ''));
}

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!lastLineWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (!current) continue;

    if (field === 'allow' || field === 'disallow') {
      if (field === 'disallow' && value === '') continue; // empty Disallow = allow all
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value, length: value.length });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) current.crawlDelay = seconds;
    }
  }

  return groups;
}

/** Picks the group with the longest user-agent token matching ours, else `*`. */
export function selectGroup(groups, userAgent) {
  const ua = userAgent.toLowerCase();
  let best = null;
  let bestLen = -1;
  let wildcard = null;

  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        wildcard ??= group;
        continue;
      }
      if (ua.includes(agent) && agent.length > bestLen) {
        best = group;
        bestLen = agent.length;
      }
    }
  }
  return best || wildcard || null;
}

export function isAllowedBy(group, pathname) {
  if (!group) return true;
  let decision = true;
  let winner = -1;

  for (const rule of group.rules) {
    if (!patternToRegex(rule.pattern).test(pathname)) continue;
    // Longest match wins; Allow beats Disallow at equal length.
    if (rule.length > winner || (rule.length === winner && rule.allow)) {
      winner = rule.length;
      decision = rule.allow;
    }
  }
  return decision;
}

async function loadRobots(origin, userAgent, timeoutMs) {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;

  let entry;
  try {
    const res = await fetch(new URL('/robots.txt', origin), {
      headers: { 'user-agent': userAgent, accept: 'text/plain' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });

    if (res.status >= 400 && res.status < 500) {
      entry = { groups: [], unreachable: false, fetchedAt: Date.now() };
    } else if (!res.ok) {
      entry = { groups: [], unreachable: true, fetchedAt: Date.now() };
    } else {
      entry = { groups: parseRobots(await res.text()), unreachable: false, fetchedAt: Date.now() };
    }
  } catch {
    entry = { groups: [], unreachable: true, fetchedAt: Date.now() };
  }

  cache.set(origin, entry);
  return entry;
}

/**
 * @returns {Promise<{allowed: boolean, reason: string, crawlDelayMs: number}>}
 */
export async function checkRobots(url, { userAgent, timeoutMs = 10000 } = {}) {
  const target = new URL(url);
  const robots = await loadRobots(target.origin, userAgent, timeoutMs);

  if (robots.unreachable) {
    return { allowed: false, reason: 'robots.txt unreachable — treating as disallowed', crawlDelayMs: 0 };
  }

  const group = selectGroup(robots.groups, userAgent);
  const allowed = isAllowedBy(group, target.pathname + target.search);
  const crawlDelayMs = group?.crawlDelay ? group.crawlDelay * 1000 : 0;

  return {
    allowed,
    reason: allowed ? 'allowed by robots.txt' : `disallowed by robots.txt for ${userAgent}`,
    crawlDelayMs,
  };
}

export function clearRobotsCache() {
  cache.clear();
}
