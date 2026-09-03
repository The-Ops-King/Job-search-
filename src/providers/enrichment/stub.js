/**
 * The no-vendor default. Returns no email so the pipeline runs end to end and every
 * lead falls through to a manual channel with a draft already written. This is not a
 * placeholder to be replaced quietly: until ENRICHMENT_PROVIDER names a real vendor,
 * zero emails are eligible to send, which is the correct behaviour.
 */
export const displayName = 'stub';

export async function findEmail({ name, company, domain, profileUrl } = {}) {
  return {
    email: null,
    confidence: null,
    cost: 0,
    raw: { provider: 'stub', queried: { name, company, domain, profileUrl } },
  };
}
