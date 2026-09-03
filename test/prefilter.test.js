import { describe, it, expect } from 'vitest';
import { prefilter, prefilterPost, prefilterPatches, titleBlocked, DEFAULT_TITLE_BLOCKLIST } from '../src/pipeline/prefilter.js';
import { scorePost } from '../src/pipeline/score.js';
import { STATUS } from '../src/sheets/schema.js';

const CONFIG = {
  salary_floor_annual: 120000,
  hourly_floor: 100,
  fixed_price_hourly_floor: 100,
  fit_score_gate: 7,
};

const post = (over = {}) => ({
  post_id: 'p1', _row: 2, source: 'indeed', title: 'Sales Operations Manager',
  comp_type: 'unknown', comp_min: null, comp_max: null, est_hours: null, ...over,
});

const perfect = {
  signal_type: 'direct_role', hard_out: null, hard_out_reason: null, niche: 'coaching',
  tools_mentioned: [], team_size_hint: 5, remote_confirmed: true,
  capability_match: 10, ownership_match: 10, reasons: [],
};

describe('title blocklist', () => {
  it('catches obvious non-fits', () => {
    expect(titleBlocked('Warehouse Associate')).toBe('warehouse');
    expect(titleBlocked('CDL Truck Driver')).toBeTruthy();
    expect(titleBlocked('Data Entry Clerk')).toBe('data entry');
    expect(titleBlocked('RN Case Manager')).toBe('rn');
  });

  it('leaves anything plausibly sales-ops alone', () => {
    for (const title of [
      'Sales Operations Manager', 'Revenue Operations Lead', 'GoHighLevel Expert',
      'Integrator', 'Operations Manager', 'Zapier Automation Specialist',
      'Fractional CTO', 'Sales Systems Analyst', 'CRM Administrator',
      'Business Operations Manager', 'Head of Operations', 'Automation Engineer',
    ]) {
      expect(titleBlocked(title), `${title} must not be blocked`).toBeNull();
    }
  });

  it('matches whole words, never substrings', () => {
    // Substring matching made "Serverless" hit the restaurant term and silently
    // dropped the lead. Word boundaries are the fix.
    expect(titleBlocked('Serverless Platform Engineer')).toBeNull();
    expect(titleBlocked('Observability Lead')).toBeNull();
    expect(titleBlocked('Learning & Development Lead')).toBeNull();
    expect(titleBlocked('Assembler of Systems Documentation')).toBe('assembler');
  });

  it('honours prefix stems', () => {
    expect(titleBlocked('Housekeeping Supervisor')).toBe('housekeep*');
    expect(titleBlocked('Landscaper')).toBe('landscap*');
    expect(titleBlocked('Landscaping Crew Lead')).toBe('landscap*');
  });

  it('handles an empty or missing title', () => {
    expect(titleBlocked('')).toBeNull();
    expect(titleBlocked(null)).toBeNull();
    expect(titleBlocked(undefined)).toBeNull();
  });

  it('accepts a caller-supplied list', () => {
    expect(titleBlocked('Sales Operations Manager', ['sales operations'])).toBe('sales operations');
    expect(titleBlocked('Warehouse Associate', [])).toBeNull();
  });
});

describe('prefilterPost', () => {
  it('rejects on compensation below the floor without a model call', () => {
    const verdict = prefilterPost(post({ comp_type: 'salary', comp_max: 70000 }), CONFIG);
    expect(verdict.skip).toBe(true);
    expect(verdict.reason).toContain('below the $120,000 floor');
  });

  it('never rejects for missing compensation', () => {
    for (const comp_type of ['salary', 'hourly', 'fixed', 'unknown']) {
      expect(prefilterPost(post({ comp_type }), CONFIG).skip, `${comp_type} must survive`).toBe(false);
    }
  });

  it('passes anything it cannot decide on money or title', () => {
    expect(prefilterPost(post({ comp_type: 'salary', comp_max: 200000 }), CONFIG).skip).toBe(false);
  });

  it('carries comp_unknown through so the flag is not lost', () => {
    expect(prefilterPost(post(), CONFIG).flags).toContain('comp_unknown');
  });
});

describe('the pre-filter can only agree with the full gate', () => {
  // This is the property that makes the optimization safe. The compensation half of
  // the pre-filter is literally the function scorePost calls, so anything it drops
  // must also be dropped by a full scoring pass with a perfect classification.
  const cases = [
    { comp_type: 'salary', comp_max: 70000 },
    { comp_type: 'salary', comp_max: 119999 },
    { comp_type: 'salary', comp_max: 120000 },
    { comp_type: 'salary', comp_max: 300000 },
    { comp_type: 'hourly', comp_max: 25 },
    { comp_type: 'hourly', comp_max: 99 },
    { comp_type: 'hourly', comp_max: 100 },
    { comp_type: 'fixed', comp_max: 1000, est_hours: 40 },
    { comp_type: 'fixed', comp_max: 8000, est_hours: 40 },
    { comp_type: 'fixed', comp_max: 500, est_hours: null },
    { comp_type: 'unknown' },
    { comp_type: 'salary', comp_min: 200000, comp_max: null },
  ];

  for (const shape of cases) {
    it(`agrees on ${JSON.stringify(shape)}`, () => {
      const p = post(shape);
      const pre = prefilterPost(p, CONFIG);
      const full = scorePost(p, perfect, CONFIG);

      if (pre.skip) {
        // Dropped early, so the full gate with a perfect score must also reject it.
        expect(full.status).toBe(STATUS.REJECTED);
        expect(pre.reason).toBe(full.hard_out_reason);
      } else {
        // Kept, so nothing was thrown away that the gate would have wanted.
        expect(full.status).toBe(STATUS.LEAD);
      }
    });
  }

  it('never drops a post a perfect classification would have made a lead', () => {
    const survivors = cases
      .map((shape) => post(shape))
      .filter((p) => scorePost(p, perfect, CONFIG).status === STATUS.LEAD);
    for (const p of survivors) {
      expect(prefilterPost(p, CONFIG).skip, `${p.comp_type} ${p.comp_max} must survive`).toBe(false);
    }
  });
});

describe('prefilter batch', () => {
  it('splits the batch and reports both sides', () => {
    const posts = [
      post({ post_id: 'a', title: 'Sales Operations Manager' }),
      post({ post_id: 'b', title: 'Warehouse Associate' }),
      post({ post_id: 'c', comp_type: 'hourly', comp_max: 18 }),
      post({ post_id: 'd', comp_type: 'salary', comp_max: 150000 }),
    ];
    const { keep, rejected } = prefilter(posts, CONFIG);
    expect(keep.map((p) => p.post_id)).toEqual(['a', 'd']);
    expect(rejected.map((r) => r.post.post_id)).toEqual(['b', 'c']);
  });

  it('handles an empty batch', () => {
    expect(prefilter([], CONFIG)).toEqual({ keep: [], rejected: [] });
  });

  it('writes a real reason, so a pre-filtered row reads like any other rejection', () => {
    const { rejected } = prefilter([post({ comp_type: 'hourly', comp_max: 18 })], CONFIG);
    const [patch] = prefilterPatches(rejected, 'run-1');
    expect(patch.row).toBe(2);
    expect(patch.patch.status).toBe(STATUS.REJECTED);
    expect(patch.patch.hard_out_reason).toContain('below the $100 floor');
    expect(patch.patch.last_classified_run).toBe('run-1');
    expect(patch.patch.fit_reasons).toContain('no model call spent');
  });
});
