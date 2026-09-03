import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { MODELS, CostMeter, assertUsable } from '../providers/anthropic.js';
import { pool } from '../lib/retry.js';
import { log } from '../lib/log.js';

/**
 * One call per new post. The rubric in config/profile.md is passed verbatim as the
 * system prompt so the model scores against intent rather than keyword overlap.
 *
 * The output schema is enforced by the API, not by prompting. Sampling parameters
 * were removed from current models, so determinism comes from the schema plus a
 * fixed prompt rather than from temperature.
 */

export const HARD_OUTS = [
  'salesforce_required', 'revops_title', 'closer_role', 'trainer_role',
  'vp_sales', 'onsite', 'large_team', 'other',
];

export const ClassificationSchema = z.object({
  signal_type: z.enum(['direct_role', 'scaling_signal', 'noise'])
    .describe('direct_role: the posting is work he could be hired to do. scaling_signal: the posting is a company hiring closers or setters, i.e. a company about to have an ops problem. noise: neither.'),
  hard_out: z.enum(HARD_OUTS).nullable()
    .describe('Set when the posting matches a WON\'T DO item in the rubric, otherwise null.'),
  hard_out_reason: z.string().nullable()
    .describe('One sentence quoting or paraphrasing the specific text that triggered the hard_out. Null when hard_out is null.'),
  niche: z.string().describe('The industry or business model, in a few words. "unknown" if the posting does not say.'),
  tools_mentioned: z.array(z.string()).describe('Named software in the posting. Empty array if none.'),
  team_size_hint: z.number().nullable().describe('Number of people managed or on the team, if stated. Null otherwise.'),
  remote_confirmed: z.boolean().nullable().describe('True if explicitly remote, false if onsite or hybrid, null if unstated.'),
  capability_match: z.number().min(0).max(10).describe('0-10. Can he do the work described, judged against WHAT HE BUILDS and TOOLS CLAIMED.'),
  ownership_match: z.number().min(0).max(10).describe('0-10. Is this the kind of company and owner he fits, judged against STRONGEST FIT. Small, founder-led, GHL/HubSpot stack scores high; enterprise scores low.'),
  reasons: z.array(z.string()).describe('Two to four short factual sentences explaining both scores. No flattery, no hedging.'),
});

const INSTRUCTIONS = `You are scoring one job posting against the capability rubric above.

Score against intent, not keywords. A posting that never says "sales operations" but
describes building CRM pipelines and automations for a coaching company is a strong
capability match. A posting that says "sales operations" twenty times but requires
five years of Salesforce administration is a hard out.

capability_match asks one question: could he do the work described? Judge it against
WHAT HE BUILDS and TOOLS CLAIMED. Unfamiliar tools that resemble ones he uses cost a
little. Tools under TOOLS NOT CLAIMED cost a lot.

ownership_match asks a different question: is this the kind of company he fits?
A founder-led coaching business on GoHighLevel scores high. A 400-person company with
an established RevOps team scores low even when the tasks look similar.

Set hard_out only for a rubric WON'T DO item that the posting actually states. Do not
infer a hard out from a job title alone when the body of the posting contradicts it.

For scaling_signal: the posting is a company hiring closers, setters or sales reps.
He is not applying to that role. The signal is that the company is scaling a sales
team and will shortly need the systems underneath it.

Be blunt in reasons. State what the posting says and what it means for fit. Do not
soften a bad match and do not inflate a good one.`;

export function buildSystemPrompt(profileText) {
  return `${profileText.trim()}\n\n---\n\n${INSTRUCTIONS}`;
}

export function buildUserMessage(post) {
  const money = [post.comp_type, post.comp_min, post.comp_max].some(Boolean)
    ? `${post.comp_type}: ${post.comp_min ?? '?'} to ${post.comp_max ?? '?'}${post.est_hours ? ` over ~${post.est_hours}h` : ''}`
    : 'not stated';

  return [
    `SOURCE: ${post.source}`,
    `TITLE: ${post.title}`,
    `COMPANY: ${post.company ?? 'not stated (Upwork hides client identity)'}`,
    `LOCATION: ${post.location ?? 'not stated'}`,
    `REMOTE FLAG FROM BOARD: ${post.remote === null ? 'unknown' : post.remote}`,
    `COMPENSATION: ${money}`,
    `POSTED: ${post.posted_at ?? 'unknown'}`,
    '',
    'DESCRIPTION:',
    String(post.description ?? '').slice(0, 20000),
  ].join('\n');
}

export async function classifyPost(client, post, profileText, meter) {
  const message = await client.messages.parse({
    model: MODELS.classify,
    max_tokens: 4000,
    system: buildSystemPrompt(profileText),
    messages: [{ role: 'user', content: buildUserMessage(post) }],
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: zodOutputFormat(ClassificationSchema),
    },
  });

  assertUsable(message);
  meter?.record(MODELS.classify, message.usage);

  if (!message.parsed_output) throw new Error('Classifier returned no parsable output');
  return message.parsed_output;
}

/**
 * Classifies a batch with bounded concurrency. Never throws: a post that fails stays
 * status=pending so the next run retries it, and the failure is reported.
 */
export async function classifyAll(client, posts, profileText, { concurrency = 5, meter = new CostMeter() } = {}) {
  const results = new Map();
  const failures = [];

  const settled = await pool(posts, concurrency, (post) => classifyPost(client, post, profileText, meter));

  settled.forEach((outcome, index) => {
    const post = posts[index];
    if (outcome.ok) results.set(post.post_id, outcome.value);
    else failures.push({ post_id: post.post_id, title: post.title, message: outcome.error.message });
  });

  log.info('classification complete', {
    total: posts.length, ok: results.size, failed: failures.length, cost_usd: meter.total,
  });

  return { results, failures, meter };
}
