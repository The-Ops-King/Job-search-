import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { MODELS, CostMeter, assertUsable } from '../providers/anthropic.js';
import { pool } from '../lib/retry.js';
import { TRACK, CHANNEL } from '../sheets/schema.js';
import { log } from '../lib/log.js';

export const DraftSchema = z.object({
  subject: z.string().describe('Under 60 characters. Plain and specific. No colons used as a marketing hook, no title case, no question mark unless it is a real question.'),
  body: z.string().describe('Under 150 words. Plain text only. No markdown, no bullet points, no signature block beyond the name.'),
});

/**
 * Written to defeat the tells that mark a message as machine-written. The rules are
 * negative on purpose: the failure mode is not bad grammar, it is fluent, evenly
 * paced, upbeat copy that reads like every other automated pitch in the inbox.
 */
const STYLE = `HOW TO WRITE

Write the way a competent person writes when they are busy and want a reply.

Hard rules:
- No em dashes or en dashes. Use a period, a comma, or restructure the sentence.
- Straight quotes only.
- No markdown, no bold, no bullet points, no emoji.
- Under 150 words in the body.
- Never name a past client or company he has worked with. He has not cleared that.
- Never invent a metric, a result, a timeline, or a credential. Everything you claim
  must be traceable to the rubric.

Do not write these:
- Flattery or warm-up. Not "I was excited to see", not "love what you're building",
  not "Great posting".
- Groups of three. "Faster, cleaner, and more reliable" is a tell. Two things, or one.
- "Not just X, it's Y" and any other negative parallelism.
- Sentence-tail participles that add nothing: "streamlining your process", "ensuring
  smooth handoffs", "helping your team scale".
- Consultant vocabulary: leverage, streamline, robust, seamless, holistic, elevate,
  empower, unlock, drive, spearhead, synergy, best-in-class, cutting-edge, landscape,
  testament, showcase, delve.
- Announcing what you are about to do. "Here's what I'd do" then doing it. Just do it.
- A closing line that restates the pitch or looks forward to hearing back.
- Hedging stacks: "might potentially be able to help".

Do write like this:
- Vary sentence length. A long sentence that does real work, then a short one.
- Name one concrete thing from the posting. Not the job title. Something in the body
  of the post that shows it was actually read.
- Say what he would build, in the specific nouns of the work: a round-robin, a
  speed-to-lead trigger, a disposition set, a commission sheet, a scorecard.
- One ask. A question they can answer in a sentence, or a request for a short call.
- Sign off with just his first name.`;

const APPLICATION_TEMPLATE = `TRACK: application

They posted work he can do. He is responding as the person who would do it.

Structure, loosely: what in the posting he is responding to, what he would build,
the ask. Include the resume link once, inline, as a plain URL.

He is not begging for the job and he is not selling hard. He is a specialist saying
this is in his lane and here is the specific thing he would do first.`;

const PITCH_TEMPLATE = `TRACK: pitch

They are hiring closers, setters or reps. He is not applying to that role and must
not appear to be.

The logic to convey, without spelling it out mechanically: they are adding sales
headcount, the operational problems that follow are predictable, and he builds that
layer. Name the specific thing that tends to break when a team of that shape grows.
Lead routing that stops being fair. Speed to lead falling apart past a certain volume.
Nobody knowing which setter actually sourced a closed deal. Commission math done by
hand. Pick the one this posting actually implies.

Do not claim to know their situation. Do not open with a rhetorical question about
their pain. State the pattern, say what he builds, ask one question.`;

const CHANNEL_NOTE = {
  [CHANNEL.EMAIL]: 'This will be sent as an email. The subject line is a real subject line.',
  [CHANNEL.MANUAL_DM]: 'This will be pasted into a direct message. Keep the subject as a short internal label; the body must stand alone without one.',
  [CHANNEL.MANUAL_APPLY]: 'This will be pasted into an application or Upwork proposal box. The subject is an internal label only. The body must open as a proposal, not as an email, and must not begin with a greeting that names a person, because the client name is unknown.',
};

export function buildDraftSystemPrompt(profileText) {
  return `${profileText.trim()}\n\n---\n\n${STYLE}`;
}

export function buildDraftUserMessage({ post, lead, track, channel }) {
  const money = post.comp_type && post.comp_type !== 'unknown'
    ? `${post.comp_type} ${post.comp_min ?? '?'} to ${post.comp_max ?? '?'}`
    : 'not stated';

  return [
    track === TRACK.PITCH ? PITCH_TEMPLATE : APPLICATION_TEMPLATE,
    '',
    CHANNEL_NOTE[channel] ?? CHANNEL_NOTE[CHANNEL.MANUAL_APPLY],
    '',
    'His resume: https://jtylerray.com/resume',
    lead?.contact_name ? `Recipient: ${lead.contact_name}${lead.contact_role ? `, ${lead.contact_role}` : ''}` : 'Recipient name: unknown. Do not invent one.',
    '',
    'THE POSTING',
    `Source: ${post.source}`,
    `Title: ${post.title}`,
    `Company: ${post.company ?? 'not stated'}`,
    `Compensation: ${money}`,
    post.niche ? `Niche: ${post.niche}` : '',
    post.tools_mentioned ? `Tools named in the posting: ${post.tools_mentioned}` : '',
    '',
    String(post.description ?? '').slice(0, 12000),
  ].filter(Boolean).join('\n');
}

export async function draftOne(client, { post, lead, track, channel, profileText, meter }) {
  const message = await client.messages.parse({
    model: MODELS.draft,
    max_tokens: 4000,
    system: buildDraftSystemPrompt(profileText),
    messages: [{ role: 'user', content: buildDraftUserMessage({ post, lead, track, channel }) }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: zodOutputFormat(DraftSchema) },
  });

  assertUsable(message);
  meter?.record(MODELS.draft, message.usage);
  if (!message.parsed_output) throw new Error('Draft returned no parsable output');

  return sanitize(message.parsed_output);
}

/**
 * Last line of defence for the two tells a prompt cannot fully suppress. Dashes are
 * rewritten rather than reported because the fix is unambiguous.
 */
export function sanitize({ subject, body }) {
  const clean = (text) => String(text ?? '')
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/[—–]/g, ', ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return { subject: clean(subject).slice(0, 200), body: clean(body) };
}

export function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

export async function draftAll(client, items, profileText, { concurrency = 3, meter = new CostMeter() } = {}) {
  const drafts = new Map();
  const failures = [];

  const settled = await pool(items, concurrency, (item) => draftOne(client, { ...item, profileText, meter }));

  settled.forEach((outcome, index) => {
    const item = items[index];
    if (outcome.ok) drafts.set(item.post.post_id, outcome.value);
    else failures.push({ post_id: item.post.post_id, title: item.post.title, message: outcome.error.message });
  });

  const long = [...drafts.entries()].filter(([, d]) => wordCount(d.body) > 170);
  if (long.length) log.warn('drafts over the length target', { count: long.length });

  log.info('drafting complete', { total: items.length, ok: drafts.size, failed: failures.length, cost_usd: meter.total });
  return { drafts, failures, meter };
}
