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
function drawSparkline(canvas, series, { alert = false } = {}) {
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
  const stroke = alert ? '#ff8a5c' : last <= mean ? '#45c17a' : '#ef6b6b';

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
      hint: `${summary.pricedParts} of ${summary.totalParts} parts priced`,
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
    const value = el('div', `value ${card.valueClass || ''}`.trim(), card.value);
    if (card.valueClass === 'up') value.style.color = 'var(--bad)';
    if (card.valueClass === 'down') value.style.color = 'var(--good)';
    node.append(value, el('div', 'hint', card.hint));
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
  row.append(priceCell);

  // Retailer badge
  const retailerCell = el('td');
  if (item.best) {
    retailerCell.append(pill(item.best.retailer, 'pill-retailer'));
    retailerCell.append(el('span', 'source-tag', `via ${item.best.source}`));
  } else {
    retailerCell.append(pill('no price', 'pill-muted'));
  }
  row.append(retailerCell);

  // Sparkline
  const sparkCell = el('td', 'col-spark');
  if (item.series.length >= 2) {
    const wrap = el('div', 'spark-wrap');
    const canvas = el('canvas', 'spark');
    canvas.setAttribute('aria-label', `${item.name} price history`);
    wrap.append(canvas);
    sparkCell.append(wrap);
    requestAnimationFrame(() => drawSparkline(canvas, item.series, { alert: item.flags.drop }));
  } else {
    sparkCell.append(el('span', 'spark-empty', 'not enough history'));
  }
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
  row.append(avgCell);

  // Target
  row.append(el('td', 'num', money(item.target, currency)));

  // Status
  const statusCell = el('td');
  const stack = el('div', 'status-stack');
  if (item.flags.drop) stack.append(pill(`▼ ${item.stats.dropPercent}% drop`, 'pill-alert'));
  if (item.flags.atOrBelowTarget) stack.append(pill('at target', 'pill-good'));
  if (item.flags.stale) stack.append(pill('stale', 'pill-warn'));
  if (item.flags.noPrice) stack.append(pill('unpriced', 'pill-muted'));
  if (!stack.childElementCount) stack.append(pill('tracking', 'pill-muted'));
  statusCell.append(stack);
  row.append(statusCell);

  return row;
}

function renderTable(data) {
  const body = document.getElementById('parts-body');
  const foot = document.getElementById('parts-foot');
  body.replaceChildren();

  if (!data.items.length) {
    const cell = el('td', 'empty', 'No parts seeded yet.');
    cell.colSpan = 7;
    const row = el('tr');
    row.append(cell);
    body.append(row);
    foot.replaceChildren();
    return;
  }

  for (const item of data.items) body.append(renderPartRow(item, data.currency));

  const { summary, currency } = data;
  const totalRow = el('tr');
  totalRow.append(el('td', null, 'Grand total'));

  const totalCell = el('td', 'num');
  totalCell.append(el('span', 'price', money(summary.total, currency)));
  const deltaText = `${signed(summary.baselineDelta, currency)} vs ${money(summary.baseline, currency)} baseline`;
  totalCell.append(el('span', `delta ${summary.baselineDelta > 0 ? 'up' : 'down'}`, deltaText));
  totalRow.append(totalCell);

  const spacer = el('td');
  spacer.colSpan = 3;
  totalRow.append(spacer);
  totalRow.append(el('td', 'num', money(summary.targetTotal, currency)));
  totalRow.append(el('td', null, `${summary.alerts} alert${summary.alerts === 1 ? '' : 's'}`));

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
  cell.colSpan = 7;
  const row = el('tr');
  row.append(cell);
  document.getElementById('parts-body').replaceChildren(row);
});
