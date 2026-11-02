// Cloud persistence. The app mutates `state` in memory and calls `persist()`; this module works out
// which rows were added, changed or removed since the last save and sends only those, in an order
// that respects foreign keys. Nothing but the sign-in session is kept in the browser.

import { defaultState, categoriesOf } from './model.js';
import { selectAll, upsert, remove, removeAll, currentUser, hasColumns } from './cloud.js';

// camelCase in the app ↔ snake_case in the database.
const TABLES = {
  categories: {
    to: (c) => ({ id: c.id, name: c.name, parent_id: c.parentId ?? null }),
    from: (r) => ({ id: r.id, name: r.name, parentId: r.parent_id ?? null }),
  },
  accounts: {
    to: (a) => ({ id: a.id, name: a.name, type: a.type, currency: a.currency, archived: Boolean(a.archived) }),
    from: (r) => ({ id: r.id, name: r.name, type: r.type, currency: r.currency, archived: r.archived }),
  },
  rules: {
    to: (x, i) => ({ id: x.id, pattern: x.pattern, match: x.match, category_id: x.categoryId ?? null, position: i }),
    from: (r) => ({ id: r.id, pattern: r.pattern, match: r.match, categoryId: r.category_id }),
  },
  holdings: {
    to: (x) => ({
      id: x.id, account_id: x.accountId, symbol: x.symbol, mic: x.mic ?? null, exchange: x.exchange ?? null,
      name: x.name ?? null, currency: x.currency, quantity: x.quantity, price: x.price ?? null,
      price_at: x.priceAt ?? null, manual: Boolean(x.manual), price_error: x.priceError ?? null, source: x.source ?? null,
      price_history: x.priceHistory ?? null,
    }),
    from: (r) => ({
      id: r.id, accountId: r.account_id, symbol: r.symbol, mic: r.mic, exchange: r.exchange, name: r.name,
      currency: r.currency, quantity: r.quantity, price: r.price, priceAt: r.price_at, manual: r.manual,
      priceError: r.price_error ?? undefined, source: r.source, priceHistory: r.price_history ?? undefined,
    }),
  },
  schedules: {
    to: (s) => ({
      id: s.id, description: s.description, amount: s.amount, kind: s.kind, account_id: s.accountId,
      to_account_id: s.toAccountId ?? null, category_id: s.categoryId ?? null, every: s.every, unit: s.unit,
      anchor_day: s.anchorDay ?? null, next_date: s.nextDate, end_date: s.endDate ?? null,
    }),
    from: (r) => ({
      id: r.id, description: r.description, amount: Number(r.amount), kind: r.kind, accountId: r.account_id,
      toAccountId: r.to_account_id, categoryId: r.category_id, every: r.every, unit: r.unit,
      anchorDay: r.anchor_day, nextDate: r.next_date, endDate: r.end_date,
    }),
  },
  people: {
    to: (p) => ({ id: p.id, name: p.name }),
    from: (r) => ({ id: r.id, name: r.name }),
  },
  ious: {
    to: (e) => ({
      id: e.id, person_id: e.personId, date: e.date, description: e.description ?? '',
      amount: e.amount, transaction_id: e.transactionId ?? null, kind: e.kind ?? null,
    }),
    from: (r) => ({
      id: r.id, personId: r.person_id, date: r.date, description: r.description,
      amount: Number(r.amount), transactionId: r.transaction_id, kind: r.kind,
    }),
  },
  lots: {
    to: (l) => ({ id: l.id, holding_id: l.holdingId, date: l.date, kind: l.kind, quantity: l.quantity, price: l.price, fees: l.fees ?? 0 }),
    from: (r) => ({ id: r.id, holdingId: r.holding_id, date: r.date, kind: r.kind, quantity: r.quantity, price: r.price, fees: r.fees }),
  },
  snapshots: {
    to: (x) => ({ id: x.date, date: x.date, values: x.values }),
    from: (r) => ({ id: r.id, date: r.date, values: r.values ?? {} }),
  },
  transactions: {
    to: (t) => ({
      id: t.id, account_id: t.accountId, date: t.date, description: t.description, amount: t.amount,
      category_ids: categoriesOf(t), rate: t.rate ?? null, memo: t.memo || null,
      transfer_id: t.transferId ?? null, kind: t.kind ?? null,
    }),
    from: (r) => ({
      // Rows saved before multiple categories have only category_id.
      id: r.id, accountId: r.account_id, date: r.date, description: r.description, amount: Number(r.amount),
      categoryIds: r.category_ids ?? (r.category_id ? [r.category_id] : []), rate: r.rate, memo: r.memo ?? '', transferId: r.transfer_id ?? undefined, kind: r.kind ?? undefined,
    }),
  },
};
// Parents before children when saving; children before parents when deleting.
const ORDER = ['categories', 'accounts', 'people', 'rules', 'holdings', 'lots', 'schedules', 'transactions', 'ious', 'snapshots'];
// Tables added after the first release. If the database doesn't have one yet (schema.sql not
// re-run), the app still loads and simply doesn't save that table.
const OPTIONAL = new Set(['schedules', 'people', 'ious', 'snapshots', 'lots']);
const missing = new Set();
export const missingTables = () => [...missing];

// Columns added after the first release. Saving needs them, so their absence is reported to the
// app, which asks for schema.sql to be run again.
const NEW_COLUMNS = { categories: ['parent_id'], transactions: ['category_ids', 'kind'], settings: ['fx', 'last_backup_at', 'backup_every'], holdings: ['price_history'] };
let schemaOutdated = false;
export const needsSchemaUpdate = () => schemaOutdated || missing.size > 0;

const toSettingsRow = (s) => ({
  quote_api_key: s.quoteApiKey || null, av_api_key: s.avApiKey || null, last_account_id: s.lastAccountId ?? null,
  fx: s.fx ?? {},
  last_backup_at: s.lastBackupAt ?? null,
  backup_every: s.backupEvery ?? 7,
});

let state = null;
let saved = {}; // table → Map(id → JSON of the row as last saved)
let savedSettings = '';
let timer = null;
let running = null;
let listener = () => {};

// status: 'saved' | 'saving' | 'error'. The app shows it in the header.
export const onStatus = (fn) => { listener = fn; };
export const hasPendingChanges = () => Boolean(timer || running) || diff().size > 0;

const snapshot = () => {
  saved = Object.fromEntries(ORDER.map((t) => [t, new Map(state[t].map((x, i) => [x.id, JSON.stringify(TABLES[t].to(x, i))]))]));
  savedSettings = JSON.stringify(toSettingsRow(state.settings));
};

// Loads everything for the signed-in user. An empty account gets the default categories and rules.
export async function load() {
  missing.clear();
  const checks = await Promise.all(Object.entries(NEW_COLUMNS).map(([t, cols]) => hasColumns(t, cols)));
  schemaOutdated = checks.includes(false);
  const [rows, settingsRows] = await Promise.all([
    Promise.all(ORDER.map((t) => selectAll(t).catch((err) => {
      if (!OPTIONAL.has(t)) throw err;
      missing.add(t);
      return [];
    }))),
    selectAll('settings', 'user_id'),
  ]);
  const base = defaultState();
  state = { ...base, rates: {} };
  ORDER.forEach((t, i) => { state[t] = rows[i].map(TABLES[t].from); });
  state.rules = rows[ORDER.indexOf('rules')]
    .sort((a, b) => a.position - b.position).map(TABLES.rules.from);
  const s = settingsRows[0] ?? {};
  state.settings = {
    quoteApiKey: s.quote_api_key ?? '', avApiKey: s.av_api_key ?? '', lastAccountId: s.last_account_id ?? undefined,
    fx: s.fx ?? {}, // today's exchange rates, { USD: { rate, date } }, so they're fetched once a day
    lastBackupAt: s.last_backup_at ?? null, // when a backup was last downloaded
    backupEvery: s.backup_every ?? 7, // days between backup reminders; 0 = no reminders
  };
  snapshot();
  const empty = !state.accounts.length && !state.categories.length && !state.rules.length;
  if (empty) {
    state.categories = base.categories;
    state.rules = base.rules;
    persist();
  }
  return state;
}

// Rows to write and ids to delete, per table.
function diff() {
  const changes = new Map();
  if (!state) return changes;
  for (const t of ORDER) {
    if (missing.has(t)) continue;
    const before = saved[t];
    const now = new Map(state[t].map((x, i) => [x.id, TABLES[t].to(x, i)]));
    const up = [...now.values()].filter((row) => before.get(row.id) !== JSON.stringify(row));
    const del = [...before.keys()].filter((id) => !now.has(id));
    if (up.length || del.length) changes.set(t, { up, del });
  }
  if (JSON.stringify(toSettingsRow(state.settings)) !== savedSettings) changes.set('settings', {});
  return changes;
}

async function flush() {
  timer = null;
  if (running) { schedule(300); return; }
  // Writing to an outdated schema would fail on every retry; wait until it's updated.
  if (schemaOutdated) { listener('error', new Error('The database needs the updated schema.sql')); return; }
  const changes = diff();
  if (!changes.size) { listener('saved'); return; }
  listener('saving');
  const userId = currentUser()?.id;
  running = (async () => {
    for (const t of ORDER) {
      const c = changes.get(t);
      if (c?.up.length) await upsert(t, c.up.map((r) => ({ user_id: userId, ...r })));
    }
    for (const t of [...ORDER].reverse()) {
      const c = changes.get(t);
      if (c?.del.length) await remove(t, c.del);
    }
    if (changes.has('settings')) await upsert('settings', [{ user_id: userId, ...toSettingsRow(state.settings) }], 'user_id');
  })();
  try {
    await running;
    // Mark exactly what was sent as saved; edits made meanwhile are picked up by the next diff.
    for (const [t, c] of changes) {
      if (t === 'settings') continue;
      c.up.forEach((row) => saved[t].set(row.id, JSON.stringify(row)));
      c.del.forEach((id) => saved[t].delete(id));
    }
    if (changes.has('settings')) savedSettings = JSON.stringify(toSettingsRow(state.settings));
    running = null;
    listener(diff().size ? 'saving' : 'saved');
    if (diff().size) schedule(0);
  } catch (err) {
    running = null;
    listener('error', err);
    schedule(5000); // keep retrying; nothing is lost while the page stays open
  }
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(flush, ms);
}

// Debounced so a burst of edits (an import, reordering rules) becomes one round of requests.
export function persist() {
  listener('saving');
  schedule(400);
  return true;
}

// Empties `tables` in the database and in memory: one DELETE per table instead of one per row.
// Waits for any save in flight first, so nothing is written back afterwards.
export async function clearTables(tables) {
  clearTimeout(timer);
  timer = null;
  if (running) await running.catch(() => {});
  listener('saving');
  try {
    for (const t of [...ORDER].reverse()) {
      if (!tables.includes(t) || missing.has(t)) continue;
      await removeAll(t);
      state[t] = [];
      saved[t] = new Map();
    }
  } catch (err) {
    listener('error', err);
    throw err;
  }
  listener(diff().size ? 'saving' : 'saved');
  if (diff().size) schedule(0);
}

// ── Backups ──────────────────────────────────────────────────────────────────

export const BACKUP_TABLES = ORDER;

// Everything, as the rows the database holds (snake_case, ids and links kept), so a backup restores
// exactly. API keys and the save bookkeeping are left out.
export function backupData() {
  return {
    format: 'finance-backup', version: 1, createdAt: new Date().toISOString(),
    tables: Object.fromEntries(ORDER.map((t) => [t, state[t].map((x, i) => TABLES[t].to(x, i))])),
  };
}

// Replaces everything in memory with a backup (from backupData). The caller has already emptied
// the database tables (clearTables), so the next save sends every row.
export function restoreData(data) {
  if (data?.format !== 'finance-backup' || !data.tables) throw new Error('This isn’t a Finance backup');
  for (const t of ORDER) {
    const rows = data.tables[t] ?? [];
    state[t] = t === 'rules'
      ? [...rows].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(TABLES[t].from)
      : rows.map(TABLES[t].from);
  }
  persist();
}

// Data saved by the earlier, browser-only version of this tool, if any.
const LEGACY_KEY = 'finance:v1';
export function legacyData() {
  try {
    const data = JSON.parse(localStorage.getItem(LEGACY_KEY));
    return data && (data.accounts?.length || data.transactions?.length) ? data : null;
  } catch { return null; }
}
export function forgetLegacyData() {
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* nothing to remove */ }
}
