const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg, ...fields };
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

/**
 * Collects everything that went wrong during a run so the Runs row and the digest
 * report the same list. Stages push here instead of throwing when the run should continue.
 */
export class ErrorCollector {
  constructor() { this.items = []; }
  add(stage, error, context = {}) {
    const message = error instanceof Error ? error.message : String(error);
    this.items.push({ stage, message, ...context });
    log.error(`${stage}: ${message}`, context);
    return this;
  }
  get length() { return this.items.length; }
  toLines() {
    return this.items.map((e) => {
      const ctx = Object.entries(e)
        .filter(([k]) => k !== 'stage' && k !== 'message')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      return `[${e.stage}] ${e.message}${ctx ? ` (${ctx})` : ''}`;
    });
  }
  toCell() { return this.toLines().join('\n').slice(0, 45000); }
}
