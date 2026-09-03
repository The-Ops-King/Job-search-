import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

import {
  LlmError, LlmRateLimitError, LlmAuthError, LlmRefusalError, LlmParseError,
  extractJson, schemaInstructions,
} from './index.js';
import { log } from '../../lib/log.js';

const run = promisify(execFile);

export const name = 'claude_code';

/**
 * Runs the model through headless Claude Code on a Claude subscription, so the
 * pipeline costs no separate API bill.
 *
 * Two flags matter more than all the others:
 *
 *   --tools ""   Claude Code ships its tool definitions in every request. Measured
 *                on a trivial prompt, leaving them in costs 26,438 input tokens per
 *                call; stripping them costs 509. That is a 13x difference on a
 *                workload that makes one call per job posting, so this is not an
 *                optimization, it is the difference between viable and not.
 *
 *   --bare       Must NOT be used. It forces API-key-only auth and never reads the
 *                OAuth credentials a subscription uses, which is exactly backwards
 *                for this backend. Isolation comes from --setting-sources and
 *                --strict-mcp-config instead.
 *
 * The tradeoff against the API backend is real: there is no server-side schema
 * enforcement here, so output is validated with zod and retried once on a miss.
 */

const MODELS = {
  classify: 'claude-sonnet-5',
  draft: 'claude-opus-5',
};

// Claude Code spawns a process per call and each one carries its own context, so
// running many at once buys less than it does against the API and costs a lot more
// memory on a CI runner.
export const defaultConcurrency = { classify: 3, draft: 2 };

export const supportsSchemaEnforcement = false;

const ISOLATION_ARGS = [
  '--output-format', 'json',
  '--max-turns', '1',
  // No tools. See the note above; this is the single biggest cost lever.
  '--tools', '',
  // Ignore any MCP servers, settings files or CLAUDE.md the host machine has, so a
  // run behaves identically on a laptop and on a CI runner.
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '',
];

export function assertConfigured() {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    throw new LlmAuthError(
      'Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set. For the ' +
      'subscription route run "claude setup-token" and store the result as ' +
      'CLAUDE_CODE_OAUTH_TOKEN.');
  }
}

/** Maps a CLI error string onto an error the pipeline knows how to act on. */
export function classifyError(message) {
  const text = String(message ?? '');
  if (/rate.?limit|usage limit|too many requests|quota|limit reached|429/i.test(text)) {
    return new LlmRateLimitError(
      `Claude usage limit reached: ${text.slice(0, 300)}. Remaining posts stay pending ` +
      `and are retried on the next run.`);
  }
  if (/authentication|unauthorized|401|invalid.*token|expired.*token/i.test(text)) {
    return new LlmAuthError(
      `Claude Code authentication failed: ${text.slice(0, 300)}. Re-run "claude setup-token" ` +
      `and update CLAUDE_CODE_OAUTH_TOKEN.`);
  }
  if (/refus|decline|cannot help|can't help/i.test(text)) {
    return new LlmRefusalError(`Model declined: ${text.slice(0, 300)}`);
  }
  return new LlmError(`Claude Code error: ${text.slice(0, 500)}`, { retryable: /5\d\d|overload|timeout|network/i.test(text) });
}

async function invoke({ system, prompt, model, timeoutMs }) {
  let stdout;
  try {
    ({ stdout } = await run('claude', [
      '-p', prompt,
      '--model', model,
      '--system-prompt', system,
      ...ISOLATION_ARGS,
    ], {
      // A neutral directory so no repository CLAUDE.md is discovered and pulled in.
      cwd: tmpdir(),
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      env: process.env,
    }));
  } catch (error) {
    if (error.killed || error.signal) {
      throw new LlmError(`Claude Code timed out after ${timeoutMs}ms`, { retryable: true });
    }
    // A non-zero exit still prints the JSON envelope, so prefer it over the raw error.
    if (error.stdout) stdout = error.stdout;
    else throw classifyError(error.message);
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new LlmParseError(
      `Claude Code did not return a JSON envelope: ${String(stdout).slice(0, 400)}`,
      { raw: stdout });
  }

  if (envelope.is_error) throw classifyError(envelope.result ?? envelope.terminal_reason);

  return {
    text: envelope.result,
    usage: envelope.usage ?? {},
    // On a subscription this is not a bill. It is the API-list equivalent of the
    // quota the call consumed, which is the only comparable number available.
    costUsd: Number(envelope.total_cost_usd ?? 0),
  };
}

export async function complete({ system, prompt, schema, purpose = 'classify', timeoutMs = 180000 }) {
  const model = MODELS[purpose] ?? MODELS.classify;
  const fullSystem = `${system}\n\n${schemaInstructions(schema)}`;

  let lastError;
  let correction = '';

  // Two attempts. The second feeds the validation error back, which fixes the
  // common case of a near-miss on an enum or a missing key.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { text, usage, costUsd } = await invoke({
      system: fullSystem,
      prompt: correction ? `${prompt}\n\n${correction}` : prompt,
      model,
      timeoutMs,
    });

    try {
      return { data: schema.parse(extractJson(text)), usage, costUsd };
    } catch (error) {
      lastError = error;
      const detail = error?.issues
        ? error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        : error.message;
      log.warn('model output failed validation', { attempt, purpose, detail: detail.slice(0, 300) });
      correction =
        `Your previous response did not match the required schema: ${detail}\n` +
        `Return the corrected JSON object only.`;
    }
  }

  throw new LlmParseError(
    `Model output failed schema validation twice: ${lastError?.message ?? 'unknown'}`,
    { raw: lastError?.raw });
}
