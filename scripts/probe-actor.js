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

// Actors can set their own floor (Upwork rejects anything under 20).
const input = buildInput(actorConfig, { query, maxItems: 5, remote: true, postedWithinDays: 7 });
process.stdout.write(`actor: ${actorConfig.actorId}\ninput: ${JSON.stringify(input, null, 2)}\n\n`);

const client = createApifyClient();

/**
 * Prints the actor's declared input schema.
 *
 * Guessing input field names has now failed twice on this actor: it accepted both
 * `searchQuery` and `queries` without complaint, ignored them, and logged
 * "No queries provided, fetching all jobs". A silently ignored input is worse than a
 * 400, because the run succeeds and returns plausible-looking rubbish. The schema is
 * published on the build, so read it rather than guess.
 */
async function printInputSchema(actorId) {
  try {
    const actor = await client.actor(actorId).get();
    const buildId = actor?.taggedBuilds?.latest?.buildId;
    if (!buildId) {
      process.stdout.write('INPUT SCHEMA: no tagged latest build to read it from\n\n');
      return;
    }
    const build = await client.build(buildId).get();
    const raw = build?.inputSchema;
    if (!raw) {
      process.stdout.write('INPUT SCHEMA: build publishes none\n\n');
      return;
    }
    const schema = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);

    process.stdout.write('INPUT SCHEMA (the actor\'s own declaration)\n');
    for (const [key, spec] of Object.entries(props)) {
      const bits = [
        spec.type ?? '?',
        required.has(key) ? 'REQUIRED' : '',
        spec.default !== undefined ? `default=${JSON.stringify(spec.default)}` : '',
        Array.isArray(spec.enum) ? `enum=${JSON.stringify(spec.enum.slice(0, 8))}` : '',
      ].filter(Boolean).join(' ');
      process.stdout.write(`  ${key.padEnd(26)} ${bits}\n`);
      if (spec.title) process.stdout.write(`  ${''.padEnd(26)} "${spec.title}"\n`);
    }
    const unknown = Object.keys(input).filter((k) => !(k in props));
    if (unknown.length) {
      process.stdout.write(`\n  SENT BUT NOT IN SCHEMA (silently ignored): ${unknown.join(', ')}\n`);
    }
    process.stdout.write('\n');
  } catch (error) {
    process.stdout.write(`INPUT SCHEMA: could not read it (${error.message})\n\n`);
  }
}

await printInputSchema(actorConfig.actorId);
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
