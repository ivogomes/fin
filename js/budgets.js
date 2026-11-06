// Budget envelopes (Insights → Budgets): money in the everyday accounts is given a job by assigning
// it to categories, month by month, in EUR. What isn't assigned yet is "to budget". Each envelope
// shows what's assigned, spent and available; with rollover, what's left at the end of a month stays
// in it (and what's overspent comes off it), without, it goes back to be budgeted.

import { today } from './market.js';
import {
  BUDGET_ACCOUNT_TYPES, addMonths, budgetProgress, freezePast, newId, sortedCategories, spentIn, toBudget,
  toMinor, unbudgeted,
} from './model.js';
import { missingTables } from './store.js';
import { render, state, undoable } from './app.js';
import { ask } from './insights.js';
import { pageLink } from './overview.js';
import { ratesArg } from './transactions.js';
import {
  button, catLabel, catOptions, dialog, field, h, iconButton, input, loader, money, monthLabel, say, select, signed,
} from './ui.js';

// The month shown ('YYYY-MM'), kept while the page is open.
let budgetMonth = null;
const thisMonth = () => today().slice(0, 7);
const lastDay = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
const spendBetween = (from, to) => ask('insight_totals', { p_from: from, p_to: to, p_accounts: null, p_only: null, p_rates: ratesArg() });

// What was spent a month in a category over the last three whole months, or undefined while loading.
function typicalMonth(categoryId) {
  const from = `${addMonths(thisMonth(), -3)}-01`;
  const totals = spendBetween(from, lastDay(addMonths(thisMonth(), -1)));
  return totals && Math.round(spentIn(categoryId, totals.spend, state.categories) / 3);
}

// The money in the everyday accounts (EUR) at the end of `month`, or today for this month and later;
// undefined while the database works it out.
function cashAt(month) {
  const ids = state.accounts.filter((a) => BUDGET_ACCOUNT_TYPES.has(a.type)).map((a) => a.id);
  if (!ids.length) return 0;
  const end = lastDay(month);
  const runs = ask('balances_at', { p_dates: [end < today() ? end : today()], p_rates: ratesArg(), p_accounts: ids });
  return runs && Object.values(runs).reduce((sum, r) => sum + Number(r.values?.[0] ?? 0), 0);
}

export function renderBudgets() {
  if (missingTables().includes('budgets')) {
    return h('section', { class: 'fin-card fin-pad' },
      h('p', { class: 'fin-empty' }, 'Budgets need the database updated: run tools/finance/db/schema.sql again in the Supabase SQL editor, then reload.'));
  }
  const month = budgetMonth ?? thisMonth();
  const go = (n) => { budgetMonth = addMonths(month, n); render(n < 0 ? 'budget-prev' : 'budget-next'); say(monthLabel(budgetMonth)); };
  const nav = h('div', { class: 'fin-actions fin-budget-nav' },
    button('‹', () => go(-1), 'secondary fin-btn-sm', { 'data-key': 'budget-prev', 'aria-label': 'Previous month' }),
    h('h3', { class: 'fin-label fin-budget-month', 'aria-live': 'polite' }, monthLabel(month)),
    button('›', () => go(1), 'secondary fin-btn-sm', { 'data-key': 'budget-next', 'aria-label': 'Next month' }),
    month !== thisMonth() && button('This month', () => { budgetMonth = null; render('budget-add'); }, 'secondary fin-btn-sm'),
    h('span', { class: 'fin-spacer' }),
    button('Add envelope', () => openBudgetDialog(null, month), 'primary', { 'data-key': 'budget-add', 'aria-haspopup': 'dialog' }));

  if (!state.budgets.length) {
    return h('div', { class: 'fin-insights' }, nav,
      h('section', { class: 'fin-card fin-pad' }, h('p', { class: 'fin-empty' },
        'No envelopes yet. Add one for each category you spend on, like groceries, rent or eating out, and assign the money in your everyday accounts to them month by month until nothing is left to budget.')));
  }

  // Envelopes started by this month, parents first, each family together.
  const order = sortedCategories(state.categories).map((c) => c.id);
  const rank = (b) => { const i = order.indexOf(b.categoryId); return i < 0 ? order.length : i; };
  const shown = state.budgets.filter((b) => b.startMonth <= month).sort((a, b) => rank(a) - rank(b));
  const budgeted = new Set(shown.map((b) => b.categoryId));

  const from = `${month}-01`;
  const to = lastDay(month);
  const totals = spendBetween(from, to);
  const cash = cashAt(month);
  // With rollover, what was spent from each envelope's first month to the month before this one.
  const starts = [...new Set(shown.filter((b) => b.rollover && b.startMonth < month).map((b) => b.startMonth))];
  const before = new Map(starts.map((s) => [s, spendBetween(`${s}-01`, lastDay(addMonths(month, -1)))]));
  if (!totals || cash === undefined || [...before.values()].some((x) => !x)) return h('div', { class: 'fin-insights' }, nav, loader('Working out budgets…'));

  const now = today();
  const dayShare = month < thisMonth() ? 1 : month > thisMonth() ? 0 : Number(now.slice(8)) / Number(to.slice(8));
  const rows = shown.map((b) => ({
    b,
    p: budgetProgress(b, {
      month, dayShare,
      spent: spentIn(b.categoryId, totals.spend, state.categories, budgeted),
      before: before.has(b.startMonth) && b.rollover ? spentIn(b.categoryId, before.get(b.startMonth).spend, state.categories, budgeted) : 0,
    }),
  }));
  const sum = (key) => rows.reduce((s, { p }) => s + p[key], 0);
  const ready = toBudget(cash, rows.map((r) => r.p));
  const outside = unbudgeted(shown, totals.spend, state.categories);
  const daysLeft = month === thisMonth() ? Number(to.slice(8)) - Number(now.slice(8)) + 1 : 0;

  return h('div', { class: 'fin-insights' }, nav,
    h('dl', { class: 'fin-stats' },
      h('div', { class: `fin-stat-key ${ready < 0 ? 'is-neg' : ''}` }, h('dt', {}, 'To budget'),
        h('dd', { class: ready < 0 ? 'fin-neg' : '' }, money(ready, 'EUR')),
        h('p', { class: 'fin-stat-note' }, ready > 0 ? 'not in an envelope yet: assign it'
          : ready < 0 ? 'more is assigned than you have: take some out of envelopes' : 'every euro has a job')),
      h('div', {}, h('dt', {}, 'Assigned'), h('dd', {}, money(sum('assigned'), 'EUR')), h('p', { class: 'fin-stat-note' }, 'this month')),
      h('div', {}, h('dt', {}, 'Spent'), h('dd', { class: 'fin-neg' }, money(sum('spent'), 'EUR')), h('p', { class: 'fin-stat-note' }, 'from envelopes')),
      h('div', {}, h('dt', {}, 'Available'), h('dd', { class: sum('left') < 0 ? 'fin-neg' : 'fin-pos' }, signed(sum('left'), 'EUR')),
        daysLeft > 0 && sum('left') > 0 && h('p', { class: 'fin-stat-note' }, `${money(Math.floor(sum('left') / daysLeft), 'EUR')} a day for ${daysLeft} more day${daysLeft === 1 ? '' : 's'}`)),
      outside !== 0 && h('div', {}, h('dt', {}, 'Without an envelope'), h('dd', {}, money(outside, 'EUR')),
        h('p', { class: 'fin-stat-note' }, 'spent, straight out of what’s to budget'))),
    h('section', { class: 'fin-card', 'aria-label': `Envelopes for ${monthLabel(month)}` },
      h('div', { class: 'fin-budget fin-budget-cols fin-budget-th', 'aria-hidden': 'true' },
        h('span', {}, 'Envelope'), h('span', { class: 'fin-r' }, 'Assigned'), h('span', { class: 'fin-r' }, 'Spent'), h('span', { class: 'fin-r' }, 'Available'), h('span', {})),
      h('ul', { class: 'fin-budgets' }, rows.map(({ b, p }) => budgetRow(b, p, { month, from, to, daysLeft })))),
    h('p', { class: 'fin-hint fin-mt' }, 'To budget is the money in your checking, cash and credit card accounts less what the envelopes hold. Income adds to it, and so does what’s left in an envelope without carry over at the end of a month; money moved to a savings or investment account or spent without an envelope comes out of it. Spending counts as on the Income and spending tab: refunds lower it and transfers between your accounts don’t count. An envelope on a category also takes its subcategories that have none of their own.'));
}

function budgetRow(b, p, { month, from, to, daysLeft }) {
  const name = catLabel(b.categoryId) || 'Deleted category';
  const pct = Math.round(p.share * 100);
  const bar = h('span', { class: 'fin-usage-bar', 'data-level': p.over ? 'high' : p.ahead ? 'mid' : 'ok' });
  bar.style.setProperty('--used', `${pct}%`);
  // This month's assignment, typed in place; the default amount clears the month's own.
  const assign = input({
    type: 'number', step: '0.01', min: '0', inputmode: 'decimal', class: 'fin-input fin-budget-assign',
    value: String(p.assigned / 100), 'data-key': `budget-assign-${b.id}`, 'aria-label': `Assigned to ${name} in ${monthLabel(month)}`,
  });
  assign.addEventListener('change', () => {
    const value = assign.value === '' ? 0 : toMinor(assign.value);
    if (Number.isNaN(value) || value === p.assigned) return;
    undoable(`${money(value, 'EUR')} assigned to ${name} in ${monthLabel(month)}.`, ['budgets'], () => {
      const { [month]: _, ...rest } = b.assigned ?? {};
      b.assigned = value === b.amount ? rest : { ...rest, [month]: value };
    });
  });
  const notes = [
    p.over ? `${money(-p.left, 'EUR')} overspent${b.rollover ? '' : ', taken from what’s to budget next month'}` : !b.rollover && p.left > 0 && month <= thisMonth() ? 'what’s left goes back to be budgeted at the month’s end' : '',
    !p.over && p.ahead && 'ahead of the month’s pace',
    !p.over && daysLeft > 1 && p.left > 0 && `${money(Math.floor(p.left / daysLeft), 'EUR')} a day`,
    p.carry > 0 && `${money(p.carry, 'EUR')} carried over`,
    p.carry < 0 && `${money(-p.carry, 'EUR')} overspent before`,
  ].filter(Boolean);
  return h('li', { class: 'fin-budget' },
    h('div', { class: 'fin-budget-cols' },
      pageLink(name, { name: 'search', cats: [b.categoryId], from, to }, 'fin-budget-name fin-break-link'),
      h('span', { class: 'fin-r' }, assign),
      h('span', { class: 'fin-r fin-num' }, h('span', { class: 'fin-stack-label' }, 'Spent '), money(p.spent, 'EUR')),
      h('span', { class: `fin-r fin-num ${p.over ? 'fin-neg' : ''}` }, h('span', { class: 'fin-stack-label' }, 'Available '), h('strong', {}, money(p.left, 'EUR'))),
      h('span', { class: 'fin-actions' },
        button('Edit', () => openBudgetDialog(b), 'secondary fin-btn-sm', { 'data-key': `budget-edit-${b.id}`, 'aria-label': `Edit the ${name} envelope`, 'aria-haspopup': 'dialog' }),
        iconButton('trash', `Delete the ${name} envelope`, () => {
          undoable(`Envelope for ${name} deleted.`, ['budgets'], () => { state.budgets = state.budgets.filter((x) => x.id !== b.id); });
        }, { danger: true }))),
    h('span', {
      class: 'fin-usage', role: 'progressbar', 'aria-label': `${name}: spent`,
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct),
    }, bar),
    notes.length > 0 && h('p', { class: `fin-stat-note ${p.over ? 'fin-neg' : ''}` }, notes.join(' · ')));
}

function openBudgetDialog(existing = null, month = thisMonth()) {
  const taken = new Set(state.budgets.filter((b) => b !== existing).map((b) => b.categoryId));
  const options = catOptions().filter(([id]) => !taken.has(id));
  if (!options.length) { say('Every category already has an envelope.'); return; }
  const cat = select(options, existing?.categoryId ?? options[0][0]);
  const amount = input({ type: 'number', step: '0.01', min: '0', required: true, inputmode: 'decimal', value: existing ? String(existing.amount / 100) : null });
  const rollover = h('input', { type: 'checkbox', id: 'budget-rollover', checked: existing ? Boolean(existing.rollover) : true });
  const typical = h('p', { class: 'fin-hint', 'aria-live': 'polite' });
  // The three months' sums arrive from the database; until then, look again a few times.
  const showTypical = (tries = 0) => {
    const t = typicalMonth(cat.value);
    typical.textContent = t === undefined ? '' : t > 0 ? `You spent about ${money(t, 'EUR')} a month on it over the last three months.` : 'Nothing spent on it in the last three months.';
    if (t === undefined && tries < 20 && dialog.open) setTimeout(() => showTypical(tries + 1), 300);
  };
  cat.addEventListener('change', () => showTypical());
  const returnKey = existing ? `budget-edit-${existing.id}` : 'budget-add';
  const close = () => { dialog.close(); render(returnKey); };
  dialog.replaceChildren(h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const fields = { categoryId: cat.value, amount: toMinor(amount.value), rollover: rollover.checked };
      const name = catLabel(fields.categoryId);
      dialog.close();
      // A new default applies from this month on; the months before keep what they had.
      if (existing) {
        undoable(`Saved the envelope for ${name}.`, ['budgets'], () => {
          if (fields.amount !== existing.amount) existing.assigned = freezePast(existing, thisMonth());
          Object.assign(existing, fields);
        });
      } else undoable(`Added an envelope for ${name}.`, ['budgets'], () => { state.budgets.push({ id: newId(), ...fields, assigned: {}, startMonth: month }); });
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, existing ? `Edit the envelope for ${catLabel(existing.categoryId)}` : 'Add envelope'),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Category', cat, 'Its subcategories without an envelope of their own count toward it.'),
      field('Assigned a month (EUR)', amount, existing ? 'From this month on; earlier months keep theirs. Change a single month on the Budgets tab.' : 'Each month by default; change a single month on the Budgets tab.')),
    typical,
    h('div', { class: 'fin-check' }, rollover,
      h('label', { for: 'budget-rollover' }, 'Carry over: what’s left at the end of a month stays in the envelope, and what’s overspent comes off next month. Off, both go back to what’s to budget.')),
    h('div', { class: 'fin-dialog-actions' },
      button('Cancel', close),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, existing ? 'Save' : 'Add envelope'))));
  dialog.showModal();
  showTypical();
  (existing ? amount : cat).focus();
}
