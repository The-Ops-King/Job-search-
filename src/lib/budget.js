import { log } from './log.js';

/**
 * A hard spend ceiling enforced *during* ingest.
 *
 * The existing cost guard checks after ingest and before enrichment, which is too
 * late for Apify: by then the results are bought. This one is checked before every
 * single query, so the run stops fetching the moment the budget is gone rather than
 * discovering it afterwards.
 *
 * Actual cost is only known after a query returns, so each query is pre-checked
 * against an assumed worst case. Overshoot is bounded by one query.
 */
export class RunBudget {
  constructor({ capUsd, assumedCostPer1k = 3.0, maxItemsPerQuery = 20 } = {}) {
    this.capUsd = Number.isFinite(capUsd) && capUsd > 0 ? capUsd : Infinity;
    this.assumedCostPer1k = assumedCostPer1k;
    this.maxItemsPerQuery = maxItemsPerQuery;
    this.spent = 0;
    this.queriesRun = 0;
    this.queriesSkipped = 0;
    this.stoppedAt = null;
  }

  /** Worst case for one query, used to decide whether to start it at all. */
  get estimatedQueryCost() {
    return (this.maxItemsPerQuery / 1000) * this.assumedCostPer1k;
  }

  get remaining() {
    return this.capUsd === Infinity ? Infinity : Math.max(0, this.capUsd - this.spent);
  }

  get exhausted() {
    return this.spent >= this.capUsd;
  }

  /** False means do not start another query. */
  canAfford() {
    if (this.capUsd === Infinity) return true;
    return this.spent + this.estimatedQueryCost <= this.capUsd;
  }

  record(usd, { source, query } = {}) {
    const amount = Number.isFinite(usd) ? usd : 0;
    this.spent = Number((this.spent + amount).toFixed(6));
    this.queriesRun += 1;
    if (this.exhausted && !this.stoppedAt) {
      this.stoppedAt = { source, query, spent: this.spent };
      log.warn('apify budget reached', { cap: this.capUsd, spent: this.spent, source, query });
    }
    return this.spent;
  }

  skip() {
    this.queriesSkipped += 1;
  }

  summary() {
    return {
      capUsd: this.capUsd === Infinity ? null : this.capUsd,
      spent: Number(this.spent.toFixed(4)),
      queriesRun: this.queriesRun,
      queriesSkipped: this.queriesSkipped,
      stopped: Boolean(this.stoppedAt || this.queriesSkipped),
    };
  }
}

/**
 * Rotates the query list by a stable offset so a budget cut-off does not always
 * starve the same tail queries.
 *
 * Without this, a cap that bites at query 30 of 58 means queries 31 onward never run
 * on any day. With it, every query comes up over a few runs, and dedupe means the
 * only cost of a delayed query is finding a posting a day later.
 */
export function rotateQueries(queries, offset) {
  if (!queries.length) return [];
  const start = ((Math.trunc(offset) % queries.length) + queries.length) % queries.length;
  return [...queries.slice(start), ...queries.slice(0, start)];
}

/** Day number since epoch, so the rotation advances once per day and is reproducible. */
export function dayIndex(now = new Date()) {
  return Math.floor(now.getTime() / 86400000);
}
