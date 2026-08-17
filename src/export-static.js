/**
 * Builds the static site for GitHub Pages.
 *
 * Serialises exactly what the live API would return, so `public/app.js` runs
 * unchanged in both modes: it tries the API first and falls back to these files
 * when there's no server behind it.
 */
import './lib/fatal.js';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { getBuild } from './repo.js';
import { describeSources } from './sources/index.js';

const SITE_DIR = process.env.SITE_DIR || path.join(ROOT, 'site');

export function exportStatic({ log = console.log } = {}) {
  fs.rmSync(SITE_DIR, { recursive: true, force: true });
  fs.mkdirSync(SITE_DIR, { recursive: true });

  fs.cpSync(path.join(ROOT, 'public'), SITE_DIR, { recursive: true });

  // Flip the page into static mode. Fail loudly rather than shipping a build
  // that silently falls back to probing an API which isn't there.
  const indexPath = path.join(SITE_DIR, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const token = "window.__TRACKER_MODE__ = 'server'";
  if (!html.includes(token)) {
    throw new Error(`export-static: mode marker "${token}" not found in public/index.html`);
  }
  fs.writeFileSync(indexPath, html.replace(token, "window.__TRACKER_MODE__ = 'static'"));

  const build = getBuild();
  build.static = true; // tells the UI there's no refresh endpoint behind it

  fs.writeFileSync(path.join(SITE_DIR, 'build.json'), JSON.stringify(build, null, 2));
  fs.writeFileSync(
    path.join(SITE_DIR, 'sources.json'),
    JSON.stringify({ sources: describeSources(), schedule: config.schedule, static: true }, null, 2)
  );

  // Jekyll would otherwise swallow files it doesn't recognise.
  fs.writeFileSync(path.join(SITE_DIR, '.nojekyll'), '');

  log(
    `[site] wrote ${path.relative(ROOT, SITE_DIR)}/ — ${build.items.length} parts, ` +
      `${build.summary.alerts} alert(s), total ${build.currency} ${build.summary.total}`
  );
  return SITE_DIR;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  exportStatic();
}
