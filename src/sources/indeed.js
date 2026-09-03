import { collect } from './_shared.js';

export const name = 'indeed';

export function queriesFor(queryConfig) {
  return [...queryConfig.shared];
}

export async function fetch({ client, actorConfig, queryConfig, options, now }) {
  return collect({
    source: name,
    client,
    actorConfig,
    queries: queriesFor(queryConfig),
    options: { ...options, remote: true },
    now,
  });
}
