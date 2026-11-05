// Savings goals (Insights → Goals): something to save for, a target in EUR (by a date, or whenever),
// and the accounts put toward it. Each shows how far along it is, when it's reached at the pace of
// what's scheduled into those accounts every month, and, with a date, what it takes a month to make it.

import { today } from './market.js';
import { convert, goalProgress, newId, scheduledEffect, timesAYear, toMinor } from './model.js';
import { missingTables } from './store.js';
import { accountValue, render, state, undoable } from './app.js';
import {
  button, dialog, field, fullDate, h, iconButton, input, latestRate, money, monthLabel,
} from './ui.js';

// Accounts that can hold savings (not cards or loans, which are owed).
const savingAccounts = () => state.accounts.filter((a) => !a.archived && a.type !== 'credit' && a.type !== 'loan');
const inEur = (a, minor) => convert(minor, latestRate(a.currency) ?? 1);

// What's in a goal's accounts today, and what goes into them a month from what's scheduled (in EUR;
// a transfer between two of them counts as nothing).
export function goalFigures(g) {
  const accounts = state.accounts.filter((a) => g.accountIds.includes(a.id));
  const saved = accounts.reduce((sum, a) => sum + inEur(a, accountValue(a)), 0);
  const now = today();
  const monthly = Math.round(state.schedules.filter((s) => !s.endDate || s.endDate >= now)
    .reduce((sum, s) => sum + accounts.reduce((acc, a) => acc + inEur(a, scheduledEffect(s, a.id)), 0) * (timesAYear(s) / 12), 0));
  return { accounts, saved, monthly, ...goalProgress({ saved, target: g.target, monthly, targetDate: g.targetDate }, now) };
}

export function renderGoals() {
  if (missingTables().includes('goals')) {
    return h('section', { class: 'fin-card fin-pad' },
      h('p', { class: 'fin-empty' }, 'Goals need the database updated: run tools/finance/schema.sql again in the Supabase SQL editor, then reload.'));
  }
  return h('div', { class: 'fin-insights' },
    h('div', { class: 'fin-actions fin-goals-actions' },
      button('Add goal', () => openGoalDialog(), 'primary', { 'data-key': 'goal-add', 'aria-haspopup': 'dialog' })),
    state.goals.length === 0
      ? h('section', { class: 'fin-card fin-pad' }, h('p', { class: 'fin-empty' }, 'No goals yet. Add one for something you’re saving for, like an emergency fund or a house deposit, and the accounts that go toward it.'))
      : h('div', { class: 'fin-asset-grid' }, state.goals.map(goalCard)));
}

function goalCard(g) {
  const f = goalFigures(g);
  const pct = Math.round(f.share * 100);
  const headId = `goal-${g.id}`;
  const bar = h('span', { class: 'fin-usage-bar', 'data-level': f.left === 0 ? 'done' : 'ok' });
  bar.style.setProperty('--used', `${pct}%`);
  const pace = f.left === 0 ? 'Reached.'
    : f.monthly > 0 ? `At ${money(f.monthly, 'EUR')} a month going in (from what’s scheduled), reached in ${monthLabel(f.reachBy.slice(0, 7))}.`
      : f.monthly < 0 ? `More is scheduled out of these accounts than into them (${money(-f.monthly, 'EUR')} a month), so it isn’t getting closer.`
        : 'Nothing is scheduled into these accounts each month. Schedule a transfer to see when you’d reach it.';
  const byDate = g.targetDate && f.left > 0 && (f.onTrack
    ? `On track for ${fullDate(g.targetDate)}.`
    : `To make it by ${fullDate(g.targetDate)}: ${money(f.needed, 'EUR')} a month${f.monthly > 0 ? `, ${money(f.needed - f.monthly, 'EUR')} more than now` : ''}.`);
  return h('section', { class: 'fin-card fin-goal', 'aria-labelledby': headId },
    h('div', { class: 'fin-card-head' },
      h('div', {},
        h('h3', { id: headId, class: 'fin-asset-title' }, g.name),
        h('p', { class: 'fin-meta' }, [g.targetDate && `by ${fullDate(g.targetDate)}`, f.accounts.map((a) => a.name).join(', ') || 'no accounts'].filter(Boolean).join(' · '))),
      h('div', { class: 'fin-actions' },
        button('Edit', () => openGoalDialog(g), 'secondary fin-btn-sm', { 'data-key': `goal-edit-${g.id}`, 'aria-label': `Edit ${g.name}`, 'aria-haspopup': 'dialog' }),
        iconButton('trash', `Delete ${g.name}`, () => {
          undoable(`Goal “${g.name}” deleted.`, ['goals'], () => { state.goals = state.goals.filter((x) => x.id !== g.id); });
        }, { danger: true }))),
    h('div', { class: 'fin-pad' },
      h('p', { class: 'fin-goal-figures' },
        h('strong', { class: 'fin-num' }, money(f.saved, 'EUR')), ` of ${money(g.target, 'EUR')}`,
        h('span', { class: 'fin-muted' }, ` · ${pct}%${f.left > 0 ? `, ${money(f.left, 'EUR')} to go` : ''}`)),
      h('span', {
        class: 'fin-usage', role: 'progressbar', 'aria-label': `${g.name}: saved`,
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct),
      }, bar),
      h('p', { class: 'fin-stat-note fin-goal-pace' }, pace),
      byDate && h('p', { class: `fin-stat-note fin-goal-pace ${f.onTrack ? '' : 'fin-goal-behind'}` }, byDate)));
}

function openGoalDialog(existing = null) {
  const g0 = existing ?? { accountIds: [] };
  const name = input({ type: 'text', required: true, autocomplete: 'off', value: g0.name, placeholder: 'e.g. Emergency fund, House deposit' });
  const target = input({ type: 'number', step: '0.01', min: '0.01', required: true, inputmode: 'decimal', value: g0.target != null ? String(g0.target / 100) : null });
  const by = input({ type: 'date', value: g0.targetDate ?? null });
  const boxes = savingAccounts().map((a) => {
    const box = h('input', { type: 'checkbox', value: a.id, checked: g0.accountIds.includes(a.id) });
    return h('label', { class: 'fin-check' }, box, ` ${a.name}`, h('span', { class: 'fin-muted' }, ` · ${money(accountValue(a), a.currency)}`));
  });
  const error = h('p', { class: 'fin-error', role: 'alert' });
  const returnKey = existing ? `goal-edit-${existing.id}` : 'goal-add';
  const close = () => { dialog.close(); render(returnKey); };
  dialog.replaceChildren(h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const accountIds = boxes.map((l) => l.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
      if (!accountIds.length) { error.textContent = 'Pick at least one account that goes toward it.'; boxes[0]?.querySelector('input').focus(); return; }
      const fields = { name: name.value.trim(), target: toMinor(target.value), targetDate: by.value || null, accountIds };
      dialog.close();
      if (existing) undoable(`Saved ${fields.name}.`, ['goals'], () => Object.assign(existing, fields));
      else undoable(`Added goal ${fields.name}.`, ['goals'], () => { state.goals.push({ id: newId(), ...fields }); });
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, existing ? `Edit ${existing.name}` : 'Add goal'),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Name', name), field('Target (EUR)', target),
      field('By', by, 'Optional. Shows what it takes a month to get there by then.')),
    h('fieldset', { class: 'fin-fieldset' }, h('legend', { class: 'fin-legend-label' }, 'Accounts that go toward it'),
      boxes.length ? h('div', { class: 'fin-goal-accounts' }, boxes) : h('p', { class: 'fin-empty' }, 'No accounts to save in yet.')),
    error,
    h('div', { class: 'fin-dialog-actions' },
      button('Cancel', close),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, existing ? 'Save' : 'Add goal'))));
  dialog.showModal();
  name.focus();
}
