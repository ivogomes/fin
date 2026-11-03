// Holdings of an investment account, and their buys and sells (lots).

import { alphaVantageCovers, today } from './market.js';
import { CURRENCIES, holdingHistory, holdingValue, lotSummary, newId } from './model.js';
import { persist } from './store.js';
import { byName, loadHistory, refreshPrices, render, setView, state, undoable, view } from './app.js';
import { priceCell, symbolPicker } from './entry.js';
import {
  button, dialog, field, h, hideAmounts, iconButton, input, latestRate, money, num, say, select,
  shortDate, shownQty, signed, tone,
} from './ui.js';

// ── editing a holding ────────────────────────────────────────────────────────

// Exchanges a holding can be priced on (MIC → name). Non-US ones are priced through Alpha Vantage.
export const EXCHANGES = [
  ['XETR', 'Xetra'], ['XFRA', 'Frankfurt'], ['XLON', 'London'], ['XPAR', 'Paris'], ['XAMS', 'Amsterdam'],
  ['XMIL', 'Milan'], ['XTSE', 'Toronto'], ['XNAS', 'NASDAQ'], ['XNGS', 'NASDAQ (Global Select)'], ['XNYS', 'NYSE'],
];

export function openHoldingDialog(x) {
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
      if (account.value !== view.id) setView({ name: 'account', id: account.value });
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

export let openLotsId = null;
export let openChartId = null; // the holding whose charts are open

// A holding's price over time, and the gain or loss on the units held (needs its buys and sells).
export function holdingChartPanel(x) {
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
export function chartTip(wrap, svg) {
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
export function timeChart(points, { id, title, unit, format, kind = 'change', ref = null, refLabel = '', wide = false }) {
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
export const lotsOfHolding = (id) => state.lots.filter((l) => l.holdingId === id).sort((a, b) => a.date.localeCompare(b.date));
// An investment account's gain from its holdings: each one's value less what its buys and sells
// cost, in the account's currency (converted at today's rates, like its value). Null when a
// holding has no lots (its cost isn't known) or a price or rate is missing.
export function holdingsGain(account) {
  const list = state.holdings.filter((x) => x.accountId === account.id);
  if (!list.length) return null;
  let gain = 0;
  let cost = 0;
  for (const x of list) {
    const own = lotsOfHolding(x.id);
    const value = holdingValue(x);
    if (!own.length || value == null) return null;
    const toAccount = x.currency === account.currency ? 1
      : latestRate(x.currency) && latestRate(account.currency) ? latestRate(x.currency) / latestRate(account.currency) : null;
    if (toAccount == null) return null;
    const c = lotSummary(own).cost;
    gain += Math.round((value - c) * toAccount);
    cost += Math.round(c * toAccount);
  }
  return { gain, cost };
}
// A holding with lots takes its units from them.
export function recalcHolding(x) {
  const own = lotsOfHolding(x.id);
  if (own.length) x.quantity = lotSummary(own).quantity;
}

export function lotsPanel(x) {
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
          h('td', { class: 'fin-nowrap' }, shortDate(l.date)),
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

export function holdingsSection(account) {
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
      // Each holding is in the currency it's priced in; say so when that isn't the account's.
      const mixed = list.some((x) => x.currency !== account.currency);
      const parts = [
        times.length > 0 && `Prices as of ${new Date(times[0]).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`,
        mixed && `Each holding is shown in the currency it’s priced in; the account’s value is in ${account.currency}, at today’s rates.`,
      ].filter(Boolean);
      return parts.length > 0 && h('p', { class: 'fin-hint fin-pad-x' }, parts.join(' '));
    })(),
    list.length === 0
      ? h('p', { class: 'fin-empty fin-pad' }, 'No holdings yet.')
      : h('div', { class: 'fin-scroll' }, h('table', { class: 'fin-table' },
        h('caption', { class: 'fin-sr' }, 'Holdings'),
        h('thead', {}, h('tr', {},
          ['Symbol', 'Name', 'Exchange', 'Currency', 'Units', 'Price', 'Value', 'Cost', 'Gain'].map((t, i) => h('th', { scope: 'col', class: i > 3 ? 'fin-r' : null }, t)),
          h('th', { scope: 'col' }, h('span', { class: 'fin-sr' }, 'Actions')))),
        h('tbody', {}, list.flatMap((x) => {
          const v = holdingValue(x);
          const own = lotsOfHolding(x.id);
          const sum = own.length ? lotSummary(own) : null;
          const gain = sum && v != null ? v - sum.cost : null;
          const open = openLotsId === x.id;
          const charted = openChartId === x.id;
          // In another currency than the account's: its value there too, as the account's total counts it.
          const rates = x.currency !== account.currency && latestRate(x.currency) && latestRate(account.currency);
          const inAccount = rates && v != null ? Math.round(v * (latestRate(x.currency) / latestRate(account.currency))) : null;
          const row = h('tr', {},
            h('td', {}, x.symbol),
            h('td', {}, x.name ?? '', x.priceError && h('span', { class: 'fin-sub fin-row-error' },
              `No live price: ${x.priceError.replace(/\s*Consider upgrading.*$/i, '')} Enter the price by hand for now.`)),
            h('td', { class: 'fin-muted' }, x.exchange ?? (x.mic ? '' : 'not set')),
            h('td', { class: x.currency === account.currency ? 'fin-muted' : null }, x.currency),
            h('td', { class: 'fin-r fin-num' }, shownQty(x.quantity)),
            h('td', { class: 'fin-r fin-num' }, priceCell(x)),
            h('td', { class: 'fin-r fin-num' }, v == null ? '—' : money(v, x.currency),
              inAccount != null && h('span', { class: 'fin-sub' }, `≈ ${money(inAccount, account.currency)}`)),
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
            charted && h('tr', { class: 'fin-edit-row' }, h('td', { colspan: 10 }, holdingChartPanel(x))),
            open && h('tr', { class: 'fin-edit-row' }, h('td', { colspan: 10 }, lotsPanel(x)))];
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
