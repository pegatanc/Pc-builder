'use strict';

const money = (value, currency = 'USD') =>
  value == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);

const signed = (value, currency = 'USD') =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(Math.abs(value), currency)}`;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

function pill(text, kind) {
  return el('span', `pill ${kind}`, text);
}

/* ---------- sparkline ---------- */

/**
 * Plain canvas sparkline: filled area, line, and a dot on the latest point.
 * Coloured green when the series ends below its own average, red above.
 */
function drawSparkline(canvas, series, { alert = false, highlight = null, accent = null } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 170;
  const height = canvas.clientHeight || 34;

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const values = series.map((p) => p.price);
  if (values.length < 2) return;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const usableH = height - pad * 2;

  const x = (i) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v) => pad + (1 - (v - min) / span) * usableH;

  const last = values[values.length - 1];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const stroke = accent || (alert ? '#ff8a5c' : last <= mean ? '#45c17a' : '#ef6b6b');

  // Filled area under the line.
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `${stroke}44`);
  gradient.addColorStop(1, `${stroke}00`);

  ctx.beginPath();
  ctx.moveTo(x(0), y(values[0]));
  values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(values.length - 1), height);
  ctx.lineTo(x(0), height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line.
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Latest point.
  ctx.beginPath();
  ctx.arc(x(values.length - 1), y(last), 2.4, 0, Math.PI * 2);
  ctx.fillStyle = stroke;
  ctx.fill();

  // Hovered point: vertical crosshair plus a ringed marker.
  if (highlight != null && highlight >= 0 && highlight < values.length) {
    const hx = x(highlight);
    const hy = y(values[highlight]);

    ctx.beginPath();
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, height);
    ctx.strokeStyle = 'rgba(230, 233, 239, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#e6e9ef';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/* ---------- sparkline tooltip ---------- */

let tooltipEl = null;

function tooltip() {
  if (!tooltipEl) {
    tooltipEl = el('div', 'spark-tip');
    tooltipEl.hidden = true;
    document.body.append(tooltipEl);
  }
  return tooltipEl;
}

/**
 * Makes a sparkline readable: hovering snaps to the nearest day and reports the
 * exact date and price. Without this the chart shows a shape but no numbers.
 */
function attachSparklineTooltip(canvas, series, options) {
  const indexAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1))));
  };

  const show = (event) => {
    const index = indexAt(event);
    const point = series[index];
    if (!point) return;

    drawSparkline(canvas, series, { ...options, highlight: index });

    const tip = tooltip();
    tip.hidden = false;
    tip.replaceChildren(
      el('span', 'spark-tip-price', money(point.price, options.currency)),
      el('span', 'spark-tip-day', formatDay(point.day))
    );

    // Clamp to the viewport so the tip never hangs off the right edge.
    const rect = canvas.getBoundingClientRect();
    const width = tip.offsetWidth || 90;
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, event.clientX - width / 2));
    tip.style.left = `${left}px`;
    tip.style.top = `${rect.top + window.scrollY - tip.offsetHeight - 8}px`;
  };

  const hide = () => {
    tooltip().hidden = true;
    drawSparkline(canvas, series, { ...options, highlight: null });
  };

  canvas.addEventListener('mousemove', show);
  canvas.addEventListener('mouseleave', hide);
}

function formatDay(day) {
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Table cells are narrow and the window is 90 days, so the year is noise. */
function formatDayShort(day) {
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ---------- sorting ---------- */

/**
 * Sort keys per column. `dir` is the direction applied on first click — the
 * interesting end first, so clicking "Cheapest" leads with the expensive parts
 * and clicking "Status" leads with the biggest drop.
 */
const SORTS = {
  part: { label: 'Part', dir: 1, value: (i) => i.name.toLowerCase() },
  price: { label: 'Cheapest', dir: -1, value: (i) => i.best?.price ?? null },
  retailer: { label: 'Retailer', dir: 1, value: (i) => i.best?.retailer?.toLowerCase() ?? null },
  avg: { label: '30-day avg', dir: -1, value: (i) => i.stats.avgWindow },
  low: { label: 'Lowest seen', dir: -1, value: (i) => i.stats.aboveLowPercent },
  target: { label: 'Target', dir: -1, value: (i) => i.target },
  status: { label: 'Status', dir: -1, value: (i) => i.stats.dropPercent },
};

const SORT_KEY = 'pc-tracker-sort';

function loadSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
    return saved && SORTS[saved.column] ? saved : null;
  } catch {
    return null;
  }
}

function saveSort(sort) {
  try {
    if (sort) localStorage.setItem(SORT_KEY, JSON.stringify(sort));
    else localStorage.removeItem(SORT_KEY);
  } catch {
    /* private mode — sorting still works, it just won't persist */
  }
}

let sortState = loadSort();

/** Null values always sink, whichever way the column is pointing. */
function sortItems(items, sort) {
  if (!sort) return items;
  const spec = SORTS[sort.column];
  if (!spec) return items;

  return [...items].sort((a, b) => {
    const av = spec.value(a);
    const bv = spec.value(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * sort.dir;
    return (av - bv) * sort.dir;
  });
}

/**
 * Three states per column: off, primary direction, reversed. Cycling back to
 * off restores catalogue order, which is meaningful here (CPU, board, RAM…).
 */
function cycleSort(column) {
  const spec = SORTS[column];
  if (!spec) return;

  if (!sortState || sortState.column !== column) sortState = { column, dir: spec.dir };
  else if (sortState.dir === spec.dir) sortState = { column, dir: -spec.dir };
  else sortState = null;

  saveSort(sortState);
  if (lastData) renderTable(lastData);
}

function wireSortHeaders() {
  for (const th of document.querySelectorAll('thead th[data-sort]')) {
    const column = th.dataset.sort;
    th.tabIndex = 0;
    th.setAttribute('role', 'button');
    th.addEventListener('click', () => cycleSort(column));
    th.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        cycleSort(column);
      }
    });
  }
}

function paintSortHeaders() {
  for (const th of document.querySelectorAll('thead th[data-sort]')) {
    const active = sortState?.column === th.dataset.sort;
    th.classList.toggle('sorted', active);
    th.setAttribute('aria-sort', active ? (sortState.dir === 1 ? 'ascending' : 'descending') : 'none');
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = active ? (sortState.dir === 1 ? '▲' : '▼') : '';
  }
}

/* ---------- owner recognition ---------- */

/*
 * Recognises a personal key so the page can say "this is your tracker".
 *
 * It is NOT access control and must not be mistaken for it. The site is static
 * on public hosting, so there is no server to check anything against, the data
 * in build.json is readable by anyone, and this comparison happens in the
 * visitor's own browser. What it buys you is confirmation that you opened your
 * own link, nothing more.
 *
 * Only the SHA-256 digest is published — the key itself is never in the repo.
 */
const OWNER_FLAG = 'pc-tracker-owner';

async function sha256Hex(value) {
  // crypto.subtle needs a secure context: HTTPS or localhost, not plain-HTTP LAN.
  if (!window.isSecureContext || !crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function recogniseOwner(expectedHash) {
  if (!expectedHash) return false;

  const params = new URLSearchParams(location.search);
  const key = params.get('key');

  if (key) {
    const digest = await sha256Hex(key);
    if (digest && digest === expectedHash) {
      try {
        localStorage.setItem(OWNER_FLAG, digest);
      } catch {
        /* private mode — recognised for this page view only */
      }
    }
    // Drop the key from the address bar either way, so it is not left sitting
    // in a shared screenshot or copied out of the URL.
    params.delete('key');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
    if (digest && digest === expectedHash) return true;
  }

  try {
    return localStorage.getItem(OWNER_FLAG) === expectedHash;
  } catch {
    return false;
  }
}

function renderOwnerBadge(recognised) {
  const slot = document.getElementById('owner-badge');
  if (!slot) return;
  slot.hidden = !recognised;
  if (recognised) {
    slot.textContent = '✓ your tracker';
    slot.title = 'This browser presented the owner key. A recognition marker, not access control.';
  }
}

/* ---------- copy all links ---------- */


/**
 * One line per part, in the order currently displayed, as "Name — url".
 * Readable enough to paste into notes and still one URL per line for anything
 * that opens links in bulk.
 */
function partLinkList(data) {
  return sortItems(data.items, sortState)
    .map((item) => {
      const url = item.best?.url || item.listings.find((l) => l.url)?.url;
      return url ? `${item.name} — ${url}` : null;
    })
    .filter(Boolean);
}

/**
 * navigator.clipboard needs a secure context, which covers HTTPS and localhost
 * but not a plain-HTTP LAN address — so fall back to the textarea trick rather
 * than silently doing nothing there.
 */
async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* denied or unavailable — try the fallback below */
    }
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

function wireCopyLinks() {
  const button = document.getElementById('copy-links');
  if (!button) return;
  const original = button.textContent;
  let resetTimer;

  button.addEventListener('click', async () => {
    if (!lastData) return;
    const lines = partLinkList(lastData);

    if (!lines.length) {
      button.textContent = 'No links yet';
    } else {
      const copied = await copyText(lines.join('\n'));
      button.textContent = copied
        ? `Copied ${lines.length} link${lines.length === 1 ? '' : 's'}`
        : 'Copy failed';
    }

    button.classList.add('flash');
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      button.textContent = original;
      button.classList.remove('flash');
    }, 1800);
  });
}

/* ---------- rendering ---------- */



function renderSummary(data) {
  const { summary, currency } = data;
  const container = document.getElementById('summary');
  container.replaceChildren();

  const delta = summary.baselineDelta;
  const deltaClass = delta > 0 ? 'up' : delta < 0 ? 'down' : '';

  const cards = [
    {
      label: 'Build total',
      value: money(summary.total, currency),
      hint:
        summary.pricedParts < summary.totalParts
          ? `Only ${summary.pricedParts} of ${summary.totalParts} parts priced — total is incomplete`
          : summary.totalLow != null
            ? `Lowest ${money(summary.totalLow, currency)} on ${formatDay(summary.totalLowDay)}`
            : `${summary.pricedParts} of ${summary.totalParts} parts priced`,
      warn: summary.pricedParts < summary.totalParts,
      trend: true,
    },
    {
      label: 'vs baseline',
      value: signed(delta, currency),
      hint: `Baseline ${money(summary.baseline, currency)} · ${
        summary.baselineDeltaPercent > 0 ? '+' : ''
      }${summary.baselineDeltaPercent ?? 0}%`,
      valueClass: deltaClass,
    },
    {
      label: 'Target total',
      value: money(summary.targetTotal, currency),
      hint: `${summary.atTarget} part${summary.atTarget === 1 ? '' : 's'} at or below target`,
    },
    {
      label: 'Price drops',
      value: String(summary.alerts),
      hint: `≥${data.alertRule.dropPercent}% under ${data.alertRule.windowDays}-day average`,
      valueClass: summary.alerts ? 'down' : '',
    },
  ];

  for (const card of cards) {
    const node = el('div', 'card');
    node.append(el('div', 'label', card.label));
    if (card.warn) node.classList.add('card-warn');
    const value = el('div', `value ${card.valueClass || ''}`.trim(), card.value);
    if (card.valueClass === 'up') value.style.color = 'var(--bad)';
    if (card.valueClass === 'down') value.style.color = 'var(--good)';
    node.append(value, el('div', 'hint', card.hint));

    // The build total carries its own trend line: is this build getting cheaper?
    if (card.trend && data.totalSeries?.length >= 2) {
      const canvas = el('canvas', 'spark spark-wide');
      canvas.setAttribute(
        'aria-label',
        `Build total over ${data.totalSeries.length} days, low ` +
          `${money(summary.totalLow, currency)} on ${formatDay(summary.totalLowDay)}`
      );
      node.append(canvas);
      const options = { currency, accent: '#5aa9ff' };
      requestAnimationFrame(() => {
        drawSparkline(canvas, data.totalSeries, options);
        attachSparklineTooltip(canvas, data.totalSeries, options);
      });
    }

    container.append(node);
  }
}

function renderPartRow(item, currency) {
  const row = el('tr');
  if (item.flags.drop) row.classList.add('alert');

  // Part
  const partCell = el('td');
  const nameNode = el('div', 'part-name');
  const link = item.best?.url || item.listings.find((l) => l.url)?.url;
  if (link) {
    const a = el('a', null, item.name);
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    nameNode.append(a);
  } else {
    nameNode.textContent = item.name;
  }
  partCell.append(nameNode, el('div', 'part-meta', `${item.category} · ${item.spec || item.model || ''}`));
  partCell.dataset.label = 'Part';
  row.append(partCell);

  // Cheapest price
  const priceCell = el('td', 'num');
  const priceNode = el('span', 'price', item.best ? money(item.best.price, item.best.currency) : '—');
  if (item.flags.atOrBelowTarget) priceNode.classList.add('below-target');
  priceCell.append(priceNode);
  if (item.best && item.target != null) {
    const diff = item.best.price - item.target;
    priceCell.append(
      el('span', `delta ${diff > 0 ? 'up' : 'down'}`, `${signed(diff, currency)} vs target`)
    );
  }
  priceCell.dataset.label = 'Cheapest';
  row.append(priceCell);

  // Retailer badge
  const retailerCell = el('td');
  if (item.best) {
    retailerCell.append(pill(item.best.retailer, 'pill-retailer'));
    retailerCell.append(el('span', 'source-tag', `via ${item.best.source}`));
  } else {
    retailerCell.append(pill('no price', 'pill-muted'));
    if (link) {
      const help = el('span', 'source-tag', 'set a price →');
      const a = el('a', 'unpriced-link');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'check';
      help.append(' ', a);
      retailerCell.append(help);
    }
  }
  retailerCell.dataset.label = 'Retailer';
  row.append(retailerCell);

  // Sparkline
  const sparkCell = el('td', 'col-spark');
  if (item.series.length >= 2) {
    const wrap = el('div', 'spark-wrap');
    const canvas = el('canvas', 'spark');
    const first = item.series[0];
    const last = item.series[item.series.length - 1];
    canvas.setAttribute(
      'aria-label',
      `${item.name} price history, ${item.series.length} days from ` +
        `${money(first.price, currency)} on ${formatDay(first.day)} to ` +
        `${money(last.price, currency)} on ${formatDay(last.day)}. ` +
        `Lowest ${money(item.stats.low, currency)}, highest ${money(item.stats.high, currency)}.`
    );
    wrap.append(canvas);
    sparkCell.append(wrap);

    const options = { alert: item.flags.drop, currency };
    requestAnimationFrame(() => {
      drawSparkline(canvas, item.series, options);
      attachSparklineTooltip(canvas, item.series, options);
    });
  } else {
    sparkCell.append(el('span', 'spark-empty', 'not enough history'));
  }
  sparkCell.dataset.label = '90-day history';
  row.append(sparkCell);

  // 30-day average
  const avgCell = el('td', 'num');
  avgCell.append(el('span', null, money(item.stats.avgWindow, currency)));
  if (item.stats.dropPercent != null) {
    const pct = item.stats.dropPercent;
    avgCell.append(
      el('span', `delta ${pct > 0 ? 'down' : 'up'}`, `${pct > 0 ? '−' : '+'}${Math.abs(pct)}%`)
    );
  }
  avgCell.dataset.label = '30-day avg';
  row.append(avgCell);

  // Lowest seen — the "is this a good price?" column.
  const lowCell = el('td', 'num');
  lowCell.append(el('span', null, money(item.stats.low, currency)));
  if (item.stats.lowDay) {
    lowCell.append(
      el(
        'span',
        'delta',
        item.flags.atLowest ? 'today' : `+${item.stats.aboveLowPercent}% · ${formatDayShort(item.stats.lowDay)}`
      )
    );
  }
  lowCell.dataset.label = 'Lowest seen';
  row.append(lowCell);

  // Target
  const targetCell = el('td', 'num', money(item.target, currency));
  targetCell.dataset.label = 'Target';
  row.append(targetCell);

  // Status
  const statusCell = el('td');
  const stack = el('div', 'status-stack');
  if (item.flags.drop) stack.append(pill(`▼ ${item.stats.dropPercent}% drop`, 'pill-alert'));
  if (item.flags.atLowest) stack.append(pill('★ lowest yet', 'pill-low'));
  if (item.flags.atOrBelowTarget) stack.append(pill('at target', 'pill-good'));
  if (item.flags.stale) stack.append(pill('stale', 'pill-warn'));
  if (item.flags.noPrice) stack.append(pill('unpriced', 'pill-muted'));
  if (!stack.childElementCount) stack.append(pill('tracking', 'pill-muted'));
  statusCell.append(stack);
  statusCell.dataset.label = 'Status';
  row.append(statusCell);

  return row;
}

function renderTable(data) {
  const body = document.getElementById('parts-body');
  const foot = document.getElementById('parts-foot');
  body.replaceChildren();

  if (!data.items.length) {
    const cell = el('td', 'empty', 'No parts seeded yet.');
    cell.colSpan = 8;
    const row = el('tr');
    row.append(cell);
    body.append(row);
    foot.replaceChildren();
    return;
  }

  for (const item of sortItems(data.items, sortState)) {
    body.append(renderPartRow(item, data.currency));
  }
  paintSortHeaders();

  const { summary, currency } = data;
  const totalRow = el('tr');
  const labelCell = el('td', null, 'Grand total');
  labelCell.dataset.label = '';
  totalRow.append(labelCell);

  const totalCell = el('td', 'num');
  totalCell.append(el('span', 'price', money(summary.total, currency)));
  const deltaText = `${signed(summary.baselineDelta, currency)} vs ${money(summary.baseline, currency)} baseline`;
  totalCell.append(el('span', `delta ${summary.baselineDelta > 0 ? 'up' : 'down'}`, deltaText));
  totalCell.dataset.label = 'Build total';
  totalRow.append(totalCell);

  const spacer = el('td');
  spacer.colSpan = 3;
  totalRow.append(spacer);

  const lowCell = el('td', 'num', money(summary.totalLow, currency));
  lowCell.dataset.label = 'Lowest ever';
  totalRow.append(lowCell);

  const targetCell = el('td', 'num', money(summary.targetTotal, currency));
  targetCell.dataset.label = 'Target total';
  totalRow.append(targetCell);

  const alertCell = el('td', null, `${summary.alerts} alert${summary.alerts === 1 ? '' : 's'}`);
  alertCell.dataset.label = 'Alerts';
  totalRow.append(alertCell);

  foot.replaceChildren(totalRow);
}

function renderMeta(data, sources) {
  const active = sources.filter((s) => s.willRun);
  const synthetic = active.length > 0 && active.every((s) => s.synthetic);

  document.getElementById('subtitle').textContent =
    `${data.items.length} parts · ${active.map((s) => s.name).join(', ') || 'no active source'} · ` +
    `checks ${sourcesScheduleText(sources)}`;

  const badge = document.getElementById('source-badge');
  badge.hidden = false;
  if (synthetic) {
    badge.textContent = 'sample data';
    badge.className = 'pill pill-warn';
    badge.title = 'No real price source configured — see the README.';
  } else {
    badge.textContent = 'live sources';
    badge.className = 'pill pill-good';
    badge.title = active.map((s) => s.label).join('\n');
  }

  const lastRun = data.lastRun;
  document.getElementById('last-run').textContent = lastRun
    ? `Last check: ${new Date(lastRun.finished_at || lastRun.started_at).toLocaleString()} ` +
      `(${lastRun.trigger}, ${lastRun.observations} price${lastRun.observations === 1 ? '' : 's'})` +
      (lastRun.errors ? ` · ${lastRun.errors}` : '')
    : 'No fetch recorded yet.';

  document.getElementById('alert-rule').textContent =
    `Alert rule: cheapest price ≥${data.alertRule.dropPercent}% below the ` +
    `${data.alertRule.windowDays}-day average (min ${data.alertRule.minSamples} samples).`;
}

function sourcesScheduleText(sources) {
  const schedule = window.__schedule;
  return schedule ? `on "${schedule.cron}" (${schedule.timezone})` : 'on schedule';
}

/* ---------- boot ---------- */

let lastData = null;

// Set by index.html; `npm run site` rewrites it to 'static' for GitHub Pages.
const IS_STATIC = window.__TRACKER_MODE__ === 'static';

/**
 * Works against the live server and against the static GitHub Pages build.
 * The mode is known up front, so the static build never requests an API that
 * isn't there (and never logs a 404 on every page load).
 */
async function loadJson(apiPath, staticPath) {
  const url = IS_STATIC ? staticPath : apiPath;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.json();
}

async function load() {
  const [data, sourceInfo] = await Promise.all([
    loadJson('/api/build', './build.json'),
    loadJson('/api/sources', './sources.json'),
  ]);
  window.__schedule = sourceInfo.schedule;

  lastData = data;
  renderSummary(data);
  renderTable(data);
  renderMeta(data, sourceInfo.sources);
  applyMode(data);
  renderOwnerBadge(await recogniseOwner(sourceInfo.site?.ownerKeyHash));
}

/** In the static build there is no refresh endpoint, so don't offer one. */
function applyMode(data) {
  const staticMode = IS_STATIC || data.static === true;
  const button = document.getElementById('refresh');
  const note = document.getElementById('static-note');

  button.hidden = staticMode;
  note.hidden = !staticMode;

  if (staticMode && data.generatedAt) {
    note.textContent = `Static build · generated ${new Date(data.generatedAt).toLocaleString()}`;
  }
}

wireSortHeaders();
wireCopyLinks();

document.getElementById('refresh').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await load();
  } catch (err) {
    console.error(err);
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh prices';
  }
});

// Sparklines are sized in CSS pixels, so they need a redraw on resize.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => lastData && renderTable(lastData), 150);
});

load().catch((err) => {
  // textContent, not innerHTML: the message can carry markup from a failed response.
  const cell = el('td', 'empty', `Failed to load: ${err.message}`);
  cell.colSpan = 8;
  const row = el('tr');
  row.append(cell);
  document.getElementById('parts-body').replaceChildren(row);
});
