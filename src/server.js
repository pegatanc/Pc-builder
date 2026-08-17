import path from 'node:path';
import express from 'express';
import { ROOT, config } from './config.js';
import { seed } from './seed.js';
import { getBuild } from './repo.js';
import { runFetch, backfillIfEmpty, purgeSyntheticHistory } from './fetcher.js';
import { describeSources, usingSampleData } from './sources/index.js';
import { startScheduler } from './scheduler.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

seed();
purgeSyntheticHistory();
backfillIfEmpty();

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/build', (req, res) => {
  res.json(getBuild());
});

app.get('/api/sources', (req, res) => {
  res.json({ sources: describeSources(), schedule: config.schedule });
});

app.post('/api/refresh', async (req, res) => {
  try {
    const result = await runFetch({ trigger: 'api' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.listen(PORT, HOST, () => {
  console.log(`\n  PC part price tracker → http://${HOST}:${PORT}\n`);

  if (usingSampleData()) {
    console.log('  Running on SAMPLE DATA — no real price source is configured.');
    console.log('  See the README to add Keepa, PA-API, Best Buy or manual prices.\n');
  }

  startScheduler();
});
