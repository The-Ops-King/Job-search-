import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { dedupe, crossPostAnnotations, duplicateRows } from '../src/pipeline/dedupe.js';
import { normalizeAll } from '../src/sources/normalize.js';
import { STATUS } from '../src/sheets/schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const actors = JSON.parse(readFileSync(join(ROOT, 'config/actors.json'), 'utf8'));
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, `test/fixtures/${name}.json`), 'utf8'));
const NOW = new Date('2026-09-03T00:00:00.000Z');

const normalize = (source) =>
  normalizeAll(fixture(source), { source, actorConfig: actors[source], now: NOW }).posts;

const asRow = (post, row) => ({
  _row: row, post_id: post.post_id, source: post.source, url: post.url,
  title: post.title, dupe_hash: post.dupe_hash, status: STATUS.LEAD, fit_reasons: '',
});

describe('exact deduplication', () => {
  it('skips a post_id already in the sheet', () => {
    const posts = normalize('indeed');
    const existing = posts.map((p, i) => asRow(p, i + 2));
    const { fresh, exactDuplicates } = dedupe(posts, existing);
    expect(fresh).toHaveLength(0);
    expect(exactDuplicates).toHaveLength(3);
  });

  it('treats an empty sheet as all fresh', () => {
    const posts = normalize('indeed');
    expect(dedupe(posts, []).fresh).toHaveLength(3);
  });

  it('collapses the same post appearing twice within one run', () => {
    const posts = normalize('indeed');
    const { fresh, exactDuplicates } = dedupe([...posts, ...posts], []);
    expect(fresh).toHaveLength(3);
    expect(exactDuplicates).toHaveLength(3);
  });
});

describe('cross-post detection between LinkedIn and Indeed', () => {
  // The Halcyon Agency posting appears in both fixture files with identical title,
  // company and body. Different URLs mean different post_ids, so only the content
  // hash can catch it.
  const linkedinHalcyon = () => normalize('linkedin').find((p) => p.company === 'Halcyon Agency');
  const indeedHalcyon = () => normalize('indeed').find((p) => p.company === 'Halcyon Agency');

  it('produces the same dupe_hash for the same job on two boards', () => {
    expect(linkedinHalcyon().dupe_hash).toBe(indeedHalcyon().dupe_hash);
    expect(linkedinHalcyon().post_id).not.toBe(indeedHalcyon().post_id);
  });

  it('keeps the first-seen row and marks the later one as a cross-post', () => {
    const kept = linkedinHalcyon();
    const { fresh, nearDuplicates } = dedupe([indeedHalcyon()], [asRow(kept, 5)]);
    expect(fresh).toHaveLength(0);
    expect(nearDuplicates).toHaveLength(1);
    expect(nearDuplicates[0].keptPostId).toBe(kept.post_id);
  });

  it('does not cross-match two postings from the same source', () => {
    const post = indeedHalcyon();
    const twin = { ...post, post_id: 'different-id', url: 'https://indeed.com/viewjob?jk=zzz' };
    const { fresh, nearDuplicates } = dedupe([twin], [asRow(post, 2)]);
    expect(nearDuplicates).toHaveLength(0);
    expect(fresh).toHaveLength(1);
  });

  it('leaves Upwork out of near-duplicate matching', () => {
    const upworkPost = { ...normalize('upwork')[0], dupe_hash: indeedHalcyon().dupe_hash };
    const { fresh, nearDuplicates } = dedupe([upworkPost], [asRow(indeedHalcyon(), 2)]);
    expect(nearDuplicates).toHaveLength(0);
    expect(fresh).toHaveLength(1);
  });

  it('catches a cross-post that arrives inside the same run', () => {
    const { fresh, nearDuplicates } = dedupe([linkedinHalcyon(), indeedHalcyon()], []);
    expect(fresh).toHaveLength(1);
    expect(nearDuplicates).toHaveLength(1);
    expect(fresh[0].source).toBe('linkedin');
  });

  it('honours a caller-supplied source list', () => {
    const { nearDuplicates } = dedupe([indeedHalcyon()], [asRow(linkedinHalcyon(), 5)], { nearDupeSources: [] });
    expect(nearDuplicates).toHaveLength(0);
  });
});

describe('cross-post annotations', () => {
  it('records the other board url on the surviving row', () => {
    const kept = normalize('linkedin').find((p) => p.company === 'Halcyon Agency');
    const dupePost = normalize('indeed').find((p) => p.company === 'Halcyon Agency');
    const rows = [asRow(kept, 5)];
    const { nearDuplicates } = dedupe([dupePost], rows);

    const [patch] = crossPostAnnotations(nearDuplicates, rows);
    expect(patch.row).toBe(5);
    expect(patch.patch.fit_reasons).toContain('cross-posted');
    expect(patch.patch.fit_reasons).toContain(dupePost.url);
  });

  it('appends to an existing fit_reasons value without losing it', () => {
    const kept = normalize('linkedin').find((p) => p.company === 'Halcyon Agency');
    const dupePost = normalize('indeed').find((p) => p.company === 'Halcyon Agency');
    const rows = [{ ...asRow(kept, 5), fit_reasons: 'strong GHL match' }];
    const { nearDuplicates } = dedupe([dupePost], rows);

    const [patch] = crossPostAnnotations(nearDuplicates, rows);
    expect(patch.patch.fit_reasons).toContain('strong GHL match');
    expect(patch.patch.fit_reasons).toContain('cross-posted');
  });

  it('is idempotent, so a rerun does not stack the same note twice', () => {
    const kept = normalize('linkedin').find((p) => p.company === 'Halcyon Agency');
    const dupePost = normalize('indeed').find((p) => p.company === 'Halcyon Agency');
    let rows = [asRow(kept, 5)];

    const first = crossPostAnnotations(dedupe([dupePost], rows).nearDuplicates, rows);
    rows = [{ ...rows[0], fit_reasons: first[0].patch.fit_reasons }];
    const second = crossPostAnnotations(dedupe([dupePost], rows).nearDuplicates, rows);

    expect(second[0].patch.fit_reasons).toBe(first[0].patch.fit_reasons);
  });
});

describe('duplicateRows', () => {
  it('writes the duplicate as its own row pointing at the kept post', () => {
    const kept = normalize('linkedin').find((p) => p.company === 'Halcyon Agency');
    const dupePost = normalize('indeed').find((p) => p.company === 'Halcyon Agency');
    const { nearDuplicates } = dedupe([dupePost], [asRow(kept, 5)]);

    const [row] = duplicateRows(nearDuplicates, 'run-1');
    expect(row.status).toBe(STATUS.DUPLICATE);
    expect(row.post_id).toBe(dupePost.post_id);
    expect(row.fit_reasons).toContain(kept.post_id);
    expect(row.first_seen_run).toBe('run-1');
  });
});
