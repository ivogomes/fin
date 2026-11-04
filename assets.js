// Assets: a home, vehicles, anything else of value, kept apart from the accounts. The Assets page
// is their dashboard: what they're worth together, and a card for each with its value (estimated
// between valuations, model.js assetValue), what it cost, its value over time and its valuations.

import { today } from './market.js';
import {
  ASSET_CHANGE, ASSET_KINDS, CURRENCIES, assetChange, assetValuations, assetValue, convert,
  historyPoints, newId, toMinor,
} from './model.js';
import { persist } from './store.js';
import { render, state, undoable } from './app.js';
import { timeChart } from './holdings.js';
import {
  button, dialog, field, h, icon, iconButton, input, latestRate, money, num, say, select, shortDate,
  signed, tone,
} from './ui.js';

// The assets that count in net worth: each one does unless it's left out (the checkbox on its card).
export const countedAssets = () => state.assets.filter((x) => !x.excludeTotals);
// What `list` is worth on `date`, in EUR at today's rates.
export const assetsInEur = (list, date = today()) =>
  list.reduce((sum, x) => sum + convert(assetValue(x, date)?.value ?? 0, latestRate(x.currency) ?? 1), 0);

const KIND_ICONS = { home: 'asset-home', vehicle: 'asset-vehicle', other: 'asset-other' };
const rateText = (x) => {
  const c = assetChange(x);
  return `${c > 0 ? '+' : ''}${num(c, c % 1 ? 1 : 0)}% a year`;
};

export function renderAssets() {
  const own = state.assets.filter((x) => !x.soldOn);
  const sold = state.assets.filter((x) => x.soldOn);
  const total = assetsInEur(own);
  const cost = own.filter((x) => x.purchasePrice != null).reduce((sum, x) => sum + convert(x.purchasePrice, latestRate(x.currency) ?? 1), 0);
  const valuedCost = assetsInEur(own.filter((x) => x.purchasePrice != null));
  const inNetWorth = own.filter((x) => !x.excludeTotals);
  return h('div', {},
    h('div', { class: 'fin-account-head' },
      h('div', {}, h('h2', { class: 'fin-title', id: 'assets-h', tabindex: '-1' }, 'Assets'),
        h('p', { class: 'fin-meta' }, 'Your home, vehicles and anything else of value, at what they’re worth: valued when you know, estimated in between.')),
      button('Add asset', () => openAssetDialog(), 'primary', { 'data-key': 'asset-add', 'aria-haspopup': 'dialog' })),
    own.length === 0 && sold.length === 0
      ? h('section', { class: 'fin-card fin-pad' }, h('p', { class: 'fin-empty' }, 'No assets yet. Add a home, a car or anything else of value to follow what it’s worth and count it in net worth.'))
      : [
        h('dl', { class: 'fin-stats' },
          h('div', {}, h('dt', {}, 'Worth'), h('dd', {}, money(total, 'EUR')),
            h('p', { class: 'fin-stat-note' }, `${own.length} asset${own.length === 1 ? '' : 's'}, in EUR`)),
          cost > 0 && h('div', {}, h('dt', {}, 'Bought for'), h('dd', {}, money(cost, 'EUR')),
            h('p', { class: `fin-stat-note ${tone(valuedCost - cost)}` }, `${signed(valuedCost - cost, 'EUR')} since (${valuedCost >= cost ? '+' : ''}${num(((valuedCost - cost) / cost) * 100)}%)`)),
          h('div', {}, h('dt', {}, 'In net worth'), h('dd', {}, money(assetsInEur(inNetWorth), 'EUR')),
            h('p', { class: 'fin-stat-note' }, inNetWorth.length === own.length ? (own.length === 1 ? 'it counts' : 'all of them count')
              : `${inNetWorth.length} of ${own.length} count; each card says`))),
        ...own.map(assetCard),
        sold.length > 0 && h('h3', { class: 'fin-label fin-mt' }, 'Sold'),
        ...sold.map(assetCard),
      ]);
}

// One asset: its value (saying when it's an estimate, and from what), what it cost and the gain or
// loss since, its value over time (with what it cost to compare), and its valuations.
function assetCard(x) {
  const now = assetValue(x, x.soldOn ?? today());
  const shownAt = x.soldOn ? assetValue(x, prevDay(x.soldOn)) : now;
  const cur = x.currency;
  const gain = shownAt && x.purchasePrice != null ? shownAt.value - x.purchasePrice : null;
  const headId = `asset-${x.id}`;
  return h('section', { class: `fin-card fin-asset${x.soldOn ? ' is-sold' : ''}`, 'aria-labelledby': headId },
    h('div', { class: 'fin-card-head fin-asset-head' },
      h('h3', { id: headId, class: 'fin-asset-title' }, h('span', { class: `fin-group-icon fin-asset-icon fin-asset-icon--${x.kind}` }, icon(KIND_ICONS[x.kind] ?? 'asset-other')), x.name),
      h('p', { class: 'fin-meta' }, [ASSET_KINDS[x.kind], cur, x.boughtOn && `bought ${shortDate(x.boughtOn)}`, x.soldOn && `sold ${shortDate(x.soldOn)}`].filter(Boolean).join(' · ')),
      h('div', { class: 'fin-actions' },
        // Whether it counts in net worth: a switch among its actions, saved at once.
        !x.soldOn && h('label', { class: `fin-switch fin-asset-switch${x.excludeTotals ? '' : ' is-on'}` },
          h('input', {
            type: 'checkbox', role: 'switch', checked: !x.excludeTotals, 'data-key': `asset-count-${x.id}`,
            'aria-label': `Count ${x.name} in net worth`,
            onchange: (e) => {
              if (e.target.checked) delete x.excludeTotals; else x.excludeTotals = true;
              persist(); render(`asset-count-${x.id}`);
              say(e.target.checked ? `${x.name} counts in net worth.` : `${x.name} is left out of net worth.`);
            },
          }),
          h('span', { class: 'fin-switch-track', 'aria-hidden': 'true' }),
          h('span', { 'aria-hidden': 'true' }, 'In net worth')),
        button('Edit', () => openAssetDialog(x), 'secondary fin-btn-sm', { 'data-key': `asset-edit-${x.id}`, 'aria-label': `Edit ${x.name}`, 'aria-haspopup': 'dialog' }),
        iconButton('trash', `Delete ${x.name}`, () => {
          if (!confirm(`Delete “${x.name}” and its valuations?`)) return;
          undoable(`${x.name} deleted.`, ['assets'], () => { state.assets = state.assets.filter((y) => y.id !== x.id); });
        }, { danger: true }))),
    h('dl', { class: 'fin-stats fin-asset-stats' },
      h('div', {}, h('dt', {}, x.soldOn ? 'Worth when sold' : shownAt?.estimated ? 'Worth, estimated' : 'Worth'),
        h('dd', { class: 'fin-num' }, shownAt ? money(shownAt.value, cur) : '—'),
        h('p', { class: 'fin-stat-note' }, !shownAt ? 'add a valuation below'
          : shownAt.estimated ? `from ${money(shownAt.from.value, cur)} ${shownAt.from.bought ? 'paid' : 'valued'} on ${shortDate(shownAt.from.date)}, at ${rateText(x)}`
            : shownAt.from.bought ? `its purchase price; changes at ${rateText(x)}` : `valued on ${shortDate(shownAt.from.date)}; changes at ${rateText(x)}`)),
      x.purchasePrice != null && h('div', {}, h('dt', {}, 'Bought for'), h('dd', { class: 'fin-num' }, money(x.purchasePrice, cur)),
        gain != null && h('p', { class: `fin-stat-note ${tone(gain)}` },
          `${signed(gain, cur)}${x.purchasePrice > 0 ? ` (${gain >= 0 ? '+' : ''}${num((gain / x.purchasePrice) * 100)}%)` : ''} since`)),
      cur !== 'EUR' && shownAt && h('div', {}, h('dt', {}, 'In EUR'), h('dd', { class: 'fin-num' }, money(convert(shownAt.value, latestRate(cur) ?? 1), 'EUR')),
        h('p', { class: 'fin-stat-note' }, 'at today’s rate'))),
    valueChart(x),
    valuationsList(x));
}

const prevDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);

// Its value from its first valuation (or purchase) to today (or the day before it was sold), green
// while above where it started and red below, with what it cost as a dashed line.
function valueChart(x) {
  const first = assetValuations(x)[0]?.date;
  const end = x.soldOn ? prevDay(x.soldOn) : today();
  if (!first || first >= end) return null;
  const { ends } = historyPoints(first, end);
  const dates = [...new Set([first, ...ends.map((e) => e.date), end])].sort();
  const pts = dates.map((date) => ({ date, v: assetValue(x, date)?.value ?? 0 }));
  return h('div', { class: 'fin-pad fin-asset-chart' }, timeChart(pts, {
    id: `asset-chart-${x.id}`, title: `${x.name}, worth over time`, unit: `in ${x.currency}`, format: (v) => money(v, x.currency),
    ...(x.purchasePrice != null && { ref: pts.map((p) => ({ date: p.date, v: x.purchasePrice })), refLabel: 'Bought for' }),
  }));
}

// Its valuations, newest first (the purchase among them, changed under Edit), each removable, and a
// form to add one; one a day, a new one replacing that day's. Undo takes a change back.
function valuationsList(x) {
  const cur = x.currency;
  const list = assetValuations(x).reverse();
  const date = input({ type: 'date', required: true, value: today(), 'data-key': `val-date-${x.id}` });
  const value = input({ type: 'number', step: '0.01', min: '0', required: true, inputmode: 'decimal' });
  const error = h('p', { class: 'fin-error', role: 'alert' });
  return h('details', { class: 'fin-valuations-wrap', open: list.length <= 1 },
    h('summary', {}, `Valuations (${list.length})`),
    list.length > 0 && h('ul', { class: 'fin-valuations' }, list.map((v) => h('li', {},
      h('time', { datetime: v.date }, shortDate(v.date)),
      h('span', { class: 'fin-muted' }, v.bought ? 'purchase price' : ''),
      h('span', { class: 'fin-num' }, money(v.value, cur)),
      v.bought
        ? h('span', {})
        : iconButton('trash', `Remove the valuation of ${shortDate(v.date)}`, () => undoable(`Valuation of ${shortDate(v.date)} removed.`, ['assets'], () => {
          x.valuations = (x.valuations ?? []).filter((y) => !(y.date === v.date && y.value === v.value));
        }), { danger: true })))),
    !x.soldOn && h('form', {
      class: 'fin-tx-form fin-valuation-form',
      'aria-label': `Add a valuation of ${x.name}`,
      onsubmit: (e) => {
        e.preventDefault();
        if (value.value === '' || !(toMinor(value.value) >= 0)) { error.textContent = 'Type what it was worth.'; value.focus(); return; }
        const v = { date: date.value, value: toMinor(value.value) };
        undoable(`${x.name} valued at ${money(v.value, cur)} on ${shortDate(v.date)}.`, ['assets'], () => {
          x.valuations = [...(x.valuations ?? []).filter((y) => y.date !== v.date), v].sort((a, b) => a.date.localeCompare(b.date));
        });
      },
    },
      h('p', { class: 'fin-hint' }, 'What it was worth on a day: an appraisal, a price seen for one like it, its insurance value.'),
      h('div', { class: 'fin-grid fin-grid-2' }, field('Date', date), field(`Value (${cur})`, value)),
      error,
      h('div', { class: 'fin-actions' }, h('button', { type: 'submit', class: 'fin-btn btn-primary fin-btn-sm' }, 'Add valuation'))));
}

// Adding or changing an asset: its name and kind, currency, value today (when adding: its first
// valuation), when it was bought and for how much, how its value changes in a year (empty: the
// kind's usual), the lowest it can fall to, and when it was sold. (Whether it counts in net worth
// is on its card.)
export function openAssetDialog(existing = null) {
  const x0 = existing ?? {};
  const money0 = (v) => (v != null ? String(v / 100) : null);
  const name = input({ type: 'text', required: true, autocomplete: 'off', value: x0.name, placeholder: 'e.g. Home, Car' });
  const kind = select(Object.entries(ASSET_KINDS), x0.kind ?? 'home');
  const cur = select(CURRENCIES.map((c) => [c, c]), x0.currency ?? 'EUR');
  const valueNow = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal' });
  const boughtOn = input({ type: 'date', value: x0.boughtOn ?? null });
  const purchase = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: money0(x0.purchasePrice) });
  const change = input({ type: 'number', step: '0.1', min: '-100', max: '100', inputmode: 'decimal', value: x0.valueChange != null ? String(x0.valueChange) : null });
  const floor = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: money0(x0.valueFloor) });
  const floorField = field('Lowest value', floor, 'Optional. A falling estimate stops here (what it would sell for at worst).');
  const soldOn = input({ type: 'date', value: x0.soldOn ?? null });
  const error = h('p', { class: 'fin-error', role: 'alert' });
  const syncKind = () => {
    const usual = ASSET_CHANGE[kind.value];
    change.placeholder = `${usual > 0 ? '+' : ''}${usual}`;
    floorField.hidden = kind.value === 'home';
  };
  kind.addEventListener('change', syncKind);
  syncKind();
  const returnKey = existing ? `asset-edit-${existing.id}` : 'asset-add';
  const close = () => { dialog.close(); render(returnKey); };
  dialog.replaceChildren(h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      if (!existing && valueNow.value === '' && purchase.value === '') {
        error.textContent = 'Give its value today or what it was bought for, so it has a value to start from.';
        valueNow.focus();
        return;
      }
      const fields = {
        name: name.value.trim(), kind: kind.value, currency: cur.value,
        purchasePrice: purchase.value !== '' ? toMinor(purchase.value) : null, boughtOn: boughtOn.value || null,
        valueChange: change.value !== '' ? Number(change.value) : null,
        valueFloor: kind.value !== 'home' && floor.value !== '' ? toMinor(floor.value) : null,
        soldOn: soldOn.value || null,
      };
      const apply = (x) => { for (const [k, v] of Object.entries(fields)) { if (v == null || v === false) delete x[k]; else x[k] = v; } };
      dialog.close();
      if (existing) {
        undoable(`Saved ${fields.name}.`, ['assets'], () => apply(existing));
      } else {
        const x = { id: newId(), valuations: valueNow.value !== '' ? [{ date: today(), value: toMinor(valueNow.value) }] : [] };
        apply(x);
        undoable(`Added ${x.name}.`, ['assets'], () => { state.assets.push(x); });
      }
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, existing ? `Edit ${existing.name}` : 'Add asset'),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Name', name), field('Kind', kind),
      field('Currency', cur),
      !existing && field('Value today', valueNow, 'Its first valuation. Add more later on its card.'),
      field('Bought on', boughtOn), field('Purchase price', purchase, 'Optional. Shows the gain or loss on it.'),
      field('Yearly change (%)', change, 'How its value moves in a year between valuations: + grows (a home), − falls (a car). Empty: the usual for its kind.'),
      floorField,
      existing && field('Sold on', soldOn, 'From then it’s worth nothing to you, and it moves under Sold.')),
    error,
    h('div', { class: 'fin-dialog-actions' },
      button('Cancel', close),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, existing ? 'Save' : 'Add asset'))));
  dialog.showModal();
  name.focus();
}
