// Imports (CSV, Buxfer, holdings) and CSV export.

import { today } from './market.js';
import {
  ACCOUNT_TYPE_LABELS, IMPORT_FIELDS, IOU_TYPES, buxferImport, categoriesOf,
  categoryPath, convert, detectBuxferFile, frequencyLabel, ftImport, fundMovementsToFt,
  guessDateFormat, guessDecimal, guessMapping, holdingValue, importRows, isFtExport,
  isFundMovements, lotSummary, newId, normalize, parseCsv, sortedCategories,
  splitsOf, toCsv,
} from './model.js';
import { missingTables, persist } from './store.js';
import { accountValue, byName, refreshRates, render, setView, state, view } from './app.js';
import { personName } from './ious.js';
import { accountLabel, holdingOf } from './transactions.js';
import {
  button, catLabel, category, field, h, input, money, say, select, shortDate, signed, tone,
} from './ui.js';

// ── CSV import and export ────────────────────────────────────────────────────

// The import in progress lives outside the DOM so a re-render (prices arriving, a save finishing)
// doesn't throw away the file and the column choices.
export let importDraft = null;

export const FIELD_LABELS = {
  date: 'Date', description: 'Description', amount: 'Amount', type: 'Type (expense or income)',
  account: 'Account', category: 'Category', memo: 'Memo', currency: 'Currency',
  reference: 'ID / reference (pairs transfer rows)',
  iou: 'IOU (Buxfer: “Name: 12,50”)',
};

export async function readImportFile(file) {
  const rows = parseCsv(await file.text());
  if (rows.length < 2) { say('That file has no rows to import.'); return; }
  const [header, ...body] = rows;
  const mapping = guessMapping(header);
  const column = (f) => body.slice(0, 50).map((r) => r[mapping[f]] ?? '');
  importDraft = {
    fileName: file.name, header, body, mapping,
    dateFormat: mapping.date >= 0 ? guessDateFormat(column('date')) : 'dmy',
    decimal: mapping.amount >= 0 ? guessDecimal(column('amount')) : '.',
    defaultAccountId: view.id ?? state.accounts[0]?.id ?? '',
  };
  render('map-date');
  say(`Read ${body.length} rows from ${file.name}. Check the columns, then import.`);
}

export const runImport = (id) => importRows(importDraft.body, importDraft, {
  id, accounts: state.accounts, categories: state.categories, rules: state.rules, transactions: state.transactions, people: state.people,
});

// EUR rows need no lookup. Setting their rate before saving keeps a large import to one upload,
// instead of a second one when refreshRates() fills the rates in.
export function withEuroRates(transactions, accounts) {
  const eur = new Set(accounts.filter((a) => a.currency === 'EUR').map((a) => a.id));
  for (const t of transactions) if (t.rate == null && eur.has(t.accountId)) t.rate = 1;
}

// A Buxfer export in progress: the parsed files and the preview, kept across re-renders.
export let buxferDraft = null;

export async function readBuxferFiles(fileList) {
  const files = {};
  const names = [];
  for (const f of fileList) {
    const rows = parseCsv(await f.text());
    const kind = rows.length ? detectBuxferFile(rows[0]) : null;
    if (kind && kind !== 'tags') { files[kind] = rows; names.push(f.name); }
  }
  if (!files.transactions && !files.accounts) {
    say('None of those files look like a Buxfer accounts or transactions export.');
    return;
  }
  buxferDraft = { files, names, openingBalances: true };
  previewBuxfer();
  render('bux-opening');
  say('Read the Buxfer export. Check the balances, then import.');
}

export const buxferCtx = (id) => ({
  id, today: today(), accounts: state.accounts, categories: state.categories, rules: state.rules,
  transactions: state.transactions, holdings: state.holdings, schedules: state.schedules, people: state.people, lots: state.lots,
});

export function previewBuxfer() {
  let n = 0;
  buxferDraft.preview = buxferImport(buxferDraft.files, buxferCtx(() => `preview-${++n}`), { openingBalances: buxferDraft.openingBalances });
}

// ── imports: one page, three kinds ───────────────────────────────────────────

export const IMPORT_KINDS = [
  ['csv', 'Transactions (CSV)'], ['buxfer', 'From Buxfer'], ['holdings', 'Holdings'],
];
export const importKind = () => (IMPORT_KINDS.some(([k]) => k === view.kind) ? view.kind : 'csv');
export function importTabs() {
  const current = importKind();
  return h('div', { class: 'fin-tabs', role: 'group', 'aria-label': 'What to import' },
    IMPORT_KINDS.map(([k, label]) => h('button', {
      type: 'button', class: 'fin-tab', 'aria-pressed': String(current === k), 'data-key': `imp-${k}`,
      onclick: () => { setView({ name: 'settings', section: 'import', kind: k }); render(`imp-${k}`); say(`Import ${label.toLowerCase()}.`); },
    }, label)));
}
export function importPage() {
  const kind = importKind();
  return [
    importTabs(),
    kind === 'buxfer' ? buxferSection() : kind === 'holdings' ? ftSection() : importSection(),
  ];
}

export function buxferSection() {
  const head = h('h3', { id: 'bux-h', class: 'fin-label' }, 'Import from Buxfer');
  if (!buxferDraft) {
    const file = input({ type: 'file', accept: '.csv,text/csv', multiple: true, 'data-key': 'bux-file' });
    file.addEventListener('change', () => file.files.length && readBuxferFiles(file.files));
    return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'bux-h' }, head,
      h('p', { class: 'fin-hint' }, 'Select the CSV files from Buxfer’s export together: accounts, transactions, investments and reminders. Accounts keep their type and currency, transfers stay linked, holdings keep their prices, and you can check every balance against Buxfer before importing.'),
      h('div', { class: 'fin-grid' }, field('Buxfer export files', file)));
  }

  const d = buxferDraft;
  const p = d.preview;
  const opening = h('input', { type: 'checkbox', checked: d.openingBalances, 'data-key': 'bux-opening', id: 'bux-opening' });
  opening.addEventListener('change', () => { d.openingBalances = opening.checked; previewBuxfer(); render('bux-opening'); });
  const allMatch = p.reconciliation.every((r) => r.matches);
  const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'bux-h' }, head,
    h('p', { class: 'fin-hint' }, d.names.join(', ')),
    h('ul', { class: 'fin-import-list', 'aria-live': 'polite' },
      h('li', {}, h('strong', {}, plural(p.imported, 'transaction')), p.duplicates ? `, ${p.duplicates} already in your data (skipped)` : ''),
      p.newAccounts.length > 0 && h('li', {}, `${plural(p.newAccounts.length, 'new account')}`,
        p.newAccounts.some((a) => a.archived) ? `, of which ${p.newAccounts.filter((a) => a.archived).length} archived (in Buxfer’s archive, not in accounts.csv)` : ''),
      p.newCategories.length > 0 && h('li', {}, plural(p.newCategories.length, 'new category') + ' from Buxfer tags'),
      p.linkedTransfers > 0 && h('li', {}, `${plural(p.linkedTransfers, 'transfer')} between accounts, linked`),
      p.unpairedTransfers > 0 && h('li', {}, `${plural(p.unpairedTransfers, 'transfer row')} without another side (fees, trades inside one account), imported as plain transactions`),
      (p.newHoldings.length + p.holdingUpdates.length) > 0 && h('li', {}, `${plural(p.newHoldings.length + p.holdingUpdates.length, 'holding')} with Buxfer’s prices, entered by hand until you switch them to live prices`),
      p.openings > 0 && h('li', {}, `${plural(p.openings, 'opening balance')} for history before the export`),
      p.ious.length > 0 && (() => {
        const n = new Set(p.ious.map((e) => e.personId)).size;
        return h('li', {}, `${p.ious.length} IOU ${p.ious.length === 1 ? 'entry' : 'entries'} with ${n} ${n === 1 ? 'person' : 'people'} (loans, settlements, shared bills)`);
      })(),
      p.schedules.length > 0 && h('li', {}, `${plural(p.schedules.length, 'scheduled transaction')} from reminders.csv`,
        missingTables().includes('schedules') && h('strong', { class: 'fin-row-error' },
          '. They won’t be saved until you run the updated schema.sql in Supabase and reload.')),
      p.skippedReminders.length > 0 && h('li', {}, `${plural(p.skippedReminders.length, 'reminder')} not scheduled: `,
        p.skippedReminders.map((r) => `${r.description} (${r.reason})`).join('; '), '. Add them under Scheduled.'),
      p.errors.length > 0 && h('li', { class: 'fin-row-error' }, `${plural(p.errors.length, 'row')} with problems, skipped: `,
        p.errors.slice(0, 3).map((e) => `line ${e.line} (${e.message})`).join('; '))),
    p.reconciliation.length > 0 && [
      h('p', {}, allMatch
        ? 'After import, every account matches its Buxfer balance:'
        : 'Some accounts won’t match Buxfer after import:'),
      h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
        h('caption', { class: 'fin-sr' }, 'Balances compared with Buxfer'),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Account'), h('th', { scope: 'col', class: 'fin-r' }, 'Buxfer'),
          h('th', { scope: 'col', class: 'fin-r' }, 'After import'), h('th', { scope: 'col', class: 'fin-r' }, 'Opening balance'),
          h('th', { scope: 'col' }, 'Check'))),
        h('tbody', {}, p.reconciliation.map((r) => h('tr', {},
          h('td', {}, r.name, r.valued && h('span', { class: 'fin-sub' }, 'Valued by holdings')),
          h('td', { class: 'fin-r fin-num' }, money(r.buxfer, r.currency)),
          h('td', { class: 'fin-r fin-num' }, money(r.ours, r.currency)),
          h('td', { class: 'fin-r fin-num fin-muted' }, r.opening ? signed(r.opening, r.currency) : ''),
          h('td', { class: r.matches ? 'fin-pos' : 'fin-neg' }, r.matches ? '✓ Matches' : `Off by ${signed(r.buxfer - r.ours, r.currency)}`)))))),
    ],
    h('div', { class: 'fin-check fin-mt' }, opening,
      h('label', { for: 'bux-opening' }, 'Add an opening balance where the transactions don’t add up to the Buxfer balance')),
    h('div', { class: 'fin-actions fin-mt' },
      button(`Import from Buxfer`, async () => {
        const res = buxferImport(d.files, buxferCtx(newId), { openingBalances: d.openingBalances });
        withEuroRates(res.transactions, [...state.accounts, ...res.newAccounts]);
        state.accounts.push(...res.newAccounts);
        state.categories.push(...res.newCategories);
        state.transactions.push(...res.transactions);
        state.holdings.push(...res.newHoldings);
        state.schedules.push(...res.schedules);
        state.people.push(...res.newPeople);
        state.ious.push(...res.ious);
        for (const u of res.holdingUpdates) Object.assign(state.holdings.find((x) => x.id === u.id), u);
        buxferDraft = null;
        // Show the result: the first active account, with the account list back in the side panel.
        const first = [...state.accounts].sort(byName).find((a) => !a.archived) ?? state.accounts[0];
        if (first) setView({ name: 'account', id: first.id });
        persist(); render('bux-file');
        say(`Imported ${res.imported} transactions and ${res.newAccounts.length} accounts from Buxfer. Saving to your account…`);
        await refreshRates(); // USD transactions get the rate of their own date
      }, 'primary', { disabled: !p.imported && !p.newAccounts.length && !p.newHoldings.length && !p.holdingUpdates.length && !p.openings && !p.schedules.length }),
      button('Cancel', () => { buxferDraft = null; render('bux-file'); })));
}

// FT.com portfolio export, or a fund's movements list (a pension fund's "ListagemMovimentos.xls")
// → buys and sells on the holdings of one investment account.
export let ftDraft = null;

// Text from a file that may be UTF-16 (what some banks call .xls is tab-separated UTF-16 text).
export async function readText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bom16 = bytes[0] === 0xFF && bytes[1] === 0xFE;
  const zeros = bytes.slice(0, 200).filter((b, i) => i % 2 === 1 && b === 0).length;
  return new TextDecoder(bom16 || zeros > 40 ? 'utf-16le' : 'utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

export async function readFtFile(file) {
  let rows = parseCsv(await readText(file));
  const movements = rows.length > 0 && isFundMovements(rows[0]);
  // The movements list names its portfolio ("Carteira"), which may also be the account's name.
  const portfolio = movements ? normalize(rows[1]?.[rows[0].findIndex((x) => normalize(x) === 'carteira')] ?? '') : '';
  if (movements) rows = fundMovementsToFt(rows);
  else if (!rows.length || !isFtExport(rows[0])) { say('That file isn’t an FT.com transactions export or a fund’s movements list.'); return; }
  const investments = state.accounts.filter((a) => a.type === 'investment' && !a.archived);
  // Guess the account from the file name ("ETFs_Transactions_…" → an account with "ETF" in its name).
  const hint = file.name.split(/[_\s-]/)[0].replace(/s$/i, '').toLowerCase();
  const guess = (portfolio && investments.find((a) => normalize(a.name).includes(portfolio)))
    ?? investments.find((a) => a.name.toLowerCase().includes(hint)) ?? investments[0];
  ftDraft = { name: file.name, rows, accountId: guess?.id ?? '' };
  render('ft-account');
}

export function ftSection() {
  const head = h('h3', { class: 'fin-label' }, 'Import holdings');
  const investments = state.accounts.filter((a) => a.type === 'investment' && !a.archived);
  if (!ftDraft) {
    const file = input({ type: 'file', accept: '.csv,.xls,.txt,.tsv,text/csv,text/plain', 'data-key': 'ft-file' });
    file.addEventListener('change', () => file.files[0] && readFtFile(file.files[0]));
    return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'settings-h' }, head,
      h('p', { class: 'fin-hint' }, 'Every buy and sell with its date, units and price, from either the transactions export of an FT.com portfolio, or a fund’s movements list (a pension fund’s “ListagemMovimentos”, with Data, Fundo, Operação, Nº UPs and Valor UP). They become the lots of the account’s holdings, which then show what they cost and what you’ve gained, and give the net-worth history real values over time. Holdings are matched by ticker or name and created when missing; a fund from a movements list is priced by hand, starting at its latest unit value. Importing the same file again adds nothing.'),
      investments.length === 0 ? h('p', { class: 'fin-notice' }, 'Add an investment account first.') : h('div', { class: 'fin-grid' }, field('Export file', file)));
  }
  const d = ftDraft;
  const acc = select([...investments].sort(byName).map((a) => [a.id, a.name]), d.accountId, { 'data-key': 'ft-account' });
  acc.addEventListener('change', () => { d.accountId = acc.value; render('ft-account'); });
  let n = 0;
  const p = ftImport(d.rows, d.accountId, { id: () => `p${++n}`, holdings: state.holdings, lots: state.lots });
  const allLots = [...state.lots, ...p.newLots];
  const symbols = [...new Set(p.newLots.map((l) => l.holdingId))].map((id) => {
    const holding = state.holdings.find((x) => x.id === id) ?? p.newHoldings.find((x) => x.id === id);
    const update = p.holdingUpdates.find((u) => u.id === id);
    const sum = lotSummary(allLots.filter((l) => l.holdingId === id));
    return { holding, update, sum, count: p.newLots.filter((l) => l.holdingId === id).length };
  });
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'settings-h' }, head,
    h('p', { class: 'fin-hint' }, `${d.name} · ${d.rows.length - 1} rows`),
    h('div', { class: 'fin-grid' }, field('Investment account', acc)),
    p.newLots.length === 0
      ? h('p', { class: 'fin-notice' }, p.duplicates ? `All ${p.duplicates} buys and sells are already there.` : 'No buys or sells in this file.')
      : h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
        h('caption', { class: 'fin-sr' }, 'What will be imported'),
        h('thead', {}, h('tr', {}, ['Holding', 'Buys and sells', 'Units after', 'Units now', 'Cost'].map((t, i) => h('th', { scope: 'col', class: i > 0 ? 'fin-r' : null }, t)))),
        h('tbody', {}, symbols.map(({ holding, update, sum, count }) => h('tr', {},
          h('td', {}, holding.symbol, h('span', { class: 'fin-sub' }, update ? holding.name ?? '' : 'New holding')),
          h('td', { class: 'fin-r fin-num' }, String(count)),
          h('td', { class: 'fin-r fin-num' }, String(sum.quantity)),
          h('td', { class: `fin-r fin-num ${update && update.before !== sum.quantity ? 'fin-neg' : 'fin-muted'}` }, update ? String(update.before) : '—'),
          h('td', { class: 'fin-r fin-num' }, money(sum.cost, holding.currency))))))),
    symbols.some(({ update, sum }) => update && update.before !== sum.quantity) && h('p', { class: 'fin-notice' },
      'Some units differ from what the holding has now (in red). After the import, the units come from the buys and sells.'),
    (p.duplicates > 0 || p.skipped.length > 0) && h('p', { class: 'fin-hint' },
      [p.duplicates && `${p.duplicates} already imported (skipped)`, p.skipped.length && `${p.skipped.length} rows that aren't buys or sells (skipped)`].filter(Boolean).join(' · ')),
    h('div', { class: 'fin-actions fin-mt' },
      button(`Import ${p.newLots.length} buys and sells`, () => {
        const res = ftImport(d.rows, d.accountId, { id: newId, holdings: state.holdings, lots: state.lots });
        state.holdings.push(...res.newHoldings);
        state.lots.push(...res.newLots);
        for (const { id, before, ...fields } of res.holdingUpdates) Object.assign(state.holdings.find((x) => x.id === id), fields);
        ftDraft = null;
        persist();
        setView({ name: 'account', id: d.accountId });
        render();
        say(`Imported ${res.newLots.length} buys and sells.`);
      }, 'primary', { disabled: !p.newLots.length || !d.accountId }),
      button('Cancel', () => { ftDraft = null; render('ft-file'); })));
}

export function importSection() {
  const head = h('h3', { id: 'import-h', class: 'fin-label' }, 'Import transactions (CSV)');
  if (!importDraft) {
    const file = input({ type: 'file', accept: '.csv,text/csv', 'data-key': 'import-file' });
    file.addEventListener('change', () => file.files[0] && readImportFile(file.files[0]));
    return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'import-h' }, head,
      h('p', { class: 'fin-hint' }, 'Any CSV with a date, a description and an amount, such as a bank statement. You choose which column is which and see a preview before anything is saved.'),
      h('div', { class: 'fin-grid' }, field('CSV file', file)));
  }

  const d = importDraft;
  const update = (key, value, focus) => { d[key] = value; render(focus); };
  const columnOptions = [['-1', 'Not in this file'], ...d.header.map((name, i) => [String(i), name || `Column ${i + 1}`])];
  const mapSelects = IMPORT_FIELDS.map((f) => {
    const sel = select(columnOptions, String(d.mapping[f]), { 'data-key': `map-${f}` });
    sel.addEventListener('change', () => update('mapping', { ...d.mapping, [f]: Number(sel.value) }, `map-${f}`));
    return field(`${FIELD_LABELS[f]}${['date', 'description', 'amount'].includes(f) ? ' *' : ''}`, sel);
  });
  const dateFmt = select([['dmy', 'Day/month/year'], ['mdy', 'Month/day/year'], ['ymd', 'Year-month-day']], d.dateFormat, { 'data-key': 'imp-date' });
  dateFmt.addEventListener('change', () => update('dateFormat', dateFmt.value, 'imp-date'));
  const dec = select([[',', '1.234,56 (comma)'], ['.', '1,234.56 (point)']], d.decimal, { 'data-key': 'imp-dec' });
  dec.addEventListener('change', () => update('decimal', dec.value, 'imp-dec'));
  const acc = select([['', 'None'], ...[...state.accounts].sort(byName).map((a) => [a.id, accountLabel(a)])], d.defaultAccountId, { 'data-key': 'imp-acc' });
  acc.addEventListener('change', () => update('defaultAccountId', acc.value, 'imp-acc'));

  const required = ['date', 'description', 'amount'].filter((f) => d.mapping[f] < 0);
  let n = 0;
  const preview = required.length ? null : runImport(() => `preview-${++n}`);
  const nameOf = (id) => state.accounts.find((a) => a.id === id)?.name
    ?? preview?.newAccounts.find((a) => a.id === id)?.name ?? '';
  const previewCats = [...state.categories, ...(preview?.newCategories ?? [])];
  const catOf = (ids) => ids.map((id) => previewCats.find((c) => c.id === id)).filter(Boolean).map((c) => categoryPath(c, previewCats)).join(', ');

  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'import-h' }, head,
    h('p', { class: 'fin-hint' }, `${d.fileName} · ${d.body.length} rows`),
    h('div', { class: 'fin-grid' }, mapSelects),
    h('div', { class: 'fin-grid' },
      field('Dates look like', dateFmt),
      field('Decimal separator', dec),
      field('Account for rows without one', acc, 'Rows with an Account column use that account, and unknown names become new accounts.')),
    required.length
      ? h('p', { class: 'fin-error', role: 'alert' }, `Choose the column for: ${required.map((f) => FIELD_LABELS[f]).join(', ')}.`)
      : h('div', { class: 'fin-import-summary', 'aria-live': 'polite' },
        h('p', {}, h('strong', {}, `${preview.transactions.length} to import`),
          preview.duplicates ? ` · ${preview.duplicates} already in your data (skipped)` : '',
          preview.errors.length ? ` · ${preview.errors.length} with problems (skipped)` : ''),
        (preview.linkedTransfers > 0 || preview.unpairedTransfers > 0) && h('p', { class: 'fin-hint' },
          preview.linkedTransfers ? `${preview.linkedTransfers} transfer${preview.linkedTransfers === 1 ? '' : 's'} between accounts, linked from their two rows.` : '',
          preview.unpairedTransfers ? ` ${preview.unpairedTransfers} transfer row${preview.unpairedTransfers === 1 ? '' : 's'} without a matching other side, imported as plain transactions.` : ''),
        preview.newAccounts.length > 0 && h('p', { class: 'fin-hint' },
          `New accounts: ${preview.newAccounts.map((a) => `${a.name} (${a.currency})`).join(', ')}. They start as Checking; change the type afterwards with Edit.`),
        preview.newCategories.length > 0 && h('p', { class: 'fin-hint' },
          `New categories: ${preview.newCategories.map((c) => c.name).join(', ')}.`),
        preview.errors.length > 0 && h('ul', { class: 'fin-import-errors' },
          preview.errors.slice(0, 5).map((e) => h('li', {}, `Line ${e.line}: ${e.message}`)),
          preview.errors.length > 5 && h('li', {}, `and ${preview.errors.length - 5} more`)),
        preview.transactions.length > 0 && h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
          h('caption', { class: 'fin-sr' }, 'First rows to import'),
          h('thead', {}, h('tr', {}, ['Date', 'Description', 'Amount', 'Account', 'Category'].map((t, i) =>
            h('th', { scope: 'col', class: i === 2 ? 'fin-r' : null }, t)))),
          h('tbody', {}, preview.transactions.slice(0, 8).map((t) => h('tr', {},
            h('td', { class: 'fin-nowrap' }, shortDate(t.date)), h('td', {}, t.description),
            h('td', { class: `fin-r fin-num ${tone(t.amount)}` }, (t.amount / 100).toFixed(2)),
            h('td', {}, nameOf(t.accountId)),
            h('td', {}, t.transferId ? h('span', { class: 'fin-muted' }, 'Transfer') : catOf(t.categoryIds)))))))),
    h('div', { class: 'fin-actions fin-mt' },
      button(`Import ${preview?.transactions.length ?? 0} transactions`, async () => {
        const res = runImport(newId);
        withEuroRates(res.transactions, [...state.accounts, ...res.newAccounts]);
        state.accounts.push(...res.newAccounts);
        state.categories.push(...res.newCategories);
        state.transactions.push(...res.transactions);
        state.people.push(...res.newPeople);
        state.ious.push(...res.ious);
        importDraft = null;
        persist(); render('import-file');
        say(`Imported ${res.transactions.length} transactions.`);
        await refreshRates(); // prices USD rows at their own dates
      }, 'primary', { disabled: !preview?.transactions.length }),
      button('Choose another file', () => { importDraft = null; render('import-file'); })));
}

export function download(name, rows) {
  const a = h('a', { href: URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

export const decimal2 = (minor) => (minor / 100).toFixed(2);

// Readable CSV tables (names instead of ids), for the Export buttons and inside a backup.
export function readableCsvs() {
  const accName = (id) => state.accounts.find((a) => a.id === id)?.name ?? '';
  const accCur = (id) => state.accounts.find((a) => a.id === id)?.currency ?? 'EUR';
  const holdingOf = (id) => state.holdings.find((x) => x.id === id);
  return {
    transactions: [
      ['Date', 'Description', 'Amount', 'Currency', 'Account', 'Category', 'Memo', 'Amount (EUR)', 'Transfer', 'Kind', 'Split', 'Holding'],
      ...[...state.transactions].sort((a, b) => a.date.localeCompare(b.date)).map((t) => [
        t.date, t.description, decimal2(t.amount), accCur(t.accountId), accName(t.accountId),
        t.transferId ? '' : categoriesOf(t).map(catLabel).filter(Boolean).join(', '), t.memo ?? '',
        t.rate == null ? '' : decimal2(convert(t.amount, t.rate)), t.transferId ?? '', t.kind ?? '',
        // A split's parts, "Food 40.00; Home 20.00"; a dividend's holding.
        splitsOf(t)?.map((p) => `${catLabel(p.categoryId) || 'No category'} ${decimal2(p.amount)}`).join('; ') ?? '',
        holdingOf(t.holdingId)?.symbol ?? '',
      ]),
    ],
    accounts: [
      ['Name', 'Type', 'Currency', 'Archived', 'Balance'],
      ...[...state.accounts].sort(byName).map((a) => [a.name, ACCOUNT_TYPE_LABELS[a.type], a.currency, a.archived ? 'yes' : 'no', decimal2(accountValue(a))]),
    ],
    holdings: [
      ['Account', 'Symbol', 'Exchange', 'Name', 'Quantity', 'Price', 'Currency', 'Value', 'Price date', 'Entered by hand'],
      ...state.holdings.map((x) => [
        accName(x.accountId), x.symbol, x.exchange ?? '', x.name ?? '', x.quantity, x.price ?? '', x.currency,
        holdingValue(x) == null ? '' : decimal2(holdingValue(x)), x.priceAt?.slice(0, 10) ?? '', x.manual ? 'yes' : 'no',
      ]),
    ],
    lots: [
      ['Account', 'Symbol', 'Date', 'Buy or sell', 'Units', 'Price', 'Fees', 'Currency'],
      ...[...state.lots].sort((a, b) => a.date.localeCompare(b.date)).map((l) => {
        const x = holdingOf(l.holdingId);
        return [accName(x?.accountId), x?.symbol ?? '', l.date, l.kind, l.quantity, l.price, l.fees ?? 0, x?.currency ?? ''];
      }),
    ],
    ious: [
      ['Date', 'Person', 'Type', 'Description', 'Amount (EUR, + they owe you)', 'Account'],
      ...[...state.ious].sort((a, b) => a.date.localeCompare(b.date)).map((e) => [
        e.date, personName(e.personId), IOU_TYPES[e.kind] ?? '', e.description, decimal2(e.amount),
        accName(state.transactions.find((t) => t.id === e.transactionId)?.accountId),
      ]),
    ],
    schedules: [
      ['Next date', 'Description', 'Type', 'Amount', 'Account', 'To account', 'Category', 'Repeats', 'Ends'],
      ...state.schedules.map((x) => [x.nextDate, x.description, x.kind, decimal2(x.amount), accName(x.accountId), accName(x.toAccountId), categoriesOf(x).map(catLabel).filter(Boolean).join(', '), frequencyLabel(x), x.endDate ?? '']),
    ],
    categories: [
      ['Category', 'Parent'],
      ...sortedCategories(state.categories).map((c) => [c.name, c.parentId ? category(c.parentId)?.name ?? '' : '']),
    ],
    rules: [
      ['Order', 'Match', 'Text', 'Category'],
      ...state.rules.map((r, i) => [i + 1, r.match, r.pattern, catLabel(r.categoryId)]),
    ],
  };
}

export const setBuxferDraft = (v) => { buxferDraft = v; };
export const setImportDraft = (v) => { importDraft = v; };
