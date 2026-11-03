// Adding transactions: the quick-entry grid and the single form, with description suggestions and
// the category picker.

import { fundSearch, isIsin, searchSymbols, today } from './market.js';
import {
  addInterval, batchRow, categorize, crossConvert, frequencyLabel, makeTransfer, newId, normalize,
  suggestDescriptions, toMinor,
} from './model.js';
import { persist } from './store.js';
import { ensureRate, fundCall, refreshPrices, render, state } from './app.js';
import {
  accountLabel, accountName, categoryPicker, descIndex, holdingSelect, pickableAccounts,
  pickerField, splitEditor,
} from './transactions.js';
import { button, catLabel, field, h, input, money, say, select, shortDate, txDialog, typeSwitch } from './ui.js';

// ── add transactions dialog ──────────────────────────────────────────────────

// Two modes, as in Buxfer: "multi" is a grid of quick rows; "single" has every field, including transfers.
export function openTxDialog(mode, account) {
  const close = () => { txDialog.close(); render('tx-add'); };
  const swap = (next) => { txDialog.replaceChildren(next === 'multi' ? multiTxForm(account, close, swap) : singleTxForm(account, close, swap)); txDialog.querySelector('input, select')?.focus(); };
  swap(mode);
  if (!txDialog.open) txDialog.showModal();
  txDialog.querySelector('input[type="text"]')?.focus();
}

export function dialogHead(title, close) {
  return h('div', { class: 'fin-dialog-head' },
    h('h2', { id: 'tx-dialog-h', class: 'fin-dialog-title' }, title),
    button('×', close, 'secondary fin-btn-icon', { 'aria-label': 'Close' }));
}

// Shows a combobox's list floating under its box (fixed to the window, so a dialog or a scrolling
// table can't cut it off), or above it when there isn't room below. `open(on)` shows or hides it.
export function floatingList(box, listbox, minWidth = 288) {
  // Lines the list up with the box; the position goes to CSS as custom properties.
  const place = () => {
    const r = box.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const up = below < 240 && r.top > below;
    const width = Math.min(Math.max(r.width, minWidth), window.innerWidth - 16);
    const set = (k, v) => listbox.style.setProperty(k, `${Math.round(v)}px`);
    listbox.classList.toggle('fin-options--up', up);
    set('--opt-left', Math.max(8, Math.min(r.left, window.innerWidth - 8 - width)));
    set('--opt-width', width);
    set('--opt-top', r.bottom + 4);
    set('--opt-bottom', window.innerHeight - r.top + 4);
    set('--opt-max', Math.min(288, up ? r.top - 12 : below));
  };
  const open = (on) => {
    listbox.hidden = !on;
    box.setAttribute('aria-expanded', String(on));
    // Follow the box while anything scrolls (the dialog, the page) or the window changes size.
    window[on ? 'addEventListener' : 'removeEventListener']('scroll', place, true);
    window[on ? 'addEventListener' : 'removeEventListener']('resize', place);
    if (!on) { box.removeAttribute('aria-activedescendant'); return; }
    place();
  };
  return { open, isOpen: () => !listbox.hidden };
}

// A description box that suggests names from past transactions (ARIA combobox + listbox).
// ↓/↑ move, Enter or Tab take the highlighted one, Esc closes the list. `onAccept(entry)` fills the
// rest of the row. The list floats over the page (fixed to the window), so a dialog or a scrolling
// table can't cut it off; it opens upwards when there isn't room below.
// `index()` gives the earlier descriptions (descIndex).
export function descriptionCombo(index, { label, accountOf, onAccept }) {
  const listId = `desc-${newId().slice(0, 8)}`;
  const box = input({
    type: 'text', autocomplete: 'off', role: 'combobox', 'aria-autocomplete': 'list',
    'aria-expanded': 'false', 'aria-controls': listId, 'aria-label': label,
  });
  const listbox = h('ul', { id: listId, role: 'listbox', class: 'fin-options fin-options--float', hidden: true, 'aria-label': 'Earlier descriptions' });
  let results = [];
  let active = -1;
  const { open, isOpen } = floatingList(box, listbox);
  const highlight = (i) => {
    active = i;
    [...listbox.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    const li = listbox.children[i];
    if (li) { box.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
  };
  const accept = (e) => { open(false); onAccept(e); };
  const update = () => {
    results = suggestDescriptions(index(), box.value, { accountId: accountOf() });
    listbox.replaceChildren(...results.map((e, i) => h('li', {
      id: `${listId}-${i}`, role: 'option', class: 'fin-option fin-option-desc', 'aria-selected': 'false',
      onmousedown: (ev) => ev.preventDefault(), // keep focus in the box
      onclick: () => accept(e),
    },
      h('span', { class: 'fin-option-main' }, e.description),
      h('span', { class: 'fin-sub' }, [
        e.kind === 'transfer' ? `⇄ ${accountName(e.accountId)} → ${accountName(e.toAccountId)}`
          : `${e.kind === 'refund' ? '↩ Refund · ' : ''}${e.categoryIds.map(catLabel).filter(Boolean).join(', ') || 'No category'}`,
        `used ${e.count}×`].join(' · ')))));
    open(results.length > 0);
    // Pre-select the first suggestion only when it starts with what's typed, so Tab or Enter never
    // swap a new description for a different old one; otherwise pick with the arrow keys first.
    if (results.length && results[0].key.startsWith(normalize(box.value))) highlight(0);
    else active = -1;
  };
  box.addEventListener('input', update);
  box.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (!isOpen() && box.value.trim()) update();
      else if (results.length) highlight(Math.min(active + 1, results.length - 1));
    } else if (ev.key === 'ArrowUp' && isOpen()) {
      ev.preventDefault();
      highlight(Math.max(active - 1, 0));
    } else if ((ev.key === 'Enter' || ev.key === 'Tab') && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && isOpen() && active >= 0) {
      ev.preventDefault();
      ev.stopPropagation(); // the form's Enter (next row) shouldn't also run
      accept(results[active]);
    } else if (ev.key === 'Escape' && isOpen()) {
      ev.preventDefault();
      ev.stopPropagation(); // close the list, not the dialog
      open(false);
    }
  });
  box.addEventListener('blur', () => setTimeout(() => open(false), 100));
  return { box, el: h('div', { class: 'fin-combo' }, box, listbox) };
}

// A form row for a description combobox: the label points at its box, the list sits under it.
export function comboField(label, combo, hint) {
  const f = field(label, combo.box, hint);
  f.replaceChild(combo.el, combo.box);
  combo.el.prepend(combo.box);
  return f;
}

// Quick entry: a grid of rows, made for the keyboard. Descriptions suggest earlier ones and fill the
// rest of the row from their latest use; Enter goes to the next row (adding one at the end);
// Ctrl/⌘+Enter saves them all.
export const SIGNS = { expense: '-', income: '+', refund: 'r', transfer: 't' }; // batchRow's codes
export function multiTxForm(account, close, swap) {
  const accounts = pickableAccounts(account.id);
  const index = descIndex;
  const rows = [];
  const body = h('tbody');
  const error = h('p', { class: 'fin-error', role: 'alert' });
  let form;

  const addRow = () => {
    const n = rows.length + 1;
    const r = {};
    Object.assign(r, {
      // Several categories, like the single form; none picked means the rules choose (shown as Auto).
      cat: categoryPicker([], { label: `Categories, row ${n}`, compact: true, placeholder: () => autoLabel() }),
      type: typeSwitch(['expense', 'income', 'refund', 'transfer'], 'expense', { label: `Type, row ${n}`, compact: true, onChange: () => syncType() }),
      // For a transfer, the category cell shows where the money goes instead.
      to: select([['', 'To account…'], ...accounts.map((a) => [a.id, accountLabel(a)])], '', { 'aria-label': `Transfer to, row ${n}`, hidden: true }),
      amount: input({ type: 'number', step: '0.01', min: '0.01', inputmode: 'decimal', 'aria-label': `Amount, row ${n}` }),
      date: input({ type: 'date', value: rows.at(-1)?.date.value || today(), 'aria-label': `Date, row ${n}` }),
      acc: select(accounts.map((a) => [a.id, accountLabel(a)]), rows.at(-1)?.acc.value ?? account.id, { 'aria-label': `Account, row ${n}` }),
    });
    const combo = descriptionCombo(index, {
      label: `Description, row ${n}`,
      accountOf: () => r.acc.value,
      // Fill the row from the latest use of that description, except the amount, which is rarely the
      // same; the cursor goes there next.
      onAccept: (e) => {
        r.desc.value = e.description;
        r.cat.set(e.categoryIds);
        r.type.value = e.kind === 'transfer' ? 'transfer' : e.kind === 'refund' ? 'refund' : e.amount < 0 ? 'expense' : 'income';
        // A transfer brings both of its accounts, when they're still open.
        if (e.kind === 'transfer') {
          if (accounts.some((a) => a.id === e.accountId)) r.acc.value = e.accountId;
          if (accounts.some((a) => a.id === e.toAccountId)) r.to.value = e.toAccountId;
        }
        syncType();
        syncAuto();
        ensureSpareRow();
        r.amount.focus();
      },
    });
    r.desc = combo.box;
    // While no category is picked, the box shows what the rules would pick.
    // (A function declaration: the picker asks for it while the row is still being built.)
    function autoLabel() {
      const id = r.desc && categorize(r.desc.value, state.rules);
      return id ? `Auto: ${catLabel(id)}` : 'Auto';
    }
    const syncAuto = () => r.cat.refresh();
    r.desc.addEventListener('input', () => { syncAuto(); ensureSpareRow(); });
    r.amount.addEventListener('focus', () => r.amount.select());
    // In the amount, + and − switch the row to income or expense without leaving the keyboard.
    r.amount.addEventListener('keydown', (ev) => {
      const k = { '+': 'income', '-': 'expense' }[ev.key];
      if (!k) return;
      ev.preventDefault();
      r.type.value = k;
      syncType();
    });
    const syncType = () => {
      const transfer = r.type.value === 'transfer';
      r.cat.el.hidden = transfer;
      r.to.hidden = !transfer;
    };
    rows.push(r);
    r.tr = h('tr', {},
      h('td', {}, combo.el), h('td', {}, r.type.el), h('td', {}, r.cat.el, r.to),
      h('td', {}, r.amount), h('td', {}, r.date), h('td', {}, r.acc));
    body.append(r.tr);
    return r;
  };
  // Typing in the last row adds another, so there's always an empty one to go to.
  const ensureSpareRow = () => {
    const last = rows.at(-1);
    if (last.desc.value.trim() || last.amount.value) addRow();
  };
  for (let i = 0; i < 3; i += 1) addRow();

  // Enter in a field goes to the next row's description (adding one at the end); Ctrl/⌘+Enter saves.
  const onKey = (ev) => {
    if (ev.key !== 'Enter' || ev.target.tagName === 'TEXTAREA') return;
    if (ev.target.tagName === 'BUTTON' && ev.target.getAttribute('role') !== 'radio') return;
    ev.preventDefault();
    if (ev.metaKey || ev.ctrlKey) { form.requestSubmit(); return; }
    const i = rows.findIndex((r) => r.tr.contains(ev.target));
    if (i < 0) return;
    if (i === rows.length - 1) addRow();
    rows[i + 1].desc.focus();
  };

  form = h('form', {
    onkeydown: onKey,
    onsubmit: async (e) => {
      e.preventDefault();
      const ready = [];
      for (const [i, r] of rows.entries()) {
        const res = batchRow({
          description: r.desc.value, amount: r.amount.value, sign: SIGNS[r.type.value],
          date: r.date.value, accountId: r.acc.value, categoryIds: r.cat.value(), toAccountId: r.to.value,
        }, state.rules);
        if (res.skip) continue;
        if (res.error) {
          error.textContent = `Row ${i + 1} ${res.error}.`;
          (res.error.includes('description') ? r.desc : res.error.includes('date') ? r.date
            : res.error.includes('transfer') ? r.to : r.amount).focus();
          return;
        }
        ready.push(res);
      }
      if (!ready.length) { error.textContent = 'Fill in at least one row.'; rows[0].desc.focus(); return; }
      const acc = (id) => state.accounts.find((a) => a.id === id);
      for (const res of ready) {
        if (res.transfer) {
          // Two linked sides; between currencies, the received amount is converted at that day's rate.
          const { fromId, toId, date, description, sent } = res.transfer;
          const from = acc(fromId);
          const to = acc(toId);
          const [rf, rt] = [await ensureRate(from.currency, date), await ensureRate(to.currency, date)];
          const received = from.currency === to.currency || rf == null || rt == null ? sent : crossConvert(sent, rf, rt);
          const legs = makeTransfer({ from, to, sent, received, date, description });
          legs[0].rate = rf;
          legs[1].rate = rt;
          state.transactions.push(...legs);
        } else {
          const cur = acc(res.tx.accountId).currency;
          state.transactions.push({ id: newId(), ...res.tx, rate: await ensureRate(cur, res.tx.date) });
        }
      }
      persist(); close();
      const transfers = ready.filter((x) => x.transfer).length;
      const later = ready.some((x) => (x.transfer?.date ?? x.tx.date) > today());
      say(`Added ${ready.length - transfers} transaction${ready.length - transfers === 1 ? '' : 's'}${transfers ? ` and ${transfers} transfer${transfers === 1 ? '' : 's'}` : ''}.${later ? ' Those dated after today wait under Upcoming.' : ''}`);
    },
  },
    dialogHead('Add transactions', close),
    h('p', { class: 'fin-keys' },
      h('span', {}, h('kbd', {}, '↓'), h('kbd', {}, '↑'), ' pick a suggestion'),
      h('span', {}, h('kbd', {}, 'Enter'), ' or ', h('kbd', {}, 'Tab'), ' take it'),
      h('span', {}, h('kbd', {}, '+'), h('kbd', {}, '−'), ' in the amount: income or expense'),
      h('span', {}, h('kbd', {}, 'Enter'), ' next row'),
      h('span', {}, h('kbd', {}, /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'), h('kbd', {}, 'Enter'), ' save all')),
    h('div', { class: 'fin-batch-wrap' }, h('table', { class: 'fin-batch' },
      h('thead', {}, h('tr', {}, ['Description', 'Type', 'Category or To', 'Amount', 'Date', 'Account (from)'].map((t) => h('th', { scope: 'col' }, t)))),
      body)),
    h('p', { class: 'fin-hint' }, 'Empty rows are skipped. Type to find a category, and add as many as you like; leave it on Auto to use your rules. A suggestion fills in its category and type, or both accounts for a transfer; you type the amount. For a transfer, pick ⇄ and the account the money goes to.'),
    error,
    h('div', { class: 'fin-dialog-foot' },
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Add transactions'),
      h('span', { class: 'fin-muted' }, 'or'),
      h('button', { type: 'button', class: 'fin-link', onclick: () => swap('single') }, 'Add a single transaction')));
  return form;
}

export function singleTxForm(account, close, swap) {
  const accounts = pickableAccounts(account.id);
  const accountOptions = accounts.map((a) => [a.id, accountLabel(a, { currency: true })]);
  const type = typeSwitch(['expense', 'income', 'refund', 'dividend', 'transfer'], 'expense', { onChange: () => { sync(); suggest(); } });
  // Suggestions fill in the type and categories (or both accounts, for a transfer), not the amount.
  let fillFrom = () => {};
  const descCombo = descriptionCombo(descIndex, {
    label: 'Description', accountOf: () => from.value, onAccept: (e) => fillFrom(e),
  });
  const desc = descCombo.box;
  let suggest = () => {};
  const cats = categoryPicker([], { label: 'Categories', onChange: () => suggest() });
  const amount = input({ type: 'number', step: '0.01', min: '0.01', required: true, inputmode: 'decimal' });
  const date = input({ type: 'date', required: true, value: today() });
  const from = select(accountOptions, account.id);
  const other = accounts.find((a) => a.id !== account.id);
  const to = select([['', 'Choose an account'], ...accountOptions], other?.id ?? '');
  const received = input({ type: 'number', step: '0.01', min: '0.01', inputmode: 'decimal' });
  const memo = h('textarea', { class: 'fin-input', rows: '3' });
  const REPEATS = { never: null, week: { every: 1, unit: 'week' }, month: { every: 1, unit: 'month' }, year: { every: 1, unit: 'year' } };
  const repeat = select([['never', 'Never'], ['week', 'Every week'], ['month', 'Every month'], ['year', 'Every year']], 'never');
  const error = h('p', { class: 'fin-error', role: 'alert' });
  const hint = h('p', { class: 'fin-hint', 'aria-live': 'polite' });

  const amountField = field(`Amount (${account.currency})`, amount);
  const fromField = field('Account', from);
  const toField = field('To account', to);
  const receivedField = field('Amount received', received, 'Filled in from the daily rate. Change it to match what actually arrived.');
  const catField = pickerField('Categories', cats);
  const split = splitEditor(null, { total: () => toMinor(amount.value), currency: account.currency, cats, catField });
  amount.addEventListener('input', () => split.refresh());
  const holdingPick = holdingSelect(null);
  const holdingField = field('From holding', holdingPick, 'Optional. Counts in that holding’s return.');
  const acc = (id) => state.accounts.find((a) => a.id === id);
  let receivedTouched = false;

  // Show the fields each type needs, and keep the received amount in step for cross-currency transfers.
  const sync = async () => {
    const transfer = type.value === 'transfer';
    const a = acc(from.value);
    const b = acc(to.value);
    const cross = transfer && a && b && a.currency !== b.currency;
    fromField.querySelector('label').textContent = transfer ? 'From account' : 'Account';
    toField.hidden = !transfer;
    to.required = transfer;
    split.el.hidden = transfer;
    if (transfer) catField.hidden = true; else if (!split.value()) catField.hidden = false;
    holdingField.hidden = type.value !== 'dividend';
    receivedField.hidden = !cross;
    received.required = Boolean(cross);
    desc.required = !transfer;
    receivedField.querySelector('label').textContent = cross ? `Amount received (${b.currency})` : 'Amount received';
    amountField.querySelector('label').textContent = `Amount (${a?.currency ?? 'EUR'})`;
    if (cross && !receivedTouched && Number(amount.value) > 0) {
      const [ra, rb] = await Promise.all([ensureRate(a.currency, date.value), ensureRate(b.currency, date.value)]);
      if (ra != null && rb != null && !receivedTouched) received.value = (crossConvert(toMinor(amount.value), ra, rb) / 100).toFixed(2);
    }
  };
  suggest = () => {
    if (type.value === 'transfer' || cats.value().length || !desc.value.trim()) { hint.textContent = ''; return; }
    const id = categorize(desc.value, state.rules);
    hint.textContent = id ? `Category from rules: ${catLabel(id)}` : 'No rule matches. It will be uncategorized.';
  };
  [from, to, amount, date].forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', sync));
  received.addEventListener('input', () => { receivedTouched = received.value !== ''; });
  desc.addEventListener('input', suggest);

  // Repeat: also creates a schedule whose next date is one interval after this transaction.
  const scheduleFrom = (fields) => {
    const freq = REPEATS[repeat.value];
    if (!freq) return '';
    const nextDate = addInterval(date.value, freq, Number(date.value.slice(8, 10)));
    state.schedules.push({ id: newId(), ...fields, ...freq, anchorDay: Number(date.value.slice(8, 10)), nextDate, endDate: null });
    return ` Repeats ${frequencyLabel(freq).toLowerCase()}, next on ${shortDate(nextDate)}.`;
  };

  fillFrom = (e) => {
    desc.value = e.description;
    type.value = ['transfer', 'refund', 'dividend'].includes(e.kind) ? e.kind : e.amount < 0 ? 'expense' : 'income';
    if (e.kind === 'transfer') {
      if (accounts.some((a) => a.id === e.accountId)) from.value = e.accountId;
      if (accounts.some((a) => a.id === e.toAccountId)) to.value = e.toAccountId;
    } else {
      cats.set(e.categoryIds);
    }
    receivedTouched = false;
    sync();
    suggest();
    amount.focus();
  };

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      const a = acc(from.value);
      const sent = toMinor(amount.value);
      const common = { date: date.value, memo: memo.value.trim() };
      const laterNote = () => (date.value > today() ? ' It’s dated after today, so it waits under Upcoming.' : '');
      if (type.value === 'transfer') {
        const b = acc(to.value);
        if (!b || b.id === a.id) { error.textContent = 'Pick a different account to transfer to.'; to.focus(); return; }
        const legs = makeTransfer({
          from: a, to: b, sent,
          received: a.currency === b.currency ? sent : toMinor(received.value),
          description: desc.value.trim(), ...common,
        });
        legs[0].rate = await ensureRate(a.currency, date.value);
        legs[1].rate = await ensureRate(b.currency, date.value);
        state.transactions.push(...legs);
        const repeats = scheduleFrom({ description: legs[0].description, amount: sent, kind: 'transfer', accountId: a.id, toAccountId: b.id, categoryIds: [] });
        persist(); close(); say(`Transferred from ${a.name} to ${b.name}.${repeats}${laterNote()}`);
        return;
      }
      const parts = split.value();
      if (parts?.error) { error.textContent = parts.error; parts.focus(); return; }
      const sign = type.value === 'expense' ? -1 : 1;
      // None picked: the rules choose one, as in the quick form. A split's are its parts'.
      const categoryIds = parts ? [...new Set(parts.parts.map((p) => p.categoryId).filter(Boolean))]
        : cats.value().length ? cats.value() : [categorize(desc.value, state.rules)].filter(Boolean);
      state.transactions.push({
        id: newId(), accountId: a.id, description: desc.value.trim(),
        amount: sent * sign,
        categoryIds, rate: await ensureRate(a.currency, date.value), ...common,
        ...(type.value === 'refund' || type.value === 'dividend' ? { kind: type.value } : {}),
        ...(type.value === 'dividend' && holdingPick.value ? { holdingId: holdingPick.value } : {}),
        ...(parts ? { splits: parts.parts.map((p) => ({ categoryId: p.categoryId || null, amount: p.amount * sign })) } : {}),
      });
      const repeats = scheduleFrom({ description: desc.value.trim(), amount: sent, kind: type.value === 'expense' ? 'expense' : 'income', accountId: a.id, toAccountId: null, categoryIds });
      persist(); close(); say(`Transaction added.${repeats}${laterNote()}`);
    },
  },
    dialogHead('Add transaction', close),
    type.el,
    h('div', { class: 'fin-grid fin-grid-2' },
      comboField('Description', descCombo),
      catField, field('Date', date),
      amountField, receivedField,
      fromField, toField, holdingField,
      field('Repeat', repeat, 'Adds a schedule: each next date shows on the account to enter or skip.')),
    split.el,
    hint,
    h('div', { class: 'fin-grid' }, field('Memo', memo)),
    error,
    h('div', { class: 'fin-dialog-foot' },
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Add transaction'),
      h('span', { class: 'fin-muted' }, 'or'),
      h('button', { type: 'button', class: 'fin-link', onclick: () => swap('multi') }, 'Add several transactions')));
  sync();
  return form;
}

// Search-as-you-type for a stock or ETF listing (ARIA combobox with a listbox popup).
// `picked()` returns the chosen listing, or null until one is chosen from the list.
export function symbolPicker(onPick) {
  const listId = `sym-${newId().slice(0, 8)}`;
  const box = input({
    type: 'text', autocomplete: 'off', spellcheck: 'false', role: 'combobox',
    'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
    placeholder: 'Ticker, name or fund ISIN, e.g. VWCE, Apple or LU0109981661',
  });
  const listbox = h('ul', { id: listId, role: 'listbox', class: 'fin-options', hidden: true, 'aria-label': 'Matches' });
  const note = h('p', { class: 'fin-hint', 'aria-live': 'polite' });
  let results = [];
  let active = -1;
  let chosen = null;
  let timer;
  let inflight;

  const open = (on) => { listbox.hidden = !on; box.setAttribute('aria-expanded', String(on)); if (!on) box.removeAttribute('aria-activedescendant'); };
  const highlight = (i) => {
    active = i;
    [...listbox.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    const li = listbox.children[i];
    if (li) { box.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
  };
  const choose = (r) => {
    chosen = r;
    box.value = `${r.symbol} · ${r.name}`;
    note.textContent = `${r.exchange} (${r.country}) · ${r.type} · priced in ${r.currency}`;
    open(false);
    onPick?.(r);
  };
  const paint = () => {
    listbox.replaceChildren(...results.map((r, i) => h('li', {
      id: `${listId}-${i}`, role: 'option', class: 'fin-option', 'aria-selected': 'false',
      onmousedown: (e) => e.preventDefault(), // keep focus in the input
      onclick: () => choose(r),
    },
      h('span', { class: 'fin-option-main' }, h('strong', {}, r.symbol), ` ${r.name}`),
      h('span', { class: 'fin-sub' }, `${r.exchange} · ${r.country} · ${r.type} · ${r.currency}`))));
    active = -1;
    open(results.length > 0);
  };
  const search = async (q) => {
    inflight?.abort();
    inflight = new AbortController();
    try {
      // An ISIN (a fund): ask EODHD what it is; listings from Twelve Data's search follow.
      const fund = isIsin(q) && state.settings.eodhdApiKey ? await fundSearch(q.toUpperCase(), fundCall).catch(() => null) : null;
      const listings = await searchSymbols(q, inflight.signal).catch((err) => { if (fund && err.name !== 'AbortError') return []; throw err; });
      results = fund ? [fund, ...listings] : listings;
      note.textContent = results.length ? `${results.length} matches. Use the arrow keys to choose.` : 'No matches.';
      paint();
    } catch (err) {
      if (err.name !== 'AbortError') note.textContent = 'Search is unavailable right now.';
    }
  };

  box.addEventListener('input', () => {
    chosen = null;
    clearTimeout(timer);
    const q = box.value.trim();
    if (q.length < 2) { results = []; paint(); note.textContent = ''; return; }
    timer = setTimeout(() => search(q), 250);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); open(true); highlight(Math.min(active + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); highlight(Math.max(active - 1, 0)); }
    else if (e.key === 'Enter' && !listbox.hidden && active >= 0) { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape' && !listbox.hidden) { e.preventDefault(); e.stopPropagation(); open(false); }
  });
  box.addEventListener('blur', () => setTimeout(() => open(false), 100));

  return { box, el: h('div', { class: 'fin-combo' }, box, listbox), note, picked: () => chosen };
}

// A holding is priced live unless the provider can't (wrong plan, no ticker), in which case you type
// the price. Manual holdings are skipped by automatic refreshes until you ask for a live price again.
export function priceCell(x) {
  if (!x.manual && !x.priceError) return x.price == null ? 'no price' : money(Math.round(x.price * 100), x.currency);
  const priceIn = input({
    type: 'number', step: 'any', min: '0', inputmode: 'decimal', class: 'fin-input fin-input-sm fin-price',
    value: x.price == null ? null : String(x.price), 'aria-label': `Price of ${x.symbol} in ${x.currency}`,
    'data-key': `price-${x.id}`,
  });
  priceIn.addEventListener('change', () => {
    const value = Number(priceIn.value);
    if (!(value >= 0) || priceIn.value === '') return;
    Object.assign(x, { price: value, manual: true, priceAt: new Date().toISOString() });
    delete x.priceError;
    persist(); render(); say(`Price of ${x.symbol} set to ${money(Math.round(value * 100), x.currency)}.`);
  });
  return h('div', { class: 'fin-price-edit' },
    priceIn,
    x.manual && h('span', { class: 'fin-sub' }, 'Entered by hand · ',
      h('button', {
        type: 'button', class: 'fin-link fin-link-sm',
        onclick: () => { x.manual = false; refreshPrices([x]); },
      }, 'try live price')));
}
