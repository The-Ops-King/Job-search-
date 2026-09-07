import { describe, it, expect } from 'vitest';
import { RunBudget, rotateQueries, dayIndex } from '../src/lib/budget.js';
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
    expect(b.estimatedQueryCost).toBeCloseTo(0.06, 5);
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
      expect(budget.spent, `cap ${cap}`).toBeLessThanOrEqual(cap + budget.estimatedQueryCost);
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
