import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  getPath, pick, parseCompensation, resolveCompensation, parsePostedAt, parseRemote,
  normalizeItem, normalizeAll, filterByRecency, SchemaDriftError,
} from '../src/sources/normalize.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const actors = JSON.parse(readFileSync(join(ROOT, 'config/actors.json'), 'utf8'));
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, `test/fixtures/${name}.json`), 'utf8'));
const NOW = new Date('2026-09-03T00:00:00.000Z');

describe('getPath', () => {
  it('walks dots and array indexes', () => {
    const obj = { a: { b: [{ c: 'found' }] }, list: ['x', 'y'] };
    expect(getPath(obj, 'a.b[0].c')).toBe('found');
    expect(getPath(obj, 'list[1]')).toBe('y');
  });

  it('returns undefined instead of throwing on any miss', () => {
    expect(getPath({}, 'a.b.c')).toBeUndefined();
    expect(getPath({ a: null }, 'a.b')).toBeUndefined();
    expect(getPath({ a: 'string' }, 'a[0].b')).toBeUndefined();
  });
});

describe('pick', () => {
  it('takes the first candidate path that yields a value', () => {
    expect(pick({ b: 'second' }, ['a', 'b', 'c'])).toEqual({ value: 'second', path: 'b' });
  });

  it('treats empty string and empty array as misses', () => {
    expect(pick({ a: '', b: [], c: 'real' }, ['a', 'b', 'c']).value).toBe('real');
  });
});

describe('parseCompensation', () => {
  it('parses an annual range', () => {
    expect(parseCompensation('$120,000 - $150,000 a year')).toEqual({ min: 120000, max: 150000, period: 'year' });
  });

  it('parses an hourly rate', () => {
    expect(parseCompensation('$60.00/hr')).toEqual({ min: 60, max: 60, period: 'hour' });
  });

  it('expands the K suffix', () => {
    expect(parseCompensation('$150K per year')).toEqual({ min: 150000, max: 150000, period: 'year' });
  });

  it('reads "up to" as a ceiling and "from" as a floor', () => {
    expect(parseCompensation('Up to $150,000')).toEqual({ min: null, max: 150000, period: null });
    expect(parseCompensation('From $90,000 annually')).toEqual({ min: 90000, max: null, period: 'year' });
  });

  it('returns null when there is no money in the string', () => {
    expect(parseCompensation('Competitive salary and benefits')).toBeNull();
    expect(parseCompensation('')).toBeNull();
    expect(parseCompensation(null)).toBeNull();
  });

  it('ignores small non-money numbers outside hourly context', () => {
    expect(parseCompensation('$120,000 a year, 5 years experience')).toEqual({ min: 120000, max: 120000, period: 'year' });
  });
});

describe('resolveCompensation', () => {
  it('annualizes a monthly salary so one floor comparison works', () => {
    expect(resolveCompensation({ text: '$12,000 per month', defaultType: 'salary' }))
      .toEqual({ comp_type: 'salary', comp_min: 144000, comp_max: 144000 });
  });

  it('prefers explicit numeric fields over parsed text', () => {
    expect(resolveCompensation({ typeRaw: 'Hourly', min: 85, max: 150, text: '$1 - $2 an hour' }))
      .toEqual({ comp_type: 'hourly', comp_min: 85, comp_max: 150 });
  });

  it('reports unknown when nothing resolves', () => {
    expect(resolveCompensation({ text: 'DOE', defaultType: 'salary' }))
      .toEqual({ comp_type: 'unknown', comp_min: null, comp_max: null });
  });

  it('swaps a reversed range', () => {
    const r = resolveCompensation({ typeRaw: 'salary', min: 200000, max: 100000 });
    expect([r.comp_min, r.comp_max]).toEqual([100000, 200000]);
  });
});

describe('parsePostedAt', () => {
  it('handles ISO, epoch seconds and epoch milliseconds', () => {
    expect(parsePostedAt('2026-09-02T14:30:00.000Z')).toBe('2026-09-02T14:30:00.000Z');
    expect(parsePostedAt(1756857600000)).toBe(new Date(1756857600000).toISOString());
    expect(parsePostedAt(1756857600)).toBe(new Date(1756857600000).toISOString());
  });

  it('resolves relative phrases against a supplied clock', () => {
    expect(parsePostedAt('1 day ago', NOW)).toBe('2026-09-02T00:00:00.000Z');
    expect(parsePostedAt('just posted', NOW)).toBe(NOW.toISOString());
    expect(parsePostedAt('30+ days ago', NOW)).toBe(new Date(NOW.getTime() - 30 * 86400000).toISOString());
  });

  it('returns null for junk rather than an invalid date', () => {
    expect(parsePostedAt('sometime recently')).toBeNull();
    expect(parsePostedAt('')).toBeNull();
  });
});

describe('parseRemote', () => {
  it('reads the strings boards actually emit', () => {
    expect(parseRemote(true)).toBe(true);
    expect(parseRemote('Remote')).toBe(true);
    expect(parseRemote('hybrid')).toBe(false);
    expect(parseRemote('On-site')).toBe(false);
    expect(parseRemote('', 'fallback')).toBe('fallback');
  });
});

describe('normalizeAll against fixtures', () => {
  for (const source of ['upwork', 'linkedin', 'indeed']) {
    it(`maps every ${source} fixture item to a canonical Post`, () => {
      const { posts, dropped } = normalizeAll(fixture(source), {
        source, actorConfig: actors[source], now: NOW,
      });
      expect(dropped).toBe(0);
      expect(posts).toHaveLength(fixture(source).length);
      for (const post of posts) {
        expect(post.post_id).toMatch(/^[a-f0-9]{64}$/);
        expect(post.source).toBe(source);
        expect(post.url).toMatch(/^https:\/\//);
        expect(post.title.length).toBeGreaterThan(0);
        expect(post.description.length).toBeGreaterThan(0);
        expect(post.dupe_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(['hourly', 'fixed', 'salary', 'unknown']).toContain(post.comp_type);
      }
    });
  }

  it('strips tracking parameters so the same posting gets one id', () => {
    const [post] = normalizeAll(fixture('indeed'), { source: 'indeed', actorConfig: actors.indeed, now: NOW }).posts;
    expect(post.url).toBe('https://indeed.com/viewjob?jk=aa11bb22cc33dd44');
  });

  it('carries Upwork hourly range and estimated hours through', () => {
    const [post] = normalizeAll(fixture('upwork'), { source: 'upwork', actorConfig: actors.upwork, now: NOW }).posts;
    expect(post.comp_type).toBe('hourly');
    expect(post.comp_min).toBe(85);
    expect(post.comp_max).toBe(150);
    expect(post.est_hours).toBe(40);
  });

  it('leaves company null when the board does not expose one', () => {
    const linkedinPosts = normalizeAll(fixture('linkedin'), { source: 'linkedin', actorConfig: actors.linkedin, now: NOW }).posts;
    expect(linkedinPosts[0].company).toBe('Peak Performance Coaching');
    const noCompany = normalizeAll([{ ...fixture('linkedin')[0], companyName: undefined }], {
      source: 'linkedin', actorConfig: actors.linkedin, now: NOW,
    }).posts[0];
    expect(noCompany.company).toBeNull();
  });
});

describe('schema drift', () => {
  it('throws when the actor stops returning a required field', () => {
    const broken = fixture('indeed').map(({ url, ...rest }) => ({ ...rest, jobLink: url }));
    delete broken[0].jobLink; delete broken[1].jobLink; delete broken[2].jobLink;
    expect(() => normalizeAll(broken, { source: 'indeed', actorConfig: actors.indeed, now: NOW }))
      .toThrow(SchemaDriftError);
  });

  it('names the missing fields and the keys it did see', () => {
    try {
      normalizeAll([{ nothing: 'useful' }], { source: 'indeed', actorConfig: actors.indeed, now: NOW });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaDriftError);
      expect(error.message).toContain('url');
      expect(error.message).toContain('nothing');
      expect(error.message).toContain('probe-actor');
    }
  });

  it('tolerates a single malformed item without failing the batch', () => {
    const items = [...fixture('indeed'), { junk: true }];
    const { posts, dropped } = normalizeAll(items, { source: 'indeed', actorConfig: actors.indeed, now: NOW });
    expect(dropped).toBe(1);
    expect(posts).toHaveLength(3);
  });

  it('warns rather than fails when only posted_at stops resolving', () => {
    const items = fixture('indeed').map(({ postedAt, ...rest }) => rest);
    const { posts, warnings } = normalizeAll(items, { source: 'indeed', actorConfig: actors.indeed, now: NOW });
    expect(posts).toHaveLength(3);
    expect(warnings.join(' ')).toContain('posted_at never resolved');
  });
});

describe('filterByRecency', () => {
  const posts = [
    { posted_at: '2026-09-02T12:00:00.000Z' },
    { posted_at: '2026-08-01T12:00:00.000Z' },
    { posted_at: null },
  ];

  it('drops stale posts but keeps undated ones', () => {
    const { kept, dropped } = filterByRecency(posts, 2, NOW);
    expect(dropped).toBe(1);
    expect(kept).toHaveLength(2);
    expect(kept.some((p) => p.posted_at === null)).toBe(true);
  });

  it('is a no-op when no window is given', () => {
    expect(filterByRecency(posts, 0, NOW).kept).toHaveLength(3);
  });
});

describe('normalizeItem', () => {
  it('reports which required fields were missing instead of returning a partial post', () => {
    const { post, missing } = normalizeItem({ title: 'x' }, { source: 'indeed', actorConfig: actors.indeed, now: NOW });
    expect(post).toBeNull();
    expect(missing).toContain('url');
    expect(missing).toContain('description');
  });
});
