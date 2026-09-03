import { google } from 'googleapis';
import { TABS, TAB_NAMES, CONFIG_SEED, headersFor } from './schema.js';
import { retry, sleep } from '../lib/retry.js';
import { log } from '../lib/log.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const MUTEX_STALE_MS = 30 * 60 * 1000;

export function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function credentialsFromEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  const decoded = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  try {
    return JSON.parse(decoded);
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (expected raw or base64): ${error.message}`);
  }
}

export async function createSheetsClient({ spreadsheetId = process.env.SHEET_ID } = {}) {
  if (!spreadsheetId) throw new Error('SHEET_ID is not set');
  const creds = credentialsFromEnv();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  await auth.authorize();
  return new SheetStore(google.sheets({ version: 'v4', auth }), spreadsheetId);
}

export class SheetStore {
  constructor(api, spreadsheetId) {
    this.api = api;
    this.spreadsheetId = spreadsheetId;
    this._sheetIds = null;
  }

  async _call(label, fn) {
    return retry(fn, { attempts: 3, baseMs: 800, maxMs: 15000, label: `sheets:${label}` });
  }

  async sheetIds() {
    if (this._sheetIds) return this._sheetIds;
    const res = await this._call('get-metadata', () =>
      this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties' }));
    this._sheetIds = Object.fromEntries(
      res.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
    return this._sheetIds;
  }

  /**
   * Reads a whole tab in one call and maps rows onto header names. `_row` is the
   * 1-based sheet row, which is what update() addresses. UNFORMATTED_VALUE keeps
   * checkboxes as booleans and numbers as numbers instead of display strings.
   */
  async load(tab) {
    const expected = headersFor(tab);
    const res = await this._call(`load:${tab}`, () =>
      this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${tab}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      }));

    const values = res.data.values ?? [];
    if (values.length === 0) throw new Error(`Tab "${tab}" is empty. Run: npm run setup-sheet`);

    const headers = values[0].map((h) => String(h ?? '').trim());
    const missing = expected.filter((h) => !headers.includes(h));
    if (missing.length) {
      throw new Error(
        `Tab "${tab}" is missing column(s): ${missing.join(', ')}. ` +
        `Run "npm run setup-sheet" to add them (it never deletes data).`);
    }

    const rows = values.slice(1).map((cells, i) => {
      const row = { _row: i + 2 };
      headers.forEach((h, c) => { row[h] = cells[c] ?? ''; });
      return row;
    }).filter((row) => headers.some((h) => row[h] !== '' && row[h] !== undefined));

    return { headers, rows };
  }

  async loadKeyed(tab) {
    const { headers, rows } = await this.load(tab);
    const key = TABS[tab].key;
    return { headers, rows, byKey: new Map(rows.map((r) => [String(r[key]), r])) };
  }

  /**
   * RAW, not USER_ENTERED: description text full of "5/10" or a leading "=" must
   * land as text, never be reinterpreted as a date or a formula.
   */
  async append(tab, objects) {
    if (!objects.length) return 0;
    const headers = headersFor(tab);
    const values = objects.map((obj) => headers.map((h) => serialize(obj[h])));
    await this._call(`append:${tab}`, () =>
      this.api.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      }));
    log.info('sheet append', { tab, rows: values.length });
    return values.length;
  }

  /**
   * Writes only the cells that changed. Whole-row writes would clobber an APPROVE
   * box checked by hand while the run was in flight.
   */
  async update(tab, updates) {
    const headers = headersFor(tab);
    const data = [];
    for (const { row, patch } of updates) {
      for (const [field, value] of Object.entries(patch)) {
        const col = headers.indexOf(field);
        if (col === -1) throw new Error(`Tab "${tab}" has no column "${field}"`);
        data.push({
          range: `${tab}!${columnLetter(col)}${row}`,
          values: [[serialize(value)]],
        });
      }
    }
    if (!data.length) return 0;

    for (let i = 0; i < data.length; i += 500) {
      const batch = data.slice(i, i + 500);
      await this._call(`update:${tab}`, () =>
        this.api.spreadsheets.values.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: batch },
        }));
    }
    log.info('sheet update', { tab, cells: data.length });
    return data.length;
  }

  // ---- config ----------------------------------------------------------

  async loadConfig(defaults = {}) {
    const { rows } = await this.load('Config');
    const overrides = {};
    for (const row of rows) {
      const key = String(row.key ?? '').trim();
      if (!key) continue;
      overrides[key] = coerce(row.value);
    }
    return { ...defaults, ...overrides, _rows: rows };
  }

  async setConfig(entries) {
    const { rows } = await this.load('Config');
    const byKey = new Map(rows.map((r) => [String(r.key).trim(), r]));
    const updates = [];
    const inserts = [];
    for (const [key, value] of Object.entries(entries)) {
      const existing = byKey.get(key);
      if (existing) updates.push({ row: existing._row, patch: { value } });
      else inserts.push({ key, value, notes: '' });
    }
    if (updates.length) await this.update('Config', updates);
    if (inserts.length) await this.append('Config', inserts);
  }

  // ---- mutex -----------------------------------------------------------

  /**
   * Sheets has no compare-and-swap, so this is claim, pause, re-read, confirm.
   * Two runs starting inside the confirm window can still both proceed. With a
   * daily cron plus occasional manual runs that window is not a practical risk,
   * and the alternative (a real lock service) is not worth the dependency.
   */
  async acquireLock(runIdValue, { staleMs = MUTEX_STALE_MS, confirmDelayMs = 1500 } = {}) {
    const config = await this.loadConfig();
    const held = config.running === true;
    const since = config.running_since ? Date.parse(config.running_since) : NaN;
    const age = Number.isNaN(since) ? Infinity : Date.now() - since;

    if (held && age < staleMs) {
      throw new LockHeldError(
        `Another run holds the lock (run_id=${config.running_by}, started ${config.running_since}). ` +
        `It goes stale after ${Math.round(staleMs / 60000)} minutes.`);
    }
    if (held) log.warn('breaking stale lock', { previous: config.running_by, age_ms: age });

    await this.setConfig({ running: 'TRUE', running_since: new Date().toISOString(), running_by: runIdValue });
    await sleep(confirmDelayMs);

    const confirm = await this.loadConfig();
    if (String(confirm.running_by) !== runIdValue) {
      throw new LockHeldError(`Lost the lock race to run_id=${confirm.running_by}`);
    }

    log.info('lock acquired', { run_id: runIdValue });
    return async () => {
      await this.setConfig({ running: 'FALSE', running_since: '', running_by: '' });
      log.info('lock released', { run_id: runIdValue });
    };
  }

  // ---- setup -----------------------------------------------------------

  async ensureTabs() {
    const res = await this._call('get-metadata', () =>
      this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties' }));
    const existing = new Map(res.data.sheets.map((s) => [s.properties.title, s.properties]));

    const addRequests = TAB_NAMES
      .filter((t) => !existing.has(t))
      .map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }));
    if (addRequests.length) {
      await this._call('add-tabs', () =>
        this.api.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: { requests: addRequests },
        }));
      this._sheetIds = null;
      log.info('created tabs', { tabs: addRequests.map((r) => r.addSheet.properties.title) });
    }

    for (const tab of TAB_NAMES) {
      const headers = headersFor(tab);
      const current = await this._call(`headers:${tab}`, () =>
        this.api.spreadsheets.values.get({
          spreadsheetId: this.spreadsheetId,
          range: `${tab}!1:1`,
        }));
      const have = (current.data.values?.[0] ?? []).map((h) => String(h ?? '').trim());
      const merged = [...have];
      for (const h of headers) if (!merged.includes(h)) merged.push(h);

      if (merged.join(' ') !== have.join(' ')) {
        await this._call(`write-headers:${tab}`, () =>
          this.api.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: `${tab}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values: [merged] },
          }));
        log.info('headers written', { tab, added: merged.filter((h) => !have.includes(h)) });
      }
    }

    await this.applyFormatting();
    await this.seedConfig();
  }

  async applyFormatting() {
    const ids = await this.sheetIds();
    const requests = [];

    for (const [tab, spec] of Object.entries(TABS)) {
      const sheetId = ids[tab];
      if (sheetId === undefined) continue;

      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColorStyle: { rgbColor: { red: 0.93, green: 0.93, blue: 0.93 } },
            },
          },
          fields: 'userEnteredFormat(textFormat,backgroundColorStyle)',
        },
      });
      requests.push({
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      });

      for (const col of spec.checkbox ?? []) {
        const index = spec.headers.indexOf(col);
        if (index === -1) continue;
        requests.push({
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: index, endColumnIndex: index + 1 },
            rule: { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true },
          },
        });
      }
    }

    if (requests.length) {
      await this._call('formatting', () =>
        this.api.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } }));
    }
  }

  async seedConfig() {
    const { rows } = await this.load('Config');
    const present = new Set(rows.map((r) => String(r.key).trim()));
    const missing = CONFIG_SEED
      .filter(([key]) => !present.has(key))
      .map(([key, value, notes]) => ({ key, value, notes }));
    if (missing.length) {
      await this.append('Config', missing);
      log.info('seeded config keys', { keys: missing.map((m) => m.key) });
    }
  }
}

export class LockHeldError extends Error {
  constructor(message) { super(message); this.name = 'LockHeldError'; }
}

function serialize(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  // A single cell holds 50,000 characters. Leave headroom rather than fail the write.
  return String(value).slice(0, 45000);
}

export function coerce(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const text = String(value ?? '').trim();
  if (text === '') return '';
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

export const isChecked = (value) => value === true || /^true$/i.test(String(value ?? '').trim());
