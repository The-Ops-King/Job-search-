import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { LlmError, LlmRateLimitError, LlmAuthError, LlmRefusalError, LlmParseError } from './index.js';

export const name = 'api';

/**
 * The Anthropic Messages API backend. Not the default, because it bills separately
 * from a Claude subscription, but kept complete and one environment variable away:
 * LLM_BACKEND=api.
 *
 * Its advantage over the subscription route is real. `output_config.format` makes
 * the API itself enforce the JSON schema, so there is no parse-and-retry loop and no
 * class of failure where the model returns prose. If classification reliability ever
 * becomes the bottleneck, this is the switch to flip.
 */

const MODELS = {
  classify: 'claude-sonnet-5',
  draft: 'claude-opus-5',
};

/** USD per million tokens, for the run cost estimate. */
const PRICING = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
};

export const defaultConcurrency = { classify: 5, draft: 3 };

export const supportsSchemaEnforcement = true;

let client = null;

export function assertConfigured() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new LlmAuthError('LLM_BACKEND=api requires ANTHROPIC_API_KEY.');
  }
}

function getClient() {
  // The SDK retries 429 and 5xx itself with backoff; four tries rides out a burst.
  client ??= new Anthropic({ maxRetries: 4, timeout: 180000 });
  return client;
}

export function estimateCost(model, usage = {}) {
  const price = PRICING[model] ?? { input: 0, output: 0 };
  const input = (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0) * 0.1
    + (usage.cache_creation_input_tokens ?? 0) * 1.25;
  return (input / 1e6) * price.input + ((usage.output_tokens ?? 0) / 1e6) * price.output;
}

export async function complete({ system, prompt, schema, purpose = 'classify', maxTokens = 4000 }) {
  const model = MODELS[purpose] ?? MODELS.classify;

  let message;
  try {
    message = await getClient().messages.parse({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: purpose === 'draft' ? 'high' : 'medium',
        format: zodOutputFormat(schema),
      },
    });
  } catch (error) {
    const status = error?.status;
    if (status === 429) throw new LlmRateLimitError(`API rate limit: ${error.message}`);
    if (status === 401 || status === 403) throw new LlmAuthError(`API auth failed: ${error.message}`);
    throw new LlmError(`API call failed: ${error.message}`, { retryable: status >= 500 });
  }

  if (message.stop_reason === 'refusal') {
    throw new LlmRefusalError(`Model declined (${message.stop_details?.category ?? 'unspecified'})`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new LlmError('Response hit max_tokens before completing', { retryable: false });
  }
  if (!message.parsed_output) {
    throw new LlmParseError('API returned no parsable output despite schema enforcement');
  }

  return {
    data: message.parsed_output,
    usage: message.usage ?? {},
    costUsd: estimateCost(model, message.usage),
  };
}
