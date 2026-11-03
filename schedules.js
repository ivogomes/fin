// Scheduled transactions and subscriptions.

import { today } from './market.js';
import {
  UNITS, advanceSchedule, categoriesOf, convert, crossConvert, findSubscriptions, frequencyLabel,
  newId, occurrences, plannedTransactions, scheduledEffect, scheduledTransactions,
  suggestSchedules, toMinor, withMarkedSchedules,
} from './model.js';
import { persist } from './store.js';
import { cardPayments, inCurrency, payCard } from './accounts.js';
import {
  deleteTransactions, editingTxId, ensureRate, render, setEditingTxId, setView, state, undoable,
  view,
} from './app.js';
import { ask, inEur } from './insights.js';
import { pageLink } from './overview.js';
import {
  accountBadge, accountLabel, accountName, catChips, categoryCell, categoryPicker,
  pickableAccounts, pickerField, transactionForm,
} from './transactions.js';
import {
  button, catLabel, dialog, field, h, icon, iconButton, input, latestRate, loader, money, readPref,
  say, select, shortDate, signed, thisYear, tone, writePref,
} from './ui.js';

// ── scheduled transactions ───────────────────────────────────────────────────

export const FORECAST_DAYS = 30;
export const daysFromToday = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
export const scheduleAccounts = (s) => [accountName(s.accountId), s.kind === 'transfer' && accountName(s.toAccountId)].filter(Boolean).join(' → ');

// Enter one due date: add its transaction(s) with that date and move the schedule on.
export async function enterScheduled(s, focusKey) {
  const rows = scheduledTransactions(s, s.nextDate, state.accounts);
  const currencyOf = (t) => state.accounts.find((a) => a.id === t.accountId)?.currency ?? 'EUR';
  for (const t of rows) t.rate = await ensureRate(currencyOf(t), t.date);
  // A transfer between currencies arrives converted at that day's rate.
  if (rows.length === 2 && currencyOf(rows[0]) !== currencyOf(rows[1]) && rows[0].rate && rows[1].rate) {
    rows[1].amount = crossConvert(-rows[0].amount, rows[0].rate, rows[1].rate);
  }
  state.transactions.push(...rows);
  Object.assign(s, advanceSchedule(s));
  persist(); render(focusKey);
  say(`Added ${s.description}. Next one on ${shortDate(s.nextDate)}.`);
}

export function skipScheduled(s, focusKey) {
  const skipped = s.nextDate;
  Object.assign(s, advanceSchedule(s));
  persist(); render(focusKey);
  say(`Skipped ${s.description} on ${shortDate(skipped)}. Next one on ${shortDate(s.nextDate)}.`);
}

export function deleteScheduled(s) {
  undoable(`Stopped “${s.description}”. Transactions already entered are kept.`, ['schedules'], () => {
    state.schedules = state.schedules.filter((x) => x.id !== s.id);
  });
}

export const dueLabel = (date) => (date < today() ? 'Overdue' : date === today() ? 'Due today' : null);

// Add a schedule, or edit `existing`. `preset` fills a new one (from the transaction form's Repeat).
export function openScheduleDialog(existing = null, preset = {}) {
  const s = existing ?? preset;
  const accounts = pickableAccounts(s.accountId);
  const accountOptions = accounts.map((a) => [a.id, accountLabel(a)]);
  const kind = select([['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']], s.kind ?? 'expense');
  const desc = input({ type: 'text', required: true, autocomplete: 'off', value: s.description });
  const amount = input({ type: 'number', step: '0.01', min: '0.01', required: true, inputmode: 'decimal', value: s.amount ? String(s.amount / 100) : null });
  const from = select(accountOptions, s.accountId ?? view.id ?? accounts[0]?.id);
  const to = select([['', 'Choose an account'], ...accountOptions], s.toAccountId ?? '');
  // Several categories, like a transaction (chips, and a menu to add one).
  const cats = categoryPicker(categoriesOf(s), { label: 'Categories' });
  const every = input({ type: 'number', min: '1', step: '1', required: true, value: String(s.every ?? 1), inputmode: 'numeric' });
  const unit = select(UNITS.map((u) => [u, `${u}(s)`]), s.unit ?? 'month');
  const next = input({ type: 'date', required: true, value: s.nextDate ?? today() });
  const end = input({ type: 'date', value: s.endDate ?? null });
  // Marked as a subscription: listed under Scheduled → Subscriptions (expenses only).
  const subBox = h('input', { type: 'checkbox', checked: Boolean(s.subscription) });
  const subField = h('label', { class: 'fin-check' }, subBox, ' This is a subscription');
  const fromField = field('Account', from);
  const toField = field('To account', to);
  const catField = pickerField('Categories', cats);
  const sync = () => {
    const transfer = kind.value === 'transfer';
    fromField.querySelector('label').textContent = transfer ? 'From account' : 'Account';
    toField.hidden = !transfer;
    to.required = transfer;
    catField.hidden = transfer;
    subField.hidden = kind.value !== 'expense';
  };
  kind.addEventListener('change', sync);
  sync();
  const returnKey = existing ? `sched-edit-${existing.id}` : document.activeElement?.dataset?.key;
  const close = () => { dialog.close(); render(returnKey); };
  const error = h('p', { class: 'fin-error', role: 'alert' });

  dialog.replaceChildren(h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      if (kind.value === 'transfer' && (!to.value || to.value === from.value)) { error.textContent = 'Pick a different account to transfer to.'; to.focus(); return; }
      const fields = {
        description: desc.value.trim(), amount: toMinor(amount.value), kind: kind.value,
        accountId: from.value, toAccountId: kind.value === 'transfer' ? to.value : null,
        categoryIds: kind.value === 'transfer' ? [] : cats.value(), categoryId: undefined,
        every: Math.max(1, Math.round(Number(every.value))), unit: unit.value,
        anchorDay: Number(next.value.slice(8, 10)), nextDate: next.value, endDate: end.value || null,
        subscription: kind.value === 'expense' && subBox.checked,
      };
      if (existing) Object.assign(existing, fields);
      else state.schedules.push({ id: newId(), ...fields });
      persist(); close();
      say(existing ? 'Schedule saved.' : `Scheduled ${fields.description}, ${frequencyLabel(fields).toLowerCase()}, next on ${shortDate(fields.nextDate)}.`);
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, existing ? 'Edit schedule' : 'Schedule a transaction'),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Type', kind), field('Description', desc), field('Amount', amount),
      fromField, toField,
      catField,
      h('div', { class: 'fin-field' },
        h('span', { class: 'fin-field-label', id: 'sched-every-l' }, 'Repeats every'),
        h('div', { class: 'fin-inline', role: 'group', 'aria-labelledby': 'sched-every-l' },
          every, unit)),
      field('Next date', next), field('Ends on', end, 'Optional. Leave empty to repeat until you stop it.')),
    subField,
    error,
    h('div', { class: 'fin-dialog-actions' },
      button('Cancel', close),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, existing ? 'Save' : 'Schedule'))));
  every.setAttribute('aria-label', 'Number');
  unit.setAttribute('aria-label', 'Unit');
  dialog.showModal();
  desc.focus();
}

// What's coming for one account, as greyed rows above its transactions: the schedules falling within
// the forecast window, and transactions already added with a later date (they count once it comes).
// Newest first like the list, each with the balance it would leave; `cols` matches the table's.
export function upcomingRows(account, { cols, inEur, balance }) {
  const until = daysFromToday(FORECAST_DAYS);
  const items = [
    ...state.schedules
      .filter((s) => scheduledEffect(s, account.id) !== 0)
      .flatMap((s) => occurrences(s, until).map((date, i) => ({ s, date, first: i === 0, amount: scheduledEffect(s, account.id) }))),
    ...plannedTransactions(account.id, state.transactions, today()).map((t) => ({ t, date: t.date, amount: t.amount })),
    // A card's statement payment: into the card, out of the account it's paid from.
    ...cardPayments().flatMap((p) => [
      p.card.id === account.id && { pay: p, date: p.date, amount: p.amount },
      p.from?.id === account.id && { pay: p, date: p.date, amount: -inCurrency(p.amount, p.card.currency, account.currency) },
    ]).filter(Boolean),
  ].sort((a, b) => a.date.localeCompare(b.date));
  if (!items.length) return [];
  let running = balance;
  for (const it of items) it.balance = (running += it.amount);
  const cur = account.currency;
  const dateCell = (date, chip) => h('td', { class: 'fin-nowrap c-date' }, h('time', { datetime: date }, shortDate(date)),
    date.slice(0, 4) != thisYear && ` ${date.slice(0, 4)}`, chip);
  const amountCell = (amount, refund) => h('td', { class: `fin-r fin-num c-amt ${tone(amount)}` },
    refund && h('span', { class: 'fin-refund', title: 'Refund' }, icon('refund'), h('span', { class: 'fin-sr' }, 'Refund: ')),
    signed(amount, cur));
  const balanceCell = (b) => h('td', { class: 'fin-r fin-num fin-muted c-bal' }, money(b, cur));

  const scheduleRow = ({ s, date, first, amount, balance: b }) => {
    const due = dueLabel(date);
    return h('tr', { class: `fin-upcoming${due ? ' fin-due' : ''}` },
      h('td', { class: 'fin-tick-col c-tick' }),
      dateCell(date, h('span', { class: `fin-chip fin-chip-inline${due ? ' fin-chip-due' : ''}` }, due ?? 'Scheduled')),
      amountCell(amount),
      balanceCell(b),
      h('td', { class: 'c-desc' }, s.description, h('span', { class: 'fin-sub' },
        `${frequencyLabel(s)}${s.kind === 'transfer' ? ` · ${scheduleAccounts(s)}` : ''}`)),
      // A transfer shows where it goes (or comes from), like an entered one; anything else its
      // categories as chips (changed in the schedule, not here).
      h('td', { class: 'c-cat' }, s.kind === 'transfer'
        ? h('span', { class: 'fin-tag fin-tag--transfer' }, amount < 0 ? 'To ' : 'From ', ...accountBadge(amount < 0 ? s.toAccountId : s.accountId))
        : catChips(categoriesOf(s))),
      inEur && h('td', { class: 'c-eur' }),
      // Only the next date of a schedule can be entered or skipped; later ones follow from it.
      h('td', { class: 'fin-r c-act' }, first && h('div', { class: 'fin-actions fin-row-actions fin-upcoming-actions' },
        button('Enter', () => enterScheduled(s, `up-enter-${s.id}`), 'secondary fin-btn-sm',
          { 'aria-label': `Enter ${s.description} for ${shortDate(date)}`, 'data-key': `up-enter-${s.id}` }),
        button('Skip', () => skipScheduled(s, `up-skip-${s.id}`), 'secondary fin-btn-sm',
          { 'aria-label': `Skip ${s.description} on ${shortDate(date)}`, 'data-key': `up-skip-${s.id}` }))));
  };
  // A card's statement payment, with Pay (a transfer from the account it's paid from, today).
  const payRow = ({ pay, date, amount, balance: b }) => {
    const due = dueLabel(date);
    const toCard = pay.card.id === account.id;
    return h('tr', { class: `fin-upcoming${due ? ' fin-due' : ''}` },
      h('td', { class: 'fin-tick-col c-tick' }),
      dateCell(date, h('span', { class: `fin-chip fin-chip-inline${due ? ' fin-chip-due' : ''}` }, due ?? 'Payment due')),
      amountCell(amount),
      balanceCell(b),
      h('td', { class: 'c-desc' }, `${pay.card.name} payment`, h('span', { class: 'fin-sub' },
        `Statement of ${shortDate(pay.st.close)}${toCard ? (pay.from ? ` · from ${pay.from.name}` : ' · paid from: not set') : ''}`)),
      h('td', { class: 'c-cat' }, h('span', { class: 'fin-tag fin-tag--transfer' }, ...(toCard ? ['From ', ...(pay.from ? accountBadge(pay.from.id) : ['…'])] : ['To ', ...accountBadge(pay.card.id)]))),
      inEur && h('td', { class: 'c-eur' }),
      h('td', { class: 'fin-r c-act' }, h('div', { class: 'fin-actions fin-row-actions fin-upcoming-actions' },
        button(pay.from ? 'Pay' : 'Set up', () => payCard(pay), 'secondary fin-btn-sm',
          { 'aria-label': pay.from ? `Pay ${money(pay.amount, pay.card.currency)} to ${pay.card.name} from ${pay.from.name}` : `Set the account ${pay.card.name} is paid from` }))));
  };
  // A transaction added ahead of time: already saved, so it's edited or deleted like any other.
  const plannedRow = ({ t, balance: b }) => {
    if (t.id === editingTxId) return h('tr', { class: 'fin-edit-row' }, h('td', { colspan: cols }, transactionForm(account, t)));
    const label = `${t.description}, ${shortDate(t.date)}`;
    return h('tr', { class: 'fin-upcoming' },
      h('td', { class: 'fin-tick-col c-tick' }),
      dateCell(t.date),
      amountCell(t.amount, t.kind === 'refund'),
      balanceCell(b),
      h('td', { class: 'c-desc' }, t.description, t.memo && h('span', { class: 'fin-sub' }, t.memo)),
      h('td', { class: 'c-cat' }, categoryCell(t)),
      inEur && h('td', { class: 'c-eur' }),
      h('td', { class: 'fin-r c-act' }, h('div', { class: 'fin-row-actions' },
        iconButton('edit', `Edit ${label}`, () => { setEditingTxId(t.id); render('tx-desc-edit'); }, { 'data-key': `tx-edit-${t.id}` }),
        iconButton('trash', `Delete ${label}`, () => deleteTransactions(new Set([t.id])), { danger: true }))));
  };
  // The heading folds the rows away (remembered in this browser, for every account); folded, it
  // still says how many there are and what they add up to.
  const net = items.reduce((sum, it) => sum + it.amount, 0);
  const toggle = () => {
    upcomingOpen = !upcomingOpen;
    writePref('finance:upcoming-open', upcomingOpen);
    render('upcoming-toggle');
    say(upcomingOpen ? 'Upcoming transactions shown.' : 'Upcoming transactions folded away.');
  };
  return [
    h('tr', { class: 'fin-month fin-upcoming-head' }, h('th', { colspan: cols, scope: 'colgroup' },
      h('button', {
        type: 'button', class: 'fin-upcoming-toggle', 'aria-expanded': String(upcomingOpen), 'data-key': 'upcoming-toggle', onclick: toggle,
      },
        h('span', { class: 'fin-upcoming-chevron', 'aria-hidden': 'true' }),
        'Upcoming ', h('span', { class: 'fin-count' }, String(items.length)),
        h('span', { class: 'fin-upcoming-note' }, upcomingOpen
          ? ` · scheduled for the next ${FORECAST_DAYS} days`
          : [` · next ${FORECAST_DAYS} days, `, h('span', { class: `fin-num ${tone(net)}` }, signed(net, cur)), ' in all'])))),
    ...(upcomingOpen ? items.reverse().map((it) => (it.t ? plannedRow(it) : it.pay ? payRow(it) : scheduleRow(it))) : []),
  ];
}
export let upcomingOpen = readPref('finance:upcoming-open', true);

// Payments that look recurring but have no schedule yet (model.js suggestSchedules), from the
// database's groups of repeated descriptions over the last 13 months. undefined while it's asked.
export function scheduleSuggestions() {
  const groups = ask('recurring_candidates', { p_since: daysFromToday(-400), p_today: today() });
  if (!groups) return undefined;
  return suggestSchedules(groups, { schedules: state.schedules, today: today(), hidden: state.settings.hiddenSuggestions ?? [] })
    .filter((x) => state.accounts.some((a) => a.id === x.accountId && !a.archived));
}

export function suggestionsCard() {
  const list = scheduleSuggestions();
  if (list === undefined) return h('section', { class: 'fin-card' }, loader('Looking for payments that repeat…'));
  if (!list.length) return null;
  const hide = (x) => {
    state.settings.hiddenSuggestions = [...(state.settings.hiddenSuggestions ?? []), x.id];
    persist(); render('sched-add');
    say(`“${x.description}” won’t be suggested again.`);
  };
  return h('section', { class: 'fin-card', 'aria-labelledby': 'suggest-h' },
    h('div', { class: 'fin-card-head' },
      h('h3', { id: 'suggest-h', class: 'fin-label' }, 'Looks recurring ', h('span', { class: 'fin-count' }, String(list.length)))),
    h('p', { class: 'fin-hint fin-pad-x' }, 'These came round regularly for about the same amount and have no schedule yet. Schedule one to see it coming, or say it isn’t recurring.'),
    h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
      h('caption', { class: 'fin-sr' }, 'Payments that look recurring'),
      h('thead', {}, h('tr', {}, ['Description', 'Account', 'Amount', 'Repeats', 'Next date'].map((t, i) =>
        h('th', { scope: 'col', class: i === 2 ? 'fin-r' : null }, t)), h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
      h('tbody', {}, list.map((x) => {
        const cur = state.accounts.find((a) => a.id === x.accountId)?.currency ?? 'EUR';
        const shown = x.kind === 'expense' ? -x.amount : x.amount;
        return h('tr', {},
          h('td', {}, x.description, catChips(categoriesOf(x))),
          h('td', {}, accountName(x.accountId)),
          h('td', { class: `fin-r fin-num ${tone(shown)}` }, signed(shown, cur),
            x.typical !== x.amount && h('span', { class: 'fin-sub' }, `usually ${money(x.typical, cur)}`)),
          h('td', {}, frequencyLabel(x), h('span', { class: 'fin-sub' }, `${x.count} times, last on ${shortDate(x.lastDate)}`)),
          h('td', { class: 'fin-nowrap' }, h('time', { datetime: x.nextDate }, shortDate(x.nextDate))),
          h('td', { class: 'fin-r' }, h('div', { class: 'fin-actions fin-row-actions' },
            button('Schedule…', () => openScheduleDialog(null, x), 'secondary fin-btn-sm', { 'aria-label': `Schedule ${x.description}`, 'aria-haspopup': 'dialog' }),
            button('Not recurring', () => hide(x), 'secondary fin-btn-sm', { 'aria-label': `${x.description} isn’t recurring` }))));
      })))));
}

// ── subscriptions ────────────────────────────────────────────────────────────

// Subscriptions found in the payments that repeat (model.js findSubscriptions), over the last three
// years and a bit, in groups of two or more so a yearly plan shows after two charges; plus schedules
// marked as subscriptions. undefined while the database works it out.
export function subscriptionsFound() {
  const groups = ask('recurring_candidates', { p_since: daysFromToday(-1200), p_today: today(), p_min: 2 });
  if (!groups) return undefined;
  const found = findSubscriptions(groups, { today: today(), hidden: state.settings.hiddenSuggestions ?? [] });
  return withMarkedSchedules(found, state.schedules, today())
    .filter((x) => state.accounts.some((a) => a.id === x.accountId && !a.archived));
}
export const subCurrency = (x) => state.accounts.find((a) => a.id === x.accountId)?.currency ?? 'EUR';
export const subEur = (x, minor) => convert(minor, latestRate(subCurrency(x)) ?? 1);

export function subscriptionsPanel() {
  const list = subscriptionsFound();
  if (list === undefined) return h('section', { class: 'fin-card' }, loader('Looking for subscriptions…'));
  const active = list.filter((x) => x.status === 'active');
  const stopped = list.filter((x) => x.status === 'stopped');
  const monthly = active.reduce((sum, x) => sum + subEur(x, x.monthly), 0);
  const rises = active.filter((x) => x.priceChange && x.priceChange.to > x.priceChange.from);
  const hiddenCount = (state.settings.hiddenSuggestions ?? []).filter((id) => id.startsWith('sub|')).length;
  // Found ones are hidden; a schedule marked as one is unmarked (and hidden too, if it was also found).
  const hide = (x) => {
    const sc = x.marked && state.schedules.find((y) => y.id === x.scheduleId);
    if (sc) sc.subscription = false;
    if (!x.id.startsWith('sched|')) state.settings.hiddenSuggestions = [...(state.settings.hiddenSuggestions ?? []), x.id];
    persist(); render('sched-add');
    say(`“${x.description}” isn’t treated as a subscription any more.`);
  };
  const name = (x) => h('td', {}, x.description,
    h('span', { class: 'fin-sub' }, [...categoriesOf(x).map(catLabel), accountName(x.accountId)].filter(Boolean).join(' · ')));
  const find = (x) => pageLink('Find', { name: 'search', q: x.description }, 'fin-link fin-link-sm');
  const year = (d) => (d.slice(0, 4) != thisYear ? ` ${d.slice(0, 4)}` : '');
  return h('div', {},
    h('dl', { class: 'fin-stats' },
      h('div', {}, h('dt', {}, 'A month'), h('dd', { class: 'fin-neg' }, money(monthly, 'EUR')),
        h('p', { class: 'fin-stat-note' }, `${active.length} subscription${active.length === 1 ? '' : 's'}, yearly ones spread over 12 months`)),
      h('div', {}, h('dt', {}, 'A year'), h('dd', { class: 'fin-neg' }, money(active.reduce((sum, x) => sum + subEur(x, x.yearly), 0), 'EUR')),
        h('p', { class: 'fin-stat-note' }, 'at today’s prices, in EUR')),
      h('div', {}, h('dt', {}, 'Went up'), h('dd', { class: rises.length ? 'fin-neg' : '' }, String(rises.length)),
        h('p', { class: 'fin-stat-note' }, rises.length
          // Each rise as a monthly cost: the rise's share of the price, of what it costs a month.
          ? `+${money(rises.reduce((sum, x) => sum + subEur(x, Math.round(((x.priceChange.to - x.priceChange.from) / x.amount) * x.monthly)), 0), 'EUR')} a month in all`
          : 'no price rises seen'))),
    h('section', { class: 'fin-card', 'aria-labelledby': 'subs-h' },
      h('div', { class: 'fin-card-head' }, h('h3', { id: 'subs-h', class: 'fin-label' }, 'Active ', h('span', { class: 'fin-count' }, String(active.length)))),
      active.length === 0
        ? h('p', { class: 'fin-empty fin-pad' }, 'No subscriptions found. They show here once one has been charged three times for the same price.')
        : h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table fin-subs' },
          h('caption', { class: 'fin-sr' }, 'Active subscriptions, dearest first'),
          h('thead', {}, h('tr', {}, ['Subscription', 'Price', 'A month', 'Last charged', 'Next'].map((t, i) =>
            h('th', { scope: 'col', class: i === 1 || i === 2 ? 'fin-r' : null }, t)), h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
          h('tbody', {}, active.map((x) => {
            const cur = subCurrency(x);
            const up = x.priceChange && x.priceChange.to > x.priceChange.from;
            return h('tr', {},
              name(x),
              h('td', { class: 'fin-r fin-num' }, money(x.amount, cur), h('span', { class: 'fin-sub' }, frequencyLabel(x).toLowerCase()),
                x.priceChange && h('span', { class: `fin-chip fin-chip-inline ${up ? 'fin-chip-up' : 'fin-chip-down'}` },
                  `${up ? '↑' : '↓'} from ${money(x.priceChange.from, cur)} in ${new Date(`${x.priceChange.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`)),
              h('td', { class: 'fin-r fin-num' }, money(subEur(x, x.monthly), 'EUR')),
              x.lastDate
                ? h('td', { class: 'fin-nowrap' }, h('time', { datetime: x.lastDate }, shortDate(x.lastDate)), year(x.lastDate),
                  h('span', { class: 'fin-sub' }, `${x.count} charges since ${shortDate(x.firstDate)}${year(x.firstDate)}`))
                : h('td', { class: 'fin-muted' }, 'Not seen yet'),
              h('td', { class: 'fin-nowrap' }, h('time', { datetime: x.nextDate }, shortDate(x.nextDate)), year(x.nextDate),
                x.scheduleId && h('span', { class: 'fin-sub' }, x.marked ? 'marked in its schedule' : 'scheduled')),
              h('td', { class: 'fin-r' }, h('div', { class: 'fin-actions fin-row-actions' },
                !x.scheduleId && button('Schedule…', () => openScheduleDialog(null, { ...x, kind: 'expense', subscription: true }), 'secondary fin-btn-sm', { 'aria-label': `Schedule ${x.description}`, 'aria-haspopup': 'dialog' }),
                x.scheduleId && button('Edit schedule', () => openScheduleDialog(state.schedules.find((y) => y.id === x.scheduleId)), 'secondary fin-btn-sm', { 'aria-label': `Edit the schedule of ${x.description}`, 'aria-haspopup': 'dialog' }),
                find(x),
                button('Not a subscription', () => hide(x), 'secondary fin-btn-sm', { 'aria-label': `${x.description} isn’t a subscription` }))));
          }))))),
    stopped.length > 0 && h('section', { class: 'fin-card', 'aria-labelledby': 'subs-stop-h' },
      h('div', { class: 'fin-card-head' }, h('h3', { id: 'subs-stop-h', class: 'fin-label' }, 'Looks cancelled ', h('span', { class: 'fin-count' }, String(stopped.length)))),
      h('p', { class: 'fin-hint fin-pad-x' }, 'These were charged regularly but the last one is well overdue. If you didn’t cancel one, check it’s still being paid.'),
      h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
        h('caption', { class: 'fin-sr' }, 'Subscriptions that look cancelled'),
        h('thead', {}, h('tr', {}, ['Subscription', 'Price', 'Last charged', 'Was due'].map((t, i) =>
          h('th', { scope: 'col', class: i === 1 ? 'fin-r' : null }, t)), h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
        h('tbody', {}, stopped.map((x) => h('tr', {},
          name(x),
          h('td', { class: 'fin-r fin-num' }, money(x.amount, subCurrency(x)), h('span', { class: 'fin-sub' }, frequencyLabel(x).toLowerCase())),
          h('td', { class: 'fin-nowrap' }, x.lastDate ? [h('time', { datetime: x.lastDate }, shortDate(x.lastDate)), year(x.lastDate)] : '—'),
          h('td', { class: 'fin-nowrap' }, h('time', { datetime: x.nextDate }, shortDate(x.nextDate)), year(x.nextDate),
            x.marked && h('span', { class: 'fin-sub' }, 'its schedule has ended')),
          h('td', { class: 'fin-r' }, h('div', { class: 'fin-actions fin-row-actions' },
            find(x),
            button('Not a subscription', () => hide(x), 'secondary fin-btn-sm', { 'aria-label': `${x.description} isn’t a subscription` }))))))))),
    h('p', { class: 'fin-hint fin-mt' }, 'Found in the last three years of payments: something charged at a steady rhythm (weekly, monthly, quarterly or yearly; a yearly one after two charges) for the same price each time, give or take 5% for foreign-currency charges, or with one price change. You can also tick “This is a subscription” on any schedule. Rent or a loan can look like one too; say “Not a subscription” and it won’t show again.',
      hiddenCount > 0 && [' ', h('button', {
        type: 'button', class: 'fin-link fin-link-sm',
        onclick: () => {
          state.settings.hiddenSuggestions = (state.settings.hiddenSuggestions ?? []).filter((id) => !id.startsWith('sub|'));
          persist(); render(); say('Hidden subscriptions are back.');
        },
      }, `Show the ${hiddenCount} you hid`)]));
}

export function renderSchedules() {
  const list = [...state.schedules].sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  const subs = view.tab === 'subscriptions';
  const pick = (t) => { setView({ name: 'scheduled', ...(t === 'subscriptions' && { tab: t }) }); render(`sched-tab-${t}`); };
  const tabs = h('div', { class: 'fin-tabs', role: 'group', 'aria-label': 'Scheduled view' },
    [['schedules', 'Schedules'], ['subscriptions', 'Subscriptions']].map(([t, label]) => h('button', {
      type: 'button', class: 'fin-tab', 'aria-pressed': String(subs === (t === 'subscriptions')), 'data-key': `sched-tab-${t}`, onclick: () => pick(t),
    }, label)));
  if (subs) {
    return h('div', {},
      h('div', { class: 'fin-account-head' },
        h('div', {}, h('h2', { class: 'fin-title' }, 'Scheduled'),
          h('p', { class: 'fin-meta' }, 'Subscriptions found in your payments: what they cost, price rises, and ones that seem to have stopped.')),
        button('Schedule a transaction', () => openScheduleDialog(), 'primary', { 'data-key': 'sched-add', 'aria-haspopup': 'dialog' })),
      tabs, h('div', { class: 'fin-insights' }, subscriptionsPanel()));
  }
  return h('div', {},
    h('div', { class: 'fin-account-head' },
      h('div', {}, h('h2', { class: 'fin-title' }, 'Scheduled'),
        h('p', { class: 'fin-meta' }, 'Recurring transactions. When one is due it shows on its account, where you enter or skip it.')),
      button('Schedule a transaction', () => openScheduleDialog(), 'primary', { 'data-key': 'sched-add', 'aria-haspopup': 'dialog' })),
    tabs,
    suggestionsCard(),
    h('section', { class: 'fin-card' },
      list.length === 0
        ? h('p', { class: 'fin-empty fin-pad' }, 'Nothing scheduled yet. Add one here, use Repeat when adding a single transaction, or import Buxfer’s reminders.csv.')
        : h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
          h('caption', { class: 'fin-sr' }, 'Scheduled transactions'),
          h('thead', {}, h('tr', {}, ['Next date', 'Description', 'Account', 'Amount', 'Repeats'].map((t, i) =>
            h('th', { scope: 'col', class: i === 3 ? 'fin-r' : null }, t)), h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
          h('tbody', {}, list.map((s) => {
            const due = dueLabel(s.nextDate);
            const cur = state.accounts.find((a) => a.id === s.accountId)?.currency ?? 'EUR';
            const shown = s.kind === 'expense' ? -s.amount : s.amount;
            return h('tr', { class: due ? 'fin-due' : null },
              h('td', { class: 'fin-nowrap' }, h('time', { datetime: s.nextDate }, shortDate(s.nextDate)),
                due && h('span', { class: 'fin-chip fin-chip-inline fin-chip-due' }, due)),
              h('td', {}, s.description, s.subscription && h('span', { class: 'fin-chip fin-chip-inline' }, 'Subscription'),
                catChips(categoriesOf(s))),
              h('td', {}, scheduleAccounts(s)),
              h('td', { class: `fin-r fin-num ${s.kind === 'transfer' ? '' : tone(shown)}` }, s.kind === 'transfer' ? money(s.amount, cur) : signed(shown, cur)),
              h('td', { class: 'fin-nowrap' }, frequencyLabel(s), s.endDate && h('span', { class: 'fin-sub' }, `until ${shortDate(s.endDate)}`)),
              h('td', { class: 'fin-r' }, h('div', { class: 'fin-actions fin-row-actions' },
                due && button('Enter', () => enterScheduled(s, `sched-edit-${s.id}`), 'secondary fin-btn-sm', { 'aria-label': `Enter ${s.description}` }),
                button('Edit', () => openScheduleDialog(s), 'secondary fin-btn-sm', { 'aria-label': `Edit ${s.description}`, 'data-key': `sched-edit-${s.id}` }),
                button('Stop', () => deleteScheduled(s), 'danger fin-btn-sm', { 'aria-label': `Stop ${s.description}` }))));
          }))))));
}
