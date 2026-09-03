import { collect } from './_shared.js';

export const name = 'upwork';

/**
 * Upwork carries both the direct-role queries and the scaling-signal queries
 * (§6.3): a client hiring closers is a client about to have an ops problem.
 * Upwork search is remote by definition, so no remote knob is sent.
 */
export function queriesFor(queryConfig) {
  return [...queryConfig.shared, ...queryConfig.upwork_only];
}

export async function fetch({ client, actorConfig, queryConfig, options, now, budget, rotation }) {
  return collect({
    source: name,
    client,
    actorConfig,
    queries: queriesFor(queryConfig),
    options: { ...options, remote: false },
    now,
    budget,
    rotation,
  });
}
