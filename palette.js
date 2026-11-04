// Go to (Ctrl/⌘+K): jump anywhere or start something from the keyboard.

import { ACCOUNT_TYPE_LABELS, normalize } from './model.js';
import { openAccountDialog } from './accounts.js';
import { openAssetDialog } from './assets.js';
import {
  accountValue, byName, quickAdd, render, selectAccount, setHideAmounts, setView, state, view,
} from './app.js';
import { openTxDialog } from './entry.js';
import { IMPORT_KINDS } from './imports.js';
import { openScheduleDialog } from './schedules.js';
import { SETTINGS_PAGES } from './settings.js';
import { h, hideAmounts, input, money } from './ui.js';

// ── Go to: jump anywhere or start something, from the keyboard (Ctrl/⌘+K) ─────

export const cmdDialog = document.getElementById('cmd-dialog');
export const cmdOpen = document.getElementById('cmd-open');
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
cmdOpen.title = `Go to anything (${isMac ? '⌘K' : 'Ctrl+K'})`;
cmdOpen.querySelector('kbd').textContent = isMac ? '⌘K' : 'Ctrl K';

// Everything the palette offers: pages, accounts, settings pages and actions, plus searching the
// transactions for what's typed. `words` are extra terms it can be found by.
export function paletteItems(query) {
  const go = (v) => () => { setView(v); render(); };
  const items = [];
  const q = query.trim();
  if (q) items.push({ group: 'Search', label: `Search transactions for “${q}”`, run: go({ name: 'search', q }), always: true });
  items.push(
    { group: 'Pages', label: 'Overview', words: 'home start today', run: go({ name: 'overview' }) },
    { group: 'Pages', label: 'Search transactions', words: 'find filter', run: go({ name: 'search' }) },
    { group: 'Pages', label: 'Scheduled', words: 'recurring bills reminders', run: go({ name: 'scheduled' }) },
    { group: 'Pages', label: 'Subscriptions', words: 'recurring netflix spotify streaming cancel', run: go({ name: 'scheduled', tab: 'subscriptions' }) },
    { group: 'Pages', label: 'Insights: income and spending', words: 'charts categories budget', run: go({ name: 'insights' }) },
    { group: 'Pages', label: 'Insights: net worth', words: 'wealth history allocation', run: go({ name: 'insights', tab: 'networth' }) },
    { group: 'Pages', label: 'Assets', words: 'home house car vehicle property value', run: go({ name: 'assets' }) },
    { group: 'Pages', label: 'IOUs', words: 'loans owe people friends', run: go({ name: 'ious' }) },
  );
  for (const a of [...state.accounts].sort((x, y) => (x.archived - y.archived) || byName(x, y))) {
    items.push({
      group: 'Accounts', label: a.name, sub: `${ACCOUNT_TYPE_LABELS[a.type]}${a.archived ? ', archived' : ''} · ${money(accountValue(a), a.currency)}`,
      words: `${ACCOUNT_TYPE_LABELS[a.type]} account`, run: () => selectAccount(a.id),
    });
  }
  items.push(
    { group: 'Actions', label: 'Add transactions', words: 'new quick entry expense income', run: quickAdd },
    { group: 'Actions', label: 'Add a single transaction', words: 'new transfer refund dividend split', run: () => {
      const account = state.accounts.find((a) => a.id === view.id && !a.archived) ?? [...state.accounts].sort(byName).find((a) => !a.archived);
      if (account) openTxDialog('single', account); else openAccountDialog();
    } },
    { group: 'Actions', label: 'Add an account', words: 'new card bank', run: () => openAccountDialog() },
    { group: 'Actions', label: 'Schedule a transaction', words: 'new recurring repeat', run: () => openScheduleDialog() },
    { group: 'Actions', label: 'Add an asset', words: 'new home house car vehicle property', run: () => openAssetDialog() },
    { group: 'Actions', label: hideAmounts ? 'Show amounts' : 'Hide amounts', words: 'privacy mask', run: () => setHideAmounts(!hideAmounts) },
  );
  for (const page of SETTINGS_PAGES) {
    items.push({ group: 'Settings', label: `Settings: ${page.label}`, words: page.group, run: go({ name: 'settings', section: page.key }) });
  }
  for (const [kind, label] of IMPORT_KINDS) {
    items.push({ group: 'Settings', label: `Import: ${label}`, words: 'data file csv learn', run: go({ name: 'settings', section: 'import', kind }) });
  }
  if (!q) return items;
  // Every word typed must be found; names starting with it come first, then a word starting with it.
  const words = normalize(q).split(/\s+/);
  const rank = (it) => {
    const name = normalize(it.label);
    return name.startsWith(words[0]) ? 0 : name.split(/[\s:/·(]+/).some((w) => w.startsWith(words[0])) ? 1 : 2;
  };
  return items
    .filter((it) => it.always || words.every((w) => normalize(`${it.label} ${it.sub ?? ''} ${it.words ?? ''} ${it.group}`).includes(w)))
    .map((it, i) => ({ it, i, r: it.always ? 3 : rank(it) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ it }) => it);
}

export function openPalette() {
  if (!state || cmdDialog.open || document.querySelector('dialog[open]')) return;
  const box = input({
    type: 'text', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true',
    'aria-controls': 'cmd-list', 'aria-autocomplete': 'list', 'aria-label': 'Go to or do',
    placeholder: 'Go to an account or page, or type to search…',
  });
  box.classList.add('fin-cmd-input');
  const list = h('div', { id: 'cmd-list', role: 'listbox', class: 'fin-cmd-list', 'aria-label': 'Results' });
  const count = h('p', { class: 'fin-sr', role: 'status' });
  let shown = [];
  let active = 0;
  const highlight = (i) => {
    active = Math.max(0, Math.min(shown.length - 1, i));
    list.querySelectorAll('[role="option"]').forEach((o, j) => o.setAttribute('aria-selected', String(j === active)));
    const el = document.getElementById(`cmd-opt-${active}`);
    if (el) { box.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); } else box.removeAttribute('aria-activedescendant');
  };
  const run = (it) => { cmdDialog.close(); it.run(); };
  const update = () => {
    shown = paletteItems(box.value);
    let n = 0;
    const groups = [...new Set(shown.map((it) => it.group))];
    list.replaceChildren(...groups.map((g) => h('div', { role: 'group', 'aria-label': g, class: 'fin-cmd-group' },
      h('div', { class: 'fin-cmd-group-head', 'aria-hidden': 'true' }, g),
      shown.filter((it) => it.group === g).map((it) => {
        const i = n;
        n += 1;
        return h('div', {
          id: `cmd-opt-${i}`, role: 'option', class: 'fin-cmd-option', 'aria-selected': 'false',
          onmousedown: (e) => e.preventDefault(), // keep focus in the box
          onclick: () => run(it),
          onpointermove: () => { if (active !== i) highlight(i); },
        }, h('span', { class: 'fin-cmd-label' }, it.label), it.sub && h('span', { class: 'fin-sub' }, it.sub));
      }))));
    // The display order is by group, so put `shown` in that order too (the arrows follow it).
    shown = groups.flatMap((g) => shown.filter((it) => it.group === g));
    if (!shown.length) list.replaceChildren(h('p', { class: 'fin-empty fin-pad' }, 'Nothing matches.'));
    count.textContent = `${shown.length} result${shown.length === 1 ? '' : 's'}`;
    highlight(0);
  };
  box.addEventListener('input', update);
  box.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 }[e.key];
    if (step) { e.preventDefault(); highlight(active + step); return; }
    if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); highlight(0); return; }
    if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); highlight(shown.length - 1); return; }
    if (e.key === 'Enter' && shown[active]) { e.preventDefault(); run(shown[active]); }
  });
  cmdDialog.replaceChildren(
    h('div', { class: 'fin-cmd-box' }, box),
    list, count,
    h('p', { class: 'fin-keys fin-cmd-keys' },
      h('span', {}, h('kbd', {}, '↓'), h('kbd', {}, '↑'), ' move'),
      h('span', {}, h('kbd', {}, 'Enter'), ' go'),
      h('span', {}, h('kbd', {}, 'Esc'), ' close')));
  update();
  cmdDialog.showModal();
  box.focus();
}
cmdOpen.addEventListener('click', openPalette);
// Clicking the dimmed backdrop (outside the box) closes it.
cmdDialog.addEventListener('click', (e) => { if (e.target === cmdDialog) cmdDialog.close(); });
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !cmdOpen.hidden) {
    e.preventDefault();
    if (cmdDialog.open) cmdDialog.close(); else openPalette();
  }
});
