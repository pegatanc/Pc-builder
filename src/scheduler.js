import cron from 'node-cron';
import { config } from './config.js';
import { runFetch } from './fetcher.js';

export function startScheduler({ log = console.log } = {}) {
  const { cron: expression, timezone, runOnStart } = config.schedule;

  if (!cron.validate(expression)) {
    log(`[cron] invalid expression "${expression}" — scheduler disabled.`);
    return null;
  }

  const task = cron.schedule(
    expression,
    () => {
      runFetch({ trigger: 'cron', log }).catch((err) => log(`[cron] fetch failed: ${err.message}`));
    },
    { timezone }
  );

  log(`[cron] scheduled "${expression}" (${timezone})`);

  if (runOnStart) {
    runFetch({ trigger: 'startup', log }).catch((err) => log(`[startup] fetch failed: ${err.message}`));
  }

  return task;
}
