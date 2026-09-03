/**
 * Turns per-query Apify billing into the two numbers that actually change what you
 * should do: what each query cost, and what fraction of what it returned survived
 * deduplication.
 *
 * Apify bills per result, per query, and dedupe runs after billing. A posting that
 * matches four of your queries is paid for four times and kept once. That multiplier
 * is invisible in a total, which is why it is broken out here.
 */

const RATE_HINT = 'assumes the actor bills per result; check the Apify dashboard for the real rate';

export function summarizeSpend(sourceStats, { keptPostIds = 0, collectedRaw = 0 } = {}) {
  const rows = [];
  let totalCost = 0;
  let totalItems = 0;

  for (const [source, stats] of Object.entries(sourceStats)) {
    for (const q of stats.queryStats ?? []) {
      rows.push({ source, ...q });
      totalCost += q.costUsd ?? 0;
      totalItems += q.items ?? 0;
    }
  }

  rows.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.items - a.items);

  const dead = rows.filter((r) => r.items === 0);
  const capped = rows.filter((r) => r.cappedOut);
  // Everything billed for that deduped away. On a daily run over a short lookback
  // this is normally most of the volume, and it is the number worth watching.
  const wastedItems = Math.max(0, collectedRaw - keptPostIds);
  const wasteRatio = collectedRaw ? wastedItems / collectedRaw : 0;
  const costPerKept = keptPostIds > 0 ? totalCost / keptPostIds : null;

  return {
    rows,
    totalCost: Number(totalCost.toFixed(4)),
    totalItems,
    dead,
    capped,
    wastedItems,
    wasteRatio,
    costPerKept,
    projectedMonthly: Number((totalCost * 30).toFixed(2)),
  };
}

/** Plain-text block for the digest. Kept short: the top offenders and the ratios. */
export function spendLines(summary, { topN = 8 } = {}) {
  if (!summary.rows.length) return [];

  const lines = [];
  lines.push(`APIFY SPEND: $${summary.totalCost.toFixed(2)} this run across ${summary.totalItems} billed results`);
  lines.push(`  projected $${summary.projectedMonthly.toFixed(0)}/month at this volume (${RATE_HINT})`);

  if (summary.costPerKept !== null) {
    lines.push(
      `  $${summary.costPerKept.toFixed(3)} per post actually kept ` +
      `(${(summary.wasteRatio * 100).toFixed(0)}% of billed results were duplicates or already seen)`);
  }

  if (summary.capped.length) {
    lines.push(
      `  ${summary.capped.length} queries hit the result cap, so they are probably being truncated. ` +
      `Raising max_items_per_query costs more; lowering it may be losing postings.`);
  }

  if (summary.dead.length) {
    lines.push(`  ${summary.dead.length} queries returned nothing: ${summary.dead.map((d) => `"${d.query}" (${d.source})`).join(', ')}`);
  }

  lines.push('  most expensive queries:');
  for (const row of summary.rows.slice(0, topN)) {
    lines.push(`    $${(row.costUsd ?? 0).toFixed(3)}  ${String(row.items).padStart(3)} results  ${row.source}  "${row.query}"`);
  }

  return lines;
}
