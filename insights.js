// Insights (income, spending, categories over a period) and net worth over time.

import { rpc, selectAll } from './cloud.js';
import { today } from './market.js';
import {
  ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, DIVIDENDS, LOCKED_KINDS, PERIODS, REFUNDS_UNMATCHED,
  completeMonths, convert, historyPoints, holdingValue, insightsFrom, investedHistory, lotFlows,
  lotSummary, netWorthHistory, periodRange, returnSummary,
} from './model.js';
import { missingTables, persist, transactionsComplete } from './store.js';
import { counted } from './accounts.js';
import { accountValue, latestClose, loadHistory, render, setView, state, totalsOf, view } from './app.js';
import { assetsInEur } from './assets.js';
import { pageLink } from './overview.js';
import { chartTip, lotsOfHolding, timeChart } from './holdings.js';
import { fetchTransactions, ratesArg, renderWhenIdle } from './transactions.js';
import {
  button, catLabel, category, field, h, hideAmounts, icon, input, isPhone, latestRate, loader,
  money, monthLabel, num, numLocale, readPref, say, select, fullDate, shortDate, shownQty, signed,
  tone, writePref,
} from './ui.js';

// ── insights ─────────────────────────────────────────────────────────────────

export let insightsPeriod = readPref('finance:period', { preset: 'this-month' });
// The Net worth tab counting everything, also what's left out of totals (renderNetWorth).
let netWorthAll = readPref('finance:nw-all', false);
export const compactEUR = (minor) => (hideAmounts ? '•••'
  : new Intl.NumberFormat(numLocale(), { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100));

export function bucketLabel(key, unit, multiYear) {
  if (unit === 'year') return key;
  if (unit === 'month') {
    return new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, multiYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
  }
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
export const bucketTitle = (key, unit) =>
  unit === 'week' ? `Week of ${shortDate(key)}` : unit === 'month' ? monthLabel(key) : unit === 'year' ? key : shortDate(key);

// Period picker: presets plus a custom range. Remembered on this device.
export function periodControls(range) {
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
    h('p', { class: 'fin-period-range' }, `${shortDate(range.from)} – ${shortDate(range.to)}`));
}

// Income and spending per bucket as paired columns. One y-axis from 0; a readout above the plot
// shows the hovered or focused bucket, and the same numbers are in the table below the chart.
export function incomeSpendChart(r) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  // On a phone, drawn for its narrow width (so it fits without scrolling), with fewer date labels.
  const narrow = isPhone();
  const W = narrow ? 380 : 760; const H = 230; const L = 52; const R = 8; const T = 10; const B = 26;
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
  const every = Math.ceil(series.length / (narrow ? 6 : 12)); // at most ~12 x labels (6 on a phone)
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
export const DONUT_SLOTS = 7;
export function donutChart(title, slices, total, { share }) {
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
// `search(ids, types)` gives the search showing a row's transactions in the period (null: none).
export function categoryBreakdown(title, rows, total, search = null) {
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
  // A row's name opens its transactions (not the row of an opening list, whose name opens it, nor a
  // parent's own part, without a category of its own to search for).
  const searchOf = (id) => {
    if (!search || id === REFUNDS_UNMATCHED) return null;
    return id === DIVIDENDS ? search([], ['dividend']) : search([id ?? '']);
  };
  const line = (id, amount, child = false, { linked = true } = {}) => h('div', { class: `fin-break-row fin-break-row--dot${child ? ' fin-break-child' : ''}` },
    child ? h('span', { 'aria-hidden': 'true' }) : dot(slotOf(id)),
    (() => {
      const label = child ? (category(id)?.name ?? name(id)) : name(id);
      const to = linked && searchOf(id);
      return to
        ? pageLink(label, to, 'fin-break-name fin-break-link')
        : h('span', { class: 'fin-break-name' }, label);
    })(),
    h('span', { class: 'fin-num fin-break-amt' }, money(amount, 'EUR')),
    h('span', { class: 'fin-num fin-break-pct fin-muted' }, share(amount)));
  return h('section', { class: 'fin-card fin-pad', 'aria-label': title },
    h('h3', { class: 'fin-label' }, title),
    rows.length === 0 ? h('p', { class: 'fin-empty' }, 'Nothing in this period.') : [
      slices.length > 0 && donutChart(title, slices, total, { share }),
      h('ul', { class: 'fin-break' }, rows.map((c) => h('li', {},
        c.children.length
          ? h('details', {},
            h('summary', {}, line(c.id, c.amount, false, { linked: false })),
            h('div', { class: 'fin-break-children' }, c.children.map((k) => line(k.id, k.amount, true)),
              c.amount - c.children.reduce((x, k) => x + k.amount, 0) !== 0 &&
                line(null, c.amount - c.children.reduce((x, k) => x + k.amount, 0), true, { linked: false }),
              searchOf(c.id) && h('p', { class: 'fin-break-all' }, pageLink(`See all of ${name(c.id)}`, searchOf(c.id), 'fin-link fin-link-sm'))))
          : line(c.id, c.amount)))),
    ]);
}

// What investments are made of today: a donut by holding (the biggest seven, the rest as Other) or
// by currency, over the list with each one's value and share. `holdings` can span several accounts.
export let allocationBy = 'holding'; // or 'currency'; kept while the page is open
export function allocationCard(holdings, key) {
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
export const answers = new Map();
export function ask(name, args) {
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
export function insightsFor(range, accountIds, onlyCategory = null) {
  const totals = ask('insight_totals', {
    p_from: range.from, p_to: range.to, p_accounts: accountIds ? [...accountIds] : null, p_only: onlyCategory, p_rates: ratesArg(),
  });
  return totals && insightsFrom(totals, { ...range, categories: state.categories });
}

// `spendingOnly` (credit cards): just spending, no income, net or savings. `balanceOf` (an account's
// own tab): its balance over the period, after the cards and before the other charts.
export function insightsPanel(accountIds, { spendingOnly = false, balanceOf = null } = {}) {
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
  const searchFor = (cats, types) => ({
    name: 'search', cats, types, accounts: accountIds ? [...accountIds] : [], from: range.from, to: range.to, // the same period as the totals
  });
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
          // Each category opens its transactions in the period (in these accounts) as search results;
          // uncategorised ones only of the card's own kind.
          categoryBreakdown('Spending by category', r.spending, r.expenses, (ids, types) => searchFor(ids, types ?? (ids[0] === '' ? ['expense', 'refund'] : []))),
          !spendingOnly && categoryBreakdown('Income by category', r.earning, r.income, (ids, types) => searchFor(ids, types ?? (ids[0] === '' ? ['income'] : [])))),
      ],
    h('p', { class: 'fin-hint fin-mt' }, 'Transfers between your accounts and opening balances aren’t counted. Loans and repayments count only what isn’t owed back, refunds lower spending (in their first category that isn’t an income one, like a salary), and a transaction with several categories counts under its first one.'));
}

// An account's balance over a period, in its own currency, at the end of each day, week or month
// (from the database's balances_at), up to today.
export function balanceChart(account, range) {
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
export function previousRange({ from, to }) {
  const day = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
  return { from: day(from, -days), to: day(from, -1) };
}
export const prevLabel = ({ from, to }) => `${fullDate(from)} – ${fullDate(to)}`;
// "+12% vs 1 Jan 2025 – 31 Dec 2025", "new", or "same as …".
export function versus(now, before, prevRange) {
  if (!before) return now ? `nothing in ${prevLabel(prevRange)}` : '';
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  return pct === 0 ? `same as ${prevLabel(prevRange)}` : `${pct > 0 ? '+' : ''}${pct}% vs ${prevLabel(prevRange)}`;
}

// One series as columns from a zero baseline (no legend: the heading names it). Hover or focus a
// column for its value; the table under it has every value.
export function singleColumns(series, unit, range, label) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const narrow = isPhone(); // drawn for a phone's width there, as incomeSpendChart
  const W = narrow ? 380 : 760; const H = 200; const L = 52; const R = 8; const T = 10; const B = 26;
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
  const every = Math.ceil(series.length / (narrow ? 6 : 12));
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
export function renderInsights() {
  const worth = view.tab === 'networth';
  const pick = (t) => { setView({ name: 'insights', ...(t === 'networth' && { tab: 'networth' }) }); render(`ins-tab-${t}`); };
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
export function holdingsValueEUR(a) {
  if (!state.holdings.some((x) => x.accountId === a.id)) return null;
  return convert(accountValue(a), latestRate(a.currency) ?? 1);
}

// Once a day, keep what each investment account is worth at market prices, so the net-worth
// history shows real values from today on instead of what was put in.
export function recordSnapshot() {
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
export const fetchedSets = new Map(); // key → 'loading' | 'done'
export function transactionsLoaded(key, filter) {
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
export const inEur = (t) => convert(t.amount, t.rate ?? latestRate(state.accounts.find((a) => a.id === t.accountId)?.currency ?? 'EUR') ?? 1);
// Net worth history estimates investments without buys and sells from what was put in (model.js).
export const estimateOpts = { paidIn: (a) => convert(totalsOf(a.id).balance, latestRate(a.currency) ?? 1), first: (a) => totalsOf(a.id).first };

// "+7.2% a year", or the plain return when it's under a year; with a note on what it covers.
export function returnText(sum) {
  if (sum.annual != null) return { text: `${sum.annual >= 0 ? '+' : ''}${num(sum.annual * 100)}% a year`, value: sum.annual };
  if (sum.simple != null) return { text: `${sum.simple >= 0 ? '+' : ''}${num(sum.simple * 100)}%`, value: sum.simple, short: true };
  return null;
}

// Insights for an investment account: its value against what was put in, over the period, its
// annual return and dividends, and each holding's value, cost, gain, dividends and return today.
export function investmentInsights(account) {
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
  // This account alone: not the assets, which would otherwise come along with the rest of the state.
  const hist = netWorthHistory({ ...state, accounts: [account], assets: [] }, { from: range.from, to, today: today(), holdingsValue: holdingsValueEUR, rateOf, runs: runMap(runs), estimate: estimateOpts });
  const invested = investedHistory(account, state, dates, rateOf, runMap(paidIn).get(account.id) ?? { values: [] });
  const pts = hist.points.map((p, i) => ({ key: p.key, date: p.date, total: p.total, investments: invested[i] }));
  const now = pts.at(-1);
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
    // Value, invested and gain are at the top of the account's page; here, what's about the period
    // and the return.
    h('dl', { class: 'fin-stats' },
      h('div', {}, h('dt', {}, `Change since ${shortDate(pts[0].date)}`),
        h('dd', { class: tone(change) }, signed(change, 'EUR')),
        h('p', { class: 'fin-stat-note' }, 'value, including new money')),
      // Money-weighted (XIRR): money added late counts for less time. Over everything, not the period.
      yearly && h('div', {}, h('dt', {}, yearly.short ? 'Return' : 'Annual return'),
        h('dd', { class: yearly.value > 0 ? 'fin-pos' : yearly.value < 0 ? 'fin-neg' : '' }, yearly.text),
        h('p', { class: 'fin-stat-note' }, yearly.short
          ? `since ${shortDate(since)}; under a year, so not made yearly`
          : `money-weighted, since ${fullDate(since)}${dividends.length ? ', with dividends' : ''}`)),
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
      h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table fin-hold-ins' },
        h('caption', { class: 'fin-sr' }, `Holdings of ${account.name}`),
        h('thead', {}, h('tr', {}, ['Holding', 'Units', 'Value', 'Cost', 'Gain', 'Dividends', 'Return', 'Share'].map((t, i) => h('th', { scope: 'col', class: i ? 'fin-r' : null }, t)))),
        // On a phone each row stacks as a card (fin-hold-ins in finance.css), each cell in its place
        // (hi-…), the figures without their header saying what they are (fin-stack-label).
        h('tbody', {}, rows.map(({ x, value, cost, gain: g, dividends: d, ret }) => {
          const r = ret && returnText(ret);
          const label = (text) => h('span', { class: 'fin-stack-label' }, `${text} `);
          return h('tr', {},
            h('td', { class: 'hi-sym' }, x.symbol, h('span', { class: 'fin-sub' }, x.name ?? '')),
            h('td', { class: 'fin-r fin-num hi-units' }, shownQty(x.quantity), h('span', { class: 'fin-stack-label' }, ' units')),
            h('td', { class: 'fin-r fin-num hi-val' }, money(value, 'EUR')),
            h('td', { class: 'fin-r fin-num fin-muted hi-cost' }, label('cost'), cost == null ? '—' : money(cost, 'EUR')),
            h('td', { class: `fin-r fin-num hi-gain ${g == null ? '' : tone(g)}` }, g == null ? '—' : signed(g, 'EUR'),
              g != null && cost > 0 && h('span', { class: 'fin-sub' }, `${g >= 0 ? '+' : ''}${num((g / cost) * 100)}%`)),
            h('td', { class: 'fin-r fin-num hi-div' }, label('Dividends'), d ? money(d, 'EUR') : '—'),
            h('td', { class: `fin-r fin-num hi-ret ${r ? (r.value > 0 ? 'fin-pos' : r.value < 0 ? 'fin-neg' : '') : ''}` }, label('Return'), r ? r.text : '—',
              r?.short && h('span', { class: 'fin-sub' }, 'under a year')),
            h('td', { class: 'fin-r fin-num fin-muted hi-share' }, totalValue ? `${Math.round((value / totalValue) * 100)}%` : '',
              totalValue > 0 && h('span', { class: 'fin-stack-label' }, ' of the account')));
        })))),
      h('p', { class: 'fin-hint' }, 'Return is money-weighted (XIRR) over each holding’s buys, sells and dividends, with today’s value as if sold today. It needs the holding’s buys and sells.')),
    allocationCard(own, account.id));
}

// balances_at's answer as accountRuns gives it: Map(accountId → { last, values }).
export const runMap = (obj) => new Map(Object.entries(obj ?? {}));

// How net worth changed since yesterday (EUR minor units), from the same history as the Net worth
// page, or undefined while the database works it out.
export function netWorthSinceYesterday() {
  const to = today();
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
  const runs = ask('balances_at', { p_dates: [from, to], p_rates: ratesArg() });
  if (!runs) return undefined;
  const [before, now] = netWorthHistory({ ...state, accounts: state.accounts.filter(counted), assets: [] }, {
    from, to, today: to, holdingsValue: holdingsValueEUR, rateOf: (c) => latestRate(c) ?? 1, runs: runMap(runs), estimate: estimateOpts,
  }).points;
  return now.total - before.total;
}
// An investment account's gain or loss since yesterday, in its currency: the change in its value less
// the money moved in or out since (so a deposit isn't a gain). { day, text }, or null while it's
// worked out.
export function accountSinceYesterday(account) {
  const to = today();
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
  const runs = ask('balances_at', { p_dates: [from, to], p_rates: ratesArg(), p_accounts: [account.id] });
  if (!runs) return null;
  const map = runMap(runs);
  const [before, now] = netWorthHistory({ ...state, accounts: [account], assets: [] }, {
    from, to, today: to, holdingsValue: holdingsValueEUR, rateOf: (c) => latestRate(c) ?? 1, runs: map, estimate: estimateOpts,
  }).points;
  const moved = map.get(account.id)?.values ?? [];
  const eur = now.total - before.total - (Number(moved[1] ?? 0) - Number(moved[0] ?? 0));
  const day = Math.round(eur / (latestRate(account.currency) ?? 1));
  return { day, text: day === 0 ? 'no change since yesterday' : `${signed(day, account.currency)} since yesterday` };
}
// The same, said: { day, text }, or null while it's worked out (or with no accounts).
export function sinceYesterday() {
  const day = state.accounts.length ? netWorthSinceYesterday() : undefined;
  if (day == null) return null;
  return { day, text: day === 0 ? 'no change since yesterday' : `${signed(day, 'EUR')} since yesterday` };
}

// The Net worth tab of Insights (without the page's heading).
export function renderNetWorth() {
  const first = state.accounts.map((a) => totalsOf(a.id).first).filter(Boolean).reduce((min, d) => (d < min ? d : min), today());
  const range = periodRange(insightsPeriod.preset, today(), { from: insightsPeriod.from, to: insightsPeriod.to, first });
  if (range.from > range.to) [range.from, range.to] = [range.to, range.from];
  const to = range.to > today() ? today() : range.to; // the future has no balances yet
  // Each account's running total at each point comes from the database; investments are valued here.
  const runs = ask('balances_at', { p_dates: historyPoints(range.from, to).ends.map((e) => e.date), p_rates: ratesArg() });
  if (!runs) {
    return h('div', { class: 'fin-insights' }, periodControls(range), loader('Working out the history…'));
  }
  // Show total wealth (remembered in this browser): also the assets (never in net worth: they aren't
  // money) and the accounts left out of totals, for a total worth. Offered only when there's more.
  const leftOut = state.accounts.some((a) => !a.archived && !counted(a)) || state.assets.length > 0;
  const everything = leftOut && netWorthAll;
  const inTotals = (a) => everything || counted(a);
  const hist = netWorthHistory({ ...state, accounts: state.accounts.filter(inTotals), assets: everything ? state.assets : [] }, {
    from: range.from, to, today: today(), holdingsValue: holdingsValueEUR, rateOf: (c) => latestRate(c) ?? 1, runs: runMap(runs), estimate: estimateOpts,
  });
  // Net worth (or, counting everything, total worth) and what's within reach (without pensions and
  // retirement savings, locked away until later, and without any assets counted), both from the same
  // point of the history.
  const pts = hist.points;
  const now = pts.at(-1);
  const start = pts[0];
  const change = now.total - start.total;
  const reachOf = (p) => p.total - p.locked - (p.assets ?? 0);
  const hasReach = pts.some((p) => p.locked || p.assets);
  const allSwitch = leftOut && h('label', { class: 'fin-switch fin-nw-all' },
    h('input', {
      type: 'checkbox', role: 'switch', checked: everything, 'data-key': 'nw-all',
      onchange: (e) => { netWorthAll = e.target.checked; writePref('finance:nw-all', netWorthAll); render('nw-all'); },
    }),
    h('span', { class: 'fin-switch-track', 'aria-hidden': 'true' }),
    `Show total wealth (includes ${[state.assets.length && 'assets', state.accounts.some((a) => !a.archived && !counted(a)) && 'what’s left out of totals'].filter(Boolean).join(' and ')})`);

  // Today's split by account type (archived accounts are closed, so they're not part of it).
  const byType = ACCOUNT_TYPES.map((type) => {
    const value = state.accounts.filter((a) => a.type === type && !a.archived && inTotals(a))
      .reduce((sum, a) => sum + convert(accountValue(a), latestRate(a.currency) ?? 1), 0);
    return { type, value };
  }).filter((x) => x.value !== 0);
  // Assets, when counting everything, as one more line (by their own icon).
  if (now.assets) byType.push({ type: 'assets', label: 'Assets', icon: 'asset-home', value: now.assets });
  const assets = byType.filter((x) => x.value > 0).reduce((s, x) => s + x.value, 0);
  const debts = byType.filter((x) => x.value < 0).reduce((s, x) => s - x.value, 0);

  return h('div', {},
    h('div', { class: 'fin-insights' },
      periodControls(range),
      allSwitch,
      h('dl', { class: 'fin-stats' },
        h('div', { class: 'fin-stat-key' }, h('dt', {}, everything ? 'Total worth today' : 'Net worth today'), h('dd', {}, money(now.total, 'EUR')),
          h('p', { class: 'fin-stat-note' }, everything ? 'everything, assets included'
            : `what counts in totals${now.locked ? ', pensions included' : ''}`)),
        h('div', {}, h('dt', {}, `Change since ${shortDate(start.date)}`),
          h('dd', { class: tone(change) }, signed(change, 'EUR')),
          start.total > 0 && h('p', { class: 'fin-stat-note' }, `${change >= 0 ? '+' : ''}${num((change / start.total) * 100)}%`)),
        h('div', {}, h('dt', {}, 'Investments'), h('dd', {}, money(now.investments, 'EUR')),
          now.total > 0 && h('p', { class: 'fin-stat-note' }, `${Math.round((now.investments / now.total) * 100)}% of net worth`)),
        h('div', {}, h('dt', {}, 'Debts'), h('dd', { class: debts ? 'fin-neg' : '' }, money(debts, 'EUR')),
          h('p', { class: 'fin-stat-note' }, 'credit cards and other negative balances')),
        // Assets (a home, vehicles…: the Assets page): never in net worth, only in a total worth.
        state.assets.some((x) => !x.soldOn) && h('div', {}, h('dt', {}, 'Assets'), h('dd', {}, money(assetsInEur(state.assets.filter((x) => !x.soldOn)), 'EUR')),
          h('p', { class: 'fin-stat-note' }, everything ? 'in total worth · ' : 'not in net worth · ',
            pageLink('See them', { name: 'assets' }, 'fin-link fin-link-sm'))),
        // Within reach: net worth less pensions and assets, from the same point of the history.
        hasReach && h('div', {}, h('dt', {}, 'Within reach'), h('dd', {}, money(reachOf(now), 'EUR')),
          h('p', { class: 'fin-stat-note' }, `without ${[now.locked > 0 && `${money(now.locked, 'EUR')} in pensions`, now.assets > 0 && `${money(now.assets, 'EUR')} in assets`].filter(Boolean).join(' and ')}`))),
      pts.length > 1
        ? [
          h('section', { class: 'fin-card fin-pad' },
            timeChart(pts.map((p) => ({ date: p.date, v: p.total })), { id: 'nw', title: everything ? 'Total worth over time' : 'Net worth over time', unit: 'in EUR', format: (v) => money(v, 'EUR'), wide: true })),
          pts.some((p) => p.investments) && h('section', { class: 'fin-card fin-pad' },
            timeChart(pts.map((p) => ({ date: p.date, v: p.investments })), { id: 'nw-inv', title: 'Investments', unit: 'in EUR', format: (v) => money(v, 'EUR'), wide: true })),
        ]
        : h('p', { class: 'fin-notice' }, 'Pick a longer period to see net worth over time.'),
      h('p', { class: 'fin-hint' },
        hist.firstSnapshot
          ? `Investments are at market value from ${fullDate(hist.firstSnapshot)}, recorded once a day when you open the app. Before that, holdings with buys and sells are valued as the units held times the latest trade price`
          : 'Investments are at market value today. Earlier, holdings with buys and sells are valued as the units held times the latest trade price',
        hist.estimated
          ? '; accounts without them are estimated as what was put in by then plus today’s gain growing evenly from their first transaction.'
          : '; others at what was put in, as there’s no price history.',
        !hist.firstSnapshot && ' From today the app records market values once a day, so the history fills in.',
        ' Closed (archived) accounts count until their last transaction.'),
      h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'nw-type-h' },
        h('h3', { id: 'nw-type-h', class: 'fin-label' }, 'By account type, and assets, today'),
        h('ul', { class: 'fin-break' }, byType.map(({ type, value, label, icon: ic }) => h('li', {},
          h('div', { class: `fin-break-row fin-type-row fin-group--${type}` },
            h('span', { class: 'fin-break-name' }, h('span', { class: 'fin-group-icon' }, icon(ic ?? `type-${type}`)), label ?? ACCOUNT_TYPE_LABELS[type]),
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
