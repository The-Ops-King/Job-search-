import { STATUS } from '../sheets/schema.js';

/**
 * Two passes. Exact match on post_id catches the same posting seen again on any
 * later run. Near-duplicate match on dupe_hash catches one job cross-posted to two
 * boards, which LinkedIn and Indeed do constantly.
 *
 * The first-seen row is always the one kept; the duplicate's URL is appended to its
 * fit_reasons so the row shows where else the job ran.
 */
export function dedupe(incoming, existingRows, { nearDupeSources = ['linkedin', 'indeed'] } = {}) {
  const seenIds = new Set(existingRows.map((r) => String(r.post_id)));

  const nearIndex = new Map();
  for (const row of existingRows) {
    const hash = String(row.dupe_hash ?? '');
    if (hash && nearDupeSources.includes(String(row.source))) {
      if (!nearIndex.has(hash)) nearIndex.set(hash, row);
    }
  }

  const fresh = [];
  const exactDuplicates = [];
  const nearDuplicates = [];

  for (const post of incoming) {
    if (seenIds.has(post.post_id)) {
      exactDuplicates.push(post);
      continue;
    }

    const eligible = nearDupeSources.includes(post.source);
    const twin = eligible ? nearIndex.get(post.dupe_hash) : undefined;
    if (twin && twin.source !== post.source) {
      nearDuplicates.push({ post, keptPostId: String(twin.post_id), keptRow: twin._row ?? null });
      seenIds.add(post.post_id);
      continue;
    }

    fresh.push(post);
    seenIds.add(post.post_id);
    if (eligible && !nearIndex.has(post.dupe_hash)) nearIndex.set(post.dupe_hash, post);
  }

  return { fresh, exactDuplicates, nearDuplicates };
}

/**
 * Cell patches for the surviving rows of near-duplicate pairs, so the kept row
 * records the other board's URL.
 */
export function crossPostAnnotations(nearDuplicates, existingRows) {
  const byId = new Map(existingRows.map((r) => [String(r.post_id), r]));
  const grouped = new Map();

  for (const { post, keptPostId } of nearDuplicates) {
    const row = byId.get(keptPostId);
    if (!row) continue;
    if (!grouped.has(keptPostId)) grouped.set(keptPostId, { row, urls: [] });
    grouped.get(keptPostId).urls.push(`${post.source}: ${post.url}`);
  }

  return [...grouped.values()].map(({ row, urls }) => {
    const existing = String(row.fit_reasons ?? '').trim();
    const note = `cross-posted -> ${urls.join(' | ')}`;
    const merged = existing.includes(note) ? existing : [existing, note].filter(Boolean).join(' | ');
    return { row: row._row, patch: { fit_reasons: merged } };
  });
}

/** Rows for postings that arrive already classified as duplicates of a kept row. */
export function duplicateRows(nearDuplicates, runIdValue) {
  return nearDuplicates.map(({ post, keptPostId }) => ({
    post_id: post.post_id,
    source: post.source,
    url: post.url,
    title: post.title,
    company: post.company,
    posted_at: post.posted_at,
    comp_type: post.comp_type,
    comp_min: post.comp_min,
    comp_max: post.comp_max,
    est_hours: post.est_hours,
    first_seen_run: runIdValue,
    signal_type: '',
    fit_score: '',
    fit_reasons: `duplicate of ${keptPostId}`,
    hard_out_reason: '',
    niche: '',
    tools_mentioned: '',
    status: STATUS.DUPLICATE,
    dupe_hash: post.dupe_hash,
    last_classified_run: '',
    comp_flags: '',
  }));
}
