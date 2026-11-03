// Settings: its pages and navigation, category management, and the smaller settings sections.

import {
  categoriesOf, categorize, defaultState, findTransferPairs, newId, normalize, sortedCategories,
  splitsOf,
} from './model.js';
import { clearTables, persist, transactionsComplete } from './store.js';
import {
  avatar, profile, refreshPrices, render, setEditingTxId, setHideAmounts, setTxPage, setView,
  signOutNow, state, totalsOf, undoable, view,
} from './app.js';
import { backupSection, exportSection } from './backups.js';
import { decimal2, importKind, importPage, importTabs, setBuxferDraft, setImportDraft } from './imports.js';
import { needEverything } from './transactions.js';
import {
  NUMBER_FORMATS, button, catLabel, catOptions, category, field, h, hideAmounts, input,
  numberFormat, say, select, setNumberFormat, shortDate, writePref,
} from './ui.js';

// ── main: settings ───────────────────────────────────────────────────────────

// Settings are split into pages; while in Settings the left panel lists them instead of the accounts.
export const SETTINGS_PAGES = [
  { key: 'categories', label: 'Categories', group: 'Organise', needsAll: true, render: () => categoriesSection() },
  { key: 'rules', label: 'Category rules', group: 'Organise', needsAll: true, render: () => rulesSection() },
  { key: 'market', label: 'Market data', group: 'Prices', render: () => marketSection() },
  { key: 'backup', label: 'Backup and restore', group: 'Data', needsAll: true, render: () => backupSection() },
  // One page for every import, with the kind picked at the top (holdings don't need every transaction).
  { key: 'import', label: 'Import', group: 'Data', needsAll: () => importKind() !== 'holdings', render: () => importPage() },
  { key: 'link', label: 'Link transfers', group: 'Data', needsAll: true, render: () => linkTransfersSection() },
  { key: 'export', label: 'Export', group: 'Data', needsAll: true, render: () => exportSection() },
  { key: 'delete', label: 'Delete all data', group: 'Data', render: () => deleteAllSection() },
  { key: 'display', label: 'Display', group: 'Account', render: () => displaySection() },
  { key: 'account', label: 'Your account', group: 'Account', render: () => accountSection() },
];
export let settingsPage = 'categories'; // remembered while the page stays open

export function settingsPageOf() {
  return SETTINGS_PAGES.find((p) => p.key === (view.section ?? settingsPage)) ?? SETTINGS_PAGES[0];
}

export function renderSettings() {
  const page = settingsPageOf();
  return h('div', { class: 'fin-settings-page' },
    h('p', { class: 'fin-meta' }, `Settings · ${page.group}`),
    h('h2', { class: 'fin-title', id: 'settings-h', tabindex: '-1', 'data-key': 'settings-h' }, page.label),
    // Pages that work on every transaction load them the first time they're opened.
    (typeof page.needsAll === 'function' ? page.needsAll() : page.needsAll) && !transactionsComplete()
      ? [page.key === 'import' && importTabs(), needEverything()] : page.render());
}

export function renderSettingsNav() {
  const current = settingsPageOf().key;
  const groups = [...new Set(SETTINGS_PAGES.map((p) => p.group))];
  return [
    h('div', { class: 'fin-side-head' }, h('h2', { class: 'fin-side-title' }, 'Settings')),
    h('nav', { 'aria-label': 'Settings pages' }, groups.map((g) => h('div', { class: 'fin-group' },
      h('h3', { class: 'fin-group-head fin-group-static' }, g),
      h('ul', { class: 'fin-accounts' }, SETTINGS_PAGES.filter((p) => p.group === g).map((p) => h('li', {},
        h('button', {
          type: 'button', class: `fin-account${p.key === 'delete' ? ' fin-account-danger' : ''}`,
          'data-key': `set-${p.key}`, 'aria-current': p.key === current ? 'page' : null,
          onclick: () => openSettings(p.key, `set-${p.key}`),
        }, h('span', { class: 'fin-account-name' }, p.label)))))))),
  ];
}

export function openSettings(key, focusKey) {
  settingsPage = key;
  setView({ name: 'settings', section: key });
  render(focusKey);
  say(`${settingsPageOf().label} settings.`);
}

export function accountSection() {
  const p = profile();
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'settings-h' },
    h('div', { class: 'fin-me-who fin-me-who--page' }, avatar(p, 48),
      h('div', { class: 'fin-me-names' }, p.name && h('strong', {}, p.name), h('span', { class: p.name ? 'fin-sub' : '' }, p.email ? ['Signed in as ', p.email] : 'Signed in'))),
    h('p', { class: 'fin-hint' }, 'Your data is saved to your account and loads on any device where you sign in with this email, or with Google using the same address.'),
    h('div', { class: 'fin-actions fin-mt' }, button('Sign out', () => signOutNow(), 'secondary', { 'data-key': 'sign-out' })));
}

export function rulesSection() {
  const pattern = input({ type: 'text', required: true, autocomplete: 'off', 'data-key': 'rule-add' });
  const match = select([['contains', 'contains'], ['starts', 'starts with'], ['equals', 'is exactly']], 'contains');
  const ruleCat = select(catOptions(), sortedCategories(state.categories)[0]?.id);
  const matchLabel = { contains: 'contains', starts: 'starts with', equals: 'is exactly' };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= state.rules.length) return;
    [state.rules[i], state.rules[j]] = [state.rules[j], state.rules[i]];
    persist(); render();
  };
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'settings-h' },
    h('p', { class: 'fin-hint' }, 'Checked top to bottom. The first rule that matches the description sets the category. Case and accents are ignored.'),
    state.rules.length === 0 ? h('p', { class: 'fin-empty' }, 'No rules yet.') :
      h('ol', { class: 'fin-rules' }, state.rules.map((r, i) => h('li', {},
        h('span', {}, `If description ${matchLabel[r.match]} `, h('strong', {}, `“${r.pattern}”`), ' → ', catLabel(r.categoryId) || 'Unknown'),
        h('span', { class: 'fin-actions' },
          button('↑', () => move(i, -1), 'secondary fin-btn-sm', { 'aria-label': `Move rule ${r.pattern} up`, disabled: i === 0 }),
          button('↓', () => move(i, 1), 'secondary fin-btn-sm', { 'aria-label': `Move rule ${r.pattern} down`, disabled: i === state.rules.length - 1 }),
          button('Delete', () => { state.rules = state.rules.filter((x) => x.id !== r.id); persist(); render('rule-add'); }, 'danger fin-btn-sm', { 'aria-label': `Delete rule ${r.pattern}` }))))),
    h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        state.rules.push({ id: newId(), pattern: pattern.value.trim(), match: match.value, categoryId: ruleCat.value });
        persist(); render('rule-add'); say('Rule added.');
      },
    },
      h('div', { class: 'fin-grid' }, field('Description', match), field('Text', pattern), field('Category', ruleCat)),
      h('div', { class: 'fin-actions' },
        h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Add rule'),
        button('Re-apply to uncategorized', () => {
          let n = 0;
          for (const t of state.transactions) {
            if (t.transferId || categoriesOf(t).length) continue;
            const id = categorize(t.description, state.rules);
            if (id) { t.categoryIds = [id]; n += 1; }
          }
          persist(); render(); say(`Categorized ${n} transaction(s).`);
        }))));
}

export function marketSection() {
  const key = input({ type: 'password', autocomplete: 'off', value: state.settings.quoteApiKey });
  const avKey = input({ type: 'password', autocomplete: 'off', value: state.settings.avApiKey });
  const eodKey = input({ type: 'password', autocomplete: 'off', value: state.settings.eodhdApiKey });
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'settings-h' },
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        state.settings.quoteApiKey = key.value.trim();
        state.settings.avApiKey = avKey.value.trim();
        state.settings.eodhdApiKey = eodKey.value.trim();
        persist();
        say('API keys saved. Fetching prices…');
        await refreshPrices(state.holdings.filter((x) => !x.manual));
      },
    },
      h('p', { class: 'fin-hint' }, 'The keys are free and saved with your account, so they work on every device. Prices refresh once a day when you open the page.'),
      h('div', { class: 'fin-grid' },
        field('Twelve Data API key', key, 'From twelvedata.com. Search, and prices for US listings.'),
        field('Alpha Vantage API key', avKey, 'From alphavantage.co. Prices for Xetra, London and other non-US listings, which Twelve Data’s free plan excludes. 25 lookups a day.'),
        field('EODHD API key', eodKey, 'From eodhd.com. Prices for funds, found by their ISIN (e.g. LU0109981661). The database fetches them, as EODHD can’t be reached from a web page. The free plan allows about 20 lookups a day.')),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Save keys')));
}

// How numbers look, and amounts hidden or shown. Saved in this browser.
export function displaySection() {
  const sample = (key) => new Intl.NumberFormat(NUMBER_FORMATS[key].locale, { style: 'currency', currency: 'EUR' }).format(1234567.89);
  const fmt = h('div', { class: 'fin-choices', role: 'radiogroup', 'aria-labelledby': 'fmt-h' },
    Object.entries(NUMBER_FORMATS).map(([key, f]) => h('label', { class: 'fin-choice' },
      h('input', {
        type: 'radio', name: 'number-format', value: key, checked: key === numberFormat, 'data-key': `fmt-${key || 'auto'}`,
        onchange: () => {
          setNumberFormat(key);
          writePref('finance:number-format', key);
          render(`fmt-${key || 'auto'}`);
          say(`Numbers now look like ${sample(key)}.`);
        },
      }),
      h('span', {}, key ? f.label : f.label.split(' (')[0], h('span', { class: 'fin-sub' }, key ? sample(key) : `${sample(key)} here`)))));
  // Appearance: light, dark or the system's (theme.js applies it, before the page is drawn).
  const THEMES = { system: ['System', 'Follows your device'], light: ['Light', 'Always light'], dark: ['Dark', 'Always dark'] };
  const current = window.finTheme?.get() ?? 'system';
  const theme = h('div', { class: 'fin-choices', role: 'radiogroup', 'aria-labelledby': 'theme-h' },
    Object.entries(THEMES).map(([key, [label, note]]) => h('label', { class: 'fin-choice' },
      h('input', {
        type: 'radio', name: 'theme', value: key, checked: key === current, 'data-key': `theme-${key}`,
        onchange: () => {
          window.finTheme?.set(key);
          render(`theme-${key}`);
          say(key === 'system' ? 'Fin now follows your device’s light or dark setting.' : `Fin is now ${label.toLowerCase()}.`);
        },
      }),
      h('span', {}, label, h('span', { class: 'fin-sub' }, note)))));
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'settings-h' },
    h('h3', { id: 'theme-h', class: 'fin-label' }, 'Appearance'),
    h('p', { class: 'fin-hint' }, 'Light, dark, or the same as your device. Saved in this browser.'),
    theme,
    h('h3', { id: 'fmt-h', class: 'fin-label fin-mt' }, 'Number format'),
    h('p', { class: 'fin-hint' }, 'How amounts, units and percentages are written everywhere in Fin. Saved in this browser. Exports keep plain numbers (1234.56) so spreadsheets read them.'),
    fmt,
    h('h3', { class: 'fin-label fin-mt' }, 'Hide amounts'),
    h('p', { class: 'fin-hint' }, 'To show Fin to someone without showing your money: the eye in the header, or Alt+H (Option+H on a Mac).'),
    h('label', { class: 'fin-switch' },
      h('input', { type: 'checkbox', role: 'switch', checked: hideAmounts, 'data-key': 'hide-switch', onchange: (e) => setHideAmounts(e.target.checked) }),
      h('span', { class: 'fin-switch-track', 'aria-hidden': 'true' }), 'Hide amounts'));
}

// Start over: removes the data, keeps the sign-in and API keys. Needs DELETE typed to unlock.
export function deleteAllSection() {
  const counts = `${state.accounts.length} accounts, ${state.accounts.reduce((n, a) => n + totalsOf(a.id).count, 0)} transactions, ${state.holdings.length} holdings, ${state.schedules.length} schedules and ${state.people.length} people with their IOUs`;
  const alsoCats = h('input', { type: 'checkbox', id: 'del-cats' });
  const confirmIn = input({ type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'del-hint' });
  const go = button('Delete all data', async () => {
    const tables = ['accounts', 'transactions', 'holdings', 'lots', 'schedules', 'people', 'ious', 'snapshots', ...(alsoCats.checked ? ['categories', 'rules'] : [])];
    go.disabled = true;
    say('Deleting…');
    try {
      await clearTables(tables);
    } catch (err) {
      say(`Couldn’t delete everything: ${err.message}. Nothing was lost that you didn’t ask to delete; try again.`);
      render('del-confirm');
      return;
    }
    if (alsoCats.checked) {
      // Start again from the defaults, like a new account.
      const base = defaultState();
      state.categories = base.categories;
      state.rules = base.rules;
      persist();
    }
    state.settings.lastAccountId = undefined;
    setEditingTxId(null); setImportDraft(null); setBuxferDraft(null); setTxPage(0);
    settingsPage = 'import';
    setView({ name: 'settings', section: 'import', kind: 'buxfer' });
    persist(); render('bux-file');
    say('All data deleted. You can import again now.');
  }, 'danger', { disabled: true, 'data-key': 'del-go' });
  confirmIn.setAttribute('data-key', 'del-confirm');
  confirmIn.addEventListener('input', () => { go.disabled = confirmIn.value.trim() !== 'DELETE'; });

  return h('section', { class: 'fin-card fin-pad fin-danger-zone', 'aria-labelledby': 'del-h' },
    h('h3', { id: 'del-h', class: 'fin-label' }, 'Delete all data'),
    h('p', {}, `Permanently deletes ${counts} from your account, so you can import from scratch. Your sign-in and API keys stay. This can’t be undone; export first if you might want any of it back.`),
    h('div', { class: 'fin-check' }, alsoCats,
      h('label', { for: 'del-cats' }, `Also delete categories (${state.categories.length}) and category rules (${state.rules.length}), and start again from the defaults`)),
    h('div', { class: 'fin-grid fin-mt' }, field('Type DELETE to confirm', confirmIn)),
    h('p', { id: 'del-hint', class: 'fin-sr' }, 'The delete button turns on once DELETE is typed.'),
    go);
}

// For transactions imported before transfers were recognised: find the two sides and link them,
// after showing what will change.
export function linkTransfersSection() {
  const pairs = findTransferPairs(state.transactions);
  const accName = (id) => state.accounts.find((a) => a.id === id)?.name ?? '';
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'link-h' },
    h('h3', { id: 'link-h', class: 'fin-label', tabindex: '-1', 'data-key': 'link-h' }, 'Link transfers'),
    h('p', { class: 'fin-hint' }, 'Finds pairs of transactions on the same date with the same description and opposite amounts in two different accounts, and turns each pair into one transfer.'),
    pairs.length === 0
      ? h('p', { class: 'fin-empty' }, 'No unlinked transfers found.')
      : [
        h('p', {}, h('strong', {}, `${pairs.length} likely transfer${pairs.length === 1 ? '' : 's'}`)),
        h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
          h('caption', { class: 'fin-sr' }, 'Transfers that will be linked'),
          h('thead', {}, h('tr', {}, ['Date', 'Description', 'Amount', 'From', 'To'].map((t, i) =>
            h('th', { scope: 'col', class: i === 2 ? 'fin-r' : null }, t)))),
          h('tbody', {}, pairs.slice(0, 10).map(([out, inn]) => h('tr', {},
            h('td', { class: 'fin-nowrap' }, shortDate(out.date)), h('td', {}, out.description),
            h('td', { class: 'fin-r fin-num' }, decimal2(-out.amount)),
            h('td', {}, accName(out.accountId)), h('td', {}, accName(inn.accountId))))))),
        pairs.length > 10 && h('p', { class: 'fin-hint' }, `and ${pairs.length - 10} more.`),
        h('div', { class: 'fin-actions fin-mt' }, button(`Link ${pairs.length} transfer${pairs.length === 1 ? '' : 's'}`, () => {
          for (const [out, inn] of pairs) {
            const transferId = newId();
            for (const t of [out, inn]) { t.transferId = transferId; t.categoryIds = []; }
          }
          persist(); render('link-h');
          say(`Linked ${pairs.length} transfers.`);
        }, 'primary')),
      ]);
}

// ── category management ──────────────────────────────────────────────────────

export let editingCatId = null;

// Two levels, like Buxfer: a category is top-level or the child of a top-level one.
export function categoriesSection() {
  const uses = new Map();
  for (const t of state.transactions) for (const id of categoriesOf(t)) uses.set(id, (uses.get(id) ?? 0) + 1);
  const childrenOf = (id) => state.categories.filter((c) => c.parentId === id);
  const tops = sortedCategories(state.categories).filter((c) => !c.parentId || !category(c.parentId));
  const topOptions = (except) => [['', 'None (top level)'], ...tops.filter((c) => c.id !== except).map((c) => [c.id, c.name])];

  const remove = (c) => {
    const kids = childrenOf(c.id);
    const n = uses.get(c.id) ?? 0;
    const rules = state.rules.filter((r) => r.categoryId === c.id).length;
    const lines = [`Delete “${catLabel(c.id)}”?`];
    if (n) lines.push(`It will be removed from ${n} transaction${n === 1 ? '' : 's'} (they stay, without this category).`);
    if (rules) lines.push(`${rules} rule${rules === 1 ? '' : 's'} using it will be deleted.`);
    if (kids.length) lines.push(`Its ${kids.length} subcategor${kids.length === 1 ? 'y moves' : 'ies move'} to the top level.`);
    if (!confirm(lines.join('\n'))) return;
    undoable(`Deleted ${c.name}.`, ['transactions', 'categories', 'rules', 'schedules'], () => {
      for (const t of state.transactions) {
        if (categoriesOf(t).includes(c.id)) t.categoryIds = categoriesOf(t).filter((id) => id !== c.id);
        // A split keeps its parts; the part loses its category.
        if (splitsOf(t)?.some((p) => p.categoryId === c.id)) t.splits = t.splits.map((p) => (p.categoryId === c.id ? { ...p, categoryId: null } : p));
      }
      for (const k of state.categories) if (k.parentId === c.id) k.parentId = null;
      state.rules = state.rules.filter((r) => r.categoryId !== c.id);
      for (const x of state.schedules) if (categoriesOf(x).includes(c.id)) x.categoryIds = categoriesOf(x).filter((id) => id !== c.id);
      state.categories = state.categories.filter((x) => x.id !== c.id);
    });
  };

  const row = (c) => {
    const n = uses.get(c.id) ?? 0;
    if (editingCatId === c.id) {
      const name = input({ type: 'text', required: true, value: c.name, 'data-key': 'cat-edit-name' });
      const hasKids = childrenOf(c.id).length > 0;
      const parent = select(topOptions(c.id), c.parentId ?? '', { disabled: hasKids });
      const cancel = () => { editingCatId = null; render(`cat-edit-${c.id}`); };
      return h('li', { class: 'fin-cat-row fin-cat-editing' }, h('form', {
        class: 'fin-cat-form',
        onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } },
        onsubmit: (e) => {
          e.preventDefault();
          const clash = state.categories.find((x) => x.id !== c.id && (x.parentId ?? '') === parent.value && normalize(x.name) === normalize(name.value));
          if (clash) { say(`There's already a ${catLabel(clash.id)}.`); name.focus(); return; }
          Object.assign(c, { name: name.value.trim(), parentId: parent.value || null });
          editingCatId = null;
          persist(); render(`cat-edit-${c.id}`); say(`Saved ${catLabel(c.id)}.`);
        },
      },
        field('Name', name),
        field('Under', parent, hasKids ? 'It has subcategories, so it stays at the top level.' : null),
        h('div', { class: 'fin-actions' },
          h('button', { type: 'submit', class: 'fin-btn btn-primary fin-btn-sm' }, 'Save'),
          button('Cancel', cancel, 'secondary fin-btn-sm'))));
    }
    return h('li', { class: `fin-cat-row${c.parentId ? ' fin-cat-child' : ''}` },
      h('span', { class: 'fin-cat-name' }, c.name, h('span', { class: 'fin-muted fin-num' }, ` ${n}`)),
      h('span', { class: 'fin-actions fin-row-actions' },
        button('Edit', () => { editingCatId = c.id; render('cat-edit-name'); }, 'secondary fin-btn-sm',
          { 'aria-label': `Edit ${catLabel(c.id)}`, 'data-key': `cat-edit-${c.id}` }),
        button('Delete', () => remove(c), 'danger fin-btn-sm', { 'aria-label': `Delete ${catLabel(c.id)}` })));
  };

  const newName = input({ type: 'text', required: true, autocomplete: 'off', 'data-key': 'cat-add' });
  const newParent = select(topOptions(), '');
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'cats-h' },
    h('h3', { id: 'cats-h', class: 'fin-label' }, `Categories (${state.categories.length})`),
    h('p', { class: 'fin-hint' }, 'A category can sit under another, one level deep, and is shown as “Parent / Child”. A transaction can have several. The number is how many transactions use it.'),
    h('ul', { class: 'fin-cat-tree' }, tops.map((p) => h('li', {},
      h('ul', { class: 'fin-cat-family' }, row(p), childrenOf(p.id).sort((a, b) => a.name.localeCompare(b.name)).map(row))))),
    h('form', {
      class: 'fin-mt',
      onsubmit: (e) => {
        e.preventDefault();
        const parentId = newParent.value || null;
        const clash = state.categories.find((x) => (x.parentId ?? null) === parentId && normalize(x.name) === normalize(newName.value));
        if (clash) { say(`There's already a ${catLabel(clash.id)}.`); return; }
        const cat = { id: newId(), name: newName.value.trim(), parentId };
        state.categories.push(cat);
        persist(); render('cat-add'); say(`Added ${catLabel(cat.id)}.`);
      },
    },
      h('div', { class: 'fin-grid' }, field('New category', newName), field('Under', newParent)),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Add category')));
}
