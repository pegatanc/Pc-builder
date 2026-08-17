/**
 * Reports configuration mistakes as a readable message instead of a stack trace.
 *
 * Every entry point imports this *first*. That matters: `config.js` parses the
 * config files during module evaluation, so a malformed config.json throws
 * before any statement in the entry file runs — a try/catch there would never
 * see it, but a handler registered by an earlier import does.
 */
function report(err) {
  if (err?.isConfigError) {
    console.error('\n  Configuration problem\n');
    for (const line of String(err.message).split('\n')) console.error(`  ${line}`);
    console.error('');
  } else {
    console.error(err);
  }
  process.exit(1);
}

process.on('uncaughtException', report);
process.on('unhandledRejection', report);
