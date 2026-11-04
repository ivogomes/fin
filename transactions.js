// Transaction lists: filters, selection and bulk changes, the table, editing in place, an account's
// transactions a page at a time, and Search.

import { rpc } from './cloud.js';
import { today } from './market.js';
import {
  CURRENCIES, IOU_TYPES, categoriesOf, convert, crossConvert, filterTransactions, newId, normalize, occurrences,
  plannedTransactions, ruleSuggestion, scaleSplits, scheduledEffect, searchCategories,
  sortedCategories, splitsOf, toMinor,
} from './model.js';
import {
  addTransactions, editToken, isFromDatabase, loadAllTransactions, markSchemaOutdated, persist,
  settle, transactionsComplete,
} from './store.js';
import { cardPayments } from './accounts.js';
import {
  CARD_NETWORKS, TX_PAGE_SIZE, byName, cardMark, deleteTransactions, editingTxId, ensureRate,
  hasUnsavedInput, render, selectAccount, setEditingTxId, setTxPage, setView, showToast, state,
  totalsOf, txPage, undoable, view,
} from './app.js';
import { comboField, descriptionCombo, floatingList, openTxDialog } from './entry.js';
import { inEur } from './insights.js';
import { personName } from './ious.js';
import { FORECAST_DAYS, daysFromToday, openScheduleDialog, subscriptionChip, upcomingRows } from './schedules.js';
import {
  button, catLabel, catOptions, category, field, h, hueOf, icon, iconButton, input, latestRate,
  flag, loader, money, monthLabel, num, say, select, shortDate, signed, status, tone,
  typeSwitch,
} from './ui.js';

// ── learning rules from manual categories ────────────────────────────────────

export const ruleDeclined = new Set(); // "description|category" offers turned down, for this visit
export async function offerRule(t, categoryId) {
  // The other uncategorised transactions with this description, which the rule could fill in.
  const same = normalize(t.description ?? '');
  if (same && !transactionsComplete()) await fetchTransactions(() => rpc('same_description_uncategorized', { p_key: same }));
  const s = ruleSuggestion(t, categoryId, state.rules, state.transactions);
  if (!s) return;
  const key = `${normalize(s.pattern)}|${categoryId}`;
  if (ruleDeclined.has(key)) return;
  const add = (fill) => {
    // At the top, so it wins over broader rules (the first match decides).
    state.rules.unshift({ id: newId(), pattern: s.pattern, match: s.match, categoryId });
    let n = 0;
    if (fill) {
      for (const x of state.transactions) {
        if (x.id === t.id || x.transferId || categoriesOf(x).length || normalize(x.description) !== normalize(s.pattern)) continue;
        x.categoryIds = [categoryId];
        n += 1;
      }
    }
    persist(); render();
    say(`Rule added${n ? `, and ${n} more transaction${n === 1 ? '' : 's'} categorized` : ''}.`);
  };
  showToast(`Always put “${s.pattern}” in ${catLabel(categoryId)}?`, [
    ...(s.others ? [{ label: `Add rule and fill ${s.others} more`, primary: true, run: () => add(true) }] : []),
    { label: 'Add rule', primary: !s.others, run: () => add(false) },
    { label: 'No', run: () => ruleDeclined.add(key) },
  ], { timeout: 15000 });
}

// ── transaction lists: filters, selection, the table ─────────────────────────

export const selected = new Set(); // ids of selected transactions, in the list on screen
export const txFilters = new Map(); // scope ('acc:<id>' or 'search') → filter
// Lists pick several (any of them matches); an empty one means all. '' among the categories is
// "Uncategorized".
export const EMPTY_FILTER = { text: '', categoryIds: [], types: [], from: '', to: '', min: '', max: '', accountIds: [] };
export const filterOf = (scope) => txFilters.get(scope) ?? EMPTY_FILTER;
export const filterActive = (f) => Boolean(f.text || f.categoryIds.length || f.types.length || f.from || f.to || f.min || f.max || f.accountIds.length);
export let filterTimer = null;

// A filter menu for picking several values: a button saying what's picked ("All categories",
// "Groceries", "3 categories") that opens a list of checkboxes, with a search box when `searchable`.
// Each tick applies at once and the list stays open through the redraw (openMenu), so several can be
// ticked in a row. ↓/↑ move between the boxes, Esc or a click outside closes it.
// `options`: [{ value, label, sub?, hue?, child? }]; `onChange(values, focusKey)`.
export let openMenu = null; // { key, q } of the menu that's open
export let closeMenu = null; // hides it (and stops following the page's scrolling)
export function multiFilter({ key, label, all, many, options, picked, onChange, searchable = false }) {
  const isOpen = openMenu?.key === key;
  const chosen = options.filter((o) => picked.includes(o.value));
  const summary = !chosen.length ? all : chosen.length === 1 ? chosen[0].label : `${chosen.length} ${many}`;
  const btn = h('button', {
    type: 'button', class: `fin-input fin-ms-btn${chosen.length ? ' is-on' : ''}`, 'data-key': key,
    'aria-expanded': 'false', 'aria-controls': `ms-${key}`, 'aria-label': `${label}: ${summary}`,
  }, h('span', { class: 'fin-ms-text' }, summary), h('span', { class: 'fin-ms-caret', 'aria-hidden': 'true' }, '▾'));
  const menu = h('div', { id: `ms-${key}`, class: 'fin-options fin-options--float fin-ms-menu', role: 'group', 'aria-label': label, hidden: true });
  const list = floatingList(btn, menu, 240);
  const boxes = () => [...menu.querySelectorAll('input[type="checkbox"]')].filter((b) => !b.closest('li').hidden);
  const show = (on) => {
    if (closeMenu && on) closeMenu();
    list.open(on);
    openMenu = on ? { key, q: openMenu?.key === key ? openMenu.q : '' } : null;
    closeMenu = on ? () => { list.open(false); if (openMenu?.key === key) openMenu = null; closeMenu = null; } : null;
  };
  const search = searchable && h('input', {
    type: 'search', class: 'fin-input fin-input-sm fin-ms-search', placeholder: 'Search', autocomplete: 'off',
    'aria-label': `Search ${many}`, 'data-key': `${key}-q`, value: isOpen ? openMenu.q : '',
  });
  const items = options.map((o) => {
    const box = h('input', { type: 'checkbox', checked: picked.includes(o.value), 'data-key': `${key}-${o.value || 'none'}` });
    box.addEventListener('change', () => {
      const next = box.checked ? [...picked, o.value] : picked.filter((v) => v !== o.value);
      onChange(next, box.dataset.key);
    });
    return h('li', { class: `fin-ms-item${o.child ? ' fin-option-child' : ''}`, 'data-text': normalize([o.label, o.sub].filter(Boolean).join(' ')) },
      h('label', { class: 'fin-check' }, box,
        o.hue != null && h('span', { class: 'fin-cat-dot', 'data-hue': o.hue, 'aria-hidden': 'true' }),
        h('span', { class: 'fin-option-main' }, o.label),
        o.sub && h('span', { class: 'fin-sub' }, o.sub)));
  });
  const none = h('p', { class: 'fin-option-none', hidden: true }, 'Nothing matches');
  const filterList = () => {
    const words = normalize(search?.value ?? '').split(/\s+/).filter(Boolean);
    items.forEach((li) => { li.hidden = !words.every((w) => li.dataset.text.includes(w)); });
    none.hidden = items.some((li) => !li.hidden);
    // While searching, a child shows its parent's name (the list isn't a tree any more).
    menu.classList.toggle('is-searching', words.length > 0);
    if (openMenu?.key === key) openMenu.q = search?.value ?? '';
  };
  search && search.addEventListener('input', filterList);
  // (Native append prints false; h() is what skips it.)
  menu.append(...[
    search,
    h('ul', { class: 'fin-ms-list' }, items), none,
    chosen.length > 0 && h('button', { type: 'button', class: 'fin-link fin-link-sm fin-ms-clear', 'data-key': `${key}-clear`, onclick: () => { closeMenu?.(); onChange([], key); } }, `Show ${all.toLowerCase()}`),
  ].filter(Boolean));
  btn.addEventListener('click', () => {
    show(menu.hidden);
    if (!menu.hidden) (search || boxes()[0])?.focus();
  });
  menu.addEventListener('keydown', (ev) => {
    const shown = boxes();
    const i = shown.indexOf(document.activeElement);
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); show(false); btn.focus(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); shown[Math.min(i + 1, shown.length - 1)]?.focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); (i > 0 ? shown[i - 1] : search || shown[0])?.focus(); }
    // Enter in the search box ticks the first match (a checkbox's own Enter would submit nothing).
    else if (ev.key === 'Enter' && ev.target === search) { ev.preventDefault(); shown[0]?.click(); }
  });
  if (isOpen) {
    // Open again after a tick redrew the bar: visible now (render puts focus back in it), placed once
    // it's on the page.
    if (closeMenu) closeMenu();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    openMenu = { key, q: search?.value ?? '' };
    filterList();
    queueMicrotask(() => { if (menu.isConnected && openMenu?.key === key) show(true); });
  }
  return h('div', { class: 'fin-ms', 'data-ms': key }, btn, menu);
}
// A click or focus outside the open filter menu closes it.
export const closeMenuOutside = (ev) => {
  if (openMenu && !ev.target.closest?.(`[data-ms="${openMenu.key}"]`)) closeMenu?.();
};
document.addEventListener('mousedown', closeMenuOutside);
document.addEventListener('focusin', closeMenuOutside);

// On a phone an account's filters fold behind a Filters button (CSS shows it on phones only),
// saying how many are on; these scopes are open, while the app is.
const filtersOpen = new Set();
const filtersOn = (f) => [f.text, f.categoryIds.length, f.types.length, f.from || f.to, f.min || f.max, f.accountIds.length].filter(Boolean).length;
export function filterBar(scope, { showAccount = false } = {}) {
  const f = filterOf(scope);
  const set = (patch, focusKey, wait = 0) => {
    targetTx = null;
    txFilters.set(scope, { ...filterOf(scope), ...patch });
    setTxPage(0);
    selected.clear();
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => render(focusKey), wait);
  };
  const text = input({ type: 'search', value: f.text, placeholder: 'Search description, memo or amount', 'data-key': `${scope}-q`, 'aria-label': 'Search transactions' });
  text.addEventListener('input', () => set({ text: text.value }, `${scope}-q`, 250));
  const cat = multiFilter({
    key: `${scope}-cat`, label: 'Categories', all: 'All categories', many: 'categories', searchable: true,
    picked: f.categoryIds, onChange: (ids, focus) => set({ categoryIds: ids }, focus),
    options: [{ value: '', label: 'Uncategorized' }, ...sortedCategories(state.categories).map((c) => ({
      value: c.id, label: c.name, hue: hueOf(c.id), child: Boolean(c.parentId && category(c.parentId)),
      sub: c.parentId ? category(c.parentId)?.name : undefined,
    }))],
  });
  const type = multiFilter({
    key: `${scope}-type`, label: 'Types', all: 'All types', many: 'types',
    picked: f.types, onChange: (types, focus) => set({ types }, focus),
    options: [['expense', 'Expenses'], ['income', 'Income'], ['refund', 'Refunds'], ['dividend', 'Dividends'], ['transfer', 'Transfers']].map(([value, label]) => ({ value, label })),
  });
  // A date box reports a "valid" date after almost every keystroke (typing 2026 passes through 0002,
  // 0020, 0202), and applying it redraws the list and resets the box mid-typing. So it applies a
  // moment after typing stops, only once the year looks real, and at once on Enter or leaving it.
  const dateIn = (k, label) => {
    const el = input({ type: 'date', value: f[k], 'data-key': `${scope}-${k}`, 'aria-label': label });
    const apply = (wait) => {
      if (el.value === filterOf(scope)[k]) return;
      if (el.value && Number(el.value.slice(0, 4)) < 1900) return;
      set({ [k]: el.value }, `${scope}-${k}`, wait);
    };
    el.addEventListener('change', () => apply(1200));
    el.addEventListener('blur', () => apply(0));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(0); } });
    return el;
  };
  const amountIn = (k, label) => {
    const el = input({ type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: f[k], placeholder: label, 'data-key': `${scope}-${k}`, 'aria-label': `${label} amount` });
    el.addEventListener('input', () => set({ [k]: el.value }, `${scope}-${k}`, 400));
    return el;
  };
  const acc = showAccount && multiFilter({
    key: `${scope}-acc`, label: 'Accounts', all: 'All accounts', many: 'accounts', searchable: state.accounts.length > 8,
    picked: f.accountIds, onChange: (ids, focus) => set({ accountIds: ids }, focus),
    options: [...state.accounts].sort(byName).map((a) => ({ value: a.id, label: accountLabel(a), sub: a.archived ? 'archived' : undefined })),
  });
  const fold = scope.startsWith('acc:');
  const open = filtersOpen.has(scope);
  const on = filtersOn(f);
  const toggle = fold && h('button', {
    type: 'button', class: 'fin-btn secondary fin-btn-sm fin-filter-toggle', 'aria-expanded': String(open), 'data-key': `${scope}-fold`,
    onclick: () => { if (open) filtersOpen.delete(scope); else filtersOpen.add(scope); render(`${scope}-fold`); }, // (not the search box: that would bring up the keyboard)
  }, on ? `Filters (${on})` : 'Filters');
  return h('div', { class: `fin-filters${fold ? ' fin-filters--fold' : ''}${open ? ' is-open' : ''}`, role: 'search', 'aria-label': 'Filter transactions' },
    toggle,
    h('div', { class: 'fin-filter-q' }, text),
    acc, cat, type,
    h('div', { class: 'fin-filter-pair' }, dateIn('from', 'From date'), h('span', { class: 'fin-muted' }, '–'), dateIn('to', 'To date')),
    h('div', { class: 'fin-filter-pair' }, amountIn('min', 'Min'), h('span', { class: 'fin-muted' }, '–'), amountIn('max', 'Max')),
    filterActive(f) && button('Clear', () => { closeMenu?.(); txFilters.delete(scope); setTxPage(0); selected.clear(); render(`${scope}-q`); }, 'secondary fin-btn-sm', { 'data-key': `${scope}-clear` }));
}

export function pager(page, pages, total, where, headingId = 'tx-h') {
  const go = (p, key) => {
    setTxPage(Math.min(Math.max(p, 0), pages - 1));
    selected.clear();
    render(key);
    const first = txPage * TX_PAGE_SIZE + 1;
    say(`Showing transactions ${first} to ${Math.min(first + TX_PAGE_SIZE - 1, total)} of ${total}.`);
    if (where === 'bottom') document.getElementById(headingId)?.scrollIntoView({ block: 'start' });
  };
  const first = page * TX_PAGE_SIZE + 1;
  const last = Math.min(first + TX_PAGE_SIZE - 1, total);
  return h('nav', { class: 'fin-pager', 'aria-label': `Transaction pages${where === 'bottom' ? ', bottom' : ''}` },
    h('span', { class: 'fin-muted fin-num' }, `${first}–${last} of ${total}`),
    button('« First', () => go(0, `pg-first-${where}`), 'secondary fin-btn-sm', { disabled: page === 0, 'data-key': `pg-first-${where}` }),
    button('‹ Previous', () => go(page - 1, `pg-prev-${where}`), 'secondary fin-btn-sm', { disabled: page === 0, 'data-key': `pg-prev-${where}` }),
    h('span', { class: 'fin-muted' }, `Page ${page + 1} of ${pages}`),
    button('Next ›', () => go(page + 1, `pg-next-${where}`), 'secondary fin-btn-sm', { disabled: page === pages - 1, 'data-key': `pg-next-${where}` }),
    button('Last »', () => go(pages - 1, `pg-last-${where}`), 'secondary fin-btn-sm', { disabled: page === pages - 1, 'data-key': `pg-last-${where}` }));
}

// Acting on the selection: categories (transfers are left as they are) and delete.
export function bulkBar(pageRows) {
  const picked = state.transactions.filter((t) => selected.has(t.id));
  const categorizable = picked.filter((t) => !t.transferId);
  const setCat = categoryCombo({ label: 'Set the category of the selected transactions', placeholder: 'Set category…', onPick: (id) => {
    undoable(`${catLabel(id)} set on ${categorizable.length} transaction${categorizable.length === 1 ? '' : 's'}.`, ['transactions'], () => {
      for (const t of categorizable) { t.categoryIds = [id]; delete t.splits; }
    });
  } });
  const addCat = categoryCombo({ label: 'Add a category to the selected transactions', placeholder: 'Add category…', onPick: (id) => {
    undoable(`${catLabel(id)} added to ${categorizable.length} transaction${categorizable.length === 1 ? '' : 's'}.`, ['transactions'], () => {
      // A split transaction keeps its parts (a category is added to a part in its edit form).
      for (const t of categorizable) if (!splitsOf(t) && !categoriesOf(t).includes(id)) t.categoryIds = [...categoriesOf(t), id];
    });
  } });
  return h('div', { class: 'fin-bulk', role: 'region', 'aria-label': 'Selected transactions' },
    h('strong', {}, `${picked.length} selected`),
    picked.length < pageRows.length && button(`Select all ${pageRows.length} on this page`, () => { pageRows.forEach((t) => selected.add(t.id)); render('bulk-clear'); }, 'secondary fin-btn-sm'),
    categorizable.length > 0 && setCat.el,
    categorizable.length > 0 && addCat.el,
    categorizable.length > 0 && button('Remove categories', () => undoable(`Categories removed from ${categorizable.length} transaction${categorizable.length === 1 ? '' : 's'}.`, ['transactions'], () => {
      for (const t of categorizable) { t.categoryIds = []; delete t.splits; }
    }), 'secondary fin-btn-sm'),
    button('Delete', () => deleteTransactions(new Set(selected)), 'danger fin-btn-sm'),
    button('Clear selection', () => { selected.clear(); render(); }, 'secondary fin-btn-sm', { 'data-key': 'bulk-clear' }));
}

// Opens a date box's calendar, where the browser can (not every browser can; typing still works).
export function openPicker(el) {
  try { el?.showPicker?.(); } catch { /* not allowed here, or not supported */ }
}
// Clicking anywhere in a date box opens its calendar, not just on its small icon. Keyboard focus
// doesn't, so typing a date stays as it was.
document.addEventListener('click', (e) => {
  const el = e.target;
  if (el instanceof HTMLInputElement && el.type === 'date' && !el.disabled && !el.readOnly) openPicker(el);
});

// Quick edit: one cell of a transaction (its date, amount or description) turns into a box. Enter or
// leaving it saves, Esc cancels. A transfer's other side follows: same date and description, and an
// amount that's converted at that date's rate when the two accounts' currencies differ (otherwise
// the same). Undo puts it back.
export let quickEdit = null; // { id, field }
export const QUICK_NAMES = { date: 'date', amount: 'amount', description: 'description' };
export function quickCell(t, field, label, ...content) {
  const key = `qe-${t.id}-${field}`;
  if (quickEdit?.id !== t.id || quickEdit.field !== field) {
    return h('button', {
      type: 'button', class: 'fin-cell-btn', 'data-key': key, title: `Change the ${QUICK_NAMES[field]}`,
      'aria-label': `Change the ${QUICK_NAMES[field]} of ${label}`,
      onclick: () => {
        quickEdit = { id: t.id, field };
        setEditingTxId(null);
        render('qe-input');
        // A date opens straight onto the calendar (still part of the click, so the browser allows it).
        if (field === 'date') openPicker(document.querySelector('[data-key="qe-input"]'));
      },
    }, ...content);
  }
  const box = input(field === 'date'
    ? { type: 'date', value: t.date, required: true }
    : field === 'amount'
      ? { type: 'number', step: '0.01', min: '0.01', inputmode: 'decimal', value: String(Math.abs(t.amount) / 100) }
      : { type: 'text', value: t.description, autocomplete: 'off' });
  box.classList.add('fin-input-cell');
  box.dataset.key = 'qe-input';
  box.setAttribute('aria-label', `New ${QUICK_NAMES[field]} for ${label}`);
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    quickEdit = null;
    if (save) await saveQuickEdit(t, field, box.value);
    else render(key);
  };
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  box.addEventListener('blur', () => finish(true));
  return box;
}

export async function saveQuickEdit(t, field, raw) {
  const key = `qe-${t.id}-${field}`;
  const tx = state.transactions.find((x) => x.id === t.id);
  const value = raw.trim();
  const partner = tx && transferPartner(tx);
  const unchanged = !tx || (field === 'date' ? value === tx.date : field === 'amount' ? toMinor(value) === Math.abs(tx.amount) : value === tx.description);
  if (unchanged) { render(key); return; }
  if (field === 'description' && !value) { render(key); say('A description can’t be empty.'); return; }
  if (field === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) { render(key); say('That isn’t a date.'); return; }
  if (field === 'amount' && !(toMinor(value) > 0)) { render(key); say('The amount must be above zero.'); return; }
  // A new date needs that day's rates (fetched before the change, so undo stays one step).
  const cur = (id) => state.accounts.find((a) => a.id === id)?.currency ?? 'EUR';
  const day = field === 'date' ? value : tx.date;
  const rates = field === 'date' || (field === 'amount' && partner && cur(partner.accountId) !== cur(tx.accountId))
    ? await Promise.all([ensureRate(cur(tx.accountId), day), partner ? ensureRate(cur(partner.accountId), day) : null])
    : null;
  // The other side of a transfer, from this side's amount: the same, or converted at the day's rate.
  const otherSide = (minor, p2) => (cur(p2.accountId) === cur(tx.accountId) ? minor
    : rates?.[0] != null && rates?.[1] != null ? crossConvert(minor, rates[0], rates[1]) : Math.round(minor * Math.abs(p2.amount / tx.amount)));
  undoable(`${field === 'date' ? 'Date' : field === 'amount' ? 'Amount' : 'Description'} changed.`, ['transactions'], () => {
    const t2 = state.transactions.find((x) => x.id === t.id);
    const p2 = partner && state.transactions.find((x) => x.id === partner.id);
    if (field === 'description') { t2.description = value; if (p2) p2.description = value; }
    if (field === 'date') {
      t2.date = value; t2.rate = rates[0];
      if (p2) { p2.date = value; p2.rate = rates[1]; p2.amount = Math.sign(p2.amount) * otherSide(Math.abs(t2.amount), p2); }
    }
    if (field === 'amount') {
      const next = toMinor(value) * (t2.amount < 0 ? -1 : 1);
      if (p2) p2.amount = Math.sign(p2.amount) * otherSide(Math.abs(next), p2);
      // A split keeps each part's share of the new amount.
      if (splitsOf(t2)) t2.splits = scaleSplits(t2.splits, next);
      t2.amount = next;
    }
  });
  document.querySelector(`[data-key="${key}"]`)?.focus();
}

// The transactions table. `rows` is one page; each may carry `balance` (shown when `showBalance`).
// With `showAccount` (search), each row names its account and amounts are in that account's currency.
// `upcoming(cols)` gives greyed rows to show first (an account's future transactions).
export function txTable(rows, { caption, showBalance = false, showAccount = false, inEur = false, upcoming = null }) {
  const accOf = (t) => state.accounts.find((a) => a.id === t.accountId);
  const cols = 6 + (showBalance ? 1 : 0) + (showAccount ? 1 : 0) + (inEur ? 1 : 0);
  const allOnPage = rows.length > 0 && rows.every((t) => selected.has(t.id));
  const someOnPage = rows.some((t) => selected.has(t.id));
  const pageBox = h('input', {
    type: 'checkbox', class: 'fin-tick', checked: allOnPage, 'aria-label': 'Select all on this page', 'data-key': 'select-page',
    onchange: (e) => { rows.forEach((t) => (e.target.checked ? selected.add(t.id) : selected.delete(t.id))); render('select-page'); },
  });
  pageBox.indeterminate = someOnPage && !allOnPage;
  return h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table fin-tx-table' },
    h('caption', { class: 'fin-sr' }, caption),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', class: 'fin-tick-col' }, pageBox),
      h('th', { scope: 'col' }, 'Date'),
      h('th', { scope: 'col', class: 'fin-r' }, 'Amount'),
      showBalance && h('th', { scope: 'col', class: 'fin-r' }, 'Balance'),
      h('th', { scope: 'col' }, 'Description'),
      showAccount && h('th', { scope: 'col' }, 'Account'),
      h('th', { scope: 'col' }, 'Categories'),
      inEur && h('th', { scope: 'col', class: 'fin-r' }, h('span', { class: 'fin-th-flag' }, flag('EUR'), 'In EUR')),
      h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
    h('tbody', {}, upcoming?.(cols), rows.flatMap((t, i) => {
      const account = accOf(t);
      const cur = account?.currency ?? 'EUR';
      // A heading row at the start of each month makes a long list easier to scan.
      const month = t.date.slice(0, 7);
      const heading = (i === 0 || rows[i - 1].date.slice(0, 7) !== month) && h('tr', { class: 'fin-month' },
        h('th', { colspan: cols, scope: 'colgroup' }, monthLabel(month)));
      // The row being edited turns into a full-width form, so the edit happens in place.
      if (t.id === editingTxId && account) {
        return [heading, h('tr', { class: 'fin-edit-row' },
          h('td', { colspan: cols }, transactionForm(account, state.transactions.find((x) => x.id === t.id))))];
      }
      const label = `${t.description}, ${shortDate(t.date)}`;
      const tr = h('tr', { class: [selected.has(t.id) && 'is-selected', targetTx?.id === t.id && 'is-target'].filter(Boolean).join(' ') || null },
        h('td', { class: 'fin-tick-col c-tick' }, h('input', {
          type: 'checkbox', class: 'fin-tick', checked: selected.has(t.id), 'aria-label': `Select ${label}`, 'data-key': `sel-${t.id}`,
          onchange: (e) => { if (e.target.checked) selected.add(t.id); else selected.delete(t.id); render(`sel-${t.id}`); },
        })),
        // Date, amount and description: click (or Enter) to change just that, in place.
        h('td', { class: 'fin-nowrap c-date' }, quickCell(t, 'date', label,
          h('time', { datetime: t.date }, shortDate(t.date)))),
        h('td', { class: `fin-r fin-num c-amt ${tone(t.amount)}` }, quickCell(t, 'amount', label,
          t.kind === 'refund' && h('span', { class: 'fin-refund', title: 'Refund' }, icon('refund'), h('span', { class: 'fin-sr' }, 'Refund: ')),
          signed(t.amount, cur))),
        showBalance && h('td', { class: 'fin-r fin-num fin-muted c-bal' }, t.balance == null ? '' : money(t.balance, cur)),
        h('td', { class: 'c-desc' }, quickCell(t, 'description', label, t.description),
          subscriptionChip(t),
          t.kind === 'dividend' && h('span', { class: 'fin-sub' }, holdingOf(t.holdingId) ? `Dividend from ${holdingOf(t.holdingId).symbol}` : 'Dividend'),
          t.memo && h('span', { class: 'fin-sub' }, t.memo)),
        showAccount && h('td', { class: 'c-acc' }, h('button', {
          type: 'button', class: 'fin-link fin-link-sm', onclick: () => selectAccount(t.accountId),
        }, ...(account ? accountBadge(account.id) : ['Deleted account']))),
        h('td', { class: 'c-cat' }, categoryCell(t)),
        inEur && h('td', { class: 'fin-r fin-num fin-muted c-eur' }, cur === 'EUR' ? '' : t.rate == null ? 'pending' : signed(convert(t.amount, t.rate), 'EUR')),
        h('td', { class: 'fin-r c-act' }, h('div', { class: 'fin-row-actions' },
          iconButton('edit', `Edit ${label}`, () => { setEditingTxId(t.id); render('tx-desc-edit'); }, { 'data-key': `tx-edit-${t.id}` }),
          iconButton('trash', `Delete ${label}`, () => deleteTransactions(new Set([t.id])), { danger: true }))));
      // Opened from the other side of a transfer: scroll to it once it's on the page.
      if (targetTx?.id === t.id && !targetTx.scrolled) {
        targetTx.scrolled = true;
        queueMicrotask(() => tr.scrollIntoView({ block: 'center' }));
      }
      return [heading, tr];
    }))));
}

// The transaction opened from the other side of a transfer: highlighted in its account's list.
let targetTx = null; // { id, scrolled }
// Opens `t` in its account: the list filtered to its date (so it's on the page however far back it
// is), with it highlighted. The address carries it (tx, on), so it works from another page too.
export function showTransaction(t) {
  setView({ name: 'account', id: t.accountId, tx: t.id, on: t.date });
  render();
}
// Called by render when the view asks for a transaction (showTransaction, or the address).
export function focusTransaction() {
  const { id, tx, on } = view;
  txFilters.set(`acc:${id}`, { ...EMPTY_FILTER, from: on, to: on });
  setTxPage(0);
  selected.clear();
  setEditingTxId(null);
  targetTx = { id: tx, scrolled: false };
  setView({ name: 'account', id });
  say(`Showing ${on ? shortDate(on) : 'that day'} in ${accountName(id)}. Clear the filters to see all of it.`);
}

// ── an account's transactions, a page at a time from the database ─────────────

// Fetches transactions (`get` resolves to database rows) into the ones in use. Pending changes are
// saved first, and the answer is dropped if something changed while it was on its way (it could
// bring back a row just deleted); then it tries again.
export async function fetchTransactions(get) {
  for (let i = 0; i < 3; i += 1) {
    await settle();
    const token = editToken();
    const rows = await get();
    const added = addTransactions(rows, token);
    if (added) return added;
  }
  return null;
}

// Lists drawn from the database (an account's transactions, search results), per scope: which rows
// are on the page, their running balances (accounts), how many match, as last sent. `known`: the
// transactions in use when it was asked for, so one added here since (not in the answer) still shows.
// After a save each is marked stale and asked for again, and keeps showing meanwhile.
export const listViews = new Map();
export const listLoading = new Map();
// The last failure per scope, { key, message }: shown in place of the list, and not asked again
// until the filters (the key) change, so a redraw doesn't retry it in a loop.
export const listErrors = new Map();
export const listError = (scope, key) => (listErrors.get(scope)?.key === key ? listErrors.get(scope).message : null);
export function requestList(scope, key, name, args) {
  if (listLoading.get(scope) === key || listError(scope, key)) return;
  listErrors.delete(scope);
  listLoading.set(scope, key);
  let page = null;
  let known = null;
  fetchTransactions(async () => {
    known = new Set(state.transactions.map((t) => t.id));
    page = await rpc(name, args);
    return [...page.rows, ...(page.planned ?? []), ...page.partners];
  }).then((added) => {
    if (listLoading.get(scope) !== key) return;
    listLoading.delete(scope);
    if (!added || !page) { listErrors.set(scope, { key, message: 'Couldn’t load the transactions. Try again in a moment.' }); renderWhenIdle(); return; }
    listViews.set(scope, {
      key, total: Number(page.total), ids: page.rows.map((r) => r.id), known, page,
      balances: new Map(page.rows.filter((r) => r.balance != null).map((r) => [r.id, Number(r.balance)])),
    });
    renderWhenIdle();
  }).catch((err) => {
    if (listLoading.get(scope) === key) listLoading.delete(scope);
    // PostgREST's answer when a function's arguments changed in a newer schema.sql.
    // Redraw once to show the notice (a redraw asks again, so not on every failure).
    const outdated = /could not find the function/i.test(err.message);
    if (outdated) markSchemaOutdated();
    listErrors.set(scope, { key, message: outdated
      ? 'The database needs updating for these filters: run tools/finance/schema.sql again in the Supabase SQL editor, then reload.'
      : `Couldn’t load the transactions: ${err.message}` });
    renderWhenIdle();
  });
}

// A filter bar's filter as arguments for the database's list functions (fin_match).
export function filterArgs(f) {
  const text = String(f.text ?? '').trim();
  const asAmount = /^[\d.,]+$/.test(text) ? Math.abs(toMinor(text.replace(/,(\d{1,2})$/, '.$1').replace(/,/g, ''))) : null;
  return {
    p_text: normalize(text) || null, p_amount: Number.isFinite(asAmount) ? asAmount : null,
    p_categories: f.categoryIds.some(Boolean) ? f.categoryIds.filter(Boolean) : null,
    p_uncategorized: f.categoryIds.includes(''), p_types: f.types.length ? f.types : null,
    p_from: f.from || null, p_to: f.to || null,
    p_min: f.min === '' || f.min == null ? null : toMinor(f.min), p_max: f.max === '' || f.max == null ? null : toMinor(f.max),
  };
}
// Today's rates for the database's EUR sums, for transactions that don't have their own.
export const ratesArg = () => Object.fromEntries(CURRENCIES.map((c) => [c, latestRate(c) ?? 1]));

// Draws again after data arrives, unless that would wipe something being typed or edited; then the
// next redraw shows it.
export function renderWhenIdle() {
  if (editingTxId || quickEdit || hasUnsavedInput()) return;
  render();
}

export function transactionsSection(account) {
  const scope = `acc:${account.id}`;
  const f = filterOf(scope);
  const filtered = filterActive(f);
  const now = today();
  const key = JSON.stringify([account.id, txPage, f, now]);
  const txView = listViews.get(scope);
  const ready = txView?.key === key;
  if (!ready || txView.stale) {
    requestList(scope, key, 'account_transactions',
      { p_account: account.id, p_today: now, p_limit: TX_PAGE_SIZE, p_offset: txPage * TX_PAGE_SIZE, ...filterArgs(f) });
  }
  const totals = totalsOf(account.id);
  const byId = new Map(state.transactions.map((t) => [t.id, t]));
  // The page's rows (minus any deleted since), plus transactions added here since it was fetched.
  const fresh = ready ? state.transactions.filter((t) => t.accountId === account.id && t.date <= now
    && !txView.known.has(t.id) && !isFromDatabase(t.id) && !txView.ids.includes(t.id)) : [];
  const rows = [
    ...(ready ? txView.ids.map((id) => byId.get(id)).filter((t) => t && t.accountId === account.id && t.date <= now) : []),
    ...(filtered ? filterTransactions(fresh, f, { categories: state.categories }) : fresh),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  // Running balances: on the first page, counted down from the balance right now, so they follow
  // every change at once; elsewhere, the database's (exact again after the next save).
  if (txPage === 0 && !filtered) {
    let bal = totals.balance;
    for (const t of rows) { t.balance = bal; bal -= t.amount; }
  } else {
    for (const t of rows) t.balance = txView?.balances.get(t.id) ?? null;
  }
  const total = ready ? txView.total + fresh.length : totals.past;
  const pages = Math.max(1, Math.ceil(total / TX_PAGE_SIZE));
  if (ready && txPage > pages - 1) { setTxPage(pages - 1); return transactionsSection(account); } // after deleting the last rows of the last page
  for (const id of selected) if (!rows.some((t) => t.id === id)) selected.delete(id);
  // What's coming sits on top of the first page, unless filters are narrowing the list.
  const upcoming = !filtered && txPage === 0
    ? (cols) => upcomingRows(account, { cols, inEur: account.currency !== 'EUR', balance: totals.balance })
    : null;
  const hasUpcoming = Boolean(upcoming) && (plannedTransactions(account.id, state.transactions, now).length > 0
    || state.schedules.some((s) => scheduledEffect(s, account.id) !== 0 && occurrences(s, daysFromToday(FORECAST_DAYS)).length > 0)
    || cardPayments().some((p) => p.card.id === account.id || p.from?.id === account.id));
  return h('section', { class: 'fin-card', 'aria-labelledby': 'tx-h' },
    h('div', { class: 'fin-card-head' },
      h('h3', { id: 'tx-h', class: 'fin-label' }, 'Transactions ', h('span', { class: 'fin-count' }, filtered ? (ready ? `${total} of ${totals.past}` : '…') : String(totals.past))),
      h('div', { class: 'fin-actions' },
        button('Schedule…', () => openScheduleDialog(null, { accountId: account.id }), 'secondary', { 'data-key': 'up-add', 'aria-haspopup': 'dialog' }),
        button('Add transactions', () => openTxDialog('multi', account), 'primary', { 'data-key': 'tx-add', 'aria-haspopup': 'dialog' }))),
    filterBar(scope),
    selected.size > 0 && bulkBar(rows),
    pages > 1 && pager(txPage, pages, total, 'top'),
    !ready && rows.length === 0 && listError(scope, key)
      ? h('p', { class: 'fin-error fin-pad', role: 'alert' }, listError(scope, key))
      : !ready && rows.length === 0
      ? loader('Loading transactions…')
      : rows.length === 0 && !hasUpcoming
        ? h('p', { class: 'fin-empty fin-pad' }, filtered ? 'No transactions match these filters.' : 'No transactions yet.')
        : txTable(rows, {
          caption: `Transactions for ${account.name}, newest first, page ${txPage + 1} of ${pages}${hasUpcoming ? '. Upcoming ones come first and don’t count in the balance yet' : ''}`,
          showBalance: true, inEur: account.currency !== 'EUR', upcoming: hasUpcoming ? upcoming : null,
        }),
    pages > 1 && pager(txPage, pages, total, 'bottom'));
}

// Shown where a view needs every transaction (Insights on an account page) while they load.
export let everythingLoading = false;
export function needEverything() {
  if (!everythingLoading) {
    everythingLoading = true;
    loadAllTransactions()
      .then(() => { everythingLoading = false; renderWhenIdle(); })
      .catch((err) => { everythingLoading = false; say(`Couldn’t load the transactions: ${err.message}`); });
  }
  return loader('Loading all your transactions…');
}

// Earlier descriptions for the suggestions when adding transactions, from the database (one list,
// fetched once per page and again after transactions are saved). Empty until it arrives.
export let descCache = null;
export let descLoading = false;
export function loadDescIndex() {
  if (descLoading) return;
  descLoading = true;
  rpc('description_index')
    .then((list) => { descCache = list; })
    .catch(() => { /* suggestions are a convenience; try again next time */ })
    .finally(() => { descLoading = false; });
}
export function descIndex() {
  if (!descCache) loadDescIndex();
  return descCache ?? [];
}

// Search across every account (archived ones too).
export function renderSearch() {
  // Arriving with something to search for (…?page=search&q=…, from Go to): start with it.
  if (view.q) {
    txFilters.set('search', { ...EMPTY_FILTER, text: view.q });
    setView({ name: 'search' });
  }
  const f = filterOf('search');
  const active = filterActive(f);
  const key = JSON.stringify([txPage, f]);
  const view0 = listViews.get('search');
  const ready = active && view0?.key === key;
  if (active && (!ready || view0.stale)) {
    requestList('search', key, 'search_transactions', {
      p_accounts: f.accountIds.length ? f.accountIds : null, p_limit: TX_PAGE_SIZE, p_offset: txPage * TX_PAGE_SIZE,
      ...filterArgs(f), p_rates: ratesArg(),
    });
  }
  const byId = new Map(state.transactions.map((t) => [t.id, t]));
  const rows = ready ? view0.ids.map((id) => byId.get(id)).filter(Boolean) : [];
  const total = ready ? view0.total : 0;
  const pages = Math.max(1, Math.ceil(total / TX_PAGE_SIZE));
  if (ready && txPage > pages - 1) { setTxPage(pages - 1); return renderSearch(); }
  for (const id of selected) if (!rows.some((t) => t.id === id)) selected.delete(id);
  // Totals of what's found, in EUR (transfers left out, as they only move money around).
  const sums = ready ? view0.page : null;
  return h('div', {},
    h('div', { class: 'fin-account-head' },
      h('div', {}, h('h2', { class: 'fin-title', id: 'search-h', tabindex: '-1' }, 'Search'),
        h('p', { class: 'fin-meta' }, 'Find transactions across all your accounts, archived ones included.'))),
    h('section', { class: 'fin-card', 'aria-labelledby': 'search-res-h' },
      h('div', { class: 'fin-card-head' },
        h('h3', { id: 'search-res-h', class: 'fin-label' }, 'Results ', ready && h('span', { class: 'fin-count' }, String(total))),
        ready && total > 0 && h('p', { class: 'fin-search-totals' },
          h('span', {}, 'In ', h('strong', { class: 'fin-num fin-pos' }, money(Number(sums.in), 'EUR'))),
          h('span', {}, 'Out ', h('strong', { class: 'fin-num fin-neg' }, money(Number(sums.out), 'EUR'))))),
      filterBar('search', { showAccount: true }),
      selected.size > 0 && bulkBar(rows),
      !active
        ? h('p', { class: 'fin-empty fin-pad' }, 'Type something to search for, or pick accounts, categories, types, dates or amounts.')
        : !ready && listError('search', key)
          ? h('p', { class: 'fin-error fin-pad', role: 'alert' }, listError('search', key))
        : !ready
          ? loader('Searching…')
          : rows.length === 0
            ? h('p', { class: 'fin-empty fin-pad' }, 'Nothing matches these filters.')
            : [
              pages > 1 && pager(txPage, pages, total, 'top', 'search-res-h'),
              txTable(rows, { caption: `Search results, newest first, page ${txPage + 1} of ${pages}`, showAccount: true }),
              pages > 1 && pager(txPage, pages, total, 'bottom', 'search-res-h'),
            ]));
}

export const transferPartner = (tx) =>
  tx.transferId && state.transactions.find((x) => x.transferId === tx.transferId && x.id !== tx.id);
// An account as written in text and in menus: a credit card says so, with its network ("Travel card
// (Visa)"), so it can't be mixed up with another account of the same name; `currency` adds that.
export function accountLabel(a, { currency = false } = {}) {
  const extra = [a.type === 'credit' && (CARD_NETWORKS[a.cardNetwork] ?? 'credit card'), currency && a.currency].filter(Boolean);
  return extra.length ? `${a.name} (${extra.join(', ')})` : a.name;
}
export const accountName = (id) => { const a = state.accounts.find((x) => x.id === id); return a ? accountLabel(a) : 'a deleted account'; };
// The same in a badge or a table cell: a card's network mark before its name (the mark names the
// network for screen readers); a card with no network set says "credit card" in words.
export function accountBadge(id) {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) return ['a deleted account'];
  if (a.type !== 'credit') return [a.name];
  const mark = cardMark(a, 'fin-card-mark--tag');
  return mark ? [mark, a.name] : [accountLabel(a)];
}
// Accounts you can pick in a form: the active ones, plus `keep` even if it is archived.
export const pickableAccounts = (keep) => state.accounts.filter((a) => !a.archived || a.id === keep).sort(byName);

// Inline edit of one transaction. For one side of a transfer, the other side follows: same date,
// description and memo, and the same amount. Between currencies the other side has its own field,
// which follows this amount at the rate of the transfer's date until it's typed in (the exact amount
// from a statement, say); when the saved amounts don't match that day's rate, a note offers to.
export function transactionForm(account, tx) {
  const partner = transferPartner(tx);
  const partnerAccount = partner && state.accounts.find((a) => a.id === partner.accountId);
  const crossCurrency = Boolean(partnerAccount && partnerAccount.currency !== account.currency);
  let kind = tx.kind === 'refund' || tx.kind === 'dividend' ? tx.kind : tx.amount > 0 ? 'income' : 'expense';
  // Suggestions fill in the description, and the categories when it has none (never the amount).
  const descCombo = descriptionCombo(descIndex, {
    label: 'Description',
    accountOf: () => account.id,
    onAccept: (e) => {
      desc.value = e.description;
      if (!tx.transferId && !cats.value().length && e.categoryIds.length) cats.set(e.categoryIds);
      amount.focus();
    },
  });
  const desc = descCombo.box;
  desc.required = true;
  desc.value = tx.description;
  desc.dataset.key = 'tx-desc-edit';
  const amount = input({ type: 'number', step: '0.01', min: '0.01', required: true, inputmode: 'decimal', value: String(Math.abs(tx.amount) / 100) });
  const date = input({ type: 'date', required: true, value: tx.date });
  // Between currencies: what the other side's amount is, following this one at the day's rate.
  const other = crossCurrency && input({ type: 'number', step: '0.01', min: '0.01', required: true, inputmode: 'decimal', value: String(Math.abs(partner.amount) / 100) });
  const rateNote = h('p', { class: 'fin-hint', 'aria-live': 'polite' });
  let otherTouched = false;
  let atRate = null; // the other side's amount at the day's rate, once the rates are in
  const syncOther = async ({ follow }) => {
    if (!crossCurrency) return;
    const day = date.value;
    const [ra, rb] = await Promise.all([ensureRate(account.currency, day), ensureRate(partnerAccount.currency, day)]);
    if (day !== date.value) return; // the date changed again meanwhile
    if (ra == null || rb == null) { atRate = null; rateNote.replaceChildren(`No exchange rate for ${shortDate(day)} yet, so ${partnerAccount.currency} stays as typed.`); return; }
    atRate = toMinor(amount.value) > 0 ? crossConvert(toMinor(amount.value), ra, rb) : null;
    if (follow && !otherTouched && atRate != null) other.value = (atRate / 100).toFixed(2);
    const rate = `1 ${account.currency} = ${num(ra / rb, 4)} ${partnerAccount.currency} on ${shortDate(day)}`;
    const off = atRate != null && Math.abs(toMinor(other.value) - atRate) > Math.max(1, atRate * 0.005);
    // (replaceChildren takes nodes one by one, not a list.)
    rateNote.replaceChildren(...(off
      ? [`${rate}, which makes ${money(atRate, partnerAccount.currency)}. `,
        h('button', { type: 'button', class: 'fin-link', onclick: () => { otherTouched = false; other.value = (atRate / 100).toFixed(2); syncOther({ follow: false }); } }, 'Use that day’s rate')]
      : [otherTouched ? `${rate}. The amount typed is kept.` : `${rate}.`]));
  };
  if (crossCurrency) {
    amount.addEventListener('input', () => syncOther({ follow: true }));
    date.addEventListener('change', () => syncOther({ follow: true }));
    other.addEventListener('input', () => { otherTouched = true; syncOther({ follow: false }); });
    syncOther({ follow: false }); // as saved; the note says if it isn't the day's rate
  }
  const cats = categoryPicker(categoriesOf(tx), { label: `Categories of ${tx.description}` });
  const catField = pickerField('Categories', cats);
  const split = splitEditor(splitsOf(tx), { total: () => toMinor(amount.value), currency: account.currency, cats, catField });
  amount.addEventListener('input', () => split.refresh());
  const holdingPick = holdingSelect(tx.holdingId);
  const holdingField = field('From holding', holdingPick, 'Optional. Counts in that holding’s return.');
  const memo = h('textarea', { class: 'fin-input', rows: '2' });
  memo.value = tx.memo ?? '';
  const error = h('p', { class: 'fin-error', role: 'alert' });
  const cancel = () => { setEditingTxId(null); render(`tx-edit-${tx.id}`); };
  const syncKind = () => { holdingField.hidden = kind !== 'dividend'; };
  const kinds = typeSwitch(['expense', 'income', 'refund', 'dividend'], kind, { onChange: (k) => { kind = k; syncKind(); } });
  syncKind();

  return h('form', {
    class: 'fin-tx-form',
    'aria-label': `Edit ${tx.description}`,
    onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } },
    onsubmit: async (e) => {
      e.preventDefault();
      const sign = tx.transferId ? Math.sign(tx.amount) : kind === 'expense' ? -1 : 1;
      const next = toMinor(amount.value) * sign;
      const parts = tx.transferId ? null : split.value();
      if (parts?.error) { error.textContent = parts.error; parts.focus(); return; }
      const dateMoved = tx.date !== date.value;
      const shared = { date: date.value, description: desc.value.trim(), memo: memo.value.trim() };
      if (partner) {
        const partnerCurrency = partnerAccount?.currency ?? 'EUR';
        Object.assign(partner, shared, {
          // The same amount, or (between currencies) the other side's field.
          amount: Math.sign(partner.amount) * (crossCurrency ? toMinor(other.value) : Math.abs(next)),
          rate: !dateMoved && partner.rate != null ? partner.rate : await ensureRate(partnerCurrency, date.value),
        });
      }
      const catsBefore = categoriesOf(tx);
      Object.assign(tx, shared, {
        amount: next,
        kind: tx.transferId ? tx.kind : kind === 'refund' || kind === 'dividend' ? kind : tx.kind === 'opening' ? 'opening' : undefined,
        holdingId: !tx.transferId && kind === 'dividend' ? holdingPick.value || undefined : undefined,
        // Split: each part with the transaction's sign; its categories are the parts' (for filters).
        splits: parts ? parts.parts.map((p) => ({ categoryId: p.categoryId || null, amount: p.amount * sign })) : undefined,
        categoryIds: tx.transferId ? [] : parts ? [...new Set(parts.parts.map((p) => p.categoryId).filter(Boolean))] : cats.value(),
        // Keep the stored rate unless the date moved.
        rate: !dateMoved && tx.rate != null ? tx.rate : await ensureRate(account.currency, date.value),
      });
      setEditingTxId(null);
      persist(); render(`tx-edit-${tx.id}`);
      say(partner ? `Transfer updated in both ${account.name} and ${accountName(partner.accountId)}.` : 'Transaction updated.');
      const added = categoriesOf(tx).find((id) => !catsBefore.includes(id));
      if (added) offerRule(tx, added);
    },
  },
    tx.transferId
      ? h('p', { class: 'fin-hint fin-edit-note' }, `Transfer ${tx.amount < 0 ? 'to' : 'from'} ${accountName(partner?.accountId)}. Changes apply to both sides.`)
      : kinds.el,
    h('div', { class: 'fin-grid' },
      // Between currencies, each amount with its currency's flag.
      comboField('Description', descCombo), field(crossCurrency ? [flag(account.currency), `Amount (${account.currency})`] : `Amount (${account.currency})`, amount),
      crossCurrency && field([flag(partnerAccount.currency), `Amount in ${partnerAccount.name} (${partnerAccount.currency})`], other),
      field('Date', date), !tx.transferId && holdingField),
    crossCurrency && rateNote,
    !tx.transferId && catField,
    !tx.transferId && split.el,
    h('div', { class: 'fin-grid' }, field('Memo', memo)),
    error,
    h('div', { class: 'fin-actions' },
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Save changes'),
      button('Cancel', cancel)));
}

// IOU entries per transaction, built once per render (there can be tens of thousands of rows).
export let iouByTx = null;
export function iousOf(transactionId) {
  if (!iouByTx) {
    iouByTx = new Map();
    for (const e of state.ious) {
      if (!e.transactionId) continue;
      if (!iouByTx.has(e.transactionId)) iouByTx.set(e.transactionId, []);
      iouByTx.get(e.transactionId).push(e);
    }
  }
  return iouByTx.get(transactionId) ?? [];
}

// "Loan · Íris/Sérgio", linking to that person's IOUs.
export function iouLabel(entries) {
  const type = IOU_TYPES[entries[0].kind] ?? (entries[0].amount > 0 ? 'Loan' : 'Settlement');
  const people = [...new Set(entries.map((e) => e.personId))];
  return h('button', {
    type: 'button', class: 'fin-tag fin-tag--iou',
    onclick: () => { setView({ name: 'ious', personId: people[0] }); render('person-h'); },
  }, `${type} · ${people.map(personName).join(', ')}`);
}

export function categoryCell(t) {
  if (t.transferId) {
    const partner = transferPartner(t);
    const chip = [`${t.amount < 0 ? 'To' : 'From'} `, ...accountBadge(partner?.accountId)];
    // A button to the other side, when it's loaded (it comes with the page's transactions).
    return partner
      ? h('button', {
        type: 'button', class: 'fin-tag fin-tag--transfer fin-tag--link',
        'aria-label': `${t.amount < 0 ? 'To' : 'From'} ${accountName(partner.accountId)}: open the other side of this transfer`,
        onclick: () => showTransaction(partner),
      }, ...chip)
      : h('span', { class: 'fin-tag fin-tag--transfer' }, ...chip);
  }
  // Loans, settlements and paying for a friend are shown by their type instead of categories, like
  // transfers. A shared bill is a real expense: it keeps its categories, with the IOU underneath.
  const ious = iousOf(t.id);
  if (ious.length && ious[0].kind !== 'shared_bill') return iouLabel(ious);
  // A split transaction: each part's category with its amount; changed in the edit form.
  const parts = splitsOf(t);
  if (parts) {
    const cur = state.accounts.find((a) => a.id === t.accountId)?.currency ?? 'EUR';
    return h('div', { class: 'fin-cats fin-cats-compact', role: 'group', 'aria-label': `Split of ${t.description}` },
      parts.map((p) => h('span', { class: 'fin-cat-chip fin-cat-chip--part', 'data-hue': p.categoryId ? hueOf(p.categoryId) : '0' },
        h('span', {}, catLabel(p.categoryId) || 'No category'),
        h('span', { class: 'fin-num fin-cat-amt' }, money(Math.abs(p.amount), cur)))),
      h('button', {
        type: 'button', class: 'fin-link fin-link-sm', 'aria-label': `Change the split of ${t.description}`,
        onclick: () => { setEditingTxId(t.id); render('tx-desc-edit'); },
      }, 'Change'),
      ious.length > 0 && h('div', { class: 'fin-sub' }, iouLabel(ious)));
  }
  // Changes save straight away; the picker redraws itself, so the table keeps its place and focus.
  const picker = categoryPicker(categoriesOf(t), {
    label: `Categories of ${t.description}, ${shortDate(t.date)}`,
    compact: true,
    onChange: (ids, change) => {
      const added = ids.find((id) => !categoriesOf(t).includes(id));
      t.categoryIds = ids;
      persist();
      say(change);
      // Categorizing by hand can teach a rule.
      if (added) offerRule(t, added);
    },
  }).el;
  return ious.length ? h('div', {}, picker, h('div', { class: 'fin-sub' }, iouLabel(ious))) : picker;
}

// A search box for categories (ARIA combobox + listbox): typing filters them by name or parent
// (searchCategories), ↓/↑ move, Enter, Tab or a click picks one, Esc closes the list. After a pick the box
// clears and keeps focus, so several can be added in a row. `exclude()` gives the ids to leave out
// (those already picked); `onPick(id)` takes the choice; `onBackspace()` runs on Backspace in an empty
// box. The box is drawn as a small dashed pill (.fin-cat-add) until it's used.
export function categoryCombo({ label, placeholder = '+ Category', exclude = () => [], onPick, onBackspace }) {
  const listId = `cat-${newId().slice(0, 8)}`;
  const box = h('input', {
    type: 'text', class: 'fin-input fin-input-sm fin-cat-add', autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
    'aria-label': label, placeholder,
  });
  const listbox = h('ul', { id: listId, role: 'listbox', class: 'fin-options fin-options--float', hidden: true, 'aria-label': 'Categories' });
  const { open, isOpen } = floatingList(box, listbox, 224);
  let results = [];
  let active = -1;
  const highlight = (i) => {
    active = i;
    [...listbox.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    const li = listbox.children[i];
    if (li?.id) { box.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
  };
  const update = () => {
    results = searchCategories(state.categories, box.value, exclude());
    // Children sit indented under their parent; only a search result names its parent.
    const searching = Boolean(box.value.trim());
    const parent = (c) => c.parentId && category(c.parentId)?.name;
    listbox.replaceChildren(...(results.length ? results.map((c, i) => h('li', {
      id: `${listId}-${i}`, role: 'option', class: `fin-option fin-option-cat${parent(c) && !searching ? ' fin-option-child' : ''}`, 'aria-selected': 'false',
      onmousedown: (ev) => ev.preventDefault(), // keep focus in the box
      onclick: () => pick(c.id),
    },
      h('span', { class: 'fin-cat-dot', 'data-hue': hueOf(c.id), 'aria-hidden': 'true' }),
      h('span', { class: 'fin-option-main' }, c.name),
      searching && parent(c) && h('span', { class: 'fin-sub' }, parent(c))))
      : [h('li', { class: 'fin-option-none', role: 'presentation' }, box.value.trim() ? 'No category matches' : 'No more categories')]));
    open(true);
    if (results.length && box.value.trim()) highlight(0); else active = -1;
  };
  const pick = (id) => {
    box.value = '';
    onPick(id);
    // The picker may have moved the box (a chip was added before it); keep the list where it is.
    if (document.activeElement === box) update(); else open(false);
  };
  box.addEventListener('input', update);
  box.addEventListener('mousedown', () => { if (!isOpen()) setTimeout(update); });
  box.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (!isOpen()) update();
      else if (results.length) highlight(Math.min(active + 1, results.length - 1));
    } else if (ev.key === 'ArrowUp' && isOpen()) {
      ev.preventDefault();
      highlight(Math.max(active - 1, 0));
    } else if (ev.key === 'Enter' && isOpen() && active >= 0) {
      ev.preventDefault();
      ev.stopPropagation(); // not the form's Enter (submit, or next row)
      pick(results[active].id);
    } else if (ev.key === 'Enter' && box.value.trim()) {
      ev.preventDefault(); // text that matches nothing: don't submit the form with it
      ev.stopPropagation();
    } else if (ev.key === 'Tab' && !ev.shiftKey && isOpen() && active >= 0 && box.value.trim()) {
      pick(results[active].id); // and move on, as in the description box
    } else if (ev.key === 'Escape' && isOpen()) {
      ev.preventDefault();
      ev.stopPropagation(); // close the list, not the dialog
      open(false);
    } else if (ev.key === 'Backspace' && !box.value && onBackspace) {
      onBackspace();
    }
  });
  box.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== box) { open(false); box.value = ''; } }, 100));
  return { box, el: h('span', { class: 'fin-combo fin-cat-combo' }, box, listbox) };
}

// Chosen categories as removable chips, plus a search box to add more (categoryCombo). `value()`
// reads the choice; `onChange(ids, message)` runs on every change. `placeholder()` is the box's text
// while nothing is chosen (the quick-entry grid shows what the rules would pick); `refresh()`
// redraws it.
export function categoryPicker(selected, { label, compact = false, onChange, placeholder } = {}) {
  const ids = [...selected];
  const wrap = h('div', { class: `fin-cats${compact ? ' fin-cats-compact' : ''}`, role: 'group', 'aria-label': label });
  const combo = categoryCombo({
    label: `Add a category (${label})`,
    exclude: () => ids,
    onPick: (id) => {
      ids.push(id);
      onChange?.([...ids], `Added ${catLabel(id)}.`);
      paint();
    },
    // Backspace in the empty box removes the last chip, as in an email "To" field.
    onBackspace: () => {
      if (!ids.length) return;
      const id = ids.pop();
      onChange?.([...ids], `Removed ${catLabel(id)}.`);
      paint();
    },
  });
  const paint = (focus) => {
    combo.box.placeholder = ids.length ? '+' : placeholder?.() ?? '+ Category';
    const chips = ids.map((id, i) => h('span', { class: 'fin-cat-chip', 'data-hue': hueOf(id) },
      h('span', {}, catLabel(id) || 'Deleted category'),
      h('button', {
        type: 'button', class: 'fin-cat-x', 'aria-label': `Remove ${catLabel(id) || 'category'}`,
        onclick: () => {
          ids.splice(i, 1);
          onChange?.([...ids], `Removed ${catLabel(id)}.`);
          paint(i);
        },
      }, '×')));
    // Only the chips are redrawn: the box stays put, so it keeps focus and what's typed.
    wrap.querySelectorAll(':scope > .fin-cat-chip').forEach((el) => el.remove());
    if (combo.el.parentNode !== wrap) wrap.append(combo.el);
    combo.el.before(...chips);
    // After removing a chip, focus the next one (or the box), so keyboard users don't lose their place.
    if (typeof focus === 'number') (wrap.querySelectorAll('.fin-cat-x')[focus] ?? combo.box).focus();
  };
  paint();
  // `set(ids)` replaces the choice (a suggestion filling in its categories).
  return {
    el: wrap, box: combo.box, value: () => [...ids], refresh: () => paint(),
    set: (next) => { ids.splice(0, ids.length, ...next.filter((id) => category(id))); paint(); onChange?.([...ids], ''); },
  };
}

// Categories as chips that only show (no × or menu): a schedule's in a list, a suggestion's.
export const catChips = (ids) => ids.length > 0 && h('div', { class: 'fin-cats' },
  ids.map((id) => h('span', { class: 'fin-cat-chip', 'data-hue': hueOf(id) }, h('span', {}, catLabel(id) || 'Deleted category'))));

// A labelled form row for a category picker (a group, so the label is its accessible name).
export function pickerField(label, picker) {
  const id = `f-${newId().slice(0, 8)}`;
  picker.el.removeAttribute('aria-label');
  picker.el.setAttribute('aria-labelledby', id);
  return h('div', { class: 'fin-field fin-mb' }, h('span', { class: 'fin-field-label', id }, label), picker.el);
}

// Splitting a transaction across categories (a supermarket receipt: food and household): parts, each
// a category and an amount, that add up to the transaction's amount. While it's split, the
// categories picker (`catField`) is hidden. `total()` is the amount typed (positive cents).
// `value()`: null when not split, { error, focus } when the parts don't work yet, else { parts }
// with positive amounts. `refresh()` updates what's left after the amount changes.
export function splitEditor(initial, { total, currency, cats, catField }) {
  let parts = initial ? initial.map((p) => ({ categoryId: p.categoryId ?? '', amount: Math.abs(p.amount) })) : null;
  const wrap = h('div', { class: 'fin-split' });
  const note = h('p', { class: 'fin-split-note', 'aria-live': 'polite' });
  const headId = `split-${newId().slice(0, 8)}`;
  const left = () => total() - parts.reduce((sum, p) => sum + p.amount, 0);
  const status = () => {
    if (!parts) return;
    const l = left();
    note.className = `fin-split-note ${l === 0 ? 'fin-split-ok' : 'fin-split-off'}`;
    note.textContent = l === 0 ? 'The parts add up to the amount.'
      : l > 0 ? `${money(l, currency)} left to put in a part.` : `The parts are ${money(-l, currency)} more than the amount.`;
  };
  const paint = (focus) => {
    if (!parts) {
      catField.hidden = false;
      wrap.replaceChildren(h('button', {
        type: 'button', class: 'fin-link fin-link-sm', 'data-key': 'split-start',
        onclick: () => {
          const t = total();
          parts = [{ categoryId: cats.value()[0] ?? '', amount: t > 0 ? t : 0 }, { categoryId: '', amount: 0 }];
          paint(1);
        },
      }, 'Split across categories'));
      if (focus === 'start') wrap.querySelector('button').focus();
      return;
    }
    catField.hidden = true;
    const amounts = [];
    const rows = parts.map((p, i) => {
      const cat = select([['', 'No category'], ...catOptions()], p.categoryId, { 'aria-label': `Category of part ${i + 1}` });
      cat.addEventListener('change', () => { p.categoryId = cat.value; });
      const amt = input({
        type: 'number', step: '0.01', min: '0.01', inputmode: 'decimal', value: p.amount ? String(p.amount / 100) : '',
        'aria-label': `Amount of part ${i + 1} (${currency})`,
      });
      amt.addEventListener('input', () => { p.amount = amt.value === '' ? 0 : toMinor(amt.value); status(); });
      amounts.push(amt);
      return h('li', { class: 'fin-split-row' }, cat, amt,
        parts.length > 2 ? iconButton('trash', `Remove part ${i + 1}`, () => { parts.splice(i, 1); paint(Math.min(i, parts.length - 1)); }) : h('span'));
    });
    wrap.replaceChildren(
      h('span', { class: 'fin-field-label', id: headId }, `Split across categories (${currency})`),
      h('ul', { class: 'fin-split-list', 'aria-labelledby': headId }, rows),
      note,
      h('div', { class: 'fin-actions' },
        button('Add a part', () => { parts.push({ categoryId: '', amount: Math.max(0, left()) }); paint(parts.length - 1); }, 'secondary fin-btn-sm'),
        button('Don’t split', () => { parts = null; paint('start'); }, 'secondary fin-btn-sm')));
    status();
    if (typeof focus === 'number') (amounts[focus]?.value ? amounts[focus] : rows[focus]?.querySelector('select'))?.focus();
  };
  paint();
  return {
    el: wrap,
    refresh: status,
    value: () => {
      if (!parts) return null;
      const bad = parts.findIndex((p) => !(p.amount > 0));
      const firstAmount = (i) => () => wrap.querySelectorAll('.fin-split-row input')[i]?.focus();
      if (parts.length < 2) return { error: 'A split needs at least two parts.', focus: firstAmount(0) };
      if (bad >= 0) return { error: `Part ${bad + 1} needs an amount above zero.`, focus: firstAmount(bad) };
      if (left() !== 0) return { error: `The parts must add up to the amount: ${note.textContent}`, focus: firstAmount(parts.length - 1) };
      return { parts: parts.map((p) => ({ ...p })) };
    },
  };
}

// A dividend's holding: every holding, by symbol, with its account.
export function holdingSelect(selected) {
  const list = [...state.holdings].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return select([['', 'Not linked to a holding'], ...list.map((x) => [x.id, `${x.symbol}${x.name && x.name !== x.symbol ? ` · ${x.name}` : ''} (${accountName(x.accountId)})`])], selected ?? '');
}
export const holdingOf = (id) => state.holdings.find((x) => x.id === id);

export const setIouByTx = (v) => { iouByTx = v; };
export const setDescCache = (v) => { descCache = v; };
