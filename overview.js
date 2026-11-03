// The Overview: where things stand, alerts, what's coming up, this month's spending, credit cards.

import { today } from './market.js';
import { REFUNDS_UNMATCHED, frequencyLabel, occurrences } from './model.js';
import { accountAlerts, alertsBox, cardPayments, payCard, renderWelcome, statementOf } from './accounts.js';
import {
  accountValue, byName, cardMark, limitUse, netWorthNow, quickAdd, render, selectAccount, setView,
  state, urlOf, usageBar,
} from './app.js';
import { backupToDrive, driveBackupDue, driveFailed, driveOn } from './backups.js';
import { insightsFor, transactionsLoaded } from './insights.js';
import {
  daysFromToday, deleteScheduled, dueLabel, enterScheduled, scheduleAccounts, scheduleSuggestions,
  skipScheduled, subEur, subscriptionsFound,
} from './schedules.js';
import { accountName, transferPartner } from './transactions.js';
import { button, catLabel, h, loader, money, shortDate, signed, tone } from './ui.js';

// ── overview ─────────────────────────────────────────────────────────────────

export const OVERVIEW_DAYS = 14;
// A link to another page (a view). A plain click goes there the app's way (saving first); Ctrl/⌘-click
// still opens a new tab.
export const pageLink = (label, v, cls) => h('a', {
  class: cls, href: urlOf(v),
  onclick: (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setView(v);
    render();
  },
}, label);
// The first page: where things stand, this month's spending against last month's, what's coming in
// the next two weeks, credit cards, and payments that look recurring.
export function renderOverview() {
  const now = today();
  const day = Number(now.slice(8, 10));
  const monthStart = `${now.slice(0, 7)}-01`;
  // Last month up to the same day (or its last day), so the two compare like for like.
  const prevStart = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
  const prevLast = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10);
  const prevEnd = `${prevStart.slice(0, 8)}${String(Math.min(day, Number(prevLast.slice(8, 10)))).padStart(2, '0')}`;
  const r = insightsFor({ from: monthStart, to: now }, null);
  const p = insightsFor({ from: prevStart, to: prevEnd }, null);
  const nw = netWorthNow();
  const lastMonth = new Date(`${prevStart}T00:00:00`).toLocaleDateString(undefined, { month: 'long' });
  const sameDays = `${lastMonth} 1–${Number(prevEnd.slice(8, 10))}`;
  const vsLast = (a, b) => (!b ? `nothing by this day in ${lastMonth}` : (() => {
    const pct = Math.round(((a - b) / Math.abs(b)) * 100);
    return pct === 0 ? `same as ${sameDays}` : `${pct > 0 ? '+' : ''}${pct}% vs ${sameDays}`;
  })());

  return h('div', { class: 'fin-overview' },
    h('div', { class: 'fin-account-head' },
      h('div', {}, h('h2', { class: 'fin-title', id: 'overview-h', tabindex: '-1' }, 'Overview'),
        h('p', { class: 'fin-meta' }, new Date(`${now}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))),
      button('Add transactions', quickAdd, 'primary', { 'data-key': 'ov-add', 'aria-haspopup': 'dialog' })),
    state.accounts.length === 0 ? renderWelcome() : [
      alertsBox(overviewAlerts()),
      h('dl', { class: 'fin-stats' },
        h('div', {}, h('dt', {}, 'Net worth'), h('dd', { class: tone(nw.total) }, money(nw.total, 'EUR')),
          h('p', { class: 'fin-stat-note' }, nw.unconverted ? `${nw.unconverted} account(s) waiting for exchange rates` : 'across your open accounts, in EUR')),
        h('div', {}, h('dt', {}, 'Spent this month'), h('dd', { class: 'fin-neg' }, r ? money(r.expenses, 'EUR') : '…'),
          h('p', { class: 'fin-stat-note' }, r && p ? vsLast(r.expenses, p.expenses) : 'working it out…')),
        h('div', {}, h('dt', {}, 'Income this month'), h('dd', { class: 'fin-pos' }, r ? money(r.income, 'EUR') : '…'),
          h('p', { class: 'fin-stat-note' }, r && p ? vsLast(r.income, p.income) : 'working it out…')),
        // What the subscriptions found cost a month (yearly ones spread over twelve).
        (() => {
          const subs = subscriptionsFound()?.filter((x) => x.status === 'active');
          return h('div', {}, h('dt', {}, 'Subscriptions'),
            h('dd', { class: 'fin-neg' }, subs ? money(subs.reduce((sum, x) => sum + subEur(x, x.monthly), 0), 'EUR') : '…'),
            h('p', { class: 'fin-stat-note' }, subs
              ? [`a month, ${subs.length} found · `, pageLink('See them', { name: 'scheduled', tab: 'subscriptions' }, 'fin-link fin-link-sm')]
              : 'working it out…'));
        })()),
      comingUpCard(),
      h('div', { class: 'fin-overview-grid' },
        r && p ? monthCategoriesCard(r, p, sameDays) : h('section', { class: 'fin-card' }, loader('Working out this month…')),
        creditCardsCard()),
    ]);
}

// Everything due in the next two weeks, across accounts: scheduled dates (with Enter and Skip for
// the next one of each) and transactions already added with a later date. Overdue ones first.
export function comingUpCard() {
  const now = today();
  const until = daysFromToday(OVERVIEW_DAYS);
  const plannedReady = transactionsLoaded('planned', `&date=gt.${now}`);
  const items = [
    ...state.schedules.filter((sc) => state.accounts.some((a) => a.id === sc.accountId && !a.archived))
      .flatMap((sc) => occurrences(sc, until).map((date, i) => ({ s: sc, date, first: i === 0 }))),
    // A transfer shows once, from the side the money leaves.
    ...state.transactions.filter((t) => t.date > now && t.date <= until && !(t.transferId && t.amount > 0)).map((t) => ({ t, date: t.date })),
    ...cardPayments().filter((p) => p.date <= until).map((p) => ({ pay: p, date: p.date })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const cur = (id) => state.accounts.find((a) => a.id === id)?.currency ?? 'EUR';
  const amountOf = (it) => {
    if (it.pay) return h('span', { class: 'fin-num' }, money(it.pay.amount, it.pay.card.currency));
    if (it.t) return h('span', { class: `fin-num ${it.t.transferId ? '' : tone(it.t.amount)}` }, it.t.transferId ? money(-it.t.amount, cur(it.t.accountId)) : signed(it.t.amount, cur(it.t.accountId)));
    const shown = it.s.kind === 'expense' ? -it.s.amount : it.s.amount;
    return h('span', { class: `fin-num ${it.s.kind === 'transfer' ? '' : tone(shown)}` }, it.s.kind === 'transfer' ? money(it.s.amount, cur(it.s.accountId)) : signed(shown, cur(it.s.accountId)));
  };
  return h('section', { class: 'fin-card', 'aria-labelledby': 'coming-h' },
    h('div', { class: 'fin-card-head' },
      h('h3', { id: 'coming-h', class: 'fin-label' }, `Coming up, next ${OVERVIEW_DAYS} days `, h('span', { class: 'fin-count' }, String(items.length))),
      pageLink('All schedules ›', { name: 'scheduled' }, 'fin-link fin-link-sm')),
    !plannedReady && items.length === 0 ? loader('Looking ahead…')
      : items.length === 0 ? h('p', { class: 'fin-empty fin-pad' }, 'Nothing scheduled or dated in the next two weeks.')
        : h('ul', { class: 'fin-coming' }, items.map((it) => {
          const due = it.s || it.pay ? dueLabel(it.date) : null;
          const t = it.t;
          const name = t ? t.description : it.pay ? `${it.pay.card.name} payment` : it.s.description;
          const where = it.pay ? `${it.pay.from?.name ?? 'paid from: not set'} → ${it.pay.card.name}`
            : t ? (t.transferId ? `${accountName(t.accountId)} → ${accountName(transferPartner(t)?.accountId)}` : accountName(t.accountId)) : scheduleAccounts(it.s);
          return h('li', { class: `fin-coming-row${due ? ' fin-due' : ''}` },
            h('time', { class: 'fin-coming-date fin-nowrap', datetime: it.date }, shortDate(it.date)),
            h('span', { class: 'fin-coming-what' }, name,
              h('span', { class: 'fin-sub' }, where, ' · ', it.pay ? `statement of ${shortDate(it.pay.st.close)}` : t ? 'added ahead' : frequencyLabel(it.s).toLowerCase()),
              due && h('span', { class: 'fin-chip fin-chip-inline fin-chip-due' }, due)),
            amountOf(it),
            h('span', { class: 'fin-actions fin-coming-actions' },
              it.pay && button(it.pay.from ? 'Pay…' : 'Set up', () => payCard(it.pay), 'secondary fin-btn-sm',
                { 'aria-label': it.pay.from ? `Pay ${it.pay.card.name}, ${money(it.pay.amount, it.pay.card.currency)} left to pay` : `Set the account ${it.pay.card.name} is paid from`, 'aria-haspopup': 'dialog' }),
              it.s && it.first && it.date <= now && button('Enter', () => enterScheduled(it.s, `ov-enter-${it.s.id}`), 'secondary fin-btn-sm',
                { 'aria-label': `Enter ${name} for ${shortDate(it.date)}`, 'data-key': `ov-enter-${it.s.id}` }),
              it.s && it.first && it.date <= now && button('Skip', () => skipScheduled(it.s, `ov-skip-${it.s.id}`), 'secondary fin-btn-sm',
                { 'aria-label': `Skip ${name} on ${shortDate(it.date)}`, 'data-key': `ov-skip-${it.s.id}` })));
        })));
}

// This month's spending by top-level category, against last month up to the same day.
export function monthCategoriesCard(r, p, sameDays) {
  const rows = r.spending.filter((c) => c.amount > 0).slice(0, 6);
  const top = Math.max(1, ...rows.map((c) => c.amount), ...rows.map((c) => p.spending.find((x) => x.id === c.id)?.amount ?? 0));
  const name = (id) => (id === REFUNDS_UNMATCHED ? 'Refunds with no expense category' : id ? catLabel(id) || 'Deleted category' : 'Uncategorised');
  const bar = (amount, cls) => {
    const el = h('span', { class: `fin-ov-bar ${cls}`, 'aria-hidden': 'true' });
    el.style.setProperty('--w', `${Math.max(0.5, (amount / top) * 100).toFixed(1)}%`);
    return el;
  };
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'ov-cat-h' },
    h('div', { class: 'fin-chart-head' },
      h('h3', { id: 'ov-cat-h', class: 'fin-label' }, 'Spending this month'),
      h('ul', { class: 'fin-legend', 'aria-label': 'Legend' },
        h('li', {}, h('span', { class: 'fin-key fin-key-out' }), 'this month'),
        h('li', {}, h('span', { class: 'fin-key fin-key-prev' }), sameDays))),
    rows.length === 0 ? h('p', { class: 'fin-empty' }, 'No spending yet this month.')
      : h('ul', { class: 'fin-ov-cats' }, rows.map((c) => {
        const before = p.spending.find((x) => x.id === c.id)?.amount ?? 0;
        return h('li', { class: 'fin-ov-cat' },
          h('span', { class: 'fin-ov-cat-name' }, name(c.id)),
          h('span', { class: 'fin-num fin-ov-cat-amt' }, money(c.amount, 'EUR'),
            h('span', { class: 'fin-sub' }, before ? `${money(before, 'EUR')} by now last month` : 'none by now last month')),
          h('span', { class: 'fin-ov-bars' }, bar(c.amount, 'fin-ov-bar-now'), bar(before, 'fin-ov-bar-prev')));
      })),
    pageLink('More in Insights ›', { name: 'insights' }, 'fin-link fin-link-sm'));
}

// Each open credit card: what's owed and, with a limit, how much of it is used and what's left.
export function creditCardsCard() {
  const cards = state.accounts.filter((a) => a.type === 'credit' && !a.archived).sort(byName);
  if (!cards.length) return null;
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'ov-cards-h' },
    h('h3', { id: 'ov-cards-h', class: 'fin-label' }, 'Credit cards'),
    h('ul', { class: 'fin-ov-cards' }, cards.map((a) => {
      const value = accountValue(a);
      const use = limitUse(a, value);
      return h('li', {},
        h('button', { type: 'button', class: 'fin-ov-card', onclick: () => selectAccount(a.id) },
          h('span', { class: 'fin-account-name' }, cardMark(a), a.name),
          h('span', { class: `fin-num ${value < 0 ? 'fin-neg' : ''}` }, value < 0 ? `${money(-value, a.currency)} owed` : value > 0 ? `${money(value, a.currency)} in your favour` : 'nothing owed'),
          use && usageBar(use),
          use && h('span', { class: 'fin-sub' }, use.left < 0
            ? `${money(-use.left, a.currency)} over the limit`
            : `${money(use.left, a.currency)} available · ${use.used}% of ${money(a.creditLimit, a.currency)} used`),
          (() => {
            const st = statementOf(a);
            if (!st) return null;
            return h('span', { class: 'fin-sub' }, st.owed === 0 ? `Statement of ${shortDate(st.close)}: nothing to pay`
              : st.left === 0 ? `Statement of ${shortDate(st.close)}: paid`
                : `${money(st.left, a.currency)} to pay${st.due ? ` by ${shortDate(st.due)}` : ''}`);
          })()));
    })));
}

// The Overview's alerts, most pressing first: schedules left overdue, the accounts' own (low
// balances, cards near their limit, card payments due), a Drive backup that didn't go through,
// subscriptions that stopped but are still scheduled, and payments that look recurring.
export function overviewAlerts() {
  const now = today();
  const days = (d) => Math.round((Date.parse(now) - Date.parse(d)) / 864e5);
  const overdue = state.schedules.filter((s) => s.nextDate < now).sort((a, b) => a.nextDate.localeCompare(b.nextDate))
    .map((s) => ({
      level: 'overdue',
      text: `${s.description} was due on ${shortDate(s.nextDate)}, ${days(s.nextDate) === 1 ? 'yesterday' : `${days(s.nextDate)} days ago`}, and hasn’t been entered or skipped.`,
      action: h('div', { class: 'fin-actions fin-alert-actions' },
        button('Enter', () => enterScheduled(s, 'ov-add'), 'secondary fin-btn-sm', { 'aria-label': `Enter ${s.description} of ${shortDate(s.nextDate)}` }),
        button('Skip', () => skipScheduled(s, 'ov-add'), 'secondary fin-btn-sm', { 'aria-label': `Skip ${s.description} of ${shortDate(s.nextDate)}` })),
    }));
  // Found by the subscription finder as stopped, while its schedule still expects the next charge.
  const stopped = (subscriptionsFound() ?? []).filter((x) => x.status === 'stopped' && x.scheduleId).map((x) => {
    const sched = state.schedules.find((y) => y.id === x.scheduleId);
    return sched && {
      level: 'stopped',
      text: `${x.description} hasn’t been charged since ${shortDate(x.lastDate)}, but its schedule still expects it on ${shortDate(sched.nextDate)}.`,
      action: button('Stop the schedule', () => deleteScheduled(sched), 'secondary fin-btn-sm', { 'aria-label': `Stop the schedule of ${x.description}` }),
    };
  });
  return [...overdue, ...accountAlerts(), driveAlert(), ...stopped, recurringAlert()].filter(Boolean);
}

// Today's backup to Google Drive didn't go through when Fin opened (Google needed you to confirm,
// say); the button tries again, letting Google ask.
export function driveAlert() {
  if (!driveFailed || !driveOn() || !driveBackupDue()) return null;
  return {
    level: 'backup',
    text: `Today’s backup to Google Drive didn’t go through (${driveFailed.replace(/\.$/, '')}).`,
    action: button('Back up now', () => backupToDrive({ interactive: true }), 'secondary fin-btn-sm'),
  };
}

// An alert pointing to payments that look recurring, when there are any (for alertsBox).
export function recurringAlert() {
  const list = scheduleSuggestions();
  if (!list?.length) return null;
  return {
    level: 'recurring',
    text: `${list.length} payment${list.length === 1 ? '' : 's'} look${list.length === 1 ? 's' : ''} recurring but ${list.length === 1 ? 'has' : 'have'} no schedule: ${list.slice(0, 3).map((x) => x.description).join(', ')}${list.length > 3 ? '…' : ''}.`,
    action: pageLink('Review them', { name: 'scheduled' }, 'fin-btn secondary fin-btn-sm'),
  };
}
