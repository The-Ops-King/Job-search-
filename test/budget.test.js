import { describe, it, expect } from 'vitest';
import { RunBudget, rotateQueries, dayIndex, shouldRunToday, activeShares, effectiveLookback, planSources } from '../src/lib/budget.js';
import { collect, buildInput } from '../src/sources/_shared.js';
import { summarizeSpend, spendLines } from '../src/pipeline/spend.js';

const actorConfig = {
  actorId: 'test/actor',
  input: { template: {}, fields: { query: 'q', maxItems: 'n' } },
  map: { url: ['url'], title: ['title'], description: ['description'] },
  required: ['url', 'title', 'description'],
  defaults: {},
};

const item = (i) => ({ url: `https://x.com/${i}`, title: `Job ${i}`, description: 'a description' });

/** Stands in for apify-client. Bills a fixed amount per result returned. */
function fakeClient({ itemsPerQuery = 20, costPerItem = 0.003 } = {}) {
  const calls = [];
  return {
    calls,
    actor: () => ({
      call: async (input) => {
        calls.push(input.q);
        return { id: `run${calls.length}`, status: 'SUCCEEDED', defaultDatasetId: `ds${calls.length}`,
          usageTotalUsd: itemsPerQuery * costPerItem, buildNumber: '1.0.0' };
      },
    }),
    dataset: () => ({
      listItems: async () => ({ items: Array.from({ length: itemsPerQuery }, (_, i) => item(`${calls.length}-${i}`)) }),
    }),
  };
}

describe('RunBudget', () => {
  it('allows spending up to the cap and then stops', () => {
    const b = new RunBudget({ capUsd: 0.10, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    expect(b.estimatedQueryCost()).toBeCloseTo(0.06, 5);
    expect(b.canAfford()).toBe(true);
    b.record(0.06);
    expect(b.canAfford()).toBe(false); // 0.06 + 0.06 would exceed 0.10
    expect(b.exhausted).toBe(false);
  });

  it('reports where it stopped', () => {
    const b = new RunBudget({ capUsd: 0.05, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    b.record(0.06, { source: 'upwork', query: 'sales ops' });
    expect(b.exhausted).toBe(true);
    expect(b.summary().stopped).toBe(true);
  });

  it('treats a missing cap as unlimited rather than zero', () => {
    const b = new RunBudget({});
    expect(b.capUsd).toBe(Infinity);
    expect(b.canAfford()).toBe(true);
    b.record(1000);
    expect(b.canAfford()).toBe(true);
  });

  it('ignores a nonsense cap instead of blocking every query', () => {
    expect(new RunBudget({ capUsd: 0 }).capUsd).toBe(Infinity);
    expect(new RunBudget({ capUsd: -5 }).capUsd).toBe(Infinity);
  });

  it('counts skips separately from runs', () => {
    const b = new RunBudget({ capUsd: 1 });
    b.record(0.1); b.skip(); b.skip();
    expect(b.summary()).toMatchObject({ queriesRun: 1, queriesSkipped: 2, stopped: true });
  });
});

describe('rotateQueries', () => {
  const qs = ['a', 'b', 'c', 'd'];

  it('rotates by the offset', () => {
    expect(rotateQueries(qs, 0)).toEqual(['a', 'b', 'c', 'd']);
    expect(rotateQueries(qs, 1)).toEqual(['b', 'c', 'd', 'a']);
    expect(rotateQueries(qs, 5)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('handles negative offsets without producing holes', () => {
    expect(rotateQueries(qs, -1)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('keeps every query exactly once, whatever the offset', () => {
    for (const off of [0, 1, 3, 17, -4]) {
      expect([...rotateQueries(qs, off)].sort()).toEqual(['a', 'b', 'c', 'd']);
    }
  });

  it('covers the whole list across consecutive days when only two run per day', () => {
    // The point of rotation: with a cap that only affords 2 of 4, every query still
    // gets its turn within a couple of runs instead of the tail never running.
    const seen = new Set();
    for (let day = 0; day < 2; day += 1) rotateQueries(qs, day * 2).slice(0, 2).forEach((q) => seen.add(q));
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('advances once per day', () => {
    const d1 = dayIndex(new Date('2026-09-03T01:00:00Z'));
    const d2 = dayIndex(new Date('2026-09-03T23:00:00Z'));
    const d3 = dayIndex(new Date('2026-09-04T01:00:00Z'));
    expect(d1).toBe(d2);
    expect(d3).toBe(d1 + 1);
  });

  it('survives an empty list', () => {
    expect(rotateQueries([], 3)).toEqual([]);
  });
});

describe('the cap is enforced during ingest, not after', () => {
  const queries = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'];
  const options = { maxItems: 20, lookbackDays: 2, timeoutSecs: 60 };

  it('stops calling the actor once the budget is spent', async () => {
    const client = fakeClient({ itemsPerQuery: 20, costPerItem: 0.003 }); // $0.06 per query
    const budget = new RunBudget({ capUsd: 0.20, assumedCostPer1k: 3, maxItemsPerQuery: 20 });

    const result = await collect({ source: 'indeed', client, actorConfig, queries, options, budget });

    // Three queries at $0.06 fit under $0.20; a fourth would not.
    expect(client.calls).toHaveLength(3);
    expect(budget.spent).toBeCloseTo(0.18, 5);
    expect(budget.summary().queriesSkipped).toBe(5);
    expect(result.meta.queriesSkippedForBudget).toBe(5);
  });

  it('never exceeds the cap, whatever the cap is', async () => {
    for (const cap of [0.05, 0.1, 0.25, 0.5, 1.0]) {
      const client = fakeClient({ itemsPerQuery: 20, costPerItem: 0.003 });
      const budget = new RunBudget({ capUsd: cap, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
      await collect({ source: 'indeed', client, actorConfig, queries, options, budget });
      // Overshoot is bounded by one query, because real cost is only known afterwards.
      expect(budget.spent, `cap ${cap}`).toBeLessThanOrEqual(cap + budget.estimatedQueryCost());
    }
  });

  it('says in the digest that queries were deferred, not lost', async () => {
    const client = fakeClient({ itemsPerQuery: 20, costPerItem: 0.003 });
    const budget = new RunBudget({ capUsd: 0.10, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    const result = await collect({ source: 'indeed', client, actorConfig, queries, options, budget });

    expect(result.warnings.join(' ')).toContain('Apify budget for this run is spent');
    expect(result.warnings.join(' ')).toContain('run first next time');

    const text = spendLines(summarizeSpend(
      { indeed: result.meta }, { keptPostIds: 5, collectedRaw: 20, budget: budget.summary() },
    )).join('\n');
    expect(text).toContain('budget cap $0.10/run');
    expect(text).toContain('queries were skipped');
    expect(text).toContain('rotates daily');
  });

  it('runs everything when the budget is generous', async () => {
    const client = fakeClient({ itemsPerQuery: 5, costPerItem: 0.003 });
    const budget = new RunBudget({ capUsd: 10, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    await collect({ source: 'indeed', client, actorConfig, queries, options, budget });
    expect(client.calls).toHaveLength(8);
    expect(budget.summary().queriesSkipped).toBe(0);
  });

  it('works with no budget at all, for a manual unbounded run', async () => {
    const client = fakeClient({ itemsPerQuery: 5 });
    await collect({ source: 'indeed', client, actorConfig, queries, options, budget: null });
    expect(client.calls).toHaveLength(8);
  });

  it('applies rotation so the query order shifts by day', async () => {
    const day0 = fakeClient({ itemsPerQuery: 5 });
    const day1 = fakeClient({ itemsPerQuery: 5 });
    await collect({ source: 'indeed', client: day0, actorConfig, queries, options, rotation: 0 });
    await collect({ source: 'indeed', client: day1, actorConfig, queries, options, rotation: 3 });
    expect(day0.calls[0]).toBe('q1');
    expect(day1.calls[0]).toBe('q4');
  });

  it('does not call a source failed when its queries were only deferred', async () => {
    const client = fakeClient({ itemsPerQuery: 20, costPerItem: 0.003 });
    const budget = new RunBudget({ capUsd: 0.06, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    // One query affordable, seven skipped. That is a budget stop, not a dead actor,
    // so it must not throw the "all queries failed" error.
    await expect(collect({ source: 'indeed', client, actorConfig, queries, options, budget }))
      .resolves.toBeTruthy();
  });
});

describe('cost accounting when the actor reports nothing', () => {
  // The live probe returned usageTotalUsd of 0 from a run that plainly consumed
  // results. Trusting it would leave the cap reading zero spend forever.
  const queries = ['q1', 'q2', 'q3', 'q4'];
  const options = { maxItems: 20, lookbackDays: 2, timeoutSecs: 60 };

  it('falls back to the assumed rate so the cap still fires', async () => {
    const client = fakeClient({ itemsPerQuery: 20, costPerItem: 0 }); // reports $0
    const budget = new RunBudget({ capUsd: 0.15, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    await collect({ source: 'indeed', client, actorConfig, queries, options, budget });

    // 20 items at $3/1k is $0.06 a query, so two fit under $0.15 and two do not.
    expect(budget.spent).toBeCloseTo(0.12, 5);
    expect(client.calls).toHaveLength(2);
    expect(budget.summary().queriesSkipped).toBe(2);
  });

  it('marks the figure as estimated so the digest does not present it as billed', async () => {
    const client = fakeClient({ itemsPerQuery: 10, costPerItem: 0 });
    const budget = new RunBudget({ capUsd: 10, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    const result = await collect({ source: 'indeed', client, actorConfig, queries, options, budget });
    expect(result.meta.queryStats.every((q) => q.costEstimated)).toBe(true);
  });

  it('prefers the actor’s own number whenever it reports one', async () => {
    const client = fakeClient({ itemsPerQuery: 20, costPerItem: 0.01 }); // $0.20 a query
    const budget = new RunBudget({ capUsd: 10, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    const result = await collect({ source: 'indeed', client, actorConfig, queries, options, budget });
    expect(result.meta.queryStats[0].costUsd).toBeCloseTo(0.20, 5);
    expect(result.meta.queryStats[0].costEstimated).toBe(false);
  });
});

describe('actor-imposed minimum on maxItems', () => {
  it('raises maxItems to the actor floor, which Upwork enforces with a 400', () => {
    const withFloor = { ...actorConfig, input: { ...actorConfig.input, minItems: 20 } };
    expect(buildInput(withFloor, { query: 'x', maxItems: 5 }).n).toBe(20);
    expect(buildInput(withFloor, { query: 'x', maxItems: 50 }).n).toBe(50);
  });

  it('leaves actors without a floor alone', () => {
    expect(buildInput(actorConfig, { query: 'x', maxItems: 5 }).n).toBe(5);
  });
});

describe('per-actor billing rates', () => {
  const queries = ['q1'];
  const options = { maxItems: 20, lookbackDays: 2, timeoutSecs: 60 };

  it('uses the actor’s own rate rather than one global assumption', async () => {
    const pricey = { ...actorConfig, costPer1kResults: 6.0 };
    const client = fakeClient({ itemsPerQuery: 100, costPerItem: 0 });
    const budget = new RunBudget({ capUsd: 10, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    await collect({ source: 'linkedin', client, actorConfig: pricey, queries, options, budget });
    // 100 items at $6/1k is $0.60, not the $0.30 the global rate would have assumed.
    expect(budget.spent).toBeCloseTo(0.60, 5);
  });

  it('falls back to the global rate for an actor with no rate set', async () => {
    const client = fakeClient({ itemsPerQuery: 100, costPerItem: 0 });
    const budget = new RunBudget({ capUsd: 10, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    await collect({ source: 'indeed', client, actorConfig, queries, options, budget });
    expect(budget.spent).toBeCloseTo(0.30, 5);
  });
});

describe('a source with an unknown search field', () => {
  const options = { maxItems: 20, lookbackDays: 2, timeoutSecs: 60 };

  it('is skipped rather than run blind', async () => {
    // Upwork accepted two different guessed query fields, ignored both, and returned
    // arbitrary listings. Running it costs money and fills the sheet with noise.
    const blocked = { ...actorConfig, blocked: 'search field unknown' };
    const client = fakeClient({ itemsPerQuery: 20 });
    const budget = new RunBudget({ capUsd: 10, assumedCostPer1k: 3, maxItemsPerQuery: 20 });

    const result = await collect({ source: 'upwork', client, actorConfig: blocked, queries: ['q1', 'q2'], options, budget });

    expect(client.calls).toHaveLength(0);
    expect(budget.spent).toBe(0);
    expect(result.posts).toEqual([]);
    expect(result.warnings.join(' ')).toContain('search field unknown');
    expect(result.meta.blocked).toBe(true);
  });

  it('still runs a source that is not blocked', async () => {
    const client = fakeClient({ itemsPerQuery: 5 });
    const result = await collect({ source: 'indeed', client, actorConfig, queries: ['q1'], options });
    expect(client.calls).toHaveLength(1);
    expect(result.meta.blocked).toBeUndefined();
  });
});

describe('enum-bucketed recency windows', () => {
  // cheap_scraper's LinkedIn actor takes r86400 / r604800 / r2592000, not a day
  // count. Rounding down would silently narrow the search and lose postings.
  const withEnum = {
    ...actorConfig,
    input: {
      template: {},
      fields: { query: 'q', maxItems: 'n', postedWithinDays: 'publishedAt' },
      postedWithinDaysEnum: [[1, 'r86400'], [7, 'r604800'], [30, 'r2592000']],
    },
  };
  const build = (days) => buildInput(withEnum, { query: 'x', maxItems: 5, postedWithinDays: days }).publishedAt;

  it('rounds up to the narrowest window that still covers the lookback', () => {
    expect(build(1)).toBe('r86400');
    expect(build(2)).toBe('r604800');
    expect(build(7)).toBe('r604800');
    expect(build(14)).toBe('r2592000');
  });

  it('falls back to the widest window rather than dropping the filter', () => {
    expect(build(365)).toBe('r2592000');
  });

  it('omits the field when no lookback is requested', () => {
    expect(buildInput(withEnum, { query: 'x', maxItems: 5 }).publishedAt).toBeUndefined();
  });
});

describe('per-source budget shares', () => {
  const queries = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'];
  const options = { maxItems: 20, lookbackDays: 2, timeoutSecs: 60 };

  it('stops an expensive source at its share, leaving the rest for everyone else', async () => {
    const budget = new RunBudget({
      capUsd: 3.0, assumedCostPer1k: 3, maxItemsPerQuery: 20, shares: { linkedin: 0.4, indeed: 0.6 },
    });
    // LinkedIn's actor refuses fewer than 150 results, so one query is $0.90 at $6/1k.
    const linkedinConfig = {
      ...actorConfig,
      costPer1kResults: 6.0,
      input: { ...actorConfig.input, minItems: 150 },
    };
    const li = fakeClient({ itemsPerQuery: 150, costPerItem: 0.006 });
    await collect({ source: 'linkedin', client: li, actorConfig: linkedinConfig, queries, options, budget });

    // $1.20 is LinkedIn's share, so one query fits and a second would not.
    expect(li.calls).toHaveLength(1);
    expect(budget.spentBy('linkedin')).toBeCloseTo(0.90, 5);

    // Indeed still gets its own $1.80, which is every query it has.
    const ind = fakeClient({ itemsPerQuery: 20, costPerItem: 0.003 });
    await collect({ source: 'indeed', client: ind, actorConfig, queries, options, budget });
    expect(ind.calls).toHaveLength(8);
  });

  it('would have let the expensive source eat the whole run without shares', async () => {
    // The behaviour being guarded against: same cap, no shares, LinkedIn first.
    const budget = new RunBudget({ capUsd: 3.0, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    const linkedinConfig = { ...actorConfig, costPer1kResults: 6.0, input: { ...actorConfig.input, minItems: 150 } };
    const li = fakeClient({ itemsPerQuery: 150, costPerItem: 0.006 });
    await collect({ source: 'linkedin', client: li, actorConfig: linkedinConfig, queries, options, budget });
    expect(li.calls.length).toBeGreaterThan(1);

    const ind = fakeClient({ itemsPerQuery: 20, costPerItem: 0.003 });
    await collect({ source: 'indeed', client: ind, actorConfig, queries, options, budget });
    expect(ind.calls.length).toBeLessThan(8);
  });

  it('prices the pre-check off the actor floor, not off max_items_per_query', () => {
    const b = new RunBudget({ capUsd: 1.0, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    // 20 items at $3 is $0.06 and fits. 150 items at $6 is $0.90 and also fits, but
    // only because the cap is $1. The point is that the two are priced differently.
    expect(b.estimatedQueryCost({ maxItems: 20, ratePer1k: 3 })).toBeCloseTo(0.06, 5);
    expect(b.estimatedQueryCost({ maxItems: 150, ratePer1k: 6 })).toBeCloseTo(0.90, 5);
  });

  it('charges a source against both its own share and the global cap', () => {
    const b = new RunBudget({ capUsd: 1.0, shares: { a: 0.5, b: 0.5 }, assumedCostPer1k: 3, maxItemsPerQuery: 20 });
    b.record(0.45, { source: 'a' });
    expect(b.canAfford({ source: 'a', maxItems: 20, ratePer1k: 3 })).toBe(false); // 0.45 + 0.06 > 0.50
    expect(b.canAfford({ source: 'b', maxItems: 20, ratePer1k: 3 })).toBe(true);
    expect(b.summary().perSource).toEqual({ a: 0.45 });
  });

  it('gives a source with no share the whole cap, so an unlisted source is not starved', () => {
    const b = new RunBudget({ capUsd: 1.0, shares: { a: 0.5 } });
    expect(b.capFor('a')).toBeCloseTo(0.5, 5);
    expect(b.capFor('unlisted')).toBe(1.0);
  });

  it('ignores shares entirely when there is no cap', () => {
    const b = new RunBudget({ shares: { a: 0.1 } });
    expect(b.capFor('a')).toBe(Infinity);
    expect(b.canAfford({ source: 'a', maxItems: 100000, ratePer1k: 100 })).toBe(true);
  });
});

describe('activeShares', () => {
  const shares = { indeed: 0.4, linkedin: 0.4, upwork: 0.2 };

  it('hands the whole cap to the sources that are actually running', () => {
    // Upwork blocked and LinkedIn off-cadence: Indeed should get all of it, not 40%.
    expect(activeShares(shares, ['indeed'])).toEqual({ indeed: 1 });
  });

  it('splits proportionally between the sources that remain', () => {
    const result = activeShares(shares, ['indeed', 'linkedin']);
    expect(result.indeed).toBeCloseTo(0.5, 6);
    expect(result.linkedin).toBeCloseTo(0.5, 6);
  });

  it('keeps the configured ratio when everything runs', () => {
    const result = activeShares(shares, ['indeed', 'linkedin', 'upwork']);
    expect(result.upwork).toBeCloseTo(0.2, 6);
    expect(Object.values(result).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('returns nothing rather than dividing by zero when no source has a share', () => {
    expect(activeShares({}, ['indeed'])).toEqual({});
    expect(activeShares(shares, [])).toEqual({});
    // No shares means RunBudget falls back to the whole cap per source, which is the
    // old unshared behaviour rather than a lockout.
    expect(new RunBudget({ capUsd: 3, shares: activeShares({}, ['indeed']) }).capFor('indeed')).toBe(3);
  });

  it('survives a share given as a string or a nonsense value', () => {
    const result = activeShares({ a: '0.5', b: 'nonsense', c: -1 }, ['a', 'b', 'c']);
    expect(result).toEqual({ a: 1, b: 0, c: 0 });
  });
});

describe('shouldRunToday', () => {
  it('runs every day when the cadence is 1, absent, or nonsense', () => {
    for (const n of [1, undefined, null, 0, -3, 'weekly']) {
      expect(shouldRunToday(n, 12345), String(n)).toBe(true);
    }
  });

  it('runs on exactly half the days at a cadence of 2', () => {
    const days = Array.from({ length: 10 }, (_, i) => 1000 + i);
    expect(days.filter((d) => shouldRunToday(2, d))).toHaveLength(5);
  });

  it('is keyed off the day number, so a skipped or crashed run does not shift it', () => {
    // A counter would drift after a failed run. The calendar cannot.
    expect(shouldRunToday(2, 100)).toBe(true);
    expect(shouldRunToday(2, 101)).toBe(false);
    expect(shouldRunToday(2, 102)).toBe(true);
  });

  it('handles a weekly cadence', () => {
    const days = Array.from({ length: 14 }, (_, i) => i);
    expect(days.filter((d) => shouldRunToday(7, d))).toEqual([0, 7]);
  });
});

describe('effectiveLookback', () => {
  it('widens the window by the days the source sat out', () => {
    // Two-day lookback running every other day covers the calendar exactly, with no
    // margin. One failed run and a day of postings is gone for good.
    expect(effectiveLookback(2, 2)).toBe(3);
    expect(effectiveLookback(2, 7)).toBe(8);
  });

  it('leaves a daily source alone', () => {
    expect(effectiveLookback(2, 1)).toBe(2);
    expect(effectiveLookback(2, undefined)).toBe(2);
  });

  it('does not widen the first-run window, which is already wide', () => {
    expect(effectiveLookback(14, 2)).toBe(15);
  });

  it('passes a nonsense lookback straight through rather than inventing one', () => {
    expect(effectiveLookback(null, 2)).toBeNull();
  });
});

describe('planSources', () => {
  const actors = {
    upwork: { actorId: 'a/upwork', blocked: 'search field unknown' },
    linkedin: { actorId: 'a/linkedin', runEveryNDays: 2 },
    indeed: { actorId: 'a/indeed' },
    broken: {},
  };
  const names = ['upwork', 'linkedin', 'indeed', 'broken'];
  const by = (plan) => Object.fromEntries(plan.map((p) => [p.name, p]));

  it('runs the daily source on any day', () => {
    for (const day of [100, 101]) expect(by(planSources(names, actors, day)).indeed.active).toBe(true);
  });

  it('runs the every-other-day source on alternate days', () => {
    expect(by(planSources(names, actors, 100)).linkedin.active).toBe(true);
    expect(by(planSources(names, actors, 101)).linkedin.active).toBe(false);
  });

  it('carries the cadence forward so the lookback can widen to match', () => {
    expect(by(planSources(names, actors, 100)).linkedin.everyNDays).toBe(2);
  });

  it('excludes a blocked source and says why, every run', () => {
    const upwork = by(planSources(names, actors, 100)).upwork;
    expect(upwork.active).toBe(false);
    expect(upwork.reason).toContain('search field unknown');
  });

  it('excludes a source with no actorId rather than throwing mid-run', () => {
    expect(by(planSources(names, actors, 100)).broken).toMatchObject({ active: false });
    expect(by(planSources(names, actors, 100)).broken.reason).toContain('actorId');
  });

  it('always gives a reason for every source it leaves out', () => {
    for (const plan of planSources(names, actors, 101)) {
      if (!plan.active) expect(plan.reason, plan.name).toBeTruthy();
    }
  });

  it('hands the whole cap to Indeed on a day nothing else runs', () => {
    // The three pieces together: Upwork blocked, LinkedIn off-cadence, so the $3 that
    // would have been split three ways is all Indeed's.
    const plan = planSources(names, actors, 101);
    const active = plan.filter((p) => p.active).map((p) => p.name);
    expect(active).toEqual(['indeed']);
    const budget = new RunBudget({
      capUsd: 3, shares: activeShares({ indeed: 0.4, linkedin: 0.4, upwork: 0.2 }, active),
    });
    expect(budget.capFor('indeed')).toBeCloseTo(3, 6);
  });
});
