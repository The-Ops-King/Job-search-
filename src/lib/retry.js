import { log } from './log.js';

const DEFAULT_RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

export function isRetryable(error) {
  const status = error?.status ?? error?.code ?? error?.response?.status;
  if (typeof status === 'number' && DEFAULT_RETRYABLE_STATUSES.has(status)) return true;
  const code = error?.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  return /rate.?limit|timeout|socket hang up|ECONNRESET/i.test(error?.message ?? '');
}

/**
 * Exponential backoff with full jitter. `attempts` counts total tries, not retries.
 */
export async function retry(fn, { attempts = 3, baseMs = 500, maxMs = 20000, label = 'op', retryable = isRetryable } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !retryable(error)) throw error;
      const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.round(Math.random() * ceiling);
      log.warn(`retrying ${label}`, { attempt, of: attempts, delay_ms: delay, error: error.message });
      await sleep(delay);
    }
  }
  throw lastError;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs tasks with bounded concurrency, preserving input order in the result array.
 * Never rejects: each slot resolves to { ok: true, value } or { ok: false, error }.
 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
