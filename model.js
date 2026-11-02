// Finance model. No DOM, no I/O. Money is stored as integer minor units (cents) so sums never drift.
// Every amount lives in its account's currency; `amountBase` is the same amount in the base currency (EUR),
// converted with the rate of the transaction date and frozen at that point.

export const BASE = 'EUR';
export const CURRENCIES = ['EUR', 'USD'];
// Order is the order of the groups in the side panel.
export const ACCOUNT_TYPES = ['cash', 'checking', 'credit', 'investment', 'savings'];
export const ACCOUNT_TYPE_LABELS = {
  cash: 'Cash', checking: 'Checking', credit: 'Credit card', investment: 'Investment', savings: 'Savings',
};

export const toMinor = (value) => Math.round(Number(value) * 100);
export const fromMinor = (minor) => minor / 100;

export function formatMoney(minor, currency, locale = undefined) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(fromMinor(minor));
}

// Lowercase and strip accents so "Café" matches a "cafe" rule.
export const normalize = (text) =>
  String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Rules are checked in list order and the first match wins. Returns a category id or null.
export function categorize(description, rules) {
  const text = normalize(description);
  if (!text) return null;
  for (const rule of rules) {
    const pattern = normalize(rule.pattern);
    if (!pattern) continue;
    const hit =
      rule.match === 'equals' ? text === pattern :
      rule.match === 'starts' ? text.startsWith(pattern) :
      text.includes(pattern);
    if (hit) return rule.categoryId;
  }
  return null;
}

// `rate` is base-currency units per 1 unit of `currency` (EUR per USD). EUR is always 1.
export function convert(minor, rate) {
  return Math.round(minor * rate);
}

export const rateFor = (currency, rates, date) =>
  currency === BASE ? 1 : rates[`${currency}:${date}`] ?? null;

// ── Categories ───────────────────────────────────────────────────────────────
// A category is { id, name, parentId }. Like Buxfer, there are two levels: top-level categories and
// their children. A child is shown and matched by its path, "Parent / Child". A transaction has a
// list of category ids (`categoryIds`), possibly empty.

const PATH_SEPARATOR = /\s+\/\s+/;

export function categoryPath(cat, categories) {
  const parent = cat.parentId && categories.find((c) => c.id === cat.parentId);
  return parent ? `${parent.name} / ${cat.name}` : cat.name;
}

// Finds categories by path ("Compras / Mercearia", case and accents ignored), creating the parent
// and the child when they don't exist yet. `created` lists what was added, parents first.
export function categoryResolver(categories, id) {
  const all = [...categories];
  const created = [];
  const byPath = new Map(all.map((c) => [normalize(categoryPath(c, all)), c]));
  const resolve = (path) => {
    const parts = String(path).split(PATH_SEPARATOR).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    const key = normalize(parts.join(' / '));
    if (byPath.has(key)) return byPath.get(key);
    const parent = parts.length > 1 ? resolve(parts[0]) : null;
    const cat = { id: id(), name: parts.length > 1 ? parts.slice(1).join(' / ') : parts[0], parentId: parent?.id ?? null };
    all.push(cat);
    created.push(cat);
    byPath.set(key, cat);
    return cat;
  };
  return { resolve, created };
}

// The categories of a transaction, reading older rows that had a single categoryId.
export const categoriesOf = (t) => t.categoryIds ?? (t.categoryId ? [t.categoryId] : []);

// Category ids sorted so parents come before their children and each family stays together.
export function sortedCategories(categories) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const top = categories.filter((c) => !c.parentId || !categories.some((p) => p.id === c.parentId)).sort(byName);
  return top.flatMap((p) => [p, ...categories.filter((c) => c.parentId === p.id).sort(byName)]);
}

// Moves an amount between two currencies through the base currency.
export const crossConvert = (minor, rateFrom, rateTo) => Math.round((minor * rateFrom) / rateTo);

// One row of the "add several" form. Returns { skip } for an empty row, { error } for a half-filled
// one, or { tx } without id and rate (the caller adds those).
export function batchRow(row, rules) {
  const description = row.description.trim();
  const raw = String(row.amount).trim();
  if (!description && !raw) return { skip: true };
  if (!description) return { error: 'needs a description' };
  if (!(Number(raw) > 0)) return { error: 'needs an amount above zero' };
  if (!row.date) return { error: 'needs a date' };
  return {
    tx: {
      accountId: row.accountId,
      date: row.date,
      description,
      // sign: '-' expense, '+' income, 'r' refund (money back that cancels part of an expense)
      amount: toMinor(raw) * (row.sign === '-' ? -1 : 1),
      categoryIds: [row.categoryId || categorize(description, rules)].filter(Boolean),
      memo: '',
      ...(row.sign === 'r' ? { kind: 'refund' } : {}),
    },
  };
}

// A transfer is two linked transactions: money out of `from`, money into `to`. `sent` and `received`
// are positive minor units in each account's own currency (they differ when the currencies do).
export function makeTransfer({ from, to, sent, received, date, description, memo = '' }, id = newId) {
  const transferId = id();
  const text = description || `Transfer: ${from.name} → ${to.name}`;
  const common = { date, description: text, categoryIds: [], transferId, memo };
  return [
    { id: id(), accountId: from.id, amount: -Math.abs(sent), ...common },
    { id: id(), accountId: to.id, amount: Math.abs(received), ...common },
  ];
}

// Account balance in the account's own currency. Credit card balances are negative when money is owed.
export function accountBalance(account, transactions) {
  return transactions
    .filter((t) => t.accountId === account.id)
    .reduce((sum, t) => sum + t.amount, 0);
}

// Transactions of one account, newest first, each with the account balance right after it.
export function withRunningBalance(accountId, transactions) {
  const rows = transactions
    .filter((t) => t.accountId === accountId)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.date.localeCompare(b.t.date) || a.i - b.i); // same day: entry order
  let balance = 0;
  return rows.map(({ t }) => ({ ...t, balance: (balance += t.amount) })).reverse();
}

// A holding is priced in its own currency; value is returned in that currency's minor units.
export function holdingValue(holding) {
  if (holding.price == null) return null;
  return Math.round(holding.quantity * holding.price * 100);
}

// An investment account with holdings is worth its holdings at current prices; the money moved into
// it (its transactions) is what was invested, and the difference is the gain. Without holdings it is
// worth the sum of its transactions, like any other account. This matches how Buxfer values them.
export function investmentValue(account, holdings, transactions, latestRate) {
  const invested = accountBalance(account, transactions);
  const own = holdings.filter((x) => x.accountId === account.id);
  if (!own.length) return { total: invested, invested, missing: 0, hasHoldings: false };
  let total = 0;
  let missing = 0;
  for (const h of own) {
    const value = holdingValue(h);
    if (value == null) { missing += 1; continue; }
    // Holdings are converted to the account currency through the base currency.
    total += h.currency === account.currency
      ? value
      : Math.round(value * (latestRate(h.currency) / latestRate(account.currency)));
  }
  return { total, invested, missing, hasHoldings: true };
}

// Net worth in the base currency. Archived accounts don't count; accounts still waiting for a rate
// are counted separately.
export function netWorth(state, latestRate) {
  let total = 0;
  let unconverted = 0;
  for (const account of state.accounts) {
    if (account.archived) continue;
    const rate = latestRate(account.currency);
    if (rate == null) { unconverted += 1; continue; }
    const native = account.type === 'investment'
      ? investmentValue(account, state.holdings, state.transactions, latestRate).total
      : accountBalance(account, state.transactions);
    total += convert(native, rate);
  }
  return { total, unconverted };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

// RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes, CRLF, a leading BOM.
// The delimiter is guessed from the first line (comma, semicolon or tab) unless given.
export function parseCsv(text, delimiter) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const d = delimiter ?? [',', ';', '\t'].reduce((best, c) =>
    firstLine.split(c).length > firstLine.split(best).length ? c : best, ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Writes rows (arrays of values) as CSV with a BOM, so Excel opens accents correctly.
export function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map((r) => r.map(esc).join(',')).join('\r\n')}\r\n`;
}

// "1.234,56", "-12.50", "(3,00)", "€ 1 234.56" → minor units, or NaN. `decimal` is '.' or ','.
export function parseAmount(text, decimal = '.') {
  let s = String(text).trim();
  const negative = /^\(.*\)$/.test(s) || /^[-−]/.test(s) || /[-−]$/.test(s);
  s = s.replace(/[^\d.,]/g, '');
  s = decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return NaN;
  return toMinor(s) * (negative ? -1 : 1);
}

// "31/12/2026" (dmy), "12/31/2026" (mdy), "2026-12-31" (ymd) → ISO date, or null. Two-digit years are 20xx.
export function parseDate(text, format = 'dmy') {
  const parts = String(text).trim().split(/\D+/).filter(Boolean).slice(0, 3).map(Number);
  if (parts.length !== 3) return null;
  let [y, m, d] = format === 'ymd' ? parts : format === 'mdy' ? [parts[2], parts[0], parts[1]] : [parts[2], parts[1], parts[0]];
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

// Best guesses from sample values, so the import form starts on the right settings.
export function guessDateFormat(samples) {
  const parts = samples.map((s) => String(s).trim().split(/\D+/).filter(Boolean).map(Number)).filter((p) => p.length >= 3);
  if (parts.some((p) => String(p[0]).length === 4)) return 'ymd';
  if (parts.some((p) => p[1] > 12)) return 'mdy';
  return 'dmy';
}
export function guessDecimal(samples) {
  return samples.some((s) => /\d,\d{1,2}\s*$/.test(String(s).trim())) ? ',' : '.';
}

export const IMPORT_FIELDS = ['date', 'description', 'amount', 'type', 'account', 'category', 'memo', 'currency', 'reference', 'iou'];
const HEADER_HINTS = {
  reference: /^(id|transaction id|reference|ref|referencia)$/,
  iou: /^(iou|ious)$/,
  date: /^(date|data|fecha|datum|booking date|transaction date)$/,
  description: /^(description|descricao|payee|name|merchant|details|descritivo)$/,
  amount: /^(amount|valor|montante|value|quantia|importe|betrag)$/,
  type: /^(type|tipo)$/,
  account: /^(account|conta|account name)$/,
  category: /^(category|categoria|tags|tag)$/,
  memo: /^(memo|note|notes|nota|notas|observacoes)$/,
  currency: /^(currency|moeda)$/,
};

// Maps each import field to a column index (or -1) from the header names.
export function guessMapping(header) {
  const names = header.map((h) => normalize(h));
  return Object.fromEntries(IMPORT_FIELDS.map((f) => [f, names.findIndex((n) => HEADER_HINTS[f].test(n))]));
}

// Turns CSV rows into transactions. Accounts and categories are matched by name (case and accents
// ignored); unknown ones are listed for creation. Rows that already exist (same account, date,
// amount and description, counted with multiplicity) are skipped as duplicates.
export function importRows(rows, { mapping, dateFormat, decimal, defaultAccountId }, ctx) {
  const byName = (list) => new Map(list.map((x) => [normalize(x.name), x]));
  const accounts = byName(ctx.accounts);
  // A caller importing several files shares one resolver, so a category is only created once.
  const resolver = ctx.resolver ?? categoryResolver(ctx.categories, ctx.id);
  const createdBefore = resolver.created.length;
  const newAccounts = new Map();
  const key = (t) => `${t.accountId}|${t.date}|${t.amount}|${normalize(t.description)}`;
  const existing = new Map();
  for (const t of ctx.transactions) existing.set(key(t), (existing.get(key(t)) ?? 0) + 1);

  const cell = (r, f) => (mapping[f] >= 0 ? String(r[mapping[f]] ?? '').trim() : '');
  const transactions = [];
  const legs = []; // transfer rows, linked in pairs at the end
  const iouRows = []; // rows with an IOU column, turned into people and entries at the end
  const errors = [];
  let duplicates = 0;

  rows.forEach((r, i) => {
    const line = i + 2; // 1-based, after the header row
    const date = parseDate(cell(r, 'date'), dateFormat);
    if (!date) { errors.push({ line, message: `date “${cell(r, 'date')}” is not ${dateFormat.toUpperCase()}` }); return; }
    let amount = parseAmount(cell(r, 'amount'), decimal);
    if (Number.isNaN(amount)) { errors.push({ line, message: `amount “${cell(r, 'amount')}” is not a number` }); return; }
    const type = normalize(cell(r, 'type'));
    // Transfer rows ("transfer", "transferencia") keep their own sign: out is negative, in is positive.
    const isTransfer = /transfer/.test(type);
    const isRefund = /refund|reembolso|devolucao/.test(type);
    if (!isTransfer && /expense|debit|despesa|withdrawal|payment/.test(type)) amount = -Math.abs(amount);
    else if (!isTransfer && (isRefund || /income|credit|receita|deposit/.test(type))) amount = Math.abs(amount);

    const accountName = cell(r, 'account');
    let accountId = defaultAccountId;
    if (accountName) {
      const found = accounts.get(normalize(accountName)) ?? newAccounts.get(normalize(accountName));
      if (found) accountId = found.id;
      else {
        const cur = cell(r, 'currency').toUpperCase();
        const created = { id: ctx.id(), name: accountName, type: 'checking', currency: CURRENCIES.includes(cur) ? cur : BASE, archived: false };
        newAccounts.set(normalize(accountName), created);
        accountId = created.id;
      }
    }
    if (!accountId) { errors.push({ line, message: 'no account, and no default account chosen' }); return; }

    const description = cell(r, 'description') || '(no description)';
    // Several categories are separated by commas; each may be a "Parent / Child" path. Transfers
    // carry none. Without any, the rules pick one.
    const names = cell(r, 'category').split(',').map((s) => s.trim()).filter(Boolean);
    const categoryIds = isTransfer ? []
      : names.length ? [...new Set(names.map((n) => resolver.resolve(n).id))]
        : [categorize(description, ctx.rules)].filter(Boolean);

    const tx = {
      accountId, date, description, amount, categoryIds,
      memo: cell(r, 'memo'), rate: null,
      ...(isRefund ? { kind: 'refund' } : {}),
    };
    const k = key(tx);
    if (existing.get(k)) { existing.set(k, existing.get(k) - 1); duplicates += 1; return; }
    const row = { id: ctx.id(), ...tx };
    transactions.push(row);
    if (isTransfer) legs.push({ tx: row, ref: cell(r, 'reference') });
    if (mapping.iou >= 0) {
      const shares = parseBuxferIou(r[mapping.iou]);
      if (shares.length) iouRows.push({ tx: row, shares, type: iouType(cell(r, 'type'), row.amount) });
    }
  });

  // Link transfer legs: by the file's shared reference when it has one (Buxfer gives both sides the
  // same id), otherwise by date, description and opposite amounts.
  const groups = new Map();
  for (const leg of legs) {
    const g = leg.ref ? `ref:${leg.ref}` : `${leg.tx.date}|${Math.abs(leg.tx.amount)}|${normalize(leg.tx.description)}`;
    if (!groups.has(g)) groups.set(g, { byRef: Boolean(leg.ref), txs: [] });
    groups.get(g).txs.push(leg.tx);
  }
  let linkedTransfers = 0;
  for (const { byRef, txs } of groups.values()) linkedTransfers += linkPairs(txs, ctx.id, byRef);
  const unpairedTransfers = legs.length - linkedTransfers * 2;

  // IOU column: people matched by name (created when new), one entry per share, linked to its row.
  const peopleByName = new Map((ctx.people ?? []).map((p) => [normalize(p.name), p]));
  const newPeople = [];
  const ious = [];
  for (const { tx, shares, type } of iouRows) {
    for (const { name, amount } of shares) {
      let person = peopleByName.get(normalize(name));
      if (!person) { person = { id: ctx.id(), name }; peopleByName.set(normalize(name), person); newPeople.push(person); }
      ious.push({ id: ctx.id(), personId: person.id, date: tx.date, description: tx.description, amount: amount * iouSign(tx.amount), transactionId: tx.id, kind: type });
    }
  }

  return {
    transactions, errors, duplicates, linkedTransfers, unpairedTransfers, newPeople, ious,
    newAccounts: [...newAccounts.values()], newCategories: resolver.created.slice(createdBefore),
  };
}

// Pairs money out with money in from a group of candidate legs, each pair in two different accounts.
// With `anyAmount`, the amounts may differ (a cross-currency transfer under one shared reference);
// otherwise they must be exact opposites. Sets a shared transferId and clears the category.
function linkPairs(group, id, anyAmount) {
  const outs = group.filter((t) => t.amount < 0 && !t.transferId);
  const ins = group.filter((t) => t.amount > 0 && !t.transferId);
  let n = 0;
  for (const out of outs) {
    const match = ins.find((t) => !t.transferId && t.accountId !== out.accountId && (anyAmount || t.amount === -out.amount));
    if (!match) continue;
    const transferId = id();
    for (const t of [out, match]) { t.transferId = transferId; t.categoryIds = []; }
    n += 1;
  }
  return n;
}

// Likely transfers among existing transactions: same date and description, exact opposite amounts,
// different accounts, not linked yet. Returns [out, in] pairs without changing anything.
export function findTransferPairs(transactions) {
  const groups = new Map();
  for (const t of transactions) {
    if (t.transferId || !t.amount) continue;
    const g = `${t.date}|${Math.abs(t.amount)}|${normalize(t.description)}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const pairs = [];
  for (const group of groups.values()) {
    const ins = group.filter((t) => t.amount > 0);
    const used = new Set();
    for (const out of group.filter((t) => t.amount < 0)) {
      const match = ins.find((t) => !used.has(t) && t.accountId !== out.accountId);
      if (match) { used.add(match); pairs.push([out, match]); }
    }
  }
  return pairs;
}

// ── Scheduled (recurring) transactions ───────────────────────────────────────
// A schedule: { id, description, amount (positive minor units), kind: 'expense'|'income'|'transfer',
// accountId, toAccountId (transfers), categoryId, every, unit: 'day'|'week'|'month'|'year',
// anchorDay (day of month to aim for), nextDate, endDate }. Nothing is added by itself: each due
// date is entered or skipped by hand, because amounts like a salary change.

export const UNITS = ['day', 'week', 'month', 'year'];

// "1 month", "30 days", "2 weeks", "1 year" → { every, unit }, or null.
export function parseFrequency(text) {
  const m = normalize(text).match(/^(\d+)\s*(day|week|month|year)s?$/);
  return m ? { every: Number(m[1]), unit: m[2] } : null;
}

export function frequencyLabel({ every, unit }) {
  return every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`;
}

// Adds the interval. Months and years aim for `anchorDay` and fall back to the month's last day,
// so a schedule on the 31st goes Jan 31 → Feb 28 → Mar 31 instead of drifting to the 28th.
export function addInterval(iso, { every, unit }, anchorDay) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (unit === 'day' || unit === 'week') {
    d.setUTCDate(d.getUTCDate() + every * (unit === 'week' ? 7 : 1));
    return d.toISOString().slice(0, 10);
  }
  const months = every * (unit === 'year' ? 12 : 1);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay ?? d.getUTCDate(), lastDay);
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
}

// Dates of a schedule from its next date up to `until` (inclusive), stopping at its end date.
export function occurrences(rec, until, limit = 500) {
  const out = [];
  let date = rec.nextDate;
  while (date && date <= until && (!rec.endDate || date <= rec.endDate) && out.length < limit) {
    out.push(date);
    date = addInterval(date, rec, rec.anchorDay);
  }
  return out;
}

// What one occurrence does to an account's balance (0 if the schedule doesn't touch it).
export function scheduledEffect(rec, accountId) {
  if (rec.kind === 'transfer') {
    if (rec.accountId === accountId) return -rec.amount;
    if (rec.toAccountId === accountId) return rec.amount;
    return 0;
  }
  if (rec.accountId !== accountId) return 0;
  return rec.kind === 'expense' ? -rec.amount : rec.amount;
}

// Balance after everything scheduled up to `until`, including due dates not entered yet.
export function forecast(accountId, balance, schedules, until) {
  return schedules.reduce((sum, rec) => sum + scheduledEffect(rec, accountId) * occurrences(rec, until).length, balance);
}

// The transaction(s) for one occurrence: one row, or two linked legs for a transfer. No rate yet.
export function scheduledTransactions(rec, date, accounts, id = newId) {
  if (rec.kind === 'transfer') {
    const from = accounts.find((a) => a.id === rec.accountId);
    const to = accounts.find((a) => a.id === rec.toAccountId);
    return makeTransfer({ from, to, sent: rec.amount, received: rec.amount, date, description: rec.description }, id);
  }
  return [{
    id: id(), accountId: rec.accountId, date, description: rec.description,
    amount: rec.kind === 'expense' ? -rec.amount : rec.amount,
    categoryIds: rec.categoryId ? [rec.categoryId] : [], memo: '',
  }];
}

// Moves a schedule to its next date after `date` (entering or skipping an occurrence).
export function advanceSchedule(rec) {
  return { ...rec, nextDate: addInterval(rec.nextDate, rec, rec.anchorDay) };
}

// ── Insights ─────────────────────────────────────────────────────────────────
// A transaction's `kind` marks the special ones: 'refund' (money back that cancels part of an
// expense) and 'opening' (an opening balance, which is history, not income or spending).

const iso = (d) => d.toISOString().slice(0, 10);
const utc = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const mondayOf = (s) => { const d = utc(s); return addDays(s, -((d.getUTCDay() + 6) % 7)); };

export const PERIODS = {
  'this-week': 'This week', 'last-week': 'Last week',
  'this-month': 'This month', 'last-month': 'Last month',
  'last-30': 'Last 30 days', 'last-90': 'Last 90 days',
  'this-year': 'This year', 'last-year': 'Last year', 'last-12m': 'Last 12 months',
  all: 'All time', custom: 'Custom',
};

// The dates a preset covers, relative to `today` (weeks start on Monday). `first` is the earliest
// transaction date, for "All time"; `custom` passes its own from/to through.
export function periodRange(preset, today, { from, to, first } = {}) {
  const [y, m] = today.split('-').map(Number);
  const monthStart = (yy, mm) => iso(new Date(Date.UTC(yy, mm - 1, 1)));
  const monthEnd = (yy, mm) => iso(new Date(Date.UTC(yy, mm, 0)));
  switch (preset) {
    case 'this-week': return { from: mondayOf(today), to: addDays(mondayOf(today), 6) };
    case 'last-week': return { from: addDays(mondayOf(today), -7), to: addDays(mondayOf(today), -1) };
    case 'this-month': return { from: monthStart(y, m), to: monthEnd(y, m) };
    case 'last-month': return { from: monthStart(y, m - 1), to: monthEnd(y, m - 1) };
    case 'last-30': return { from: addDays(today, -29), to: today };
    case 'last-90': return { from: addDays(today, -89), to: today };
    case 'this-year': return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'last-year': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case 'last-12m': return { from: monthStart(y, m - 11), to: monthEnd(y, m) };
    case 'all': return { from: first ?? today, to: today };
    default: return { from: from ?? today, to: to ?? today };
  }
}

// Bucket size for the chart: days for a couple of weeks, weeks up to a quarter, months up to two
// years, years beyond.
export function granularity(from, to) {
  const days = (utc(to) - utc(from)) / 864e5 + 1;
  return days <= 14 ? 'day' : days <= 92 ? 'week' : days <= 731 ? 'month' : 'year';
}
const bucketOf = (date, unit) =>
  unit === 'day' ? date : unit === 'week' ? mondayOf(date) : unit === 'month' ? date.slice(0, 7) : date.slice(0, 4);
const nextBucket = (key, unit) => {
  if (unit === 'day') return addDays(key, 1);
  if (unit === 'week') return addDays(key, 7);
  if (unit === 'month') { const [yy, mm] = key.split('-').map(Number); return iso(new Date(Date.UTC(yy, mm, 1))).slice(0, 7); }
  return String(Number(key) + 1);
};

// Income and spending over a period, for some accounts (`accountIds`, a Set) or all (null).
// What counts:
// - Transfers between your accounts and opening balances don't count at all.
// - IOUs are netted out: a transaction counts after its IOU entries, so a loan (money out, they
//   owe it back) counts as nothing, and a shared bill counts only your share.
// - A refund lowers spending (and its category's spending) instead of counting as income.
// - Amounts are in EUR at each transaction's own rate (`rateOf(currency)` when it has none).
// - In the category breakdown a transaction counts under its first category, so the parts add up
//   to the total.
export function insights(transactions, { from, to, accountIds = null, accounts, categories, ious = [], rateOf = () => 1 }) {
  const currency = new Map(accounts.map((a) => [a.id, a.currency]));
  const iouByTx = new Map();
  for (const e of ious) if (e.transactionId) iouByTx.set(e.transactionId, (iouByTx.get(e.transactionId) ?? 0) + e.amount);
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId ?? null]));
  const unit = granularity(from, to);

  const buckets = new Map();
  for (let k = bucketOf(from, unit), guard = 0; k <= bucketOf(to, unit) && guard < 400; k = nextBucket(k, unit), guard += 1) {
    buckets.set(k, { key: k, income: 0, expenses: 0 });
  }
  const spend = new Map(); // top category id (or '') → { amount, children: Map }
  const earn = new Map();
  const add = (map, catId, amount) => {
    const top = catId ? parentOf.get(catId) ?? catId : '';
    const entry = map.get(top) ?? { id: top, amount: 0, children: new Map() };
    entry.amount += amount;
    if (catId && catId !== top) entry.children.set(catId, (entry.children.get(catId) ?? 0) + amount);
    map.set(top, entry);
  };

  let income = 0;
  let expenses = 0;
  let refunds = 0;
  let count = 0;
  for (const t of transactions) {
    if (t.date < from || t.date > to) continue;
    if (accountIds && !accountIds.has(t.accountId)) continue;
    if (t.transferId || t.kind === 'opening') continue;
    const rate = t.rate ?? rateOf(currency.get(t.accountId) ?? 'EUR') ?? 1;
    const eur = Math.round(t.amount * rate) + (iouByTx.get(t.id) ?? 0);
    if (!eur) continue;
    count += 1;
    const cat = categoriesOf(t)[0] ?? null;
    const bucket = buckets.get(bucketOf(t.date, unit));
    if (t.kind === 'refund') {
      expenses -= eur;
      refunds += eur;
      add(spend, cat, -eur);
      if (bucket) bucket.expenses -= eur;
    } else if (eur < 0) {
      expenses -= eur;
      add(spend, cat, -eur);
      if (bucket) bucket.expenses -= eur;
    } else {
      income += eur;
      add(earn, cat, eur);
      if (bucket) bucket.income += eur;
    }
  }
  const ranked = (map) => [...map.values()]
    .map((e) => ({ id: e.id, amount: e.amount, children: [...e.children].map(([id, amount]) => ({ id, amount })).sort((a, b) => b.amount - a.amount) }))
    .filter((e) => e.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
  return {
    from, to, unit, income, expenses, refunds, net: income - expenses, count,
    savingsRate: income > 0 ? (income - expenses) / income : null,
    series: [...buckets.values()],
    spending: ranked(spend),
    earning: ranked(earn),
  };
}

// ── Holding lots (buys and sells) ────────────────────────────────────────────
// A lot is { id, holdingId, date, kind: 'buy'|'sell', quantity, price, fees } with price and fees in
// the holding's currency. A holding with lots takes its quantity from them.

// Units, what they cost, and the average price paid, from a holding's lots. A sell takes units out
// at the average cost at that point, so the remaining cost stays what's still held.
export function lotSummary(lots) {
  let quantity = 0;
  let cost = 0;
  for (const l of [...lots].sort((a, b) => a.date.localeCompare(b.date))) {
    if (l.kind === 'sell') {
      const avg = quantity ? cost / quantity : 0;
      quantity -= l.quantity;
      cost -= avg * l.quantity;
    } else {
      quantity += l.quantity;
      cost += l.quantity * l.price + (l.fees ?? 0);
    }
  }
  quantity = Math.round(quantity * 1e8) / 1e8;
  return { quantity, cost: Math.round(cost * 100), avgPrice: quantity ? cost / quantity : null };
}

// Units held on a date, and the latest price known by then (the last trade's price).
function lotsAt(lots, date) {
  let quantity = 0;
  let price = null;
  for (const l of lots) {
    if (l.date > date) break;
    quantity += l.kind === 'sell' ? -l.quantity : l.quantity;
    price = l.price;
  }
  return { quantity, price };
}

// FT.com portfolio export: "Date,Name,Symbol,Type,Quantity,Price,Price Currency,Fees,...", with
// symbols like "VWCE:FRA:EUR" (ticker, exchange, currency).
export const isFtExport = (header) =>
  /^date,name,symbol,type,quantity,price,price currency,fees/.test(header.map((x) => normalize(x)).join(','));

// FT exchange codes → the exchange's MIC (used to price the listing).
const FT_MIC = { FRA: 'XFRA', GER: 'XETR', LSE: 'XLON', PAR: 'XPAR', AEX: 'XAMS', MIL: 'XMIL', NSQ: 'XNAS', NYQ: 'XNYS', NMQ: 'XNAS', TOR: 'XTSE' };
const FT_EXCHANGE = { FRA: 'Frankfurt', GER: 'Xetra', LSE: 'London', PAR: 'Paris', AEX: 'Amsterdam', MIL: 'Milan', NSQ: 'NASDAQ', NMQ: 'NASDAQ', NYQ: 'NYSE', TOR: 'Toronto' };

// Lots from an FT.com export into one account. Holdings are matched by ticker (Buxfer's "VWCE"
// matches FT's "VWCE:FRA:EUR") or created. Lots already there (same holding, date, kind, units and
// price) are skipped, so the same file can be imported again. Rows that aren't buys or sells
// (dividends) are counted and skipped. Each touched holding's quantity is recalculated from all its
// lots.
export function ftImport(rows, accountId, ctx) {
  const [header, ...body] = rows;
  const col = (name) => header.findIndex((h) => normalize(h) === name);
  const c = { date: col('date'), name: col('name'), symbol: col('symbol'), type: col('type'), qty: col('quantity'), price: col('price'), cur: col('price currency'), fees: col('fees') };
  const holdings = ctx.holdings.filter((x) => x.accountId === accountId);
  const newHoldings = [];
  const newLots = [];
  const skipped = [];
  let duplicates = 0;
  const key = (l) => `${l.holdingId}|${l.date}|${l.kind}|${l.quantity}|${l.price}`;
  const seen = new Set(ctx.lots.map(key));
  const listing = new Map(); // holding id → the exchange FT lists it on

  body.forEach((r, i) => {
    const type = normalize(r[c.type]);
    const kind = /buy/.test(type) ? 'buy' : /sell/.test(type) ? 'sell' : null;
    const [ticker, exch, currency] = String(r[c.symbol] ?? '').split(':');
    const date = parseDate(r[c.date], 'ymd');
    const quantity = Number(r[c.qty]);
    const price = Number(r[c.price]);
    if (!kind) { skipped.push({ line: i + 2, reason: `${r[c.type] || 'empty'} rows aren't buys or sells` }); return; }
    if (!ticker || !date || !(quantity > 0) || !(price >= 0)) { skipped.push({ line: i + 2, reason: 'missing symbol, date, units or price' }); return; }
    let holding = [...holdings, ...newHoldings].find((x) => normalize(x.symbol) === normalize(ticker));
    if (!holding) {
      holding = {
        id: ctx.id(), accountId, symbol: ticker.toUpperCase(), mic: FT_MIC[exch] ?? null, exchange: FT_EXCHANGE[exch] ?? exch ?? null,
        name: r[c.name] || ticker, currency: (r[c.cur] || currency || BASE).toUpperCase(), quantity: 0, price: null, manual: true,
      };
      newHoldings.push(holding);
    }
    if (!listing.has(holding.id)) listing.set(holding.id, { mic: FT_MIC[exch] ?? null, exchange: FT_EXCHANGE[exch] ?? exch ?? null });
    const lot = { id: ctx.id(), holdingId: holding.id, date, kind, quantity, price, fees: Number(r[c.fees]) || 0 };
    if (seen.has(key(lot))) { duplicates += 1; return; }
    seen.add(key(lot));
    newLots.push(lot);
  });

  // Recalculate each touched holding from all its lots. New holdings start at their last trade's
  // price, entered by hand, until a live price is fetched.
  const allLots = [...ctx.lots, ...newLots];
  const touched = new Set(newLots.map((l) => l.holdingId));
  const holdingUpdates = [];
  for (const id of touched) {
    const own = allLots.filter((l) => l.holdingId === id).sort((a, b) => a.date.localeCompare(b.date));
    const { quantity } = lotSummary(own);
    const fresh = newHoldings.find((x) => x.id === id);
    if (fresh) Object.assign(fresh, { quantity, price: fresh.price ?? own.at(-1).price, priceAt: `${own.at(-1).date}T00:00:00.000Z` });
    else {
      // Holdings from Buxfer have no exchange; FT's lets them be priced live.
      const h = holdings.find((x) => x.id === id);
      const where = listing.get(id);
      holdingUpdates.push({ id, quantity, before: h.quantity, ...(!h.mic && where?.mic ? where : {}) });
    }
  }
  return { newHoldings, holdingUpdates, newLots, skipped, duplicates };
}

// ── Net worth over time ──────────────────────────────────────────────────────

// The last day a bucket covers (capped at `to`).
function bucketEnd(key, unit, to) {
  const end = unit === 'day' ? key
    : unit === 'week' ? addDays(key, 6)
      : unit === 'month' ? iso(new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)))
        : `${key}-12-31`;
  return end < to ? end : to;
}

// Net worth (in EUR minor units) at the end of each bucket between `from` and `to`, with the part
// in investment accounts. For each account and date:
// - Ordinary accounts are the sum of their transactions up to that date (each at its own rate).
// - An archived account counts until its last transaction and as nothing after, since it was
//   closed; leftovers on closed accounts are usually gains or losses that were never recorded.
// - An investment account with holdings is worth its holdings today (`holdingsValue(account)`),
//   its latest daily snapshot (market value) on earlier dates that have one, and before that:
//   with lots (buys and sells) for every holding, the units held then times the latest trade price
//   by then; without, what was put in (its transactions), as there's no price history.
// `snapshots` are { date, values: { accountId: EUR minor units } }.
export function netWorthHistory({ accounts, transactions, snapshots = [], holdings = [], lots = [] }, { from, to, today, holdingsValue, rateOf = () => 1 }) {
  const unit = granularity(from, to);
  const ends = [];
  for (let k = bucketOf(from, unit), guard = 0; k <= bucketOf(to, unit) && guard < 400; k = nextBucket(k, unit), guard += 1) {
    ends.push({ key: k, date: bucketEnd(k, unit, to) });
  }
  const byAccount = new Map(accounts.map((a) => [a.id, []]));
  for (const t of transactions) byAccount.get(t.accountId)?.push(t);
  const snaps = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const firstSnapshot = snaps[0]?.date ?? null;
  const lotsOf = new Map();
  for (const l of [...lots].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!lotsOf.has(l.holdingId)) lotsOf.set(l.holdingId, []);
    lotsOf.get(l.holdingId).push(l);
  }
  // The value of an account's holdings on a date from their lots, or null when any holding has none.
  const lotValue = (a, date) => {
    const own = holdings.filter((x) => x.accountId === a.id);
    if (!own.length || own.some((x) => !lotsOf.has(x.id))) return null;
    let total = 0;
    for (const x of own) {
      const { quantity, price } = lotsAt(lotsOf.get(x.id), date);
      if (quantity && price != null) total += Math.round(quantity * price * 100 * (rateOf(x.currency) ?? 1));
    }
    return total;
  };
  const firstLot = (a) => holdings.filter((x) => x.accountId === a.id)
    .map((x) => lotsOf.get(x.id)?.[0]?.date).filter(Boolean).sort()[0] ?? null;

  const points = ends.map(({ key, date }) => ({ key, date, total: 0, investments: 0, byType: {} }));
  for (const a of accounts) {
    const txs = byAccount.get(a.id).sort((x, y) => x.date.localeCompare(y.date));
    const lastDate = txs.at(-1)?.date ?? null;
    const valuedByHoldings = a.type === 'investment' && holdingsValue(a) != null;
    const lotsFrom = valuedByHoldings ? firstLot(a) : null;
    let i = 0;
    let running = 0;
    for (const p of points) {
      while (i < txs.length && txs[i].date <= p.date) {
        const t = txs[i];
        running += Math.round(t.amount * (t.rate ?? rateOf(a.currency) ?? 1));
        i += 1;
      }
      let value = running;
      if (a.archived && lastDate && p.date >= lastDate) value = 0;
      else if (valuedByHoldings) {
        if (p.date >= today) value = holdingsValue(a);
        else if (firstSnapshot && p.date >= firstSnapshot && snaps.filter((s) => s.date <= p.date).at(-1)?.values?.[a.id] != null) {
          value = snaps.filter((s) => s.date <= p.date).at(-1).values[a.id];
        } else if (lotsFrom && p.date >= lotsFrom) {
          value = lotValue(a, p.date) ?? value;
        }
      }
      if (!value) continue;
      p.total += value;
      p.byType[a.type] = (p.byType[a.type] ?? 0) + value;
      if (a.type === 'investment') p.investments += value;
    }
  }
  return { unit, points, firstSnapshot };
}

// What had been put into an investment account by each date, in EUR minor units: from its holdings'
// buys and sells when every holding has them (their cost, sells at average cost), otherwise the sum
// of the money moved into the account (its transactions).
export function investedHistory(account, { transactions, holdings, lots }, dates, rateOf = () => 1) {
  const own = holdings.filter((x) => x.accountId === account.id);
  const lotsOf = (id) => lots.filter((l) => l.holdingId === id);
  const byLots = own.length > 0 && own.every((x) => lotsOf(x.id).length);
  const txs = transactions.filter((t) => t.accountId === account.id && t.kind !== 'opening');
  return dates.map((d) => {
    if (byLots) {
      return own.reduce((sum, x) => sum + Math.round(lotSummary(lotsOf(x.id).filter((l) => l.date <= d)).cost * (rateOf(x.currency) ?? 1)), 0);
    }
    return txs.filter((t) => t.date <= d).reduce((sum, t) => sum + Math.round(t.amount * (t.rate ?? rateOf(account.currency) ?? 1)), 0);
  });
}

// ── IOUs ─────────────────────────────────────────────────────────────────────
// A person is { id, name }. An IOU entry is { id, personId, date, description, amount, transactionId, kind }:
// a positive amount means they owe you more, a negative one that they owe you less (or that you owe
// them). An entry can be linked to the transaction that moved the money, or stand alone (cash).

// Buxfer's IOU transaction types, kept on each entry so its transaction can show what it was.
export const IOU_TYPES = { loan: 'Loan', settlement: 'Settlement', paid_for_friend: 'Paid for friend', shared_bill: 'Shared bill' };

// The everyday cases: how the money moves in your account, what it does to the IOU, and its type.
export const IOU_KINDS = {
  lent: { label: 'I lent them money', account: -1, iou: 1, type: 'loan' },
  paidfor: { label: 'I paid for them', account: -1, iou: 1, type: 'paid_for_friend' },
  repaid: { label: 'They paid me back', account: 1, iou: -1, type: 'settlement' },
  borrowed: { label: 'I borrowed from them', account: 1, iou: -1, type: 'loan' },
  payback: { label: 'I paid them back', account: -1, iou: 1, type: 'settlement' },
};

// The IOU type of a Buxfer transaction type, or from the direction of the money when it isn't one.
export function iouType(buxferType, transactionAmount) {
  const t = normalize(buxferType).replace(/\s+/g, '_');
  if (t in IOU_TYPES) return t;
  return transactionAmount < 0 ? 'loan' : 'settlement';
}

// Balance per person id: positive, they owe you; negative, you owe them.
export function personBalances(ious) {
  const out = new Map();
  for (const e of ious) out.set(e.personId, (out.get(e.personId) ?? 0) + e.amount);
  return out;
}

// One person's entries, newest first, each with the balance right after it.
export function personHistory(personId, ious) {
  let balance = 0;
  return ious
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.personId === personId)
    .sort((a, b) => a.e.date.localeCompare(b.e.date) || a.i - b.i)
    .map(({ e }) => ({ ...e, balance: (balance += e.amount) }))
    .reverse();
}

// Buxfer's IOU column: "Íris/Sérgio: 9.000,00" or "Pedro Ivo: 2,50; Gonçalo Ribeiro: 2,50".
// Amounts use a decimal comma and are unsigned. Returns [{ name, amount }] in minor units.
export function parseBuxferIou(text) {
  return String(text ?? '').split(';').map((part) => part.match(/^\s*(.+?):\s*([-\d.,]+)\s*$/))
    .filter(Boolean)
    .map(([, name, amount]) => ({ name: name.trim(), amount: Math.abs(parseAmount(amount, ',')) }))
    .filter((x) => x.amount > 0);
}

// The IOU side of a Buxfer transaction: money out of your account (a loan, a shared bill, paying for
// a friend) means they owe you that share; money in (a settlement) means they owe you less.
export const iouSign = (transactionAmount) => (transactionAmount < 0 ? 1 : -1);

// ── Buxfer export ────────────────────────────────────────────────────────────

// Which Buxfer export a CSV is, from its header row.
export function detectBuxferFile(header) {
  const h = header.map((x) => normalize(x)).join(',');
  if (h.startsWith('name,balance,type,currency')) return 'accounts';
  if (h.startsWith('account,symbol,value,quantity,price')) return 'investments';
  if (h.startsWith('id,date,description,currency,amount,type')) return 'transactions';
  if (h.startsWith('tag name')) return 'tags';
  if (h.startsWith('description,due date,frequency')) return 'reminders';
  return null;
}

// Buxfer reminders → schedules. The STOP DATE column is ignored: in real exports it holds dates
// before the reminder's own next due date while payments carry on, so it isn't an end date.
// Income amounts can be exported negative; the sign comes from the type. Transfers name both
// accounts as "From > To". Reminders that already exist (same description and account) are skipped.
function buxferReminders(rows, accountByName, resolver, existing, id) {
  const schedules = [];
  const skipped = [];
  const seen = new Set(existing.map((s) => `${normalize(s.description)}|${s.accountId}`));
  rows.slice(1).forEach((r, i) => {
    const [description, due, frequency, , type, amount, account, tags] = r;
    const freq = parseFrequency(frequency);
    const kind = { expense: 'expense', income: 'income', transfer: 'transfer' }[normalize(type)];
    const [fromName, toName] = String(account).split('>').map((s) => s.trim());
    const from = accountByName.get(normalize(fromName ?? ''));
    const to = toName ? accountByName.get(normalize(toName)) : null;
    const reason =
      !freq ? `frequency “${frequency}” not understood`
      : !kind ? `type “${type}” not understood`
      : !fromName ? 'no account in Buxfer'
      : !from || (kind === 'transfer' && !to) ? `account “${account}” not found`
      : !parseDate(due, 'ymd') ? `due date “${due}” not understood`
      : null;
    if (reason) { skipped.push({ line: i + 2, description, reason }); return; }
    if (seen.has(`${normalize(description)}|${from.id}`)) return;
    let categoryId = null;
    const tag = String(tags ?? '').split(',')[0].trim();
    if (tag && kind !== 'transfer') {
      categoryId = resolver.resolve(tag).id;
    }
    const nextDate = parseDate(due, 'ymd');
    schedules.push({
      id: id(), description, amount: Math.abs(parseAmount(amount, '.')), kind,
      accountId: from.id, toAccountId: to?.id ?? null, categoryId,
      every: freq.every, unit: freq.unit, anchorDay: Number(nextDate.slice(8, 10)), nextDate, endDate: null,
    });
  });
  return { schedules, skipped };
}

const buxferType = (t) => {
  const s = normalize(t);
  if (s.startsWith('investment')) return 'investment'; // also "Investment - 401K"
  return { 'credit card': 'credit', checking: 'checking', cash: 'cash', savings: 'savings' }[s] ?? 'checking';
};

const dayBefore = (iso) => new Date(Date.parse(iso) - 864e5).toISOString().slice(0, 10);

// Imports a Buxfer export: `files` holds the parsed rows (header first) of accounts.csv,
// transactions.csv and investments.csv (any may be missing). Accounts get their Buxfer type and
// currency; accounts that only appear in transactions are archived ones in Buxfer and come in archived.
// Holdings come from investments.csv with Buxfer's prices. With `openingBalances`, an account whose
// transactions don't add up to its Buxfer balance (history before the export, a starting balance)
// gets one "Opening balance" transaction for the difference. Running it twice adds nothing new.
export function buxferImport(files, ctx, { openingBalances = true } = {}) {
  const byName = new Map(ctx.accounts.map((a) => [normalize(a.name), a]));
  const newAccounts = [];
  const balances = new Map(); // account id → Buxfer balance (minor units)

  for (const r of (files.accounts ?? []).slice(1)) {
    const [name, balance, type, currency] = r;
    let account = byName.get(normalize(name));
    if (!account) {
      account = { id: ctx.id(), name, type: buxferType(type), currency: CURRENCIES.includes(currency) ? currency : BASE, archived: false };
      newAccounts.push(account);
      byName.set(normalize(name), account);
    }
    balances.set(account.id, parseAmount(balance, '.'));
  }
  const knownAccounts = [...ctx.accounts, ...newAccounts];

  // One resolver for every file, so a category is created once. tags.csv comes first: it holds the
  // whole tree ("Banco", "Banco / Comissões e Despesas"), including categories no transaction uses.
  const resolver = categoryResolver(ctx.categories, ctx.id);
  for (const [name] of (files.tags ?? []).slice(1)) if (name?.trim()) resolver.resolve(name);

  let tx = { transactions: [], errors: [], duplicates: 0, linkedTransfers: 0, unpairedTransfers: 0, newAccounts: [], newCategories: [], newPeople: [], ious: [] };
  if (files.transactions?.length > 1) {
    const [header, ...body] = files.transactions;
    tx = importRows(body, {
      mapping: guessMapping(header), dateFormat: 'ymd', decimal: '.', defaultAccountId: null,
    }, { ...ctx, accounts: knownAccounts, resolver });
    for (const a of tx.newAccounts) a.archived = true; // not in accounts.csv: archived in Buxfer
  }
  const allAccounts = [...knownAccounts, ...tx.newAccounts];
  const accountByName = new Map(allAccounts.map((a) => [normalize(a.name), a]));

  // Holdings: one per account and symbol (Buxfer lists each purchase lot separately).
  const lots = new Map();
  for (const r of (files.investments ?? []).slice(1)) {
    const [accountName, symbol, value, quantity, , description] = r;
    const account = accountByName.get(normalize(accountName));
    if (!account) continue;
    const key = `${account.id}|${symbol}`;
    const lot = lots.get(key) ?? { account, symbol, name: description?.trim() || symbol, quantity: 0, value: 0 };
    lot.quantity += Number(quantity);
    lot.value += Number(value);
    lots.set(key, lot);
  }
  const newHoldings = [];
  const holdingUpdates = [];
  const pricedAt = `${ctx.today}T00:00:00.000Z`;
  for (const lot of lots.values()) {
    const price = lot.quantity ? lot.value / lot.quantity : 0;
    const existing = ctx.holdings.find((x) => x.accountId === lot.account.id && x.symbol === lot.symbol);
    const fields = { quantity: lot.quantity, price, priceAt: pricedAt, manual: true };
    // A holding with lots (from an FT.com import) keeps the quantity its lots add up to.
    const hasLots = (ctx.lots ?? []).some((l) => l.holdingId === existing?.id);
    if (existing) holdingUpdates.push({ id: existing.id, ...fields, ...(hasLots ? { quantity: existing.quantity } : {}) });
    else newHoldings.push({ id: ctx.id(), accountId: lot.account.id, symbol: lot.symbol, name: lot.name, currency: lot.account.currency, ...fields });
  }

  // Compare every account in accounts.csv with Buxfer, and add opening balances where they differ.
  const allTx = [...ctx.transactions, ...tx.transactions];
  const holdingsAfter = [
    ...ctx.holdings.map((x) => ({ ...x, ...holdingUpdates.find((u) => u.id === x.id) })),
    ...newHoldings,
  ];
  const reconciliation = [];
  const openings = [];
  for (const [accountId, buxfer] of balances) {
    const account = allAccounts.find((a) => a.id === accountId);
    const own = allTx.filter((t) => t.accountId === accountId);
    const valued = account.type === 'investment' && holdingsAfter.some((x) => x.accountId === accountId);
    let ours = valued
      ? holdingsAfter.filter((x) => x.accountId === accountId).reduce((s, x) => s + Math.round(x.quantity * x.price * 100), 0)
      : own.reduce((s, t) => s + t.amount, 0);
    const diff = buxfer - ours;
    let opening = 0;
    if (!valued && diff !== 0 && openingBalances) {
      const first = own.map((t) => t.date).sort()[0] ?? ctx.today;
      openings.push({
        id: ctx.id(), accountId, date: dayBefore(first), description: 'Opening balance (from Buxfer)', kind: 'opening',
        amount: diff, categoryIds: [], memo: '', rate: null,
      });
      opening = diff;
      ours += diff;
    }
    // Holdings are rounded to the cent one by one, so allow a cent per holding.
    const tolerance = valued ? holdingsAfter.filter((x) => x.accountId === accountId).length : 0;
    reconciliation.push({ accountId, name: account.name, currency: account.currency, buxfer, ours, opening, valued, matches: Math.abs(buxfer - ours) <= tolerance });
  }

  let reminders = { schedules: [], skipped: [] };
  if (files.reminders?.length > 1) {
    reminders = buxferReminders(files.reminders, accountByName, resolver, ctx.schedules ?? [], ctx.id);
  }

  return {
    newAccounts: [...newAccounts, ...tx.newAccounts],
    newCategories: resolver.created,
    newPeople: tx.newPeople, ious: tx.ious,
    schedules: reminders.schedules, skippedReminders: reminders.skipped,
    transactions: [...tx.transactions, ...openings],
    newHoldings, holdingUpdates, reconciliation,
    openings: openings.length, duplicates: tx.duplicates, errors: tx.errors,
    linkedTransfers: tx.linkedTransfers, unpairedTransfers: tx.unpairedTransfers,
    imported: tx.transactions.length,
  };
}

export function defaultState() {
  const ids = ['meals', 'groceries', 'transport', 'salary', 'rent', 'utilities', 'fun', 'health'];
  const names = ['Meals', 'Groceries', 'Transport', 'Salary', 'Rent', 'Utilities', 'Entertainment', 'Health'];
  return {
    version: 1,
    settings: { quoteApiKey: '' },
    accounts: [],
    transactions: [],
    holdings: [],
    schedules: [],
    people: [],
    ious: [],
    snapshots: [],
    lots: [],
    categories: ids.map((id, i) => ({ id, name: names[i], parentId: null })),
    rules: [
      { id: 'r-lunch', pattern: 'lunch', match: 'contains', categoryId: 'meals' },
      { id: 'r-dinner', pattern: 'dinner', match: 'contains', categoryId: 'meals' },
      { id: 'r-uber', pattern: 'uber', match: 'contains', categoryId: 'transport' },
    ],
    rates: {},
  };
}

export const newId = () => crypto.randomUUID();
