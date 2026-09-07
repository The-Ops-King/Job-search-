import { postId, dupeHash, canonicalUrl } from '../lib/hash.js';
import { log } from '../lib/log.js';

/**
 * Turns raw actor output into the canonical Post shape using the field mappings in
 * config/actors.json. Nothing here knows any actor's field names: change the actor,
 * change the config. When a mapping stops resolving a required field, this throws
 * rather than writing rows with holes in them.
 */

export class SchemaDriftError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'SchemaDriftError';
    this.details = details;
  }
}

/** Resolves "a.b[0].c" against an object. Returns undefined on any miss. */
export function getPath(obj, path) {
  if (!path) return undefined;
  let current = obj;
  for (const segment of String(path).split('.')) {
    const match = /^([^[]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    const [, key, indexes] = match;
    if (key) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[key];
    }
    for (const idx of indexes.match(/\d+/g) ?? []) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(idx)];
    }
  }
  return current;
}

const isEmpty = (v) =>
  v === undefined || v === null || v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'number' && Number.isNaN(v));

/** First candidate path that yields a non-empty value. */
export function pick(item, paths = []) {
  for (const path of paths) {
    const value = getPath(item, path);
    if (!isEmpty(value)) return { value, path };
  }
  return { value: undefined, path: null };
}

// --- compensation -------------------------------------------------------

const PERIOD_PATTERNS = [
  [/\b(?:per\s+hour|an?\s+hour|hourly|\/\s*hr\b|\/\s*hour\b|p\/h\b|hr\b)/i, 'hour'],
  [/\b(?:per\s+year|a\s+year|annually|annual|yearly|\/\s*yr\b|\/\s*year\b|per\s+annum|p\.?a\.?\b)/i, 'year'],
  [/\b(?:per\s+month|a\s+month|monthly|\/\s*mo\b|\/\s*month\b)/i, 'month'],
  [/\b(?:per\s+week|a\s+week|weekly|\/\s*wk\b|\/\s*week\b)/i, 'week'],
  [/\b(?:per\s+day|a\s+day|daily|\/\s*day\b)/i, 'day'],
];

export const ANNUALIZE = { year: 1, month: 12, week: 52, day: 260 };

/**
 * Parses the free-text compensation strings job boards emit:
 * "$120,000 - $150,000 a year", "$60.00/hr", "Up to $150K", "From $90,000", "$5,000".
 * Returns null when the string carries no money at all, so callers can tell
 * "no compensation stated" apart from "compensation stated as zero".
 */
export function parseCompensation(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).trim();
  if (!text) return null;

  let period = null;
  for (const [pattern, name] of PERIOD_PATTERNS) {
    if (pattern.test(text)) { period = name; break; }
  }

  const hasCurrency = /[$£€]/.test(text);
  if (!hasCurrency && !period) return null;

  const amounts = [];
  const numberPattern = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kK])?/g;
  let match;
  while ((match = numberPattern.exec(text)) !== null) {
    let value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    if (match[2]) value *= 1000;
    // A bare "2" in "2 years experience" is not pay. Require a plausible floor
    // unless the string is explicitly hourly.
    if (value < 15 && period !== 'hour') continue;
    amounts.push(value);
  }
  if (!amounts.length) return null;

  amounts.sort((a, b) => a - b);
  const lowest = amounts[0];
  const highest = amounts[amounts.length - 1];

  if (amounts.length === 1) {
    if (/\b(?:up\s+to|max(?:imum)?|as\s+much\s+as|under)\b/i.test(text)) {
      return { min: null, max: lowest, period };
    }
    if (/\b(?:from|starting(?:\s+at)?|min(?:imum)?|at\s+least|\+)\b/i.test(text) || /\d\s*\+/.test(text)) {
      return { min: lowest, max: null, period };
    }
    return { min: lowest, max: lowest, period };
  }

  return { min: lowest, max: highest, period };
}

/**
 * Collapses explicit numeric fields, free text and the actor's own type label into
 * comp_type / comp_min / comp_max. Salaried pay is annualized so a single floor
 * comparison works regardless of how the board quoted it.
 */
export function resolveCompensation({ typeRaw, min, max, text, defaultType = 'unknown' }) {
  const parsed = parseCompensation(text);
  const numeric = (v) => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  let low = numeric(min) ?? parsed?.min ?? null;
  let high = numeric(max) ?? parsed?.max ?? null;
  if (low !== null && high !== null && low > high) [low, high] = [high, low];

  const label = String(typeRaw ?? '').toLowerCase();
  let type;
  if (/hourly|hour|per[-_\s]?hour/.test(label)) type = 'hourly';
  else if (/fixed|budget|project|milestone|contract\s*value/.test(label)) type = 'fixed';
  else if (/salary|salaried|annual|full[-\s]?time/.test(label)) type = 'salary';
  else if (parsed?.period === 'hour') type = 'hourly';
  else if (parsed?.period && ANNUALIZE[parsed.period]) type = 'salary';
  else if (low === null && high === null) type = 'unknown';
  else type = defaultType;

  if (type === 'salary' && parsed?.period && ANNUALIZE[parsed.period] > 1) {
    const factor = ANNUALIZE[parsed.period];
    if (low !== null) low *= factor;
    if (high !== null) high *= factor;
  }

  if (low === null && high === null) type = 'unknown';
  return { comp_type: type, comp_min: low, comp_max: high };
}

// --- dates --------------------------------------------------------------

const RELATIVE = /^(?:posted\s+)?(?:(\d+)\+?\s*(minute|min|hour|hr|day|week|month)s?\s+ago|(just\s+posted|today|new|active\s+today)|(yesterday))/i;

/** Handles ISO strings, epoch seconds, epoch milliseconds and "3 days ago". */
export function parsePostedAt(value, now = new Date()) {
  if (isEmpty(value)) return null;

  if (typeof value === 'number' || /^\d{9,13}$/.test(String(value).trim())) {
    const n = Number(value);
    const ms = String(Math.trunc(n)).length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const text = String(value).trim();
  const rel = RELATIVE.exec(text);
  if (rel) {
    if (rel[3]) return now.toISOString();
    if (rel[4]) return new Date(now.getTime() - 86400000).toISOString();
    const amount = Number(rel[1]);
    const unitMs = {
      minute: 60000, min: 60000, hour: 3600000, hr: 3600000,
      day: 86400000, week: 604800000, month: 2592000000,
    }[rel[2].toLowerCase()];
    return new Date(now.getTime() - amount * unitMs).toISOString();
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

const TRUTHY_REMOTE = /^(true|yes|remote|fully[-\s]?remote|work[-\s]?from[-\s]?home|wfh|1)$/i;
const FALSY_REMOTE = /^(false|no|on[-\s]?site|onsite|in[-\s]?office|hybrid|0)$/i;

export function parseRemote(value, fallback = null) {
  if (typeof value === 'boolean') return value;
  if (isEmpty(value)) return fallback;
  const text = String(value).trim();
  if (TRUTHY_REMOTE.test(text)) return true;
  if (FALSY_REMOTE.test(text)) return false;
  if (/remote/i.test(text) && !/hybrid/i.test(text)) return true;
  if (/hybrid|on[-\s]?site/i.test(text)) return false;
  return fallback;
}

// --- the mapper ---------------------------------------------------------

const RAW_CELL_LIMIT = 44000;

export function normalizeItem(item, { source, actorConfig, now = new Date() }) {
  const map = actorConfig.map ?? {};
  const defaults = actorConfig.defaults ?? {};
  const hits = {};
  const values = {};
  const read = (field) => {
    const { value, path } = pick(item, map[field] ?? []);
    hits[field] = path;
    values[field] = value;
    return value;
  };

  const required = actorConfig.required ?? [];
  for (const field of required) read(field);
  const missing = required.filter((field) => isEmpty(values[field]));
  if (missing.length) return { post: null, missing, hits };

  // An expired posting is a wasted classification call and a dead lead. Indeed
  // flags them explicitly, so drop them here rather than paying to score them.
  const expired = read('expired');
  if (expired === true || /^(true|yes|expired)$/i.test(String(expired ?? ''))) {
    return { post: null, missing: [], hits, expired: true };
  }

  const url = values.url ?? read('url');
  const title = values.title ?? read('title');
  const description = values.description ?? read('description');
  const company = read('company');

  const comp = resolveCompensation({
    typeRaw: read('comp_type_raw'),
    min: read('comp_min'),
    max: read('comp_max'),
    text: read('comp_text'),
    defaultType: defaults.comp_type ?? 'unknown',
  });

  const estHoursRaw = read('est_hours');
  const estHours = Number(String(estHoursRaw ?? '').replace(/[^0-9.]/g, ''));

  const rawJson = JSON.stringify(item);
  const post = {
    post_id: postId(source, url),
    source,
    url: canonicalUrl(url),
    title: String(title).trim(),
    company: isEmpty(company) ? null : String(company).trim(),
    poster_name: (() => { const v = read('poster_name'); return isEmpty(v) ? null : String(v).trim(); })(),
    description: String(description).trim(),
    posted_at: parsePostedAt(read('posted_at'), now),
    comp_type: comp.comp_type,
    comp_min: comp.comp_min,
    comp_max: comp.comp_max,
    est_hours: Number.isFinite(estHours) && estHours > 0 ? estHours : null,
    location: (() => { const v = read('location'); return isEmpty(v) ? null : String(v).trim(); })(),
    remote: parseRemote(read('remote'), defaults.remote ?? null),
    raw: rawJson.length > RAW_CELL_LIMIT ? `${rawJson.slice(0, RAW_CELL_LIMIT)}...[truncated]` : rawJson,
  };
  post.dupe_hash = dupeHash(post);

  return { post, missing: [], hits };
}

/**
 * Normalizes a whole actor batch. Throws SchemaDriftError when the mapping stops
 * working, so a broken actor surfaces as a named failed source in the Runs row and
 * the digest instead of a quietly short day.
 *
 * `driftTolerance` is the share of items allowed to miss a required field before the
 * whole batch is rejected, and it only applies to batches of ten or more. In smaller
 * batches a single bad listing would blow past any percentage, so there only a batch
 * where every item fails counts as drift.
 */
export function normalizeAll(items, { source, actorConfig, now = new Date(), driftTolerance = 0.2 } = {}) {
  const posts = [];
  const failures = [];
  const fieldHits = {};

  let expiredCount = 0;
  for (const item of items) {
    const result = normalizeItem(item, { source, actorConfig, now });
    const { post, missing, hits } = result;
    for (const [field, path] of Object.entries(hits)) {
      fieldHits[field] ??= { hit: 0, total: 0, paths: new Set() };
      fieldHits[field].total += 1;
      if (path) { fieldHits[field].hit += 1; fieldHits[field].paths.add(path); }
    }
    if (post) posts.push(post);
    else if (result.expired) expiredCount += 1;
    else failures.push({ missing, sample: Object.keys(item ?? {}).slice(0, 25) });
  }

  const inventory = Object.fromEntries(
    Object.entries(fieldHits).map(([field, s]) => [
      field,
      { hit_rate: s.total ? Number((s.hit / s.total).toFixed(2)) : 0, paths: [...s.paths] },
    ]));

  const warnings = [];
  if (items.length && posts.length && (inventory.posted_at?.hit_rate ?? 0) === 0) {
    warnings.push(
      `${source}: posted_at never resolved (${JSON.stringify(actorConfig.map?.posted_at ?? [])}). ` +
      `Freshness filtering is off for this source until the mapping is fixed.`);
  }

  if (expiredCount) warnings.push(`${source}: skipped ${expiredCount} expired postings.`);

  // Expired items are a correct outcome, not drift, so they are excluded from the
  // miss rate that decides whether the actor's schema has changed.
  const considered = Math.max(0, items.length - expiredCount);
  const missRate = considered ? failures.length / considered : 0;
  // A proportion only means something with a sample behind it. Below ten items only
  // total failure counts as drift, so a single malformed listing in a thin result set
  // does not take the source down.
  const totalDrift = considered > 0 && failures.length === considered;
  const proportionalDrift = considered >= 10 && missRate > driftTolerance;
  if (totalDrift || proportionalDrift) {
    const fields = [...new Set(failures.flatMap((f) => f.missing))];
    throw new SchemaDriftError(
      `${source}: ${failures.length}/${items.length} items were missing required field(s) ` +
      `[${fields.join(', ')}]. The actor's output shape has probably changed. ` +
      `Run "npm run probe-actor -- ${source}" and fix "map" in config/actors.json. ` +
      `Keys seen on a sample item: ${(failures[0]?.sample ?? []).join(', ')}`,
      { source, inventory, failures: failures.slice(0, 3) });
  }

  if (failures.length) {
    warnings.push(`${source}: dropped ${failures.length} of ${items.length} items missing required fields.`);
  }
  for (const w of warnings) log.warn(w, { source });

  return { posts, warnings, inventory, dropped: failures.length, expired: expiredCount };
}

/**
 * Drops stale postings. A post with no resolvable date is kept: over-including is
 * cheap because dedupe catches repeats, while silently dropping is not recoverable.
 */
export function filterByRecency(posts, days, now = new Date()) {
  if (!Number.isFinite(days) || days <= 0) return { kept: posts, dropped: 0 };
  const cutoff = now.getTime() - days * 86400000;
  const kept = posts.filter((p) => !p.posted_at || Date.parse(p.posted_at) >= cutoff);
  return { kept, dropped: posts.length - kept.length };
}
