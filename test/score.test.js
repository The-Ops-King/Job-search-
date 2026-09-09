import { describe, it, expect } from 'vitest';
import { scorePost, fitScore, COMP_FLAG } from '../src/pipeline/score.js';
import { STATUS, TRACK } from '../src/sheets/schema.js';

const CONFIG = {
  salary_floor_annual: 120000,
  hourly_floor: 100,
  fixed_price_hourly_floor: 100,
  fit_score_gate: 7,
};

const strong = (over = {}) => ({
  signal_type: 'direct_role',
  hard_out: null,
  hard_out_reason: null,
  niche: 'coaching',
  tools_mentioned: ['GoHighLevel'],
  team_size_hint: 6,
  remote_confirmed: true,
  capability_match: 9,
  ownership_match: 9,
  reasons: ['GHL rebuild, small founder-led team'],
  ...over,
});

const post = (over = {}) => ({
  post_id: 'p1', source: 'indeed', title: 'Ops Manager',
  comp_type: 'unknown', comp_min: null, comp_max: null, est_hours: null, ...over,
});

describe('fitScore', () => {
  it('weights capability at 0.7 and ownership at 0.3, to one decimal', () => {
    expect(fitScore(10, 10)).toBe(10);
    expect(fitScore(8, 6)).toBe(7.4);
    expect(fitScore(9, 4)).toBe(7.5);
    expect(fitScore(0, 0)).toBe(0);
  });

  it('clamps out-of-range scores rather than propagating them', () => {
    expect(fitScore(99, -5)).toBe(7);
    expect(fitScore(null, undefined)).toBe(0);
  });
});

describe('rule 1: hard-outs stop everything', () => {
  for (const hardOut of ['salesforce_required', 'closer_role', 'vp_sales', 'onsite', 'large_team']) {
    it(`rejects on ${hardOut} regardless of how well it scores`, () => {
      const verdict = scorePost(
        post({ comp_type: 'salary', comp_max: 400000 }),
        strong({ hard_out: hardOut, hard_out_reason: 'stated in the posting' }),
        CONFIG);
      expect(verdict.status).toBe(STATUS.REJECTED);
      expect(verdict.hard_out).toBe(hardOut);
      expect(verdict.hard_out_reason).toBe('stated in the posting');
    });
  }

  it('falls back to the hard_out code when no reason is given', () => {
    const verdict = scorePost(post(), strong({ hard_out: 'onsite', hard_out_reason: null }), CONFIG);
    expect(verdict.hard_out_reason).toBe('onsite');
  });
});

describe('rule 2: noise', () => {
  it('rejects noise even with perfect sub-scores', () => {
    const verdict = scorePost(post(), strong({ signal_type: 'noise' }), CONFIG);
    expect(verdict.status).toBe(STATUS.REJECTED);
    expect(verdict.hard_out_reason).toContain('noise');
  });
});

describe('rule 3: compensation floors', () => {
  it('rejects a salary whose top of range is under the floor', () => {
    const verdict = scorePost(post({ comp_type: 'salary', comp_min: 80000, comp_max: 95000 }), strong(), CONFIG);
    expect(verdict.status).toBe(STATUS.REJECTED);
    expect(verdict.hard_out_reason).toContain('below the $120,000 floor');
  });

  it('passes a salary exactly at the floor', () => {
    const verdict = scorePost(post({ comp_type: 'salary', comp_max: 120000 }), strong(), CONFIG);
    expect(verdict.status).toBe(STATUS.LEAD);
  });

  it('rejects an hourly rate under the floor', () => {
    const verdict = scorePost(post({ comp_type: 'hourly', comp_min: 40, comp_max: 65 }), strong(), CONFIG);
    expect(verdict.status).toBe(STATUS.REJECTED);
    expect(verdict.hard_out_reason).toContain('hourly $65');
  });

  it('passes an hourly rate at the floor', () => {
    expect(scorePost(post({ comp_type: 'hourly', comp_max: 100 }), strong(), CONFIG).status).toBe(STATUS.LEAD);
  });

  it('rejects fixed price whose implied hourly rate is under the floor', () => {
    const verdict = scorePost(post({ comp_type: 'fixed', comp_max: 2000, est_hours: 40 }), strong(), CONFIG);
    expect(verdict.status).toBe(STATUS.REJECTED);
    expect(verdict.hard_out_reason).toContain('$50/hr');
  });

  it('passes fixed price whose implied hourly rate clears the floor', () => {
    const verdict = scorePost(post({ comp_type: 'fixed', comp_max: 8000, est_hours: 40 }), strong(), CONFIG);
    expect(verdict.status).toBe(STATUS.LEAD);
    expect(verdict.reasons.join(' ')).toContain('$200/hr');
  });

  it('passes fixed price with no hour estimate and flags it', () => {
    const verdict = scorePost(post({ comp_type: 'fixed', comp_max: 1500, est_hours: null }), strong(), CONFIG);
    expect(verdict.status).toBe(STATUS.LEAD);
    expect(verdict.comp_flags).toContain(COMP_FLAG.UNKNOWN);
  });

  it('rejects a fixed total that cannot reach the hourly floor at any hours', () => {
    // A live probe returned a $5 fixed posting. No job takes under an hour, so the
    // implied rate is bounded above by the total, and $5 can never reach $100/hr.
    const verdict = scorePost(post({ comp_type: 'fixed', comp_max: 5, est_hours: null }), strong(), CONFIG);
    expect(verdict.status).toBe(STATUS.REJECTED);
    expect(verdict.hard_out_reason).toContain('at any number of hours');
  });

  it('still passes a fixed total at or above the floor with no hours given', () => {
    expect(scorePost(post({ comp_type: 'fixed', comp_max: 100, est_hours: null }), strong(), CONFIG).status)
      .toBe(STATUS.LEAD);
  });

  it('never rejects for missing compensation, whatever the type', () => {
    for (const comp_type of ['salary', 'hourly', 'fixed', 'unknown']) {
      const verdict = scorePost(post({ comp_type, comp_min: null, comp_max: null }), strong(), CONFIG);
      expect(verdict.status, `${comp_type} with no comp must pass`).toBe(STATUS.LEAD);
      expect(verdict.comp_flags).toContain(COMP_FLAG.UNKNOWN);
    }
  });

  it('falls back to comp_min when only one bound is given', () => {
    expect(scorePost(post({ comp_type: 'salary', comp_min: 150000, comp_max: null }), strong(), CONFIG).status)
      .toBe(STATUS.LEAD);
    expect(scorePost(post({ comp_type: 'salary', comp_min: 60000, comp_max: null }), strong(), CONFIG).status)
      .toBe(STATUS.REJECTED);
  });

  it('checks compensation before the fit gate, so a cheap perfect match is rejected on money', () => {
    const verdict = scorePost(post({ comp_type: 'hourly', comp_max: 20 }), strong(), CONFIG);
    expect(verdict.hard_out_reason).toContain('floor');
  });
});

describe('rule 4: the fit gate', () => {
  it('rejects below the gate and reports the score', () => {
    const verdict = scorePost(post(), strong({ capability_match: 5, ownership_match: 5 }), CONFIG);
    expect(verdict.status).toBe(STATUS.REJECTED);
    expect(verdict.fit_score).toBe(5);
    expect(verdict.hard_out_reason).toContain('below the 7 gate');
  });

  it('passes exactly at the gate', () => {
    const verdict = scorePost(post(), strong({ capability_match: 7, ownership_match: 7 }), CONFIG);
    expect(verdict.fit_score).toBe(7);
    expect(verdict.status).toBe(STATUS.LEAD);
  });

  it('respects a gate raised through the Config tab', () => {
    const verdict = scorePost(post(), strong({ capability_match: 8, ownership_match: 8 }), { ...CONFIG, fit_score_gate: 9 });
    expect(verdict.status).toBe(STATUS.REJECTED);
  });
});

describe('rule 5: track assignment', () => {
  it('sends direct_role to the application track', () => {
    expect(scorePost(post(), strong({ signal_type: 'direct_role' }), CONFIG).track).toBe(TRACK.APPLICATION);
  });

  it('sends scaling_signal to the pitch track', () => {
    expect(scorePost(post(), strong({ signal_type: 'scaling_signal' }), CONFIG).track).toBe(TRACK.PITCH);
  });

  it('leaves track null on anything rejected', () => {
    expect(scorePost(post(), strong({ hard_out: 'onsite' }), CONFIG).track).toBeNull();
  });
});

describe('robustness', () => {
  it('does not throw when the classification is missing entirely', () => {
    const verdict = scorePost(post(), null, CONFIG);
    expect(verdict.status).toBe(STATUS.REJECTED);
    expect(verdict.fit_score).toBe(0);
  });

  it('handles compensation arriving as a formatted string from the sheet', () => {
    const verdict = scorePost(post({ comp_type: 'salary', comp_max: '$95,000' }), strong(), CONFIG);
    expect(verdict.status).toBe(STATUS.REJECTED);
  });
});

describe('a salary figure whose period was lost', () => {
  // LinkedIn publishes pay as a bare array of amounts with no period attached, and
  // labels almost everything "Full-time". A posting quoting $150/hr therefore arrives
  // as comp_type salary with comp_max 150. Rejecting that against the $120,000 floor
  // would silently drop one of the best-paying leads on the board.
  it('does not reject an implausibly small annual salary, it treats it as unknown', () => {
    const verdict = scorePost(post({ comp_type: 'salary', comp_min: 100, comp_max: 150 }), strong(), CONFIG);
    expect(verdict.status).toBe(STATUS.LEAD);
    expect(verdict.comp_flags).toContain(COMP_FLAG.UNKNOWN);
    expect(verdict.comp_flags).toContain(COMP_FLAG.IMPLAUSIBLE);
  });

  it('still rejects a real salary that is merely low', () => {
    // $80,000 is a plausible annual figure and genuinely below the floor.
    const verdict = scorePost(post({ comp_type: 'salary', comp_max: 80000 }), strong(), CONFIG);
    expect(verdict.status).toBe(STATUS.REJECTED);
    expect(verdict.comp_flags).not.toContain(COMP_FLAG.IMPLAUSIBLE);
  });

  it('draws the line where no real annual salary lives', () => {
    expect(scorePost(post({ comp_type: 'salary', comp_max: 14999 }), strong(), CONFIG).status).toBe(STATUS.LEAD);
    expect(scorePost(post({ comp_type: 'salary', comp_max: 15000 }), strong(), CONFIG).status).toBe(STATUS.REJECTED);
  });

  it('leaves hourly and fixed alone, where small numbers are meaningful', () => {
    // $150/hr correctly labelled must pass, and $150 fixed must still fail.
    expect(scorePost(post({ comp_type: 'hourly', comp_max: 150 }), strong(), CONFIG).status).toBe(STATUS.LEAD);
    expect(scorePost(post({ comp_type: 'fixed', comp_max: 50 }), strong(), CONFIG).status).toBe(STATUS.REJECTED);
  });
});
