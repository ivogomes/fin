// Cloud persistence. The app mutates `state` in memory and calls `persist()`; this module works out
// which rows were added, changed or removed since the last save and sends only those, in an order
// that respects foreign keys. Nothing but the sign-in session is kept in the browser.
//
// Transactions are the exception to loading everything: `state.transactions` holds only the ones in
// use (a page of an account, what an action needs), unless a page asks for all of them. Rows are
// never dropped from it, so one missing since the last save was deleted. Account totals come from
// the database (`refreshSummaries`) with the changes not yet counted there added on top
// (`accountTotals`), so they move the moment something changes.

import { defaultState, categoriesOf, splitsOf } from './model.js';
import { selectAll, upsert, remove, removeAll, currentUser, hasColumns, rpc } from './cloud.js';

// camelCase in the app ↔ snake_case in the database.
const TABLES = {
  categories: {
    to: (c) => ({ id: c.id, name: c.name, parent_id: c.parentId ?? null }),
    from: (r) => ({ id: r.id, name: r.name, parentId: r.parent_id ?? null }),
  },
  accounts: {
    to: (a) => ({
      id: a.id, name: a.name, type: a.type, currency: a.currency, archived: Boolean(a.archived), credit_limit: a.creditLimit ?? null, card_network: a.cardNetwork ?? null,
      statement_day: a.statementDay ?? null, due_day: a.dueDay ?? null, pay_from: a.payFrom ?? null,
      low_balance: a.lowBalance ?? null, is_main: Boolean(a.isMain),
      interest_rate: a.interestRate ?? null, interest_every: a.interestEvery ?? null, interest_tax: a.interestTax ?? null, investment_kind: a.investmentKind ?? null,
      opened_on: a.openedOn ?? null, closed_on: a.closedOn ?? null, institution: a.institution ?? null, last_four: a.lastFour ?? null,
      exclude_totals: Boolean(a.excludeTotals), color: a.color ?? null,
    }),
    // Settings that aren't set are left off, so an account only carries what it uses.
    from: (r) => {
      const a = { id: r.id, name: r.name, type: r.type, currency: r.currency, archived: r.archived };
      const set = (k, v) => { if (v != null && v !== false && v !== '') a[k] = v; };
      set('creditLimit', r.credit_limit != null ? Number(r.credit_limit) : null);
      set('cardNetwork', r.card_network);
      set('statementDay', r.statement_day);
      set('dueDay', r.due_day);
      set('payFrom', r.pay_from);
      set('lowBalance', r.low_balance != null ? Number(r.low_balance) : null);
      set('isMain', r.is_main);
      set('interestRate', r.interest_rate);
      set('interestEvery', r.interest_every);
      set('interestTax', r.interest_tax);
      set('investmentKind', r.investment_kind);
      set('openedOn', r.opened_on);
      set('closedOn', r.closed_on);
      set('institution', r.institution);
      set('lastFour', r.last_four);
      set('excludeTotals', r.exclude_totals);
      set('color', r.color);
      return a;
    },
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
      to_account_id: s.toAccountId ?? null, category_id: categoriesOf(s)[0] ?? null, category_ids: categoriesOf(s), every: s.every, unit: s.unit,
      anchor_day: s.anchorDay ?? null, next_date: s.nextDate, end_date: s.endDate ?? null, subscription: Boolean(s.subscription),
    }),
    from: (r) => ({
      id: r.id, description: r.description, amount: Number(r.amount), kind: r.kind, accountId: r.account_id,
      // Several categories, like a transaction; rows saved before that have only category_id.
      toAccountId: r.to_account_id, categoryIds: r.category_ids?.length ? r.category_ids : r.category_id ? [r.category_id] : [], every: r.every, unit: r.unit,
      anchorDay: r.anchor_day, nextDate: r.next_date, endDate: r.end_date, ...(r.subscription && { subscription: true }),
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
  // A home, a vehicle… (model.js, Assets): valued from valuations, apart from the accounts.
  assets: {
    to: (x, i) => ({
      id: x.id, name: x.name, kind: x.kind, currency: x.currency, purchase_price: x.purchasePrice ?? null, bought_on: x.boughtOn ?? null,
      value_change: x.valueChange ?? null, value_floor: x.valueFloor ?? null, valuations: x.valuations ?? [],
      sold_on: x.soldOn ?? null, position: i,
    }),
    from: (r) => {
      const x = { id: r.id, name: r.name, kind: r.kind, currency: r.currency, valuations: (r.valuations ?? []).map((v) => ({ date: v.date, value: Number(v.value) })) };
      if (r.purchase_price != null) x.purchasePrice = Number(r.purchase_price);
      if (r.bought_on) x.boughtOn = r.bought_on;
      if (r.value_change != null) x.valueChange = Number(r.value_change);
      if (r.value_floor != null) x.valueFloor = Number(r.value_floor);
      if (r.sold_on) x.soldOn = r.sold_on;
      return x;
    },
  },
  transactions: {
    to: (t) => ({
      id: t.id, account_id: t.accountId, date: t.date, description: t.description, amount: t.amount,
      category_ids: categoriesOf(t), rate: t.rate ?? null, memo: t.memo || null,
      transfer_id: t.transferId ?? null, kind: t.kind ?? null,
      splits: splitsOf(t), holding_id: t.holdingId ?? null,
    }),
    from: (r) => ({
      // Rows saved before multiple categories have only category_id.
      id: r.id, accountId: r.account_id, date: r.date, description: r.description, amount: Number(r.amount),
      categoryIds: r.category_ids ?? (r.category_id ? [r.category_id] : []), rate: r.rate, memo: r.memo ?? '', transferId: r.transfer_id ?? undefined, kind: r.kind ?? undefined,
      ...(Array.isArray(r.splits) && r.splits.length && { splits: r.splits.map((p) => ({ categoryId: p.categoryId ?? null, amount: Number(p.amount) })) }),
      ...(r.holding_id && { holdingId: r.holding_id }),
    }),
  },
};
// Parents before children when saving; children before parents when deleting.
const ORDER = ['categories', 'accounts', 'people', 'rules', 'holdings', 'lots', 'schedules', 'transactions', 'ious', 'snapshots', 'assets'];
// Tables added after the first release. If the database doesn't have one yet (schema.sql not
// re-run), the app still loads and simply doesn't save that table.
const OPTIONAL = new Set(['schedules', 'people', 'ious', 'snapshots', 'lots', 'assets']);
const missing = new Set();
export const missingTables = () => [...missing];

// Columns added after the first release. Saving needs them, so their absence is reported to the
// app, which asks for schema.sql to be run again.
const NEW_COLUMNS = {
  accounts: ['credit_limit', 'card_network', 'statement_day', 'due_day', 'pay_from', 'low_balance', 'is_main', 'interest_rate',
    'interest_every', 'interest_tax', 'investment_kind', 'opened_on', 'closed_on', 'institution', 'last_four', 'exclude_totals', 'color'], categories: ['parent_id'], transactions: ['category_ids', 'kind', 'splits', 'holding_id'], settings: ['fx', 'last_backup_at', 'backup_every', 'eodhd_api_key', 'hidden_suggestions'], holdings: ['price_history'], schedules: ['subscription', 'category_ids'] };
let schemaOutdated = false;
export const needsSchemaUpdate = () => schemaOutdated || missing.size > 0;
// A database function the app calls doesn't take its arguments yet (schema.sql not run again).
export const markSchemaOutdated = () => { schemaOutdated = true; };

const toSettingsRow = (s) => ({
  quote_api_key: s.quoteApiKey || null, av_api_key: s.avApiKey || null, eodhd_api_key: s.eodhdApiKey || null, last_account_id: s.lastAccountId ?? null,
  fx: s.fx ?? {},
  last_backup_at: s.lastBackupAt ?? null,
  backup_every: s.backupEvery ?? 7,
  hidden_suggestions: s.hiddenSuggestions ?? [],
});

let state = null;
let saved = {}; // table → Map(id → JSON of the row as last saved)
let savedSettings = '';
let timer = null;
let running = null;
let listener = () => {};
let savedListener = () => {};
let allTransactions = false;

// After each successful save round, with the tables it wrote.
export const onSaved = (fn) => { savedListener = fn; };
// Whether `state.transactions` holds every transaction (some pages and tools need them all).
export const transactionsComplete = () => allTransactions;

// status: 'saved' | 'saving' | 'error'. The app shows it in the header.
export const onStatus = (fn) => { listener = fn; };
export const hasPendingChanges = () => Boolean(timer || running) || diff().size > 0;

const snapshot = () => {
  saved = Object.fromEntries(ORDER.map((t) => [t, new Map(state[t].map((x, i) => [x.id, JSON.stringify(TABLES[t].to(x, i))]))]));
  savedSettings = JSON.stringify(toSettingsRow(state.settings));
};

// Loads the signed-in user's data, and the account totals. Transactions only with `allTransactions`
// (otherwise the page fetches the ones it shows). An empty account gets the default categories and rules.
export async function load({ allTransactions: everything = false, today, until } = {}) {
  missing.clear();
  allTransactions = everything;
  // The schema check, every table and the totals load at the same time.
  const [checks, rows, settingsRows, sums] = await Promise.all([
    Promise.all(Object.entries(NEW_COLUMNS).map(([t, cols]) => hasColumns(t, cols))),
    Promise.all(ORDER.map((t) => (t === 'transactions' && !everything ? Promise.resolve([]) : selectAll(t)).catch((err) => {
      if (!OPTIONAL.has(t)) throw err;
      missing.add(t);
      return [];
    }))),
    selectAll('settings', 'user_id'),
    rpc('account_summaries', { p_today: today, p_until: until }).catch(() => null),
  ]);
  schemaOutdated = checks.includes(false) || sums == null;
  const base = defaultState();
  state = { ...base, rates: {} };
  ORDER.forEach((t, i) => { state[t] = rows[i].map(TABLES[t].from); });
  fromDb.clear();
  state.transactions.forEach((t) => fromDb.add(t.id));
  state.rules = rows[ORDER.indexOf('rules')]
    .sort((a, b) => a.position - b.position).map(TABLES.rules.from);
  state.assets = rows[ORDER.indexOf('assets')]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(TABLES.assets.from);
  const s = settingsRows[0] ?? {};
  state.settings = {
    quoteApiKey: s.quote_api_key ?? '', avApiKey: s.av_api_key ?? '', eodhdApiKey: s.eodhd_api_key ?? '', lastAccountId: s.last_account_id ?? undefined,
    fx: s.fx ?? {}, // today's exchange rates, { USD: { rate, date } }, so they're fetched once a day
    lastBackupAt: s.last_backup_at ?? null, // when a backup was last downloaded
    backupEvery: s.backup_every ?? 7, // days between backup reminders; 0 = no reminders
    hiddenSuggestions: s.hidden_suggestions ?? [], // suggested schedules turned down
  };
  snapshot();
  setSummaries(sums ?? []);
  const empty = !state.accounts.length && !state.categories.length && !state.rules.length;
  if (empty) {
    state.categories = base.categories;
    state.rules = base.rules;
    persist();
  }
  return state;
}

// ── Transactions in use, and account totals ─────────────────────────────────

const fromRow = (r) => TABLES.transactions.from(r);

// Counts changes made in memory (each persist), so a fetch can tell whether anything changed while
// it was on its way.
let edits = 0;
export const editToken = () => edits;
// Transactions that came from the database (as opposed to added here since the page loaded).
const fromDb = new Set();
export const isFromDatabase = (id) => fromDb.has(id);

// Adds transactions fetched from the database (rows as the database has them) to the ones in use,
// skipping any already there, or deleted here and not saved yet. They're counted in the totals
// already. With `token` (editToken() from before the fetch): if anything changed since, adds nothing
// and returns null, as the rows may be out of date.
export function addTransactions(rows, token = edits) {
  if (token !== edits) return null;
  const have = new Set(state.transactions.map((t) => t.id));
  for (const id of saved.transactions.keys()) have.add(id);
  const added = [];
  for (const r of rows) {
    if (have.has(r.id)) continue;
    const t = fromRow(r);
    fromDb.add(t.id);
    state.transactions.push(t);
    saved.transactions.set(t.id, JSON.stringify(TABLES.transactions.to(t)));
    base.set(t.id, brief(t));
    have.add(t.id);
    added.push(t);
  }
  return added;
}

// Loads every transaction (waiting for pending saves first), for the pages and tools that need them.
export async function loadAllTransactions() {
  if (allTransactions) return;
  await settle();
  addTransactions(await selectAll('transactions'));
  allTransactions = true;
}

// A transaction's part in its account's totals.
const brief = (t) => ({ accountId: t.accountId, amount: t.amount, date: t.date });
let summaries = new Map(); // accountId → { balance, count, past, planned, plannedCount } per the database
let base = new Map(); // transaction id → brief, as counted in `summaries`

function setSummaries(list) {
  summaries = new Map(list.map((x) => [x.accountId, {
    balance: Number(x.balance), count: Number(x.count), past: Number(x.past), planned: Number(x.planned), plannedCount: Number(x.plannedCount),
    first: x.first ?? null, // the date of its first transaction
  }]));
  // What the database had when it counted: the transactions in use as last saved.
  base = new Map([...saved.transactions].map(([id, json]) => {
    const r = JSON.parse(json);
    return [id, { accountId: r.account_id, amount: r.amount, date: r.date }];
  }));
}

// Asks the database for the totals again (after a save). Waits for a save in progress, so the
// totals and what's counted as saved match.
export async function refreshSummaries(today, until) {
  if (running) await running.catch(() => {});
  const list = await rpc('account_summaries', { p_today: today, p_until: until });
  if (running || timer) return false; // something changed meanwhile: the next save asks again
  setSummaries(list);
  return true;
}

// Each account's totals right now: the database's, plus whatever changed here since it counted.
// `balance` and `past` count up to `today`, `planned` what's dated after it up to `until`.
export function accountTotals(today, until) {
  const out = new Map();
  const at = (id) => {
    if (!out.has(id)) {
      const s = summaries.get(id);
      out.set(id, { balance: s?.balance ?? 0, count: s?.count ?? 0, past: s?.past ?? 0, planned: s?.planned ?? 0, plannedCount: s?.plannedCount ?? 0, first: s?.first ?? null });
    }
    return out.get(id);
  };
  for (const id of summaries.keys()) at(id);
  const apply = (b, sign) => {
    const x = at(b.accountId);
    x.count += sign;
    if (sign > 0 && (!x.first || b.date < x.first)) x.first = b.date;
    if (b.date <= today) { x.balance += sign * b.amount; x.past += sign; } else {
      x.plannedCount += sign;
      if (b.date <= until) x.planned += sign * b.amount;
    }
  };
  const now = new Set();
  for (const t of state.transactions) {
    now.add(t.id);
    const was = base.get(t.id);
    if (was && was.accountId === t.accountId && was.amount === t.amount && was.date === t.date) continue;
    if (was) apply(was, -1);
    apply(brief(t), 1);
  }
  for (const [id, was] of base) if (!now.has(id)) apply(was, -1);
  return out;
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
  const sentSettings = toSettingsRow(state.settings);
  running = (async () => {
    for (const t of ORDER) {
      const c = changes.get(t);
      if (c?.up.length) await upsert(t, c.up.map((r) => ({ user_id: userId, ...r })));
    }
    for (const t of [...ORDER].reverse()) {
      const c = changes.get(t);
      if (c?.del.length) await remove(t, c.del);
    }
    if (changes.has('settings')) await upsert('settings', [{ user_id: userId, ...sentSettings }], 'user_id');
  })();
  try {
    await running;
    // Mark exactly what was sent as saved; edits made meanwhile are picked up by the next diff.
    for (const [t, c] of changes) {
      if (t === 'settings') continue;
      c.up.forEach((row) => saved[t].set(row.id, JSON.stringify(row)));
      c.del.forEach((id) => saved[t].delete(id));
    }
    // Settings changed while saving (a rate fetched, say) aren't marked saved: the next round sends them.
    if (changes.has('settings')) savedSettings = JSON.stringify(sentSettings);
    running = null;
    listener(diff().size ? 'saving' : 'saved');
    if (diff().size) schedule(0);
    savedListener(new Set(changes.keys()));
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

// Sends whatever is waiting right away, before leaving the page. Gives up after a few rounds (say,
// the database is unreachable); the browser then warns before the page closes.
export async function settle() {
  for (let i = 0; i < 5 && (timer || running || diff().size); i += 1) {
    if (running) { await running.catch(() => {}); continue; }
    clearTimeout(timer);
    timer = null;
    await flush();
  }
}

// Debounced so a burst of edits (an import, reordering rules) becomes one round of requests.
export function persist() {
  edits += 1;
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
      if (t === 'transactions') { setSummaries([]); allTransactions = true; }
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
  if (data?.format !== 'finance-backup' || !data.tables) throw new Error('This isn’t a Fin backup');
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
