#!/usr/bin/env node
import 'dotenv/config';
import { run } from '../src/index.js';
import { log } from '../src/lib/log.js';

const args = new Set(process.argv.slice(2));
const result = await run({
  dryRun: args.has('--dry-run'),
  skipSend: args.has('--skip-send'),
});

if (result.skipped) {
  log.warn('run skipped', { reason: result.reason });
  process.exit(0);
}
log.info('done', { run_id: result.runId, ...result.counts, cost_usd: result.costUsd });
process.exit(result.errors.length ? 1 : 0);
