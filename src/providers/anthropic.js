import Anthropic from '@anthropic-ai/sdk';

/**
 * Classification runs on every new post every day, so it goes to the cheap model.
 * Drafts run only on gated leads and are what a stranger judges Tyler on, so they
 * go to the expensive one. The cost gap is small at this volume; the quality gap
 * on the drafts is not.
 */
export const MODELS = {
  classify: 'claude-sonnet-5',
  draft: 'claude-opus-5',
};

/** USD per million tokens. Used for the Runs estimate and the cost guard. */
export const PRICING = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
};

export function createAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  // The SDK retries 429 and 5xx itself with backoff; four tries covers a rate-limit
  // burst without another retry layer fighting it.
  return new Anthropic({ maxRetries: 4, timeout: 120000 });
}

export class CostMeter {
  constructor() { this.entries = []; }

  record(model, usage) {
    if (!usage) return;
    const price = PRICING[model] ?? { input: 0, output: 0 };
    const input = (usage.input_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0) * 0.1
      + (usage.cache_creation_input_tokens ?? 0) * 1.25;
    const usd = (input / 1e6) * price.input + ((usage.output_tokens ?? 0) / 1e6) * price.output;
    this.entries.push({ model, usd, input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 });
    return usd;
  }

  addExternal(label, usd) {
    if (Number.isFinite(usd) && usd > 0) this.entries.push({ model: label, usd });
  }

  get total() {
    return Number(this.entries.reduce((sum, e) => sum + e.usd, 0).toFixed(4));
  }

  breakdown() {
    const byModel = {};
    for (const e of this.entries) byModel[e.model] = Number(((byModel[e.model] ?? 0) + e.usd).toFixed(4));
    return byModel;
  }
}

export class RefusalError extends Error {
  constructor(details) {
    super(`Model declined the request (${details?.category ?? 'unspecified'})`);
    this.name = 'RefusalError';
    this.details = details;
  }
}

/** Every model response goes through here so a refusal never reads as a parse failure. */
export function assertUsable(message) {
  if (message.stop_reason === 'refusal') throw new RefusalError(message.stop_details);
  if (message.stop_reason === 'max_tokens') throw new Error('Response hit max_tokens before completing');
  return message;
}
