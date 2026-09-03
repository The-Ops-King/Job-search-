/**
 * The seam between the pipeline and whatever runs the model.
 *
 * Every backend implements one method:
 *
 *   complete({ system, prompt, schema, purpose, maxTokens })
 *     -> { data, usage, costUsd }
 *
 * `data` is already validated against the zod schema, so callers never see raw
 * text. `purpose` is 'classify' or 'draft'; the backend picks the model, which
 * keeps model choice out of the pipeline.
 *
 * Switching backends is one environment variable. That is deliberate: the
 * subscription route and the API route have different failure modes, and being
 * able to move between them without touching pipeline code is the point.
 */

import * as claudeCode from './claude-code.js';
import * as api from './api.js';

const BACKENDS = { claude_code: claudeCode, api };

export function getLlm(name = process.env.LLM_BACKEND || 'claude_code') {
  const backend = BACKENDS[name];
  if (!backend) {
    throw new Error(
      `Unknown LLM_BACKEND "${name}". Available: ${Object.keys(BACKENDS).join(', ')}.`);
  }
  backend.assertConfigured();
  return backend;
}

export class LlmError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.retryable = retryable;
  }
}

/**
 * Raised when the account's usage limit is reached. This is not retryable inside a
 * run: it stops the batch so the remaining posts stay pending for the next one,
 * rather than burning the rest of the window on calls that will all fail.
 */
export class LlmRateLimitError extends LlmError {
  constructor(message) {
    super(message, { retryable: false });
    this.name = 'LlmRateLimitError';
  }
}

export class LlmAuthError extends LlmError {
  constructor(message) {
    super(message, { retryable: false });
    this.name = 'LlmAuthError';
  }
}

export class LlmRefusalError extends LlmError {
  constructor(message) {
    super(message, { retryable: false });
    this.name = 'LlmRefusalError';
  }
}

export class LlmParseError extends LlmError {
  constructor(message, { raw } = {}) {
    super(message, { retryable: true });
    this.name = 'LlmParseError';
    this.raw = raw;
  }
}

export function isRateLimit(error) {
  return error instanceof LlmRateLimitError;
}

/**
 * Pulls a JSON object out of model output. Handles a bare object, a fenced block,
 * and an object with prose either side of it. Throws rather than guessing when
 * there is no object to find.
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new LlmParseError('Model returned nothing', { raw });

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1].trim() : raw;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new LlmParseError(`No JSON object in model output: ${raw.slice(0, 300)}`, { raw });
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new LlmParseError(`Model output is not valid JSON: ${error.message}`, { raw });
  }
}

/** Renders a zod schema as the instruction block a text-only backend needs. */
export function schemaInstructions(schema, name = 'result') {
  const shape = describe(schema);
  return [
    'OUTPUT FORMAT',
    '',
    `Respond with only a JSON object named ${name}. No prose before or after it, no`,
    'markdown code fence, no explanation. The object must match this shape exactly:',
    '',
    shape,
    '',
    'Every key is required. Use null for a value that does not apply. Use an empty',
    'array rather than omitting an array.',
  ].join('\n');
}

function describe(schema, depth = 0) {
  const pad = '  '.repeat(depth + 1);
  const def = schema?._def ?? {};
  const type = def.type ?? def.typeName;

  if (type === 'object' || type === 'ZodObject') {
    const shape = typeof def.shape === 'function' ? def.shape() : (def.shape ?? schema.shape);
    const lines = Object.entries(shape).map(([key, value]) => {
      const note = value?.description ? `  // ${value.description}` : '';
      return `${pad}"${key}": ${describe(value, depth + 1)}${note}`;
    });
    return `{\n${lines.join(',\n')}\n${'  '.repeat(depth)}}`;
  }
  if (type === 'array' || type === 'ZodArray') {
    const inner = def.element ?? def.type ?? def.innerType;
    return `[${describe(inner, depth)}]`;
  }
  if (type === 'enum' || type === 'ZodEnum') {
    const values = def.entries ? Object.values(def.entries) : (def.values ?? []);
    return values.map((v) => JSON.stringify(v)).join(' | ');
  }
  if (type === 'nullable' || type === 'ZodNullable') return `${describe(def.innerType, depth)} | null`;
  if (type === 'optional' || type === 'ZodOptional') return `${describe(def.innerType, depth)} | null`;
  if (type === 'string' || type === 'ZodString') return 'string';
  if (type === 'number' || type === 'ZodNumber') return 'number';
  if (type === 'boolean' || type === 'ZodBoolean') return 'boolean';
  return 'value';
}
