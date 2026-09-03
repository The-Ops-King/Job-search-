import { checkCompensation, COMP_FLAG } from './score.js';
import { STATUS } from '../sheets/schema.js';
import { log } from '../lib/log.js';

/**
 * Rejects postings that need no model call, before the model call happens.
 *
 * Two kinds of rejection, and the difference matters:
 *
 * 1. Compensation. This reuses checkCompensation from score.js, the same function
 *    scorePost calls. It is not an approximation of the gate, it is the gate, run
 *    early. A post rejected here would have been rejected after classification with
 *    the identical reason, so nothing is lost and the call is saved.
 *
 * 2. Title. This one IS a heuristic, so it is deliberately narrow: only titles that
 *    could not plausibly be sales-ops work under any reading. It is configurable in
 *    scoring.json, and the cost of getting it wrong is a silently missed lead, which
 *    is the expensive direction. When in doubt the rule is to let it through and pay
 *    for the call.
 *
 * A post with no stated compensation is never rejected here, for the same reason it
 * is never rejected in score.js: most good postings omit pay.
 */

/**
 * Only terms that cannot plausibly appear in sales-ops work. A trailing * means
 * prefix match ("landscap*" catches landscaping and landscaper); everything else
 * matches as a whole word.
 *
 * Ambiguous terms are deliberately absent. "server" was here and matched
 * "Serverless Platform Engineer"; the cost of a wrong entry is a lead that
 * disappears without ever reaching the sheet, which is far worse than the cent it
 * saves. Anything borderline goes to the model.
 */
export const DEFAULT_TITLE_BLOCKLIST = [
  'warehouse', 'forklift', 'cdl', 'truck driver', 'delivery driver', 'courier',
  'nurse', 'nursing', 'rn', 'lpn', 'cna', 'caregiver', 'phlebotom*', 'medical assistant',
  'dental assistant', 'dental hygienist', 'pharmacy technician',
  'cashier', 'barista', 'line cook', 'dishwasher', 'waiter', 'waitress',
  'janitor', 'custodian', 'housekeep*', 'landscap*', 'groundskeep*',
  'welder', 'machinist', 'electrician', 'plumber', 'hvac', 'carpenter',
  'auto mechanic', 'diesel mechanic', 'laborer', 'assembler',
  'data entry', 'transcription*', 'security guard',
];

const patternCache = new Map();

function toPattern(term) {
  if (patternCache.has(term)) return patternCache.get(term);
  const raw = String(term).toLowerCase().trim();
  const isPrefix = raw.endsWith('*');
  const body = (isPrefix ? raw.slice(0, -1) : raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(isPrefix ? `\\b${body}` : `\\b${body}\\b`, 'i');
  patternCache.set(term, pattern);
  return pattern;
}

/** Returns the offending term, or null. Word-boundary matched, never a substring. */
export function titleBlocked(title, blocklist = DEFAULT_TITLE_BLOCKLIST) {
  const text = String(title ?? '');
  if (!text.trim()) return null;
  return blocklist.find((term) => toPattern(term).test(text)) ?? null;
}

/**
 * Returns { skip, status, reason, flags } for one post. `skip` true means do not
 * spend a model call on it.
 */
export function prefilterPost(post, config) {
  const blocklist = config.title_blocklist ?? DEFAULT_TITLE_BLOCKLIST;

  const blockedTerm = titleBlocked(post.title, blocklist);
  if (blockedTerm) {
    return {
      skip: true,
      status: STATUS.REJECTED,
      reason: `title contains "${blockedTerm}", which is not sales-ops work`,
      flags: [],
    };
  }

  const comp = checkCompensation(post, config);
  if (comp.rejected) {
    return { skip: true, status: STATUS.REJECTED, reason: comp.reason, flags: comp.flags };
  }

  return { skip: false, status: null, reason: null, flags: comp.flags };
}

/**
 * Splits a batch into what needs classifying and what does not. The rejected side
 * carries a real reason, so the Posts tab reads the same whether a row was rejected
 * here or after a model call.
 */
export function prefilter(posts, config) {
  const keep = [];
  const rejected = [];

  for (const post of posts) {
    const verdict = prefilterPost(post, config);
    if (verdict.skip) rejected.push({ post, ...verdict });
    else keep.push(post);
  }

  const saved = posts.length ? Math.round((rejected.length / posts.length) * 100) : 0;
  log.info('prefilter complete', {
    total: posts.length, classifying: keep.length, rejected: rejected.length, calls_saved_pct: saved,
  });

  return { keep, rejected };
}

/** Cell patches for the rows the pre-filter rejected. */
export function prefilterPatches(rejected, runIdValue) {
  return rejected.map(({ post, reason, flags }) => ({
    row: post._row,
    patch: {
      signal_type: '',
      fit_score: 0,
      fit_reasons: 'rejected before classification, no model call spent',
      hard_out_reason: reason,
      status: STATUS.REJECTED,
      last_classified_run: runIdValue,
      comp_flags: (flags ?? []).join('; '),
    },
  }));
}

export { COMP_FLAG };
