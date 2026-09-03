#!/usr/bin/env node
import 'dotenv/config';
import { createSheetsClient } from '../src/sheets/client.js';
import { TAB_NAMES } from '../src/sheets/schema.js';
import { log } from '../src/lib/log.js';

/**
 * Creates every tab, writes headers from schema.js, turns the APPROVE column into
 * real checkboxes and seeds the Config tab. Additive only: it appends missing
 * columns and never deletes or reorders existing ones, so it is safe to re-run
 * after a schema change.
 */
const store = await createSheetsClient();
await store.ensureTabs();
log.info('sheet ready', { spreadsheetId: store.spreadsheetId, tabs: TAB_NAMES });
process.stdout.write(`\nhttps://docs.google.com/spreadsheets/d/${store.spreadsheetId}/edit\n`);
