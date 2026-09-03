import { createHash } from 'node:crypto';

export const sha256 = (input) => createHash('sha256').update(input, 'utf8').digest('hex');

/**
 * Strips tracking params, fragments, trailing slashes and case so the same posting
 * reached by two different links produces one post_id.
 */
export function canonicalUrl(rawUrl) {
  if (!rawUrl) return '';
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return String(rawUrl).trim().toLowerCase();
  }
  url.hash = '';
  const drop = [];
  for (const key of url.searchParams.keys()) {
    // Conservative on purpose: stripping a param that is actually part of a job's
    // identity would collapse two different postings into one post_id.
    if (/^(utm_|ref$|refId$|trackingId$|trk$|source$|src$|fbclid$|gclid$|position$|pageNum$|from$|tk$|alid$|advn$|xpse$|xkcb$|sjdu$|rq$|origin$|eventSource$|savedJobId$|seen$)/i.test(key)) drop.push(key);
  }
  for (const key of drop) url.searchParams.delete(key);
  url.searchParams.sort();
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

export const postId = (source, url) => sha256(`${source}:${canonicalUrl(url)}`);

const normalizeText = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Identifies the same job cross-posted to two boards. Company is included because
 * generic titles ("Operations Manager") collide constantly across employers.
 */
export function dupeHash({ title, company, description }) {
  return sha256([
    normalizeText(title),
    normalizeText(company),
    normalizeText(description).slice(0, 500),
  ].join('|'));
}

export function runId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
