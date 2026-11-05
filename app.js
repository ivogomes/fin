import {
  SignedOut, completeSignIn, configured, currentUser, rpc, selectAll, sendSignInLink,
  signInWithGoogle, signOut,
} from './cloud.js';
import { renderAssets } from './assets.js';
import { driveConfigured, renderGoogleButton } from './drive.js';
import {
  FUND_MIC, alphaVantageCovers, fetchHistory, fetchQuote, fetchQuoteAV, fetchRate, fetchRateRange,
  fundHistory, fundQuote, today,
} from './market.js';
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, convert, investmentValueFrom, newId, rateFor } from './model.js';
import {
  accountTotals, forgetLegacyData, hasPendingChanges, legacyData, load, needsSchemaUpdate, onSaved,
  onStatus, persist, refreshSummaries, settle, transactionsComplete,
} from './store.js';
import { counted, mainAccount, openAccountDialog, renderAccount, renderWelcome } from './accounts.js';
import { adoptGoogleDrive, backupBanner, backupToDrive, driveBackupDue, driveOn } from './backups.js';
import { openTxDialog } from './entry.js';
import { answers, ask, recordSnapshot, renderInsights, sinceYesterday } from './insights.js';
import { renderIous } from './ious.js';
import { renderOverview } from './overview.js';
import { openPalette } from './palette.js';
import { FORECAST_DAYS, daysFromToday, renderSchedules, resetSubscriptionIndex } from './schedules.js';
import { renderSettings, renderSettingsNav } from './settings.js';
import {
  fetchTransactions, focusTransaction, listViews, renderSearch, renderWhenIdle, selected, setDescCache,
  setIouByTx,
} from './transactions.js';
import {
  FIN_SHAPE, button, field, h, hideAmounts, icon, input, isPhone, latestRate, main, money,
  pageLoader, readPref, say, setHideAmountsValue, setHueOrder, side, svgEl, tone, wavePath,
  writePref,
} from './ui.js';

// Set once the signed-in user's data has loaded (see boot() at the bottom).
export let state = null;
// view: { name: 'account', id } | { name: 'settings' }
// Each main section is its own page, with its own address: …/finance/ (the overview), ?page=search
// (&q=… to search for something), ?page=settings&section=backup, ?account=<id>&tab=insights, and
// ?account= for the last account opened. Going to another section loads that page, so its data is
// fresh; within a page (accounts, settings pages) it's instant.
export const BASE_PATH = '/tools/finance/';
export const PAGES = ['overview', 'search', 'scheduled', 'insights', 'assets', 'ious', 'settings'];
export const sectionOf = (v) => (v.name === 'account' ? 'accounts' : v.name);
export function urlOf(v) {
  const q = new URLSearchParams();
  if (v.name === 'account') {
    q.set('account', v.id ?? '');
    if (v.tab === 'insights' || v.tab === 'ahead') q.set('tab', v.tab);
    // A transaction to show (the other side of a transfer, opened from another page).
    if (v.tx) { q.set('tx', v.tx); q.set('on', v.on ?? ''); }
  } else if (v.name !== 'overview') {
    q.set('page', v.name);
    if (v.name === 'settings' && v.section) q.set('section', v.section);
    if (v.name === 'settings' && v.section === 'import' && v.kind) q.set('kind', v.kind);
    if (v.name === 'insights' && (v.tab === 'networth' || v.tab === 'goals')) q.set('tab', v.tab);
    if (v.name === 'scheduled' && v.tab === 'subscriptions') q.set('tab', 'subscriptions');
    if (v.name === 'ious' && v.personId) q.set('person', v.personId);
    if (v.name === 'search') {
      if (v.q) q.set('q', v.q);
      // Its filters, when opened with some (a category's transactions, from Insights).
      if (v.cats?.length) q.set('cats', v.cats.join(','));
      if (v.types?.length) q.set('types', v.types.join(','));
      if (v.accounts?.length) q.set('accounts', v.accounts.join(','));
      if (v.from) q.set('from', v.from);
      if (v.to) q.set('to', v.to);
    }
  }
  const s = q.toString();
  return s ? `${BASE_PATH}?${s}` : BASE_PATH;
}
export function viewFromUrl() {
  const q = new URLSearchParams(location.search);
  const page = q.get('page');
  // Net worth was its own page; it's now a tab of Insights (old links still land there).
  if (page === 'networth' || (page === 'insights' && q.get('tab') === 'networth')) return { name: 'insights', tab: 'networth' };
  if (page === 'insights' && q.get('tab') === 'goals') return { name: 'insights', tab: 'goals' };
  // The imports were separate settings pages; they're now one, with a kind (old links still work).
  const oldImport = { buxfer: 'buxfer', ft: 'holdings' }[q.get('section')];
  if (page === 'settings' && oldImport) return { name: 'settings', section: 'import', kind: oldImport };
  if (PAGES.includes(page)) {
    return {
      ...(page === 'settings' && q.get('kind') && { kind: q.get('kind') }),
      ...(page === 'scheduled' && q.get('tab') === 'subscriptions' && { tab: 'subscriptions' }),
      name: page, ...(q.get('section') && { section: q.get('section') }), ...(q.get('person') && { personId: q.get('person') }),
      ...(page === 'search' && q.get('q') && { q: q.get('q') }),
      ...(page === 'search' && ['cats', 'types', 'accounts'].some((k) => q.has(k)) && {
        cats: q.get('cats')?.split(',') ?? [], types: q.get('types')?.split(',').filter(Boolean) ?? [],
        accounts: q.get('accounts')?.split(',').filter(Boolean) ?? [],
      }),
      ...(page === 'search' && q.get('from') && { from: q.get('from') }),
      ...(page === 'search' && q.get('to') && { to: q.get('to') }),
    };
  }
  if (q.has('account')) {
    return {
      name: 'account', id: q.get('account'), ...((q.get('tab') === 'insights' || q.get('tab') === 'ahead') && { tab: q.get('tab') }),
      ...(q.get('tx') && { tx: q.get('tx'), on: q.get('on') }),
    };
  }
  return { name: 'overview' };
}
export let view = viewFromUrl();
export let shownView = view; // what's on screen, to fall back on if leaving the page is cancelled
export let pageSection = null; // the section this page was loaded for, once loaded
export let leaving = false;
// Leaves for another page: sends what's waiting to be saved first. `ask`: confirm before dropping
// something typed here but not saved (from the header tabs; actions that move on have saved already).
export async function leave(url, { ask = false } = {}) {
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
export let editingTxId = null;
export const TX_PAGE_SIZE = 100;
export let txPage = 0; // 0 = the newest 100; reset when another account is selected
export const collapsed = new Set(readPref('finance:collapsed', ['archived'])); // the archive starts closed

// ── rates and prices ─────────────────────────────────────────────────────────

export async function ensureRate(currency, date) {
  const known = rateFor(currency, state.rates, date);
  if (known != null) return known;
  try {
    const rate = await fetchRate(currency, date);
    state.rates[`${currency}:${date}`] = rate;
    return rate;
  } catch { return null; }
}

export async function refreshRates() {
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
// instead of disappearing. Asked for, the outcome also shows as a toast, naming what failed; `quiet`
// (the refresh when the page opens) only announces it to screen readers.
// Where each holding's price refresh is, for its row in the holdings table: 'waiting' its turn or
// 'loading'; and when it was updated, so its row flashes once (carried on across redraws).
export const priceStatus = new Map();
export const priceUpdatedAt = new Map();
export const refreshingPrices = () => [...priceStatus.values()].some((s) => s === 'waiting' || s === 'loading');

export async function refreshPrices(only, { quiet = false } = {}) {
  const targets = (only ?? state.holdings).filter((x) => !['waiting', 'loading'].includes(priceStatus.get(x.id)));
  if (!targets.length) return;
  say(`Fetching ${targets.length === 1 ? 'the price' : `${targets.length} prices`}…`);
  const mark = (x, status) => { if (status) priceStatus.set(x.id, status); else priceStatus.delete(x.id); renderWhenIdle(); };
  for (const x of targets) priceStatus.set(x.id, 'waiting');
  renderWhenIdle();
  const failed = [];
  for (const x of targets) {
    mark(x, 'loading');
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
      priceUpdatedAt.set(x.id, Date.now());
      mark(x, null);
    } catch (err) {
      failed.push(x);
      x.priceError = err.message;
      mark(x, null);
    }
  }
  persist();
  await refreshRates(); // a quote may be in a currency we have no rate for yet
  renderWhenIdle();
  const updated = targets.length - failed.length;
  const message = !failed.length ? `Prices updated for ${targets.length === 1 ? targets[0].symbol : `all ${targets.length} holdings`}.`
    : `${updated ? `Prices updated for ${updated} of ${targets.length} holdings. ` : ''}No new price for ${failed.map((x) => `${x.symbol} (${x.priceError.replace(/\s*Consider upgrading.*$/i, '')})`).join(', ')}.`;
  say(message);
  // The rows show each update as it lands; a message only when something didn't come through.
  if (!quiet && failed.length) showToast(message, [], { timeout: 20000 });
}

// Prices from an earlier day are refreshed when the page opens (needs the API key).
// Weekly price history: loaded on request per holding, then kept up to date once a week.
export const latestClose = (x) => Object.keys(x.priceHistory ?? {}).sort().at(-1) ?? null;
export const historyStale = (x) => latestClose(x) && latestClose(x) < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

export async function loadHistory(list) {
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

export function stalePrices() {
  const priced = (x) => (x.mic === FUND_MIC ? Boolean(state.settings.eodhdApiKey) : Boolean(state.settings.quoteApiKey || state.settings.avApiKey));
  return state.holdings.filter((x) => !x.manual && priced(x) && (!x.priceAt || x.priceAt.slice(0, 10) !== today() || x.priceError));
}
// Runs the database's fund_data (EODHD for funds; see market.js).
export const fundCall = (args) => rpc('fund_data', args);

// ── values ───────────────────────────────────────────────────────────────────

// Each account's totals as the database counted them plus any change made here since (store.js),
// worked out once per render. Balances count what has happened: transactions dated after today wait
// greyed out above the list.
export let totalsCache = null;
export function totalsOf(accountId) {
  totalsCache ??= accountTotals(today(), daysFromToday(FORECAST_DAYS));
  return totalsCache.get(accountId) ?? { balance: 0, count: 0, past: 0, planned: 0, plannedCount: 0 };
}
export function accountValue(account) {
  const invested = totalsOf(account.id).balance;
  return account.type === 'investment'
    ? investmentValueFrom(account, state.holdings, invested, (c) => latestRate(c) ?? 1).total
    : invested;
}

// Group total in EUR. Accounts still waiting for a rate are left out and counted.
export function groupTotal(list) {
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
export const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// Net worth in EUR; accounts still waiting for a rate are left out and counted.
export function netWorthNow() {
  const nw = { total: 0, unconverted: 0 };
  for (const a of state.accounts) {
    if (a.archived || !counted(a)) continue;
    const rate = latestRate(a.currency);
    if (rate == null) nw.unconverted += 1;
    else nw.total += convert(accountValue(a), rate);
  }
  return nw;
}

export function renderSide() {
  const nw = netWorthNow();
  const since = sinceYesterday();
  const day = since?.day;
  const dayText = since?.text ?? '';
  return [
    // The net-worth card opens its own page (net worth over time and by account type), with how it
    // changed since yesterday under the figure.
    h('button', {
      type: 'button', class: 'fin-side-head fin-side-head--link', 'data-key': 'networth',
      'aria-current': view.name === 'insights' && view.tab === 'networth' ? 'page' : null,
      'aria-label': `Net worth ${money(nw.total, 'EUR')}${dayText ? `, ${dayText}` : ''}. See it over time`,
      onclick: () => { view = { name: 'insights', tab: 'networth' }; render('networth'); say('Net worth.'); },
    },
      h('span', { class: 'fin-side-title' }, 'Net worth'),
      h('span', { class: 'fin-num' }, money(nw.total, 'EUR')),
      dayText && h('span', { class: `fin-side-day${day > 0 ? ' is-up' : day < 0 ? ' is-down' : ''}` },
        day !== 0 && h('span', { 'aria-hidden': 'true' }, day > 0 ? '▲ ' : '▼ '), dayText)),
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

// Phones: the Accounts tab is a page of its own, the side panel's list (net worth on top), and
// picking an account opens it, with a way back at the top (backToAccounts).
export function accountsPage() {
  return h('div', {},
    h('div', { class: 'fin-account-head' }, h('h2', { class: 'fin-title', id: 'accounts-h', tabindex: '-1', 'data-key': 'accounts-h' }, 'Accounts')),
    h('div', { class: 'fin-side-list' }, renderSide().flat().filter(Boolean))); // its groups come as a list in the list
}
// Shown on phones only (CSS), above an account.
export const backToAccounts = () => h('button', {
  type: 'button', class: 'fin-back', 'data-key': 'back-accounts',
  onclick: () => { view = { name: 'account', id: '' }; editingTxId = null; render('accounts-h'); window.scrollTo(0, 0); },
}, h('span', { 'aria-hidden': 'true' }, '‹ '), 'Accounts');

// Credit card networks, and a small mark for each beside the card's name (simple drawings of the
// brands' marks, not their artwork). Screen readers get the network's name.
export const CARD_NETWORKS = { visa: 'Visa', mastercard: 'Mastercard' };
export function cardMark(account, extra = '') {
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
export function limitUse(account, value) {
  if (account.type !== 'credit' || account.creditLimit == null) return null;
  const used = account.creditLimit > 0 ? Math.min(100, Math.max(0, Math.round((-value / account.creditLimit) * 100))) : 100;
  return { used, level: used >= 90 ? 'high' : used >= 60 ? 'mid' : 'low', left: account.creditLimit + value };
}
export function usageBar(use, extra = '') {
  const bar = h('span', { class: 'fin-usage-bar', 'data-level': use.level });
  bar.style.setProperty('--used', `${use.used}%`);
  return h('span', { class: `fin-usage ${extra}`.trim(), 'aria-hidden': 'true' }, bar);
}

export function accountGroup(key, label, total, list) {
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
          h('span', { class: 'fin-account-name' }, cardMark(a), a.name,
            a.isMain && h('span', { class: 'fin-main-mark', title: 'Main account' }, h('span', { 'aria-hidden': 'true' }, '★'), h('span', { class: 'fin-sr' }, ', main account'))),
          // No + on positive balances here: less text, and the negative ones (in red) stand out.
          h('span', { class: `fin-num ${tone(value)}${counted(a) ? '' : ' fin-uncounted'}`, title: counted(a) ? null : 'Not in totals' }, money(value, a.currency),
            !counted(a) && h('span', { class: 'fin-sr' }, ', not in totals')),
          // A credit card with a limit: a thin bar of how much is used (said in words for screen readers).
          use && usageBar(use, 'fin-usage-side'),
          use && h('span', { class: 'fin-sr' }, `, ${use.used}% of the credit limit used`)));
    })));
}

export function selectAccount(id) {
  if (view.id !== id) { txPage = 0; selected.clear(); }
  // Stay on Insights when moving between accounts, so they're easy to compare.
  view = { name: 'account', id, tab: view.name === 'account' ? view.tab : undefined };
  editingTxId = null;
  state.settings.lastAccountId = id;
  persist();
  render();
  if (isPhone()) window.scrollTo(0, 0); // from the Accounts page: start at the top of the account
  say(`Showing ${state.accounts.find((a) => a.id === id)?.name}.`);
}

// ── messages with actions (Undo, rule offers) ────────────────────────────────

export let toastTimer = null;
export let toastUndo = null;
// One message at a time at the bottom of the screen, with optional buttons. It stays ~10 s, or
// until replaced. Undo is also on Ctrl/⌘+Z while the message shows.
export function showToast(message, actions = [], { timeout = 10000, undo = null } = {}) {
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
export function undoable(message, tables, change) {
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
export function deleteTransactions(ids) {
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

// ── shell ────────────────────────────────────────────────────────────────────

// Re-rendering replaces the DOM, so keep keyboard focus on the element with the same data-key.
export function render(focusKey) {
  // Moving to another main section loads its own page (fresh data, nothing carried over).
  if (pageSection && sectionOf(view) !== pageSection) {
    const target = urlOf(view);
    view = shownView;
    leave(target);
    return;
  }
  const key = focusKey ?? document.activeElement?.dataset?.key;
  if (view.name === 'account' && view.tx) focusTransaction();
  totalsCache = null;
  setIouByTx(null);
  resetSubscriptionIndex();
  setHueOrder(null);
  const account = view.name === 'account' && state.accounts.find((a) => a.id === view.id);
  // On a phone, an account view without one is the Accounts page (the list); elsewhere, the first.
  if (view.name === 'account' && !account && state.accounts[0] && !(isPhone() && !view.id)) view = { name: 'account', id: state.accounts[0].id };
  const current = view.name === 'account' && state.accounts.find((a) => a.id === view.id);

  document.querySelectorAll('[data-nav]').forEach((b) => {
    const on = b.dataset.nav === (view.name === 'account' ? 'accounts' : view.name);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const inSettings = view.name === 'settings';
  // The More tab stands for the sections in its menu.
  moreBtn.classList.toggle('is-on', ['assets', 'scheduled', 'ious'].includes(view.name));
  // Settings live in the avatar's menu, so the avatar shows when you're in them.
  meBtn.classList.toggle('is-on', inSettings);
  document.body.dataset.view = view.name; // phones show the side panel's button only in Settings
  // The panel's button is for the panel; on a phone it isn't used (Accounts and Settings are lists).
  sideToggle.hidden = isPhone();
  if (isPhone()) side.classList.remove('is-open');
  if (!side.classList.contains('is-open')) sideToggle.textContent = inSettings ? 'Settings menu' : 'Accounts';
  side.setAttribute('aria-label', inSettings ? 'Settings' : 'Accounts');
  // On a phone the accounts and the settings pages are pages of their own (accountsPage, and
  // renderSettings' list), so the hidden panel stays empty: no second copy of its buttons for focus.
  side.replaceChildren(...(isPhone() ? [] : inSettings ? renderSettingsNav() : renderSide()).flat().filter(Boolean));
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
          : view.name === 'assets' ? renderAssets()
        : view.name === 'account' && isPhone() && !view.id ? accountsPage()
        : current ? h('div', {}, backToAccounts(), renderAccount(current)) : renderWelcome());
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
export function legacyBanner() {
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

export const syncEl = document.getElementById('sync');
export const layout = document.querySelector('.fin-layout');

// Before sign-in only the main column shows; the account panel and the header controls appear after.
export function setShell(signedIn) {
  if (!signedIn) { openMe(false); openMore(false); }
  side.hidden = !signedIn;
  layout.classList.toggle('fin-layout--solo', !signedIn);
  document.querySelectorAll('[data-nav], #sync, #fab, #side-toggle, #hide-amounts, #cmd-open, #me, #tabbar').forEach((el) => { el.hidden = !signedIn; });
}

// The screens before the app (sign in, check your email, setup, a loading error): a card in the
// middle of the page (the header has the logo), on a sea along the bottom with fins in it.
export function screen(title, ...body) {
  setShell(false);
  main.replaceChildren(h('div', { class: 'fin-screen' },
    h('div', { class: 'fin-screen-card' },
      h('p', { class: 'fin-tagline-screen' }, 'Take care of your Finances'),
      h('h2', { class: 'fin-title', tabindex: '-1', id: 'screen-h' }, title), ...body),
    seaScene()));
}

// The sea along the bottom of those screens (decoration): three rolling waves, two small fins far
// off on the back one, and a big one cruising across on the middle one. Still when motion is reduced.
export function seaScene() {
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

export function renderSetupNeeded() {
  screen('Connect a database',
    h('p', { class: 'fin-empty' }, 'Your data is stored in your own Supabase project, so you can reach it from any device. Fill in tools/finance/config.js with the project URL and anon key, then reload. The steps are in tools/finance/README.md.'));
}

export function renderSignIn(message) {
  const email = input({ type: 'email', required: true, autocomplete: 'email' });
  const note = h('p', { class: message ? 'fin-error' : 'fin-hint', role: message ? 'alert' : null }, message ?? '');
  const fail = (msg) => {
    note.className = 'fin-error';
    note.setAttribute('role', 'alert');
    note.textContent = msg;
  };
  // With a Google client ID (config.js), "Sign in with Google" comes first; the email link stays
  // for when Google can't be used. Both reach the same account when the email is the same.
  const google = driveConfigured() && h('div', { class: 'fin-signin-google' },
    h('div', { class: 'fin-google-btn' }),
    h('p', { class: 'fin-or', 'aria-hidden': 'true' }, h('span', {}, 'or by email')));
  screen('Sign in to Fin',
    h('p', { class: 'fin-empty' }, google
      ? 'Sign in with Google, or get a link by email to open on this device. No password needed.'
      : 'We’ll email you a link. Open it on this device to sign in. No password needed.'),
    google,
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
          fail(err.message);
          submit.disabled = false;
        }
      },
    },
      field('Email', email), note,
      h('button', { type: 'submit', class: `fin-btn ${google ? 'secondary' : 'btn-primary'}` }, 'Email me a sign-in link')));
  if (google) {
    const dark = document.documentElement.dataset.theme === 'dark'
      || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    renderGoogleButton(google.querySelector('.fin-google-btn'), {
      dark,
      onToken: async (idToken, nonce) => {
        try {
          await signInWithGoogle(idToken, nonce);
          boot();
        } catch (err) {
          fail(`Google sign-in didn’t work: ${err.message}`);
        }
      },
    }).catch(() => { google.hidden = true; }); // Google unreachable: the email link still works
  }
  // With Google first, start at the heading rather than in the email box.
  (google ? document.getElementById('screen-h') : email).focus();
}

export const STATUS_TEXT = { saved: 'All changes saved', saving: 'Saving…', error: 'Not saved yet, retrying' };
onStatus((s, err) => {
  if (err instanceof SignedOut) { renderSignIn('Your session ended. Sign in again; unsaved changes on this page will be lost.'); return; }
  syncEl.textContent = STATUS_TEXT[s];
  syncEl.title = err?.message ?? '';
  syncEl.dataset.state = s;
});

// No page loads every transaction up front: each asks the database for what it shows, the IOUs
// page for the transactions its entries are linked to, and the tools that need them all (backup,
// export, imports, categories, rules) load them when opened.
export async function loadData() {
  state = await load({ today: today(), until: daysFromToday(FORECAST_DAYS) });
  if (sectionOf(view) === 'ious') {
    const ids = [...new Set(state.ious.map((e) => e.transactionId).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 100) {
      const list = ids.slice(i, i + 100).map((id) => `"${id.replace(/"/g, '\\"')}"`).join(',');
      await fetchTransactions(() => selectAll('transactions', 'id', `&id=in.(${encodeURIComponent(list)})`));
    }
  }
  // On an account page: the one in the address, else the last one opened, else the first.
  if (view.name === 'account' && !state.accounts.some((a) => a.id === view.id) && !(isPhone() && !view.id)) {
    view = { name: 'account', id: state.settings.lastAccountId ?? state.accounts[0]?.id, tab: view.tab };
  }
}

export async function boot() {
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
  paintMe();
  syncEl.textContent = STATUS_TEXT.saved;
  const add = new URLSearchParams(location.search).has('add');
  pageSection = sectionOf(view);
  render(); // also tidies the address (drops ?add)
  // Opened from the app's "Add transactions" shortcut (…/?add): go straight to quick entry.
  if (add) quickAdd();
  await refreshRates();
  await refreshPrices(stalePrices(), { quiet: true });
  recordSnapshot();
  // Once a day a backup goes to Google Drive by itself, when it's connected in this browser (or,
  // signed in with Google, when that account already gave Drive the permission).
  await adoptGoogleDrive();
  if (driveOn() && driveBackupDue()) await backupToDrive();
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
  setDescCache(null);
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
export const hideToggle = document.getElementById('hide-amounts');
export function showHidden() {
  hideToggle.setAttribute('aria-pressed', String(hideAmounts));
  hideToggle.title = hideAmounts ? 'Show amounts (Alt+H)' : 'Hide amounts (Alt+H)';
  document.body.classList.toggle('fin-amounts-hidden', hideAmounts);
}
export function setHideAmounts(on) {
  setHideAmountsValue(on);
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

// ── You: who's signed in, in the header ──────────────────────────────────────

// Name, email and photo of whoever is signed in. Signing in with Google brings the name and photo
// (Supabase keeps them in user_metadata); with the email link there's only the email.
export function profile() {
  const u = currentUser() ?? {};
  const m = u.user_metadata ?? {};
  return { name: m.full_name || m.name || '', email: u.email ?? '', photo: m.avatar_url || m.picture || '' };
}
// The photo, or the initials in a circle when there's none or it doesn't load. Decoration: the
// name is always written next to it or in the button's label.
export function avatar(p, size) {
  const words = (p.name || p.email).split(/[\s@._-]+/).filter(Boolean);
  const initials = h('span', { class: 'fin-avatar fin-avatar--initials', 'data-size': String(size), 'aria-hidden': 'true' },
    (p.name ? words.slice(0, 2).map((w) => w[0]) : [words[0]?.[0] ?? '?']).join('').toUpperCase());
  if (!p.photo) return initials;
  // no-referrer: Google's photo addresses can refuse requests that say where they come from.
  const img = h('img', { class: 'fin-avatar', src: p.photo, alt: '', width: String(size), height: String(size), referrerpolicy: 'no-referrer', 'data-size': String(size) });
  img.addEventListener('error', () => img.replaceWith(initials));
  return img;
}

// The avatar button opens a small menu: who you are, Settings (all of them), and Sign out.
// Esc, a click outside or tabbing away closes it; ↓/↑ move between its items.
export const meWrap = document.getElementById('me');
export const meBtn = document.getElementById('me-btn');
export const meMenu = document.getElementById('me-menu');
export function openMe(on) {
  meMenu.hidden = !on;
  meBtn.setAttribute('aria-expanded', String(on));
}
export function paintMe() {
  const p = profile();
  meBtn.replaceChildren(avatar(p, 32));
  meBtn.setAttribute('aria-label', `Your account, ${p.name || p.email || 'signed in'}`);
  meBtn.title = p.name && p.email ? `${p.name} (${p.email})` : p.name || p.email;
  const item = (label, run) => h('button', { type: 'button', class: 'fin-me-item', onclick: () => { openMe(false); run(); } }, label);
  meMenu.replaceChildren(
    h('div', { class: 'fin-me-who' }, avatar(p, 40),
      h('div', { class: 'fin-me-names' }, p.name && h('strong', {}, p.name), p.email && h('span', { class: 'fin-sub' }, p.email))),
    // On phones the header keeps only the logo, save status and this button, so Go to and Hide
    // amounts move in here (CSS shows them on phones only).
    h('button', { type: 'button', class: 'fin-me-item fin-me-phone', onclick: () => { openMe(false); openPalette(); } }, 'Go to…'),
    h('button', { type: 'button', class: 'fin-me-item fin-me-phone', onclick: () => { openMe(false); setHideAmounts(!hideAmounts); } },
      hideAmounts ? 'Show amounts' : 'Hide amounts'),
    h('button', {
      type: 'button', class: 'fin-me-item', 'aria-current': view.name === 'settings' ? 'page' : null,
      onclick: () => { openMe(false); view = { name: 'settings' }; render(); },
    }, 'Settings'),
    item('Sign out', () => signOutNow()));
}
meBtn.addEventListener('click', () => {
  if (meMenu.hidden) paintMe(); // "Hide amounts" or "Show amounts", as it is now
  openMe(meMenu.hidden);
  if (!meMenu.hidden) [...meMenu.querySelectorAll('.fin-me-item')].find((b) => b.offsetParent)?.focus();
});
meMenu.addEventListener('keydown', (e) => {
  const items = [...meMenu.querySelectorAll('.fin-me-item')].filter((b) => b.offsetParent);
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); openMe(false); meBtn.focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
export const closeMeOutside = (e) => { if (!meMenu.hidden && !meWrap.contains(e.target)) openMe(false); };
document.addEventListener('mousedown', closeMeOutside);
document.addEventListener('focusin', closeMeOutside);

// The tab bar's More: a menu above it with the sections that don't fit (Assets, Scheduled, IOUs).
export const moreBtn = document.getElementById('more-btn');
export const moreMenu = document.getElementById('more-menu');
export function openMore(on) {
  moreMenu.hidden = !on;
  moreBtn.setAttribute('aria-expanded', String(on));
}
moreBtn.addEventListener('click', () => {
  openMore(moreMenu.hidden);
  if (!moreMenu.hidden) moreMenu.querySelector('a')?.focus();
});
moreMenu.addEventListener('keydown', (e) => {
  const items = [...moreMenu.querySelectorAll('a')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); openMore(false); moreBtn.focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
export const closeMoreOutside = (e) => { if (!moreMenu.hidden && !moreBtn.parentElement.contains(e.target)) openMore(false); };
document.addEventListener('mousedown', closeMoreOutside);
document.addEventListener('focusin', closeMoreOutside);
// Turning the phone (or resizing the window) across the phone width switches layouts.
matchMedia('(max-width: 52rem)').addEventListener('change', () => { if (state) render(); });

// Pull to refresh, in the installed app on a touch screen (browsers have their own): pulling down
// from the top of the page reloads it, sending what's waiting to be saved first. A circle follows
// the finger and turns when far enough.
export const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (standalone && matchMedia('(pointer: coarse)').matches) {
  const PULL = 80;
  const ptr = h('div', { class: 'fin-ptr', 'aria-hidden': 'true' },
    svgEl('svg', { class: 'fin-icon', viewBox: '0 0 24 24' }, svgEl('path', { d: 'M12 5v13M6 12l6 6 6-6' })));
  document.body.append(ptr);
  let startY = null;
  let pulled = 0;
  addEventListener('touchstart', (e) => {
    const busy = window.scrollY > 0 || e.touches.length !== 1 || document.querySelector('dialog[open]')
      || e.target.closest('input, textarea, select, .fin-options, .fin-ms-menu, .fin-me-menu, .fin-more-menu, .fin-tabbar');
    startY = busy || !state ? null : e.touches[0].clientY;
    pulled = 0;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (startY == null) return;
    pulled = window.scrollY > 0 ? 0 : Math.max(0, e.touches[0].clientY - startY);
    ptr.style.setProperty('--pull', `${Math.min(pulled, PULL * 1.5)}px`);
    ptr.classList.toggle('is-pulling', pulled > 8);
    ptr.classList.toggle('is-ready', pulled >= PULL);
  }, { passive: true });
  addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null;
    ptr.classList.remove('is-pulling');
    if (pulled < PULL) { ptr.classList.remove('is-ready'); return; }
    ptr.classList.add('is-loading');
    say('Reloading…');
    await leave(location.href, { ask: true });
    // Still here: leaving was cancelled (something typed isn't saved).
    setTimeout(() => { if (!leaving) ptr.classList.remove('is-loading', 'is-ready'); }, 1200);
  });
}

// ── phone: account panel toggle, floating add button, installable app ────────

export const sideToggle = document.getElementById('side-toggle');
// On small screens the account panel is folded away behind a button; opening an account folds it again.
export function setSideOpen(open) {
  side.classList.toggle('is-open', open);
  sideToggle.setAttribute('aria-expanded', String(open));
  sideToggle.textContent = open ? 'Hide accounts' : view.name === 'settings' ? 'Settings menu' : 'Accounts';
}
sideToggle.addEventListener('click', () => setSideOpen(!side.classList.contains('is-open')));
side.addEventListener('click', (e) => { if (e.target.closest('.fin-account, .fin-side-head--link')) setSideOpen(false); });

// Quick entry for the account on screen, else the main account, else the last one used.
export function quickAdd() {
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

export async function signOutNow() {
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
export function hasUnsavedInput() {
  return [...document.querySelectorAll('#app input, #app textarea, #app select')].some((el) => {
    if (el.type === 'search' || el.type === 'file' || el.closest('[role="search"]')) return false;
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
    if (el.tagName === 'SELECT') return [...el.options].some((o) => o.selected !== o.defaultSelected);
    return el.value !== el.defaultValue;
  });
}

boot();

export const setView = (v) => { view = v; };
export const setEditingTxId = (v) => { editingTxId = v; };
export const setTxPage = (v) => { txPage = v; };
