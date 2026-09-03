import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  extractJson, schemaInstructions, isRateLimit,
  LlmParseError, LlmRateLimitError, LlmAuthError, LlmRefusalError,
} from '../src/providers/llm/index.js';
import { classifyError } from '../src/providers/llm/claude-code.js';
import { estimateCost } from '../src/providers/llm/api.js';
import { pool } from '../src/lib/retry.js';
import { ClassificationSchema } from '../src/pipeline/classify.js';
import { DraftSchema } from '../src/pipeline/draft.js';

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('unwraps a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('survives prose on either side, which is the common failure', () => {
    expect(extractJson('Here is the result:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('handles nested braces without truncating', () => {
    expect(extractJson('{"a":{"b":[1,2]},"c":"}"}')).toEqual({ a: { b: [1, 2] }, c: '}' });
  });

  it('throws a retryable parse error rather than guessing', () => {
    expect(() => extractJson('no json at all')).toThrow(LlmParseError);
    expect(() => extractJson('')).toThrow(LlmParseError);
    expect(() => extractJson('{"a":')).toThrow(LlmParseError);
    try { extractJson('nope'); } catch (e) { expect(e.retryable).toBe(true); }
  });
});

describe('schemaInstructions', () => {
  it('renders the real classification schema into promptable text', () => {
    const text = schemaInstructions(ClassificationSchema);
    for (const key of ['signal_type', 'hard_out', 'capability_match', 'ownership_match', 'tools_mentioned', 'reasons']) {
      expect(text).toContain(`"${key}"`);
    }
    expect(text).toContain('"direct_role" | "scaling_signal" | "noise"');
    expect(text).toContain('| null');
    expect(text).toContain('[string]');
    expect(text).toContain('markdown code fence');
  });

  it('carries field descriptions through as comments, since they are the guidance', () => {
    expect(schemaInstructions(ClassificationSchema)).toContain('// 0-10. Can he do the work');
  });

  it('renders the draft schema too', () => {
    const text = schemaInstructions(DraftSchema);
    expect(text).toContain('"subject"');
    expect(text).toContain('"body"');
  });

  it('handles nesting without falling back to a generic type', () => {
    const nested = z.object({
      outer: z.object({ inner: z.array(z.number()), flag: z.boolean().nullable() }),
    });
    const text = schemaInstructions(nested);
    expect(text).toContain('"inner": [number]');
    expect(text).toContain('"flag": boolean | null');
    // The renderer falls back to a bare `value` type when it cannot read a node.
    // Checking the type position, not the word, which also appears in the boilerplate.
    expect(text).not.toMatch(/:\s*value/);
  });
});

describe('the rendered schema actually round-trips', () => {
  // The point of the instructions is that a model following them produces something
  // the zod schema accepts. This asserts the shape the prompt describes validates.
  it('accepts a well-formed classification', () => {
    const payload = {
      signal_type: 'direct_role', hard_out: null, hard_out_reason: null,
      niche: 'coaching', tools_mentioned: ['HubSpot'], team_size_hint: 6,
      remote_confirmed: true, capability_match: 9, ownership_match: 8,
      reasons: ['fits the rubric'],
    };
    expect(ClassificationSchema.parse(payload)).toEqual(payload);
  });

  it('rejects an out-of-range score instead of letting it through', () => {
    expect(() => ClassificationSchema.parse({
      signal_type: 'direct_role', hard_out: null, hard_out_reason: null, niche: 'x',
      tools_mentioned: [], team_size_hint: null, remote_confirmed: null,
      capability_match: 15, ownership_match: 5, reasons: [],
    })).toThrow();
  });

  it('rejects an invented enum value', () => {
    expect(() => ClassificationSchema.parse({
      signal_type: 'maybe_relevant', hard_out: null, hard_out_reason: null, niche: 'x',
      tools_mentioned: [], team_size_hint: null, remote_confirmed: null,
      capability_match: 5, ownership_match: 5, reasons: [],
    })).toThrow();
  });
});

describe('claude-code error classification', () => {
  it('recognises a usage limit and says the posts are not lost', () => {
    const error = classifyError('Claude usage limit reached. Your limit will reset at 3pm.');
    expect(error).toBeInstanceOf(LlmRateLimitError);
    expect(isRateLimit(error)).toBe(true);
    expect(error.message).toContain('retried on the next run');
  });

  it('recognises the other rate-limit phrasings', () => {
    for (const text of ['429 Too Many Requests', 'rate limit exceeded', 'quota exhausted']) {
      expect(classifyError(text)).toBeInstanceOf(LlmRateLimitError);
    }
  });

  it('recognises auth failure and names the fix', () => {
    const error = classifyError('Authentication error - invalid token');
    expect(error).toBeInstanceOf(LlmAuthError);
    expect(error.message).toContain('claude setup-token');
  });

  it('recognises a refusal', () => {
    expect(classifyError('I cannot help with that request')).toBeInstanceOf(LlmRefusalError);
  });

  it('marks transient server trouble retryable and everything else not', () => {
    expect(classifyError('503 service unavailable').retryable).toBe(true);
    expect(classifyError('malformed input').retryable).toBe(false);
  });

  it('never treats a rate limit as retryable, so the batch stops instead of grinding', () => {
    expect(classifyError('usage limit reached').retryable).toBe(false);
  });
});

describe('api backend cost estimate', () => {
  it('prices cache reads at a tenth of fresh input', () => {
    const fresh = estimateCost('claude-sonnet-5', { input_tokens: 1e6, output_tokens: 0 });
    const cached = estimateCost('claude-sonnet-5', { cache_read_input_tokens: 1e6, output_tokens: 0 });
    expect(fresh).toBeCloseTo(2, 5);
    expect(cached).toBeCloseTo(0.2, 5);
  });

  it('prices opus above sonnet', () => {
    const usage = { input_tokens: 1e6, output_tokens: 1e6 };
    expect(estimateCost('claude-opus-5', usage)).toBeGreaterThan(estimateCost('claude-sonnet-5', usage));
  });

  it('returns zero for an unknown model rather than throwing', () => {
    expect(estimateCost('nonexistent', { input_tokens: 1e6 })).toBe(0);
  });
});

describe('pool early stop', () => {
  const rateLimit = () => new LlmRateLimitError('usage limit reached');

  it('abandons remaining work once the stop condition fires', async () => {
    let started = 0;
    const { results, stopped } = await pool(
      Array.from({ length: 20 }, (_, i) => i), 1,
      async (n) => { started += 1; if (n === 2) throw rateLimit(); return n; },
      { stopWhen: isRateLimit },
    );

    expect(stopped).toBeInstanceOf(LlmRateLimitError);
    // Three attempted, the rest abandoned untouched.
    expect(started).toBe(3);
    expect(results.filter((r) => r.skipped)).toHaveLength(17);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it('distinguishes abandoned work from failed work', async () => {
    const { results } = await pool(
      [0, 1, 2, 3], 1,
      async (n) => { if (n === 1) throw rateLimit(); return n; },
      { stopWhen: isRateLimit },
    );
    expect(results[1].skipped).toBeUndefined();
    expect(results[1].ok).toBe(false);
    expect(results[2].skipped).toBe(true);
    expect(results[3].skipped).toBe(true);
  });

  it('keeps going through ordinary failures', async () => {
    const { results, stopped } = await pool(
      [0, 1, 2, 3], 2,
      async (n) => { if (n === 1) throw new Error('one bad post'); return n; },
      { stopWhen: isRateLimit },
    );
    expect(stopped).toBeNull();
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => r.skipped)).toHaveLength(0);
  });

  it('preserves input order under concurrency', async () => {
    const { results } = await pool(
      [30, 5, 20, 1], 4,
      async (ms) => { await new Promise((r) => setTimeout(r, ms)); return ms; },
    );
    expect(results.map((r) => r.value)).toEqual([30, 5, 20, 1]);
  });
});
