// IOUs: money lent and borrowed, per person.

import { today } from './market.js';
import { IOU_KINDS, IOU_TYPES, newId, normalize, personBalances, personHistory, toMinor } from './model.js';
import { persist } from './store.js';
import { render, setView, state, undoable, view } from './app.js';
import { accountLabel, accountName, pickableAccounts } from './transactions.js';
import {
  button, dialog, field, h, iconButton, input, money, readPref, say, select, shortDate, signed,
  tone, writePref,
} from './ui.js';

// ── IOUs ─────────────────────────────────────────────────────────────────────

export const personName = (id) => state.people.find((p) => p.id === id)?.name ?? 'Someone';
// What a balance means, from your side.
export const owesText = (minor) => (minor > 0 ? 'owes you' : minor < 0 ? 'you owe' : 'settled');

// Lend, get paid back, borrow or pay back. With an account, the money also moves there as a
// transaction linked to the entry; without one (cash, or outside your accounts) only the IOU changes.
export function openIouDialog(preset = {}) {
  const people = [...state.people].sort((a, b) => a.name.localeCompare(b.name));
  const listId = `people-${newId().slice(0, 6)}`;
  const person = input({ type: 'text', required: true, autocomplete: 'off', list: listId, value: preset.personId ? personName(preset.personId) : null });
  const kind = select(Object.entries(IOU_KINDS).map(([k, v]) => [k, v.label]), preset.kind ?? 'lent');
  const amount = input({ type: 'number', step: '0.01', min: '0.01', required: true, inputmode: 'decimal' });
  const date = input({ type: 'date', required: true, value: today() });
  const desc = input({ type: 'text', autocomplete: 'off' });
  const accounts = pickableAccounts(null).filter((a) => a.currency === 'EUR');
  const acc = select([['', 'No account (cash, or outside your accounts)'], ...accounts.map((a) => [a.id, accountLabel(a)])], preset.accountId ?? '');
  const returnKey = document.activeElement?.dataset?.key;
  const close = () => { dialog.close(); render(returnKey); };

  dialog.replaceChildren(h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      // An existing person by name (case and accents ignored), or a new one.
      let p = state.people.find((x) => normalize(x.name) === normalize(person.value));
      if (!p) { p = { id: newId(), name: person.value.trim() }; state.people.push(p); }
      const k = IOU_KINDS[kind.value];
      const minor = toMinor(amount.value);
      const text = desc.value.trim() || `${IOU_TYPES[k.type]} · ${p.name}`;
      let transactionId = null;
      if (acc.value) {
        const t = {
          id: newId(), accountId: acc.value, date: date.value, description: text, amount: minor * k.account,
          categoryIds: [], memo: '', rate: 1,
        };
        state.transactions.push(t);
        transactionId = t.id;
      }
      state.ious.push({ id: newId(), personId: p.id, date: date.value, description: text, amount: minor * k.iou, transactionId, kind: k.type });
      persist(); close();
      const bal = personBalances(state.ious).get(p.id) ?? 0;
      say(`Saved. ${p.name} ${owesText(bal)}${bal ? ` ${money(Math.abs(bal), 'EUR')}` : ''}.`);
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, 'Add an IOU'),
    h('datalist', { id: listId }, people.map((p) => h('option', { value: p.name }))),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Person', person, 'Pick someone or type a new name.'),
      field('What happened', kind),
      field('Amount (EUR)', amount), field('Date', date),
      field('Description', desc, 'Optional.'),
      field('Account', acc, 'Where the money left or arrived. EUR accounts only.')),
    h('div', { class: 'fin-dialog-actions' },
      button('Cancel', close),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Save'))));
  dialog.showModal();
  (preset.personId ? kind : person).focus();
}

export function deleteIou(e) {
  const linked = e.transactionId && state.transactions.find((t) => t.id === e.transactionId);
  undoable(linked ? `Entry deleted, with its ${accountName(linked.accountId)} transaction.` : 'Entry deleted.', ['ious', 'transactions'], () => {
    state.ious = state.ious.filter((x) => x.id !== e.id);
    if (linked) state.transactions = state.transactions.filter((t) => t.id !== linked.id);
  });
}

export function renderIous() {
  if (view.personId && state.people.some((p) => p.id === view.personId)) return renderPerson(view.personId);
  const balances = personBalances(state.ious);
  const people = [...state.people].sort((a, b) =>
    Math.abs(balances.get(b.id) ?? 0) - Math.abs(balances.get(a.id) ?? 0) || a.name.localeCompare(b.name));
  const owedToYou = [...balances.values()].filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const youOwe = [...balances.values()].filter((v) => v < 0).reduce((s, v) => s - v, 0);
  // Settled people (balance 0) are hidden unless the switch is on; the choice is kept on this device.
  const showSettled = readPref('finance:showSettled', false);
  const settledCount = people.filter((p) => !(balances.get(p.id) ?? 0)).length;
  const shown = showSettled ? people : people.filter((p) => balances.get(p.id) ?? 0);
  return h('div', {},
    h('div', { class: 'fin-account-head' },
      h('div', {}, h('h2', { class: 'fin-title' }, 'IOUs'),
        h('p', { class: 'fin-meta' }, 'Money you lent or borrowed, per person.')),
      button('Add an IOU', () => openIouDialog(), 'primary', { 'data-key': 'iou-add', 'aria-haspopup': 'dialog' })),
    h('dl', { class: 'fin-stats' },
      h('div', {}, h('dt', {}, 'Owed to you'), h('dd', { class: 'fin-num fin-pos' }, money(owedToYou, 'EUR'))),
      h('div', {}, h('dt', {}, 'You owe'), h('dd', { class: `fin-num ${youOwe ? 'fin-neg' : ''}` }, money(youOwe, 'EUR')))),
    h('section', { class: 'fin-card' },
      people.length > 0 && h('div', { class: 'fin-card-head' },
        h('h3', { class: 'fin-label' }, 'People ', h('span', { class: 'fin-count' }, String(shown.length))),
        settledCount > 0 && h('label', { class: 'fin-switch' },
          h('input', {
            type: 'checkbox', role: 'switch', checked: showSettled, 'data-key': 'show-settled',
            onchange: (e) => { writePref('finance:showSettled', e.target.checked); render('show-settled'); },
          }),
          h('span', { class: 'fin-switch-track', 'aria-hidden': 'true' }),
          `Show settled (${settledCount})`)),
      people.length === 0
        ? h('p', { class: 'fin-empty fin-pad' }, 'No IOUs yet. Add one, or import Buxfer’s transactions, whose IOU column comes in here.')
        : shown.length === 0
          ? h('p', { class: 'fin-empty fin-pad' }, `Everyone is settled. Turn on “Show settled” to see the ${settledCount} ${settledCount === 1 ? 'person' : 'people'}.`)
          : h('ul', { class: 'fin-people' }, shown.map((p) => {
          const bal = balances.get(p.id) ?? 0;
          return h('li', {}, h('button', {
            type: 'button', class: 'fin-row', 'data-key': `person-${p.id}`,
            onclick: () => { setView({ name: 'ious', personId: p.id }); render('person-h'); },
          },
            h('span', { class: 'fin-row-name' }, p.name),
            h('span', { class: `fin-num ${bal > 0 ? 'fin-pos' : bal < 0 ? 'fin-neg' : 'fin-muted'}` },
              bal ? `${owesText(bal)} ${money(Math.abs(bal), 'EUR')}` : 'settled')));
        }))));
}

export function renderPerson(personId) {
  const p = state.people.find((x) => x.id === personId);
  const rows = personHistory(personId, state.ious);
  const bal = rows[0]?.balance ?? 0;
  const back = () => { setView({ name: 'ious' }); render(`person-${personId}`); };
  return h('div', {},
    h('div', { class: 'fin-bar' }, button('‹ All people', back, 'secondary fin-btn-sm')),
    h('div', { class: 'fin-account-head' },
      h('div', {},
        h('h2', { class: 'fin-title', id: 'person-h', tabindex: '-1', 'data-key': 'person-h' }, p.name),
        h('p', { class: 'fin-meta' }, bal ? `${p.name} ${owesText(bal)} ${money(Math.abs(bal), 'EUR')}` : 'All settled')),
      h('div', { class: 'fin-actions' },
        button('Add an IOU', () => openIouDialog({ personId, kind: bal > 0 ? 'repaid' : 'lent' }), 'primary', { 'data-key': 'iou-add' }),
        button('Rename', () => {
          const name = prompt('New name', p.name)?.trim();
          if (!name || name === p.name) return;
          p.name = name; persist(); render('person-h'); say(`Renamed to ${name}.`);
        }),
        button('Delete', () => {
          if (!confirm(`Delete ${p.name} and their ${rows.length} entries? Linked transactions in your accounts are kept.`)) return;
          state.ious = state.ious.filter((e) => e.personId !== personId);
          state.people = state.people.filter((x) => x.id !== personId);
          persist(); setView({ name: 'ious' }); render('iou-add'); say(`Deleted ${p.name}.`);
        }, 'danger'))),
    h('section', { class: 'fin-card' },
      rows.length === 0 ? h('p', { class: 'fin-empty fin-pad' }, 'No entries.') :
        h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
          h('caption', { class: 'fin-sr' }, `IOU entries with ${p.name}, newest first`),
          h('thead', {}, h('tr', {},
            h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col', class: 'fin-r' }, 'Amount'),
            h('th', { scope: 'col', class: 'fin-r' }, 'Balance'), h('th', { scope: 'col' }, 'Description'),
            h('th', { scope: 'col' }, 'Account'), h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
          h('tbody', {}, rows.map((e) => {
            const t = e.transactionId && state.transactions.find((x) => x.id === e.transactionId);
            return h('tr', {},
              h('td', { class: 'fin-nowrap' }, h('time', { datetime: e.date }, shortDate(e.date))),
              h('td', { class: `fin-r fin-num ${tone(e.amount)}` }, signed(e.amount, 'EUR')),
              h('td', { class: 'fin-r fin-num fin-muted' }, money(e.balance, 'EUR')),
              h('td', {}, e.description),
              h('td', {}, t ? accountName(t.accountId) : h('span', { class: 'fin-muted' }, '—')),
              h('td', { class: 'fin-r' }, h('div', { class: 'fin-row-actions' }, iconButton('trash', `Delete ${e.description}, ${shortDate(e.date)}`, () => deleteIou(e), { danger: true }))));
          }))))),
    h('p', { class: 'fin-hint fin-mt' }, 'Positive amounts mean they owe you more; negative, less (or that you owe them).'));
}
