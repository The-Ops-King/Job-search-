#!/usr/bin/env node
import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createApifyClient, runActor } from '../src/lib/apify.js';
import { buildInput } from '../src/sources/_shared.js';
import { getPath } from '../src/sources/normalize.js';

/**
 * Runs one actor once against a real query and prints what it actually returns, so
 * the mappings in config/actors.json can be corrected from reality instead of from
 * documentation. Saves the raw dataset under .probe/ for use as a test fixture.
 *
 *   npm run probe-actor -- indeed "sales operations"
 */
const [source, query = 'sales operations'] = process.argv.slice(2);
if (!source) {
  process.stderr.write('usage: npm run probe-actor -- <upwork|linkedin|indeed> ["query"]\n');
  process.exit(1);
}

const actors = JSON.parse(await readFile(new URL('../config/actors.json', import.meta.url), 'utf8'));
const actorConfig = actors[source];
if (!actorConfig) {
  process.stderr.write(`No config for source "${source}"\n`);
  process.exit(1);
}

const input = buildInput(actorConfig, { query, maxItems: 5, remote: true, postedWithinDays: 7 });
process.stdout.write(`actor: ${actorConfig.actorId}\ninput: ${JSON.stringify(input, null, 2)}\n\n`);

const client = createApifyClient();
const { items, meta } = await runActor(client, actorConfig.actorId, input, { timeoutSecs: 240 });

await mkdir(new URL('../.probe/', import.meta.url), { recursive: true });
const out = new URL(`../.probe/${source}.json`, import.meta.url);
await writeFile(out, JSON.stringify(items, null, 2));

process.stdout.write(`\nreturned ${items.length} items (build ${meta.actorVersion}, $${meta.costUsd})\n`);
process.stdout.write(`raw output saved to .probe/${source}.json\n\n`);

if (!items.length) {
  process.stdout.write('No items. Widen the query or check the input field names above.\n');
  process.exit(0);
}

process.stdout.write('KEYS ON THE FIRST ITEM\n');
for (const [key, value] of Object.entries(items[0])) {
  const preview = JSON.stringify(value ?? null);
  process.stdout.write(`  ${key.padEnd(28)} ${preview.length > 90 ? `${preview.slice(0, 90)}...` : preview}\n`);
}

process.stdout.write('\nCURRENT MAPPING, RESOLVED AGAINST THIS OUTPUT\n');
for (const [field, paths] of Object.entries(actorConfig.map ?? {})) {
  const hits = items.map((item) => paths.find((p) => {
    const v = getPath(item, p);
    return v !== undefined && v !== null && v !== '';
  }));
  const resolved = hits.filter(Boolean);
  const rate = ((resolved.length / items.length) * 100).toFixed(0);
  const verdict = resolved.length === 0 ? 'NO HIT' : `${rate}% via ${[...new Set(resolved)].join(', ')}`;
  process.stdout.write(`  ${field.padEnd(16)} ${verdict}\n`);
}
process.stdout.write('\nFix any NO HIT line in config/actors.json, then re-run this probe.\n');
