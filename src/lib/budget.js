import { log } from './log.js';

/**
 * A hard spend ceiling enforced *during* ingest.
 *
 * The other cost guard checks after ingest and before enrichment, which is too late
 * for Apify: by then the results are bought. This one is checked before every single
 * query, so the run stops fetching the moment the budget is gone.
 *
 * Actual cost is only known after a query returns, so each query is pre-checked
 * against an assumed worst case. Overshoot is bounded by one query.
 *
 * The budget is also split per source, which matters once one source is far more
 * expensive than the others. LinkedIn's actor enforces a 150-result floor at roughly
 * $6 per thousand, about $0.90 a query, against Upwork's near-zero. A single global
 * pot spent first-come-first-served would let LinkedIn consume the entire run budget
 * before Indeed ran at all, so each source gets its own share and cannot borrow from
 * another's.
 */
export class RunBudget {
  constructor({ capUsd, assumedCostPer1k = 3.0, maxItemsPerQuery = 20, shares = {} } = {}) {
    this.capUsd = Number.isFinite(capUsd) && capUsd > 0 ? capUsd : Infinity;
    this.assumedCostPer1k = assumedCostPer1k;
    this.maxItemsPerQuery = maxItemsPerQuery;
    this.shares = shares;
    this.spent = 0;
    this.perSource = {};
    this.queriesRun = 0;
    this.queriesSkipped = 0;
    this.stoppedAt = null;
  }

  /** A source's slice of the run budget. No share configured means the whole thing. */
  capFor(source) {
    const share = Number(this.shares[source]);
    if (!Number.isFinite(share) || share <= 0) return this.capUsd;
    return this.capUsd === Infinity ? Infinity : this.capUsd * share;
  }

  spentBy(source) {
    return this.perSource[source] ?? 0;
  }

  /**
   * Worst case for one query of this source, used to decide whether to start it.
   * Both numbers are per source: LinkedIn's floor of 150 results at $6 is fifteen
   * times an Indeed query, and a single global estimate would badly misjudge it.
   */
  estimatedQueryCost({ maxItems, ratePer1k } = {}) {
    const items = Number(maxItems) || this.maxItemsPerQuery;
    const rate = Number(ratePer1k) || this.assumedCostPer1k;
    return (items / 1000) * rate;
  }

  get remaining() {
    return this.capUsd === Infinity ? Infinity : Math.max(0, this.capUsd - this.spent);
  }

  get exhausted() {
    return this.spent >= this.capUsd;
  }

  /** False means do not start another query for this source. */
  canAfford({ source, maxItems, ratePer1k } = {}) {
    if (this.capUsd === Infinity) return true;
    const estimate = this.estimatedQueryCost({ maxItems, ratePer1k });
    if (this.spent + estimate > this.capUsd) return false;
    if (source && this.spentBy(source) + estimate > this.capFor(source)) return false;
    return true;
  }

  record(usd, { source, query } = {}) {
    const amount = Number.isFinite(usd) ? usd : 0;
    this.spent = Number((this.spent + amount).toFixed(6));
    if (source) this.perSource[source] = Number((this.spentBy(source) + amount).toFixed(6));
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
      perSource: Object.fromEntries(
        Object.entries(this.perSource).map(([k, v]) => [k, Number(v.toFixed(4))])),
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

/**
 * Whether a source runs on this day. Expensive sources can run less often than the
 * cron does: LinkedIn every other day costs half as much and loses little, because
 * salaried postings turn over slowly and Indeed covers the same market daily.
 *
 * Keyed off the day number rather than a counter, so it stays correct across
 * restarts and skipped runs.
 */
export function shouldRunToday(everyNDays, day = dayIndex()) {
  const n = Number(everyNDays);
  if (!Number.isFinite(n) || n <= 1) return true;
  return day % Math.trunc(n) === 0;
}

/**
 * Redistributes shares across only the sources actually running.
 *
 * A share that belongs to a source which is blocked, or not scheduled today, is dead
 * budget: nobody may spend it and the run finishes under cap having skipped queries it
 * could have afforded. Normalizing over the active set instead means Indeed gets the
 * whole pot on the days LinkedIn does not run, which is the entire reason the cadence
 * is worth having.
 */
export function activeShares(shares = {}, activeSources = []) {
  const picked = activeSources.map((source) => {
    const share = Number(shares[source]);
    return [source, Number.isFinite(share) && share > 0 ? share : 0];
  });
  const total = picked.reduce((sum, [, share]) => sum + share, 0);
  if (total <= 0) return {};
  return Object.fromEntries(picked.map(([source, share]) => [source, share / total]));
}

/**
 * How far back a source must look, given how often it runs.
 *
 * A source running every other day against a two-day lookback covers the calendar
 * exactly, with no margin: one failed run and a day of postings is never seen again.
 * Widening by the gap gives an overlapping window, and dedupe makes the overlap free
 * on our side. It is not free on Apify's, which bills per result, so the widening is
 * only ever the gap and never more.
 */
export function effectiveLookback(lookbackDays, everyNDays) {
  const base = Number(lookbackDays);
  const n = Number(everyNDays);
  if (!Number.isFinite(base) || base <= 0) return lookbackDays;
  if (!Number.isFinite(n) || n <= 1) return base;
  return base + (Math.trunc(n) - 1);
}

/**
 * Decides which sources run this time, and why the others do not.
 *
 * Kept out of the pipeline so the reasons are testable. A source that quietly stops
 * running is the failure mode that hides for weeks: every exclusion here carries a
 * reason that ends up in the digest.
 */
export function planSources(names, actors = {}, day = dayIndex()) {
  return names.map((name) => {
    const actorConfig = actors[name];
    const everyNDays = Number(actorConfig?.runEveryNDays ?? 1);
    if (!actorConfig?.actorId) {
      return { name, active: false, reason: 'no actorId in config/actors.json' };
    }
    if (actorConfig.blocked) {
      return { name, active: false, reason: `blocked. ${actorConfig.blocked}` };
    }
    if (!shouldRunToday(everyNDays, day)) {
      return { name, active: false, reason: `runs every ${everyNDays} days, and today is not its day` };
    }
    return { name, active: true, everyNDays };
  });
}
