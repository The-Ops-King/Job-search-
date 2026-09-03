import * as stub from './stub.js';

/**
 * The contract every enrichment vendor must satisfy.
 *
 *   findEmail({ name, company, domain, profileUrl })
 *     -> { email: string|null, confidence: number|null, cost: number, raw: object }
 *
 * Adding a vendor is one new file in this directory plus ENRICHMENT_PROVIDER.
 * Nothing else in the pipeline changes. Vendor choice is Tyler's, not the code's.
 */

const PROVIDERS = { stub };

export function getProvider(name = process.env.ENRICHMENT_PROVIDER || 'stub') {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(
      `Unknown ENRICHMENT_PROVIDER "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}. ` +
      `Add src/providers/enrichment/${name}.js exporting findEmail() and register it here.`);
  }
  if (typeof provider.findEmail !== 'function') {
    throw new Error(`Enrichment provider "${name}" does not export findEmail()`);
  }
  return { name, ...provider };
}

/** Best-effort company domain from a company name, when the vendor needs one. */
export function guessDomain(company) {
  if (!company) return null;
  const slug = String(company)
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|co|corp|company|group|agency|media|consulting|solutions)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
  return slug.length >= 3 ? `${slug}.com` : null;
}
