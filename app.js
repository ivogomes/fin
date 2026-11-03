import {
  CURRENCIES, ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, toMinor, formatMoney, categorize, convert, rateFor, defaultState,
  normalize, categoryPath, categoriesOf, sortedCategories, searchCategories,
  IOU_KINDS, IOU_TYPES, personBalances, personHistory, PERIODS, periodRange, insightsFrom, completeMonths, REFUNDS_UNMATCHED, netWorthHistory, investedHistory, historyPoints, holdingHistory,
  suggestDescriptions, filterTransactions, ruleSuggestion,
  plannedTransactions, holdingValue, investmentValue, investmentValueFrom, newId,
  crossConvert, batchRow, makeTransfer,
  parseCsv, toCsv, guessDateFormat, guessDecimal, guessMapping, importRows, IMPORT_FIELDS, findTransferPairs,
  detectBuxferFile, buxferImport, isFtExport, ftImport, isFundMovements, fundMovementsToFt, lotSummary,
  UNITS, frequencyLabel, addInterval, occurrences, forecast, scheduledEffect, scheduledTransactions, advanceSchedule,
  INVESTMENT_KINDS, LOCKED_KINDS, lastStatementDate, dueAfter, balanceDip, savingsInterest,
  splitsOf, scaleSplits, DIVIDENDS, suggestSchedules, lotFlows, returnSummary, rulesFromHistory, findSubscriptions, withMarkedSchedules,
} from './model.js';
import {
  fetchRate, fetchRateRange, fetchQuote, fetchQuoteAV, fetchHistory, alphaVantageCovers, searchSymbols, today,
  FUND_MIC, isIsin, fundSearch, fundQuote, fundHistory,
} from './market.js';
import {
  load, persist, settle, onStatus, onSaved, hasPendingChanges, addTransactions, loadAllTransactions, transactionsComplete,
  refreshSummaries, accountTotals, editToken, isFromDatabase, legacyData, forgetLegacyData, missingTables, clearTables, needsSchemaUpdate, markSchemaOutdated,
  backupData, restoreData, BACKUP_TABLES,
} from './store.js';
import { makeZip, readZip } from './zip.js';
import { driveConfigured, uploadBackup, listBackups, disconnect as driveDisconnect, KEEP as DRIVE_KEEP } from './drive.js';
import { configured, currentUser, completeSignIn, sendSignInLink, signOut, SignedOut, rpc, selectAll } from './cloud.js';

// Set once the signed-in user's data has loaded (see boot() at the bottom).
let state = null;
// view: { name: 'account', id } | { name: 'settings' }
// Each main section is its own page, with its own address: …/finance/ (the overview), ?page=search
// (&q=… to search for something), ?page=settings&section=backup, ?account=<id>&tab=insights, and
// ?account= for the last account opened. Going to another section loads that page, so its data is
// fresh; within a page (accounts, settings pages) it's instant.
const BASE_PATH = '/tools/finance/';
const PAGES = ['overview', 'search', 'scheduled', 'insights', 'ious', 'settings'];
const sectionOf = (v) => (v.name === 'account' ? 'accounts' : v.name);
function urlOf(v) {
  const q = new URLSearchParams();
  if (v.name === 'account') {
    q.set('account', v.id ?? '');
    if (v.tab === 'insights') q.set('tab', 'insights');
  } else if (v.name !== 'overview') {
    q.set('page', v.name);
    if (v.name === 'settings' && v.section) q.set('section', v.section);
    if (v.name === 'settings' && v.section === 'import' && v.kind) q.set('kind', v.kind);
    if (v.name === 'insights' && v.tab === 'networth') q.set('tab', 'networth');
    if (v.name === 'scheduled' && v.tab === 'subscriptions') q.set('tab', 'subscriptions');
    if (v.name === 'ious' && v.personId) q.set('person', v.personId);
    if (v.name === 'search' && v.q) q.set('q', v.q);
  }
  const s = q.toString();
  return s ? `${BASE_PATH}?${s}` : BASE_PATH;
}
function viewFromUrl() {
  const q = new URLSearchParams(location.search);
  const page = q.get('page');
  // Net worth was its own page; it's now a tab of Insights (old links still land there).
  if (page === 'networth' || (page === 'insights' && q.get('tab') === 'networth')) return { name: 'insights', tab: 'networth' };
  // The imports were separate settings pages; they're now one, with a kind (old links still work).
  const oldImport = { buxfer: 'buxfer', ft: 'holdings' }[q.get('section')];
  if (page === 'settings' && oldImport) return { name: 'settings', section: 'import', kind: oldImport };
  if (PAGES.includes(page)) {
    return {
      ...(page === 'settings' && q.get('kind') && { kind: q.get('kind') }),
      ...(page === 'scheduled' && q.get('tab') === 'subscriptions' && { tab: 'subscriptions' }),
      name: page, ...(q.get('section') && { section: q.get('section') }), ...(q.get('person') && { personId: q.get('person') }),
      ...(page === 'search' && q.get('q') && { q: q.get('q') }),
    };
  }
  if (q.has('account')) return { name: 'account', id: q.get('account'), ...(q.get('tab') === 'insights' && { tab: 'insights' }) };
  return { name: 'overview' };
}
let view = viewFromUrl();
let shownView = view; // what's on screen, to fall back on if leaving the page is cancelled
let pageSection = null; // the section this page was loaded for, once loaded
let leaving = false;
// Leaves for another page: sends what's waiting to be saved first. `ask`: confirm before dropping
// something typed here but not saved (from the header tabs; actions that move on have saved already).
async function leave(url, { ask = false } = {}) {
  if (leaving) return;
  if (ask && hasUnsavedInput() && !window.confirm('Leave this page? What you’ve typed here isn’t saved yet.')) return;
  leaving = true;
  if (hasPendingChanges()) {
    say('Saving before switching page…');
    await settle();
  }
  location.assign(url);
  setTimeout(() => { leaving = false; }, 1000); // if the browser stays (the user chose to stay)
}
let editingTxId = null;
const TX_PAGE_SIZE = 100;
let txPage = 0; // 0 = the newest 100; reset when another account is selected
const collapsed = new Set(readPref('finance:collapsed', ['archived'])); // the archive starts closed

const side = document.getElementById('side');
const main = document.getElementById('app');
const dialog = document.getElementById('account-dialog');
const txDialog = document.getElementById('tx-dialog');
const status = document.getElementById('status');

// ── helpers ──────────────────────────────────────────────────────────────────

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
}

function readPref(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* per-viewer convenience only */ }
}

const say = (msg) => { status.textContent = ''; setTimeout(() => { status.textContent = msg; }, 30); };
const category = (id) => state.categories.find((c) => c.id === id);
// A category as shown everywhere: "Parent / Child" for children.
const catLabel = (id) => { const c = category(id); return c ? categoryPath(c, state.categories) : ''; };
// Options for a category <select>: parents followed by their children.
// A colour group (0–7) per top-level category, so a family's chips share a colour. Colours go round
// in alphabetical order of the top-level categories, so neighbours in the list never share one.
function hueOf(id) {
  const c = category(id);
  const top = c?.parentId ? category(c.parentId) ?? c : c;
  if (!top) return '0';
  if (!hueOrder) {
    hueOrder = new Map(state.categories.filter((x) => !x.parentId)
      .sort((x, y) => x.name.localeCompare(y.name)).map((x, i) => [x.id, String(i % 8)]));
  }
  return hueOrder.get(top.id) ?? '0';
}
let hueOrder = null; // reset on every render, like iouByTx
const catOptions = () => sortedCategories(state.categories).map((c) => [c.id, categoryPath(c, state.categories)]);
// Hide amounts (to show the app to someone): every amount and quantity is drawn as dots. The dots
// stand in for a fixed number, so their length says nothing about the real one; signs, colours and
// percentages stay. Remembered per browser.
let hideAmounts = readPref('finance:hide-amounts', false);
const MASK_MINOR = 123456;
const masked = (text) => text.replace(/\d/g, '•');
// How numbers look (Settings → Display): the browser's own way, or a chosen style. Per browser.
const NUMBER_FORMATS = {
  '': { label: 'Automatic (your browser’s language)', locale: undefined },
  dot: { label: '1,000.00', locale: 'en-GB' },
  comma: { label: '1.000,00', locale: 'de-DE' },
  space: { label: '1 000,00', locale: 'fr-FR' },
};
let numberFormat = NUMBER_FORMATS[readPref('finance:number-format', '')] ? readPref('finance:number-format', '') : '';
const numLocale = () => NUMBER_FORMATS[numberFormat].locale;
// A plain number with `digits` decimals (percentages, rates), in the chosen style.
const num = (x, digits = 1) => new Intl.NumberFormat(numLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x);
const money = (minor, cur) => (hideAmounts ? masked(formatMoney(minor < 0 ? -MASK_MINOR : MASK_MINOR, cur, numLocale())) : formatMoney(minor, cur, numLocale()));
const signed = (minor, cur) =>
  new Intl.NumberFormat(numLocale(), { style: 'currency', currency: cur, signDisplay: 'exceptZero' })
    .format((hideAmounts ? Math.sign(minor) * MASK_MINOR : minor) / 100).replace(/\d/g, (d) => (hideAmounts ? '•' : d));
const shownQty = (n) => (hideAmounts ? '•••' : new Intl.NumberFormat(numLocale(), { maximumFractionDigits: 8 }).format(n));
const tone = (minor) => (minor > 0 ? 'fin-pos' : minor < 0 ? 'fin-neg' : '');
const latestRate = (cur) => (cur === 'EUR' ? 1 : state.rates[`${cur}:latest`]?.rate ?? null);

const thisYear = new Date().getFullYear();
const shortDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, d.getFullYear() === thisYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
};

function field(label, control, hint) {
  const id = `f-${newId().slice(0, 8)}`;
  control.id = id;
  return h('div', { class: 'fin-field' },
    h('label', { for: id }, label), control, hint && h('p', { class: 'fin-hint' }, hint));
}

const input = (attrs) => h('input', { class: 'fin-input', ...attrs });
const select = (options, value, attrs = {}) =>
  h('select', { class: 'fin-input', ...attrs },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
const button = (label, onclick, kind = 'secondary', attrs = {}) =>
  h('button', { type: 'button', class: `fin-btn ${kind === 'primary' ? 'btn-primary' : kind}`, onclick, ...attrs }, label);

// A transaction's type as a segmented switch (a radio group): one Tab stop, ←/→ move and pick, like
// native radios. `compact` shows only the symbols (the quick-entry grid), with the names as labels
// and tooltips. `value` reads and sets the picked type.
const TX_TYPES = { expense: ['−', 'Expense'], income: ['+', 'Income'], refund: ['↩', 'Refund'], dividend: ['%', 'Dividend'], transfer: ['⇄', 'Transfer'] };
function typeSwitch(kinds, value, { label = 'Transaction type', compact = false, onChange } = {}) {
  let current = value;
  const show = () => btns.forEach((b, i) => {
    b.setAttribute('aria-checked', String(kinds[i] === current));
    b.tabIndex = kinds[i] === current ? 0 : -1;
  });
  const pick = (k, focus) => {
    if (focus) btns[kinds.indexOf(k)].focus();
    if (k === current) return;
    current = k;
    show();
    onChange?.(k);
  };
  const btns = kinds.map((k) => h('button', {
    type: 'button', role: 'radio', class: 'fin-seg-btn', 'data-kind': k,
    title: compact ? TX_TYPES[k][1] : null, 'aria-label': compact ? TX_TYPES[k][1] : null,
    onclick: () => pick(k, true),
  }, h('span', { class: 'fin-seg-icon', 'aria-hidden': 'true' }, TX_TYPES[k][0]), !compact && TX_TYPES[k][1]));
  const el = h('div', {
    class: `fin-seg fin-seg--type${compact ? ' fin-seg--compact' : ''}`, role: 'radiogroup', 'aria-label': label,
    onkeydown: (ev) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
      if (!step) return;
      ev.preventDefault();
      pick(kinds[(kinds.indexOf(current) + step + kinds.length) % kinds.length], true);
    },
  }, btns);
  show();
  return { el, get value() { return current; }, set value(k) { current = k; show(); } };
}

// Line icons (24px grid, drawn with the text colour) for compact row actions.
const ICONS = {
  edit: ['M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z', 'M13.5 6.5l3 3'],
  trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7l1 12.5h9l1-12.5', 'M10 11v5M14 11v5'],
  plus: ['M12 5v14M5 12h14'],
  refund: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  // Account types
  'type-cash': ['M3 7h18v10H3Z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z', 'M6.5 10v4M17.5 10v4'],
  'type-checking': ['M3 10 12 4.5l9 5.5', 'M5.5 10.5v7M10 10.5v7M14 10.5v7M18.5 10.5v7', 'M3 20h18'],
  'type-credit': ['M3 6h18v12H3Z', 'M3 10h18', 'M7 14.5h4'],
  'type-investment': ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'],
  'type-savings': ['M5 7.5c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5-7-1.1-7-2.5Z', 'M5 7.5v4.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V7.5', 'M5 12v4.5C5 17.9 8.1 19 12 19s7-1.1 7-2.5V12'],
  'type-archived': ['M3 5h18v4H3Z', 'M5 9v10h14V9', 'M10 13h4'],
};
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'fin-icon');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
// An icon-only button; `label` is its accessible name and tooltip.
const iconButton = (name, label, onclick, { danger = false, ...attrs } = {}) =>
  h('button', { type: 'button', class: `fin-icon-btn${danger ? ' fin-icon-btn--danger' : ''}`, 'aria-label': label, title: label, onclick, ...attrs }, icon(name));

// Loading animations: Fin's fin, on a rolling wave. They're decoration (hidden from screen readers,
// still when motion is reduced); the message beside them is what's announced.
const NS_SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs, ...kids) => {
  const n = document.createElementNS(NS_SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids);
  return n;
};
// A wave from x0 to x1 with its top at `y`, crests `period` wide and `height` high, filled down to `bottom`.
function wavePath(x0, x1, y, period, height, bottom) {
  let d = `M${x0} ${y}`;
  for (let x = x0, up = true; x < x1; x += period / 2, up = !up) d += `q${period / 4} ${up ? -height : height} ${period / 2} 0`;
  return `${d}V${bottom}H${x0}Z`;
}
// The logo's fin, 24 wide and 26 tall, facing right: the tip leans back to the left, so it swims
// forward as the animations move it rightwards (the logo's own faces the other way; it stays still).
const FIN_SHAPE = 'M24 26Q17 5 0 0Q7 9 4 26Z';

// Opening a page: a fin circling across the middle of the screen (gliding along, diving at the
// edge, surfacing on the other side), with a joke under the message that changes every few seconds.
const QUIPS = [
  'Something’s circling your spending…', 'Testing the waters…', 'Swimming through your transactions…',
  'Fin-ding your money…', 'Smelling a bargain…', 'Diving into the details…', 'Making a splash…', 'Circling the numbers…',
];
function circlingFin() {
  const clipId = `fin-water-${newId().slice(0, 6)}`;
  return svgEl('svg', { viewBox: '0 0 160 64', class: 'fin-circling', 'aria-hidden': 'true' },
    svgEl('defs', {}, svgEl('clipPath', { id: clipId }, svgEl('rect', { x: 0, y: 0, width: 160, height: 46 }))),
    svgEl('path', { d: wavePath(-40, 200, 44, 20, 3, 64), class: 'fin-wave fin-wave-back' }),
    svgEl('g', { 'clip-path': `url(#${clipId})` },
      svgEl('g', { transform: 'translate(0 20)' },
        svgEl('g', { class: 'fin-swim' }, svgEl('path', { d: FIN_SHAPE, class: 'fin-shape' })))),
    svgEl('path', { d: wavePath(-40, 200, 46, 20, 3, 64), class: 'fin-wave fin-wave-front' }));
}
function pageLoader(text) {
  let i = Math.floor(Math.random() * QUIPS.length);
  const quip = h('span', { class: 'fin-loader-quip', 'aria-hidden': 'true' }, QUIPS[i]);
  const box = h('div', { class: 'fin-page-loader', role: 'status' },
    circlingFin(), h('p', { class: 'fin-loader-text' }, text), quip);
  const timer = setInterval(() => {
    if (!box.isConnected) { clearInterval(timer); return; }
    i = (i + 1) % QUIPS.length;
    quip.textContent = QUIPS[i];
  }, 2400);
  return box;
}

// Inside a page (a table, a chart): a small fin bobbing on a rolling wave beside the message.
function loader(text) {
  const svg = svgEl('svg', { viewBox: '0 0 28 20', class: 'fin-bobbing', 'aria-hidden': 'true' },
    svgEl('g', { transform: 'translate(8 2) scale(0.5)' }, svgEl('g', { class: 'fin-bob' }, svgEl('path', { d: FIN_SHAPE, class: 'fin-shape' }))),
    svgEl('path', { d: wavePath(-8, 40, 14, 8, 1.6, 20), class: 'fin-wave fin-wave-front fin-wave-small' }));
  return h('div', { class: 'fin-loader', role: 'status' }, svg, h('span', {}, text));
}

const monthLabel = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

// ── rates and prices ─────────────────────────────────────────────────────────

async function ensureRate(currency, date) {
  const known = rateFor(currency, state.rates, date);
  if (known != null) return known;
  try {
    const rate = await fetchRate(currency, date);
    state.rates[`${currency}:${date}`] = rate;
    return rate;
  } catch { return null; }
}

async function refreshRates() {
  const used = new Set(state.accounts.map((a) => a.currency));
  state.holdings.forEach((x) => used.add(x.currency));
  used.delete('EUR');
  let failed = false;
  // Today's rate is saved with your settings: fetched on the first visit of the day, then reused on
  // every load and every device until tomorrow.
  const fx = state.settings.fx ?? (state.settings.fx = {});
  let fetched = false;
  for (const cur of used) {
    if (fx[cur]?.date === today()) {
      state.rates[`${cur}:latest`] = fx[cur];
      state.rates[`${cur}:${today()}`] = fx[cur].rate;
      continue;
    }
    const rate = await ensureRate(cur, today());
    if (rate == null) {
      failed = true;
      if (fx[cur]) state.rates[`${cur}:latest`] = fx[cur]; // yesterday's, until today's loads
      continue;
    }
    state.rates[`${cur}:latest`] = fx[cur] = { rate, date: today() };
    fetched = true;
  }
  if (fetched) persist();
  // Fill in transactions that have no rate yet (saved offline, or imported). Many at once are
  // priced from one date-range request per currency instead of one request per date.
  if (!transactionsComplete()) await fetchTransactions(() => selectAll('transactions', 'id', '&rate=is.null'));
  const missing = state.transactions.filter((t) => t.rate == null);
  const currencyOf = (t) => state.accounts.find((a) => a.id === t.accountId)?.currency;
  for (const cur of new Set(missing.map(currencyOf))) {
    if (!cur) continue;
    const list = missing.filter((t) => currencyOf(t) === cur);
    if (cur === 'EUR') { list.forEach((t) => { t.rate = 1; }); continue; }
    if (list.length > 3) {
      const dates = list.map((t) => t.date).sort();
      // Start a week early so a weekend or holiday at the start still has an earlier rate.
      const from = new Date(Date.parse(dates[0]) - 7 * 864e5).toISOString().slice(0, 10);
      try {
        const byDate = await fetchRateRange(cur, from, dates.at(-1));
        const days = Object.keys(byDate).sort();
        for (const t of list) {
          const day = days.filter((d) => d <= t.date).at(-1);
          if (day) { t.rate = byDate[day]; state.rates[`${cur}:${t.date}`] = byDate[day]; }
        }
      } catch { failed = true; }
    } else {
      for (const t of list) {
        const rate = await ensureRate(cur, t.date);
        if (rate != null) t.rate = rate;
      }
    }
  }
  if (missing.length) persist();
  if (failed) say('Exchange rates unavailable right now. Showing the last known values.');
  render();
}

// Each holding keeps its own `priceError` (the provider's message) so a failure shows on its row
// instead of disappearing.
async function refreshPrices(only) {
  const targets = only ?? state.holdings;
  if (!targets.length) return;
  say('Fetching prices…');
  let failed = 0;
  for (const x of targets) {
    try {
      // Funds go to EODHD (through the database); non-US listings to Alpha Vantage when a key is
      // set; everything else to Twelve Data.
      const viaAV = alphaVantageCovers(x.mic) && state.settings.avApiKey;
      const fund = x.mic === FUND_MIC;
      const q = fund ? await fundQuote(x.symbol, fundCall)
        : viaAV ? await fetchQuoteAV(x.symbol, x.mic, state.settings.avApiKey)
          : await fetchQuote(x.symbol, state.settings.quoteApiKey, x.mic);
      Object.assign(x, {
        price: q.price, name: x.name ?? q.name, currency: q.currency ?? x.currency,
        source: fund ? 'EODHD' : viaAV ? 'Alpha Vantage' : 'Twelve Data', priceAt: new Date().toISOString(),
      });
      delete x.priceError;
    } catch (err) {
      failed += 1;
      x.priceError = err.message;
    }
  }
  persist();
  await refreshRates(); // a quote may be in a currency we have no rate for yet
  say(failed
    ? `${failed} of ${targets.length} price${targets.length === 1 ? '' : 's'} could not be fetched.`
    : 'Prices updated.');
}

// Prices from an earlier day are refreshed when the page opens (needs the API key).
// Weekly price history: loaded on request per holding, then kept up to date once a week.
const latestClose = (x) => Object.keys(x.priceHistory ?? {}).sort().at(-1) ?? null;
const historyStale = (x) => latestClose(x) && latestClose(x) < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

async function loadHistory(list) {
  const keys = { avKey: state.settings.avApiKey, tdKey: state.settings.quoteApiKey };
  const failed = [];
  let done = 0;
  for (const x of list) {
    if (!x.symbol || !x.mic) { failed.push(`${x.symbol}: no exchange set (Edit the holding)`); continue; }
    try {
      const weekly = x.mic === FUND_MIC ? await fundHistory(x.symbol, fundCall) : await fetchHistory(x.symbol, x.mic, keys);
      x.priceHistory = { ...(x.priceHistory ?? {}), ...weekly };
      done += 1;
    } catch (err) {
      failed.push(`${x.symbol}: ${err.message.replace(/\s*Consider upgrading.*$/i, '')}`);
    }
  }
  if (done) { persist(); render(); }
  if (failed.length) showToast(`Price history: ${failed.join(' · ')}`, [], { timeout: 20000 });
  else if (done) say(`Price history loaded for ${done} holding${done === 1 ? '' : 's'}.`);
}

function stalePrices() {
  const priced = (x) => (x.mic === FUND_MIC ? Boolean(state.settings.eodhdApiKey) : Boolean(state.settings.quoteApiKey || state.settings.avApiKey));
  return state.holdings.filter((x) => !x.manual && priced(x) && (!x.priceAt || x.priceAt.slice(0, 10) !== today() || x.priceError));
}
// Runs the database's fund_data (EODHD for funds; see market.js).
const fundCall = (args) => rpc('fund_data', args);

// ── values ───────────────────────────────────────────────────────────────────

// Each account's totals as the database counted them plus any change made here since (store.js),
// worked out once per render. Balances count what has happened: transactions dated after today wait
// greyed out above the list.
let totalsCache = null;
function totalsOf(accountId) {
  totalsCache ??= accountTotals(today(), daysFromToday(FORECAST_DAYS));
  return totalsCache.get(accountId) ?? { balance: 0, count: 0, past: 0, planned: 0, plannedCount: 0 };
}
function accountValue(account) {
  const invested = totalsOf(account.id).balance;
  return account.type === 'investment'
    ? investmentValueFrom(account, state.holdings, invested, (c) => latestRate(c) ?? 1).total
    : invested;
}

// Group total in EUR. Accounts still waiting for a rate are left out and counted.
function groupTotal(list) {
  let total = 0;
  let missing = 0;
  for (const a of list.filter(counted)) {
    const rate = latestRate(a.currency);
    if (rate == null) missing += 1;
    else total += convert(accountValue(a), rate);
  }
  return { total, missing };
}

// ── side panel ───────────────────────────────────────────────────────────────

// Accounts are listed alphabetically everywhere (case and accents ignored).
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// Net worth in EUR; accounts still waiting for a rate are left out and counted.
function netWorthNow() {
  const nw = { total: 0, unconverted: 0 };
  for (const a of state.accounts) {
    if (a.archived || !counted(a)) continue;
    const rate = latestRate(a.currency);
    if (rate == null) nw.unconverted += 1;
    else nw.total += convert(accountValue(a), rate);
  }
  return nw;
}

function renderSide() {
  const nw = netWorthNow();
  return [
    // The net-worth card opens its own page: net worth over time and by account type.
    h('button', {
      type: 'button', class: 'fin-side-head fin-side-head--link', 'data-key': 'networth',
      'aria-current': view.name === 'insights' && view.tab === 'networth' ? 'page' : null,
      onclick: () => { view = { name: 'insights', tab: 'networth' }; render('networth'); say('Net worth.'); },
    },
      h('span', { class: 'fin-side-title' }, 'Net worth'),
      h('span', { class: 'fin-num' }, money(nw.total, 'EUR')),
      h('span', { class: 'fin-side-more' }, 'See over time ›')),
    nw.unconverted > 0 && h('p', { class: 'fin-side-note' }, `${nw.unconverted} account(s) left out until exchange rates load.`),
    state.accounts.length === 0 && h('p', { class: 'fin-side-note' }, 'No accounts yet.'),
    ACCOUNT_TYPES.map((type) => {
      const list = state.accounts.filter((a) => a.type === type && !a.archived).sort(byName);
      if (!list.length) return null;
      const { total } = groupTotal(list);
      return accountGroup(type, ACCOUNT_TYPE_LABELS[type], h('span', { class: `fin-num ${tone(total)}` }, money(total, 'EUR')), list);
    }),
    (() => {
      const archived = state.accounts.filter((a) => a.archived).sort(byName);
      return archived.length > 0 && accountGroup('archived', 'Archived', h('span', { class: 'fin-group-count' }, String(archived.length)), archived);
    })(),
    h('div', { class: 'fin-side-foot' }, button('Add account', () => openAccountDialog(), 'secondary', { 'data-key': 'add-account' })),
  ];
}

// Credit card networks, and a small mark for each beside the card's name (simple drawings of the
// brands' marks, not their artwork). Screen readers get the network's name.
const CARD_NETWORKS = { visa: 'Visa', mastercard: 'Mastercard' };
function cardMark(account, extra = '') {
  const n = account.type === 'credit' && CARD_NETWORKS[account.cardNetwork] ? account.cardNetwork : null;
  if (!n) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, ...kids) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.append(...kids);
    return e;
  };
  const svg = el('svg', { viewBox: '0 0 24 16', class: `fin-card-mark ${extra}`.trim(), role: 'img', 'aria-label': CARD_NETWORKS[n] });
  if (n === 'visa') {
    svg.append(el('rect', { width: 24, height: 16, rx: 2.5, class: 'fin-visa-bg' }),
      el('text', { x: 12, y: 11, 'text-anchor': 'middle', class: 'fin-visa-text' }, 'VISA'));
  } else {
    const clip = `mc-${newId().slice(0, 6)}`;
    svg.append(el('rect', { width: 24, height: 16, rx: 2.5, class: 'fin-mc-bg' }),
      el('clipPath', { id: clip }, el('circle', { cx: 9.5, cy: 8, r: 5 })),
      el('circle', { cx: 9.5, cy: 8, r: 5, class: 'fin-mc-red' }),
      el('circle', { cx: 14.5, cy: 8, r: 5, class: 'fin-mc-yellow' }),
      el('circle', { cx: 14.5, cy: 8, r: 5, class: 'fin-mc-orange', 'clip-path': `url(#${clip})` }));
  }
  return svg;
}

// How much of a credit card's limit is used: { used (0–100), level, left }, or null without a limit.
// The bar shows it (its width goes to the stylesheet as --used); teal, amber from 60%, red from 90%.
function limitUse(account, value) {
  if (account.type !== 'credit' || account.creditLimit == null) return null;
  const used = account.creditLimit > 0 ? Math.min(100, Math.max(0, Math.round((-value / account.creditLimit) * 100))) : 100;
  return { used, level: used >= 90 ? 'high' : used >= 60 ? 'mid' : 'low', left: account.creditLimit + value };
}
function usageBar(use, extra = '') {
  const bar = h('span', { class: 'fin-usage-bar', 'data-level': use.level });
  bar.style.setProperty('--used', `${use.used}%`);
  return h('span', { class: `fin-usage ${extra}`.trim(), 'aria-hidden': 'true' }, bar);
}

function accountGroup(key, label, total, list) {
  const holdsCurrent = view.name === 'account' && list.some((a) => a.id === view.id);
  // Each type has its own icon and tint, so the groups are easy to tell apart at a glance.
  return h('details', {
    class: `fin-group fin-group--${key}`, open: holdsCurrent || !collapsed.has(key),
    ontoggle: (e) => {
      if (e.target.open) collapsed.delete(key); else collapsed.add(key);
      writePref('finance:collapsed', [...collapsed]);
    },
  },
    h('summary', { class: 'fin-group-head' },
      h('span', { class: 'fin-group-icon' }, icon(`type-${key}`)),
      h('span', { class: 'fin-group-label' }, label), total),
    h('ul', { class: 'fin-accounts' }, list.map((a) => {
      const value = accountValue(a);
      const current = view.name === 'account' && view.id === a.id;
      const use = limitUse(a, value);
      return h('li', {},
        h('button', {
          type: 'button', class: `fin-account${use ? ' fin-account--limit' : ''}`, 'data-key': `acc-${a.id}`,
          'aria-current': current ? 'page' : null,
          onclick: () => selectAccount(a.id),
        },
          h('span', { class: 'fin-account-name' }, colorDot(a), cardMark(a), a.name,
            a.isMain && h('span', { class: 'fin-main-mark', title: 'Main account' }, h('span', { 'aria-hidden': 'true' }, '★'), h('span', { class: 'fin-sr' }, ', main account'))),
          // No + on positive balances here: less text, and the negative ones (in red) stand out.
          h('span', { class: `fin-num ${tone(value)}${counted(a) ? '' : ' fin-uncounted'}`, title: counted(a) ? null : 'Not in totals' }, money(value, a.currency),
            !counted(a) && h('span', { class: 'fin-sr' }, ', not in totals')),
          // A credit card with a limit: a thin bar of how much is used (said in words for screen readers).
          use && usageBar(use, 'fin-usage-side'),
          use && h('span', { class: 'fin-sr' }, `, ${use.used}% of the credit limit used`)));
    })));
}

function selectAccount(id) {
  if (view.id !== id) { txPage = 0; selected.clear(); }
  // Stay on Insights when moving between accounts, so they're easy to compare.
  view = { name: 'account', id, tab: view.name === 'account' ? view.tab : undefined };
  editingTxId = null;
  state.settings.lastAccountId = id;
  persist();
  render();
  say(`Showing ${state.accounts.find((a) => a.id === id)?.name}.`);
}

// ── account dialog ───────────────────────────────────────────────────────────

// Colours an account can wear (a dot by its name), the same hues as the category chips.
const ACCOUNT_COLORS = ['Teal', 'Blue', 'Purple', 'Pink', 'Orange', 'Yellow', 'Green', 'Grey'];
const colorDot = (a) => a.color != null && h('span', { class: 'fin-acc-dot', 'data-hue': a.color, 'aria-hidden': 'true' });
const mainAccount = () => state.accounts.find((a) => a.isMain && !a.archived);
// Accounts that count in net worth and the group totals (not the ones left out of totals).
const counted = (a) => !a.excludeTotals;
const INTEREST_EVERY = [[1, 'Every month'], [3, 'Every three months'], [12, 'Every year']];

// Add an account, or edit `existing`. The currency is fixed once an account has transactions or
// holdings, because their amounts are stored in that currency. Each type has its own settings (shown
// for that type only); "More details" has the ones every account can have.
function openAccountDialog(existing = null) {
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

function setArchived(account, archived) {
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
const inCurrency = (minor, from, to) => (from === to ? minor : crossConvert(minor, latestRate(from) ?? 1, latestRate(to) ?? 1));

// A card's latest statement (it has a statement day): its date, what was owed then (from the
// database), what's been paid into the card since, what's left, and when it's due (with a due day).
// undefined while it's worked out.
function statementOf(card) {
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
function cardPayments() {
  return state.accounts.filter((a) => a.type === 'credit' && !a.archived && a.statementDay && a.dueDay)
    .map((card) => ({ card, st: statementOf(card) }))
    .filter(({ st }) => st && st.left > 0)
    .map(({ card, st }) => ({ card, st, from: state.accounts.find((x) => x.id === card.payFrom && !x.archived) ?? null, date: st.due, amount: st.left }));
}

// Pays what's left on a card's statement from its "Paid from" account today, as a transfer.
async function payCard(p) {
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
function upcomingEffects(account) {
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
function accountAlerts(only = null) {
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

// A list of alerts, each with its Pay button for a card payment.
function alertsBox(list, { label = 'Heads up' } = {}) {
  if (!list.length) return null;
  return h('section', { class: 'fin-alerts', 'aria-label': label },
    h('ul', {}, list.map((al) => h('li', { class: `fin-alert fin-alert--${al.level}` },
      h('span', { class: 'fin-alert-icon', 'aria-hidden': 'true' }, al.level === 'due' ? '⏰' : '⚠'),
      h('span', {}, al.text),
      al.pay && button(al.pay.from ? 'Pay now' : 'Set where it’s paid from', () => payCard(al.pay), 'secondary fin-btn-sm',
        { 'aria-label': al.pay.from ? `Pay ${money(al.pay.amount, al.pay.card.currency)} to ${al.pay.card.name}` : `Set the account ${al.pay.card.name} is paid from` })))));
}

// ── main: account ────────────────────────────────────────────────────────────

function renderWelcome() {
  return h('div', { class: 'fin-welcome' },
    h('h2', { class: 'fin-title' }, 'Start with an account'),
    h('p', { class: 'fin-empty' }, 'Add your checking accounts, credit cards and investments. Accounts are in EUR unless you pick USD.'),
    button('Add account', () => openAccountDialog(), 'primary'));
}

function renderAccount(account) {
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
            view = { name: 'account', id: [...state.accounts].sort(byName).find((a) => !a.archived)?.id };
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
      account.currency !== 'EUR' && h('div', {}, h('dt', {}, 'In EUR'),
        h('dd', { class: 'fin-num' }, rate == null ? 'rate pending' : signed(convert(value, rate), 'EUR')),
        h('p', { class: 'fin-stat-note' }, rate == null ? 'waiting for today’s rate' : `at today’s rate, 1 ${account.currency} = ${num(rate, 4)} EUR`)),
      // For investments, the transactions are the money paid in; the gain is value minus that.
      inv?.hasHoldings && h('div', {}, h('dt', {}, 'Invested'), h('dd', { class: 'fin-num' }, money(inv.invested, account.currency)),
        h('p', { class: 'fin-stat-note' }, 'money put in')),
      inv?.hasHoldings && h('div', {}, h('dt', {}, 'Gain'),
        h('dd', { class: `fin-num ${tone(value - inv.invested)}` }, signed(value - inv.invested, account.currency)),
        h('p', { class: 'fin-stat-note' }, inv.invested > 0
          ? `${value >= inv.invested ? '+' : ''}${num((value - inv.invested) / inv.invested * 100)}% on what was put in`
          : 'value less what was put in')),
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

function statementCard(card) {
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

function interestCard(account, value) {
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
function accountTabs() {
  const tab = view.tab === 'insights' ? 'insights' : 'transactions';
  const pick = (t) => { view = { ...view, tab: t }; render(`tab-${t}`); };
  return h('div', { class: 'fin-tabs', role: 'group', 'aria-label': 'Account view' },
    ['transactions', 'insights'].map((t) => h('button', {
      type: 'button', class: 'fin-tab', 'aria-pressed': String(tab === t), 'data-key': `tab-${t}`, onclick: () => pick(t),
    }, t === 'transactions' ? 'Transactions' : 'Insights')));
}

// Only one page of rows is put in the DOM. The running balance is still worked out over all of the
// account's transactions, so every page shows the true balance after each row.
// ── messages with actions (Undo, rule offers) ────────────────────────────────

let toastTimer = null;
let toastUndo = null;
// One message at a time at the bottom of the screen, with optional buttons. It stays ~10 s, or
// until replaced. Undo is also on Ctrl/⌘+Z while the message shows.
function showToast(message, actions = [], { timeout = 10000, undo = null } = {}) {
  const el = document.getElementById('toast');
  clearTimeout(toastTimer);
  toastUndo = undo;
  const hide = () => { el.hidden = true; toastUndo = null; };
  el.replaceChildren(
    h('span', { class: 'fin-toast-msg' }, message),
    ...actions.map((a) => h('button', {
      type: 'button', class: `fin-toast-btn${a.primary ? ' fin-toast-btn--primary' : ''}`,
      onclick: () => { hide(); a.run(); },
    }, a.label)),
    h('button', { type: 'button', class: 'fin-toast-close', 'aria-label': 'Dismiss', onclick: hide }, '×'));
  el.hidden = false;
  toastTimer = setTimeout(hide, timeout);
}

// Runs a change that can be taken back: the named tables are copied first, and the message offers
// Undo, which puts the copies back (the save then sends the difference).
// Undo puts back the rows as they were; rows that came in afterwards (a page of transactions fetched
// meanwhile) stay, since leaving them out would delete them.
function undoable(message, tables, change) {
  const before = structuredClone(Object.fromEntries(tables.map((t) => [t, state[t]])));
  change();
  const after = Object.fromEntries(tables.map((t) => [t, new Set(state[t].map((x) => x.id))]));
  persist();
  render();
  const undo = () => {
    for (const t of tables) {
      const was = new Set(before[t].map((x) => x.id));
      state[t] = [...before[t], ...state[t].filter((x) => !was.has(x.id) && !after[t].has(x.id))];
    }
    persist();
    render();
    say('Undone.');
  };
  showToast(message, [{ label: 'Undo', primary: true, run: undo }], { undo });
  say(`${message} Undo is available.`);
}

document.addEventListener('keydown', (e) => {
  if (toastUndo && e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey
    && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    const undo = toastUndo;
    document.getElementById('toast').hidden = true;
    toastUndo = null;
    undo();
  }
});

// Deleting transactions: a transfer's other side and any IOU entries go too.
function deleteTransactions(ids) {
  const picked = state.transactions.filter((t) => ids.has(t.id));
  const transfers = new Set(picked.map((t) => t.transferId).filter(Boolean));
  const n = picked.length;
  undoable(n === 1 ? (picked[0].transferId ? 'Transfer deleted from both accounts.' : 'Transaction deleted.') : `${n} transactions deleted.`,
    ['transactions', 'ious'], () => {
      state.transactions = state.transactions.filter((t) => !ids.has(t.id) && !(t.transferId && transfers.has(t.transferId)));
      state.ious = state.ious.filter((e) => !ids.has(e.transactionId));
      selected.clear();
    });
}

// ── learning rules from manual categories ────────────────────────────────────

const ruleDeclined = new Set(); // "description|category" offers turned down, for this visit
async function offerRule(t, categoryId) {
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

const selected = new Set(); // ids of selected transactions, in the list on screen
const txFilters = new Map(); // scope ('acc:<id>' or 'search') → filter
// Lists pick several (any of them matches); an empty one means all. '' among the categories is
// "Uncategorized".
const EMPTY_FILTER = { text: '', categoryIds: [], types: [], from: '', to: '', min: '', max: '', accountIds: [] };
const filterOf = (scope) => txFilters.get(scope) ?? EMPTY_FILTER;
const filterActive = (f) => Boolean(f.text || f.categoryIds.length || f.types.length || f.from || f.to || f.min || f.max || f.accountIds.length);
let filterTimer = null;

// A filter menu for picking several values: a button saying what's picked ("All categories",
// "Groceries", "3 categories") that opens a list of checkboxes, with a search box when `searchable`.
// Each tick applies at once and the list stays open through the redraw (openMenu), so several can be
// ticked in a row. ↓/↑ move between the boxes, Esc or a click outside closes it.
// `options`: [{ value, label, sub?, hue?, child? }]; `onChange(values, focusKey)`.
let openMenu = null; // { key, q } of the menu that's open
let closeMenu = null; // hides it (and stops following the page's scrolling)
function multiFilter({ key, label, all, many, options, picked, onChange, searchable = false }) {
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
const closeMenuOutside = (ev) => {
  if (openMenu && !ev.target.closest?.(`[data-ms="${openMenu.key}"]`)) closeMenu?.();
};
document.addEventListener('mousedown', closeMenuOutside);
document.addEventListener('focusin', closeMenuOutside);

function filterBar(scope, { showAccount = false } = {}) {
  const f = filterOf(scope);
  const set = (patch, focusKey, wait = 0) => {
    txFilters.set(scope, { ...filterOf(scope), ...patch });
    txPage = 0;
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
  return h('div', { class: 'fin-filters', role: 'search', 'aria-label': 'Filter transactions' },
    h('div', { class: 'fin-filter-q' }, text),
    acc, cat, type,
    h('div', { class: 'fin-filter-pair' }, dateIn('from', 'From date'), h('span', { class: 'fin-muted' }, '–'), dateIn('to', 'To date')),
    h('div', { class: 'fin-filter-pair' }, amountIn('min', 'Min'), h('span', { class: 'fin-muted' }, '–'), amountIn('max', 'Max')),
    filterActive(f) && button('Clear', () => { closeMenu?.(); txFilters.delete(scope); txPage = 0; selected.clear(); render(`${scope}-q`); }, 'secondary fin-btn-sm', { 'data-key': `${scope}-clear` }));
}

function pager(page, pages, total, where, headingId = 'tx-h') {
  const go = (p, key) => {
    txPage = Math.min(Math.max(p, 0), pages - 1);
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
function bulkBar(pageRows) {
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
function openPicker(el) {
  try { el?.showPicker?.(); } catch { /* not allowed here, or not supported */ }
}
// Clicking anywhere in a date box opens its calendar, not just on its small icon. Keyboard focus
// doesn't, so typing a date stays as it was.
document.addEventListener('click', (e) => {
  const el = e.target;
  if (el instanceof HTMLInputElement && el.type === 'date' && !el.disabled && !el.readOnly) openPicker(el);
});

// Quick edit: one cell of a transaction (its date, amount or description) turns into a box. Enter or
// leaving it saves, Esc cancels. A transfer's other side follows (same date and description; its
// amount scales, so a cross-currency transfer keeps its rate), and Undo puts it back.
let quickEdit = null; // { id, field }
const QUICK_NAMES = { date: 'date', amount: 'amount', description: 'description' };
function quickCell(t, field, label, ...content) {
  const key = `qe-${t.id}-${field}`;
  if (quickEdit?.id !== t.id || quickEdit.field !== field) {
    return h('button', {
      type: 'button', class: 'fin-cell-btn', 'data-key': key, title: `Change the ${QUICK_NAMES[field]}`,
      'aria-label': `Change the ${QUICK_NAMES[field]} of ${label}`,
      onclick: () => {
        quickEdit = { id: t.id, field };
        editingTxId = null;
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

async function saveQuickEdit(t, field, raw) {
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
  const rates = field === 'date'
    ? await Promise.all([ensureRate(cur(tx.accountId), value), partner ? ensureRate(cur(partner.accountId), value) : null])
    : null;
  undoable(`${field === 'date' ? 'Date' : field === 'amount' ? 'Amount' : 'Description'} changed.`, ['transactions'], () => {
    const t2 = state.transactions.find((x) => x.id === t.id);
    const p2 = partner && state.transactions.find((x) => x.id === partner.id);
    if (field === 'description') { t2.description = value; if (p2) p2.description = value; }
    if (field === 'date') {
      t2.date = value; t2.rate = rates[0];
      if (p2) { p2.date = value; p2.rate = rates[1]; }
    }
    if (field === 'amount') {
      const next = toMinor(value) * (t2.amount < 0 ? -1 : 1);
      if (p2) p2.amount = Math.round(next * (p2.amount / t2.amount));
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
function txTable(rows, { caption, showBalance = false, showAccount = false, inEur = false, upcoming = null }) {
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
      inEur && h('th', { scope: 'col', class: 'fin-r' }, 'In EUR'),
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
      return [heading, h('tr', { class: selected.has(t.id) ? 'is-selected' : null },
        h('td', { class: 'fin-tick-col c-tick' }, h('input', {
          type: 'checkbox', class: 'fin-tick', checked: selected.has(t.id), 'aria-label': `Select ${label}`, 'data-key': `sel-${t.id}`,
          onchange: (e) => { if (e.target.checked) selected.add(t.id); else selected.delete(t.id); render(`sel-${t.id}`); },
        })),
        // Date, amount and description: click (or Enter) to change just that, in place.
        h('td', { class: 'fin-nowrap c-date' }, quickCell(t, 'date', label,
          h('time', { datetime: t.date }, shortDate(t.date)), showAccount && t.date.slice(0, 4) != thisYear && ` ${t.date.slice(0, 4)}`)),
        h('td', { class: `fin-r fin-num c-amt ${tone(t.amount)}` }, quickCell(t, 'amount', label,
          t.kind === 'refund' && h('span', { class: 'fin-refund', title: 'Refund' }, icon('refund'), h('span', { class: 'fin-sr' }, 'Refund: ')),
          signed(t.amount, cur))),
        showBalance && h('td', { class: 'fin-r fin-num fin-muted c-bal' }, t.balance == null ? '' : money(t.balance, cur)),
        h('td', { class: 'c-desc' }, quickCell(t, 'description', label, t.description),
          t.kind === 'dividend' && h('span', { class: 'fin-sub' }, holdingOf(t.holdingId) ? `Dividend from ${holdingOf(t.holdingId).symbol}` : 'Dividend'),
          t.memo && h('span', { class: 'fin-sub' }, t.memo)),
        showAccount && h('td', { class: 'c-acc' }, h('button', {
          type: 'button', class: 'fin-link fin-link-sm', onclick: () => selectAccount(t.accountId),
        }, ...(account ? accountBadge(account.id) : ['Deleted account']))),
        h('td', { class: 'c-cat' }, categoryCell(t)),
        inEur && h('td', { class: 'fin-r fin-num fin-muted c-eur' }, cur === 'EUR' ? '' : t.rate == null ? 'pending' : signed(convert(t.amount, t.rate), 'EUR')),
        h('td', { class: 'fin-r c-act' }, h('div', { class: 'fin-row-actions' },
          iconButton('edit', `Edit ${label}`, () => { editingTxId = t.id; render('tx-desc-edit'); }, { 'data-key': `tx-edit-${t.id}` }),
          iconButton('trash', `Delete ${label}`, () => deleteTransactions(new Set([t.id])), { danger: true }))))];
    }))));
}

// ── an account's transactions, a page at a time from the database ─────────────

// Fetches transactions (`get` resolves to database rows) into the ones in use. Pending changes are
// saved first, and the answer is dropped if something changed while it was on its way (it could
// bring back a row just deleted); then it tries again.
async function fetchTransactions(get) {
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
const listViews = new Map();
const listLoading = new Map();
// The last failure per scope, { key, message }: shown in place of the list, and not asked again
// until the filters (the key) change, so a redraw doesn't retry it in a loop.
const listErrors = new Map();
const listError = (scope, key) => (listErrors.get(scope)?.key === key ? listErrors.get(scope).message : null);
function requestList(scope, key, name, args) {
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
function filterArgs(f) {
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
const ratesArg = () => Object.fromEntries(CURRENCIES.map((c) => [c, latestRate(c) ?? 1]));

// Draws again after data arrives, unless that would wipe something being typed or edited; then the
// next redraw shows it.
function renderWhenIdle() {
  if (editingTxId || quickEdit || hasUnsavedInput()) return;
  render();
}

function transactionsSection(account) {
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
  if (ready && txPage > pages - 1) { txPage = pages - 1; return transactionsSection(account); } // after deleting the last rows of the last page
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
let everythingLoading = false;
function needEverything() {
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
let descCache = null;
let descLoading = false;
function loadDescIndex() {
  if (descLoading) return;
  descLoading = true;
  rpc('description_index')
    .then((list) => { descCache = list; })
    .catch(() => { /* suggestions are a convenience; try again next time */ })
    .finally(() => { descLoading = false; });
}
function descIndex() {
  if (!descCache) loadDescIndex();
  return descCache ?? [];
}

// Search across every account (archived ones too).
function renderSearch() {
  // Arriving with something to search for (…?page=search&q=…, from Go to): start with it.
  if (view.q) {
    txFilters.set('search', { ...EMPTY_FILTER, text: view.q });
    view = { name: 'search' };
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
  if (ready && txPage > pages - 1) { txPage = pages - 1; return renderSearch(); }
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

const transferPartner = (tx) =>
  tx.transferId && state.transactions.find((x) => x.transferId === tx.transferId && x.id !== tx.id);
// An account as written in text and in menus: a credit card says so, with its network ("Travel card
// (Visa)"), so it can't be mixed up with another account of the same name; `currency` adds that.
function accountLabel(a, { currency = false } = {}) {
  const extra = [a.type === 'credit' && (CARD_NETWORKS[a.cardNetwork] ?? 'credit card'), currency && a.currency].filter(Boolean);
  return extra.length ? `${a.name} (${extra.join(', ')})` : a.name;
}
const accountName = (id) => { const a = state.accounts.find((x) => x.id === id); return a ? accountLabel(a) : 'a deleted account'; };
// The same in a badge or a table cell: a card's network mark before its name (the mark names the
// network for screen readers); a card with no network set says "credit card" in words.
function accountBadge(id) {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) return ['a deleted account'];
  if (a.type !== 'credit') return [a.name];
  const mark = cardMark(a, 'fin-card-mark--tag');
  return mark ? [mark, a.name] : [accountLabel(a)];
}
// Accounts you can pick in a form: the active ones, plus `keep` even if it is archived.
const pickableAccounts = (keep) => state.accounts.filter((a) => !a.archived || a.id === keep).sort(byName);

// Inline edit of one transaction. For one side of a transfer, the other side follows: same date,
// description and memo, and its amount scales with this one (so cross-currency transfers
// keep their exchange rate).
function transactionForm(account, tx) {
  const partner = transferPartner(tx);
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
  const cats = categoryPicker(categoriesOf(tx), { label: `Categories of ${tx.description}` });
  const catField = pickerField('Categories', cats);
  const split = splitEditor(splitsOf(tx), { total: () => toMinor(amount.value), currency: account.currency, cats, catField });
  amount.addEventListener('input', () => split.refresh());
  const holdingPick = holdingSelect(tx.holdingId);
  const holdingField = field('From holding', holdingPick, 'Optional. Counts in that holding’s return.');
  const memo = h('textarea', { class: 'fin-input', rows: '2' });
  memo.value = tx.memo ?? '';
  const error = h('p', { class: 'fin-error', role: 'alert' });
  const cancel = () => { editingTxId = null; render(`tx-edit-${tx.id}`); };
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
        const ratio = partner.amount / tx.amount;
        const partnerCurrency = state.accounts.find((a) => a.id === partner.accountId)?.currency ?? 'EUR';
        Object.assign(partner, shared, {
          amount: Math.round(next * ratio),
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
      editingTxId = null;
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
      comboField('Description', descCombo), field(`Amount (${account.currency})`, amount),
      field('Date', date), !tx.transferId && holdingField),
    !tx.transferId && catField,
    !tx.transferId && split.el,
    h('div', { class: 'fin-grid' }, field('Memo', memo)),
    error,
    h('div', { class: 'fin-actions' },
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Save changes'),
      button('Cancel', cancel)));
}

// IOU entries per transaction, built once per render (there can be tens of thousands of rows).
let iouByTx = null;
function iousOf(transactionId) {
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
function iouLabel(entries) {
  const type = IOU_TYPES[entries[0].kind] ?? (entries[0].amount > 0 ? 'Loan' : 'Settlement');
  const people = [...new Set(entries.map((e) => e.personId))];
  return h('button', {
    type: 'button', class: 'fin-tag fin-tag--iou',
    onclick: () => { view = { name: 'ious', personId: people[0] }; render('person-h'); },
  }, `${type} · ${people.map(personName).join(', ')}`);
}

function categoryCell(t) {
  if (t.transferId) {
    const partner = transferPartner(t);
    return h('span', { class: 'fin-tag fin-tag--transfer' }, `${t.amount < 0 ? 'To' : 'From'} `, ...accountBadge(partner?.accountId));
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
        onclick: () => { editingTxId = t.id; render('tx-desc-edit'); },
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
function categoryCombo({ label, placeholder = '+ Category', exclude = () => [], onPick, onBackspace }) {
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
function categoryPicker(selected, { label, compact = false, onChange, placeholder } = {}) {
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
const catChips = (ids) => ids.length > 0 && h('div', { class: 'fin-cats' },
  ids.map((id) => h('span', { class: 'fin-cat-chip', 'data-hue': hueOf(id) }, h('span', {}, catLabel(id) || 'Deleted category'))));

// A labelled form row for a category picker (a group, so the label is its accessible name).
function pickerField(label, picker) {
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
function splitEditor(initial, { total, currency, cats, catField }) {
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
function holdingSelect(selected) {
  const list = [...state.holdings].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return select([['', 'Not linked to a holding'], ...list.map((x) => [x.id, `${x.symbol}${x.name && x.name !== x.symbol ? ` · ${x.name}` : ''} (${accountName(x.accountId)})`])], selected ?? '');
}
const holdingOf = (id) => state.holdings.find((x) => x.id === id);

// ── add transactions dialog ──────────────────────────────────────────────────

// Two modes, as in Buxfer: "multi" is a grid of quick rows; "single" has every field, including transfers.
function openTxDialog(mode, account) {
  const close = () => { txDialog.close(); render('tx-add'); };
  const swap = (next) => { txDialog.replaceChildren(next === 'multi' ? multiTxForm(account, close, swap) : singleTxForm(account, close, swap)); txDialog.querySelector('input, select')?.focus(); };
  swap(mode);
  if (!txDialog.open) txDialog.showModal();
  txDialog.querySelector('input[type="text"]')?.focus();
}

function dialogHead(title, close) {
  return h('div', { class: 'fin-dialog-head' },
    h('h2', { id: 'tx-dialog-h', class: 'fin-dialog-title' }, title),
    button('×', close, 'secondary fin-btn-icon', { 'aria-label': 'Close' }));
}

// Shows a combobox's list floating under its box (fixed to the window, so a dialog or a scrolling
// table can't cut it off), or above it when there isn't room below. `open(on)` shows or hides it.
function floatingList(box, listbox, minWidth = 288) {
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
function descriptionCombo(index, { label, accountOf, onAccept }) {
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
function comboField(label, combo, hint) {
  const f = field(label, combo.box, hint);
  f.replaceChild(combo.el, combo.box);
  combo.el.prepend(combo.box);
  return f;
}

// Quick entry: a grid of rows, made for the keyboard. Descriptions suggest earlier ones and fill the
// rest of the row from their latest use; Enter goes to the next row (adding one at the end);
// Ctrl/⌘+Enter saves them all.
const SIGNS = { expense: '-', income: '+', refund: 'r', transfer: 't' }; // batchRow's codes
function multiTxForm(account, close, swap) {
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

function singleTxForm(account, close, swap) {
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
function symbolPicker(onPick) {
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
function priceCell(x) {
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

// ── editing a holding ────────────────────────────────────────────────────────

// Exchanges a holding can be priced on (MIC → name). Non-US ones are priced through Alpha Vantage.
const EXCHANGES = [
  ['XETR', 'Xetra'], ['XFRA', 'Frankfurt'], ['XLON', 'London'], ['XPAR', 'Paris'], ['XAMS', 'Amsterdam'],
  ['XMIL', 'Milan'], ['XTSE', 'Toronto'], ['XNAS', 'NASDAQ'], ['XNGS', 'NASDAQ (Global Select)'], ['XNYS', 'NYSE'],
];

function openHoldingDialog(x) {
  const hasLots = lotsOfHolding(x.id).length > 0;
  const name = input({ type: 'text', required: true, autocomplete: 'off', value: x.name ?? x.symbol });
  const symbol = input({ type: 'text', required: true, autocomplete: 'off', spellcheck: 'false', value: x.symbol });
  const known = EXCHANGES.some(([mic]) => mic === x.mic);
  const exchange = select([['', 'Not listed (price by hand)'], ...EXCHANGES, ...(x.mic && !known ? [[x.mic, x.exchange ?? x.mic]] : [])], x.mic ?? '');
  const currency = input({ type: 'text', required: true, autocomplete: 'off', maxlength: '3', value: x.currency, spellcheck: 'false' });
  const units = input({ type: 'number', step: 'any', min: '0', required: true, inputmode: 'decimal', value: String(x.quantity), disabled: hasLots });
  const price = input({ type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: x.price == null ? null : String(x.price) });
  const source = select([['live', 'Live, from market data'], ['manual', 'Entered by hand']], x.manual ? 'manual' : 'live');
  const accounts = state.accounts.filter((a) => a.type === 'investment' && (!a.archived || a.id === x.accountId)).sort(byName);
  const account = select(accounts.map((a) => [a.id, a.name]), x.accountId);
  // Picking another listing fills in its ticker, name, exchange and currency.
  const picker = symbolPicker((r) => {
    symbol.value = r.symbol;
    name.value = r.name;
    currency.value = r.currency;
    if (![...exchange.options].some((o) => o.value === r.mic)) exchange.append(h('option', { value: r.mic }, r.exchange));
    exchange.value = r.mic;
    source.value = 'live';
  });
  const findField = field('Find a different listing', picker.box);
  findField.replaceChild(picker.el, picker.box);
  picker.el.prepend(picker.box);
  findField.append(picker.note);
  const close = () => { dialog.close(); render(`hold-edit-${x.id}`); };

  dialog.replaceChildren(h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const listingChanged = symbol.value.trim().toUpperCase() !== x.symbol || (exchange.value || null) !== (x.mic ?? null);
      Object.assign(x, {
        name: name.value.trim(),
        symbol: symbol.value.trim().toUpperCase(),
        mic: exchange.value || null,
        exchange: exchange.value ? exchange.selectedOptions[0].textContent : null,
        currency: currency.value.trim().toUpperCase(),
        accountId: account.value,
        manual: source.value === 'manual',
        ...(hasLots ? {} : { quantity: Number(units.value) }),
      });
      if (price.value !== '' && Number(price.value) !== x.price) {
        Object.assign(x, { price: Number(price.value), priceAt: new Date().toISOString() });
      }
      if (listingChanged) delete x.priceError;
      if (account.value !== view.id) view = { name: 'account', id: account.value };
      persist(); close();
      say(`Saved ${x.symbol}.`);
      // A new listing, or switching to live prices, fetches a price straight away.
      if (!x.manual && (listingChanged || x.priceError || x.price == null)) await refreshPrices([x]);
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, `Edit ${x.symbol}`),
    findField,
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Name', name), field('Ticker', symbol),
      field('Exchange', exchange), field('Currency', currency, 'Three letters, e.g. EUR or USD.'),
      field('Units', units, hasLots ? 'Calculated from its buys and sells. Change those under Lots.' : null),
      field(`Price per unit (${x.currency})`, price),
      field('Price', source, 'Live prices need the API keys in Settings → Market data.'),
      field('Account', account)),
    h('div', { class: 'fin-dialog-actions' },
      button('Cancel', close),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Save'))));
  dialog.showModal();
  name.focus();
}

// ── lots: a holding's buys and sells ─────────────────────────────────────────

let openLotsId = null;
let openChartId = null; // the holding whose charts are open

// A holding's price over time, and the gain or loss on the units held (needs its buys and sells).
function holdingChartPanel(x) {
  const hist = holdingHistory(x, state.lots, today());
  // Built with h(), which leaves out false and null (append() would print them as text).
  const panel = (...kids) => h('div', { class: 'fin-tx-form', 'aria-label': `Charts of ${x.symbol}` }, ...kids);
  if (hist.length < 2) {
    return panel(h('p', { class: 'fin-hint' }, x.mic
      ? `Not enough prices for ${x.symbol} yet. Load its price history, or add its buys and sells.`
      : `Not enough prices for ${x.symbol} yet. Add its buys and sells (each has a price), or update its price over time.`),
    x.mic && button('Load price history', () => loadHistory([x]), 'secondary fin-btn-sm'));
  }
  const last = hist.at(-1);
  const pct = last.cost ? ` (${last.gain >= 0 ? '+' : ''}${num((last.gain / last.cost) * 100)}%)` : '';
  return panel(
    last.gain != null && h('p', { class: 'fin-readout' },
      'Now ', h('strong', { class: 'fin-num' }, money(last.value, x.currency)), ' for ', shownQty(last.units), ' units, ',
      h('strong', { class: `fin-num ${tone(last.gain)}` }, signed(last.gain, x.currency)), hideAmounts ? '' : pct, ' on what they cost.'),
    h('div', { class: 'fin-hold-charts' },
      timeChart(hist.map((p) => ({ date: p.date, v: Math.round(p.price * 100) })), {
        id: `price-${x.id}`, title: `Price of ${x.symbol}`, unit: `${x.currency} per unit`, format: (v) => money(v, x.currency),
      }),
      last.gain != null && timeChart(hist.map((p) => ({ date: p.date, v: p.gain })), {
        id: `gain-${x.id}`, title: 'Gain or loss', unit: 'on the units held then', format: (v) => signed(v, x.currency), kind: 'gain',
      })),
    last.gain == null && h('p', { class: 'fin-hint' }, 'Add its buys and sells to see the gain or loss over time.'));
}

// A small box by the hovered or focused mark, saying what the chart's readout says. It's for the
// eye: screen readers already hear the readout or the mark's own label, so it's hidden from them.
// `show(kids, xFrac, yFrac)` places it at that share of the drawing (`svg`); its place goes to the
// stylesheet in pixels (--tip-x, --tip-y), since the box can scroll sideways on a phone. Near an
// edge it lines up with the edge instead of centring, and near the top it goes below the mark.
function chartTip(wrap, svg) {
  const tip = h('div', { class: 'fin-tip', 'aria-hidden': 'true', hidden: true });
  wrap.classList.add('fin-has-tip');
  wrap.append(tip);
  return {
    show(kids, xFrac, yFrac) {
      tip.replaceChildren(...kids.flat().filter((k) => k != null && k !== false && k !== ''));
      const box = wrap.getBoundingClientRect();
      const art = svg.getBoundingClientRect();
      const x = art.left - box.left + wrap.scrollLeft + xFrac * art.width;
      const y = art.top - box.top + wrap.scrollTop + yFrac * art.height;
      const seen = x - wrap.scrollLeft; // where it is in the visible part
      tip.style.setProperty('--tip-x', `${Math.round(x)}px`);
      tip.style.setProperty('--tip-y', `${Math.round(y)}px`);
      tip.dataset.edge = seen < 90 ? 'start' : seen > wrap.clientWidth - 90 ? 'end' : 'mid';
      tip.dataset.side = y < 64 ? 'below' : 'above';
      tip.hidden = false;
    },
    hide() { tip.hidden = true; },
  };
}

// One series over time, placed by date. `kind`:
// - 'change' (default): the total on the left axis, and on the right the same gridlines as the change
//   since the first point (one scale, two readings); the line is green above where it started and
//   red below, with that level marked. `ref` adds a dashed line to compare with (e.g. money invested).
// - 'gain': a line around zero, gains shaded green and losses red.
// One tab stop: ←/→ step through the points (Home/End jump), the readout says the values; a table
// has them all. `wide` for a full-width chart.
function timeChart(points, { id, title, unit, format, kind = 'change', ref = null, refLabel = '', wide = false }) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const change = kind === 'change';
  const W = wide ? 860 : 560; const H = wide ? 260 : 220; const L = 76; const R = change ? 76 : 12; const T = 12; const B = 26;
  const plotW = W - L - R; const plotH = H - T - B;
  const base = points[0].v;
  const vals = [...points.map((p) => p.v), ...(ref ?? []).map((p) => p.v)];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (kind === 'gain') { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  if (hi === lo) { hi += 100; lo -= 100; }
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw);
  const bottom = Math.floor(lo / step) * step;
  const top = Math.ceil(hi / step) * step;
  const t0 = Date.parse(points[0].date);
  const span = Math.max(1, Date.parse(points.at(-1).date) - t0);
  const x = (p) => L + ((Date.parse(p.date) - t0) / span) * plotW;
  const y = (v) => T + plotH - ((v - bottom) / (top - bottom)) * plotH;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fin-chart fin-time-chart', role: 'img', 'aria-label': `${title}${unit ? `, ${unit}` : ''}, from ${shortDate(points[0].date)} ${points[0].date.slice(0, 4)} to ${shortDate(points.at(-1).date)} ${points.at(-1).date.slice(0, 4)}` });
  const short = (v) => (hideAmounts ? '•••' : format(Math.round(v)).replace(/[.,]00(?=\D*$)/, ''));
  for (let v = bottom; v <= top + step / 2; v += step) {
    svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 && kind === 'gain' ? 'fin-axis-line' : 'fin-grid-line' }));
    const t = el('text', { x: L - 8, y: y(v) + 4, class: 'fin-tick', 'text-anchor': 'end' });
    t.textContent = short(v);
    svg.append(t);
  }
  // The right axis: the change since the start, in round steps of the same size as the left's (the
  // same scale, counted from the starting level), with a small tick for each.
  if (change) {
    for (let k = Math.ceil((bottom - base) / step); base + k * step <= top + step / 100; k += 1) {
      const d = Math.round(k * step);
      const yy = y(base + d);
      svg.append(el('line', { x1: W - R, x2: W - R + 4, y1: yy, y2: yy, class: 'fin-axis-line' }));
      const r = el('text', { x: W - R + 8, y: yy + 4, class: `fin-tick ${d > 0 ? 'fin-tick-up' : d < 0 ? 'fin-tick-down' : ''}`, 'text-anchor': 'start' });
      r.textContent = hideAmounts ? '•••' : d === 0 ? '0' : `${d > 0 ? '+' : '−'}${format(Math.abs(d)).replace(/[.,]00(?=\D*$)/, '').replace(/^[+−-]/, '')}`;
      svg.append(r);
    }
  }
  const pathOf = (list) => list.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const line = pathOf(points);
  // Above and below a level (the start, or zero): two clip areas.
  const split = (level) => {
    const at = Math.min(T + plotH, Math.max(T, y(level)));
    const upId = `${id}-up`;
    const downId = `${id}-down`;
    const upClip = el('clipPath', { id: upId });
    upClip.append(el('rect', { x: L - 4, y: T - 4, width: plotW + 8, height: at - T + 4 }));
    const downClip = el('clipPath', { id: downId });
    downClip.append(el('rect', { x: L - 4, y: at, width: plotW + 8, height: T + plotH - at + 4 }));
    svg.append(upClip, downClip);
    return { up: `url(#${upId})`, down: `url(#${downId})`, at };
  };
  if (ref) svg.append(el('path', { d: pathOf(ref), class: 'fin-line fin-line-ref' }));
  if (kind === 'gain') {
    const clip = split(0);
    const area = `${line}L${x(points.at(-1)).toFixed(1)},${clip.at}L${x(points[0]).toFixed(1)},${clip.at}Z`;
    svg.append(el('path', { d: area, class: 'fin-area-gain', 'clip-path': clip.up }));
    svg.append(el('path', { d: area, class: 'fin-area-loss', 'clip-path': clip.down }));
    svg.append(el('path', { d: line, class: 'fin-line fin-line-gain' }));
  } else {
    const clip = split(base);
    svg.append(el('line', { x1: L, x2: W - R, y1: clip.at, y2: clip.at, class: 'fin-base-line' }));
    svg.append(el('path', { d: line, class: 'fin-line fin-line-up', 'clip-path': clip.up }));
    svg.append(el('path', { d: line, class: 'fin-line fin-line-down', 'clip-path': clip.down }));
  }
  // Dates along the bottom: about five, evenly spread.
  const ticks = Math.min(wide ? 7 : 5, points.length);
  for (let k = 0; k < ticks; k += 1) {
    const d = new Date(t0 + (span * k) / Math.max(1, ticks - 1)).toISOString().slice(0, 10);
    const t = el('text', { x: L + (plotW * k) / Math.max(1, ticks - 1), y: H - 8, class: 'fin-tick', 'text-anchor': k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle' });
    t.textContent = new Date(`${d}T00:00:00`).toLocaleDateString(undefined, span < 120 * 864e5 ? { day: 'numeric', month: 'short' } : { month: 'short', year: 'numeric' });
    svg.append(t);
  }
  const guide = el('line', { class: 'fin-guide', y1: T, y2: T + plotH, x1: -10, x2: -10 });
  const dot = el('circle', { class: 'fin-dot fin-dot-gain', r: 4, cx: -10, cy: -10 });
  svg.append(guide, dot);
  const readout = h('p', { class: 'fin-readout', 'aria-live': 'polite' });
  const refAt = (date) => ref?.find((r) => r.date === date)?.v;
  const signedOf = (v) => (v === 0 ? format(0) : `${v > 0 ? '+' : '−'}${format(Math.abs(v)).replace(/^[+−-]/, '')}`);
  let at = points.length - 1;
  // What a point says: its date and value, the change since the start, and the line to compare with.
  const info = (p, i) => {
    const d = p.v - base;
    const r = refAt(p.date);
    return [h('strong', {}, `${shortDate(p.date)} ${p.date.slice(0, 4)}`), ' ',
      h('strong', { class: `fin-num ${kind === 'gain' ? tone(p.v) : ''}` }, format(p.v)),
      change && i > 0 && [' · ', h('span', { class: `fin-num ${tone(d)}` }, signedOf(d)),
        !hideAmounts && base > 0 ? ` (${d >= 0 ? '+' : ''}${num((d / base) * 100)}%)` : '', ' since the start'],
      r != null && [' · ', refLabel.toLowerCase(), ' ', h('span', { class: 'fin-num' }, format(r))],
    ].flat().filter((k) => k != null && k !== false && k !== '');
  };
  let tip = null;
  const show = (i, withTip = false) => {
    at = Math.max(0, Math.min(points.length - 1, i));
    const p = points[at];
    guide.setAttribute('x1', x(p)); guide.setAttribute('x2', x(p));
    dot.setAttribute('cx', x(p)); dot.setAttribute('cy', y(p.v));
    dot.setAttribute('class', `fin-dot ${kind === 'gain' ? 'fin-dot-gain' : p.v >= base ? 'fin-dot-up' : 'fin-dot-down'}`);
    // replaceChildren doesn't flatten lists (it would print them as text): info() gives a flat one.
    readout.replaceChildren(...info(p, at));
    if (withTip) tip.show(info(p, at), x(p) / W, y(p.v) / H);
  };
  const wrap = h('div', {
    class: 'fin-chart-wrap', tabindex: '0', role: 'group', 'aria-label': `${title}: use the arrow keys to read each point`,
    onkeydown: (e) => {
      const move = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: points.length - 1 }[e.key];
      if (move === undefined) return;
      e.preventDefault();
      show(move, true);
    },
    onfocus: () => show(at, true),
    onblur: () => tip.hide(),
  }, svg);
  tip = chartTip(wrap, svg);
  // Pointer: the nearest point by date.
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(x(p) - px) < Math.abs(x(points[best]) - px)) best = i; });
    show(best, true);
  });
  svg.addEventListener('pointerleave', () => { if (document.activeElement !== wrap) tip.hide(); });
  show(at);
  const table = h('details', { class: 'fin-chart-table' },
    h('summary', {}, 'Show as a table'),
    h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
      h('caption', { class: 'fin-sr' }, title),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col', class: 'fin-r' }, title),
        change && h('th', { scope: 'col', class: 'fin-r' }, 'Since the start'),
        ref && h('th', { scope: 'col', class: 'fin-r' }, refLabel))),
      h('tbody', {}, [...points].reverse().map((p) => h('tr', {},
        h('th', { scope: 'row' }, `${shortDate(p.date)} ${p.date.slice(0, 4)}`),
        h('td', { class: `fin-r fin-num ${kind === 'gain' ? tone(p.v) : ''}` }, format(p.v)),
        change && h('td', { class: `fin-r fin-num ${tone(p.v - base)}` }, signedOf(p.v - base)),
        ref && h('td', { class: 'fin-r fin-num' }, refAt(p.date) == null ? '—' : format(refAt(p.date)))))))));
  return h('section', { class: 'fin-hold-chart', 'aria-labelledby': `${id}-h` },
    h('div', { class: 'fin-chart-head' },
      h('h4', { id: `${id}-h`, class: 'fin-label' }, title, unit && ' ', unit && h('span', { class: 'fin-muted fin-chart-unit' }, unit)),
      (change || ref) && h('ul', { class: 'fin-legend', 'aria-label': 'Legend' },
        change && h('li', {}, h('span', { class: 'fin-key fin-key-up' }), 'up since the start'),
        change && h('li', {}, h('span', { class: 'fin-key fin-key-down' }), 'down'),
        ref && h('li', {}, h('span', { class: 'fin-key fin-key-ref' }), refLabel))),
    readout, wrap, table);
}
const lotsOfHolding = (id) => state.lots.filter((l) => l.holdingId === id).sort((a, b) => a.date.localeCompare(b.date));
// A holding with lots takes its units from them.
function recalcHolding(x) {
  const own = lotsOfHolding(x.id);
  if (own.length) x.quantity = lotSummary(own).quantity;
}

function lotsPanel(x) {
  const own = lotsOfHolding(x.id);
  const kind = select([['buy', 'Buy'], ['sell', 'Sell']], 'buy');
  const date = input({ type: 'date', required: true, value: today(), 'data-key': `lot-date-${x.id}` });
  const units = input({ type: 'number', step: 'any', min: '0', required: true, inputmode: 'decimal' });
  const price = input({ type: 'number', step: 'any', min: '0', required: true, inputmode: 'decimal' });
  const fees = input({ type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: '0' });
  return h('div', { class: 'fin-tx-form', 'aria-label': `Buys and sells of ${x.symbol}` },
    own.length === 0
      ? h('p', { class: 'fin-hint fin-mb' }, `No buys or sells for ${x.symbol} yet. Add them here, or import an FT.com export in Settings. Once it has lots, its units come from them.`)
      : h('div', { class: 'fin-scroll fin-mb' }, h('table', { class: 'fin-table fin-lots' },
        h('caption', { class: 'fin-sr' }, `Buys and sells of ${x.symbol}`),
        h('thead', {}, h('tr', {}, ['Date', '', 'Units', 'Price', 'Fees', 'Total'].map((t, i) => h('th', { scope: 'col', class: i > 1 ? 'fin-r' : null }, t)),
          h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
        h('tbody', {}, [...own].reverse().map((l) => h('tr', {},
          h('td', { class: 'fin-nowrap' }, shortDate(l.date), l.date.slice(0, 4) != thisYear && ` ${l.date.slice(0, 4)}`),
          h('td', {}, h('span', { class: `fin-chip ${l.kind === 'sell' ? 'fin-chip-sell' : 'fin-chip-buy'}` }, l.kind === 'sell' ? 'Sell' : 'Buy')),
          h('td', { class: 'fin-r fin-num' }, shownQty(l.quantity)),
          h('td', { class: 'fin-r fin-num' }, money(Math.round(l.price * 100), x.currency)),
          h('td', { class: 'fin-r fin-num fin-muted' }, l.fees ? money(Math.round(l.fees * 100), x.currency) : '—'),
          h('td', { class: 'fin-r fin-num' }, money(Math.round((l.quantity * l.price + (l.kind === 'sell' ? -(l.fees ?? 0) : (l.fees ?? 0))) * 100), x.currency)),
          h('td', { class: 'fin-r' }, h('div', { class: 'fin-row-actions' }, iconButton('trash', `Delete the ${l.kind} of ${l.quantity} on ${shortDate(l.date)}`, () => {
            undoable(`Deleted the ${l.kind} of ${l.quantity} ${x.symbol}.`, ['lots', 'holdings'], () => {
              state.lots = state.lots.filter((y) => y.id !== l.id);
              recalcHolding(state.holdings.find((y) => y.id === x.id));
            });
          }, { danger: true })))))))),
    h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        state.lots.push({ id: newId(), holdingId: x.id, date: date.value, kind: kind.value, quantity: Number(units.value), price: Number(price.value), fees: Number(fees.value) || 0 });
        recalcHolding(x);
        persist(); render(`lot-date-${x.id}`); say(`Added. ${x.symbol} now has ${x.quantity} units.`);
      },
    },
      h('div', { class: 'fin-grid' },
        field('Buy or sell', kind), field('Date', date), field('Units', units),
        field(`Price per unit (${x.currency})`, price), field(`Fees (${x.currency})`, fees)),
      h('button', { type: 'submit', class: 'fin-btn btn-primary fin-btn-sm' }, `Add to ${x.symbol}`)));
}

function holdingsSection(account) {
  const list = state.holdings.filter((x) => x.accountId === account.id);
  const picker = symbolPicker();
  const qty = input({ type: 'number', step: 'any', min: '0', required: true, inputmode: 'decimal' });
  const symField = field('Stock, ETF or fund', picker.box);
  // field() wraps the bare input; swap in the combobox wrapper and its description.
  symField.replaceChild(picker.el, picker.box);
  picker.el.prepend(picker.box);
  symField.append(picker.note);
  const error = h('p', { class: 'fin-error', role: 'alert' });
  // Something no provider lists (a pension fund, a private holding): added by hand, with a price you
  // type and update yourself. Its name is the one typed in the search box.
  const byHand = h('div', { class: 'fin-grid fin-by-hand', hidden: true });
  const handCode = input({ type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '12', placeholder: 'Optional' });
  const handCur = select(CURRENCIES.map((c) => [c, c]), account.currency);
  const handPrice = input({ type: 'number', step: 'any', min: '0', inputmode: 'decimal' });
  byHand.append(field('Short name', handCode, 'Shown in lists. Defaults to the name.'), field('Currency', handCur), field('Price per unit', handPrice));
  let manualMode = false;
  const toggle = h('button', { type: 'button', class: 'fin-link', 'aria-expanded': 'false', 'data-key': 'hold-by-hand' });
  const setManual = (on, focus = true) => {
    manualMode = on;
    byHand.hidden = !on;
    handPrice.required = on;
    toggle.setAttribute('aria-expanded', String(on));
    toggle.textContent = on ? 'Search for a listing instead' : 'Not listed? Add it by hand';
    symField.querySelector('label').textContent = on ? 'Name' : 'Stock, ETF or fund';
    picker.box.placeholder = on ? 'e.g. My pension fund' : 'Ticker, name or fund ISIN, e.g. VWCE, Apple or LU0109981661';
    error.textContent = '';
    if (focus) (on && picker.box.value.trim() ? handPrice : picker.box).focus();
  };
  toggle.addEventListener('click', () => setManual(!manualMode));
  setManual(false, false);
  return h('section', { class: 'fin-card', 'aria-labelledby': 'hold-h' },
    h('div', { class: 'fin-card-head' },
      h('h3', { id: 'hold-h', class: 'fin-label' }, 'Holdings ', h('span', { class: 'fin-count' }, String(list.length))),
      list.some((x) => !x.manual) && button('Refresh prices', () => refreshPrices(list.filter((x) => !x.manual)), 'secondary', { 'data-key': 'refresh-prices' })),
    list.some((x) => !x.manual && alphaVantageCovers(x.mic)) && !state.settings.avApiKey && h('p', { class: 'fin-notice fin-notice-in' },
      'Non-US listings are priced through Alpha Vantage. Add its free API key in Settings.'),
    list.some((x) => !x.manual && !alphaVantageCovers(x.mic)) && !state.settings.quoteApiKey && h('p', { class: 'fin-notice fin-notice-in' },
      'US listings are priced through Twelve Data. Add its free API key in Settings.'),
    (() => {
      const times = list.map((x) => x.priceAt).filter(Boolean).sort();
      return times.length > 0 && h('p', { class: 'fin-hint fin-pad-x' },
        `Prices as of ${new Date(times[0]).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`);
    })(),
    list.length === 0
      ? h('p', { class: 'fin-empty fin-pad' }, 'No holdings yet.')
      : h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
        h('caption', { class: 'fin-sr' }, 'Holdings'),
        h('thead', {}, h('tr', {},
          ['Symbol', 'Name', 'Exchange', 'Units', 'Price', 'Value', 'Cost', 'Gain'].map((t, i) => h('th', { scope: 'col', class: i > 2 ? 'fin-r' : null }, t)),
          h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
        h('tbody', {}, list.flatMap((x) => {
          const v = holdingValue(x);
          const own = lotsOfHolding(x.id);
          const sum = own.length ? lotSummary(own) : null;
          const gain = sum && v != null ? v - sum.cost : null;
          const open = openLotsId === x.id;
          const charted = openChartId === x.id;
          const row = h('tr', {},
            h('td', {}, x.symbol),
            h('td', {}, x.name ?? '', x.priceError && h('span', { class: 'fin-sub fin-row-error' },
              `No live price: ${x.priceError.replace(/\s*Consider upgrading.*$/i, '')} Enter the price by hand for now.`)),
            h('td', { class: 'fin-muted' }, x.exchange ?? (x.mic ? '' : 'not set')),
            h('td', { class: 'fin-r fin-num' }, shownQty(x.quantity)),
            h('td', { class: 'fin-r fin-num' }, priceCell(x)),
            h('td', { class: 'fin-r fin-num' }, v == null ? '—' : money(v, x.currency)),
            h('td', { class: 'fin-r fin-num fin-muted' }, sum ? money(sum.cost, x.currency) : '—',
              sum?.avgPrice != null && h('span', { class: 'fin-sub' }, `avg ${money(Math.round(sum.avgPrice * 100), x.currency)}`)),
            h('td', { class: `fin-r fin-num ${gain == null ? '' : tone(gain)}` }, gain == null ? '—' : signed(gain, x.currency),
              gain != null && sum.cost > 0 && h('span', { class: 'fin-sub' }, `${gain >= 0 ? '+' : ''}${num((gain / sum.cost) * 100)}%`)),
            h('td', { class: 'fin-r' }, h('div', { class: 'fin-row-actions fin-row-actions--keep' },
              iconButton('edit', `Edit ${x.symbol}`, () => openHoldingDialog(x), { 'data-key': `hold-edit-${x.id}` }),
              button('Chart', () => { openChartId = charted ? null : x.id; render(`chart-${x.id}`); },
                'secondary fin-btn-sm', { 'aria-expanded': String(charted), 'data-key': `chart-${x.id}`, 'aria-label': `Chart of ${x.symbol}` }),
              button(own.length ? `Lots (${own.length})` : 'Add lots', () => { openLotsId = open ? null : x.id; render(`lots-${x.id}`); },
                'secondary fin-btn-sm', { 'aria-expanded': String(open), 'data-key': `lots-${x.id}` }),
              iconButton('trash', `Remove ${x.symbol}`, () => undoable(`${x.symbol} removed${own.length ? ` with its ${own.length} buys and sells` : ''}.`, ['holdings', 'lots'], () => {
                state.holdings = state.holdings.filter((y) => y.id !== x.id);
                state.lots = state.lots.filter((l) => l.holdingId !== x.id);
              }), { danger: true }))));
          return [row,
            charted && h('tr', { class: 'fin-edit-row' }, h('td', { colspan: 9 }, holdingChartPanel(x))),
            open && h('tr', { class: 'fin-edit-row' }, h('td', { colspan: 9 }, lotsPanel(x)))];
        })))),
    h('form', {
      class: 'fin-tx-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (manualMode) {
          const name = picker.box.value.trim();
          if (!name) { error.textContent = 'Give it a name.'; picker.box.focus(); return; }
          const holding = {
            id: newId(), accountId: account.id, symbol: handCode.value.trim() || name, mic: null, exchange: 'By hand',
            name, currency: handCur.value, quantity: Number(qty.value), price: Number(handPrice.value),
            manual: true, priceAt: new Date().toISOString(),
          };
          state.holdings.push(holding);
          persist(); render();
          say(`Added ${name}. Update its price in the holdings list whenever you like.`);
          return;
        }
        const r = picker.picked();
        if (!r) { error.textContent = 'Choose a listing from the search results, or add it by hand.'; picker.box.focus(); return; }
        const holding = {
          id: newId(), accountId: account.id, symbol: r.symbol, mic: r.mic, exchange: r.exchange,
          name: r.name, currency: r.currency, quantity: Number(qty.value), price: null,
        };
        state.holdings.push(holding);
        persist(); render();
        say(`Added ${r.symbol} on ${r.exchange}.`);
        await refreshPrices([holding]);
      },
    },
      h('div', { class: 'fin-grid fin-grid-hold' }, symField, field('Quantity', qty)),
      byHand,
      error,
      h('div', { class: 'fin-actions' },
        h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Add holding'),
        toggle)));
}

// ── IOUs ─────────────────────────────────────────────────────────────────────

const personName = (id) => state.people.find((p) => p.id === id)?.name ?? 'Someone';
// What a balance means, from your side.
const owesText = (minor) => (minor > 0 ? 'owes you' : minor < 0 ? 'you owe' : 'settled');

// Lend, get paid back, borrow or pay back. With an account, the money also moves there as a
// transaction linked to the entry; without one (cash, or outside your accounts) only the IOU changes.
function openIouDialog(preset = {}) {
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

function deleteIou(e) {
  const linked = e.transactionId && state.transactions.find((t) => t.id === e.transactionId);
  undoable(linked ? `Entry deleted, with its ${accountName(linked.accountId)} transaction.` : 'Entry deleted.', ['ious', 'transactions'], () => {
    state.ious = state.ious.filter((x) => x.id !== e.id);
    if (linked) state.transactions = state.transactions.filter((t) => t.id !== linked.id);
  });
}

function renderIous() {
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
            onclick: () => { view = { name: 'ious', personId: p.id }; render('person-h'); },
          },
            h('span', { class: 'fin-row-name' }, p.name),
            h('span', { class: `fin-num ${bal > 0 ? 'fin-pos' : bal < 0 ? 'fin-neg' : 'fin-muted'}` },
              bal ? `${owesText(bal)} ${money(Math.abs(bal), 'EUR')}` : 'settled')));
        }))));
}

function renderPerson(personId) {
  const p = state.people.find((x) => x.id === personId);
  const rows = personHistory(personId, state.ious);
  const bal = rows[0]?.balance ?? 0;
  const back = () => { view = { name: 'ious' }; render(`person-${personId}`); };
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
          persist(); view = { name: 'ious' }; render('iou-add'); say(`Deleted ${p.name}.`);
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

// ── insights ─────────────────────────────────────────────────────────────────

let insightsPeriod = readPref('finance:period', { preset: 'this-month' });
const compactEUR = (minor) => (hideAmounts ? '•••'
  : new Intl.NumberFormat(numLocale(), { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100));

function bucketLabel(key, unit, multiYear) {
  if (unit === 'year') return key;
  if (unit === 'month') {
    return new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, multiYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
  }
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const bucketTitle = (key, unit) =>
  unit === 'week' ? `Week of ${shortDate(key)}` : unit === 'month' ? monthLabel(key) : unit === 'year' ? key : shortDate(key);

// Period picker: presets plus a custom range. Remembered on this device.
function periodControls(range) {
  const preset = select(Object.entries(PERIODS), insightsPeriod.preset, { 'data-key': 'period' });
  preset.addEventListener('change', () => {
    insightsPeriod = { ...insightsPeriod, preset: preset.value, from: range.from, to: range.to };
    writePref('finance:period', insightsPeriod);
    render('period');
  });
  const custom = insightsPeriod.preset === 'custom';
  const dateIn = (key) => {
    const el = input({ type: 'date', value: range[key], 'data-key': `period-${key}` });
    el.addEventListener('change', () => {
      if (!el.value) return;
      insightsPeriod = { ...insightsPeriod, [key]: el.value };
      writePref('finance:period', insightsPeriod);
      render(`period-${key}`);
    });
    return el;
  };
  return h('div', { class: 'fin-period' },
    field('Period', preset),
    custom && field('From', dateIn('from')),
    custom && field('To', dateIn('to')),
    h('p', { class: 'fin-period-range' }, `${shortDate(range.from)} – ${shortDate(range.to)}${range.from.slice(0, 4) !== range.to.slice(0, 4) || range.to.slice(0, 4) != thisYear ? ` ${range.to.slice(0, 4)}` : ''}`));
}

// Income and spending per bucket as paired columns. One y-axis from 0; a readout above the plot
// shows the hovered or focused bucket, and the same numbers are in the table below the chart.
function incomeSpendChart(r) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const W = 760; const H = 230; const L = 52; const R = 8; const T = 10; const B = 26;
  const plotW = W - L - R; const plotH = H - T - B;
  const series = r.series;
  const top = Math.max(1, ...series.map((b) => Math.max(b.income, b.expenses)));
  // A clean top tick: 1, 2, 2.5 or 5 times a power of ten.
  const mag = 10 ** Math.floor(Math.log10(top));
  const niceTop = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= top);
  const y = (v) => T + plotH - (Math.max(0, v) / niceTop) * plotH;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fin-chart', role: 'group', 'aria-label': `Income and spending by ${r.unit}` });

  for (let i = 0; i <= 4; i += 1) {
    const v = (niceTop / 4) * i;
    svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: i ? 'fin-grid-line' : 'fin-axis-line' }));
    const label = el('text', { x: L - 8, y: y(v) + 4, class: 'fin-tick', 'text-anchor': 'end' });
    label.textContent = compactEUR(v);
    svg.append(label);
  }

  const slot = plotW / series.length;
  const barW = Math.max(2, Math.min(24, (slot - 8) / 2 - 1));
  const every = Math.ceil(series.length / 12); // at most ~12 x labels
  const chartWrap = h('div', { class: 'fin-chart-wrap' }, svg);
  const tip = chartTip(chartWrap, svg);
  const multiYear = r.from.slice(0, 4) !== r.to.slice(0, 4);
  const readout = h('p', { class: 'fin-readout', 'aria-live': 'polite' });
  const showTotal = () => {
    readout.replaceChildren(h('span', { class: 'fin-muted' }, 'Hover or focus a column for its numbers.'));
  };
  const bar = (x, v, cls) => {
    const y0 = T + plotH;
    const yv = y(v);
    const hgt = y0 - yv;
    if (hgt < 0.5) return null;
    const rr = Math.min(4, barW / 2, hgt);
    // Rounded at the data end, square on the baseline.
    return el('path', { class: cls, d: `M${x},${y0}V${yv + rr}Q${x},${yv} ${x + rr},${yv}H${x + barW - rr}Q${x + barW},${yv} ${x + barW},${yv + rr}V${y0}Z` });
  };

  series.forEach((b, i) => {
    const cx = L + slot * i + slot / 2;
    const g = el('g', { class: 'fin-col' });
    const hit = el('rect', {
      x: L + slot * i, y: T, width: slot, height: plotH, class: 'fin-hit', tabindex: '0',
      'aria-label': `${bucketTitle(b.key, r.unit)}: income ${money(b.income, 'EUR')}, spending ${money(b.expenses, 'EUR')}`,
    });
    g.append(hit);
    const inBar = bar(cx - barW - 1, b.income, 'fin-mark-in');
    const outBar = bar(cx + 1, b.expenses, 'fin-mark-out');
    if (inBar) g.append(inBar);
    if (outBar) g.append(outBar);
    const info = () => [
      h('strong', {}, bucketTitle(b.key, r.unit)), ' ',
      h('span', { class: 'fin-key fin-key-in' }), h('strong', { class: 'fin-num' }, money(b.income, 'EUR')), ' income ',
      h('span', { class: 'fin-key fin-key-out' }), h('strong', { class: 'fin-num' }, money(b.expenses, 'EUR')), ' spent',
      h('span', { class: 'fin-muted' }, ` · net ${signed(b.income - b.expenses, 'EUR')}`)];
    const show = () => {
      svg.querySelectorAll('.fin-col.is-active').forEach((n) => n.classList.remove('is-active'));
      g.classList.add('is-active');
      readout.replaceChildren(...info());
      tip.show(info(), cx / W, y(Math.max(b.income, b.expenses)) / H);
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', () => tip.hide());
    svg.append(g);
    if (i % every === 0) {
      const t = el('text', { x: cx, y: H - 8, class: 'fin-tick', 'text-anchor': 'middle' });
      t.textContent = bucketLabel(b.key, r.unit, multiYear);
      svg.append(t);
    }
  });
  svg.addEventListener('pointerleave', () => {
    svg.querySelectorAll('.fin-col.is-active').forEach((n) => n.classList.remove('is-active'));
    showTotal();
    tip.hide();
  });
  showTotal();

  const table = h('details', { class: 'fin-chart-table' },
    h('summary', {}, 'Show as a table'),
    h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
      h('caption', { class: 'fin-sr' }, `Income and spending by ${r.unit}`),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, r.unit[0].toUpperCase() + r.unit.slice(1)),
        h('th', { scope: 'col', class: 'fin-r' }, 'Income'), h('th', { scope: 'col', class: 'fin-r' }, 'Spending'), h('th', { scope: 'col', class: 'fin-r' }, 'Net'))),
      h('tbody', {}, series.map((b) => h('tr', {},
        h('th', { scope: 'row' }, bucketTitle(b.key, r.unit)),
        h('td', { class: 'fin-r fin-num' }, money(b.income, 'EUR')),
        h('td', { class: 'fin-r fin-num' }, money(b.expenses, 'EUR')),
        h('td', { class: `fin-r fin-num ${tone(b.income - b.expenses)}` }, signed(b.income - b.expenses, 'EUR'))))))));

  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'chart-h' },
    h('div', { class: 'fin-chart-head' },
      h('h3', { id: 'chart-h', class: 'fin-label' }, `Income and spending by ${r.unit}`),
      h('ul', { class: 'fin-legend', 'aria-label': 'Legend' },
        h('li', {}, h('span', { class: 'fin-key fin-key-in' }), 'Income'),
        h('li', {}, h('span', { class: 'fin-key fin-key-out' }), 'Spending'))),
    readout,
    chartWrap,
    table);
}

// A donut: `slices` ({ label, amount, slot }: slot 0–6 or 'other' picks the colour) around the total.
// Hover or focus a slice to read it in the middle (and in a tooltip beside it).
const DONUT_SLOTS = 7;
function donutChart(title, slices, total, { share }) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const S = 220; const C = S / 2; const RO = 104; const RI = 70;
  const svg = el('svg', { viewBox: `0 0 ${S} ${S}`, class: 'fin-donut', role: 'group', 'aria-label': `${title}: ${slices.length} slices` });
  const centre = el('text', { x: C, y: C - 4, class: 'fin-donut-value', 'text-anchor': 'middle' });
  const caption = el('text', { x: C, y: C + 18, class: 'fin-donut-label', 'text-anchor': 'middle' });
  const wrap = h('div', { class: 'fin-donut-wrap' }, svg);
  const tip = chartTip(wrap, svg);
  const showTotal = () => { centre.textContent = money(total, 'EUR'); caption.textContent = 'Total'; tip.hide(); };
  const sum = slices.reduce((x, sl) => x + sl.amount, 0);
  const pt = (r, a) => `${(C + r * Math.sin(a)).toFixed(2)},${(C - r * Math.cos(a)).toFixed(2)}`;
  let a0 = 0;
  for (const sl of slices) {
    const a1 = a0 + Math.min((sl.amount / sum) * 2 * Math.PI, 2 * Math.PI - 1e-4);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const path = el('path', {
      class: 'fin-slice', 'data-slot': sl.slot, tabindex: '0',
      d: `M${pt(RO, a0)}A${RO},${RO} 0 ${large} 1 ${pt(RO, a1)}L${pt(RI, a1)}A${RI},${RI} 0 ${large} 0 ${pt(RI, a0)}Z`,
      'aria-label': `${sl.label}: ${money(sl.amount, 'EUR')}, ${share(sl.amount)}`,
    });
    // The middle fits about 20 characters; the tooltip and the list beside it have the full name.
    const short = sl.label.length > 16 ? `${sl.label.slice(0, 15)}…` : sl.label;
    const mid = (a0 + a1) / 2;
    const show = () => {
      centre.textContent = money(sl.amount, 'EUR');
      caption.textContent = `${short} · ${share(sl.amount)}`;
      tip.show([h('strong', {}, sl.label), ' ', h('span', { class: 'fin-num' }, money(sl.amount, 'EUR')), ` · ${share(sl.amount)}`],
        (C + RO * Math.sin(mid)) / S, (C - RO * Math.cos(mid)) / S);
    };
    path.addEventListener('pointerenter', show);
    path.addEventListener('focus', show);
    path.addEventListener('pointerleave', showTotal);
    path.addEventListener('blur', showTotal);
    svg.append(path);
    a0 = a1;
  }
  showTotal();
  svg.append(centre, caption);
  return wrap;
}

// Spending (or income) per top-level category, largest first, each opening onto its subcategories.
// A donut of the top-level categories (the biggest seven, the rest as Other) with the total in the
// middle, over the list of every category with its amount and share; a category with subcategories
// opens to show them. Slice colours go by rank (validated categorical palette); each list row
// carries the same colour as a dot.
function categoryBreakdown(title, rows, total) {
  const name = (id) => (id === REFUNDS_UNMATCHED ? 'Refunds with no expense category'
    : id === DIVIDENDS ? 'Dividends'
      : id ? catLabel(id) || 'Deleted category' : 'Uncategorised');
  const share = (amount) => (total > 0 ? `${Math.round((amount / total) * 100)}%` : '');
  const positive = rows.filter((c) => c.amount > 0);
  const slices = positive.slice(0, DONUT_SLOTS).map((c, i) => ({ label: name(c.id), amount: c.amount, slot: String(i) }));
  const rest = positive.slice(DONUT_SLOTS).reduce((sum, c) => sum + c.amount, 0);
  if (rest > 0) slices.push({ label: 'Other', amount: rest, slot: 'other' });
  const slotOf = (id) => {
    const i = positive.findIndex((c) => c.id === id);
    return i < 0 ? null : i < DONUT_SLOTS ? String(i) : 'other';
  };
  const dot = (slot) => h('span', { class: 'fin-dot', 'data-slot': slot ?? 'none', 'aria-hidden': 'true' });
  const line = (id, amount, child = false) => h('div', { class: `fin-break-row fin-break-row--dot${child ? ' fin-break-child' : ''}` },
    child ? h('span', { 'aria-hidden': 'true' }) : dot(slotOf(id)),
    h('span', { class: 'fin-break-name' }, child ? (category(id)?.name ?? name(id)) : name(id)),
    h('span', { class: 'fin-num fin-break-amt' }, money(amount, 'EUR')),
    h('span', { class: 'fin-num fin-break-pct fin-muted' }, share(amount)));
  return h('section', { class: 'fin-card fin-pad', 'aria-label': title },
    h('h3', { class: 'fin-label' }, title),
    rows.length === 0 ? h('p', { class: 'fin-empty' }, 'Nothing in this period.') : [
      slices.length > 0 && donutChart(title, slices, total, { share }),
      h('ul', { class: 'fin-break' }, rows.map((c) => h('li', {},
        c.children.length
          ? h('details', {},
            h('summary', {}, line(c.id, c.amount)),
            h('div', { class: 'fin-break-children' }, c.children.map((k) => line(k.id, k.amount, true)),
              c.amount - c.children.reduce((x, k) => x + k.amount, 0) !== 0 &&
                line(null, c.amount - c.children.reduce((x, k) => x + k.amount, 0), true)))
          : line(c.id, c.amount)))),
    ]);
}

// What investments are made of today: a donut by holding (the biggest seven, the rest as Other) or
// by currency, over the list with each one's value and share. `holdings` can span several accounts.
let allocationBy = 'holding'; // or 'currency'; kept while the page is open
function allocationCard(holdings, key) {
  const rateOf = (c) => latestRate(c) ?? 1;
  const priced = holdings.map((x) => ({ x, value: convert(holdingValue(x) ?? 0, rateOf(x.currency)) })).filter((r) => r.value > 0);
  if (!priced.length) return null;
  const groups = new Map();
  for (const { x, value } of priced) {
    const id = allocationBy === 'currency' ? x.currency : x.id;
    const g = groups.get(id) ?? { id, label: allocationBy === 'currency' ? x.currency : x.symbol, sub: allocationBy === 'currency' ? '' : x.name ?? '', amount: 0, n: 0 };
    g.amount += value;
    g.n += 1;
    groups.set(id, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.amount - a.amount);
  if (allocationBy === 'currency') rows.forEach((g) => { g.sub = `${g.n} holding${g.n === 1 ? '' : 's'}`; });
  const total = rows.reduce((sum, g) => sum + g.amount, 0);
  const share = (amount) => (total > 0 ? `${Math.round((amount / total) * 100)}%` : '');
  const slices = rows.slice(0, DONUT_SLOTS).map((g, i) => ({ label: g.sub && allocationBy === 'holding' ? `${g.label} · ${g.sub}` : g.label, amount: g.amount, slot: String(i) }));
  const rest = rows.slice(DONUT_SLOTS).reduce((sum, g) => sum + g.amount, 0);
  if (rest > 0) slices.push({ label: 'Other', amount: rest, slot: 'other' });
  const pick = (by) => { allocationBy = by; render(`alloc-${key}-${by}`); };
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': `alloc-${key}-h` },
    h('div', { class: 'fin-chart-head' },
      h('h3', { id: `alloc-${key}-h`, class: 'fin-label' }, 'Allocation today'),
      h('div', { class: 'fin-tabs fin-tabs-sm', role: 'group', 'aria-label': 'Allocation by' },
        [['holding', 'By holding'], ['currency', 'By currency']].map(([by, label]) => h('button', {
          type: 'button', class: 'fin-tab', 'aria-pressed': String(allocationBy === by), 'data-key': `alloc-${key}-${by}`, onclick: () => pick(by),
        }, label)))),
    donutChart(`Allocation ${allocationBy === 'currency' ? 'by currency' : 'by holding'}`, slices, total, { share }),
    h('ul', { class: 'fin-break' }, rows.map((g, i) => h('li', {},
      h('div', { class: 'fin-break-row fin-break-row--dot' },
        h('span', { class: 'fin-dot', 'data-slot': i < DONUT_SLOTS ? String(i) : 'other', 'aria-hidden': 'true' }),
        h('span', { class: 'fin-break-name' }, g.label, g.sub && h('span', { class: 'fin-sub' }, g.sub)),
        h('span', { class: 'fin-num fin-break-amt' }, money(g.amount, 'EUR')),
        h('span', { class: 'fin-num fin-break-pct fin-muted' }, share(g.amount)))))),
    h('p', { class: 'fin-hint' }, 'At today’s prices, in EUR. Holdings without a price are left out.'));
}

// The whole Insights panel for some accounts (a Set of ids) or all of them (null).
// Answers from the database's insight functions, by question, kept until something they depend on
// is saved. `ask` returns undefined while one is on its way, and draws again when it arrives.
const answers = new Map();
function ask(name, args) {
  const key = `${name}:${JSON.stringify(args)}`;
  const hit = answers.get(key);
  if (hit) return hit.value;
  const entry = {};
  answers.set(key, entry);
  rpc(name, args)
    .then((value) => { entry.value = value; renderWhenIdle(); })
    .catch((err) => { answers.delete(key); say(`Couldn’t load Insights: ${err.message}`); });
  return undefined;
}
// Insights for a period (see model.js insightsFrom), or undefined while the database works it out.
function insightsFor(range, accountIds, onlyCategory = null) {
  const totals = ask('insight_totals', {
    p_from: range.from, p_to: range.to, p_accounts: accountIds ? [...accountIds] : null, p_only: onlyCategory, p_rates: ratesArg(),
  });
  return totals && insightsFrom(totals, { ...range, categories: state.categories });
}

// `spendingOnly` (credit cards): just spending, no income, net or savings. `balanceOf` (an account's
// own tab): its balance over the period, after the cards and before the other charts.
function insightsPanel(accountIds, { spendingOnly = false, balanceOf = null } = {}) {
  // "All time" starts at the first transaction of these accounts (from the account totals).
  const firsts = state.accounts.filter((a) => !accountIds || accountIds.has(a.id)).map((a) => totalsOf(a.id).first).filter(Boolean);
  const first = firsts.reduce((min, d) => (d < min ? d : min), today());
  const range = periodRange(insightsPeriod.preset, today(), { from: insightsPeriod.from, to: insightsPeriod.to, first });
  if (range.from > range.to) [range.from, range.to] = [range.to, range.from];
  // The same length of time just before, to compare with (this year → last year).
  const prevRange = previousRange(range);
  const whole = completeMonths(range.from, range.to, today());
  const r = insightsFor(range, accountIds);
  const p = insightsFor(prevRange, accountIds);
  const avgR = whole && whole.months >= 2 ? insightsFor(whole, accountIds) : null;
  if (!r || !p || avgR === undefined) {
    return h('div', { class: 'fin-insights' }, periodControls(range), loader('Working out Insights…'));
  }
  const rate = r.savingsRate == null ? '—' : `${Math.round(r.savingsRate * 100)}%`;
  const vs = (now, before) => h('p', { class: 'fin-stat-note' }, versus(now, before, prevRange));
  const avg = avgR ? {
    months: whole.months,
    r: avgR,
    note: `over ${whole.months} months, ${monthLabel(whole.from.slice(0, 7))} – ${monthLabel(whole.to.slice(0, 7))}`,
  } : null;
  return h('div', { class: 'fin-insights' },
    periodControls(range),
    h('dl', { class: 'fin-stats' },
      !spendingOnly && h('div', {}, h('dt', {}, 'Income'), h('dd', { class: 'fin-pos' }, money(r.income, 'EUR')), vs(r.income, p.income)),
      h('div', {}, h('dt', {}, 'Spending'), h('dd', { class: 'fin-neg' }, money(r.expenses, 'EUR')),
        vs(r.expenses, p.expenses),
        r.refunds > 0 && h('p', { class: 'fin-stat-note' }, `after ${money(r.refunds, 'EUR')} of refunds`)),
      !spendingOnly && h('div', {}, h('dt', {}, 'Net'), h('dd', { class: tone(r.net) }, signed(r.net, 'EUR')),
        h('p', { class: 'fin-stat-note' }, `${signed(p.net, 'EUR')} the ${prevLabel(prevRange)}`)),
      !spendingOnly && h('div', {}, h('dt', {}, 'Saved'), h('dd', {}, rate),
        h('p', { class: 'fin-stat-note' }, 'of income')),
      // Averages over the whole months of the period that have ended (not this month, still going).
      avg && h('div', {}, h('dt', {}, 'Average spending a month'), h('dd', { class: 'fin-neg' }, money(Math.round(avg.r.expenses / avg.months), 'EUR')),
        h('p', { class: 'fin-stat-note' }, avg.note)),
      avg && !spendingOnly && h('div', {}, h('dt', {}, 'Average income a month'), h('dd', { class: 'fin-pos' }, money(Math.round(avg.r.income / avg.months), 'EUR')),
        h('p', { class: 'fin-stat-note' }, avg.note))),
    // An account's own tab: its balance over the period, first of the charts.
    balanceOf && balanceChart(balanceOf, range),
    r.count === 0
      ? h('p', { class: 'fin-notice' }, spendingOnly
        ? 'No spending in this period. Payments to the card are transfers, so they don’t count.'
        : 'No income or spending in this period. Transfers between your accounts don’t count.')
      : [
        spendingOnly
          ? h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'spend-time-h' },
            h('div', { class: 'fin-chart-head' }, h('h3', { id: 'spend-time-h', class: 'fin-label' }, `Spending by ${r.unit}`)),
            singleColumns(r.series.map((b) => ({ key: b.key, value: b.expenses })), r.unit, range, 'Spending'))
          : incomeSpendChart(r),
        h('div', { class: 'fin-break-grid' },
          categoryBreakdown('Spending by category', r.spending, r.expenses),
          !spendingOnly && categoryBreakdown('Income by category', r.earning, r.income)),
        categoryOverTime(range, prevRange, accountIds, r),
      ],
    h('p', { class: 'fin-hint fin-mt' }, 'Transfers between your accounts and opening balances aren’t counted. Loans and repayments count only what isn’t owed back, refunds lower spending (in their first category that isn’t an income one, like a salary), and a transaction with several categories counts under its first one.'));
}

// An account's balance over a period, in its own currency, at the end of each day, week or month
// (from the database's balances_at), up to today.
function balanceChart(account, range) {
  const to = range.to > today() ? today() : range.to;
  const { ends } = historyPoints(range.from, to);
  if (ends.length < 2) return null;
  const runs = ask('balances_at', { p_dates: ends.map((e) => e.date), p_accounts: [account.id], p_native: true });
  if (!runs) return h('section', { class: 'fin-card' }, loader('Working out the balance…'));
  const values = runMap(runs).get(account.id)?.values ?? [];
  return h('section', { class: 'fin-card fin-pad' }, timeChart(ends.map((e, i) => ({ date: e.date, v: Number(values[i] ?? 0) })), {
    id: `bal-${account.id}`, title: 'Balance', unit: `in ${account.currency}`, format: (v) => money(v, account.currency), wide: true,
  }));
}

// The period of the same length just before `range`.
function previousRange({ from, to }) {
  const day = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
  return { from: day(from, -days), to: day(from, -1) };
}
const prevLabel = ({ from, to }) => `${shortDate(from)} ${from.slice(0, 4)} – ${shortDate(to)} ${to.slice(0, 4)}`;
// "+12% vs 1 Jan 2025 – 31 Dec 2025", "new", or "same as …".
function versus(now, before, prevRange) {
  if (!before) return now ? `nothing in ${prevLabel(prevRange)}` : '';
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  return pct === 0 ? `same as ${prevLabel(prevRange)}` : `${pct > 0 ? '+' : ''}${pct}% vs ${prevLabel(prevRange)}`;
}

// One category's spending over the period (and its total against the previous period). Defaults to
// the biggest spending category; the choice is kept while the page is open.
let insightsCategory = null;
function categoryOverTime(range, prevRange, accountIds, r) {
  const options = catOptions();
  const id = options.some(([x]) => x === insightsCategory) ? insightsCategory : r.spending.find((c) => c.id)?.id ?? options[0]?.[0];
  if (!id) return null;
  const now = insightsFor(range, accountIds, id);
  const before = insightsFor(prevRange, accountIds, id);
  if (!now || !before) return h('section', { class: 'fin-card' }, loader('Working out the category over time…'));
  const pick = select(options, id, { 'data-key': 'cat-time', 'aria-label': 'Category' });
  pick.addEventListener('change', () => { insightsCategory = pick.value; render('cat-time'); });
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'cat-time-h' },
    h('div', { class: 'fin-chart-head' },
      h('h3', { id: 'cat-time-h', class: 'fin-label' }, `Spending on a category, by ${now.unit}`),
      h('div', { class: 'fin-cat-time-pick' }, pick)),
    h('p', { class: 'fin-readout' },
      h('strong', { class: 'fin-num' }, money(now.expenses, 'EUR')), ` on ${catLabel(id)} · `,
      h('span', { class: 'fin-muted' }, versus(now.expenses, before.expenses, prevRange))),
    singleColumns(now.series.map((b) => ({ key: b.key, value: b.expenses })), now.unit, range, `Spending on ${catLabel(id)}`));
}

// One series as columns from a zero baseline (no legend: the heading names it). Hover or focus a
// column for its value; the table under it has every value.
function singleColumns(series, unit, range, label) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const W = 760; const H = 200; const L = 52; const R = 8; const T = 10; const B = 26;
  const plotW = W - L - R; const plotH = H - T - B;
  const top = Math.max(1, ...series.map((b) => b.value));
  const mag = 10 ** Math.floor(Math.log10(top));
  const niceTop = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= top);
  const y = (v) => T + plotH - (Math.max(0, v) / niceTop) * plotH;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fin-chart', role: 'group', 'aria-label': `${label}, by ${unit}` });
  for (let i = 0; i <= 4; i += 1) {
    const v = (niceTop / 4) * i;
    svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: i ? 'fin-grid-line' : 'fin-axis-line' }));
    const t = el('text', { x: L - 8, y: y(v) + 4, class: 'fin-tick', 'text-anchor': 'end' });
    t.textContent = compactEUR(v);
    svg.append(t);
  }
  const slot = plotW / series.length;
  const barW = Math.max(2, Math.min(24, slot - 6));
  const every = Math.ceil(series.length / 12);
  const multiYear = range.from.slice(0, 4) !== range.to.slice(0, 4);
  const readout = h('p', { class: 'fin-readout fin-muted', 'aria-live': 'polite' }, 'Hover or focus a column for its value.');
  const chartWrap = h('div', { class: 'fin-chart-wrap' }, svg);
  const tip = chartTip(chartWrap, svg);
  svg.addEventListener('pointerleave', () => tip.hide());
  series.forEach((b, i) => {
    const cx = L + slot * i + slot / 2;
    const g = el('g', { class: 'fin-col' });
    const hit = el('rect', { x: L + slot * i, y: T, width: slot, height: plotH, class: 'fin-hit', tabindex: '0', 'aria-label': `${bucketTitle(b.key, unit)}: ${money(b.value, 'EUR')}` });
    g.append(hit);
    const y0 = T + plotH;
    const yv = y(b.value);
    if (y0 - yv >= 0.5) {
      const rr = Math.min(4, barW / 2, y0 - yv);
      const x = cx - barW / 2;
      g.append(el('path', { class: 'fin-mark-out', d: `M${x},${y0}V${yv + rr}Q${x},${yv} ${x + rr},${yv}H${x + barW - rr}Q${x + barW},${yv} ${x + barW},${yv + rr}V${y0}Z` }));
    }
    const info = () => [h('strong', {}, bucketTitle(b.key, unit)), ' ', h('strong', { class: 'fin-num' }, money(b.value, 'EUR'))];
    const show = () => {
      svg.querySelectorAll('.fin-col.is-active').forEach((n) => n.classList.remove('is-active'));
      g.classList.add('is-active');
      readout.replaceChildren(...info());
      tip.show(info(), cx / W, yv / H);
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', () => tip.hide());
    svg.append(g);
    if (i % every === 0) {
      const t = el('text', { x: cx, y: H - 8, class: 'fin-tick', 'text-anchor': 'middle' });
      t.textContent = bucketLabel(b.key, unit, multiYear);
      svg.append(t);
    }
  });
  return [
    readout,
    chartWrap,
    h('details', { class: 'fin-chart-table' },
      h('summary', {}, 'Show as a table'),
      h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
        h('caption', { class: 'fin-sr' }, `${label}, by ${unit}`),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, unit[0].toUpperCase() + unit.slice(1)), h('th', { scope: 'col', class: 'fin-r' }, 'Spending'))),
        h('tbody', {}, series.map((b) => h('tr', {},
          h('th', { scope: 'row' }, bucketTitle(b.key, unit)),
          h('td', { class: 'fin-r fin-num' }, money(b.value, 'EUR')))))))),
  ];
}

// Insights across all accounts, in two tabs sharing the period: income and spending, and net worth.
function renderInsights() {
  const worth = view.tab === 'networth';
  const pick = (t) => { view = { name: 'insights', ...(t === 'networth' && { tab: 'networth' }) }; render(`ins-tab-${t}`); };
  return h('div', {},
    h('div', { class: 'fin-account-head' },
      h('div', {}, h('h2', { class: 'fin-title', id: 'insights-h', tabindex: '-1' }, 'Insights'),
        h('p', { class: 'fin-meta' }, worth
          ? 'Everything you own minus what you owe, across all accounts, in EUR.'
          : 'Income and spending across all your accounts, archived ones included.'))),
    h('div', { class: 'fin-tabs', role: 'group', 'aria-label': 'Insights view' },
      [['spending', 'Income and spending'], ['networth', 'Net worth']].map(([t, label]) => h('button', {
        type: 'button', class: 'fin-tab', 'aria-pressed': String(worth === (t === 'networth')), 'data-key': `ins-tab-${t}`, onclick: () => pick(t),
      }, label))),
    worth ? renderNetWorth() : insightsPanel(null));
}

// ── net worth over time ──────────────────────────────────────────────────────

// An investment account's market value today in EUR, or null when it has no holdings.
function holdingsValueEUR(a) {
  if (!state.holdings.some((x) => x.accountId === a.id)) return null;
  return convert(accountValue(a), latestRate(a.currency) ?? 1);
}

// Once a day, keep what each investment account is worth at market prices, so the net-worth
// history shows real values from today on instead of what was put in.
function recordSnapshot() {
  if (missingTables().includes('snapshots')) return;
  const values = {};
  for (const a of state.accounts) {
    if (a.type !== 'investment' || a.archived) continue;
    const v = holdingsValueEUR(a);
    if (v != null) values[a.id] = v;
  }
  if (!Object.keys(values).length) return;
  const existing = state.snapshots.find((x) => x.date === today());
  if (existing && JSON.stringify(existing.values) === JSON.stringify(values)) return;
  if (existing) existing.values = values;
  else state.snapshots.push({ id: today(), date: today(), values });
  persist();
}


// Transactions a view needs beyond the page's own, fetched once per page (`filter` is a PostgREST
// filter, e.g. '&kind=eq.dividend'). Whether they're here yet; draws again when they arrive.
const fetchedSets = new Map(); // key → 'loading' | 'done'
function transactionsLoaded(key, filter) {
  if (transactionsComplete() || fetchedSets.get(key) === 'done') return true;
  if (!fetchedSets.has(key)) {
    fetchedSets.set(key, 'loading');
    fetchTransactions(() => selectAll('transactions', 'id', filter))
      .then(() => { fetchedSets.set(key, 'done'); renderWhenIdle(); })
      .catch((err) => { fetchedSets.delete(key); say(`Couldn’t load the transactions: ${err.message}`); });
  }
  return false;
}

// A transaction in EUR, at its own rate (today's while it has none).
const inEur = (t) => convert(t.amount, t.rate ?? latestRate(state.accounts.find((a) => a.id === t.accountId)?.currency ?? 'EUR') ?? 1);
// Net worth history estimates investments without buys and sells from what was put in (model.js).
const estimateOpts = { paidIn: (a) => convert(totalsOf(a.id).balance, latestRate(a.currency) ?? 1), first: (a) => totalsOf(a.id).first };

// "+7.2% a year", or the plain return when it's under a year; with a note on what it covers.
function returnText(sum) {
  if (sum.annual != null) return { text: `${sum.annual >= 0 ? '+' : ''}${num(sum.annual * 100)}% a year`, value: sum.annual };
  if (sum.simple != null) return { text: `${sum.simple >= 0 ? '+' : ''}${num(sum.simple * 100)}%`, value: sum.simple, short: true };
  return null;
}

// Insights for an investment account: its value against what was put in, over the period, its
// annual return and dividends, and each holding's value, cost, gain, dividends and return today.
function investmentInsights(account) {
  const own = state.holdings.filter((x) => x.accountId === account.id);
  const ownLots = state.lots.filter((l) => own.some((x) => x.id === l.holdingId));
  const first = [totalsOf(account.id).first, ...ownLots.map((l) => l.date)].filter(Boolean)
    .reduce((min, d) => (d < min ? d : min), today());
  const range = periodRange(insightsPeriod.preset, today(), { from: insightsPeriod.from, to: insightsPeriod.to, first });
  if (range.from > range.to) [range.from, range.to] = [range.to, range.from];
  const to = range.to > today() ? today() : range.to;
  const rateOf = (c) => latestRate(c) ?? 1;
  // The account's totals at each point from the database: all of it, and without opening balances
  // (what was put in).
  const dates = historyPoints(range.from, to).ends.map((e) => e.date);
  const runs = ask('balances_at', { p_dates: dates, p_rates: ratesArg(), p_accounts: [account.id] });
  const paidIn = ask('balances_at', { p_dates: dates, p_rates: ratesArg(), p_accounts: [account.id], p_skip_opening: true });
  const byLots = own.length > 0 && own.every((x) => lotsOfHolding(x.id).length);
  // Dividends anywhere (they may land in another account), and this account's own transactions
  // when its return comes from the money moved in.
  const dividendsReady = transactionsLoaded('dividends', '&kind=eq.dividend');
  const movesReady = byLots || transactionsLoaded(`account:${account.id}`, `&account_id=eq.${encodeURIComponent(account.id)}`);
  if (!runs || !paidIn || !dividendsReady || !movesReady) return h('div', { class: 'fin-insights' }, periodControls(range), loader('Working out the history…'));
  const hist = netWorthHistory({ ...state, accounts: [account] }, { from: range.from, to, today: today(), holdingsValue: holdingsValueEUR, rateOf, runs: runMap(runs), estimate: estimateOpts });
  const invested = investedHistory(account, state, dates, rateOf, runMap(paidIn).get(account.id) ?? { values: [] });
  const pts = hist.points.map((p, i) => ({ key: p.key, date: p.date, total: p.total, investments: invested[i] }));
  const now = pts.at(-1);
  const gain = now.total - now.investments;
  const change = now.total - pts[0].total;

  // Dividends: paid by its holdings (wherever they landed) or into this account.
  const ownIds = new Set(own.map((x) => x.id));
  const dividends = state.transactions.filter((t) => t.kind === 'dividend' && t.date <= today() && (ownIds.has(t.holdingId) || t.accountId === account.id));
  const divInRange = dividends.filter((t) => t.date >= range.from && t.date <= to).reduce((sum, t) => sum + inEur(t), 0);
  const divAll = dividends.reduce((sum, t) => sum + inEur(t), 0);
  const divFlows = (list) => list.map((t) => ({ date: t.date, amount: inEur(t) }));

  const rows = own.map((x) => {
    const value = convert(holdingValue(x) ?? 0, rateOf(x.currency));
    const lotsX = lotsOfHolding(x.id);
    const cost = lotsX.length ? convert(lotSummary(lotsX).cost, rateOf(x.currency)) : null;
    const divs = dividends.filter((t) => t.holdingId === x.id);
    // Its return: buys, sells and dividends, with today's value as if sold today.
    const ret = lotsX.length ? returnSummary([
      ...lotFlows(lotsX).map((f) => ({ date: f.date, amount: convert(f.amount, rateOf(x.currency)) })),
      ...divFlows(divs), { date: today(), amount: value },
    ]) : null;
    return { x, value, cost, gain: cost == null ? null : value - cost, dividends: divs.reduce((sum, t) => sum + inEur(t), 0), ret };
  }).sort((a, b) => b.value - a.value);
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  // The account's return: from its holdings' buys and sells when every one has them, otherwise from
  // the money moved in and out of it; dividends and today's value count as money back.
  const flows = byLots
    ? [...own.flatMap((x) => lotFlows(lotsOfHolding(x.id)).map((f) => ({ date: f.date, amount: convert(f.amount, rateOf(x.currency)) }))),
      ...divFlows(dividends), { date: today(), amount: totalValue }]
    : [...state.transactions.filter((t) => t.accountId === account.id && t.date <= today() && t.kind !== 'dividend').map((t) => ({ date: t.date, amount: -inEur(t) })),
      ...divFlows(dividends.filter((t) => t.accountId !== account.id)), { date: today(), amount: convert(accountValue(account), rateOf(account.currency)) }];
  const accountReturn = returnSummary(flows);
  const yearly = returnText(accountReturn);
  const since = flows.map((f) => f.date).sort()[0];

  return h('div', { class: 'fin-insights' },
    periodControls(range),
    h('dl', { class: 'fin-stats' },
      h('div', {}, h('dt', {}, 'Value today'), h('dd', {}, money(now.total, 'EUR'))),
      h('div', {}, h('dt', {}, 'Invested'), h('dd', {}, money(now.investments, 'EUR')),
        h('p', { class: 'fin-stat-note' }, byLots ? 'cost of the units held' : 'money moved into the account')),
      h('div', {}, h('dt', {}, 'Gain'), h('dd', { class: tone(gain) }, signed(gain, 'EUR')),
        now.investments > 0 && h('p', { class: 'fin-stat-note' }, `${gain >= 0 ? '+' : ''}${num((gain / now.investments) * 100)}%`)),
      h('div', {}, h('dt', {}, `Change since ${shortDate(pts[0].date)}${pts[0].date.slice(0, 4) != thisYear ? ` ${pts[0].date.slice(0, 4)}` : ''}`),
        h('dd', { class: tone(change) }, signed(change, 'EUR')),
        h('p', { class: 'fin-stat-note' }, 'value, including new money')),
      // Money-weighted (XIRR): money added late counts for less time. Over everything, not the period.
      yearly && h('div', {}, h('dt', {}, yearly.short ? 'Return' : 'Annual return'),
        h('dd', { class: yearly.value > 0 ? 'fin-pos' : yearly.value < 0 ? 'fin-neg' : '' }, yearly.text),
        h('p', { class: 'fin-stat-note' }, yearly.short
          ? `since ${shortDate(since)}; under a year, so not made yearly`
          : `money-weighted, since ${shortDate(since)} ${since.slice(0, 4)}${dividends.length ? ', with dividends' : ''}`)),
      dividends.length > 0 && h('div', {}, h('dt', {}, 'Dividends'), h('dd', { class: 'fin-pos' }, money(divInRange, 'EUR')),
        h('p', { class: 'fin-stat-note' }, `in this period · ${money(divAll, 'EUR')} in all`))),
    pts.length > 1
      ? h('section', { class: 'fin-card fin-pad' }, timeChart(pts.map((p) => ({ date: p.date, v: p.total })), {
        id: `inv-${account.id}`, title: 'Value over time', unit: 'in EUR', format: (v) => money(v, 'EUR'), wide: true,
        ref: pts.map((p) => ({ date: p.date, v: p.investments })), refLabel: 'Invested',
      }))
      : h('p', { class: 'fin-notice' }, 'Pick a longer period to see the account over time.'),
    h('p', { class: 'fin-hint' },
      'Value is at market prices today and on days the app has recorded (once a day, when you open it). Before that, ',
      byLots
        ? (own.every((x) => latestClose(x)) ? 'it’s the units held then times that week’s closing price.' : 'it’s the units held then times the latest trade price by then; load the price history for real weekly values.')
        : hist.estimated
          ? 'it’s an estimate: the money put in by then, plus today’s gain growing evenly from the first transaction. Adding the buys and sells (Lots, or an FT.com import) gives real values over time.'
          : 'it’s the money put in, as there’s no record of units held; adding the buys and sells (Lots, or an FT.com import) gives real values over time.'),
    byLots && own.some((x) => !latestClose(x)) && h('div', { class: 'fin-actions fin-mt' },
      button(`Load price history (${own.filter((x) => !latestClose(x)).length} holding${own.filter((x) => !latestClose(x)).length === 1 ? '' : 's'})`,
        async (e) => { e.target.disabled = true; e.target.textContent = 'Loading…'; await loadHistory(own.filter((x) => !latestClose(x))); },
        'secondary', { 'data-key': 'load-history' }),
      h('span', { class: 'fin-hint' }, 'One lookup per holding, with your Market data keys. It then updates itself weekly.')),
    rows.length > 0 && h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'inv-h' },
      h('h3', { id: 'inv-h', class: 'fin-label' }, 'Holdings today'),
      h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
        h('caption', { class: 'fin-sr' }, `Holdings of ${account.name}`),
        h('thead', {}, h('tr', {}, ['Holding', 'Units', 'Value', 'Cost', 'Gain', 'Dividends', 'Return', 'Share'].map((t, i) => h('th', { scope: 'col', class: i ? 'fin-r' : null }, t)))),
        h('tbody', {}, rows.map(({ x, value, cost, gain: g, dividends: d, ret }) => {
          const r = ret && returnText(ret);
          return h('tr', {},
            h('td', {}, x.symbol, h('span', { class: 'fin-sub' }, x.name ?? '')),
            h('td', { class: 'fin-r fin-num' }, shownQty(x.quantity)),
            h('td', { class: 'fin-r fin-num' }, money(value, 'EUR')),
            h('td', { class: 'fin-r fin-num fin-muted' }, cost == null ? '—' : money(cost, 'EUR')),
            h('td', { class: `fin-r fin-num ${g == null ? '' : tone(g)}` }, g == null ? '—' : signed(g, 'EUR'),
              g != null && cost > 0 && h('span', { class: 'fin-sub' }, `${g >= 0 ? '+' : ''}${num((g / cost) * 100)}%`)),
            h('td', { class: 'fin-r fin-num' }, d ? money(d, 'EUR') : '—'),
            h('td', { class: `fin-r fin-num ${r ? (r.value > 0 ? 'fin-pos' : r.value < 0 ? 'fin-neg' : '') : ''}` }, r ? r.text : '—',
              r?.short && h('span', { class: 'fin-sub' }, 'under a year')),
            h('td', { class: 'fin-r fin-num fin-muted' }, totalValue ? `${Math.round((value / totalValue) * 100)}%` : ''));
        })))),
      h('p', { class: 'fin-hint' }, 'Return is money-weighted (XIRR) over each holding’s buys, sells and dividends, with today’s value as if sold today. It needs the holding’s buys and sells.')),
    allocationCard(own, account.id));
}

// balances_at's answer as accountRuns gives it: Map(accountId → { last, values }).
const runMap = (obj) => new Map(Object.entries(obj ?? {}));

// The Net worth tab of Insights (without the page's heading).
function renderNetWorth() {
  const first = state.accounts.map((a) => totalsOf(a.id).first).filter(Boolean).reduce((min, d) => (d < min ? d : min), today());
  const range = periodRange(insightsPeriod.preset, today(), { from: insightsPeriod.from, to: insightsPeriod.to, first });
  if (range.from > range.to) [range.from, range.to] = [range.to, range.from];
  const to = range.to > today() ? today() : range.to; // the future has no balances yet
  // Each account's running total at each point comes from the database; investments are valued here.
  const runs = ask('balances_at', { p_dates: historyPoints(range.from, to).ends.map((e) => e.date), p_rates: ratesArg() });
  if (!runs) {
    return h('div', { class: 'fin-insights' }, periodControls(range), loader('Working out the history…'));
  }
  const hist = netWorthHistory({ ...state, accounts: state.accounts.filter(counted) }, {
    from: range.from, to, today: today(), holdingsValue: holdingsValueEUR, rateOf: (c) => latestRate(c) ?? 1, runs: runMap(runs), estimate: estimateOpts,
  });
  const pts = hist.points;
  const now = pts.at(-1);
  const start = pts[0];
  const change = now.total - start.total;

  // Today's split by account type (archived accounts are closed, so they're not part of it).
  const byType = ACCOUNT_TYPES.map((type) => {
    const value = state.accounts.filter((a) => a.type === type && !a.archived && counted(a))
      .reduce((sum, a) => sum + convert(accountValue(a), latestRate(a.currency) ?? 1), 0);
    return { type, value };
  }).filter((x) => x.value !== 0);
  const assets = byType.filter((x) => x.value > 0).reduce((s, x) => s + x.value, 0);
  const debts = byType.filter((x) => x.value < 0).reduce((s, x) => s - x.value, 0);

  return h('div', {},
    h('div', { class: 'fin-insights' },
      periodControls(range),
      h('dl', { class: 'fin-stats' },
        h('div', {}, h('dt', {}, 'Net worth today'), h('dd', {}, money(now.total, 'EUR'))),
        h('div', {}, h('dt', {}, `Change since ${shortDate(start.date)}${start.date.slice(0, 4) != thisYear ? ` ${start.date.slice(0, 4)}` : ''}`),
          h('dd', { class: tone(change) }, signed(change, 'EUR')),
          start.total > 0 && h('p', { class: 'fin-stat-note' }, `${change >= 0 ? '+' : ''}${num((change / start.total) * 100)}%`)),
        h('div', {}, h('dt', {}, 'Investments'), h('dd', {}, money(now.investments, 'EUR')),
          now.total > 0 && h('p', { class: 'fin-stat-note' }, `${Math.round((now.investments / now.total) * 100)}% of net worth`)),
        h('div', {}, h('dt', {}, 'Debts'), h('dd', { class: debts ? 'fin-neg' : '' }, money(debts, 'EUR')),
          h('p', { class: 'fin-stat-note' }, 'credit cards and other negative balances')),
        // Pensions and retirement savings (by their kind) are locked away until later.
        (() => {
          const locked = state.accounts.filter((a) => !a.archived && counted(a) && a.type === 'investment' && LOCKED_KINDS.has(a.investmentKind))
            .reduce((sum, a) => sum + convert(accountValue(a), latestRate(a.currency) ?? 1), 0);
          return locked > 0 && h('div', {}, h('dt', {}, 'Within reach'), h('dd', {}, money(now.total - locked, 'EUR')),
            h('p', { class: 'fin-stat-note' }, `without ${money(locked, 'EUR')} in pensions and retirement savings`));
        })()),
      pts.length > 1
        ? [
          h('section', { class: 'fin-card fin-pad' },
            timeChart(pts.map((p) => ({ date: p.date, v: p.total })), { id: 'nw', title: 'Net worth over time', unit: 'in EUR', format: (v) => money(v, 'EUR'), wide: true })),
          pts.some((p) => p.investments) && h('section', { class: 'fin-card fin-pad' },
            timeChart(pts.map((p) => ({ date: p.date, v: p.investments })), { id: 'nw-inv', title: 'Investments', unit: 'in EUR', format: (v) => money(v, 'EUR'), wide: true })),
        ]
        : h('p', { class: 'fin-notice' }, 'Pick a longer period to see net worth over time.'),
      h('p', { class: 'fin-hint' },
        hist.firstSnapshot
          ? `Investments are at market value from ${shortDate(hist.firstSnapshot)} ${hist.firstSnapshot.slice(0, 4)}, recorded once a day when you open the app. Before that, holdings with buys and sells are valued as the units held times the latest trade price`
          : 'Investments are at market value today. Earlier, holdings with buys and sells are valued as the units held times the latest trade price',
        hist.estimated
          ? '; accounts without them are estimated as what was put in by then plus today’s gain growing evenly from their first transaction.'
          : '; others at what was put in, as there’s no price history.',
        !hist.firstSnapshot && ' From today the app records market values once a day, so the history fills in.',
        ' Closed (archived) accounts count until their last transaction.'),
      h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'nw-type-h' },
        h('h3', { id: 'nw-type-h', class: 'fin-label' }, 'By account type, today'),
        h('ul', { class: 'fin-break' }, byType.map(({ type, value }) => h('li', {},
          h('div', { class: `fin-break-row fin-type-row fin-group--${type}` },
            h('span', { class: 'fin-break-name' }, h('span', { class: 'fin-group-icon' }, icon(`type-${type}`)), ACCOUNT_TYPE_LABELS[type]),
            (() => {
              const NS = 'http://www.w3.org/2000/svg';
              const svg = document.createElementNS(NS, 'svg');
              svg.setAttribute('class', 'fin-hbar');
              svg.setAttribute('aria-hidden', 'true');
              const rect = document.createElementNS(NS, 'rect');
              rect.setAttribute('class', value < 0 ? 'fin-mark-out' : 'fin-mark-net');
              rect.setAttribute('height', '100%');
              rect.setAttribute('rx', '3');
              rect.setAttribute('width', `${Math.max(0.5, (Math.abs(value) / Math.max(1, assets)) * 100)}%`);
              svg.append(rect);
              return svg;
            })(),
            h('span', { class: `fin-num fin-break-amt ${value < 0 ? 'fin-neg' : ''}` }, money(value, 'EUR')),
            h('span', { class: 'fin-num fin-break-pct fin-muted' }, value > 0 && assets ? `${Math.round((value / assets) * 100)}%` : '')))))),
      // Every holding in the open investment accounts.
      allocationCard(state.holdings.filter((x) => state.accounts.some((a) => a.id === x.accountId && !a.archived && counted(a))), 'nw')));
}

// ── scheduled transactions ───────────────────────────────────────────────────

const FORECAST_DAYS = 30;
const daysFromToday = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const scheduleAccounts = (s) => [accountName(s.accountId), s.kind === 'transfer' && accountName(s.toAccountId)].filter(Boolean).join(' → ');

// Enter one due date: add its transaction(s) with that date and move the schedule on.
async function enterScheduled(s, focusKey) {
  const rows = scheduledTransactions(s, s.nextDate, state.accounts);
  const currencyOf = (t) => state.accounts.find((a) => a.id === t.accountId)?.currency ?? 'EUR';
  for (const t of rows) t.rate = await ensureRate(currencyOf(t), t.date);
  // A transfer between currencies arrives converted at that day's rate.
  if (rows.length === 2 && currencyOf(rows[0]) !== currencyOf(rows[1]) && rows[0].rate && rows[1].rate) {
    rows[1].amount = crossConvert(-rows[0].amount, rows[0].rate, rows[1].rate);
  }
  state.transactions.push(...rows);
  Object.assign(s, advanceSchedule(s));
  persist(); render(focusKey);
  say(`Added ${s.description}. Next one on ${shortDate(s.nextDate)}.`);
}

function skipScheduled(s, focusKey) {
  const skipped = s.nextDate;
  Object.assign(s, advanceSchedule(s));
  persist(); render(focusKey);
  say(`Skipped ${s.description} on ${shortDate(skipped)}. Next one on ${shortDate(s.nextDate)}.`);
}

function deleteScheduled(s) {
  undoable(`Stopped “${s.description}”. Transactions already entered are kept.`, ['schedules'], () => {
    state.schedules = state.schedules.filter((x) => x.id !== s.id);
  });
}

const dueLabel = (date) => (date < today() ? 'Overdue' : date === today() ? 'Due today' : null);

// Add a schedule, or edit `existing`. `preset` fills a new one (from the transaction form's Repeat).
function openScheduleDialog(existing = null, preset = {}) {
  const s = existing ?? preset;
  const accounts = pickableAccounts(s.accountId);
  const accountOptions = accounts.map((a) => [a.id, accountLabel(a)]);
  const kind = select([['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']], s.kind ?? 'expense');
  const desc = input({ type: 'text', required: true, autocomplete: 'off', value: s.description });
  const amount = input({ type: 'number', step: '0.01', min: '0.01', required: true, inputmode: 'decimal', value: s.amount ? String(s.amount / 100) : null });
  const from = select(accountOptions, s.accountId ?? view.id ?? accounts[0]?.id);
  const to = select([['', 'Choose an account'], ...accountOptions], s.toAccountId ?? '');
  // Several categories, like a transaction (chips, and a menu to add one).
  const cats = categoryPicker(categoriesOf(s), { label: 'Categories' });
  const every = input({ type: 'number', min: '1', step: '1', required: true, value: String(s.every ?? 1), inputmode: 'numeric' });
  const unit = select(UNITS.map((u) => [u, `${u}(s)`]), s.unit ?? 'month');
  const next = input({ type: 'date', required: true, value: s.nextDate ?? today() });
  const end = input({ type: 'date', value: s.endDate ?? null });
  // Marked as a subscription: listed under Scheduled → Subscriptions (expenses only).
  const subBox = h('input', { type: 'checkbox', checked: Boolean(s.subscription) });
  const subField = h('label', { class: 'fin-check' }, subBox, ' This is a subscription');
  const fromField = field('Account', from);
  const toField = field('To account', to);
  const catField = pickerField('Categories', cats);
  const sync = () => {
    const transfer = kind.value === 'transfer';
    fromField.querySelector('label').textContent = transfer ? 'From account' : 'Account';
    toField.hidden = !transfer;
    to.required = transfer;
    catField.hidden = transfer;
    subField.hidden = kind.value !== 'expense';
  };
  kind.addEventListener('change', sync);
  sync();
  const returnKey = existing ? `sched-edit-${existing.id}` : document.activeElement?.dataset?.key;
  const close = () => { dialog.close(); render(returnKey); };
  const error = h('p', { class: 'fin-error', role: 'alert' });

  dialog.replaceChildren(h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      if (kind.value === 'transfer' && (!to.value || to.value === from.value)) { error.textContent = 'Pick a different account to transfer to.'; to.focus(); return; }
      const fields = {
        description: desc.value.trim(), amount: toMinor(amount.value), kind: kind.value,
        accountId: from.value, toAccountId: kind.value === 'transfer' ? to.value : null,
        categoryIds: kind.value === 'transfer' ? [] : cats.value(), categoryId: undefined,
        every: Math.max(1, Math.round(Number(every.value))), unit: unit.value,
        anchorDay: Number(next.value.slice(8, 10)), nextDate: next.value, endDate: end.value || null,
        subscription: kind.value === 'expense' && subBox.checked,
      };
      if (existing) Object.assign(existing, fields);
      else state.schedules.push({ id: newId(), ...fields });
      persist(); close();
      say(existing ? 'Schedule saved.' : `Scheduled ${fields.description}, ${frequencyLabel(fields).toLowerCase()}, next on ${shortDate(fields.nextDate)}.`);
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, existing ? 'Edit schedule' : 'Schedule a transaction'),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Type', kind), field('Description', desc), field('Amount', amount),
      fromField, toField,
      catField,
      h('div', { class: 'fin-field' },
        h('span', { class: 'fin-field-label', id: 'sched-every-l' }, 'Repeats every'),
        h('div', { class: 'fin-inline', role: 'group', 'aria-labelledby': 'sched-every-l' },
          every, unit)),
      field('Next date', next), field('Ends on', end, 'Optional. Leave empty to repeat until you stop it.')),
    subField,
    error,
    h('div', { class: 'fin-dialog-actions' },
      button('Cancel', close),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, existing ? 'Save' : 'Schedule'))));
  every.setAttribute('aria-label', 'Number');
  unit.setAttribute('aria-label', 'Unit');
  dialog.showModal();
  desc.focus();
}

// What's coming for one account, as greyed rows above its transactions: the schedules falling within
// the forecast window, and transactions already added with a later date (they count once it comes).
// Newest first like the list, each with the balance it would leave; `cols` matches the table's.
function upcomingRows(account, { cols, inEur, balance }) {
  const until = daysFromToday(FORECAST_DAYS);
  const items = [
    ...state.schedules
      .filter((s) => scheduledEffect(s, account.id) !== 0)
      .flatMap((s) => occurrences(s, until).map((date, i) => ({ s, date, first: i === 0, amount: scheduledEffect(s, account.id) }))),
    ...plannedTransactions(account.id, state.transactions, today()).map((t) => ({ t, date: t.date, amount: t.amount })),
    // A card's statement payment: into the card, out of the account it's paid from.
    ...cardPayments().flatMap((p) => [
      p.card.id === account.id && { pay: p, date: p.date, amount: p.amount },
      p.from?.id === account.id && { pay: p, date: p.date, amount: -inCurrency(p.amount, p.card.currency, account.currency) },
    ]).filter(Boolean),
  ].sort((a, b) => a.date.localeCompare(b.date));
  if (!items.length) return [];
  let running = balance;
  for (const it of items) it.balance = (running += it.amount);
  const cur = account.currency;
  const dateCell = (date, chip) => h('td', { class: 'fin-nowrap c-date' }, h('time', { datetime: date }, shortDate(date)),
    date.slice(0, 4) != thisYear && ` ${date.slice(0, 4)}`, chip);
  const amountCell = (amount, refund) => h('td', { class: `fin-r fin-num c-amt ${tone(amount)}` },
    refund && h('span', { class: 'fin-refund', title: 'Refund' }, icon('refund'), h('span', { class: 'fin-sr' }, 'Refund: ')),
    signed(amount, cur));
  const balanceCell = (b) => h('td', { class: 'fin-r fin-num fin-muted c-bal' }, money(b, cur));

  const scheduleRow = ({ s, date, first, amount, balance: b }) => {
    const due = dueLabel(date);
    return h('tr', { class: `fin-upcoming${due ? ' fin-due' : ''}` },
      h('td', { class: 'fin-tick-col c-tick' }),
      dateCell(date, h('span', { class: `fin-chip fin-chip-inline${due ? ' fin-chip-due' : ''}` }, due ?? 'Scheduled')),
      amountCell(amount),
      balanceCell(b),
      h('td', { class: 'c-desc' }, s.description, h('span', { class: 'fin-sub' },
        `${frequencyLabel(s)}${s.kind === 'transfer' ? ` · ${scheduleAccounts(s)}` : ''}`)),
      // A transfer shows where it goes (or comes from), like an entered one; anything else its
      // categories as chips (changed in the schedule, not here).
      h('td', { class: 'c-cat' }, s.kind === 'transfer'
        ? h('span', { class: 'fin-tag fin-tag--transfer' }, amount < 0 ? 'To ' : 'From ', ...accountBadge(amount < 0 ? s.toAccountId : s.accountId))
        : catChips(categoriesOf(s))),
      inEur && h('td', { class: 'c-eur' }),
      // Only the next date of a schedule can be entered or skipped; later ones follow from it.
      h('td', { class: 'fin-r c-act' }, first && h('div', { class: 'fin-actions fin-row-actions fin-upcoming-actions' },
        button('Enter', () => enterScheduled(s, `up-enter-${s.id}`), 'secondary fin-btn-sm',
          { 'aria-label': `Enter ${s.description} for ${shortDate(date)}`, 'data-key': `up-enter-${s.id}` }),
        button('Skip', () => skipScheduled(s, `up-skip-${s.id}`), 'secondary fin-btn-sm',
          { 'aria-label': `Skip ${s.description} on ${shortDate(date)}`, 'data-key': `up-skip-${s.id}` }))));
  };
  // A card's statement payment, with Pay (a transfer from the account it's paid from, today).
  const payRow = ({ pay, date, amount, balance: b }) => {
    const due = dueLabel(date);
    const toCard = pay.card.id === account.id;
    return h('tr', { class: `fin-upcoming${due ? ' fin-due' : ''}` },
      h('td', { class: 'fin-tick-col c-tick' }),
      dateCell(date, h('span', { class: `fin-chip fin-chip-inline${due ? ' fin-chip-due' : ''}` }, due ?? 'Payment due')),
      amountCell(amount),
      balanceCell(b),
      h('td', { class: 'c-desc' }, `${pay.card.name} payment`, h('span', { class: 'fin-sub' },
        `Statement of ${shortDate(pay.st.close)}${toCard ? (pay.from ? ` · from ${pay.from.name}` : ' · paid from: not set') : ''}`)),
      h('td', { class: 'c-cat' }, h('span', { class: 'fin-tag fin-tag--transfer' }, ...(toCard ? ['From ', ...(pay.from ? accountBadge(pay.from.id) : ['…'])] : ['To ', ...accountBadge(pay.card.id)]))),
      inEur && h('td', { class: 'c-eur' }),
      h('td', { class: 'fin-r c-act' }, h('div', { class: 'fin-actions fin-row-actions fin-upcoming-actions' },
        button(pay.from ? 'Pay' : 'Set up', () => payCard(pay), 'secondary fin-btn-sm',
          { 'aria-label': pay.from ? `Pay ${money(pay.amount, pay.card.currency)} to ${pay.card.name} from ${pay.from.name}` : `Set the account ${pay.card.name} is paid from` }))));
  };
  // A transaction added ahead of time: already saved, so it's edited or deleted like any other.
  const plannedRow = ({ t, balance: b }) => {
    if (t.id === editingTxId) return h('tr', { class: 'fin-edit-row' }, h('td', { colspan: cols }, transactionForm(account, t)));
    const label = `${t.description}, ${shortDate(t.date)}`;
    return h('tr', { class: 'fin-upcoming' },
      h('td', { class: 'fin-tick-col c-tick' }),
      dateCell(t.date),
      amountCell(t.amount, t.kind === 'refund'),
      balanceCell(b),
      h('td', { class: 'c-desc' }, t.description, t.memo && h('span', { class: 'fin-sub' }, t.memo)),
      h('td', { class: 'c-cat' }, categoryCell(t)),
      inEur && h('td', { class: 'c-eur' }),
      h('td', { class: 'fin-r c-act' }, h('div', { class: 'fin-row-actions' },
        iconButton('edit', `Edit ${label}`, () => { editingTxId = t.id; render('tx-desc-edit'); }, { 'data-key': `tx-edit-${t.id}` }),
        iconButton('trash', `Delete ${label}`, () => deleteTransactions(new Set([t.id])), { danger: true }))));
  };
  // The heading folds the rows away (remembered in this browser, for every account); folded, it
  // still says how many there are and what they add up to.
  const net = items.reduce((sum, it) => sum + it.amount, 0);
  const toggle = () => {
    upcomingOpen = !upcomingOpen;
    writePref('finance:upcoming-open', upcomingOpen);
    render('upcoming-toggle');
    say(upcomingOpen ? 'Upcoming transactions shown.' : 'Upcoming transactions folded away.');
  };
  return [
    h('tr', { class: 'fin-month fin-upcoming-head' }, h('th', { colspan: cols, scope: 'colgroup' },
      h('button', {
        type: 'button', class: 'fin-upcoming-toggle', 'aria-expanded': String(upcomingOpen), 'data-key': 'upcoming-toggle', onclick: toggle,
      },
        h('span', { class: 'fin-upcoming-chevron', 'aria-hidden': 'true' }),
        'Upcoming ', h('span', { class: 'fin-count' }, String(items.length)),
        h('span', { class: 'fin-upcoming-note' }, upcomingOpen
          ? ` · scheduled for the next ${FORECAST_DAYS} days`
          : [` · next ${FORECAST_DAYS} days, `, h('span', { class: `fin-num ${tone(net)}` }, signed(net, cur)), ' in all'])))),
    ...(upcomingOpen ? items.reverse().map((it) => (it.t ? plannedRow(it) : it.pay ? payRow(it) : scheduleRow(it))) : []),
  ];
}
let upcomingOpen = readPref('finance:upcoming-open', true);

// Payments that look recurring but have no schedule yet (model.js suggestSchedules), from the
// database's groups of repeated descriptions over the last 13 months. undefined while it's asked.
function scheduleSuggestions() {
  const groups = ask('recurring_candidates', { p_since: daysFromToday(-400), p_today: today() });
  if (!groups) return undefined;
  return suggestSchedules(groups, { schedules: state.schedules, today: today(), hidden: state.settings.hiddenSuggestions ?? [] })
    .filter((x) => state.accounts.some((a) => a.id === x.accountId && !a.archived));
}

function suggestionsCard() {
  const list = scheduleSuggestions();
  if (list === undefined) return h('section', { class: 'fin-card' }, loader('Looking for payments that repeat…'));
  if (!list.length) return null;
  const hide = (x) => {
    state.settings.hiddenSuggestions = [...(state.settings.hiddenSuggestions ?? []), x.id];
    persist(); render('sched-add');
    say(`“${x.description}” won’t be suggested again.`);
  };
  return h('section', { class: 'fin-card', 'aria-labelledby': 'suggest-h' },
    h('div', { class: 'fin-card-head' },
      h('h3', { id: 'suggest-h', class: 'fin-label' }, 'Looks recurring ', h('span', { class: 'fin-count' }, String(list.length)))),
    h('p', { class: 'fin-hint fin-pad-x' }, 'These came round regularly for about the same amount and have no schedule yet. Schedule one to see it coming, or say it isn’t recurring.'),
    h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
      h('caption', { class: 'fin-sr' }, 'Payments that look recurring'),
      h('thead', {}, h('tr', {}, ['Description', 'Account', 'Amount', 'Repeats', 'Next date'].map((t, i) =>
        h('th', { scope: 'col', class: i === 2 ? 'fin-r' : null }, t)), h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
      h('tbody', {}, list.map((x) => {
        const cur = state.accounts.find((a) => a.id === x.accountId)?.currency ?? 'EUR';
        const shown = x.kind === 'expense' ? -x.amount : x.amount;
        return h('tr', {},
          h('td', {}, x.description, catChips(categoriesOf(x))),
          h('td', {}, accountName(x.accountId)),
          h('td', { class: `fin-r fin-num ${tone(shown)}` }, signed(shown, cur),
            x.typical !== x.amount && h('span', { class: 'fin-sub' }, `usually ${money(x.typical, cur)}`)),
          h('td', {}, frequencyLabel(x), h('span', { class: 'fin-sub' }, `${x.count} times, last on ${shortDate(x.lastDate)}`)),
          h('td', { class: 'fin-nowrap' }, h('time', { datetime: x.nextDate }, shortDate(x.nextDate))),
          h('td', { class: 'fin-r' }, h('div', { class: 'fin-actions fin-row-actions' },
            button('Schedule…', () => openScheduleDialog(null, x), 'secondary fin-btn-sm', { 'aria-label': `Schedule ${x.description}`, 'aria-haspopup': 'dialog' }),
            button('Not recurring', () => hide(x), 'secondary fin-btn-sm', { 'aria-label': `${x.description} isn’t recurring` }))));
      })))));
}

// ── subscriptions ────────────────────────────────────────────────────────────

// Subscriptions found in the payments that repeat (model.js findSubscriptions), over the last three
// years and a bit, in groups of two or more so a yearly plan shows after two charges; plus schedules
// marked as subscriptions. undefined while the database works it out.
function subscriptionsFound() {
  const groups = ask('recurring_candidates', { p_since: daysFromToday(-1200), p_today: today(), p_min: 2 });
  if (!groups) return undefined;
  const found = findSubscriptions(groups, { today: today(), hidden: state.settings.hiddenSuggestions ?? [] });
  return withMarkedSchedules(found, state.schedules, today())
    .filter((x) => state.accounts.some((a) => a.id === x.accountId && !a.archived));
}
const subCurrency = (x) => state.accounts.find((a) => a.id === x.accountId)?.currency ?? 'EUR';
const subEur = (x, minor) => convert(minor, latestRate(subCurrency(x)) ?? 1);

function subscriptionsPanel() {
  const list = subscriptionsFound();
  if (list === undefined) return h('section', { class: 'fin-card' }, loader('Looking for subscriptions…'));
  const active = list.filter((x) => x.status === 'active');
  const stopped = list.filter((x) => x.status === 'stopped');
  const monthly = active.reduce((sum, x) => sum + subEur(x, x.monthly), 0);
  const rises = active.filter((x) => x.priceChange && x.priceChange.to > x.priceChange.from);
  const hiddenCount = (state.settings.hiddenSuggestions ?? []).filter((id) => id.startsWith('sub|')).length;
  // Found ones are hidden; a schedule marked as one is unmarked (and hidden too, if it was also found).
  const hide = (x) => {
    const sc = x.marked && state.schedules.find((y) => y.id === x.scheduleId);
    if (sc) sc.subscription = false;
    if (!x.id.startsWith('sched|')) state.settings.hiddenSuggestions = [...(state.settings.hiddenSuggestions ?? []), x.id];
    persist(); render('sched-add');
    say(`“${x.description}” isn’t treated as a subscription any more.`);
  };
  const name = (x) => h('td', {}, x.description,
    h('span', { class: 'fin-sub' }, [...categoriesOf(x).map(catLabel), accountName(x.accountId)].filter(Boolean).join(' · ')));
  const find = (x) => pageLink('Find', { name: 'search', q: x.description }, 'fin-link fin-link-sm');
  const year = (d) => (d.slice(0, 4) != thisYear ? ` ${d.slice(0, 4)}` : '');
  return h('div', {},
    h('dl', { class: 'fin-stats' },
      h('div', {}, h('dt', {}, 'A month'), h('dd', { class: 'fin-neg' }, money(monthly, 'EUR')),
        h('p', { class: 'fin-stat-note' }, `${active.length} subscription${active.length === 1 ? '' : 's'}, yearly ones spread over 12 months`)),
      h('div', {}, h('dt', {}, 'A year'), h('dd', { class: 'fin-neg' }, money(active.reduce((sum, x) => sum + subEur(x, x.yearly), 0), 'EUR')),
        h('p', { class: 'fin-stat-note' }, 'at today’s prices, in EUR')),
      h('div', {}, h('dt', {}, 'Went up'), h('dd', { class: rises.length ? 'fin-neg' : '' }, String(rises.length)),
        h('p', { class: 'fin-stat-note' }, rises.length
          // Each rise as a monthly cost: the rise's share of the price, of what it costs a month.
          ? `+${money(rises.reduce((sum, x) => sum + subEur(x, Math.round(((x.priceChange.to - x.priceChange.from) / x.amount) * x.monthly)), 0), 'EUR')} a month in all`
          : 'no price rises seen'))),
    h('section', { class: 'fin-card', 'aria-labelledby': 'subs-h' },
      h('div', { class: 'fin-card-head' }, h('h3', { id: 'subs-h', class: 'fin-label' }, 'Active ', h('span', { class: 'fin-count' }, String(active.length)))),
      active.length === 0
        ? h('p', { class: 'fin-empty fin-pad' }, 'No subscriptions found. They show here once one has been charged three times for the same price.')
        : h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table fin-subs' },
          h('caption', { class: 'fin-sr' }, 'Active subscriptions, dearest first'),
          h('thead', {}, h('tr', {}, ['Subscription', 'Price', 'A month', 'Last charged', 'Next'].map((t, i) =>
            h('th', { scope: 'col', class: i === 1 || i === 2 ? 'fin-r' : null }, t)), h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
          h('tbody', {}, active.map((x) => {
            const cur = subCurrency(x);
            const up = x.priceChange && x.priceChange.to > x.priceChange.from;
            return h('tr', {},
              name(x),
              h('td', { class: 'fin-r fin-num' }, money(x.amount, cur), h('span', { class: 'fin-sub' }, frequencyLabel(x).toLowerCase()),
                x.priceChange && h('span', { class: `fin-chip fin-chip-inline ${up ? 'fin-chip-up' : 'fin-chip-down'}` },
                  `${up ? '↑' : '↓'} from ${money(x.priceChange.from, cur)} in ${new Date(`${x.priceChange.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`)),
              h('td', { class: 'fin-r fin-num' }, money(subEur(x, x.monthly), 'EUR')),
              x.lastDate
                ? h('td', { class: 'fin-nowrap' }, h('time', { datetime: x.lastDate }, shortDate(x.lastDate)), year(x.lastDate),
                  h('span', { class: 'fin-sub' }, `${x.count} charges since ${shortDate(x.firstDate)}${year(x.firstDate)}`))
                : h('td', { class: 'fin-muted' }, 'Not seen yet'),
              h('td', { class: 'fin-nowrap' }, h('time', { datetime: x.nextDate }, shortDate(x.nextDate)), year(x.nextDate),
                x.scheduleId && h('span', { class: 'fin-sub' }, x.marked ? 'marked in its schedule' : 'scheduled')),
              h('td', { class: 'fin-r' }, h('div', { class: 'fin-actions fin-row-actions' },
                !x.scheduleId && button('Schedule…', () => openScheduleDialog(null, { ...x, kind: 'expense', subscription: true }), 'secondary fin-btn-sm', { 'aria-label': `Schedule ${x.description}`, 'aria-haspopup': 'dialog' }),
                x.scheduleId && button('Edit schedule', () => openScheduleDialog(state.schedules.find((y) => y.id === x.scheduleId)), 'secondary fin-btn-sm', { 'aria-label': `Edit the schedule of ${x.description}`, 'aria-haspopup': 'dialog' }),
                find(x),
                button('Not a subscription', () => hide(x), 'secondary fin-btn-sm', { 'aria-label': `${x.description} isn’t a subscription` }))));
          }))))),
    stopped.length > 0 && h('section', { class: 'fin-card', 'aria-labelledby': 'subs-stop-h' },
      h('div', { class: 'fin-card-head' }, h('h3', { id: 'subs-stop-h', class: 'fin-label' }, 'Looks cancelled ', h('span', { class: 'fin-count' }, String(stopped.length)))),
      h('p', { class: 'fin-hint fin-pad-x' }, 'These were charged regularly but the last one is well overdue. If you didn’t cancel one, check it’s still being paid.'),
      h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
        h('caption', { class: 'fin-sr' }, 'Subscriptions that look cancelled'),
        h('thead', {}, h('tr', {}, ['Subscription', 'Price', 'Last charged', 'Was due'].map((t, i) =>
          h('th', { scope: 'col', class: i === 1 ? 'fin-r' : null }, t)), h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
        h('tbody', {}, stopped.map((x) => h('tr', {},
          name(x),
          h('td', { class: 'fin-r fin-num' }, money(x.amount, subCurrency(x)), h('span', { class: 'fin-sub' }, frequencyLabel(x).toLowerCase())),
          h('td', { class: 'fin-nowrap' }, x.lastDate ? [h('time', { datetime: x.lastDate }, shortDate(x.lastDate)), year(x.lastDate)] : '—'),
          h('td', { class: 'fin-nowrap' }, h('time', { datetime: x.nextDate }, shortDate(x.nextDate)), year(x.nextDate),
            x.marked && h('span', { class: 'fin-sub' }, 'its schedule has ended')),
          h('td', { class: 'fin-r' }, h('div', { class: 'fin-actions fin-row-actions' },
            find(x),
            button('Not a subscription', () => hide(x), 'secondary fin-btn-sm', { 'aria-label': `${x.description} isn’t a subscription` }))))))))),
    h('p', { class: 'fin-hint fin-mt' }, 'Found in the last three years of payments: something charged at a steady rhythm (weekly, monthly, quarterly or yearly; a yearly one after two charges) for the same price each time, give or take 5% for foreign-currency charges, or with one price change. You can also tick “This is a subscription” on any schedule. Rent or a loan can look like one too; say “Not a subscription” and it won’t show again.',
      hiddenCount > 0 && [' ', h('button', {
        type: 'button', class: 'fin-link fin-link-sm',
        onclick: () => {
          state.settings.hiddenSuggestions = (state.settings.hiddenSuggestions ?? []).filter((id) => !id.startsWith('sub|'));
          persist(); render(); say('Hidden subscriptions are back.');
        },
      }, `Show the ${hiddenCount} you hid`)]));
}

function renderSchedules() {
  const list = [...state.schedules].sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  const subs = view.tab === 'subscriptions';
  const pick = (t) => { view = { name: 'scheduled', ...(t === 'subscriptions' && { tab: t }) }; render(`sched-tab-${t}`); };
  const tabs = h('div', { class: 'fin-tabs', role: 'group', 'aria-label': 'Scheduled view' },
    [['schedules', 'Schedules'], ['subscriptions', 'Subscriptions']].map(([t, label]) => h('button', {
      type: 'button', class: 'fin-tab', 'aria-pressed': String(subs === (t === 'subscriptions')), 'data-key': `sched-tab-${t}`, onclick: () => pick(t),
    }, label)));
  if (subs) {
    return h('div', {},
      h('div', { class: 'fin-account-head' },
        h('div', {}, h('h2', { class: 'fin-title' }, 'Scheduled'),
          h('p', { class: 'fin-meta' }, 'Subscriptions found in your payments: what they cost, price rises, and ones that seem to have stopped.')),
        button('Schedule a transaction', () => openScheduleDialog(), 'primary', { 'data-key': 'sched-add', 'aria-haspopup': 'dialog' })),
      tabs, h('div', { class: 'fin-insights' }, subscriptionsPanel()));
  }
  return h('div', {},
    h('div', { class: 'fin-account-head' },
      h('div', {}, h('h2', { class: 'fin-title' }, 'Scheduled'),
        h('p', { class: 'fin-meta' }, 'Recurring transactions. When one is due it shows on its account, where you enter or skip it.')),
      button('Schedule a transaction', () => openScheduleDialog(), 'primary', { 'data-key': 'sched-add', 'aria-haspopup': 'dialog' })),
    tabs,
    suggestionsCard(),
    h('section', { class: 'fin-card' },
      list.length === 0
        ? h('p', { class: 'fin-empty fin-pad' }, 'Nothing scheduled yet. Add one here, use Repeat when adding a single transaction, or import Buxfer’s reminders.csv.')
        : h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
          h('caption', { class: 'fin-sr' }, 'Scheduled transactions'),
          h('thead', {}, h('tr', {}, ['Next date', 'Description', 'Account', 'Amount', 'Repeats'].map((t, i) =>
            h('th', { scope: 'col', class: i === 3 ? 'fin-r' : null }, t)), h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
          h('tbody', {}, list.map((s) => {
            const due = dueLabel(s.nextDate);
            const cur = state.accounts.find((a) => a.id === s.accountId)?.currency ?? 'EUR';
            const shown = s.kind === 'expense' ? -s.amount : s.amount;
            return h('tr', { class: due ? 'fin-due' : null },
              h('td', { class: 'fin-nowrap' }, h('time', { datetime: s.nextDate }, shortDate(s.nextDate)),
                due && h('span', { class: 'fin-chip fin-chip-inline fin-chip-due' }, due)),
              h('td', {}, s.description, s.subscription && h('span', { class: 'fin-chip fin-chip-inline' }, 'Subscription'),
                catChips(categoriesOf(s))),
              h('td', {}, scheduleAccounts(s)),
              h('td', { class: `fin-r fin-num ${s.kind === 'transfer' ? '' : tone(shown)}` }, s.kind === 'transfer' ? money(s.amount, cur) : signed(shown, cur)),
              h('td', { class: 'fin-nowrap' }, frequencyLabel(s), s.endDate && h('span', { class: 'fin-sub' }, `until ${shortDate(s.endDate)}`)),
              h('td', { class: 'fin-r' }, h('div', { class: 'fin-actions fin-row-actions' },
                due && button('Enter', () => enterScheduled(s, `sched-edit-${s.id}`), 'secondary fin-btn-sm', { 'aria-label': `Enter ${s.description}` }),
                button('Edit', () => openScheduleDialog(s), 'secondary fin-btn-sm', { 'aria-label': `Edit ${s.description}`, 'data-key': `sched-edit-${s.id}` }),
                button('Stop', () => deleteScheduled(s), 'danger fin-btn-sm', { 'aria-label': `Stop ${s.description}` }))));
          }))))));
}

// ── overview ─────────────────────────────────────────────────────────────────

const OVERVIEW_DAYS = 14;
// A link to another page (a view). A plain click goes there the app's way (saving first); Ctrl/⌘-click
// still opens a new tab.
const pageLink = (label, v, cls) => h('a', {
  class: cls, href: urlOf(v),
  onclick: (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    view = v;
    render();
  },
}, label);
// The first page: where things stand, this month's spending against last month's, what's coming in
// the next two weeks, credit cards, and payments that look recurring.
function renderOverview() {
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
      alertsBox(accountAlerts()),
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
      recurringNotice(),
    ]);
}

// Everything due in the next two weeks, across accounts: scheduled dates (with Enter and Skip for
// the next one of each) and transactions already added with a later date. Overdue ones first.
function comingUpCard() {
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
              it.pay && button(it.pay.from ? 'Pay' : 'Set up', () => payCard(it.pay), 'secondary fin-btn-sm',
                { 'aria-label': it.pay.from ? `Pay ${money(it.pay.amount, it.pay.card.currency)} to ${it.pay.card.name}` : `Set the account ${it.pay.card.name} is paid from` }),
              it.s && it.first && it.date <= now && button('Enter', () => enterScheduled(it.s, `ov-enter-${it.s.id}`), 'secondary fin-btn-sm',
                { 'aria-label': `Enter ${name} for ${shortDate(it.date)}`, 'data-key': `ov-enter-${it.s.id}` }),
              it.s && it.first && it.date <= now && button('Skip', () => skipScheduled(it.s, `ov-skip-${it.s.id}`), 'secondary fin-btn-sm',
                { 'aria-label': `Skip ${name} on ${shortDate(it.date)}`, 'data-key': `ov-skip-${it.s.id}` })));
        })));
}

// This month's spending by top-level category, against last month up to the same day.
function monthCategoriesCard(r, p, sameDays) {
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
function creditCardsCard() {
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

// A line pointing to payments that look recurring, when there are any.
function recurringNotice() {
  const list = scheduleSuggestions();
  if (!list?.length) return null;
  return h('p', { class: 'fin-notice' },
    `${list.length} payment${list.length === 1 ? '' : 's'} look${list.length === 1 ? 's' : ''} recurring but ${list.length === 1 ? 'has' : 'have'} no schedule: ${list.slice(0, 3).map((x) => x.description).join(', ')}${list.length > 3 ? '…' : ''}. `,
    pageLink('Review them', { name: 'scheduled' }, 'fin-link'));
}

// ── main: settings ───────────────────────────────────────────────────────────

// Settings are split into pages; while in Settings the left panel lists them instead of the accounts.
const SETTINGS_PAGES = [
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
let settingsPage = 'categories'; // remembered while the page stays open

function settingsPageOf() {
  return SETTINGS_PAGES.find((p) => p.key === (view.section ?? settingsPage)) ?? SETTINGS_PAGES[0];
}

function renderSettings() {
  const page = settingsPageOf();
  return h('div', { class: 'fin-settings-page' },
    h('p', { class: 'fin-meta' }, `Settings · ${page.group}`),
    h('h2', { class: 'fin-title', id: 'settings-h', tabindex: '-1', 'data-key': 'settings-h' }, page.label),
    // Pages that work on every transaction load them the first time they're opened.
    (typeof page.needsAll === 'function' ? page.needsAll() : page.needsAll) && !transactionsComplete()
      ? [page.key === 'import' && importTabs(), needEverything()] : page.render());
}

function renderSettingsNav() {
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

function openSettings(key, focusKey) {
  settingsPage = key;
  view = { name: 'settings', section: key };
  render(focusKey);
  say(`${settingsPageOf().label} settings.`);
}

function accountSection() {
  const email = currentUser()?.email;
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'settings-h' },
    h('p', {}, email ? ['Signed in as ', h('strong', {}, email), '.'] : 'Signed in.'),
    h('p', { class: 'fin-hint' }, 'Your data is saved to your account and loads on any device where you sign in with this email.'),
    h('div', { class: 'fin-actions fin-mt' }, button('Sign out', () => signOutNow(), 'secondary', { 'data-key': 'sign-out' })));
}

function rulesSection() {
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

function marketSection() {
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
function displaySection() {
  const sample = (key) => new Intl.NumberFormat(NUMBER_FORMATS[key].locale, { style: 'currency', currency: 'EUR' }).format(1234567.89);
  const fmt = h('div', { class: 'fin-choices', role: 'radiogroup', 'aria-labelledby': 'fmt-h' },
    Object.entries(NUMBER_FORMATS).map(([key, f]) => h('label', { class: 'fin-choice' },
      h('input', {
        type: 'radio', name: 'number-format', value: key, checked: key === numberFormat, 'data-key': `fmt-${key || 'auto'}`,
        onchange: () => {
          numberFormat = key;
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
function deleteAllSection() {
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
    editingTxId = null; importDraft = null; buxferDraft = null; txPage = 0;
    settingsPage = 'import';
    view = { name: 'settings', section: 'import', kind: 'buxfer' };
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
function linkTransfersSection() {
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

let editingCatId = null;

// Two levels, like Buxfer: a category is top-level or the child of a top-level one.
function categoriesSection() {
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

// ── CSV import and export ────────────────────────────────────────────────────

// The import in progress lives outside the DOM so a re-render (prices arriving, a save finishing)
// doesn't throw away the file and the column choices.
let importDraft = null;

const FIELD_LABELS = {
  date: 'Date', description: 'Description', amount: 'Amount', type: 'Type (expense or income)',
  account: 'Account', category: 'Category', memo: 'Memo', currency: 'Currency',
  reference: 'ID / reference (pairs transfer rows)',
  iou: 'IOU (Buxfer: “Name: 12,50”)',
};

async function readImportFile(file) {
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

const runImport = (id) => importRows(importDraft.body, importDraft, {
  id, accounts: state.accounts, categories: state.categories, rules: state.rules, transactions: state.transactions, people: state.people,
});

// EUR rows need no lookup. Setting their rate before saving keeps a large import to one upload,
// instead of a second one when refreshRates() fills the rates in.
function withEuroRates(transactions, accounts) {
  const eur = new Set(accounts.filter((a) => a.currency === 'EUR').map((a) => a.id));
  for (const t of transactions) if (t.rate == null && eur.has(t.accountId)) t.rate = 1;
}

// A Buxfer export in progress: the parsed files and the preview, kept across re-renders.
let buxferDraft = null;

async function readBuxferFiles(fileList) {
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

const buxferCtx = (id) => ({
  id, today: today(), accounts: state.accounts, categories: state.categories, rules: state.rules,
  transactions: state.transactions, holdings: state.holdings, schedules: state.schedules, people: state.people, lots: state.lots,
});

function previewBuxfer() {
  let n = 0;
  buxferDraft.preview = buxferImport(buxferDraft.files, buxferCtx(() => `preview-${++n}`), { openingBalances: buxferDraft.openingBalances });
}

// ── imports: one page, four kinds ────────────────────────────────────────────

const IMPORT_KINDS = [
  ['csv', 'Transactions (CSV)'], ['buxfer', 'From Buxfer'], ['holdings', 'Holdings'], ['rules', 'Category rules'],
];
const importKind = () => (IMPORT_KINDS.some(([k]) => k === view.kind) ? view.kind : 'csv');
function importTabs() {
  const current = importKind();
  return h('div', { class: 'fin-tabs', role: 'group', 'aria-label': 'What to import' },
    IMPORT_KINDS.map(([k, label]) => h('button', {
      type: 'button', class: 'fin-tab', 'aria-pressed': String(current === k), 'data-key': `imp-${k}`,
      onclick: () => { view = { name: 'settings', section: 'import', kind: k }; render(`imp-${k}`); say(`Import ${label.toLowerCase()}.`); },
    }, label)));
}
function importPage() {
  const kind = importKind();
  return [
    importTabs(),
    kind === 'buxfer' ? buxferSection() : kind === 'holdings' ? ftSection() : kind === 'rules' ? learnRulesSection() : importSection(),
  ];
}

// Category rules learnt from how transactions are already categorized (model.js rulesFromHistory):
// tick the ones to add; they go to the top of the rules, and can fill in uncategorized transactions.
const learnSkipped = new Set(); // suggestions unticked, while the page is open
let learnFill = true;
function learnRulesSection() {
  const list = rulesFromHistory(state.transactions, state.rules);
  const idOf = (r) => `${r.match}|${r.pattern}|${r.categoryId}`;
  const picked = list.filter((r) => !learnSkipped.has(idOf(r)));
  const matchLabel = { contains: 'contains', starts: 'starts with', equals: 'is exactly' };
  const tick = (r) => h('input', {
    type: 'checkbox', class: 'fin-tick', checked: !learnSkipped.has(idOf(r)), 'data-key': `learn-${idOf(r)}`,
    'aria-label': `Add the rule: description ${matchLabel[r.match]} “${r.pattern}” goes in ${catLabel(r.categoryId)}`,
    onchange: (e) => { if (e.target.checked) learnSkipped.delete(idOf(r)); else learnSkipped.add(idOf(r)); render(`learn-${idOf(r)}`); },
  });
  const fills = picked.reduce((sum, r) => sum + r.others, 0);
  const add = () => {
    const fresh = picked.map((r) => ({ id: newId(), pattern: r.pattern, match: r.match, categoryId: r.categoryId }));
    const fill = learnFill ? state.transactions.filter((t) => !t.transferId && !categoriesOf(t).length && categorize(t.description, fresh)) : [];
    const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
    undoable(`${plural(fresh.length, 'rule')} added${fill.length ? `, and ${plural(fill.length, 'transaction')} categorized` : ''}.`, ['rules', 'transactions'], () => {
      // At the top, in the order shown, so they win over broader rules (the first match decides).
      state.rules.unshift(...fresh);
      for (const t of fill) t.categoryIds = [categorize(t.description, fresh)];
    });
  };
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'learn-h' },
    h('h3', { id: 'learn-h', class: 'fin-label' }, 'Category rules from your transactions'),
    h('p', { class: 'fin-hint' }, 'Rules learnt from how you’ve already categorized things: a description seen at least three times that goes in the same category at least 9 times in 10. Where the numbers in a description change (card or reference numbers), the rule looks for the words they share. Rules that would change nothing aren’t listed. Tick the ones you want; they go to the top of your rules, where you can reorder or delete them later.'),
    list.length === 0
      ? h('p', { class: 'fin-empty' }, 'Nothing to learn right now: your rules already cover the descriptions you categorize the same way every time.')
      : [
        h('div', { class: 'fin-actions fin-mb' },
          button('Tick all', () => { learnSkipped.clear(); render('learn-all'); }, 'secondary fin-btn-sm', { 'data-key': 'learn-all' }),
          button('Untick all', () => { list.forEach((r) => learnSkipped.add(idOf(r))); render('learn-none'); }, 'secondary fin-btn-sm', { 'data-key': 'learn-none' })),
        h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
          h('caption', { class: 'fin-sr' }, 'Rules that could be added'),
          h('thead', {}, h('tr', {},
            h('th', { scope: 'col', class: 'fin-tick-col' }, h('span', { class: 'fin-sr' }, 'Add')),
            h('th', { scope: 'col' }, 'If the description'), h('th', { scope: 'col' }, 'Category'),
            h('th', { scope: 'col', class: 'fin-r' }, 'Agrees with'), h('th', { scope: 'col', class: 'fin-r' }, 'Would fill'))),
          h('tbody', {}, list.map((r) => h('tr', { class: learnSkipped.has(idOf(r)) ? null : 'is-selected' },
            h('td', { class: 'fin-tick-col' }, tick(r)),
            h('td', {}, `${matchLabel[r.match]} `, h('strong', {}, `“${r.pattern}”`)),
            h('td', {}, h('span', { class: 'fin-cat-chip', 'data-hue': hueOf(r.categoryId) }, h('span', {}, catLabel(r.categoryId)))),
            h('td', { class: 'fin-r fin-num' }, r.count === r.total ? `all ${r.total}` : `${r.count} of ${r.total}`),
            h('td', { class: 'fin-r fin-num' }, r.others ? `${r.others} uncategorized` : '—')))))),
        h('label', { class: 'fin-check fin-mt' },
          h('input', { type: 'checkbox', checked: learnFill, 'data-key': 'learn-fill', onchange: (e) => { learnFill = e.target.checked; render('learn-fill'); } }),
          ` Also categorize the uncategorized transactions they match${fills ? ` (${fills})` : ''}`),
        h('div', { class: 'fin-actions fin-mt' },
          button(picked.length ? `Add ${picked.length} rule${picked.length === 1 ? '' : 's'}` : 'Add rules', add, 'primary', { disabled: !picked.length, 'data-key': 'learn-add' }),
          pageLink('See your rules ›', { name: 'settings', section: 'rules' }, 'fin-link')),
      ]);
}

function buxferSection() {
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
        if (first) view = { name: 'account', id: first.id };
        persist(); render('bux-file');
        say(`Imported ${res.imported} transactions and ${res.newAccounts.length} accounts from Buxfer. Saving to your account…`);
        await refreshRates(); // USD transactions get the rate of their own date
      }, 'primary', { disabled: !p.imported && !p.newAccounts.length && !p.newHoldings.length && !p.holdingUpdates.length && !p.openings && !p.schedules.length }),
      button('Cancel', () => { buxferDraft = null; render('bux-file'); })));
}

// FT.com portfolio export, or a fund's movements list (a pension fund's "ListagemMovimentos.xls")
// → buys and sells on the holdings of one investment account.
let ftDraft = null;

// Text from a file that may be UTF-16 (what some banks call .xls is tab-separated UTF-16 text).
async function readText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bom16 = bytes[0] === 0xFF && bytes[1] === 0xFE;
  const zeros = bytes.slice(0, 200).filter((b, i) => i % 2 === 1 && b === 0).length;
  return new TextDecoder(bom16 || zeros > 40 ? 'utf-16le' : 'utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

async function readFtFile(file) {
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

function ftSection() {
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
        view = { name: 'account', id: d.accountId };
        render();
        say(`Imported ${res.newLots.length} buys and sells.`);
      }, 'primary', { disabled: !p.newLots.length || !d.accountId }),
      button('Cancel', () => { ftDraft = null; render('ft-file'); })));
}

function importSection() {
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

function download(name, rows) {
  const a = h('a', { href: URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

const decimal2 = (minor) => (minor / 100).toFixed(2);

// Readable CSV tables (names instead of ids), for the Export buttons and inside a backup.
function readableCsvs() {
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

// ── backups ──────────────────────────────────────────────────────────────────

function downloadBytes(name, bytes, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// One .zip with everything: backup.json (restores exactly, links included) and the same data as
// readable CSV files. API keys aren't in it, so the file is safe to keep in cloud storage.
// The backup .zip: { name, bytes }. A backup has every transaction, wherever it's made from (the
// reminder shows on any page), so they're all loaded first.
async function buildBackup() {
  if (!transactionsComplete()) {
    say('Getting all your transactions for the backup…');
    await loadAllTransactions();
  }
  const data = backupData();
  const counts = Object.entries(data.tables).filter(([, rows]) => rows.length).map(([t, rows]) => `${rows.length} ${t}`).join(', ');
  const readme = [
    `Fin backup, ${new Date().toLocaleString()}`,
    '',
    'backup.json holds everything and restores it exactly: open Fin, Settings → Backup and restore → Restore.',
    'The .csv files are the same data to read in Excel, Numbers or Google Sheets.',
    'API keys aren’t included; add them again in Settings → Market data after a restore.',
    '',
    `Contents: ${counts}.`,
  ].join('\r\n');
  const csvs = readableCsvs();
  const bytes = makeZip([
    { name: 'README.txt', data: readme },
    { name: 'backup.json', data: JSON.stringify(data) },
    ...Object.entries(csvs).map(([k, rows]) => ({ name: `${k}.csv`, data: toCsv(rows) })),
  ]);
  return { name: `finance-backup-${today()}.zip`, bytes };
}

async function downloadBackup() {
  let backup;
  try { backup = await buildBackup(); } catch (err) { say(`Couldn’t make the backup: ${err.message}`); return; }
  downloadBytes(backup.name, backup.bytes, 'application/zip');
  state.settings.lastBackupAt = new Date().toISOString();
  persist();
  render();
  say('Backup downloaded. Keep it somewhere safe, like iCloud Drive or Google Drive.');
}

// Backups to Google Drive (drive.js), once connected in this browser: made when Fin opens and one is
// due, or from a button. `interactive`: from a click, so Google may show its window.
let driveBusy = false;
const driveOn = () => driveConfigured() && readPref('finance:drive', false);
async function backupToDrive({ interactive = false } = {}) {
  if (driveBusy) return false;
  driveBusy = true;
  if (interactive) say('Backing up to Google Drive…');
  try {
    const backup = await buildBackup();
    await uploadBackup(backup.name, backup.bytes, { interactive });
    writePref('finance:drive', true);
    state.settings.lastBackupAt = new Date().toISOString();
    persist();
    driveFiles = null;
    renderWhenIdle();
    say(`Backed up to Google Drive, in “Fin backups” (the latest ${DRIVE_KEEP} are kept).`);
    return true;
  } catch (err) {
    // Opening the page: Google wanted to ask something, so the reminder offers the button instead.
    if (interactive) showToast(`Couldn’t back up to Google Drive: ${err.message}`);
    return false;
  } finally {
    driveBusy = false;
  }
}
// The backups in Drive, for the Backup page: null until asked, then a list (or an error message).
let driveFiles = null;
function loadDriveFiles(interactive = false) {
  driveFiles = { loading: true };
  listBackups({ interactive })
    .then((files) => { driveFiles = { files }; renderWhenIdle(); })
    .catch((err) => { driveFiles = { error: err.message }; renderWhenIdle(); });
}

const daysSince = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 864e5);
function backupDue() {
  const every = state.settings.backupEvery ?? 7;
  if (!every || !state.accounts.length) return false;
  const snooze = readPref('finance:backupSnooze', null);
  if (snooze && snooze >= today()) return false;
  return !state.settings.lastBackupAt || daysSince(state.settings.lastBackupAt) >= every;
}

function backupBanner() {
  if (!state || !backupDue()) return null;
  const last = state.settings.lastBackupAt;
  return h('div', { class: 'fin-notice fin-legacy fin-backup-due', role: 'region', 'aria-label': 'Backup reminder' },
    h('p', {}, last
      ? `Your last backup was ${daysSince(last)} days ago. The database keeps no backups of its own, so it’s worth making one.`
      : 'You haven’t made a backup yet. The database keeps no backups of its own, so it’s worth having one.'),
    h('div', { class: 'fin-actions' },
      driveOn() && button('Back up to Google Drive', () => backupToDrive({ interactive: true }), 'primary'),
      button('Download backup', downloadBackup, driveOn() ? 'secondary' : 'primary'),
      button('Remind me tomorrow', () => { writePref('finance:backupSnooze', today()); render(); }, 'secondary')));
}

let restoreDraft = null;
async function readRestoreFile(file) {
  try {
    let text;
    if (/\.zip$/i.test(file.name)) {
      const files = await readZip(new Uint8Array(await file.arrayBuffer()));
      const json = files.get('backup.json');
      if (!json) throw new Error('This ZIP has no backup.json in it');
      text = new TextDecoder().decode(json);
    } else text = await file.text();
    const data = JSON.parse(text);
    if (data?.format !== 'finance-backup' || !data.tables) throw new Error('This isn’t a Fin backup');
    restoreDraft = { name: file.name, data };
    render('restore-confirm');
  } catch (err) {
    say(err.message);
    showToast(`Couldn’t read ${file.name}: ${err.message}`);
  }
}

function backupSection() {
  const last = state.settings.lastBackupAt;
  const every = select([['7', 'Every week'], ['14', 'Every 2 weeks'], ['30', 'Every month'], ['0', 'Never']], String(state.settings.backupEvery ?? 7), { 'data-key': 'backup-every' });
  every.addEventListener('change', () => { state.settings.backupEvery = Number(every.value); persist(); render('backup-every'); say('Saved.'); });
  const file = input({ type: 'file', accept: '.zip,.json,application/zip,application/json', 'data-key': 'restore-file' });
  file.addEventListener('change', () => file.files[0] && readRestoreFile(file.files[0]));

  let restore;
  if (restoreDraft) {
    const d = restoreDraft.data;
    const confirmIn = input({ type: 'text', autocomplete: 'off', spellcheck: 'false', 'data-key': 'restore-confirm' });
    const go = button('Replace everything with this backup', async () => {
      go.disabled = true;
      say('Restoring…');
      try {
        await clearTables(BACKUP_TABLES);
        restoreData(d);
      } catch (err) {
        showToast(`Restore failed: ${err.message}. Try again; the backup file is unchanged.`);
        go.disabled = false;
        return;
      }
      restoreDraft = null;
      txPage = 0; selected.clear(); editingTxId = null;
      const first = [...state.accounts].sort(byName).find((a) => !a.archived);
      view = first ? { name: 'account', id: first.id } : { name: 'settings', section: 'backup' };
      render();
      say(`Restored ${state.transactions.length} transactions and ${state.accounts.length} accounts. Saving to your account…`);
      await refreshRates();
    }, 'danger', { disabled: true });
    confirmIn.addEventListener('input', () => { go.disabled = confirmIn.value.trim() !== 'RESTORE'; });
    const labels = { accounts: 'accounts', transactions: 'transactions', categories: 'categories', rules: 'rules', holdings: 'holdings', lots: 'buys and sells', schedules: 'schedules', people: 'people', ious: 'IOU entries', snapshots: 'daily values' };
    restore = [
      h('p', {}, h('strong', {}, restoreDraft.name), ` · made ${new Date(d.createdAt).toLocaleString()}`),
      h('ul', { class: 'fin-import-list' }, Object.entries(labels).filter(([t]) => d.tables[t]?.length).map(([t, label]) =>
        h('li', {}, `${d.tables[t].length} ${label}`, h('span', { class: 'fin-muted' }, ` (now ${state[t].length})`)))),
      h('p', { class: 'fin-notice' }, 'This replaces everything in your account with the backup. It can’t be undone, so download a backup of what’s there now first if you might want it.'),
      h('div', { class: 'fin-actions fin-mt' },
        button('Download a backup of what’s there now', downloadBackup, 'secondary')),
      h('div', { class: 'fin-grid fin-mt' }, field('Type RESTORE to confirm', confirmIn)),
      h('div', { class: 'fin-actions' }, go, button('Cancel', () => { restoreDraft = null; render('restore-file'); }, 'secondary')),
    ];
  }

  return h('div', {},
    h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'settings-h' },
      h('p', {}, last ? `Last backup: ${new Date(last).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${daysSince(last) === 0 ? 'today' : `${daysSince(last)} days ago`}).` : 'No backup made yet.'),
      h('p', { class: 'fin-hint' }, 'Your data is in your Supabase project, whose free plan keeps no backups. A backup is one .zip file: backup.json restores everything exactly, and the same data comes as readable CSV files. API keys aren’t included. Keep it somewhere safe, like iCloud Drive or Google Drive.'),
      h('div', { class: 'fin-actions fin-mt' }, button('Download backup', downloadBackup, 'primary', { 'data-key': 'backup-now' })),
      h('div', { class: 'fin-grid fin-mt' }, field('Remind me to back up', every, 'A banner appears when a backup is due.'))),
    driveCard(),
    h('section', { class: 'fin-card fin-pad fin-danger-zone', 'aria-labelledby': 'restore-h' },
      h('h3', { id: 'restore-h', class: 'fin-label' }, 'Restore from a backup'),
      restore ?? [
        h('p', { class: 'fin-hint' }, 'Pick a backup .zip (or its backup.json). You’ll see what’s in it before anything changes.'),
        h('div', { class: 'fin-grid' }, field('Backup file', file)),
      ]));
}

// Google Drive: connect once in this browser; then backups go there by themselves when they're due.
function driveCard() {
  const head = h('h3', { id: 'drive-h', class: 'fin-label' }, 'Google Drive');
  if (!driveConfigured()) {
    return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'drive-h' }, head,
      h('p', { class: 'fin-hint' }, 'Fin can back itself up to your Google Drive when a backup is due. It needs a Google OAuth client ID in tools/finance/config.js; the steps are in tools/finance/README.md (Backups).'));
  }
  if (!driveOn()) {
    return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'drive-h' }, head,
      h('p', { class: 'fin-hint' }, `Back up to a “Fin backups” folder in your Google Drive, by itself when a backup is due (as often as set above), keeping the latest ${DRIVE_KEEP}. Fin can only see the files it creates there, nothing else in your Drive. Connect once in each browser you use.`),
      h('div', { class: 'fin-actions' }, button('Connect Google Drive and back up now', async () => {
        if (await backupToDrive({ interactive: true })) loadDriveFiles();
      }, 'primary', { 'data-key': 'drive-connect' })));
  }
  if (!driveFiles) loadDriveFiles();
  const files = driveFiles?.files;
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'drive-h' }, head,
    h('p', { class: 'fin-hint' }, `Connected in this browser. When a backup is due, Fin makes one in “Fin backups” as it opens, keeping the latest ${DRIVE_KEEP}; if Google needs you to confirm, the reminder has a button for it. Synology’s Cloud Sync (or Google Drive on your computer) can keep a copy of that folder elsewhere.`),
    driveFiles?.loading ? loader('Looking in Google Drive…')
      : driveFiles?.error ? h('p', { class: 'fin-hint' }, `Couldn’t list the backups in Drive: ${driveFiles.error} `,
        h('button', { type: 'button', class: 'fin-link fin-link-sm', onclick: () => loadDriveFiles(true) }, 'Try again'))
        : files?.length ? h('ul', { class: 'fin-import-list' }, files.map((f) => h('li', {},
          new Date(f.createdTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
          h('span', { class: 'fin-muted' }, ` · ${f.name}${f.size ? ` · ${num(Number(f.size) / 1048576, 1)} MB` : ''}`))))
          : h('p', { class: 'fin-hint' }, 'No backups in Drive yet.'),
    h('div', { class: 'fin-actions fin-mt' },
      button('Back up to Google Drive now', () => backupToDrive({ interactive: true }), 'primary', { 'data-key': 'drive-now' }),
      button('Disconnect', async () => {
        await driveDisconnect();
        writePref('finance:drive', false);
        driveFiles = null;
        render('drive-connect');
        say('Google Drive disconnected in this browser. The backups already there stay.');
      }, 'secondary')));
}

function exportSection() {
  const stamp = today();
  const csv = () => readableCsvs();
  const labels = { transactions: 'Transactions', accounts: 'Accounts', holdings: 'Holdings', lots: 'Buys and sells', ious: 'IOUs', schedules: 'Scheduled', categories: 'Categories', rules: 'Category rules' };
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'export-h' },
    h('h3', { id: 'export-h', class: 'fin-label' }, 'Export (CSV)'),
    h('p', { class: 'fin-hint' }, 'Opens in Excel, Numbers or Google Sheets. The transactions file can be imported back here. For everything at once, use Backup and restore.'),
    h('div', { class: 'fin-actions' },
      Object.entries(labels).map(([key, label]) => button(label, () => download(`${key}-${stamp}.csv`, csv()[key])))));
}

// ── shell ────────────────────────────────────────────────────────────────────

// Re-rendering replaces the DOM, so keep keyboard focus on the element with the same data-key.
function render(focusKey) {
  // Moving to another main section loads its own page (fresh data, nothing carried over).
  if (pageSection && sectionOf(view) !== pageSection) {
    const target = urlOf(view);
    view = shownView;
    leave(target);
    return;
  }
  const key = focusKey ?? document.activeElement?.dataset?.key;
  totalsCache = null;
  iouByTx = null;
  hueOrder = null;
  const account = view.name === 'account' && state.accounts.find((a) => a.id === view.id);
  if (view.name === 'account' && !account && state.accounts[0]) view = { name: 'account', id: state.accounts[0].id };
  const current = view.name === 'account' && state.accounts.find((a) => a.id === view.id);

  document.querySelectorAll('[data-nav]').forEach((b) => {
    const on = b.dataset.nav === (view.name === 'account' ? 'accounts' : view.name);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const inSettings = view.name === 'settings';
  if (!side.classList.contains('is-open')) sideToggle.textContent = inSettings ? 'Settings menu' : 'Accounts';
  side.setAttribute('aria-label', inSettings ? 'Settings' : 'Accounts');
  side.replaceChildren(...(inSettings ? renderSettingsNav() : renderSide()).flat().filter(Boolean));
  main.replaceChildren(
    needsSchemaUpdate() ? h('p', { class: 'fin-notice fin-legacy', role: 'alert' },
      'This version needs a database update: run tools/finance/schema.sql again in the Supabase SQL editor (it keeps your data), then reload. Until then, changes aren’t saved.') : '',
    legacyBanner() ?? '',
    backupBanner() ?? '',
    view.name === 'settings' ? renderSettings()
      : view.name === 'overview' ? renderOverview()
      : view.name === 'scheduled' ? renderSchedules()
        : view.name === 'ious' ? renderIous()
          : view.name === 'search' ? renderSearch()
          : view.name === 'insights' ? renderInsights()
        : current ? renderAccount(current) : renderWelcome());
  // The address follows what's shown (an account, a settings page…), so reloading stays there.
  shownView = view;
  const url = urlOf(view);
  if (url !== location.pathname + location.search) history.replaceState(null, '', url);
  if (key) {
    const el = document.querySelector(`[data-key="${key}"]`);
    el?.focus();
    // A text box that was being typed in keeps its cursor at the end of what's there.
    if (el && ['text', 'search'].includes(el.type) && el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
  }
}

// Data from the earlier browser-only version: offer to move it into the account once.
function legacyBanner() {
  const old = legacyData();
  if (!old) return null;
  return h('div', { class: 'fin-notice fin-legacy', role: 'region', 'aria-label': 'Data in this browser' },
    h('p', {}, `This browser still has data from before sign-in: ${old.accounts?.length ?? 0} accounts and ${old.transactions?.length ?? 0} transactions.`),
    h('div', { class: 'fin-actions' },
      button('Move it to my account', async () => {
        // Add what isn't there yet, by id, so moving twice never duplicates anything.
        for (const t of ['categories', 'accounts', 'rules', 'holdings', 'transactions']) {
          const have = new Set(state[t].map((x) => x.id));
          state[t].push(...(old[t] ?? []).filter((x) => !have.has(x.id)));
        }
        state.settings.quoteApiKey ||= old.settings?.quoteApiKey ?? '';
        state.settings.avApiKey ||= old.settings?.avApiKey ?? '';
        forgetLegacyData();
        persist(); render();
        say('Moved. Your data is now saved to your account.');
        await refreshRates();
      }, 'primary'),
      button('Discard it', () => {
        if (!confirm('Delete the data stored in this browser? Your account is not affected.')) return;
        forgetLegacyData(); render(); say('Browser data discarded.');
      }, 'danger')));
}

// ── start-up: setup check, sign-in, load ─────────────────────────────────────

const syncEl = document.getElementById('sync');
const layout = document.querySelector('.fin-layout');

// Before sign-in only the main column shows; the account panel and the header controls appear after.
function setShell(signedIn) {
  side.hidden = !signedIn;
  layout.classList.toggle('fin-layout--solo', !signedIn);
  document.querySelectorAll('[data-nav], #sync, #fab, #side-toggle, #hide-amounts, #cmd-open').forEach((el) => { el.hidden = !signedIn; });
}

// The screens before the app (sign in, check your email, setup, a loading error): a card in the
// middle of the page (the header has the logo), on a sea along the bottom with fins in it.
function screen(title, ...body) {
  setShell(false);
  main.replaceChildren(h('div', { class: 'fin-screen' },
    h('div', { class: 'fin-screen-card' },
      h('p', { class: 'fin-tagline-screen' }, 'Take care of your Finances'),
      h('h2', { class: 'fin-title', tabindex: '-1', id: 'screen-h' }, title), ...body),
    seaScene()));
}

// The sea along the bottom of those screens (decoration): three rolling waves, two small fins far
// off on the back one, and a big one cruising across on the middle one. Still when motion is reduced.
function seaScene() {
  const W = 1200;
  const fin = (x, scale, cls) => svgEl('g', { transform: `translate(${x} 0)` },
    svgEl('g', { class: cls }, svgEl('path', { d: FIN_SHAPE, class: 'fin-shape', transform: `scale(${scale})` })));
  return svgEl('svg', { class: 'fin-sea', viewBox: `0 0 ${W} 200`, preserveAspectRatio: 'xMidYMax slice', 'aria-hidden': 'true' },
    svgEl('g', { class: 'fin-sea-back' },
      svgEl('g', { transform: 'translate(0 70)' }, fin(260, 0.9, 'fin-far fin-far-1'), fin(880, 0.7, 'fin-far fin-far-2')),
      svgEl('path', { d: wavePath(-240, W + 240, 92, 120, 8, 200), class: 'fin-wave fin-sea-wave fin-sea-wave-1' })),
    svgEl('g', { transform: 'translate(0 76)' }, svgEl('g', { class: 'fin-cruise' }, svgEl('path', { d: FIN_SHAPE, class: 'fin-shape', transform: 'scale(2.6)' }))),
    svgEl('path', { d: wavePath(-240, W + 240, 136, 160, 10, 200), class: 'fin-wave fin-sea-wave fin-sea-wave-2' }),
    svgEl('path', { d: wavePath(-240, W + 240, 168, 200, 7, 200), class: 'fin-wave fin-sea-wave fin-sea-wave-3' }));
}

function renderSetupNeeded() {
  screen('Connect a database',
    h('p', { class: 'fin-empty' }, 'Your data is stored in your own Supabase project, so you can reach it from any device. Fill in tools/finance/config.js with the project URL and anon key, then reload. The steps are in tools/finance/README.md.'));
}

function renderSignIn(message) {
  const email = input({ type: 'email', required: true, autocomplete: 'email' });
  const note = h('p', { class: message ? 'fin-error' : 'fin-hint', role: message ? 'alert' : null }, message ?? '');
  screen('Sign in to Fin',
    h('p', { class: 'fin-empty' }, 'We’ll email you a link. Open it on this device to sign in. No password needed.'),
    h('form', {
      class: 'fin-signin',
      onsubmit: async (e) => {
        e.preventDefault();
        const submit = e.target.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
          await sendSignInLink(email.value.trim(), `${location.origin}/tools/finance/`);
          screen('Check your email',
            h('p', { class: 'fin-empty' }, `We sent a sign-in link to ${email.value.trim()}. Open it on this device. You can close this tab.`),
            button('Use a different email', () => renderSignIn()));
          document.getElementById('screen-h').focus();
        } catch (err) {
          note.className = 'fin-error';
          note.setAttribute('role', 'alert');
          note.textContent = err.message;
          submit.disabled = false;
        }
      },
    },
      field('Email', email), note,
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Email me a sign-in link')));
  email.focus();
}

const STATUS_TEXT = { saved: 'All changes saved', saving: 'Saving…', error: 'Not saved yet, retrying' };
onStatus((s, err) => {
  if (err instanceof SignedOut) { renderSignIn('Your session ended. Sign in again; unsaved changes on this page will be lost.'); return; }
  syncEl.textContent = STATUS_TEXT[s];
  syncEl.title = err?.message ?? '';
  syncEl.dataset.state = s;
});

// No page loads every transaction up front: each asks the database for what it shows, the IOUs
// page for the transactions its entries are linked to, and the tools that need them all (backup,
// export, imports, categories, rules) load them when opened.
async function loadData() {
  state = await load({ today: today(), until: daysFromToday(FORECAST_DAYS) });
  if (sectionOf(view) === 'ious') {
    const ids = [...new Set(state.ious.map((e) => e.transactionId).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 100) {
      const list = ids.slice(i, i + 100).map((id) => `"${id.replace(/"/g, '\\"')}"`).join(',');
      await fetchTransactions(() => selectAll('transactions', 'id', `&id=in.(${encodeURIComponent(list)})`));
    }
  }
  // On an account page: the one in the address, else the last one opened, else the first.
  if (view.name === 'account' && !state.accounts.some((a) => a.id === view.id)) {
    view = { name: 'account', id: state.settings.lastAccountId ?? state.accounts[0]?.id, tab: view.tab };
  }
}

async function boot() {
  if (!configured()) { renderSetupNeeded(); return; }
  let signInError = null;
  try { await completeSignIn(); } catch (err) { signInError = err.message; }
  if (!currentUser()) { renderSignIn(signInError); return; }

  setShell(false);
  main.replaceChildren(pageLoader('Loading your data…'));
  try {
    await loadData();
  } catch (err) {
    if (err instanceof SignedOut) { renderSignIn('Your session ended. Sign in again.'); return; }
    screen('Couldn’t load your data', h('p', { class: 'fin-error', role: 'alert' }, err.message),
      button('Try again', () => boot(), 'primary'));
    return;
  }
  setShell(true);
  syncEl.textContent = STATUS_TEXT.saved;
  const add = new URLSearchParams(location.search).has('add');
  pageSection = sectionOf(view);
  render(); // also tidies the address (drops ?add)
  // Opened from the app's "Add transactions" shortcut (…/?add): go straight to quick entry.
  if (add) quickAdd();
  await refreshRates();
  await refreshPrices(stalePrices());
  recordSnapshot();
  // A backup that's due goes to Google Drive by itself, when it's connected in this browser.
  if (driveOn() && backupDue()) await backupToDrive();
  const oldHistory = state.holdings.filter(historyStale);
  if (oldHistory.length) await loadHistory(oldHistory);
}

// After transactions are saved: the totals are asked for again (they already showed the change; this
// confirms it), and so are the list page and the description suggestions.
onSaved(async (tables) => {
  const touched = ['transactions', 'ious', 'categories', 'accounts'].some((t) => tables.has(t));
  if (touched) answers.clear();
  if (!tables.has('transactions')) { if (touched && view.name === 'insights') renderWhenIdle(); return; }
  for (const v of listViews.values()) v.stale = true; // asked for again on the next draw; shown until then
  descCache = null;
  try { await refreshSummaries(today(), daysFromToday(FORECAST_DAYS)); } catch { /* the next save tries again */ }
  renderWhenIdle();
});

// The header tabs are links to the sections' pages. A plain click first sends unsaved changes
// (and asks before dropping anything typed but not saved); Ctrl/⌘-click opens a new tab as usual.
document.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  leave(a.href, { ask: true });
}));

// Hide amounts: the eye in the header, or Alt/Option+H anywhere.
const hideToggle = document.getElementById('hide-amounts');
function showHidden() {
  hideToggle.setAttribute('aria-pressed', String(hideAmounts));
  hideToggle.title = hideAmounts ? 'Show amounts (Alt+H)' : 'Hide amounts (Alt+H)';
  document.body.classList.toggle('fin-amounts-hidden', hideAmounts);
}
function setHideAmounts(on) {
  hideAmounts = on;
  writePref('finance:hide-amounts', on);
  showHidden();
  render();
  say(on ? 'Amounts hidden.' : 'Amounts shown.');
}
hideToggle.addEventListener('click', () => setHideAmounts(!hideAmounts));
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyH' && !hideToggle.hidden) {
    e.preventDefault();
    setHideAmounts(!hideAmounts);
  }
});
showHidden();

// ── Go to: jump anywhere or start something, from the keyboard (Ctrl/⌘+K) ─────

const cmdDialog = document.getElementById('cmd-dialog');
const cmdOpen = document.getElementById('cmd-open');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
cmdOpen.title = `Go to anything (${isMac ? '⌘K' : 'Ctrl+K'})`;
cmdOpen.querySelector('kbd').textContent = isMac ? '⌘K' : 'Ctrl K';

// Everything the palette offers: pages, accounts, settings pages and actions, plus searching the
// transactions for what's typed. `words` are extra terms it can be found by.
function paletteItems(query) {
  const go = (v) => () => { view = v; render(); };
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

function openPalette() {
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

// ── phone: account panel toggle, floating add button, installable app ────────

const sideToggle = document.getElementById('side-toggle');
// On small screens the account panel is folded away behind a button; opening an account folds it again.
function setSideOpen(open) {
  side.classList.toggle('is-open', open);
  sideToggle.setAttribute('aria-expanded', String(open));
  sideToggle.textContent = open ? 'Hide accounts' : view.name === 'settings' ? 'Settings menu' : 'Accounts';
}
sideToggle.addEventListener('click', () => setSideOpen(!side.classList.contains('is-open')));
side.addEventListener('click', (e) => { if (e.target.closest('.fin-account, .fin-side-head--link')) setSideOpen(false); });

// Quick entry for the account on screen, else the main account, else the last one used.
function quickAdd() {
  const account = state.accounts.find((a) => a.id === view.id && !a.archived)
    ?? mainAccount()
    ?? state.accounts.find((a) => a.id === state.settings.lastAccountId && !a.archived)
    ?? [...state.accounts].sort(byName).find((a) => !a.archived);
  if (!account) { openAccountDialog(); return; }
  openTxDialog('multi', account);
}
document.getElementById('fab').addEventListener('click', quickAdd);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('/tools/finance/sw.js', { scope: '/tools/finance/' }).catch(() => {});
}

async function signOutNow() {
  if (hasPendingChanges() && !confirm('Some changes are still being saved. Sign out anyway?')) return;
  await signOut();
  state = null;
  renderSignIn();
}

// Warn before closing the tab while changes are still on their way to the database.
window.addEventListener('beforeunload', (e) => {
  if (state && hasPendingChanges()) e.preventDefault();
});

// Whether any field on the page holds something typed or picked but not saved yet (an API key pasted
// in, say): its value differs from the one it was drawn with. Filters and file pickers don't count.
function hasUnsavedInput() {
  return [...document.querySelectorAll('#app input, #app textarea, #app select')].some((el) => {
    if (el.type === 'search' || el.type === 'file' || el.closest('[role="search"]')) return false;
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
    if (el.tagName === 'SELECT') return [...el.options].some((o) => o.selected !== o.defaultSelected);
    return el.value !== el.defaultValue;
  });
}

boot();
