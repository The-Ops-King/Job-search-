/**
 * Single source of truth for every tab and column. Headers are the contract:
 * setup-sheet.js writes them, client.js resolves column positions from them at
 * runtime, and no other module may reference a column by index.
 */

export const STATUS = {
  PENDING: 'pending',
  REJECTED: 'rejected',
  LEAD: 'lead',
  DUPLICATE: 'duplicate',
};

export const EMAIL_STATUS = {
  PENDING: 'pending',
  FOUND: 'found',
  NOT_FOUND: 'not_found',
  VERIFIED: 'verified',
  INVALID: 'invalid',
};

export const TRACK = { APPLICATION: 'application', PITCH: 'pitch' };

export const CHANNEL = { EMAIL: 'email', MANUAL_DM: 'manual_dm', MANUAL_APPLY: 'manual_apply' };

export const TABS = {
  Posts: {
    key: 'post_id',
    headers: [
      'post_id', 'source', 'url', 'title', 'company', 'posted_at',
      'comp_type', 'comp_min', 'comp_max', 'est_hours', 'first_seen_run',
      'signal_type', 'fit_score', 'fit_reasons', 'hard_out_reason', 'niche',
      'tools_mentioned', 'status',
      // Beyond the spec, and load-bearing:
      // dupe_hash persists the near-duplicate key so cross-posts are caught across
      // runs, not just within one. last_classified_run lets replay.js tell a stale
      // classification from a fresh one. comp_flags carries comp_unknown without
      // polluting fit_reasons.
      'dupe_hash', 'last_classified_run', 'comp_flags',
    ],
    numeric: ['comp_min', 'comp_max', 'est_hours', 'fit_score'],
  },

  // Posts stays readable; the payload replay needs lives here. Without it,
  // replay.js cannot re-classify without re-scraping.
  PostsRaw: {
    key: 'post_id',
    headers: ['post_id', 'description', 'raw', 'captured_at'],
  },

  Leads: {
    key: 'post_id',
    headers: [
      'post_id', 'title', 'company', 'contact_name', 'contact_role',
      'company_domain', 'email', 'email_status', 'enrichment_provider',
      'enrichment_cost', 'dm_url', 'track', 'created_run',
    ],
    numeric: ['enrichment_cost'],
  },

  Outreach: {
    key: 'post_id',
    headers: [
      'post_id', 'track', 'channel', 'to_email', 'subject', 'body',
      'APPROVE', 'sent_at', 'message_id', 'error',
    ],
    checkbox: ['APPROVE'],
  },

  Runs: {
    key: 'run_id',
    headers: [
      'run_id', 'started_at', 'finished_at', 'upwork_count', 'linkedin_count',
      'indeed_count', 'classified', 'gated', 'enriched', 'drafted', 'sent',
      'api_cost_estimate', 'errors',
    ],
    numeric: [
      'upwork_count', 'linkedin_count', 'indeed_count', 'classified',
      'gated', 'enriched', 'drafted', 'sent', 'api_cost_estimate',
    ],
  },

  Config: {
    key: 'key',
    headers: ['key', 'value', 'notes'],
  },
};

export const TAB_NAMES = Object.keys(TABS);

/**
 * Seeded into the Config tab so every knob is visible and editable without a deploy.
 * Values here override config/scoring.json at runtime.
 */
export const CONFIG_SEED = [
  ['pause', 'FALSE', 'TRUE stops sending. Everything else still runs.'],
  ['fit_score_gate', '7', 'Minimum fit_score to become a lead.'],
  ['salary_floor_annual', '120000', 'Reject salaried roles whose top-of-range is below this.'],
  ['hourly_floor', '100', 'Reject hourly work below this rate.'],
  ['fixed_price_hourly_floor', '100', 'Fixed-price: reject when budget/est_hours falls below this.'],
  ['max_sends_per_day', '15', 'Hard cap on emails sent per run.'],
  ['max_enrichments_per_run', '25', 'Hard cap on enrichment lookups per run.'],
  ['max_daily_cost', '12.00', 'USD. Run stops before enrichment if the estimate exceeds this. On the Claude Code backend this is quota-equivalent, not a bill.'],
  ['prefilter_enabled', 'TRUE', 'FALSE sends every post to the model. Use to prove the pre-filter is not dropping something.'],
  ['lookback_days', '2', 'How far back to search. First run uses first_run_lookback_days.'],
  ['first_run_lookback_days', '14', 'Used only when the Posts tab is empty.'],
  ['max_items_per_query', '50', 'Per query, per source, per run.'],
  ['running', 'FALSE', 'Mutex. Set by the pipeline; clear it by hand only if a run died.'],
  ['running_since', '', 'ISO timestamp the mutex was taken. Considered stale after 30 minutes.'],
  ['running_by', '', 'run_id holding the mutex.'],
];

export function headersFor(tab) {
  const spec = TABS[tab];
  if (!spec) throw new Error(`Unknown tab: ${tab}`);
  return spec.headers;
}

export function emptyRow(tab) {
  return Object.fromEntries(headersFor(tab).map((h) => [h, '']));
}
