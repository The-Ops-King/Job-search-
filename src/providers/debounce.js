import { retry } from '../lib/retry.js';
import { EMAIL_STATUS } from '../sheets/schema.js';

const ENDPOINT = 'https://api.debounce.io/v1/';

/**
 * Debounce returns a numeric code plus a human result. Only "Safe" is treated as
 * verified. "Risky" and "Unknown" stay at `found`: they are worth a manual look but
 * not worth burning sender reputation on automatically.
 */
export function interpret(payload) {
  const result = String(payload?.debounce?.result ?? '').toLowerCase();
  const code = String(payload?.debounce?.code ?? '');
  if (result === 'safe' || code === '5') return EMAIL_STATUS.VERIFIED;
  if (result === 'invalid' || code === '6' || code === '2' || code === '1') return EMAIL_STATUS.INVALID;
  return EMAIL_STATUS.FOUND;
}

export async function verifyEmail(email, { apiKey = process.env.DEBOUNCE_API_KEY, fetchImpl = fetch } = {}) {
  if (!email) return { status: EMAIL_STATUS.NOT_FOUND, raw: null };
  if (!apiKey) return { status: EMAIL_STATUS.FOUND, raw: { skipped: 'DEBOUNCE_API_KEY not set' } };

  const url = `${ENDPOINT}?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
  const payload = await retry(async () => {
    const res = await fetchImpl(url);
    if (!res.ok) {
      const error = new Error(`Debounce returned ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }, { attempts: 3, baseMs: 700, label: 'debounce' });

  return { status: interpret(payload), raw: payload };
}
