import { getProvider, guessDomain } from '../providers/enrichment/index.js';
import { verifyEmail } from '../providers/debounce.js';
import { EMAIL_STATUS, CHANNEL } from '../sheets/schema.js';
import { log } from '../lib/log.js';

/**
 * Contact lookup for gated leads only.
 *
 * Upwork hides client identity entirely, so Upwork leads have no name, no company
 * and no domain to look up. They resolve to a manual channel by design, not by
 * failure. LinkedIn and Indeed postings usually name a company but rarely a person,
 * so a hit rate well under half is the expected outcome, not a bug.
 *
 * Every lead gets a draft either way. The channel decides who sends it.
 */
export function decideChannel({ email, emailStatus, dmUrl }) {
  const sendable = email && (emailStatus === EMAIL_STATUS.VERIFIED || emailStatus === EMAIL_STATUS.FOUND);
  if (sendable) return CHANNEL.EMAIL;
  if (dmUrl) return CHANNEL.MANUAL_DM;
  return CHANNEL.MANUAL_APPLY;
}

export async function enrichLeads(leads, { config, meter, existingLeads = new Map() } = {}) {
  const provider = getProvider();
  const cap = Number(config?.max_enrichments_per_run ?? 25);
  const enriched = [];
  const failures = [];
  let lookups = 0;

  for (const lead of leads) {
    const prior = existingLeads.get(lead.post_id);

    // Idempotent: a lead already carrying an email is never looked up twice, so a
    // rerun costs nothing and a manual correction in the sheet survives.
    if (prior?.email) {
      enriched.push({
        ...lead,
        contact_name: prior.contact_name || lead.contact_name,
        contact_role: prior.contact_role || lead.contact_role,
        company_domain: prior.company_domain || lead.company_domain,
        email: prior.email,
        email_status: prior.email_status || EMAIL_STATUS.FOUND,
        enrichment_provider: prior.enrichment_provider || provider.name,
        enrichment_cost: 0,
        channel: decideChannel({ email: prior.email, emailStatus: prior.email_status, dmUrl: lead.dm_url }),
        skipped: 'already enriched',
      });
      continue;
    }

    const domain = lead.company_domain || guessDomain(lead.company);

    if (!lead.company && !domain && !lead.dm_url) {
      enriched.push({
        ...lead,
        company_domain: null,
        email: null,
        email_status: EMAIL_STATUS.NOT_FOUND,
        enrichment_provider: provider.name,
        enrichment_cost: 0,
        channel: CHANNEL.MANUAL_APPLY,
        skipped: 'no company, domain or profile to look up',
      });
      continue;
    }

    if (lookups >= cap) {
      enriched.push({
        ...lead,
        company_domain: domain,
        email: null,
        email_status: EMAIL_STATUS.PENDING,
        enrichment_provider: provider.name,
        enrichment_cost: 0,
        channel: decideChannel({ email: null, dmUrl: lead.dm_url }),
        skipped: `enrichment cap of ${cap} reached this run`,
      });
      continue;
    }

    try {
      lookups += 1;
      const found = await provider.findEmail({
        name: lead.contact_name || null,
        company: lead.company || null,
        domain,
        profileUrl: lead.dm_url || null,
      });
      meter?.addExternal(`enrichment:${provider.name}`, found.cost ?? 0);

      let status = found.email ? EMAIL_STATUS.FOUND : EMAIL_STATUS.NOT_FOUND;
      if (found.email) {
        const verification = await verifyEmail(found.email);
        status = verification.status;
      }

      enriched.push({
        ...lead,
        company_domain: domain,
        email: found.email,
        email_status: status,
        enrichment_provider: provider.name,
        enrichment_cost: Number(found.cost ?? 0),
        // An address Debounce calls invalid is never sent to, no matter what the
        // vendor's own confidence said.
        channel: status === EMAIL_STATUS.INVALID
          ? decideChannel({ email: null, dmUrl: lead.dm_url })
          : decideChannel({ email: found.email, emailStatus: status, dmUrl: lead.dm_url }),
      });
    } catch (error) {
      failures.push({ post_id: lead.post_id, message: error.message });
      enriched.push({
        ...lead,
        company_domain: domain,
        email: null,
        email_status: EMAIL_STATUS.NOT_FOUND,
        enrichment_provider: provider.name,
        enrichment_cost: 0,
        channel: decideChannel({ email: null, dmUrl: lead.dm_url }),
      });
    }
  }

  log.info('enrichment complete', {
    leads: leads.length,
    lookups,
    with_email: enriched.filter((l) => l.email).length,
    provider: provider.name,
    failed: failures.length,
  });

  return { enriched, failures, lookups, provider: provider.name };
}
