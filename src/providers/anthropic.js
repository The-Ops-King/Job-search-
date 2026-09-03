/**
 * Run accounting.
 *
 * What the number means depends on the backend, and the difference is not cosmetic:
 *
 *   LLM_BACKEND=api          real dollars billed to an Anthropic account
 *   LLM_BACKEND=claude_code  no bill at all; the figure is the API-list equivalent
 *                            of the quota the calls consumed, which is the only
 *                            comparable number Claude Code reports
 *
 * On the subscription backend the binding limit is the usage window, not money, so
 * the cost guard is a volume brake rather than a spending one. The digest says which
 * backend produced the figure so the number is never read as a bill when it is not.
 */
export class CostMeter {
  constructor(backend = 'unknown') {
    this.backend = backend;
    this.entries = [];
  }

  /** One completed model call. `usd` comes from the backend, already computed. */
  add(label, usd, usage = {}) {
    this.entries.push({
      label,
      usd: Number.isFinite(usd) ? usd : 0,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    });
    return usd;
  }

  /** Non-model spend: Apify runs, enrichment lookups. Always real money. */
  addExternal(label, usd) {
    if (Number.isFinite(usd) && usd > 0) this.entries.push({ label, usd, external: true });
  }

  get total() {
    return Number(this.entries.reduce((sum, e) => sum + e.usd, 0).toFixed(4));
  }

  /** Real money only, which on the subscription backend excludes model calls. */
  get billed() {
    return Number(this.entries.filter((e) => e.external)
      .reduce((sum, e) => sum + e.usd, 0).toFixed(4));
  }

  get calls() {
    return this.entries.filter((e) => !e.external).length;
  }

  breakdown() {
    const byLabel = {};
    for (const e of this.entries) byLabel[e.label] = Number(((byLabel[e.label] ?? 0) + e.usd).toFixed(4));
    return byLabel;
  }

  describe() {
    return this.backend === 'claude_code'
      ? `$${this.total.toFixed(2)} quota-equivalent across ${this.calls} calls (no API bill; ` +
        `$${this.billed.toFixed(2)} of that is real spend on Apify and enrichment)`
      : `$${this.total.toFixed(2)} across ${this.calls} calls`;
  }
}
