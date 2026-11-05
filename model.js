// Finance model. No DOM, no I/O. Money is stored as integer minor units (cents) so sums never drift.
// Every amount lives in its account's currency; `amountBase` is the same amount in the base currency (EUR),
// converted with the rate of the transaction date and frozen at that point.

export const BASE = 'EUR';
export const CURRENCIES = ['EUR', 'USD'];
// Order is the order of the groups in the side panel.
export const ACCOUNT_TYPES = ['cash', 'checking', 'credit', 'investment', 'loan', 'savings'];
export const ACCOUNT_TYPE_LABELS = {
  cash: 'Cash', checking: 'Checking', credit: 'Credit card', investment: 'Investment', loan: 'Loan', savings: 'Savings',
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

// A transaction split across categories has `splits`: [{ categoryId, amount }], amounts in the
// account's currency with the transaction's sign, adding up to its amount. Its categoryIds are the
// parts' categories (so filters find it), and Insights count each part under its own category.
export const splitsOf = (t) => (Array.isArray(t.splits) && t.splits.length ? t.splits : null);

// Parts scaled to a new total (the amount was edited): each keeps its share; rounding goes to the last.
export function scaleSplits(splits, total) {
  const before = splits.reduce((s, p) => s + p.amount, 0);
  let used = 0;
  return splits.map((p, i) => {
    const amount = i === splits.length - 1 ? total - used
      : before ? Math.round((p.amount * total) / before) : 0;
    used += amount;
    return { ...p, amount };
  });
}

// Category ids sorted so parents come before their children and each family stays together.
export function sortedCategories(categories) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const top = categories.filter((c) => !c.parentId || !categories.some((p) => p.id === c.parentId)).sort(byName);
  return top.flatMap((p) => [p, ...categories.filter((c) => c.parentId === p.id).sort(byName)]);
}

// Categories matching what's typed, for a category search box. Every word must appear in the
// category's path ("Parent / Child", case and accents ignored), so "food gro" finds "Food /
// Groceries" and a parent's name finds its children too. Names that start with the text come first,
// then the rest in list order. An empty query lists them all. `exclude` holds ids already picked.
export function searchCategories(categories, query, exclude = []) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const skip = new Set(exclude);
  const found = sortedCategories(categories).filter((c) => !skip.has(c.id)).map((c, order) => {
    const path = normalize(categoryPath(c, categories));
    return { c, order, path, starts: words.length > 0 && normalize(c.name).startsWith(words.join(' ')) };
  }).filter((x) => words.every((w) => x.path.includes(w)));
  return found.sort((a, b) => (b.starts - a.starts) || (a.order - b.order)).map((x) => x.c);
}

// ── Account settings by type ─────────────────────────────────────────────────

// What an investment account is: pensions and retirement savings are locked away until later, so
// net worth also shows what's within reach without them.
export const INVESTMENT_KINDS = { brokerage: 'Brokerage', pension: 'Pension', retirement: 'Retirement savings', crypto: 'Crypto', other: 'Other' };
export const LOCKED_KINDS = new Set(['pension', 'retirement']);

// A day of the month on a given month, or its last day when the month is shorter (the 31st in June
// is the 30th). `ym` is "YYYY-MM".
const dayIn = (ym, day) => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(Math.min(day, last)).padStart(2, '0')}`;
};
const monthAfter = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

// A credit card's latest statement: the last statement day on or before `today`.
export function lastStatementDate(today, statementDay) {
  const here = dayIn(today.slice(0, 7), statementDay);
  return here <= today ? here : dayIn(monthAfter(today.slice(0, 7), -1), statementDay);
}

// The payment due day that follows a statement: the first `dueDay` after it (the same month when it
// comes later in the month, else the next).
export function dueAfter(statement, dueDay) {
  const here = dayIn(statement.slice(0, 7), dueDay);
  return here > statement ? here : dayIn(monthAfter(statement.slice(0, 7), 1), dueDay);
}

// A balance going forward: `items` ({ date, amount }) change it in date order. The lowest point it
// reaches, and the first date it goes below `threshold` (null when it never does).
export function balanceDip(balance, items, threshold) {
  let run = balance;
  let lowest = { date: null, balance };
  let below = balance < threshold ? { date: null, balance } : null;
  for (const it of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    run += it.amount;
    if (run < lowest.balance) lowest = { date: it.date, balance: run };
    if (!below && run < threshold) below = { date: it.date, balance: run };
  }
  return { lowest, below };
}

// Interest a savings balance earns: a month's worth at `rate` percent a year, and each payment's
// when it's paid every `months` months (simple interest). `tax` is the percent withheld from each
// payment: the amounts are what arrives, after it; `gross` has them before.
export function savingsInterest(balance, rate, months = 1, tax = 0) {
  const gross = balance > 0 ? (balance * rate) / 100 / 12 : 0;
  const net = gross * (1 - (tax || 0) / 100);
  const amounts = (m) => ({ monthly: Math.round(m), perPayment: Math.round(m * months), yearly: Math.round(m * 12) });
  return { ...amounts(net), gross: amounts(gross) };
}

// The interest a loan charges in a month on what's owed (a negative balance), at `rate` % a year.
export const loanInterest = (balance, rate) => (balance < 0 ? Math.round((-balance * rate) / 100 / 12) : 0);

// A loan paid off month by month, as banks work it out: each month interest is added on what's owed
// (`rate` % a year, a twelfth of it; or a function of the payment's date, for rates that change), then
// the payment comes off. `owed` and payments in minor units;
// `lump` is paid at once today, `extra` on top of every payment; `first` is the first payment's date.
// Returns { months, interest, paid, end, points: [{ date, owed }] }, or { never: true, due } when the
// payment doesn't cover a month's interest (`due`), so the loan would never end.
export function loanPlan({ owed, rate, payment, extra = 0, lump = 0, first, start = first }) {
  const rateOn = typeof rate === 'function' ? rate : () => rate;
  const pay = payment + extra;
  let left = Math.max(0, owed - lump);
  const points = [{ date: start, owed: left }];
  const anchor = Number(first.slice(8, 10));
  let date = first;
  let interest = 0;
  let paid = 0;
  let months = 0;
  while (left > 0) {
    const due = Math.round((left * rateOn(date)) / 1200);
    if (pay <= due || months >= 1200) return { never: true, due };
    const p = Math.min(pay, left + due);
    interest += due;
    paid += p;
    left = left + due - p;
    months += 1;
    points.push({ date, owed: left });
    if (left > 0) date = addInterval(date, { every: 1, unit: 'month' }, anchor);
  }
  return { months, interest, paid, end: months ? date : null, points };
}

// A loan's interest rate on a date: the latest change dated by then that sets one (`loanChanges`,
// [{ date, rate?, payments?, payment? }]), else the rate it was added with.
export function loanRateAt(account, date) {
  const set = (account.loanChanges ?? []).filter((c) => c.rate != null && c.date <= date)
    .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  return set ? set.rate : account.interestRate ?? 0;
}

// Where a loan stands on `today` against what was agreed: `loanPayments` monthly payments from
// `loanFirst`, the term reset by any change that sets the payments left (`payments`: how many from
// its date on, after an early repayment that shortened it, say). Returns { made, left, next, end }:
// payments due by today, payments still to make, the next one's date and the last one's; null
// without an agreed term.
export function loanTerm(account, today) {
  const { loanPayments: total, loanFirst: first } = account;
  if (!total || !first) return null;
  const resets = (account.loanChanges ?? []).filter((c) => c.payments != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const anchor = Number(first.slice(8, 10));
  const step = (d) => addInterval(d, { every: 1, unit: 'month' }, anchor);
  let left = total;
  let made = 0;
  let date = first;
  let r = 0;
  for (;;) {
    // Changes dated up to this payment set how many are left from it on.
    while (r < resets.length && resets[r].date <= date) left = resets[r++].payments;
    if (left <= 0 || date > today) break;
    made += 1;
    left -= 1;
    date = step(date);
  }
  // Resets dated after the last payment due (but by today) still count.
  while (r < resets.length && resets[r].date <= today) left = resets[r++].payments;
  if (left <= 0) return { made, left: 0, next: null, end: null };
  let end = date;
  for (let k = 1; k < left; k += 1) end = step(end);
  return { made, left, next: date, end };
}

// The monthly payment that pays `owed` off in `months` at `rate` % a year (rounded up to the cent,
// so the last payment is never more than the others).
export function annuityPayment(owed, rate, months) {
  if (months <= 0 || owed <= 0) return 0;
  const i = rate / 1200;
  return Math.ceil(i === 0 ? owed / months : (owed * i) / (1 - (1 + i) ** -months));
}

// Interest a loan has cost so far, estimated from its balance: what was owed at the start of each
// whole month since its first transaction, at `rate` % a year (or a function of the month's first
// day). `transactions` are the loan's own.
export function loanInterestSoFar(transactions, rate, today) {
  const rateOn = typeof rate === 'function' ? rate : () => rate;
  if (!transactions.length) return 0;
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  let month = `${sorted[0].date.slice(0, 7)}-01`;
  const thisMonth = `${today.slice(0, 7)}-01`;
  let k = 0;
  let balance = 0;
  let total = 0;
  // Months that started after the first transaction and have ended by today.
  month = addInterval(month, { every: 1, unit: 'month' }, 1);
  while (month < thisMonth) {
    while (k < sorted.length && sorted[k].date < month) balance += sorted[k++].amount;
    // What was owed through the month: at its start, before that month's payments.
    if (balance < 0) total += Math.round((-balance * rateOn(month)) / 1200);
    month = addInterval(month, { every: 1, unit: 'month' }, 1);
  }
  return total;
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
  if (row.sign === 't') {
    if (!row.toAccountId) return { error: 'needs an account to transfer to' };
    if (row.toAccountId === row.accountId) return { error: 'transfers to the same account' };
    return { transfer: { fromId: row.accountId, toId: row.toAccountId, date: row.date, description, sent: toMinor(raw) } };
  }
  return {
    tx: {
      accountId: row.accountId,
      date: row.date,
      description,
      // sign: '-' expense, '+' income, 'r' refund (money back that cancels part of an expense);
      // 't' is a transfer, returned as { transfer } above
      amount: toMinor(raw) * (row.sign === '-' ? -1 : 1),
      // The categories picked, or else the one the rules pick.
      categoryIds: row.categoryIds?.length ? [...row.categoryIds] : [categorize(description, rules)].filter(Boolean),
      memo: '',
      ...(row.sign === 'r' ? { kind: 'refund' } : {}),
    },
  };
}

// ── Search and filters ───────────────────────────────────────────────────────

// Transactions matching a filter, newest first. Every field is optional:
// - text: in the description or memo (case and accents ignored); a number like "12.99" or "12,99"
//   also matches that amount, in or out
// - categoryIds: any of these categories (a parent includes its children); '' among them also
//   takes uncategorized ones (transfers aside)
// - types: any of 'expense' | 'income' | 'refund' | 'dividend' | 'transfer'
// - min / max: the amount's size (ignoring its sign), in the account's currency
// - from / to: dates; accountIds: any of these accounts
// An empty list doesn't filter (all categories, types or accounts). Same rules as fin_match in schema.sql.
const TYPE_TEST = {
  transfer: (t) => Boolean(t.transferId),
  refund: (t) => t.kind === 'refund',
  dividend: (t) => t.kind === 'dividend',
  expense: (t) => !t.transferId && t.kind !== 'refund' && t.amount < 0,
  income: (t) => !t.transferId && t.kind !== 'refund' && t.amount > 0,
};
export function filterTransactions(transactions, filter, { categories = [] } = {}) {
  const { text = '', categoryIds = [], types = [], min = null, max = null, from = null, to = null, accountIds = [] } = filter;
  const q = normalize(text);
  const asAmount = /^[\d.,]+$/.test(String(text).trim()) ? Math.abs(parseAmount(text, /,\d{1,2}$/.test(text.trim()) ? ',' : '.')) : NaN;
  const chosen = categoryIds.filter(Boolean);
  const uncategorized = categoryIds.includes('');
  const wanted = new Set([...chosen, ...categories.filter((c) => chosen.includes(c.parentId)).map((c) => c.id)]);
  const accounts = new Set(accountIds);
  const minMinor = min == null || min === '' ? null : toMinor(min);
  const maxMinor = max == null || max === '' ? null : toMinor(max);
  return transactions.filter((t) => {
    if (accounts.size && !accounts.has(t.accountId)) return false;
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    const size = Math.abs(t.amount);
    if (minMinor != null && size < minMinor) return false;
    if (maxMinor != null && size > maxMinor) return false;
    if (types.length && !types.some((k) => TYPE_TEST[k]?.(t))) return false;
    const cats = categoriesOf(t);
    if (categoryIds.length && !cats.some((id) => wanted.has(id)) && !(uncategorized && !cats.length && !t.transferId)) return false;
    if (q && !normalize(t.description).includes(q) && !normalize(t.memo ?? '').includes(q) && size !== asAmount) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date));
}

// After a transaction is categorized by hand: a rule worth offering ("always put X in Y"), or null
// when the rules would already pick that category. The rule matches the whole description; `others`
// counts uncategorized transactions with the same description that it would fill in too.
export function ruleSuggestion(t, categoryId, rules, transactions) {
  if (!categoryId || t.transferId || !t.description?.trim()) return null;
  if (categorize(t.description, rules) === categoryId) return null;
  const key = normalize(t.description);
  const others = transactions.filter((x) => x.id !== t.id && !x.transferId && normalize(x.description) === key && !categoriesOf(x).length).length;
  return { pattern: t.description.trim(), match: 'equals', categoryId, others };
}

// Rules worth adding, learnt from how transactions are already categorized. Transactions (not
// transfers, openings or splits) are grouped by description with numbers left out, so "CARD 1234
// GROCER" and "CARD 5678 GROCER" go together. A group whose descriptions are all the same becomes an
// "is exactly" rule; otherwise a "contains" rule with the longest run of whole words they all share
// (with four letters at least: "grocer"). A rule is kept when, over every categorized transaction it
// would match, at least `min` share its category and that's at least `share` of them, and when the
// existing rules don't already pick that category. Each: { pattern, match, categoryId, count
// (matching ones in that category), total (matching categorized ones), others (uncategorized ones it
// would fill) }, most used first.
export function rulesFromHistory(transactions, rules, { min = 3, share = 0.9 } = {}) {
  const keyOf = (d) => normalize(d).replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
  const letters = (x) => normalize(x).replace(/[^\p{L}]/gu, '').length;
  // Distinct descriptions, with how their transactions are categorized.
  const byText = new Map();
  for (const t of transactions) {
    if (t.transferId || t.kind === 'opening' || splitsOf(t) || !t.description?.trim()) continue;
    const norm = normalize(t.description).replace(/\s+/g, ' ');
    const e = byText.get(norm) ?? { norm, text: t.description.trim(), cats: new Map(), none: 0 };
    const first = categoriesOf(t)[0];
    if (first) e.cats.set(first, (e.cats.get(first) ?? 0) + 1); else e.none += 1;
    byText.set(norm, e);
  }
  const texts = [...byText.values()];
  const groups = new Map();
  for (const e of texts) {
    const key = keyOf(e.norm);
    if (letters(key) < 3) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  const seen = new Set();
  for (const list of groups.values()) {
    const cats = new Map();
    for (const e of list) for (const [c, n] of e.cats) cats.set(c, (cats.get(c) ?? 0) + n);
    const [categoryId, inGroup] = [...cats].sort((x, y) => y[1] - x[1])[0] ?? [];
    if (!categoryId || inGroup < min) continue;
    let rule;
    if (list.length === 1) rule = { pattern: list[0].text, match: 'equals' };
    else {
      // The longest run of whole words that every description has (the first one's spelling).
      const words = list[0].text.split(/\s+/);
      const has = (e, run) => ` ${e.norm} `.includes(` ${normalize(run)} `);
      let best = '';
      for (let i = 0; i < words.length; i += 1) {
        for (let j = words.length; j > i; j -= 1) {
          const run = words.slice(i, j).join(' ');
          if (letters(run) > letters(best) && list.every((e) => has(e, run))) best = run;
        }
      }
      if (letters(best) < 4) continue;
      rule = { pattern: best, match: 'contains' };
    }
    const id = `${rule.match}|${normalize(rule.pattern)}|${categoryId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    // Every description the rule would match: is it right about them, and what would it fill?
    let count = 0;
    let total = 0;
    let others = 0;
    let known = true;
    for (const e of texts) {
      if (categorize(e.text, [{ ...rule, categoryId }]) !== categoryId) continue;
      for (const [c, n] of e.cats) { total += n; if (c === categoryId) count += n; }
      others += e.none;
      if (e.cats.size && categorize(e.text, rules) !== categoryId) known = false;
    }
    if (count < min || count / total < share || known) continue;
    out.push({ ...rule, categoryId, count, total, others });
  }
  return out.sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}

// ── Description suggestions ──────────────────────────────────────────────────

// One entry per distinct description (case and accents ignored) from past transactions, with how
// often it was used and what its latest use looked like: amount (signed), kind, categories, account.
// A transfer counts once, from its outgoing side, as kind 'transfer' with both accounts and the
// amount sent (negative). Opening balances are left out.
export function descriptionIndex(transactions) {
  const partner = new Map();
  for (const t of transactions) {
    if (t.transferId && t.amount > 0) partner.set(t.transferId, t);
  }
  const map = new Map();
  for (const t of transactions) {
    if (t.kind === 'opening' || !t.description) continue;
    let use;
    if (t.transferId) {
      const to = t.amount < 0 && partner.get(t.transferId);
      if (!to) continue; // the incoming side, or a transfer missing its other side
      use = { description: t.description, lastDate: t.date, amount: t.amount, kind: 'transfer', categoryIds: [], accountId: t.accountId, toAccountId: to.accountId };
    } else {
      use = { description: t.description, lastDate: t.date, amount: t.amount, kind: t.kind, categoryIds: categoriesOf(t), accountId: t.accountId, toAccountId: null };
    }
    const key = normalize(t.description);
    const e = map.get(key);
    if (!e) map.set(key, { key, count: 1, ...use });
    else {
      e.count += 1;
      if (use.lastDate >= e.lastDate) Object.assign(e, use);
    }
  }
  return [...map.values()];
}

// The best matches for what's typed: names starting with it first, then names with a word starting
// with it, then names containing it; within each, ones used in `accountId` first, then the most used,
// then the most recent.
export function suggestDescriptions(index, query, { limit = 8, accountId = null } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const rank = (e) => (e.key.startsWith(q) ? 0 : e.key.split(/[\s/\-–(]+/).some((w) => w.startsWith(q)) ? 1 : e.key.includes(q) ? 2 : -1);
  return index
    .map((e) => ({ e, r: rank(e) }))
    .filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r
      || (b.e.accountId === accountId) - (a.e.accountId === accountId)
      || b.e.count - a.e.count
      || b.e.lastDate.localeCompare(a.e.lastDate))
    .slice(0, limit)
    .map(({ e }) => e);
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
// With `asOf` (a date), transactions dated after it don't count yet: they're planned, not done.
export function accountBalance(account, transactions, asOf = null) {
  return transactions
    .filter((t) => t.accountId === account.id && (!asOf || t.date <= asOf))
    .reduce((sum, t) => sum + t.amount, 0);
}

// Transactions dated after `today` for one account, soonest first: added ahead of time, they wait
// with the scheduled ones and count once their date comes.
export function plannedTransactions(accountId, transactions, today) {
  return transactions
    .filter((t) => t.accountId === accountId && t.date > today)
    .sort((a, b) => a.date.localeCompare(b.date));
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
export function investmentValue(account, holdings, transactions, latestRate, asOf = null) {
  return investmentValueFrom(account, holdings, accountBalance(account, transactions, asOf), latestRate);
}

// The same, from the money put in (`invested`, the account's balance) instead of its transactions.
export function investmentValueFrom(account, holdings, invested, latestRate) {
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

// ── Assets ───────────────────────────────────────────────────────────────────
// An asset (a home, a vehicle, anything else of value, kept apart from the accounts): { id, name,
// kind, currency, purchasePrice, boughtOn, valueChange, valueFloor, valuations, soldOn }. Assets
// aren't money, so they're never in net worth, only in a total worth. Its value comes from valuations ({ date, value } in minor units), the purchase
// price on the day it was bought counting as the first. Between them the value is estimated from
// the latest at a yearly change (`valueChange`, % a year, compounding: a home's grows, a vehicle's
// falls), or the kind's usual one; a falling value stops at `valueFloor` when it has one. Once sold
// (`soldOn`) it's worth nothing to you.
export const ASSET_KINDS = { home: 'Home', vehicle: 'Vehicle', other: 'Other' };
export const ASSET_CHANGE = { home: 2, vehicle: -15, other: 0 }; // the kind's usual % a year
export const assetChange = (asset) => asset.valueChange ?? ASSET_CHANGE[asset.kind] ?? 0;
// The asset's valuations, the purchase first on its day, oldest first.
export function assetValuations(asset) {
  const list = [...(asset.valuations ?? [])].map((v) => ({ ...v }));
  if (asset.purchasePrice != null && asset.boughtOn) list.push({ date: asset.boughtOn, value: asset.purchasePrice, bought: true });
  return list.sort((a, b) => a.date.localeCompare(b.date) || (a.bought ? -1 : b.bought ? 1 : 0));
}
// Its value on `date`: { value, from (the valuation it's worked out from), estimated }, or null
// before anything is known or once it's sold.
export function assetValue(asset, date) {
  if (asset.soldOn && date >= asset.soldOn) return null;
  const from = assetValuations(asset).filter((v) => v.date <= date).at(-1);
  if (!from) return null;
  const change = assetChange(asset);
  const years = (utc(date) - utc(from.date)) / (365.25 * 864e5);
  let value = Math.round(from.value * (1 + change / 100) ** years);
  if (change < 0 && asset.valueFloor != null) value = Math.max(value, Math.min(asset.valueFloor, from.value));
  return { value, from, estimated: value !== from.value };
}

// Net worth in the base currency. Archived accounts don't count; accounts still waiting for a rate
// are counted separately. With `asOf`, transactions dated after it are left out.
export function netWorth(state, latestRate, asOf = null) {
  let total = 0;
  let unconverted = 0;
  for (const account of state.accounts) {
    if (account.archived) continue;
    const rate = latestRate(account.currency);
    if (rate == null) { unconverted += 1; continue; }
    const native = account.type === 'investment'
      ? investmentValue(account, state.holdings, state.transactions, latestRate, asOf).total
      : accountBalance(account, state.transactions, asOf);
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
      // By name; else by the last four digits of its card or account number ("Card ****1234").
      const digits = accountName.replace(/\D/g, '');
      const byDigits = digits.length >= 4 ? ctx.accounts.filter((a) => a.lastFour && digits.endsWith(a.lastFour)) : [];
      const found = accounts.get(normalize(accountName)) ?? newAccounts.get(normalize(accountName)) ?? (byDigits.length === 1 ? byDigits[0] : null);
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

// Likely duplicates, as after importing the same file twice: transactions in the same account with
// the same amount and description (case, accents and numbers ignored: card and reference numbers
// often differ between exports) on dates at most `days` apart. Returns groups of two or more,
// newest first: { key, items }, with `items[0]` the one worth keeping (categories, a memo, a split,
// an IOU in `linked` or a transfer, then the oldest). `dismissed` holds keys answered "Not
// duplicates"; a group that gains another copy has a new key and shows again.
export function findDuplicates(transactions, { days = 3, dismissed = [], linked = new Set() } = {}) {
  const skip = new Set(dismissed);
  const byKey = new Map();
  for (const t of transactions) {
    if (!t.amount) continue;
    const desc = normalize(t.description).replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
    const k = `${t.accountId}|${t.amount}|${desc}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const worth = (t) => (categoriesOf(t).length ? 8 : 0) + (t.memo ? 4 : 0) + (t.splits?.length ? 4 : 0)
    + (linked.has(t.id) ? 4 : 0) + (t.transferId ? 2 : 0);
  const out = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    // Runs of dates each within `days` of the one before.
    let run = [list[0]];
    const close = () => {
      if (run.length < 2) return;
      const key = `dup|${run.map((t) => t.id).sort().join(',')}`;
      if (skip.has(key)) return;
      const items = [...run].sort((a, b) => worth(b) - worth(a) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
      out.push({ key, items });
    };
    for (const t of list.slice(1)) {
      const prev = run[run.length - 1];
      if ((Date.parse(t.date) - Date.parse(prev.date)) / 864e5 <= days) run.push(t);
      else { close(); run = [t]; }
    }
    close();
  }
  return out.sort((a, b) => b.items[0].date.localeCompare(a.items[0].date));
}

// ── Scheduled (recurring) transactions ───────────────────────────────────────
// A schedule: { id, description, amount (positive minor units), kind: 'expense'|'income'|'transfer',
// accountId, toAccountId (transfers), categoryIds (several, like a transaction's; older ones had a
// single categoryId, read with categoriesOf), every, unit: 'day'|'week'|'month'|'year',
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
    categoryIds: categoriesOf(rec), memo: '',
  }];
}

// Moves a schedule to its next date after `date` (entering or skipping an occurrence).
export function advanceSchedule(rec) {
  return { ...rec, nextDate: addInterval(rec.nextDate, rec, rec.anchorDay) };
}

// ── Payments that look recurring ─────────────────────────────────────────────

// Transactions grouped by account, description (case and accents ignored) and direction, with their
// dates and amounts oldest first, between `since` and `until`: groups of three or more. Transfers and
// special kinds (refunds, openings, dividends) are left out. The database's recurring_candidates
// gives the same; `min` is how many a group needs (three, or two for yearly subscriptions).
export function recurringGroups(transactions, { since, until, min = 3 }) {
  const map = new Map();
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const t of sorted) {
    if (t.transferId || t.kind || !t.description?.trim() || !t.amount || t.date < since || t.date > until) continue;
    const key = normalize(t.description);
    const sign = Math.sign(t.amount);
    const id = `${t.accountId}|${key}|${sign}`;
    const g = map.get(id) ?? { accountId: t.accountId, key, sign, dates: [], amounts: [] };
    g.dates.push(t.date);
    g.amounts.push(t.amount);
    g.description = t.description; // the latest spelling
    g.categoryIds = categoriesOf(t);
    map.set(id, g);
  }
  return [...map.values()].filter((g) => g.dates.length >= min);
}

// How often something can repeat, with how many days a date may drift (weekends, short months).
const RHYTHMS = [
  { every: 1, unit: 'week', days: 7, slack: 1 },
  { every: 2, unit: 'week', days: 14, slack: 2 },
  { every: 1, unit: 'month', days: 30.44, slack: 4 },
  { every: 3, unit: 'month', days: 91.31, slack: 8 },
  { every: 1, unit: 'year', days: 365.25, slack: 12 },
];

// How often `dates` (three or more, oldest first) repeat when they're evenly spaced, or null. With
// `twiceYearly`, two dates a year apart are enough (a yearly plan seen twice).
function rhythmOf(dates, { twiceYearly = false } = {}) {
  if (dates.length < (twiceYearly ? 2 : 3)) return null;
  const gaps = dates.slice(1).map((d, i) => (utc(d) - utc(dates[i])) / 864e5);
  const list = dates.length === 2 ? RHYTHMS.filter((r) => r.unit === 'year') : RHYTHMS;
  return list.find((r) => gaps.every((gap) => Math.abs(gap - r.days) <= r.slack)) ?? null;
}

// How many times a year a rhythm ({ every, unit }) comes round.
const UNIT_DAYS = { day: 1, week: 7, month: 30.44, year: 365.25 };
export const timesAYear = ({ every, unit }) => 365.25 / (UNIT_DAYS[unit] * (every || 1));

// Schedules worth suggesting from `recurringGroups`: the latest dates (up to six) are evenly spaced
// by a week, two weeks, a month, a quarter or a year; the last one is at most about two of those
// ago (it still happens); and the amounts are about the same (all but one within 30% of the typical one). Groups
// already scheduled (same account and description) or dismissed (`hidden`, their ids) are left out.
// Each suggestion is a schedule's fields plus its id, `typical` amount, `count` and `lastDate`.
export function suggestSchedules(groups, { schedules = [], today, hidden = [] }) {
  const scheduled = new Set(schedules.map((s) => `${s.accountId}|${normalize(s.description)}`));
  const out = [];
  for (const g of groups) {
    const id = `${g.accountId}|${g.key}|${g.sign}`;
    if (hidden.includes(id) || scheduled.has(`${g.accountId}|${g.key}`)) continue;
    const dates = g.dates.slice(-6);
    const amounts = g.amounts.slice(-6).map((a) => Math.abs(Number(a)));
    const rhythm = rhythmOf(dates);
    if (!rhythm) continue;
    const last = dates.at(-1);
    if ((utc(today) - utc(last)) / 864e5 > rhythm.days * 2 + rhythm.slack) continue;
    const typical = [...amounts].sort((a, b) => a - b)[Math.floor(amounts.length / 2)];
    if (amounts.filter((a) => Math.abs(a - typical) > typical * 0.3).length > 1) continue;
    const anchorDay = Number(last.slice(8, 10));
    // The next date after the last one, moved on past any that are well behind (a day or two late
    // may just not be entered yet).
    let nextDate = addInterval(last, rhythm, anchorDay);
    while ((utc(today) - utc(nextDate)) / 864e5 > rhythm.slack) nextDate = addInterval(nextDate, rhythm, anchorDay);
    out.push({
      id, accountId: g.accountId, description: g.description, kind: g.sign < 0 ? 'expense' : 'income',
      amount: amounts.at(-1), typical, categoryIds: g.categoryIds ?? [],
      every: rhythm.every, unit: rhythm.unit, anchorDay, nextDate, endDate: null,
      lastDate: last, count: g.dates.length,
    });
  }
  return out.sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.description.localeCompare(b.description));
}

// Subscriptions among `recurringGroups` (over a few years, with groups of two, so yearly ones show
// after two charges): money going out at a steady rhythm (see RHYTHMS; two charges only count when
// they're a year apart) for the same price each time, give or take 5% (a foreign-currency
// charge), or with one price change. Each: { id, accountId, description, categoryIds, amount (the
// latest), every, unit, monthly and yearly (what it costs a month and a year, in its currency),
// firstDate, lastDate, nextDate, count, status ('active', or 'stopped' when the next charge is well
// overdue), priceChange ({ from, to, date } or null) }. Ones stopped over a year ago and `hidden`
// ones (their ids) are left out. Active first, the dearest first.
export function findSubscriptions(groups, { today, hidden = [] }) {
  const near = (a, b) => Math.abs(a - b) <= Math.max(1, b * 0.05);
  const out = [];
  for (const g of groups) {
    if (g.sign >= 0) continue;
    const id = `sub|${g.accountId}|${g.key}`;
    if (hidden.includes(id)) continue;
    const dates = g.dates.slice(-6);
    const amounts = g.amounts.slice(-6).map((a) => Math.abs(Number(a)));
    const rhythm = rhythmOf(dates, { twiceYearly: true });
    if (!rhythm) continue;
    // The latest price, how far back it goes, and the one before it (if it changed once).
    const amount = amounts.at(-1);
    let from = amounts.length - 1;
    while (from > 0 && near(amounts[from - 1], amount)) from -= 1;
    const before = amounts.slice(0, from);
    if (before.length && !before.every((a) => near(a, before.at(-1)))) continue; // changes all the time: a bill
    const lastDate = dates.at(-1);
    const since = (utc(today) - utc(lastDate)) / 864e5;
    if (since > 400) continue;
    const anchorDay = Number(lastDate.slice(8, 10));
    let nextDate = addInterval(lastDate, rhythm, anchorDay);
    const status = since > rhythm.days + rhythm.slack * 2 ? 'stopped' : 'active';
    if (status === 'active') while ((utc(today) - utc(nextDate)) / 864e5 > rhythm.slack) nextDate = addInterval(nextDate, rhythm, anchorDay);
    const perYear = timesAYear(rhythm);
    out.push({
      id, accountId: g.accountId, description: g.description, categoryIds: g.categoryIds ?? [],
      amount, every: rhythm.every, unit: rhythm.unit,
      monthly: Math.round((amount * perYear) / 12), yearly: Math.round(amount * perYear),
      firstDate: g.dates[0], lastDate, nextDate, count: g.dates.length, status,
      priceChange: before.length ? { from: before.at(-1), to: amount, date: dates[from] } : null,
    });
  }
  return sortSubscriptions(out);
}
const sortSubscriptions = (list) => list.sort(
  (a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || b.monthly - a.monthly || a.description.localeCompare(b.description),
);

// The subscriptions to show: those found, plus schedules marked as subscriptions (`subscription`).
// A marked schedule with a match found (same account and description) takes its price, rhythm and
// next date from the schedule and keeps what was found (last charge, price change); one without is
// shown from the schedule alone. One past its end date has stopped. Each gets `scheduleId` when it
// has a schedule, marked or not.
export function withMarkedSchedules(found, schedules, today) {
  const key = (accountId, description) => `${accountId}|${normalize(description)}`;
  const out = found.map((x) => ({ ...x }));
  const index = new Map(out.map((x) => [key(x.accountId, x.description), x]));
  for (const sc of schedules) {
    if (sc.kind === 'transfer') continue;
    const k = key(sc.accountId, sc.description);
    const hit = index.get(k);
    if (hit) hit.scheduleId = sc.id;
    if (!sc.subscription) continue;
    const perYear = timesAYear(sc);
    const fromSchedule = {
      amount: sc.amount, every: sc.every, unit: sc.unit,
      monthly: Math.round((sc.amount * perYear) / 12), yearly: Math.round(sc.amount * perYear),
      nextDate: sc.nextDate, status: sc.endDate && sc.endDate < today ? 'stopped' : 'active', marked: true, scheduleId: sc.id,
    };
    if (hit) Object.assign(hit, fromSchedule);
    else {
      out.push({
        id: `sched|${sc.id}`, accountId: sc.accountId, description: sc.description, categoryIds: categoriesOf(sc),
        firstDate: null, lastDate: null, count: 0, priceChange: null, ...fromSchedule,
      });
    }
  }
  return sortSubscriptions(out);
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

// The whole calendar months inside a period, up to the last one finished by `today`: what monthly
// averages are taken over (this year on 2 Nov → January to October, 10 months). null if none.
export function completeMonths(from, to, today) {
  const index = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
  const lastDay = (i) => new Date(Date.UTC(Math.floor(i / 12), (i % 12) + 1, 0)).toISOString().slice(0, 10);
  const end = to < today ? to : today;
  const first = from.slice(8) === '01' ? index(from) : index(from) + 1;
  const last = lastDay(index(end)) === end ? index(end) : index(end) - 1;
  if (first > last) return null;
  return { from: `${lastDay(first).slice(0, 7)}-01`, to: lastDay(last), months: last - first + 1 };
}

// Where a refund lowers spending when none of its categories is a spending one (see insights).
export const REFUNDS_UNMATCHED = 'refunds';
// Where dividends with no category count as income.
export const DIVIDENDS = 'dividends';

// Top-level categories that mostly take money in across all of history (salary, interest…): more
// income than spending under them, refunds and transfers left out.
export function incomeCategories(transactions, categories) {
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId ?? null]));
  const net = new Map();
  for (const t of transactions) {
    if (t.transferId || t.kind) continue;
    const cat = categoriesOf(t)[0];
    if (!cat) continue;
    const top = parentOf.get(cat) ?? cat;
    net.set(top, (net.get(top) ?? 0) + Math.round(t.amount * (t.rate ?? 1)));
  }
  return new Set([...net].filter(([, v]) => v > 0).map(([id]) => id));
}

// Income and spending over a period, for some accounts (`accountIds`, a Set) or all (null).
// What counts:
// - Transfers between your accounts and opening balances don't count at all.
// - IOUs are netted out: a transaction counts after its IOU entries, so a loan (money out, they
//   owe it back) counts as nothing, and a shared bill counts only your share.
// - A refund lowers spending (and its category's spending) instead of counting as income.
// - Amounts are in EUR at each transaction's own rate (`rateOf(currency)` when it has none).
// - In the category breakdown a transaction counts under its first category, so the parts add up
//   to the total; a split one counts each part under that part's category.
// - Dividends are income, under their category or, with none, on their own line (DIVIDENDS).
// `onlyCategory` (an id) keeps only transactions whose first category is it or one of its children.
//
// Two steps, so the database can do the first (insight_totals in schema.sql) and the app the
// second: `insightTotals` applies those rules to each transaction and adds up EUR per day and per
// category; `insightsFrom` groups that into the period's buckets and the categories' parents.
export function insights(transactions, opts) {
  return insightsFrom(insightTotals(transactions, opts), opts);
}

// Sums for `insightsFrom`: totals, per day ({ date, income, expenses }), and per category
// ({ cat, amount }, cat null for none) for spending and for income. Refunds count as negative
// spending, in the category `categoryOf` gives them.
export function insightTotals(transactions, { from, to, accountIds = null, accounts, categories, ious = [], rateOf = () => 1, onlyCategory = null }) {
  const currency = new Map(accounts.map((a) => [a.id, a.currency]));
  const iouByTx = new Map();
  for (const e of ious) if (e.transactionId) iouByTx.set(e.transactionId, (iouByTx.get(e.transactionId) ?? 0) + e.amount);
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId ?? null]));
  // A refund is often tagged with where the money came from (a salary category) rather than what
  // it pays back: it lowers spending in its first category that's a spending one, else on its own line.
  const incomeTops = incomeCategories(transactions, categories);
  const categoryOf = (t) => {
    const cats = categoriesOf(t);
    if (t.kind === 'dividend' && !cats.length) return DIVIDENDS;
    if (t.kind !== 'refund') return cats[0] ?? null;
    if (!cats.length) return null;
    return cats.find((c) => !incomeTops.has(parentOf.get(c) ?? c)) ?? REFUNDS_UNMATCHED;
  };
  // One part of a split transaction: its own category (a refund's income category goes to its line).
  const partCategory = (t, c) => {
    if (!c) return t.kind === 'dividend' ? DIVIDENDS : null;
    return t.kind === 'refund' && incomeTops.has(parentOf.get(c) ?? c) ? REFUNDS_UNMATCHED : c;
  };
  const only = onlyCategory ? new Set([onlyCategory, ...categories.filter((c) => c.parentId === onlyCategory).map((c) => c.id)]) : null;
  const days = new Map();
  const spend = new Map();
  const earn = new Map();
  const add = (map, cat, amount) => map.set(cat, (map.get(cat) ?? 0) + amount);
  let income = 0;
  let expenses = 0;
  let refunds = 0;
  let count = 0;
  for (const t of transactions) {
    if (t.date < from || t.date > to) continue;
    if (accountIds && !accountIds.has(t.accountId)) continue;
    if (t.transferId || t.kind === 'opening') continue;
    const rate = t.rate ?? rateOf(currency.get(t.accountId) ?? 'EUR') ?? 1;
    // A split transaction counts part by part; its IOU entries go with the first part.
    const parts = splitsOf(t)?.map((p) => ({ cat: partCategory(t, p.categoryId), amount: Number(p.amount) }))
      ?? [{ cat: categoryOf(t), amount: t.amount }];
    parts.forEach(({ cat, amount }, n) => {
      if (only && !only.has(cat)) return;
      const eur = Math.round(amount * rate) + (n === 0 ? iouByTx.get(t.id) ?? 0 : 0);
      if (!eur) return;
      count += 1;
      const day = days.get(t.date) ?? { date: t.date, income: 0, expenses: 0 };
      days.set(t.date, day);
      // A refund is money back on an expense: it cancels part of the spending in its category (a
      // category can go below zero when more came back than was spent in the period). Not income.
      if (t.kind === 'refund') {
        expenses -= eur;
        refunds += eur;
        add(spend, cat, -eur);
        day.expenses -= eur;
      } else if (eur < 0) {
        expenses -= eur;
        add(spend, cat, -eur);
        day.expenses -= eur;
      } else {
        income += eur;
        add(earn, cat, eur);
        day.income += eur;
      }
    });
  }
  const list = (map) => [...map].map(([cat, amount]) => ({ cat, amount }));
  return { income, expenses, refunds, count, days: [...days.values()], spend: list(spend), earn: list(earn) };
}

// The Insights figures from `insightTotals` (or the database's insight_totals): buckets over the
// period (day, week, month or year, by its length), and categories grouped under their parents.
export function insightsFrom(totals, { from, to, categories }) {
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId ?? null]));
  const unit = granularity(from, to);
  const buckets = new Map();
  for (let k = bucketOf(from, unit), guard = 0; k <= bucketOf(to, unit) && guard < 400; k = nextBucket(k, unit), guard += 1) {
    buckets.set(k, { key: k, income: 0, expenses: 0 });
  }
  for (const d of totals.days) {
    const bucket = buckets.get(bucketOf(d.date, unit));
    if (!bucket) continue;
    bucket.income += Number(d.income);
    bucket.expenses += Number(d.expenses);
  }
  const ranked = (list) => {
    const map = new Map(); // top category id (or '') → { amount, children: Map }
    for (const { cat, amount } of list) {
      const top = cat ? parentOf.get(cat) ?? cat : '';
      const entry = map.get(top) ?? { id: top, amount: 0, children: new Map() };
      entry.amount += Number(amount);
      if (cat && cat !== top) entry.children.set(cat, (entry.children.get(cat) ?? 0) + Number(amount));
      map.set(top, entry);
    }
    return [...map.values()]
      .map((e) => ({ id: e.id, amount: e.amount, children: [...e.children].map(([id, amount]) => ({ id, amount })).sort((a, b) => b.amount - a.amount) }))
      .filter((e) => e.amount !== 0)
      .sort((a, b) => b.amount - a.amount);
  };
  const income = Number(totals.income);
  const expenses = Number(totals.expenses);
  return {
    from, to, unit, income, expenses, refunds: Number(totals.refunds), net: income - expenses, count: Number(totals.count),
    savingsRate: income > 0 ? (income - expenses) / income : null,
    series: [...buckets.values()],
    spending: ranked(totals.spend),
    earning: ranked(totals.earn),
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

// A holding over time, for its charts: at each date a price is known (its weekly closes, each buy
// and sell, its current price), the price, the units held then, what they cost (sells at average
// cost), their value and the gain or loss on them (minor units, in the holding's currency). It
// starts at the first buy. Without buys and sells, units are today's and cost and gain are null.
export function holdingHistory(holding, lots, today) {
  const own = lots.filter((l) => l.holdingId === holding.id).sort((a, b) => a.date.localeCompare(b.date));
  const prices = new Map(Object.entries(holding.priceHistory ?? {}).map(([d, p]) => [d, Number(p)]));
  for (const l of own) if (!prices.has(l.date)) prices.set(l.date, l.price);
  if (holding.price != null) {
    const at = holding.priceAt?.slice(0, 10) ?? today;
    prices.set(at > today ? today : at, holding.price);
  }
  const start = own[0]?.date ?? '';
  return [...prices]
    .filter(([d, p]) => d >= start && d <= today && p > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, price]) => {
      if (!own.length) {
        return { date, price, units: holding.quantity, cost: null, value: Math.round(holding.quantity * price * 100), gain: null };
      }
      const { quantity, cost } = lotSummary(own.filter((l) => l.date <= date));
      const value = Math.round(quantity * price * 100);
      return { date, price, units: quantity, cost, value, gain: value - cost };
    });
}

// ── Returns ──────────────────────────────────────────────────────────────────

// The money a holding's buys and sells moved, from your side (minor units, in its currency): a buy
// is money paid in (negative, fees included), a sell money back (positive, less fees).
export const lotFlows = (lots) => lots.map((l) => ({
  date: l.date,
  amount: Math.round((l.kind === 'sell' ? l.quantity * l.price - (l.fees ?? 0) : -(l.quantity * l.price + (l.fees ?? 0))) * 100),
}));

// The yearly rate that makes `flows` ([{ date, amount }]: money paid in negative, money back and
// today's value positive) add up to nothing when each is discounted back to the first date: the
// money-weighted annual return (XIRR), so money added late counts for less time. null without both
// money in and money out, or when no rate between −99.99% and +10,000% a year fits.
export function xirr(flows) {
  const list = flows.filter((f) => f.amount).sort((a, b) => a.date.localeCompare(b.date));
  if (!list.some((f) => f.amount < 0) || !list.some((f) => f.amount > 0)) return null;
  const t0 = utc(list[0].date);
  const years = list.map((f) => (utc(f.date) - t0) / (365.25 * 864e5));
  const npv = (r) => list.reduce((s, f, i) => s + f.amount / (1 + r) ** years[i], 0);
  let lo = -0.9999;
  let hi = 100;
  let fLo = npv(lo);
  if (fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-6) return mid;
    if (fMid * fLo < 0) hi = mid;
    else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}

// What `flows` add up to: money paid in, money back (today's value included), the gain, the years
// from the first to the last, and the annual return (null under a year, where a yearly rate would
// stretch a few weeks' move into a misleading number; `simple` is the plain return then).
export function returnSummary(flows) {
  const list = flows.filter((f) => f.amount);
  const paidIn = -list.filter((f) => f.amount < 0).reduce((s, f) => s + f.amount, 0);
  const back = list.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
  const dates = list.map((f) => f.date).sort();
  const years = dates.length ? (utc(dates.at(-1)) - utc(dates[0])) / (365.25 * 864e5) : 0;
  return {
    paidIn, back, gain: back - paidIn, years,
    simple: paidIn ? (back - paidIn) / paidIn : null,
    annual: years >= 1 ? xirr(list) : null,
  };
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

// A fund's movements list, as pension funds and banks export it (e.g. "ListagemMovimentos.xls",
// really tab-separated text): "Data, Carteira, Classe, Fundo, Operação, Nº UPs, Valor UP, Valor,
// Saldo UPs, Valorização", dates as dd.mm.yyyy and decimal commas.
export function isFundMovements(header) {
  const n = header.map((x) => normalize(x));
  return n.includes('data') && n.includes('fundo') && n.includes('operacao') && n.includes('valor up') && n.some((x) => /^n\S?\s*ups$/.test(x));
}

// The same movements as an FT.com export's rows, so ftImport turns them into lots: subscriptions
// (and commission rebates paid in units) are buys, redemptions and transfers out are sells; anything
// else keeps its own name and is skipped. The fund's name is its symbol; priced by hand, in EUR.
export function fundMovementsToFt(rows) {
  const [header, ...body] = rows;
  const n = header.map((x) => normalize(x));
  const c = { date: n.indexOf('data'), fund: n.indexOf('fundo'), op: n.indexOf('operacao'), units: n.findIndex((x) => /^n\S?\s*ups$/.test(x)), price: n.indexOf('valor up') };
  // 1.234,5678 → 1234.5678 (units and unit values have more decimals than money).
  const num = (x) => Number(String(x ?? '').trim().replace(/\./g, '').replace(',', '.'));
  const out = [['Date', 'Name', 'Symbol', 'Type', 'Quantity', 'Price', 'Price Currency', 'Fees']];
  for (const r of body) {
    if (!r[c.date]?.trim()) continue;
    const [dd, mm, yyyy] = r[c.date].trim().split(/[./-]/);
    const op = normalize(r[c.op] ?? '');
    const type = /resgate|reembolso|venda|transf\w*\s*(de\s*)?sa[ií]da/.test(op) ? 'Sell'
      : /subscri|subs\b|subs-|compra|reinvest|transf\w*\s*(de\s*)?entrada/.test(op) ? 'Buy' : (r[c.op] || '').trim();
    const fund = (r[c.fund] ?? '').trim().replace(/:/g, ' ');
    out.push([`${yyyy}-${mm}-${dd}`, fund, fund, type, String(num(r[c.units])), String(num(r[c.price])), 'EUR', '0']);
  }
  return out;
}

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
    // By ticker, or by name (a fund added by hand under a short name).
    let holding = [...holdings, ...newHoldings].find((x) => normalize(x.symbol) === normalize(ticker)
      || (r[c.name] && normalize(x.name ?? '') === normalize(r[c.name])));
    if (!holding) {
      holding = {
        // No exchange: a fund priced by hand (from a movements list).
        id: ctx.id(), accountId, symbol: exch ? ticker.toUpperCase() : ticker, mic: FT_MIC[exch] ?? null, exchange: FT_EXCHANGE[exch] ?? exch ?? 'By hand',
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
// - An account counts as nothing from its closing date (`closedOn`), or, archived without one, from
//   its last transaction; leftovers on closed accounts are usually gains or losses never recorded.
// - An investment account with holdings is worth its holdings today (`holdingsValue(account)`),
//   its latest daily snapshot (market value) on earlier dates that have one, and before that:
//   with lots (buys and sells) for every holding, the units held then times the latest trade price
//   by then; without, what was put in (its transactions), as there's no price history.
// `snapshots` are { date, values: { accountId: EUR minor units } }.
// The points of a history from `from` to `to`: a bucket (day, week, month or year, by the length)
// and the date it ends, the last one cut at `to`.
export function historyPoints(from, to) {
  const unit = granularity(from, to);
  const ends = [];
  for (let k = bucketOf(from, unit), guard = 0; k <= bucketOf(to, unit) && guard < 400; k = nextBucket(k, unit), guard += 1) {
    ends.push({ key: k, date: bucketEnd(k, unit, to) });
  }
  return { unit, ends };
}

// Each account's transactions added up in EUR at each of `dates` (sorted), at the transaction's
// rate or else today's; and the date of its last one. The database's balances_at gives the same.
// Map(accountId → { last, values }). `skipOpening` leaves opening balances out (money put in).
export function accountRuns(accounts, transactions, dates, rateOf = () => 1, { skipOpening = false } = {}) {
  const currency = new Map(accounts.map((a) => [a.id, a.currency]));
  const out = new Map(accounts.map((a) => [a.id, { last: null, values: dates.map(() => 0) }]));
  for (const t of transactions) {
    const run = out.get(t.accountId);
    if (!run || (skipOpening && t.kind === 'opening')) continue;
    if (!run.last || t.date > run.last) run.last = t.date;
    const eur = Math.round(t.amount * (t.rate ?? rateOf(currency.get(t.accountId)) ?? 1));
    for (let i = 0; i < dates.length; i += 1) if (t.date <= dates[i]) run.values[i] += eur;
  }
  return out;
}

// `runs` (from accountRuns or the database's balances_at, at these points' dates) can stand in for
// `transactions`.
// `estimate` ({ paidIn(account), first(account) }: what has been put in today, in EUR, and the date
// of its first transaction) fills in an investment account whose holdings lack buys and sells: before
// its snapshots, instead of only what was put in (and a jump to market value on the last day), the
// value is what was put in by then plus a gain growing evenly from the first transaction to today's.
// `estimated` in the answer says whether any point was worked out that way. `assets` (when counting
// everything) add their value at each point, in `assets` and in the total.
export function netWorthHistory({ accounts, transactions = [], snapshots = [], holdings = [], lots = [], assets = [] }, { from, to, today, holdingsValue, rateOf = () => 1, runs = null, estimate = null }) {
  const { unit, ends } = historyPoints(from, to);
  const accountRun = runs ?? accountRuns(accounts, transactions, ends.map((e) => e.date), rateOf);
  const snaps = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const firstSnapshot = snaps[0]?.date ?? null;
  const lotsOf = new Map();
  for (const l of [...lots].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!lotsOf.has(l.holdingId)) lotsOf.set(l.holdingId, []);
    lotsOf.get(l.holdingId).push(l);
  }
  // Weekly closing prices per holding (`priceHistory`, { date: price }), sorted, when it has them.
  const history = new Map(holdings.filter((x) => x.priceHistory && Object.keys(x.priceHistory).length)
    .map((x) => [x.id, Object.entries(x.priceHistory).sort(([a], [b]) => a.localeCompare(b))]));
  const closeAt = (id, date) => {
    const rows = history.get(id);
    if (!rows || rows[0][0] > date) return null;
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rows[mid][0] <= date) lo = mid; else hi = mid - 1; }
    return rows[lo][1];
  };
  // The value of an account's holdings on a date from their lots, or null when any holding has none.
  // Each is priced at its closing price that week when there's price history, else its last trade.
  const lotValue = (a, date) => {
    const own = holdings.filter((x) => x.accountId === a.id);
    if (!own.length || own.some((x) => !lotsOf.has(x.id))) return null;
    let total = 0;
    for (const x of own) {
      const { quantity, price } = lotsAt(lotsOf.get(x.id), date);
      const close = closeAt(x.id, date) ?? price;
      if (quantity && close != null) total += Math.round(quantity * close * 100 * (rateOf(x.currency) ?? 1));
    }
    return total;
  };
  const firstLot = (a) => holdings.filter((x) => x.accountId === a.id)
    .map((x) => lotsOf.get(x.id)?.[0]?.date).filter(Boolean).sort()[0] ?? null;

  // The gain an account has today, spread evenly from its first transaction: the share of it on `date`.
  const growth = (a) => {
    if (!estimate) return null;
    const paidIn = estimate.paidIn(a);
    const first = estimate.first(a);
    if (!(paidIn > 0) || !first || first >= today) return null;
    const gain = holdingsValue(a) / paidIn - 1;
    const span = utc(today) - utc(first);
    return (date) => 1 + gain * Math.min(1, Math.max(0, (utc(date) - utc(first)) / span));
  };
  let estimated = false;
  const points = ends.map(({ key, date }) => ({ key, date, total: 0, investments: 0, locked: 0, byType: {} }));
  for (const a of accounts) {
    const run = accountRun.get(a.id) ?? { last: null, values: [] };
    const lastDate = run.last;
    const valuedByHoldings = a.type === 'investment' && holdingsValue(a) != null;
    const lotsFrom = valuedByHoldings ? firstLot(a) : null;
    const grow = valuedByHoldings && !lotsFrom ? growth(a) : null;
    for (const [pi, p] of points.entries()) {
      let value = Number(run.values[pi] ?? 0);
      // Closed: on its closing date when it has one, else (archived) at its last transaction.
      const closed = a.closedOn ?? (a.archived ? lastDate : null);
      if (closed && p.date >= closed) value = 0;
      else if (valuedByHoldings) {
        if (p.date >= today) value = holdingsValue(a);
        else if (firstSnapshot && p.date >= firstSnapshot && snaps.filter((s) => s.date <= p.date).at(-1)?.values?.[a.id] != null) {
          value = snaps.filter((s) => s.date <= p.date).at(-1).values[a.id];
        } else if (lotsFrom) {
          if (p.date >= lotsFrom) value = lotValue(a, p.date) ?? value;
        } else if (grow && value) {
          value = Math.round(value * grow(p.date));
          estimated = true;
        }
      }
      if (!value) continue;
      p.total += value;
      p.byType[a.type] = (p.byType[a.type] ?? 0) + value;
      if (a.type === 'investment') p.investments += value;
      // Pensions and retirement savings, locked away until later (in the total too).
      if (a.type === 'investment' && LOCKED_KINDS.has(a.investmentKind)) p.locked += value;
    }
  }
  // Assets (those that count): each one's value on each date (assetValue), in EUR, apart and in the total.
  for (const p of points) {
    p.assets = 0;
    for (const x of assets) p.assets += Math.round((assetValue(x, p.date)?.value ?? 0) * (rateOf(x.currency) ?? 1));
    p.total += p.assets;
  }
  return { unit, points, firstSnapshot, estimated };
}

// What had been put into an investment account by each date, in EUR minor units: from its holdings'
// buys and sells when every holding has them (their cost, sells at average cost), otherwise the sum
// of the money moved into the account (its transactions).
// `paidIn` (accountRuns with skipOpening, or the database's, at `dates`) can stand in for
// `transactions`.
export function investedHistory(account, { transactions = [], holdings, lots }, dates, rateOf = () => 1, paidIn = null) {
  const own = holdings.filter((x) => x.accountId === account.id);
  const lotsOf = (id) => lots.filter((l) => l.holdingId === id);
  const byLots = own.length > 0 && own.every((x) => lotsOf(x.id).length);
  const run = byLots ? null : paidIn ?? accountRuns([account], transactions, dates, rateOf, { skipOpening: true }).get(account.id);
  return dates.map((d, i) => {
    if (byLots) {
      return own.reduce((sum, x) => sum + Math.round(lotSummary(lotsOf(x.id).filter((l) => l.date <= d)).cost * (rateOf(x.currency) ?? 1)), 0);
    }
    return Number(run.values[i] ?? 0);
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
      accountId: from.id, toAccountId: to?.id ?? null, categoryIds: categoryId ? [categoryId] : [],
      every: freq.every, unit: freq.unit, anchorDay: Number(nextDate.slice(8, 10)), nextDate, endDate: null,
    });
  });
  return { schedules, skipped };
}

const buxferType = (t) => {
  const s = normalize(t);
  if (s.startsWith('investment')) return 'investment'; // also "Investment - 401K"
  return { 'credit card': 'credit', checking: 'checking', cash: 'cash', savings: 'savings', loan: 'loan' }[s] ?? 'checking';
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
    assets: [],
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
