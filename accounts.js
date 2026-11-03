// An account: its dialog (add and edit), credit card statements and payments, alerts, and its page.

import { selectAll } from './cloud.js';
import { today } from './market.js';
import {
  ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, CURRENCIES, INVESTMENT_KINDS, balanceDip, convert,
  crossConvert, dueAfter, investmentValueFrom, lastStatementDate, makeTransfer, newId, occurrences,
  savingsInterest, scheduledEffect, toMinor,
} from './model.js';
import { persist, transactionsComplete } from './store.js';
import {
  CARD_NETWORKS, accountValue, byName, cardMark, ensureRate, limitUse, refreshRates, render,
  selectAccount, setView, state, totalsOf, undoable, usageBar, view,
} from './app.js';
import { holdingsGain, holdingsSection } from './holdings.js';
import { ask, insightsPanel, investmentInsights, runMap, transactionsLoaded } from './insights.js';
import { FORECAST_DAYS, daysFromToday, openScheduleDialog } from './schedules.js';
import { fetchTransactions, transactionsSection } from './transactions.js';
import {
  button, dialog, field, flag, h, icon, input, latestRate, money, monthLabel, num, say, select,
  shortDate, signed, tone,
} from './ui.js';

// ── account dialog ───────────────────────────────────────────────────────────

// Colours an account can wear (a dot by its name), the same hues as the category chips.
export const ACCOUNT_COLORS = ['Teal', 'Blue', 'Purple', 'Pink', 'Orange', 'Yellow', 'Green', 'Grey'];
export const colorDot = (a) => a.color != null && h('span', { class: 'fin-acc-dot', 'data-hue': a.color, 'aria-hidden': 'true' });
export const mainAccount = () => state.accounts.find((a) => a.isMain && !a.archived);
// Accounts that count in net worth and the group totals (not the ones left out of totals).
export const counted = (a) => !a.excludeTotals;
export const INTEREST_EVERY = [[1, 'Every month'], [3, 'Every three months'], [12, 'Every year']];

// Add an account, or edit `existing`. The currency is fixed once an account has transactions or
// holdings, because their amounts are stored in that currency. Each type has its own settings (shown
// for that type only); "More details" has the ones every account can have.
export function openAccountDialog(existing = null) {
  const a0 = existing ?? {};
  const used = existing && (totalsOf(existing.id).count > 0
    || state.holdings.some((x) => x.accountId === existing.id));
  const name = input({ type: 'text', required: true, autocomplete: 'off', value: a0.name });
  const type = select(ACCOUNT_TYPES.map((t) => [t, ACCOUNT_TYPE_LABELS[t]]), a0.type ?? 'checking');
  const cur = select(CURRENCIES.map((c) => [c, c]), a0.currency ?? 'EUR', { disabled: used });
  const color = select([['', 'No colour'], ...ACCOUNT_COLORS.map((c, i) => [String(i), c])], a0.color ?? '');
  const money0 = (v) => (v != null ? String(v / 100) : null);
  const dayIn = (v) => input({ type: 'number', min: '1', max: '31', step: '1', inputmode: 'numeric', value: v != null ? String(v) : null });
  // Credit cards
  const network = select([['', 'Not set'], ...Object.entries(CARD_NETWORKS)], a0.cardNetwork ?? '');
  const limit = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: money0(a0.creditLimit) });
  const statementDay = dayIn(a0.statementDay);
  const dueDay = dayIn(a0.dueDay);
  const payOptions = state.accounts.filter((x) => x.type !== 'credit' && !x.archived && x.id !== a0.id).sort(byName);
  const payFrom = select([['', 'Not set'], ...payOptions.map((x) => [x.id, x.name])], a0.payFrom ?? (existing ? '' : mainAccount()?.id ?? ''));
  // Checking
  const isMain = h('input', { type: 'checkbox', checked: Boolean(a0.isMain) });
  const lowBalance = input({ type: 'number', step: '0.01', inputmode: 'decimal', value: money0(a0.lowBalance) });
  // Savings
  const rate = input({ type: 'number', step: '0.01', min: '0', max: '100', inputmode: 'decimal', value: a0.interestRate != null ? String(a0.interestRate) : null });
  const rateEvery = select(INTEREST_EVERY.map(([m, label]) => [String(m), label]), String(a0.interestEvery ?? 1));
  const rateTax = input({ type: 'number', step: '0.01', min: '0', max: '100', inputmode: 'decimal', value: a0.interestTax != null ? String(a0.interestTax) : null });
  // Investments
  const kind = select([['', 'Not set'], ...Object.entries(INVESTMENT_KINDS)], a0.investmentKind ?? '');
  // Any account
  const institution = input({ type: 'text', autocomplete: 'off', value: a0.institution });
  const lastFour = input({ type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '4', pattern: '\\d{4}', value: a0.lastFour, title: 'Four digits' });
  const openedOn = input({ type: 'date', value: a0.openedOn ?? null });
  const closedOn = input({ type: 'date', value: a0.closedOn ?? null });
  const exclude = h('input', { type: 'checkbox', checked: Boolean(a0.excludeTotals) });

  const group = (legend, ...kids) => h('fieldset', { class: 'fin-fieldset' }, h('legend', { class: 'fin-legend-label' }, legend), h('div', { class: 'fin-grid fin-grid-2' }, ...kids));
  const sections = {
    credit: group('Credit card',
      field('Network', network), field('Credit limit', limit, 'Shows how much is left to spend.'),
      field('Statement day', statementDay, 'Day of the month the statement closes.'),
      field('Payment due day', dueDay, 'Day of the month it must be paid by.'),
      field('Paid from', payFrom, 'The account the card is paid from: the payment shows there as upcoming.')),
    checking: group('Checking',
      field('Warn below', lowBalance, `Warns when what’s scheduled or due in the next ${FORECAST_DAYS} days takes the balance below this.`),
      h('label', { class: 'fin-check fin-check-field' }, isMain, ' Main account (the default for quick entry and for paying cards)')),
    savings: group('Savings',
      field('Interest rate (% a year)', rate, 'Before tax. Shows the interest it should earn.'),
      field('Interest paid', rateEvery),
      field('Tax on interest (%)', rateTax, 'Withheld from each payment, e.g. 28. The estimate is what arrives after it.')),
    investment: group('Investment', field('Kind', kind, 'Pensions and retirement savings are shown apart from what’s within reach.')),
  };
  const more = h('details', { class: 'fin-more', open: Boolean(a0.institution || a0.lastFour || a0.openedOn || a0.closedOn || a0.excludeTotals) },
    h('summary', {}, 'More details'),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Bank or institution', institution),
      field('Last four digits', lastFour, 'Of the card or account number. CSV imports use it to find this account.'),
      field('Opened on', openedOn), field('Closed on', closedOn, 'Net worth counts it until then.'),
      h('label', { class: 'fin-check fin-check-field' }, exclude, ' Leave out of totals (net worth and its group)')));
  const syncType = () => { for (const [t, el] of Object.entries(sections)) el.hidden = type.value !== t; };
  type.addEventListener('change', syncType);
  syncType();

  const intOrNull = (el) => (el.value === '' ? null : Math.min(31, Math.max(1, Math.round(Number(el.value)))));
  const values = () => {
    const t = type.value;
    return {
      name: name.value.trim(), type: t, currency: cur.value, color: color.value || null,
      creditLimit: t === 'credit' && limit.value !== '' ? toMinor(limit.value) : null,
      cardNetwork: (t === 'credit' && network.value) || null,
      statementDay: t === 'credit' ? intOrNull(statementDay) : null,
      dueDay: t === 'credit' ? intOrNull(dueDay) : null,
      payFrom: (t === 'credit' && payFrom.value) || null,
      lowBalance: t === 'checking' && lowBalance.value !== '' ? toMinor(lowBalance.value) : null,
      isMain: t === 'checking' && isMain.checked,
      interestRate: t === 'savings' && rate.value !== '' ? Number(rate.value) : null,
      interestEvery: t === 'savings' && rate.value !== '' ? Number(rateEvery.value) : null,
      interestTax: t === 'savings' && rate.value !== '' && rateTax.value !== '' ? Number(rateTax.value) : null,
      investmentKind: (t === 'investment' && kind.value) || null,
      institution: institution.value.trim() || null, lastFour: lastFour.value.trim() || null,
      openedOn: openedOn.value || null, closedOn: closedOn.value || null, excludeTotals: exclude.checked,
    };
  };
  // Settings left empty aren't kept on the account.
  const apply = (account, v) => {
    for (const [k, val] of Object.entries(v)) {
      if (val == null || val === false) delete account[k]; else account[k] = val;
    }
    // One main account at most.
    if (account.isMain) for (const x of state.accounts) if (x !== account) delete x.isMain;
  };
  const returnKey = existing ? 'edit-account' : document.activeElement?.dataset?.key;
  const close = () => { dialog.close(); render(returnKey); };
  dialog.replaceChildren(h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (existing) {
        apply(existing, values());
        persist(); close(); say(`Saved ${existing.name}.`);
      } else {
        const account = { id: newId() };
        apply(account, values());
        state.accounts.push(account);
        dialog.close();
        selectAccount(account.id);
        say(`Added account ${account.name}.`);
      }
      await refreshRates();
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, existing ? 'Edit account' : 'Add account'),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Name', name), field('Type', type),
      field('Currency', cur, used
        ? 'Fixed, because this account already has transactions.'
        : 'USD amounts are converted to EUR at the daily rate.'),
      field('Colour', color, 'A dot by its name.')),
    ...Object.values(sections),
    more,
    h('div', { class: 'fin-dialog-actions' },
      button('Cancel', close),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, existing ? 'Save' : 'Add account'))));
  dialog.showModal();
  name.focus();
}

export function setArchived(account, archived) {
  if (archived) {
    const value = accountValue(account);
    if (value !== 0 && !confirm(`${account.name} still has a balance of ${signed(value, account.currency)}. Archived accounts don't count toward net worth. Archive it anyway?`)) return;
  }
  account.archived = archived;
  persist();
  render(archived ? 'unarchive-account' : 'archive-account');
  say(archived ? `${account.name} archived. Its transactions are kept.` : `${account.name} restored.`);
}

// ── credit card statements, upcoming payments and alerts ──────────────────────

// An amount in another currency at today's rates.
export const inCurrency = (minor, from, to) => (from === to ? minor : crossConvert(minor, latestRate(from) ?? 1, latestRate(to) ?? 1));

// A card's latest statement (it has a statement day): its date, what was owed then (from the
// database), what's been paid into the card since, what's left, and when it's due (with a due day).
// undefined while it's worked out.
export function statementOf(card) {
  if (card.type !== 'credit' || !card.statementDay) return null;
  const close = lastStatementDate(today(), card.statementDay);
  const runs = ask('balances_at', { p_dates: [close], p_accounts: [card.id], p_native: true });
  const since = transactionsLoaded(`card:${card.id}:${close}`, `&account_id=eq.${encodeURIComponent(card.id)}&date=gt.${close}`);
  if (!runs || !since) return undefined;
  const owed = Math.max(0, -Number(runMap(runs).get(card.id)?.values?.[0] ?? 0));
  // Transfers into the card since the statement are its payments.
  const paid = state.transactions.filter((t) => t.accountId === card.id && t.transferId && t.amount > 0 && t.date > close && t.date <= today())
    .reduce((sum, t) => sum + t.amount, 0);
  return { close, owed, paid, left: Math.max(0, owed - paid), due: card.dueDay ? dueAfter(close, card.dueDay) : null };
}

// Card payments still to make: open cards with a statement and due day and something left to pay,
// each with the account it's paid from (null when not set).
export function cardPayments() {
  return state.accounts.filter((a) => a.type === 'credit' && !a.archived && a.statementDay && a.dueDay)
    .map((card) => ({ card, st: statementOf(card) }))
    .filter(({ st }) => st && st.left > 0)
    .map(({ card, st }) => ({ card, st, from: state.accounts.find((x) => x.id === card.payFrom && !x.archived) ?? null, date: st.due, amount: st.left }));
}

// Pays what's left on a card's statement from its "Paid from" account today, as a transfer.
export async function payCard(p) {
  if (!p.from) { openAccountDialog(p.card); return; }
  const date = today();
  const [rf, rt] = [await ensureRate(p.from.currency, date), await ensureRate(p.card.currency, date)];
  const sent = p.from.currency === p.card.currency || rf == null || rt == null ? p.amount : crossConvert(p.amount, rt, rf);
  const legs = makeTransfer({ from: p.from, to: p.card, sent, received: p.amount, date, description: `${p.card.name} payment` });
  legs[0].rate = rf;
  legs[1].rate = rt;
  undoable(`Paid ${money(p.amount, p.card.currency)} to ${p.card.name} from ${p.from.name}.`, ['transactions'], () => { state.transactions.push(...legs); });
}

// What's coming for an account in the next 30 days, as { date, amount } in its currency: scheduled
// dates, transactions added ahead, and card payments to or from it.
export function upcomingEffects(account) {
  const until = daysFromToday(FORECAST_DAYS);
  return [
    ...state.schedules.filter((sc) => scheduledEffect(sc, account.id) !== 0)
      .flatMap((sc) => occurrences(sc, until).map((date) => ({ date, amount: scheduledEffect(sc, account.id) }))),
    ...state.transactions.filter((t) => t.accountId === account.id && t.date > today() && t.date <= until).map((t) => ({ date: t.date, amount: t.amount })),
    ...cardPayments().flatMap((p) => [
      p.card.id === account.id && { date: p.date, amount: p.amount },
      p.from?.id === account.id && { date: p.date, amount: -inCurrency(p.amount, p.card.currency, account.currency) },
    ]).filter(Boolean),
  ];
}

// Things to look at: checking accounts heading below their alert, and card payments due within five
// days or overdue. Each: { account, text, level ('warn' or 'due') }.
export function accountAlerts(only = null) {
  const out = [];
  for (const a of state.accounts) {
    if (a.archived || (only && a.id !== only.id)) continue;
    if (a.type === 'checking' && a.lowBalance != null) {
      const { below, lowest } = balanceDip(totalsOf(a.id).balance, upcomingEffects(a), a.lowBalance);
      if (below) {
        out.push({
          account: a, level: 'warn',
          text: below.date
            ? `${a.name} drops to ${money(below.balance, a.currency)} on ${shortDate(below.date)}, below your ${money(a.lowBalance, a.currency)} alert${lowest.balance < below.balance ? `, and to ${money(lowest.balance, a.currency)} on ${shortDate(lowest.date)}` : ''}.`
            : `${a.name} is at ${money(below.balance, a.currency)}, below your ${money(a.lowBalance, a.currency)} alert.`,
        });
      }
    }
  }
  // A credit card with a limit that's 80% or more used.
  for (const a of state.accounts) {
    if (a.archived || (only && a.id !== only.id)) continue;
    const use = limitUse(a, accountValue(a));
    if (use && use.used >= 80) {
      out.push({
        account: a, level: 'warn',
        text: `${a.name} has used ${use.used}% of its ${money(a.creditLimit, a.currency)} limit, with ${money(Math.max(0, use.left), a.currency)} left.`,
      });
    }
  }
  for (const p of cardPayments()) {
    if (only && p.card.id !== only.id && p.from?.id !== only.id) continue;
    const days = Math.round((Date.parse(p.date) - Date.parse(today())) / 864e5);
    if (days > 5) continue;
    out.push({
      account: p.card, level: 'due', pay: p,
      text: `${p.card.name}: ${money(p.amount, p.card.currency)} ${days < 0 ? `was due on ${shortDate(p.date)}` : days === 0 ? 'is due today' : `is due on ${shortDate(p.date)}`}${p.from ? `, from ${p.from.name}` : ''}.`,
    });
  }
  return out;
}

// A list of alerts in one card, a row each: a round badge (a clock for a payment due, a warning
// sign for a low balance, a loop for payments that look recurring), what it's about, and its action:
// the Pay button for a card payment, or `action` (an element, such as a link to the page).
export function alertsBox(list, { label = 'Heads up' } = {}) {
  if (!list.length) return null;
  return h('section', { class: 'fin-alerts', 'aria-label': label },
    h('ul', {}, list.map((al) => h('li', { class: `fin-alert fin-alert--${al.level}` },
      h('span', { class: 'fin-alert-icon' }, icon({ due: 'clock', overdue: 'clock', recurring: 'repeat', stopped: 'pause', backup: 'cloud' }[al.level] ?? 'warn')),
      h('span', { class: 'fin-alert-text' }, al.text),
      al.action,
      al.pay && button(al.pay.from ? 'Pay now' : 'Set where it’s paid from', () => payCard(al.pay), 'secondary fin-btn-sm',
        { 'aria-label': al.pay.from ? `Pay ${money(al.pay.amount, al.pay.card.currency)} to ${al.pay.card.name}` : `Set the account ${al.pay.card.name} is paid from` })))));
}

// ── main: account ────────────────────────────────────────────────────────────

export function renderWelcome() {
  return h('div', { class: 'fin-welcome' },
    h('h2', { class: 'fin-title' }, 'Start with an account'),
    h('p', { class: 'fin-empty' }, 'Add your checking accounts, credit cards and investments. Accounts are in EUR unless you pick USD.'),
    button('Add account', () => openAccountDialog(), 'primary'));
}

export function renderAccount(account) {
  const value = accountValue(account);
  const inv = account.type === 'investment'
    ? investmentValueFrom(account, state.holdings, totalsOf(account.id).balance, (c) => latestRate(c) ?? 1)
    : null;
  const rate = latestRate(account.currency);
  return h('div', {},
    h('div', { class: 'fin-account-head' },
      h('div', {},
        h('h2', { class: 'fin-title' }, colorDot(account), cardMark(account, 'fin-card-mark--title'), account.name),
        h('p', { class: 'fin-meta' }, [
          ACCOUNT_TYPE_LABELS[account.type] + (account.investmentKind ? `, ${INVESTMENT_KINDS[account.investmentKind].toLowerCase()}` : ''),
          account.currency,
          [account.institution, account.lastFour && `••${account.lastFour}`].filter(Boolean).join(' '),
          account.isMain && 'Main account',
          account.openedOn && `Opened ${monthLabel(account.openedOn.slice(0, 7))}`,
          account.closedOn && `Closed ${shortDate(account.closedOn)} ${account.closedOn.slice(0, 4)}`,
          account.excludeTotals && 'Not in totals',
          account.archived && 'Archived',
        ].filter(Boolean).join(' · '))),
      h('div', { class: 'fin-actions' },
        button('Edit', () => openAccountDialog(account), 'secondary', { 'data-key': 'edit-account' }),
        account.archived
          ? button('Unarchive', () => setArchived(account, false), 'secondary', { 'data-key': 'unarchive-account' })
          : button('Archive', () => setArchived(account, true), 'secondary', { 'data-key': 'archive-account' }),
        button('Delete', async () => {
          if (!confirm(`Delete "${account.name}" and everything in it?`)) return;
          // All of its transactions are needed here, so undo can bring every one of them back.
          if (!transactionsComplete()) {
            say('Getting the account’s transactions…');
            await fetchTransactions(() => selectAll('transactions', 'id', `&account_id=eq.${encodeURIComponent(account.id)}`));
          }
          undoable(`${account.name} deleted.`, ['accounts', 'transactions', 'ious', 'holdings', 'lots', 'schedules'], () => {
            state.accounts = state.accounts.filter((a) => a.id !== account.id);
            const gone = new Set(state.transactions.filter((t) => t.accountId === account.id).map((t) => t.id));
            state.ious = state.ious.filter((e) => !gone.has(e.transactionId));
            state.transactions = state.transactions.filter((t) => t.accountId !== account.id);
            const goneHoldings = new Set(state.holdings.filter((x) => x.accountId === account.id).map((x) => x.id));
            state.lots = state.lots.filter((l) => !goneHoldings.has(l.holdingId));
            state.holdings = state.holdings.filter((x) => x.accountId !== account.id);
            state.schedules = state.schedules.filter((x) => x.accountId !== account.id && x.toAccountId !== account.id);
            setView({ name: 'account', id: [...state.accounts].sort(byName).find((a) => !a.archived)?.id });
          });

        }, 'danger', { 'aria-label': `Delete account ${account.name}` }))),
    account.archived && h('p', { class: 'fin-notice' },
      'This account is archived. It is hidden from the account groups and left out of net worth. Its transactions are kept.'),
    !account.archived && alertsBox(accountAlerts(account)),
    // Each card: a label, the figure, and a short note under it (as on the Insights tabs).
    h('dl', { class: 'fin-stats' },
      h('div', {}, h('dt', {}, inv?.hasHoldings ? 'Value' : 'Balance'), h('dd', { class: `fin-num ${tone(value)}` }, signed(value, account.currency)),
        h('p', { class: 'fin-stat-note' }, inv?.hasHoldings ? 'holdings at today’s prices'
          : account.type === 'credit' ? (value < 0 ? 'owed on the card' : 'in your favour') : 'up to today')),
      // A credit card with a limit: what's left to spend (the limit, less what's owed) and how much is used.
      limitUse(account, value) && (() => {
        const { used, left } = limitUse(account, value);
        return h('div', {}, h('dt', {}, 'Available'),
          h('dd', { class: `fin-num ${left < 0 ? 'fin-neg' : ''}` }, money(left, account.currency)),
          usageBar(limitUse(account, value)),
          h('p', { class: 'fin-stat-note' }, left < 0
            ? `${money(-left, account.currency)} over the ${money(account.creditLimit, account.currency)} limit`
            : `${used}% of the ${money(account.creditLimit, account.currency)} limit used`));
      })(),
      account.currency !== 'EUR' && h('div', {}, h('dt', { class: 'fin-dt-flag' }, flag('EUR'), 'In EUR'),
        h('dd', { class: 'fin-num' }, rate == null ? 'rate pending' : signed(convert(value, rate), 'EUR')),
        h('p', { class: 'fin-stat-note' }, rate == null ? 'waiting for today’s rate' : `at today’s rate, 1 ${account.currency} = ${num(rate, 4)} EUR`)),
      // Invested and Gain come from the holdings, like the holdings table: what their buys and sells
      // cost, and their value less that. Without lots for every holding, from the money put in (the
      // account's transactions) instead.
      ...(() => {
        if (!inv?.hasHoldings) return [];
        const hg = holdingsGain(account);
        const gain = hg ? hg.gain : value - inv.invested;
        const base = hg ? hg.cost : inv.invested;
        return [h('div', {}, h('dt', {}, 'Invested'), h('dd', { class: 'fin-num' }, money(base, account.currency)),
          h('p', { class: 'fin-stat-note' }, hg ? 'what the holdings cost' : 'money put in')),
        h('div', {}, h('dt', {}, 'Gain'),
          h('dd', { class: `fin-num ${tone(gain)}` }, signed(gain, account.currency)),
          h('p', { class: 'fin-stat-note' }, base > 0
            ? `${gain >= 0 ? '+' : ''}${num((gain / base) * 100)}% on what ${hg ? 'the holdings cost' : 'was put in'}`
            : hg ? 'on what the holdings cost' : 'value less what was put in'))];
      })(),
      // A credit card's latest statement: what it said, what's left to pay and by when.
      statementCard(account),
      // Savings with an interest rate: what it should earn.
      interestCard(account, value),
      // Like Buxfer's forecast: the balance once everything scheduled in the next 30 days happens,
      // the transactions already added for those days, and card payments.
      (() => {
        const coming = upcomingEffects(account);
        if (!coming.length) return null;
        const next = coming.reduce((sum, it) => sum + it.amount, value);
        return h('div', {}, h('dt', {}, `Forecast, ${FORECAST_DAYS} days`),
          h('dd', { class: `fin-num ${tone(next)}` }, signed(next, account.currency)),
          h('p', { class: 'fin-stat-note' }, 'with what’s scheduled or dated ahead'));
      })()),
    accountTabs(),
    view.tab === 'insights'
      ? (account.type === 'investment' ? investmentInsights(account)
        : insightsPanel(new Set([account.id]), { spendingOnly: account.type === 'credit', balanceOf: account }))
      : [account.type === 'investment' && holdingsSection(account), transactionsSection(account)]);
}

export function statementCard(card) {
  const st = statementOf(card);
  if (st === null) return null;
  const cur = card.currency;
  if (st === undefined) return h('div', {}, h('dt', {}, 'Statement'), h('dd', {}, '…'), h('p', { class: 'fin-stat-note' }, 'working it out…'));
  const p = cardPayments().find((x) => x.card.id === card.id);
  return h('div', {}, h('dt', {}, `Statement, ${shortDate(st.close)}`),
    h('dd', { class: `fin-num ${st.left ? 'fin-neg' : ''}` }, money(st.owed, cur)),
    h('p', { class: 'fin-stat-note' }, st.owed === 0 ? 'nothing to pay'
      : st.left === 0 ? 'paid'
        : [st.paid ? `${money(st.left, cur)} left to pay` : 'to pay', st.due && `, due ${shortDate(st.due)}`].filter(Boolean).join('')),
    p && h('div', { class: 'fin-stat-action' }, button(p.from ? `Pay from ${p.from.name}` : 'Set where it’s paid from', () => payCard(p), 'secondary fin-btn-sm', { 'data-key': 'pay-card' })));
}

export function interestCard(account, value) {
  if (account.type !== 'savings' || !account.interestRate) return null;
  const every = account.interestEvery ?? 1;
  const tax = account.interestTax ?? 0;
  const est = savingsInterest(value, account.interestRate, every, tax);
  const label = INTEREST_EVERY.find(([m]) => m === every)?.[1].toLowerCase() ?? '';
  const scheduled = state.schedules.some((sc) => sc.accountId === account.id && sc.kind === 'income' && /interest|juro/i.test(sc.description));
  return h('div', {}, h('dt', {}, 'Interest'),
    h('dd', { class: 'fin-num fin-pos' }, `about ${money(est.perPayment, account.currency)}`),
    h('p', { class: 'fin-stat-note' }, tax
      ? `${label} at ${num(account.interestRate, 2)}% a year, after ${num(tax, tax % 1 ? 2 : 0)}% tax (${money(est.gross.perPayment, account.currency)} before it; ${money(est.yearly, account.currency)} a year)`
      : `${label} at ${num(account.interestRate, 2)}% a year (${money(est.yearly, account.currency)} a year), before tax`),
    !scheduled && est.perPayment > 0 && h('div', { class: 'fin-stat-action' }, button('Schedule it', () => openScheduleDialog(null, {
      kind: 'income', description: 'Interest', amount: est.perPayment, accountId: account.id, every, unit: 'month',
      nextDate: daysFromToday(30 * every).slice(0, 8) + '01',
    }), 'secondary fin-btn-sm', { 'aria-haspopup': 'dialog' })));
}

// Transactions or Insights for the selected account.
export function accountTabs() {
  const tab = view.tab === 'insights' ? 'insights' : 'transactions';
  const pick = (t) => { setView({ ...view, tab: t }); render(`tab-${t}`); };
  return h('div', { class: 'fin-tabs', role: 'group', 'aria-label': 'Account view' },
    ['transactions', 'insights'].map((t) => h('button', {
      type: 'button', class: 'fin-tab', 'aria-pressed': String(tab === t), 'data-key': `tab-${t}`, onclick: () => pick(t),
    }, t === 'transactions' ? 'Transactions' : 'Insights')));
}

// Only one page of rows is put in the DOM. The running balance is still worked out over all of the
// account's transactions, so every page shows the true balance after each row.
