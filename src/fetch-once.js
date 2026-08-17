/**
 * One-off CLI: `npm run fetch` to fetch now, `npm run sources` to see which
 * price sources are wired up.
 */
import { seed } from './seed.js';
import { runFetch, backfillIfEmpty, purgeSyntheticHistory } from './fetcher.js';
import { describeSources } from './sources/index.js';

function printSources() {
  console.log('\nPrice sources (config order):\n');
  for (const s of describeSources()) {
    const state = s.willRun
      ? 'ACTIVE'
      : s.standby
        ? 'standby'
        : s.enabled
          ? 'not configured'
          : 'disabled';
    console.log(`  ${s.name.padEnd(9)} ${String(state).padEnd(16)} ${s.label}`);
    if (s.missingEnv.length) console.log(`  ${''.padEnd(9)} needs: ${s.missingEnv.join(', ')}`);
    if (s.notes) console.log(`  ${''.padEnd(9)} ${s.notes}`);
  }
  console.log('');
}

if (process.argv.includes('--list')) {
  printSources();
  process.exit(0);
}

seed();
purgeSyntheticHistory();
backfillIfEmpty();
const result = await runFetch({ trigger: 'cli' });
if (result.errors.length) {
  console.error('\nErrors:');
  for (const e of result.errors) console.error(`  - ${e}`);
}
process.exit(0);
