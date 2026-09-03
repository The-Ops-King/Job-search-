import { STATUS, TRACK } from '../sheets/schema.js';

/**
 * The gate. Pure and synchronous so every floor rule is unit-testable without a
 * sheet, an actor or an API key.
 *
 * Rules run in the order given in the spec, and the first one that rejects wins.
 * The one rule worth stating twice: missing compensation never rejects. Most good
 * postings omit pay, and rejecting on absence would throw away the best leads.
 */

export const COMP_FLAG = { UNKNOWN: 'comp_unknown' };

export function fitScore(capability, ownership) {
  const cap = clamp(capability);
  const own = clamp(ownership);
  return Math.round((0.7 * cap + 0.3 * own) * 10) / 10;
}

const clamp = (n) => Math.min(10, Math.max(0, Number(n) || 0));

export function scorePost(post, classification, config) {
  const reasons = [];
  const flags = [];

  const reject = (reason, hardOut = null) => ({
    status: STATUS.REJECTED,
    fit_score: fitScore(classification?.capability_match ?? 0, classification?.ownership_match ?? 0),
    hard_out: hardOut,
    hard_out_reason: reason,
    comp_flags: flags,
    reasons: [...reasons, reason],
    track: null,
  });

  // 1. Hard-outs from the classifier.
  if (classification?.hard_out) {
    return reject(classification.hard_out_reason || classification.hard_out, classification.hard_out);
  }

  // 2. Noise.
  if (classification?.signal_type === 'noise') {
    return reject('classified as noise', null);
  }

  // 3. Compensation floors.
  const top = firstNumber(post.comp_max, post.comp_min);
  const type = post.comp_type;

  if (type === 'salary') {
    if (top === null) flags.push(COMP_FLAG.UNKNOWN);
    else if (top < config.salary_floor_annual) {
      return reject(`salary ${fmt(top)} is below the ${fmt(config.salary_floor_annual)} floor`);
    }
  } else if (type === 'hourly') {
    if (top === null) flags.push(COMP_FLAG.UNKNOWN);
    else if (top < config.hourly_floor) {
      return reject(`hourly ${fmt(top)} is below the ${fmt(config.hourly_floor)} floor`);
    }
  } else if (type === 'fixed') {
    const hours = Number(post.est_hours);
    if (top === null) {
      flags.push(COMP_FLAG.UNKNOWN);
    } else if (Number.isFinite(hours) && hours > 0) {
      const implied = top / hours;
      if (implied < config.fixed_price_hourly_floor) {
        return reject(
          `fixed ${fmt(top)} over ${hours}h implies ${fmt(Math.round(implied))}/hr, ` +
          `below the ${fmt(config.fixed_price_hourly_floor)} floor`);
      }
      reasons.push(`fixed budget implies ~${fmt(Math.round(implied))}/hr`);
    } else {
      // Fixed price with no hour estimate: no way to imply a rate, so it passes.
      flags.push(COMP_FLAG.UNKNOWN);
    }
  } else {
    flags.push(COMP_FLAG.UNKNOWN);
  }

  // 4. Fit gate.
  const score = fitScore(classification?.capability_match, classification?.ownership_match);
  if (score < config.fit_score_gate) {
    return {
      status: STATUS.REJECTED,
      fit_score: score,
      hard_out: null,
      hard_out_reason: `fit ${score} is below the ${config.fit_score_gate} gate`,
      comp_flags: flags,
      reasons: [...reasons, ...(classification?.reasons ?? [])],
      track: null,
    };
  }

  // 5. Survivor.
  return {
    status: STATUS.LEAD,
    fit_score: score,
    hard_out: null,
    hard_out_reason: '',
    comp_flags: flags,
    reasons: [...reasons, ...(classification?.reasons ?? [])],
    track: classification?.signal_type === 'scaling_signal' ? TRACK.PITCH : TRACK.APPLICATION,
  };
}

function firstNumber(...values) {
  for (const v of values) {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

const fmt = (n) => `$${Number(n).toLocaleString('en-US')}`;
