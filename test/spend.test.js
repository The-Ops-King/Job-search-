import { describe, it, expect } from 'vitest';
import { summarizeSpend, spendLines } from '../src/pipeline/spend.js';
import { buildDigest } from '../src/pipeline/digest.js';

const stats = () => ({
  upwork: {
    posts: 30,
    queryStats: [
      { query: 'sales operations', items: 50, costUsd: 0.125, cappedOut: true },
      { query: 'GoHighLevel', items: 4, costUsd: 0.01, cappedOut: false },
      { query: 'fractional CTO', items: 0, costUsd: 0, cappedOut: false },
    ],
  },
  indeed: {
    posts: 12,
    queryStats: [
      { query: 'sales ops', items: 20, costUsd: 0.06, cappedOut: false },
      { query: 'integrator', items: 0, costUsd: 0, cappedOut: false },
    ],
  },
});

describe('summarizeSpend', () => {
  it('totals cost and billed results across sources', () => {
    const s = summarizeSpend(stats(), { keptPostIds: 8, collectedRaw: 74 });
    expect(s.totalCost).toBeCloseTo(0.195, 4);
    expect(s.totalItems).toBe(74);
    expect(s.rows).toHaveLength(5);
  });

  it('ranks queries by what they cost, which is what you act on', () => {
    const s = summarizeSpend(stats(), {});
    expect(s.rows[0].query).toBe('sales operations');
    expect(s.rows[0].source).toBe('upwork');
  });

  it('names queries that returned nothing', () => {
    const s = summarizeSpend(stats(), {});
    expect(s.dead.map((d) => d.query).sort()).toEqual(['fractional CTO', 'integrator']);
  });

  it('flags queries that hit the cap, since those are being truncated', () => {
    expect(summarizeSpend(stats(), {}).capped.map((c) => c.query)).toEqual(['sales operations']);
  });

  it('computes cost per post actually kept, not per result billed', () => {
    const s = summarizeSpend(stats(), { keptPostIds: 8, collectedRaw: 74 });
    expect(s.costPerKept).toBeCloseTo(0.195 / 8, 5);
    // 74 billed, 8 survived dedupe.
    expect(s.wastedItems).toBe(66);
    expect(s.wasteRatio).toBeCloseTo(66 / 74, 4);
  });

  it('projects a monthly figure from one daily run', () => {
    expect(summarizeSpend(stats(), {}).projectedMonthly).toBeCloseTo(0.195 * 30, 2);
  });

  it('does not divide by zero when nothing was kept', () => {
    const s = summarizeSpend(stats(), { keptPostIds: 0, collectedRaw: 74 });
    expect(s.costPerKept).toBeNull();
    expect(Number.isFinite(s.wasteRatio)).toBe(true);
  });

  it('handles a source that failed before producing any query stats', () => {
    const s = summarizeSpend({ linkedin: { posts: 0, failed: true } }, {});
    expect(s.rows).toEqual([]);
    expect(s.totalCost).toBe(0);
  });
});

describe('spendLines', () => {
  it('reports the total, the projection and the waste ratio', () => {
    const text = spendLines(summarizeSpend(stats(), { keptPostIds: 8, collectedRaw: 74 })).join('\n');
    expect(text).toContain('APIFY SPEND: $0.20');
    expect(text).toContain('projected $6/month');
    expect(text).toContain('per post actually kept');
    expect(text).toContain('89% of billed results were duplicates');
  });

  it('names the dead queries so they can be deleted', () => {
    const text = spendLines(summarizeSpend(stats(), {})).join('\n');
    expect(text).toContain('2 queries returned nothing');
    expect(text).toContain('"fractional CTO"');
  });

  it('says nothing at all when no queries ran', () => {
    expect(spendLines(summarizeSpend({}, {}))).toEqual([]);
  });
});

describe('digest carries the spend block', () => {
  it('includes it when spend is supplied', () => {
    const { body } = buildDigest({
      runId: 'r1', startedAt: '2026-09-03T13:00:00Z', finishedAt: '2026-09-03T13:10:00Z',
      counts: { new_posts: 8 },
      spend: summarizeSpend(stats(), { keptPostIds: 8, collectedRaw: 74 }),
    });
    expect(body).toContain('APIFY SPEND');
    expect(body).toContain('most expensive queries');
  });

  it('omits it cleanly when there is none', () => {
    const { body } = buildDigest({ runId: 'r1', counts: {} });
    expect(body).not.toContain('APIFY SPEND');
  });

  it('states what the model cost figure means, so quota is not read as a bill', () => {
    const { body } = buildDigest({
      runId: 'r1', counts: {},
      costNote: '$1.20 quota-equivalent across 80 calls (no API bill; $0.30 of that is real spend on Apify and enrichment)',
    });
    expect(body).toContain('quota-equivalent');
    expect(body).toContain('no API bill');
  });
});
