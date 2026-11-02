import {
  CURRENCIES, ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, toMinor, formatMoney, categorize, convert, rateFor, defaultState,
  normalize, categoryPath, categoriesOf, sortedCategories,
  IOU_KINDS, IOU_TYPES, personBalances, personHistory, PERIODS, periodRange, insightsFrom, completeMonths, REFUNDS_UNMATCHED, netWorthHistory, investedHistory, historyPoints, holdingHistory,
  suggestDescriptions, filterTransactions, ruleSuggestion,
  plannedTransactions, holdingValue, investmentValue, investmentValueFrom, newId,
  crossConvert, batchRow, makeTransfer,
  parseCsv, toCsv, guessDateFormat, guessDecimal, guessMapping, importRows, IMPORT_FIELDS, findTransferPairs,
  detectBuxferFile, buxferImport, isFtExport, ftImport, isFundMovements, fundMovementsToFt, lotSummary,
  UNITS, frequencyLabel, addInterval, occurrences, forecast, scheduledEffect, scheduledTransactions, advanceSchedule,
} from './model.js';
import {
  fetchRate, fetchRateRange, fetchQuote, fetchQuoteAV, fetchHistory, alphaVantageCovers, searchSymbols, today,
  FUND_MIC, isIsin, fundSearch, fundQuote, fundHistory,
} from './market.js';
import {
  load, persist, settle, onStatus, onSaved, hasPendingChanges, addTransactions, loadAllTransactions, transactionsComplete,
  refreshSummaries, accountTotals, editToken, isFromDatabase, legacyData, forgetLegacyData, missingTables, clearTables, needsSchemaUpdate,
  backupData, restoreData, BACKUP_TABLES,
} from './store.js';
import { makeZip, readZip } from './zip.js';
import { configured, currentUser, completeSignIn, sendSignInLink, signOut, SignedOut, rpc, selectAll } from './cloud.js';

// Set once the signed-in user's data has loaded (see boot() at the bottom).
let state = null;
// view: { name: 'account', id } | { name: 'settings' }
// Each main section is its own page, with its own address: …/finance/?page=search, ?page=settings
// &section=backup, ?account=<id>&tab=insights, and …/finance/ for the last account. Going to another
// section loads that page, so its data is fresh; within a page (accounts, settings pages) it's instant.
const BASE_PATH = '/tools/finance/';
const PAGES = ['search', 'scheduled', 'insights', 'ious', 'settings'];
const sectionOf = (v) => (v.name === 'account' ? 'accounts' : v.name);
function urlOf(v) {
  const q = new URLSearchParams();
  if (v.name === 'account') {
    if (v.id) q.set('account', v.id);
    if (v.tab === 'insights') q.set('tab', 'insights');
  } else {
    q.set('page', v.name);
    if (v.name === 'settings' && v.section) q.set('section', v.section);
    if (v.name === 'insights' && v.tab === 'networth') q.set('tab', 'networth');
    if (v.name === 'ious' && v.personId) q.set('person', v.personId);
  }
  const s = q.toString();
  return s ? `${BASE_PATH}?${s}` : BASE_PATH;
}
function viewFromUrl() {
  const q = new URLSearchParams(location.search);
  const page = q.get('page');
  // Net worth was its own page; it's now a tab of Insights (old links still land there).
  if (page === 'networth' || (page === 'insights' && q.get('tab') === 'networth')) return { name: 'insights', tab: 'networth' };
  if (PAGES.includes(page)) {
    return { name: page, ...(q.get('section') && { section: q.get('section') }), ...(q.get('person') && { personId: q.get('person') }) };
  }
  return { name: 'account', id: q.get('account'), ...(q.get('tab') === 'insights' && { tab: 'insights' }) };
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
const TX_TYPES = { expense: ['−', 'Expense'], income: ['+', 'Income'], refund: ['↩', 'Refund'], transfer: ['⇄', 'Transfer'] };
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
const FIN_SHAPE = 'M0 26Q7 5 24 0Q17 9 20 26Z'; // the logo's fin, 24 wide and 26 tall

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
  for (const a of list) {
    const rate = latestRate(a.currency);
    if (rate == null) missing += 1;
    else total += convert(accountValue(a), rate);
  }
  return { total, missing };
}

// ── side panel ───────────────────────────────────────────────────────────────

// Accounts are listed alphabetically everywhere (case and accents ignored).
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

function renderSide() {
  // Net worth in EUR; accounts still waiting for a rate are left out and counted.
  const nw = { total: 0, unconverted: 0 };
  for (const a of state.accounts) {
    if (a.archived) continue;
    const rate = latestRate(a.currency);
    if (rate == null) nw.unconverted += 1;
    else nw.total += convert(accountValue(a), rate);
  }
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
          h('span', { class: 'fin-account-name' }, cardMark(a), a.name),
          // No + on positive balances here: less text, and the negative ones (in red) stand out.
          h('span', { class: `fin-num ${tone(value)}` }, money(value, a.currency)),
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

// Add an account, or edit `existing`. The currency is fixed once an account has transactions or
// holdings, because their amounts are stored in that currency.
function openAccountDialog(existing = null) {
  const used = existing && (totalsOf(existing.id).count > 0
    || state.holdings.some((x) => x.accountId === existing.id));
  const name = input({ type: 'text', required: true, autocomplete: 'off', value: existing?.name });
  const type = select(ACCOUNT_TYPES.map((t) => [t, ACCOUNT_TYPE_LABELS[t]]), existing?.type ?? 'checking');
  const cur = select(CURRENCIES.map((c) => [c, c]), existing?.currency ?? 'EUR', { disabled: used });
  // Credit cards only: the limit, so the account shows what's left to spend.
  const limit = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: existing?.creditLimit != null ? String(existing.creditLimit / 100) : null });
  const limitField = field('Credit limit', limit, 'Optional. Shows how much is left to spend.');
  const network = select([['', 'Not set'], ...Object.entries(CARD_NETWORKS)], existing?.cardNetwork ?? '');
  const networkField = field('Network', network);
  const syncType = () => { limitField.hidden = networkField.hidden = type.value !== 'credit'; };
  type.addEventListener('change', syncType);
  syncType();
  const creditLimit = () => (type.value === 'credit' && limit.value !== '' ? toMinor(limit.value) : null);
  const cardNetwork = () => (type.value === 'credit' && network.value) || null;
  const returnKey = existing ? 'edit-account' : document.activeElement?.dataset?.key;
  const close = () => { dialog.close(); render(returnKey); };
  dialog.replaceChildren(h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (existing) {
        Object.assign(existing, { name: name.value.trim(), type: type.value, currency: cur.value, creditLimit: creditLimit(), cardNetwork: cardNetwork() });
        persist(); close(); say(`Saved ${existing.name}.`);
      } else {
        const account = { id: newId(), name: name.value.trim(), type: type.value, currency: cur.value, creditLimit: creditLimit(), cardNetwork: cardNetwork() };
        state.accounts.push(account);
        dialog.close();
        selectAccount(account.id);
        say(`Added account ${account.name}.`);
      }
      await refreshRates();
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, existing ? 'Edit account' : 'Add account'),
    field('Name', name), field('Type', type), networkField, limitField,
    field('Currency', cur, used
      ? 'Fixed, because this account already has transactions.'
      : 'USD amounts are converted to EUR at the daily rate.'),
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
        h('h2', { class: 'fin-title' }, cardMark(account, 'fin-card-mark--title'), account.name),
        h('p', { class: 'fin-meta' }, `${ACCOUNT_TYPE_LABELS[account.type]} · ${account.currency}`, account.archived && ' · Archived')),
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
      // Like Buxfer's forecast: the balance once everything scheduled in the next 30 days happens,
      // and the transactions already added for those days.
      (state.schedules.some((s) => scheduledEffect(s, account.id) !== 0) || totalsOf(account.id).plannedCount > 0) && (() => {
        const next = forecast(account.id, value, state.schedules, daysFromToday(FORECAST_DAYS)) + totalsOf(account.id).planned;
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
const EMPTY_FILTER = { text: '', categoryId: null, type: null, from: '', to: '', min: '', max: '', accountId: '' };
const filterOf = (scope) => txFilters.get(scope) ?? EMPTY_FILTER;
const filterActive = (f) => Boolean(f.text || f.categoryId != null || f.type || f.from || f.to || f.min || f.max || f.accountId);
let filterTimer = null;

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
  const cat = select([['*', 'All categories'], ['', 'Uncategorized'], ...catOptions()], f.categoryId == null ? '*' : f.categoryId, { 'data-key': `${scope}-cat`, 'aria-label': 'Category' });
  cat.addEventListener('change', () => set({ categoryId: cat.value === '*' ? null : cat.value }, `${scope}-cat`));
  const type = select([['', 'All types'], ['expense', 'Expenses'], ['income', 'Income'], ['refund', 'Refunds'], ['transfer', 'Transfers']], f.type ?? '', { 'data-key': `${scope}-type`, 'aria-label': 'Type' });
  type.addEventListener('change', () => set({ type: type.value || null }, `${scope}-type`));
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
  const acc = showAccount && select([['', 'All accounts'], ...[...state.accounts].sort(byName).map((a) => [a.id, a.archived ? `${a.name} (archived)` : a.name])], f.accountId, { 'data-key': `${scope}-acc`, 'aria-label': 'Account' });
  acc && acc.addEventListener('change', () => set({ accountId: acc.value }, `${scope}-acc`));
  return h('div', { class: 'fin-filters', role: 'search', 'aria-label': 'Filter transactions' },
    h('div', { class: 'fin-filter-q' }, text),
    acc, cat, type,
    h('div', { class: 'fin-filter-pair' }, dateIn('from', 'From date'), h('span', { class: 'fin-muted' }, '–'), dateIn('to', 'To date')),
    h('div', { class: 'fin-filter-pair' }, amountIn('min', 'Min'), h('span', { class: 'fin-muted' }, '–'), amountIn('max', 'Max')),
    filterActive(f) && button('Clear', () => { txFilters.delete(scope); txPage = 0; selected.clear(); render(`${scope}-q`); }, 'secondary fin-btn-sm', { 'data-key': `${scope}-clear` }));
}

const toFilter = (f) => ({ ...f, accountIds: f.accountId ? new Set([f.accountId]) : null });

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
  const setCat = select([['', 'Set category…'], ...catOptions()], '', { 'aria-label': 'Set the category of the selected transactions', class: 'fin-input fin-input-sm' });
  setCat.addEventListener('change', () => {
    if (!setCat.value) return;
    const id = setCat.value;
    undoable(`${catLabel(id)} set on ${categorizable.length} transaction${categorizable.length === 1 ? '' : 's'}.`, ['transactions'], () => {
      for (const t of categorizable) t.categoryIds = [id];
    });
  });
  const addCat = select([['', 'Add category…'], ...catOptions()], '', { 'aria-label': 'Add a category to the selected transactions', class: 'fin-input fin-input-sm' });
  addCat.addEventListener('change', () => {
    if (!addCat.value) return;
    const id = addCat.value;
    undoable(`${catLabel(id)} added to ${categorizable.length} transaction${categorizable.length === 1 ? '' : 's'}.`, ['transactions'], () => {
      for (const t of categorizable) if (!categoriesOf(t).includes(id)) t.categoryIds = [...categoriesOf(t), id];
    });
  });
  return h('div', { class: 'fin-bulk', role: 'region', 'aria-label': 'Selected transactions' },
    h('strong', {}, `${picked.length} selected`),
    picked.length < pageRows.length && button(`Select all ${pageRows.length} on this page`, () => { pageRows.forEach((t) => selected.add(t.id)); render('bulk-clear'); }, 'secondary fin-btn-sm'),
    categorizable.length > 0 && setCat,
    categorizable.length > 0 && addCat,
    categorizable.length > 0 && button('Remove categories', () => undoable(`Categories removed from ${categorizable.length} transaction${categorizable.length === 1 ? '' : 's'}.`, ['transactions'], () => {
      for (const t of categorizable) t.categoryIds = [];
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
        h('td', { class: 'c-desc' }, quickCell(t, 'description', label, t.description), t.memo && h('span', { class: 'fin-sub' }, t.memo)),
        showAccount && h('td', { class: 'c-acc' }, h('button', {
          type: 'button', class: 'fin-link fin-link-sm', onclick: () => selectAccount(t.accountId),
        }, account?.name ?? 'Deleted account')),
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
function requestList(scope, key, name, args) {
  if (listLoading.get(scope) === key) return;
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
    if (!added || !page) { say('Couldn’t load the transactions. Try again in a moment.'); return; }
    listViews.set(scope, {
      key, total: Number(page.total), ids: page.rows.map((r) => r.id), known, page,
      balances: new Map(page.rows.filter((r) => r.balance != null).map((r) => [r.id, Number(r.balance)])),
    });
    renderWhenIdle();
  }).catch((err) => {
    if (listLoading.get(scope) === key) listLoading.delete(scope);
    say(`Couldn’t load the transactions: ${err.message}`);
  });
}

// A filter bar's filter as arguments for the database's list functions (fin_match).
function filterArgs(f) {
  const text = String(f.text ?? '').trim();
  const asAmount = /^[\d.,]+$/.test(text) ? Math.abs(toMinor(text.replace(/,(\d{1,2})$/, '.$1').replace(/,/g, ''))) : null;
  return {
    p_text: normalize(text) || null, p_amount: Number.isFinite(asAmount) ? asAmount : null,
    p_category: f.categoryId || null, p_uncategorized: f.categoryId === '', p_type: f.type || null,
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
    || state.schedules.some((s) => scheduledEffect(s, account.id) !== 0 && occurrences(s, daysFromToday(FORECAST_DAYS)).length > 0));
  return h('section', { class: 'fin-card', 'aria-labelledby': 'tx-h' },
    h('div', { class: 'fin-card-head' },
      h('h3', { id: 'tx-h', class: 'fin-label' }, 'Transactions ', h('span', { class: 'fin-count' }, filtered ? (ready ? `${total} of ${totals.past}` : '…') : String(totals.past))),
      h('div', { class: 'fin-actions' },
        button('Schedule…', () => openScheduleDialog(null, { accountId: account.id }), 'secondary', { 'data-key': 'up-add', 'aria-haspopup': 'dialog' }),
        button('Add transactions', () => openTxDialog('multi', account), 'primary', { 'data-key': 'tx-add', 'aria-haspopup': 'dialog' }))),
    filterBar(scope),
    selected.size > 0 && bulkBar(rows),
    pages > 1 && pager(txPage, pages, total, 'top'),
    !ready && rows.length === 0
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
  const f = filterOf('search');
  const active = filterActive(f);
  const key = JSON.stringify([txPage, f]);
  const view0 = listViews.get('search');
  const ready = active && view0?.key === key;
  if (active && (!ready || view0.stale)) {
    requestList('search', key, 'search_transactions', {
      p_accounts: f.accountId ? [f.accountId] : null, p_limit: TX_PAGE_SIZE, p_offset: txPage * TX_PAGE_SIZE,
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
        ? h('p', { class: 'fin-empty fin-pad' }, 'Type something to search for, or pick a category, type, dates or amounts.')
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
const accountName = (id) => state.accounts.find((a) => a.id === id)?.name ?? 'a deleted account';
// Accounts you can pick in a form: the active ones, plus `keep` even if it is archived.
const pickableAccounts = (keep) => state.accounts.filter((a) => !a.archived || a.id === keep).sort(byName);

// Inline edit of one transaction. For one side of a transfer, the other side follows: same date,
// description and memo, and its amount scales with this one (so cross-currency transfers
// keep their exchange rate).
function transactionForm(account, tx) {
  const partner = transferPartner(tx);
  let kind = tx.kind === 'refund' ? 'refund' : tx.amount > 0 ? 'income' : 'expense';
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
  const memo = h('textarea', { class: 'fin-input', rows: '2' });
  memo.value = tx.memo ?? '';
  const cancel = () => { editingTxId = null; render(`tx-edit-${tx.id}`); };
  const kinds = typeSwitch(['expense', 'income', 'refund'], kind, { onChange: (k) => { kind = k; } });

  return h('form', {
    class: 'fin-tx-form',
    'aria-label': `Edit ${tx.description}`,
    onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } },
    onsubmit: async (e) => {
      e.preventDefault();
      const sign = tx.transferId ? Math.sign(tx.amount) : kind === 'expense' ? -1 : 1;
      const next = toMinor(amount.value) * sign;
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
        kind: tx.transferId ? tx.kind : kind === 'refund' ? 'refund' : tx.kind === 'opening' ? 'opening' : undefined,
        categoryIds: tx.transferId ? [] : cats.value(),
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
      field('Date', date)),
    !tx.transferId && pickerField('Categories', cats),
    h('div', { class: 'fin-grid' }, field('Memo', memo)),
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
    return h('span', { class: 'fin-tag fin-tag--transfer' }, `${t.amount < 0 ? 'To' : 'From'} ${accountName(partner?.accountId)}`);
  }
  // Loans, settlements and paying for a friend are shown by their type instead of categories, like
  // transfers. A shared bill is a real expense: it keeps its categories, with the IOU underneath.
  const ious = iousOf(t.id);
  if (ious.length && ious[0].kind !== 'shared_bill') return iouLabel(ious);
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

// Chosen categories as removable chips, plus a menu to add another. `value()` reads the choice;
// `onChange(ids, message)` runs on every change.
function categoryPicker(selected, { label, compact = false, onChange } = {}) {
  const ids = [...selected];
  const wrap = h('div', { class: `fin-cats${compact ? ' fin-cats-compact' : ''}`, role: 'group', 'aria-label': label });
  const paint = (focus) => {
    const add = select([['', ids.length ? '+' : '+ Category'], ...catOptions().filter(([id]) => !ids.includes(id))], '',
      { 'aria-label': `Add a category (${label})`, class: 'fin-input fin-input-sm fin-cat-add' });
    add.addEventListener('change', () => {
      if (!add.value) return;
      ids.push(add.value);
      onChange?.([...ids], `Added ${catLabel(add.value)}.`);
      paint('add');
    });
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
    wrap.replaceChildren(...chips, add);
    // After removing a chip, focus the next one (or the menu), so keyboard users don't lose their place.
    if (focus === 'add') add.focus();
    else if (typeof focus === 'number') (wrap.querySelectorAll('.fin-cat-x')[focus] ?? add).focus();
  };
  paint();
  // `set(ids)` replaces the choice (a suggestion filling in its categories).
  return { el: wrap, value: () => [...ids], set: (next) => { ids.splice(0, ids.length, ...next.filter((id) => category(id))); paint(); onChange?.([...ids], ''); } };
}

// A labelled form row for a category picker (a group, so the label is its accessible name).
function pickerField(label, picker) {
  const id = `f-${newId().slice(0, 8)}`;
  picker.el.removeAttribute('aria-label');
  picker.el.setAttribute('aria-labelledby', id);
  return h('div', { class: 'fin-field fin-mb' }, h('span', { class: 'fin-field-label', id }, label), picker.el);
}

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

const categoryOptions = (autoLabel = 'Auto') => [['', autoLabel], ...catOptions()];

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
  const isOpen = () => !listbox.hidden;
  // Lines the list up with the box; the position goes to CSS as custom properties.
  const place = () => {
    const r = box.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const up = below < 240 && r.top > below;
    const width = Math.min(Math.max(r.width, 288), window.innerWidth - 16);
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
      cat: select(categoryOptions(), '', { 'aria-label': `Category, row ${n}` }),
      type: typeSwitch(['expense', 'income', 'refund', 'transfer'], 'expense', { label: `Type, row ${n}`, compact: true, onChange: () => syncType() }),
      // For a transfer, the category cell shows where the money goes instead.
      to: select([['', 'To account…'], ...accounts.map((a) => [a.id, a.name])], '', { 'aria-label': `Transfer to, row ${n}`, hidden: true }),
      amount: input({ type: 'number', step: '0.01', min: '0.01', inputmode: 'decimal', 'aria-label': `Amount, row ${n}` }),
      date: input({ type: 'date', value: rows.at(-1)?.date.value || today(), 'aria-label': `Date, row ${n}` }),
      acc: select(accounts.map((a) => [a.id, a.name]), rows.at(-1)?.acc.value ?? account.id, { 'aria-label': `Account, row ${n}` }),
    });
    const combo = descriptionCombo(index, {
      label: `Description, row ${n}`,
      accountOf: () => r.acc.value,
      // Fill the row from the latest use of that description, except the amount, which is rarely the
      // same; the cursor goes there next.
      onAccept: (e) => {
        r.desc.value = e.description;
        const cat = e.categoryIds.find((id) => category(id));
        if (cat) r.cat.value = cat;
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
    // While the category is on Auto, its label shows what the rules would pick.
    const syncAuto = () => {
      const id = categorize(r.desc.value, state.rules);
      r.cat.options[0].textContent = id ? `Auto: ${catLabel(id)}` : 'Auto';
    };
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
      r.cat.hidden = transfer;
      r.to.hidden = !transfer;
    };
    rows.push(r);
    r.tr = h('tr', {},
      h('td', {}, combo.el), h('td', {}, r.type.el), h('td', {}, r.cat, r.to),
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
          date: r.date.value, accountId: r.acc.value, categoryId: r.cat.value, toAccountId: r.to.value,
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
    h('p', { class: 'fin-hint' }, 'Empty rows are skipped. Leave the category on Auto to use your rules. A suggestion fills in its category and type, or both accounts for a transfer; you type the amount. For a transfer, pick ⇄ and the account the money goes to.'),
    error,
    h('div', { class: 'fin-dialog-foot' },
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Add transactions'),
      h('span', { class: 'fin-muted' }, 'or'),
      h('button', { type: 'button', class: 'fin-link', onclick: () => swap('single') }, 'Add a single transaction')));
  return form;
}

function singleTxForm(account, close, swap) {
  const accounts = pickableAccounts(account.id);
  const accountOptions = accounts.map((a) => [a.id, `${a.name} (${a.currency})`]);
  const type = typeSwitch(['expense', 'income', 'refund', 'transfer'], 'expense', { onChange: () => { sync(); suggest(); } });
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
    catField.hidden = transfer;
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
    type.value = e.kind === 'transfer' ? 'transfer' : e.kind === 'refund' ? 'refund' : e.amount < 0 ? 'expense' : 'income';
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
        const repeats = scheduleFrom({ description: legs[0].description, amount: sent, kind: 'transfer', accountId: a.id, toAccountId: b.id, categoryId: null });
        persist(); close(); say(`Transferred from ${a.name} to ${b.name}.${repeats}${laterNote()}`);
        return;
      }
      // None picked: the rules choose one, as in the quick form.
      const categoryIds = cats.value().length ? cats.value() : [categorize(desc.value, state.rules)].filter(Boolean);
      state.transactions.push({
        id: newId(), accountId: a.id, description: desc.value.trim(),
        amount: sent * (type.value === 'expense' ? -1 : 1),
        categoryIds, rate: await ensureRate(a.currency, date.value), ...common,
        ...(type.value === 'refund' ? { kind: 'refund' } : {}),
      });
      const repeats = scheduleFrom({ description: desc.value.trim(), amount: sent, kind: type.value === 'expense' ? 'expense' : 'income', accountId: a.id, toAccountId: null, categoryId: categoryIds[0] ?? null });
      persist(); close(); say(`Transaction added.${repeats}${laterNote()}`);
    },
  },
    dialogHead('Add transaction', close),
    type.el,
    h('div', { class: 'fin-grid fin-grid-2' },
      comboField('Description', descCombo),
      catField, field('Date', date),
      amountField, receivedField,
      fromField, toField,
      field('Repeat', repeat, 'Adds a schedule: each next date shows on the account to enter or skip.')),
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
  const show = (i) => {
    at = Math.max(0, Math.min(points.length - 1, i));
    const p = points[at];
    guide.setAttribute('x1', x(p)); guide.setAttribute('x2', x(p));
    dot.setAttribute('cx', x(p)); dot.setAttribute('cy', y(p.v));
    dot.setAttribute('class', `fin-dot ${kind === 'gain' ? 'fin-dot-gain' : p.v >= base ? 'fin-dot-up' : 'fin-dot-down'}`);
    const d = p.v - base;
    const r = refAt(p.date);
    // replaceChildren doesn't flatten lists (it would print them as text), so flatten them here.
    readout.replaceChildren(...[h('strong', {}, `${shortDate(p.date)} ${p.date.slice(0, 4)}`), ' ',
      h('strong', { class: `fin-num ${kind === 'gain' ? tone(p.v) : ''}` }, format(p.v)),
      change && at > 0 && [' · ', h('span', { class: `fin-num ${tone(d)}` }, signedOf(d)),
        !hideAmounts && base > 0 ? ` (${d >= 0 ? '+' : ''}${num((d / base) * 100)}%)` : '', ' since the start'],
      r != null && [' · ', refLabel.toLowerCase(), ' ', h('span', { class: 'fin-num' }, format(r))],
    ].flat().filter((x) => x != null && x !== false && x !== ''));
  };
  const wrap = h('div', {
    class: 'fin-chart-wrap', tabindex: '0', role: 'group', 'aria-label': `${title}: use the arrow keys to read each point`,
    onkeydown: (e) => {
      const move = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: points.length - 1 }[e.key];
      if (move === undefined) return;
      e.preventDefault();
      show(move);
    },
    onfocus: () => show(at),
  }, svg);
  // Pointer: the nearest point by date.
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(x(p) - px) < Math.abs(x(points[best]) - px)) best = i; });
    show(best);
  });
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
  const acc = select([['', 'No account (cash, or outside your accounts)'], ...accounts.map((a) => [a.id, a.name])], preset.accountId ?? '');
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
    const show = () => {
      svg.querySelectorAll('.fin-col.is-active').forEach((n) => n.classList.remove('is-active'));
      g.classList.add('is-active');
      readout.replaceChildren(
        h('strong', {}, bucketTitle(b.key, r.unit)), ' ',
        h('span', { class: 'fin-key fin-key-in' }), h('strong', { class: 'fin-num' }, money(b.income, 'EUR')), ' income ',
        h('span', { class: 'fin-key fin-key-out' }), h('strong', { class: 'fin-num' }, money(b.expenses, 'EUR')), ' spent',
        h('span', { class: 'fin-muted' }, ` · net ${signed(b.income - b.expenses, 'EUR')}`));
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
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
    h('div', { class: 'fin-chart-wrap' }, svg),
    table);
}

// Spending (or income) per top-level category, largest first, each opening onto its subcategories.
// A donut of the top-level categories (the biggest seven, the rest as Other) with the total in the
// middle, over the list of every category with its amount and share; a category with subcategories
// opens to show them. Hover or focus a slice to read it in the middle. Slice colours go by rank
// (validated categorical palette); each list row carries the same colour as a dot.
const DONUT_SLOTS = 7;
function categoryBreakdown(title, rows, total) {
  const name = (id) => (id === REFUNDS_UNMATCHED ? 'Refunds with no expense category'
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
  const showTotal = () => { centre.textContent = money(total, 'EUR'); caption.textContent = 'Total'; };
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
    // The middle fits about 20 characters; the list beside it has the full name.
    const short = sl.label.length > 16 ? `${sl.label.slice(0, 15)}…` : sl.label;
    const show = () => { centre.textContent = money(sl.amount, 'EUR'); caption.textContent = `${short} · ${share(sl.amount)}`; };
    path.addEventListener('pointerenter', show);
    path.addEventListener('focus', show);
    path.addEventListener('pointerleave', showTotal);
    path.addEventListener('blur', showTotal);
    svg.append(path);
    a0 = a1;
  }
  showTotal();
  svg.append(centre, caption);

  const dot = (slot) => h('span', { class: 'fin-dot', 'data-slot': slot ?? 'none', 'aria-hidden': 'true' });
  const line = (id, amount, child = false) => h('div', { class: `fin-break-row fin-break-row--dot${child ? ' fin-break-child' : ''}` },
    child ? h('span', { 'aria-hidden': 'true' }) : dot(slotOf(id)),
    h('span', { class: 'fin-break-name' }, child ? (category(id)?.name ?? name(id)) : name(id)),
    h('span', { class: 'fin-num fin-break-amt' }, money(amount, 'EUR')),
    h('span', { class: 'fin-num fin-break-pct fin-muted' }, share(amount)));
  return h('section', { class: 'fin-card fin-pad', 'aria-label': title },
    h('h3', { class: 'fin-label' }, title),
    rows.length === 0 ? h('p', { class: 'fin-empty' }, 'Nothing in this period.') : [
      slices.length > 0 && h('div', { class: 'fin-donut-wrap' }, svg),
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
    const show = () => {
      svg.querySelectorAll('.fin-col.is-active').forEach((n) => n.classList.remove('is-active'));
      g.classList.add('is-active');
      readout.replaceChildren(h('strong', {}, bucketTitle(b.key, unit)), ' ', h('strong', { class: 'fin-num' }, money(b.value, 'EUR')));
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    svg.append(g);
    if (i % every === 0) {
      const t = el('text', { x: cx, y: H - 8, class: 'fin-tick', 'text-anchor': 'middle' });
      t.textContent = bucketLabel(b.key, unit, multiYear);
      svg.append(t);
    }
  });
  return [
    readout,
    h('div', { class: 'fin-chart-wrap' }, svg),
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


// Insights for an investment account: its value against what was put in, over the period, and
// each holding's value, cost and gain today.
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
  if (!runs || !paidIn) return h('div', { class: 'fin-insights' }, periodControls(range), loader('Working out the history…'));
  const hist = netWorthHistory({ ...state, accounts: [account] }, { from: range.from, to, today: today(), holdingsValue: holdingsValueEUR, rateOf, runs: runMap(runs) });
  const invested = investedHistory(account, state, dates, rateOf, runMap(paidIn).get(account.id) ?? { values: [] });
  const pts = hist.points.map((p, i) => ({ key: p.key, date: p.date, total: p.total, investments: invested[i] }));
  const now = pts.at(-1);
  const gain = now.total - now.investments;
  const change = now.total - pts[0].total;
  const byLots = own.length > 0 && own.every((x) => lotsOfHolding(x.id).length);

  const rows = own.map((x) => {
    const value = convert(holdingValue(x) ?? 0, rateOf(x.currency));
    const lotsX = lotsOfHolding(x.id);
    const cost = lotsX.length ? convert(lotSummary(lotsX).cost, rateOf(x.currency)) : null;
    return { x, value, cost, gain: cost == null ? null : value - cost };
  }).sort((a, b) => b.value - a.value);
  const totalValue = rows.reduce((s, r) => s + r.value, 0);

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
        h('p', { class: 'fin-stat-note' }, 'value, including new money'))),
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
        h('thead', {}, h('tr', {}, ['Holding', 'Units', 'Value', 'Cost', 'Gain', 'Share'].map((t, i) => h('th', { scope: 'col', class: i ? 'fin-r' : null }, t)))),
        h('tbody', {}, rows.map(({ x, value, cost, gain: g }) => h('tr', {},
          h('td', {}, x.symbol, h('span', { class: 'fin-sub' }, x.name ?? '')),
          h('td', { class: 'fin-r fin-num' }, shownQty(x.quantity)),
          h('td', { class: 'fin-r fin-num' }, money(value, 'EUR')),
          h('td', { class: 'fin-r fin-num fin-muted' }, cost == null ? '—' : money(cost, 'EUR')),
          h('td', { class: `fin-r fin-num ${g == null ? '' : tone(g)}` }, g == null ? '—' : signed(g, 'EUR'),
            g != null && cost > 0 && h('span', { class: 'fin-sub' }, `${g >= 0 ? '+' : ''}${num((g / cost) * 100)}%`)),
          h('td', { class: 'fin-r fin-num fin-muted' }, totalValue ? `${Math.round((value / totalValue) * 100)}%` : ''))))))));
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
  const hist = netWorthHistory(state, {
    from: range.from, to, today: today(), holdingsValue: holdingsValueEUR, rateOf: (c) => latestRate(c) ?? 1, runs: runMap(runs),
  });
  const pts = hist.points;
  const now = pts.at(-1);
  const start = pts[0];
  const change = now.total - start.total;

  // Today's split by account type (archived accounts are closed, so they're not part of it).
  const byType = ACCOUNT_TYPES.map((type) => {
    const value = state.accounts.filter((a) => a.type === type && !a.archived)
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
          h('p', { class: 'fin-stat-note' }, 'credit cards and other negative balances'))),
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
          ? `Investments are at market value from ${shortDate(hist.firstSnapshot)} ${hist.firstSnapshot.slice(0, 4)}, recorded once a day when you open the app. Before that, holdings with buys and sells are valued as the units held times the latest trade price; others at what was put in, as there's no price history.`
          : 'Investments are at market value today. Earlier, holdings with buys and sells are valued as the units held times the latest trade price; others at what was put in, as there\'s no price history. From today the app records market values once a day, so the history fills in.',
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
            h('span', { class: 'fin-num fin-break-pct fin-muted' }, value > 0 && assets ? `${Math.round((value / assets) * 100)}%` : ''))))))));
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
  const accountOptions = accounts.map((a) => [a.id, a.name]);
  const kind = select([['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']], s.kind ?? 'expense');
  const desc = input({ type: 'text', required: true, autocomplete: 'off', value: s.description });
  const amount = input({ type: 'number', step: '0.01', min: '0.01', required: true, inputmode: 'decimal', value: s.amount ? String(s.amount / 100) : null });
  const from = select(accountOptions, s.accountId ?? view.id ?? accounts[0]?.id);
  const to = select([['', 'Choose an account'], ...accountOptions], s.toAccountId ?? '');
  const cat = select([['', 'None'], ...catOptions()], s.categoryId ?? '');
  const every = input({ type: 'number', min: '1', step: '1', required: true, value: String(s.every ?? 1), inputmode: 'numeric' });
  const unit = select(UNITS.map((u) => [u, `${u}(s)`]), s.unit ?? 'month');
  const next = input({ type: 'date', required: true, value: s.nextDate ?? today() });
  const end = input({ type: 'date', value: s.endDate ?? null });
  const fromField = field('Account', from);
  const toField = field('To account', to);
  const catField = field('Category', cat);
  const sync = () => {
    const transfer = kind.value === 'transfer';
    fromField.querySelector('label').textContent = transfer ? 'From account' : 'Account';
    toField.hidden = !transfer;
    to.required = transfer;
    catField.hidden = transfer;
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
        categoryId: kind.value === 'transfer' ? null : cat.value || null,
        every: Math.max(1, Math.round(Number(every.value))), unit: unit.value,
        anchorDay: Number(next.value.slice(8, 10)), nextDate: next.value, endDate: end.value || null,
      };
      if (existing) Object.assign(existing, fields);
      else state.schedules.push({ id: newId(), ...fields });
      persist(); close();
      say(existing ? 'Schedule saved.' : `Scheduled ${fields.description}, ${frequencyLabel(fields).toLowerCase()}, next on ${shortDate(fields.nextDate)}.`);
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, existing ? 'Edit schedule' : 'Schedule a transaction'),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Type', kind), field('Description', desc), field('Amount', amount), catField,
      fromField, toField,
      h('div', { class: 'fin-field' },
        h('span', { class: 'fin-field-label', id: 'sched-every-l' }, 'Repeats every'),
        h('div', { class: 'fin-inline', role: 'group', 'aria-labelledby': 'sched-every-l' },
          every, unit)),
      field('Next date', next), field('Ends on', end, 'Optional. Leave empty to repeat until you stop it.')),
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
      h('td', { class: 'c-cat' }, s.categoryId && h('span', { class: 'fin-muted' }, catLabel(s.categoryId))),
      inEur && h('td', { class: 'c-eur' }),
      // Only the next date of a schedule can be entered or skipped; later ones follow from it.
      h('td', { class: 'fin-r c-act' }, first && h('div', { class: 'fin-actions fin-row-actions fin-upcoming-actions' },
        button('Enter', () => enterScheduled(s, `up-enter-${s.id}`), 'secondary fin-btn-sm',
          { 'aria-label': `Enter ${s.description} for ${shortDate(date)}`, 'data-key': `up-enter-${s.id}` }),
        button('Skip', () => skipScheduled(s, `up-skip-${s.id}`), 'secondary fin-btn-sm',
          { 'aria-label': `Skip ${s.description} on ${shortDate(date)}`, 'data-key': `up-skip-${s.id}` }))));
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
  return [
    h('tr', { class: 'fin-month fin-upcoming-head' }, h('th', { colspan: cols, scope: 'colgroup' },
      'Upcoming ', h('span', { class: 'fin-upcoming-note' }, `· scheduled for the next ${FORECAST_DAYS} days`))),
    ...items.reverse().map((it) => (it.t ? plannedRow(it) : scheduleRow(it))),
  ];
}

function renderSchedules() {
  const list = [...state.schedules].sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  return h('div', {},
    h('div', { class: 'fin-account-head' },
      h('div', {}, h('h2', { class: 'fin-title' }, 'Scheduled'),
        h('p', { class: 'fin-meta' }, 'Recurring transactions. When one is due it shows on its account, where you enter or skip it.')),
      button('Schedule a transaction', () => openScheduleDialog(), 'primary', { 'data-key': 'sched-add', 'aria-haspopup': 'dialog' })),
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
              h('td', {}, s.description, s.categoryId && h('span', { class: 'fin-sub' }, catLabel(s.categoryId))),
              h('td', {}, scheduleAccounts(s)),
              h('td', { class: `fin-r fin-num ${s.kind === 'transfer' ? '' : tone(shown)}` }, s.kind === 'transfer' ? money(s.amount, cur) : signed(shown, cur)),
              h('td', { class: 'fin-nowrap' }, frequencyLabel(s), s.endDate && h('span', { class: 'fin-sub' }, `until ${shortDate(s.endDate)}`)),
              h('td', { class: 'fin-r' }, h('div', { class: 'fin-actions fin-row-actions' },
                due && button('Enter', () => enterScheduled(s, `sched-edit-${s.id}`), 'secondary fin-btn-sm', { 'aria-label': `Enter ${s.description}` }),
                button('Edit', () => openScheduleDialog(s), 'secondary fin-btn-sm', { 'aria-label': `Edit ${s.description}`, 'data-key': `sched-edit-${s.id}` }),
                button('Stop', () => deleteScheduled(s), 'danger fin-btn-sm', { 'aria-label': `Stop ${s.description}` }))));
          }))))));
}

// ── main: settings ───────────────────────────────────────────────────────────

// Settings are split into pages; while in Settings the left panel lists them instead of the accounts.
const SETTINGS_PAGES = [
  { key: 'categories', label: 'Categories', group: 'Organise', needsAll: true, render: () => categoriesSection() },
  { key: 'rules', label: 'Category rules', group: 'Organise', needsAll: true, render: () => rulesSection() },
  { key: 'market', label: 'Market data', group: 'Prices', render: () => marketSection() },
  { key: 'backup', label: 'Backup and restore', group: 'Data', needsAll: true, render: () => backupSection() },
  { key: 'buxfer', label: 'Import from Buxfer', group: 'Data', needsAll: true, render: () => buxferSection() },
  { key: 'import', label: 'Import CSV', group: 'Data', needsAll: true, render: () => importSection() },
  { key: 'ft', label: 'Import holdings', group: 'Data', render: () => ftSection() },
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
    page.needsAll && !transactionsComplete() ? needEverything() : page.render());
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
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'settings-h' },
    h('h3', { id: 'fmt-h', class: 'fin-label' }, 'Number format'),
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
    settingsPage = 'buxfer';
    view = { name: 'settings', section: 'buxfer' };
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
      for (const t of state.transactions) if (categoriesOf(t).includes(c.id)) t.categoryIds = categoriesOf(t).filter((id) => id !== c.id);
      for (const k of state.categories) if (k.parentId === c.id) k.parentId = null;
      state.rules = state.rules.filter((r) => r.categoryId !== c.id);
      for (const x of state.schedules) if (x.categoryId === c.id) x.categoryId = null;
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
  const acc = select([['', 'None'], ...[...state.accounts].sort(byName).map((a) => [a.id, a.name])], d.defaultAccountId, { 'data-key': 'imp-acc' });
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
      ['Date', 'Description', 'Amount', 'Currency', 'Account', 'Category', 'Memo', 'Amount (EUR)', 'Transfer', 'Kind'],
      ...[...state.transactions].sort((a, b) => a.date.localeCompare(b.date)).map((t) => [
        t.date, t.description, decimal2(t.amount), accCur(t.accountId), accName(t.accountId),
        t.transferId ? '' : categoriesOf(t).map(catLabel).filter(Boolean).join(', '), t.memo ?? '',
        t.rate == null ? '' : decimal2(convert(t.amount, t.rate)), t.transferId ?? '', t.kind ?? '',
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
      ...state.schedules.map((x) => [x.nextDate, x.description, x.kind, decimal2(x.amount), accName(x.accountId), accName(x.toAccountId), catLabel(x.categoryId), frequencyLabel(x), x.endDate ?? '']),
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
async function downloadBackup() {
  // A backup has every transaction, wherever it's downloaded from (the reminder shows on any page).
  if (!transactionsComplete()) {
    say('Getting all your transactions for the backup…');
    try { await loadAllTransactions(); } catch (err) { say(`Couldn’t make the backup: ${err.message}`); return; }
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
  downloadBytes(`finance-backup-${today()}.zip`, bytes, 'application/zip');
  state.settings.lastBackupAt = new Date().toISOString();
  persist();
  render();
  say('Backup downloaded. Keep it somewhere safe, like iCloud Drive or Google Drive.');
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
      ? `Your last backup was ${daysSince(last)} days ago. The database keeps no backups of its own, so it’s worth downloading one.`
      : 'You haven’t downloaded a backup yet. The database keeps no backups of its own, so it’s worth having one.'),
    h('div', { class: 'fin-actions' },
      button('Download backup', downloadBackup, 'primary'),
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
      h('p', {}, last ? `Last backup: ${new Date(last).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${daysSince(last) === 0 ? 'today' : `${daysSince(last)} days ago`}).` : 'No backup downloaded yet.'),
      h('p', { class: 'fin-hint' }, 'Your data is in your Supabase project, whose free plan keeps no backups. A backup is one .zip file: backup.json restores everything exactly, and the same data comes as readable CSV files. API keys aren’t included. Keep it somewhere safe, like iCloud Drive or Google Drive.'),
      h('div', { class: 'fin-actions fin-mt' }, button('Download backup', downloadBackup, 'primary', { 'data-key': 'backup-now' })),
      h('div', { class: 'fin-grid fin-mt' }, field('Remind me to back up', every, 'A banner appears when a backup is due.'))),
    h('section', { class: 'fin-card fin-pad fin-danger-zone', 'aria-labelledby': 'restore-h' },
      h('h3', { id: 'restore-h', class: 'fin-label' }, 'Restore from a backup'),
      restore ?? [
        h('p', { class: 'fin-hint' }, 'Pick a backup .zip (or its backup.json). You’ll see what’s in it before anything changes.'),
        h('div', { class: 'fin-grid' }, field('Backup file', file)),
      ]));
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
    const on = b.dataset.nav === (view.name === 'account' ? 'overview' : view.name);
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
  document.querySelectorAll('[data-nav], #sync, #fab, #side-toggle, #hide-amounts').forEach((el) => { el.hidden = !signedIn; });
}

function screen(title, ...body) {
  setShell(false);
  main.replaceChildren(h('div', { class: 'fin-welcome' }, h('h2', { class: 'fin-title', tabindex: '-1', id: 'screen-h' }, title), ...body));
}

function renderSetupNeeded() {
  screen('Connect a database',
    h('p', { class: 'fin-empty' }, 'Your data is stored in your own Supabase project, so you can reach it from any device. Fill in tools/finance/config.js with the project URL and anon key, then reload. The steps are in tools/finance/README.md.'));
}

function renderSignIn(message) {
  const email = input({ type: 'email', required: true, autocomplete: 'email' });
  const note = h('p', { class: message ? 'fin-error' : 'fin-hint', role: message ? 'alert' : null }, message ?? '');
  screen('Sign in',
    h('p', { class: 'fin-tagline-screen' }, 'Fin · Swim ahead of your money'),
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

// Quick entry for the account on screen, or the last one used.
function quickAdd() {
  const account = state.accounts.find((a) => a.id === view.id && !a.archived)
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
