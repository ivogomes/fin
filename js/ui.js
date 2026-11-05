// Building blocks shared by every page: making elements (h), form controls, icons, preferences,
// money and number formatting, category names and colours, and the page's fixed elements.

import { categoryPath, formatMoney, newId, sortedCategories } from './model.js';
import { state } from './app.js';
import { selected } from './transactions.js';

export const side = document.getElementById('side');
export const main = document.getElementById('app');
export const dialog = document.getElementById('account-dialog');
export const txDialog = document.getElementById('tx-dialog');
export const status = document.getElementById('status');
// ── helpers ──────────────────────────────────────────────────────────────────

export function h(tag, attrs = {}, ...kids) {
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

export function readPref(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
export function writePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* per-viewer convenience only */ }
}

// Phone layout (the same width as the CSS's): bottom tab bar, Accounts as a page of its own.
export const isPhone = () => matchMedia('(max-width: 52rem)').matches;
export const say = (msg) => { status.textContent = ''; setTimeout(() => { status.textContent = msg; }, 30); };
export const category = (id) => state.categories.find((c) => c.id === id);
// A category as shown everywhere: "Parent / Child" for children.
export const catLabel = (id) => { const c = category(id); return c ? categoryPath(c, state.categories) : ''; };
// Options for a category <select>: parents followed by their children.
// A colour group (0–7) per top-level category, so a family's chips share a colour. Colours go round
// in alphabetical order of the top-level categories, so neighbours in the list never share one.
export function hueOf(id) {
  const c = category(id);
  const top = c?.parentId ? category(c.parentId) ?? c : c;
  if (!top) return '0';
  if (!hueOrder) {
    hueOrder = new Map(state.categories.filter((x) => !x.parentId)
      .sort((x, y) => x.name.localeCompare(y.name)).map((x, i) => [x.id, String(i % 8)]));
  }
  return hueOrder.get(top.id) ?? '0';
}
export let hueOrder = null; // reset on every render, like iouByTx
export const catOptions = () => sortedCategories(state.categories).map((c) => [c.id, categoryPath(c, state.categories)]);
// Hide amounts (to show the app to someone): every amount and quantity is drawn as dots. The dots
// stand in for a fixed number, so their length says nothing about the real one; signs, colours and
// percentages stay. Remembered per browser.
export let hideAmounts = readPref('finance:hide-amounts', false);
export const MASK_MINOR = 123456;
export const masked = (text) => text.replace(/\d/g, '•');
// How numbers look (Settings → Display): the browser's own way, or a chosen style. Per browser.
export const NUMBER_FORMATS = {
  '': { label: 'Automatic (your browser’s language)', locale: undefined },
  dot: { label: '1,000.00', locale: 'en-GB' },
  comma: { label: '1.000,00', locale: 'de-DE' },
  space: { label: '1 000,00', locale: 'fr-FR' },
};
export let numberFormat = NUMBER_FORMATS[readPref('finance:number-format', '')] ? readPref('finance:number-format', '') : '';
export const numLocale = () => NUMBER_FORMATS[numberFormat].locale;
// A plain number with `digits` decimals (percentages, rates), in the chosen style.
export const num = (x, digits = 1) => new Intl.NumberFormat(numLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x);
export const money = (minor, cur) => (hideAmounts ? masked(formatMoney(minor < 0 ? -MASK_MINOR : MASK_MINOR, cur, numLocale())) : formatMoney(minor, cur, numLocale()));
export const signed = (minor, cur) =>
  new Intl.NumberFormat(numLocale(), { style: 'currency', currency: cur, signDisplay: 'exceptZero' })
    .format((hideAmounts ? Math.sign(minor) * MASK_MINOR : minor) / 100).replace(/\d/g, (d) => (hideAmounts ? '•' : d));
export const shownQty = (n) => (hideAmounts ? '•••' : new Intl.NumberFormat(numLocale(), { maximumFractionDigits: 8 }).format(n));
export const tone = (minor) => (minor > 0 ? 'fin-pos' : minor < 0 ? 'fin-neg' : '');
// A small flag for a currency (EUR, USD), drawn inline so it looks the same everywhere (Windows
// shows flag emoji as letters). Decoration: the currency is always written next to it.
const FLAG_NS = 'http://www.w3.org/2000/svg';
const flagEl = (tag, attrs) => {
  const e = document.createElementNS(FLAG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
export function flag(currency) {
  const svg = flagEl('svg', { viewBox: '0 0 18 12', class: 'fin-flag', 'aria-hidden': 'true', focusable: 'false' });
  if (currency === 'EUR') {
    svg.append(flagEl('rect', { width: 18, height: 12, fill: '#003399' }));
    // Twelve gold stars in a circle (dots at this size).
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * 2 * Math.PI;
      svg.append(flagEl('circle', { cx: (9 + 3.6 * Math.sin(a)).toFixed(2), cy: (6 - 3.6 * Math.cos(a)).toFixed(2), r: 0.62, fill: '#FFCC00' }));
    }
  } else if (currency === 'USD') {
    svg.append(flagEl('rect', { width: 18, height: 12, fill: '#FFFFFF' }));
    // Thirteen stripes, red first, and the blue canton over the top seven.
    for (let i = 0; i < 13; i += 2) svg.append(flagEl('rect', { y: ((i * 12) / 13).toFixed(3), width: 18, height: (12 / 13).toFixed(3), fill: '#B22234' }));
    svg.append(flagEl('rect', { width: 7.2, height: ((7 * 12) / 13).toFixed(3), fill: '#3C3B6E' }));
  } else return null;
  return svg;
}
export const latestRate = (cur) => (cur === 'EUR' ? 1 : state.rates[`${cur}:latest`]?.rate ?? null);

export const thisYear = new Date().getFullYear();
export const shortDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, d.getFullYear() === thisYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
};
// The same, always with its year (shortDate leaves this year's out; adding it by hand doubled it).
export const fullDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function field(label, control, hint) {
  const id = `f-${newId().slice(0, 8)}`;
  control.id = id;
  return h('div', { class: 'fin-field' },
    h('label', { for: id }, label), control, hint && h('p', { class: 'fin-hint' }, hint));
}

export const input = (attrs) => h('input', { class: 'fin-input', ...attrs });
export const select = (options, value, attrs = {}) =>
  h('select', { class: 'fin-input', ...attrs },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
export const button = (label, onclick, kind = 'secondary', attrs = {}) =>
  h('button', { type: 'button', class: `fin-btn ${kind === 'primary' ? 'btn-primary' : kind}`, onclick, ...attrs }, label);

// A transaction's type as a segmented switch (a radio group): one Tab stop, ←/→ move and pick, like
// native radios. `compact` shows only the symbols (the quick-entry grid), with the names as labels
// and tooltips. `value` reads and sets the picked type.
export const TX_TYPES = { expense: ['−', 'Expense'], income: ['+', 'Income'], refund: ['↩', 'Refund'], dividend: ['%', 'Dividend'], transfer: ['⇄', 'Transfer'] };
export function typeSwitch(kinds, value, { label = 'Transaction type', compact = false, onChange } = {}) {
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
export const ICONS = {
  edit: ['M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z', 'M13.5 6.5l3 3'],
  trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7l1 12.5h9l1-12.5', 'M10 11v5M14 11v5'],
  plus: ['M12 5v14M5 12h14'],
  refund: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  // Alerts: a payment that's due, a balance that runs low
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', 'M12 7.5V12l3 2'],
  warn: ['M12 4 2.8 19.5h18.4Z', 'M12 10v4.5', 'M12 17.2h.01'],
  pause: ['M9.5 6v12', 'M14.5 6v12'],
  cloud: ['M7 18.5h10.5a4 4 0 0 0 .4-7.98A6 6 0 0 0 6.3 9.7 4.4 4.4 0 0 0 7 18.5Z', 'M12 11v4.5', 'M12 18h.01'],
  // A subscription: a calendar page (it comes back every month or year), unlike a transfer's arrows.
  subscription: ['M4 6.5h16V20H4Z', 'M4 10.5h16', 'M8.5 4v4.5M15.5 4v4.5', 'M8.5 14.5h2M13.5 14.5h2M8.5 17h2'],
  repeat: ['M17 3.5 20.5 7 17 10.5', 'M3.5 11V10a3 3 0 0 1 3-3h14', 'M7 20.5 3.5 17 7 13.5', 'M20.5 13v1a3 3 0 0 1-3 3h-14'],
  // Account types
  'type-cash': ['M3 7h18v10H3Z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z', 'M6.5 10v4M17.5 10v4'],
  'type-checking': ['M3 10 12 4.5l9 5.5', 'M5.5 10.5v7M10 10.5v7M14 10.5v7M18.5 10.5v7', 'M3 20h18'],
  'type-credit': ['M3 6h18v12H3Z', 'M3 10h18', 'M7 14.5h4'],
  'type-investment': ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'],
  'type-loan': ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', 'M9 15l6-6', 'M9.25 9.25h.01', 'M14.75 14.75h.01'],
  'type-savings': ['M5 7.5c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5-7-1.1-7-2.5Z', 'M5 7.5v4.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V7.5', 'M5 12v4.5C5 17.9 8.1 19 12 19s7-1.1 7-2.5V12'],
  // Assets, by kind
  'asset-home': ['M4 10.5 12 4l8 6.5V20H4Z', 'M9.5 20v-5.5h5V20'],
  'asset-vehicle': ['M5 16.5V12l1.8-4.2A2 2 0 0 1 8.6 6.5h6.8a2 2 0 0 1 1.8 1.3L19 12v4.5', 'M4 12h16v4.5H4Z', 'M7.5 16.5V19M16.5 16.5V19', 'M7.5 14.2h.01M16.5 14.2h.01'],
  'asset-other': ['M4 8.5 12 4l8 4.5v7L12 20l-8-4.5Z', 'M4 8.5 12 13l8-4.5', 'M12 13v7'],
  'type-archived': ['M3 5h18v4H3Z', 'M5 9v10h14V9', 'M10 13h4'],
};
export function icon(name) {
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
export const iconButton = (name, label, onclick, { danger = false, ...attrs } = {}) =>
  h('button', { type: 'button', class: `fin-icon-btn${danger ? ' fin-icon-btn--danger' : ''}`, 'aria-label': label, title: label, onclick, ...attrs }, icon(name));

// Loading animations: Fin's fin, on a rolling wave. They're decoration (hidden from screen readers,
// still when motion is reduced); the message beside them is what's announced.
export const NS_SVG = 'http://www.w3.org/2000/svg';
export const svgEl = (tag, attrs, ...kids) => {
  const n = document.createElementNS(NS_SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids);
  return n;
};
// A wave from x0 to x1 with its top at `y`, crests `period` wide and `height` high, filled down to `bottom`.
export function wavePath(x0, x1, y, period, height, bottom) {
  let d = `M${x0} ${y}`;
  for (let x = x0, up = true; x < x1; x += period / 2, up = !up) d += `q${period / 4} ${up ? -height : height} ${period / 2} 0`;
  return `${d}V${bottom}H${x0}Z`;
}
// The logo's fin, 24 wide and 26 tall, facing right: the tip leans back to the left, so it swims
// forward as the animations move it rightwards (the logo's own faces the other way; it stays still).
export const FIN_SHAPE = 'M24 26Q17 5 0 0Q7 9 4 26Z';

// Opening a page: a fin circling across the middle of the screen (gliding along, diving at the
// edge, surfacing on the other side), with a joke under the message that changes every few seconds.
export const QUIPS = [
  'Something’s circling your spending…', 'Testing the waters…', 'Swimming through your transactions…',
  'Fin-ding your money…', 'Smelling a bargain…', 'Diving into the details…', 'Making a splash…', 'Circling the numbers…',
];
export function circlingFin() {
  const clipId = `fin-water-${newId().slice(0, 6)}`;
  return svgEl('svg', { viewBox: '0 0 160 64', class: 'fin-circling', 'aria-hidden': 'true' },
    svgEl('defs', {}, svgEl('clipPath', { id: clipId }, svgEl('rect', { x: 0, y: 0, width: 160, height: 46 }))),
    svgEl('path', { d: wavePath(-40, 200, 44, 20, 3, 64), class: 'fin-wave fin-wave-back' }),
    svgEl('g', { 'clip-path': `url(#${clipId})` },
      svgEl('g', { transform: 'translate(0 20)' },
        svgEl('g', { class: 'fin-swim' }, svgEl('path', { d: FIN_SHAPE, class: 'fin-shape' })))),
    svgEl('path', { d: wavePath(-40, 200, 46, 20, 3, 64), class: 'fin-wave fin-wave-front' }));
}
export function pageLoader(text) {
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
export function loader(text) {
  const svg = svgEl('svg', { viewBox: '0 0 28 20', class: 'fin-bobbing', 'aria-hidden': 'true' },
    svgEl('g', { transform: 'translate(8 2) scale(0.5)' }, svgEl('g', { class: 'fin-bob' }, svgEl('path', { d: FIN_SHAPE, class: 'fin-shape' }))),
    svgEl('path', { d: wavePath(-8, 40, 14, 8, 1.6, 20), class: 'fin-wave fin-wave-front fin-wave-small' }));
  return h('div', { class: 'fin-loader', role: 'status' }, svg, h('span', {}, text));
}

export const monthLabel = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export const setHueOrder = (v) => { hueOrder = v; };
export const setHideAmountsValue = (v) => { hideAmounts = v; };
export const setNumberFormat = (v) => { numberFormat = v; };
