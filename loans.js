// A loan's Insights tab: where it stands against the agreed term, the interest it has cost so far and
// what's left, what paying in advance would change (a shorter loan, or smaller payments; with the
// bank's fee), and its changes over time (a new rate, a new term or payment).

import { today } from './market.js';
import {
  addInterval, annuityPayment, crossConvert, loanInterestSoFar, loanPlan, loanRateAt, loanTerm,
  makeTransfer, newId, toMinor,
} from './model.js';
import { accountValue, ensureRate, render, state, undoable } from './app.js';
import { timeChart } from './holdings.js';
import { transactionsLoaded } from './insights.js';
import {
  button, dialog, field, fullDate, h, iconButton, input, loader, money, num, select,
} from './ui.js';

// What was typed in "Paying in advance", per loan, kept while moving around the app.
const whatIf = new Map();

// The loan's monthly repayment: a monthly transfer schedule into it.
const repaymentOf = (account) => state.schedules.find((s) => s.kind === 'transfer' && s.toAccountId === account.id
  && s.unit === 'month' && s.every === 1 && (!s.endDate || s.endDate >= today()));

const months = (n) => `${n} month${n === 1 ? '' : 's'}`;
const pct = (r) => `${num(r, 2)}%`;
const monthIndex = (iso) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
// Accounts a payment into the loan can come from.
const payingAccounts = () => state.accounts.filter((a) => !a.archived && a.type !== 'loan' && a.type !== 'credit');

// The monthly payment as things stand: the schedule's, else the latest one set by a change, else the
// one that pays what's owed off in the payments left.
function currentPayment(account, owed, rate, term) {
  const s = repaymentOf(account);
  if (s) return s.amount;
  const set = (account.loanChanges ?? []).filter((c) => c.payment != null && c.date <= today())
    .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (set) return set.payment;
  return term?.left ? annuityPayment(owed, rate, term.left) : 0;
}

// The account header's card for a loan: the next payment, how much, and where it falls in the term.
export function nextPaymentCard(account, value) {
  const owed = Math.max(0, -value);
  if (!owed) return null;
  const now = today();
  const term = loanTerm(account, now);
  const s = repaymentOf(account);
  const date = s?.nextDate ?? term?.next;
  const amount = currentPayment(account, owed, loanRateAt(account, now), term);
  if (!date || !amount) return null;
  return h('div', {}, h('dt', {}, 'Next payment'),
    h('dd', { class: 'fin-num' }, money(amount, account.currency)),
    h('p', { class: 'fin-stat-note' }, [
      fullDate(date),
      term?.left && `payment ${term.made + 1} of ${term.made + term.left}`,
      term?.end && `the last on ${fullDate(term.end)}`,
    ].filter(Boolean).join(' · ')));
}

export function loanInsights(account) {
  if (!transactionsLoaded(`account:${account.id}`, `&account_id=eq.${encodeURIComponent(account.id)}`)) {
    return h('div', { class: 'fin-insights' }, loader('Working out the loan…'));
  }
  const cur = account.currency;
  const now = today();
  const owed = Math.max(0, -accountValue(account));
  const rateOn = (d) => loanRateAt(account, d);
  const rate = rateOn(now);
  const term = loanTerm(account, now);
  const own = state.transactions.filter((t) => t.accountId === account.id && t.date <= now);
  // Interest recorded on the loan (money out of it that isn't a transfer or the opening balance)
  // is what it cost; without any, it's estimated from what was owed each month, at the rate then.
  const recorded = own.filter((t) => t.amount < 0 && !t.transferId && t.kind !== 'opening');
  const soFar = recorded.length ? -recorded.reduce((sum, t) => sum + t.amount, 0) : loanInterestSoFar(own, rateOn, now);
  const repayment = repaymentOf(account);
  const first = term?.next ?? repayment?.nextDate ?? addInterval(now, { every: 1, unit: 'month' }, Number(now.slice(8, 10)));
  const w = whatIf.get(account.id) ?? { payment: '', lump: '', extra: '', fee: '' };
  whatIf.set(account.id, w);
  const usual = currentPayment(account, owed, rate, term);

  const paidSoFar = () => h('div', {}, h('dt', {}, 'Interest paid so far'),
    h('dd', { class: 'fin-num' }, money(soFar, cur)),
    h('p', { class: 'fin-stat-note' }, recorded.length ? 'as recorded on this account'
      : rate || account.loanChanges?.length ? 'estimated from what was owed each month' : 'set the interest rate to estimate it'));
  if (owed === 0) {
    return h('div', { class: 'fin-insights' },
      h('dl', { class: 'fin-stats' }, h('div', { class: 'fin-stat-key' }, h('dt', {}, 'Still owed'), h('dd', { class: 'fin-num' }, money(0, cur)),
        h('p', { class: 'fin-stat-note' }, 'paid off')), paidSoFar()),
      changesSection(account));
  }

  const box = (key, label, hint, attrs = {}) => {
    const el = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: w[key] || null, 'data-key': `loan-${key}`, ...attrs });
    el.addEventListener('input', () => { w[key] = el.value; draw(); });
    return field(label, el, hint);
  };
  // The figures and the outcome below the inputs follow what's typed, without redrawing the inputs.
  const statsOut = h('div', {});
  const planOut = h('div', {});
  // (replaceChildren would print a `false` left by a condition as text: those are dropped.)
  const draw = () => { const [stats, plan] = results(); statsOut.replaceChildren(stats); planOut.replaceChildren(...plan.filter(Boolean)); };

  function results() {
    const payment = w.payment !== '' ? toMinor(w.payment) : usual;
    const lump = Math.min(owed, toMinor(w.lump || 0));
    const extra = toMinor(w.extra || 0);
    const fee = Math.round((lump * Number(w.fee || 0)) / 100);
    const owedCard = h('div', { class: 'fin-stat-key' }, h('dt', {}, 'Still owed'),
      h('dd', { class: 'fin-num fin-neg' }, money(owed, cur)),
      h('p', { class: 'fin-stat-note' }, rate ? `at ${pct(rate)} a year` : 'no interest rate set (Edit the account)'));
    const termCard = term && h('div', {}, h('dt', {}, 'Payments'),
      h('dd', {}, `${term.made} of ${term.made + term.left}`),
      h('p', { class: 'fin-stat-note' }, term.left ? `${term.left} left, the last agreed for ${fullDate(term.end)}` : 'all made'));
    if (!(payment > 0)) {
      return [h('dl', { class: 'fin-stats' }, owedCard, termCard, paidSoFar()),
        [h('p', { class: 'fin-empty' }, 'Enter the monthly payment, or the number of payments (Edit the account), to see when the loan ends and the interest still to pay.')]];
    }
    const base = loanPlan({ owed, rate: rateOn, payment, first, start: now });
    if (base.never) {
      return [h('dl', { class: 'fin-stats' }, owedCard, termCard, paidSoFar()),
        [h('p', { class: 'fin-error', role: 'alert' }, `A payment of ${money(payment, cur)} doesn’t cover a month’s interest (${money(base.due, cur)}), so the loan would never be paid off.`)]];
    }
    // Against the agreed term: when these payments would end it.
    const drift = term?.end ? monthIndex(base.end) - monthIndex(term.end) : 0;
    const stats = h('dl', { class: 'fin-stats' }, owedCard, termCard, paidSoFar(),
      h('div', {}, h('dt', {}, 'Interest still to pay'), h('dd', { class: 'fin-num' }, money(base.interest, cur)),
        h('p', { class: 'fin-stat-note' }, `over ${base.months} more payment${base.months === 1 ? '' : 's'} of ${money(payment, cur)}`)),
      h('div', {}, h('dt', {}, 'Last payment'), h('dd', {}, fullDate(base.end)),
        h('p', { class: 'fin-stat-note' }, !term?.end ? `${money(base.paid, cur)} still to pay in all`
          : drift === 0 ? 'as agreed'
            : `${months(Math.abs(drift))} ${drift < 0 ? 'before' : 'after'} the agreed ${fullDate(term.end)}`)));

    // Paying in advance: the same payment, ending sooner; or (a lump) the same end, smaller payments.
    const advance = lump > 0 || extra > 0;
    const alt = advance ? loanPlan({ owed, rate: rateOn, payment, extra, lump, first, start: now }) : null;
    const left = term?.left || base.months;
    const lower = lump > 0 ? annuityPayment(owed - lump, rate, left) : 0;
    const lowerPlan = lump > 0 ? loanPlan({ owed: owed - lump, rate: rateOn, payment: lower, first, start: now }) : null;
    const lines = [];
    if (alt && alt.months === 0) {
      lines.push(`That pays the loan off today: none of the ${money(base.interest, cur)} interest still to pay${fee ? `, for a ${money(fee, cur)} fee` : ''}.`);
    } else if (alt) {
      const saved = base.interest - alt.interest;
      lines.push(`Shorter loan, keeping the payment${extra ? ` (${money(payment + extra, cur)} a month with the extra)` : ''}: the last one on ${fullDate(alt.end)}, ${months(base.months - alt.months)} sooner, with ${money(saved, cur)} less interest${fee ? `, ${money(saved - fee, cur)} after the ${money(fee, cur)} fee` : ''}.`);
      if (lowerPlan && !lowerPlan.never && lower < payment) {
        const less = base.interest - lowerPlan.interest;
        lines.push(`Lower payment, keeping the end date: payments of ${money(lower, cur)} (${money(payment - lower, cur)} less a month), with ${money(less, cur)} less interest${fee ? `, ${money(less - fee, cur)} after the fee` : ''}.`);
      }
    }
    const owedOver = (plan) => plan.points.map((p) => ({ date: p.date, v: p.owed }));
    return [stats, [
      h('div', { class: 'fin-loan-outcome', role: 'status' }, ...lines.map((t) => h('p', {}, t))),
      base.points.length > 1 && timeChart(owedOver(base), {
        id: `loan-${account.id}`, title: 'Still owed until paid off', unit: cur, format: (v) => money(v, cur), wide: true, kind: 'owed',
        ref: alt && alt.points.length > 1 ? owedOver(alt) : null, refLabel: 'Paying in advance',
      }),
    ]];
  }
  draw();

  return h('div', { class: 'fin-insights' },
    statsOut,
    h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'loan-advance-h' },
      h('h3', { id: 'loan-advance-h', class: 'fin-label' }, 'What if you paid in advance'),
      h('p', { class: 'fin-meta' }, 'Try amounts here. To record a payment you made, use Pay in advance… on the account.'),
      h('div', { class: 'fin-grid fin-grid-2' },
        box('payment', 'Monthly payment', `${repayment ? 'From its schedule' : 'Worked out from the term'}${usual ? `: ${money(usual, cur)}` : ''}. Type another to try it.`, { placeholder: usual ? String(usual / 100) : '' }),
        box('lump', 'Pay once, now', 'Taken off what’s owed today.'),
        box('extra', 'Extra each month', 'Paid on top of every payment.'),
        box('fee', 'Early repayment fee (%)', 'What the bank charges on what’s paid early, if anything.', { max: '100' })),
      planOut,
      h('p', { class: 'fin-stat-note' },
        'Worked out as banks do: each month interest is added on what’s owed, then the payment comes off. ',
        'Fin’s balance drops by the whole payment unless the interest is recorded too: add it each month as money out of this account and the balance follows your statement (and the interest paid so far uses it).')),
    changesSection(account));
}

// Records a one-off payment into the loan (a transfer from `from`, and the bank's fee as an expense
// there), and what it changed: the payments left (`shorter`, a plan) or the monthly payment (neither
// when there's no payment to work from).
async function recordAdvance(account, { lump, fee, from, date, shorter = null, payment = null }) {
  const src = state.accounts.find((a) => a.id === from);
  if (!src) return;
  const [rf, rt] = [await ensureRate(src.currency, date), await ensureRate(account.currency, date)];
  const sent = src.currency === account.currency || rf == null || rt == null ? lump : crossConvert(lump, rt, rf);
  const legs = makeTransfer({ from: src, to: account, sent, received: lump, date, description: `${account.name} early repayment` });
  legs[0].rate = rf;
  legs[1].rate = rt;
  const feeTx = fee > 0 && {
    id: newId(), accountId: src.id, date, description: `${account.name} early repayment fee`,
    amount: -(src.currency === account.currency || rf == null || rt == null ? fee : crossConvert(fee, rt, rf)), categoryIds: [], memo: '', rate: rf,
  };
  const s = repaymentOf(account);
  const what = shorter?.months === 0 ? ': the loan is paid off'
    : shorter ? `: ${shorter.months} payment${shorter.months === 1 ? '' : 's'} left, the last on ${fullDate(shorter.end)}`
      : payment ? `: payments of ${money(payment, account.currency)} from now on` : '';
  undoable(`Recorded ${money(lump, account.currency)} paid early on ${account.name}${what}.`,
    ['transactions', 'accounts', 'schedules'], () => {
      state.transactions.push(...legs, ...(feeTx ? [feeTx] : []));
      const change = shorter ? { date, payments: shorter.months } : payment ? { date, payment } : null;
      if (change) account.loanChanges = [...(account.loanChanges ?? []), change];
      if (s && shorter) s.endDate = shorter.end ?? date;
      if (s && payment) s.amount = payment;
    });
}

// ── changes over time: a new rate, a new term, a new payment ───────────────

function changesSection(account) {
  const cur = account.currency;
  const list = [...(account.loanChanges ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const describe = (c) => [
    c.rate != null && `rate ${pct(c.rate)}`,
    c.payments != null && `${c.payments} payment${c.payments === 1 ? '' : 's'} left`,
    c.payment != null && `payment ${money(c.payment, cur)}`,
  ].filter(Boolean).join(' · ');
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'loan-changes-h' },
    h('h3', { id: 'loan-changes-h', class: 'fin-label' }, 'Rate and term changes'),
    list.length === 0
      ? h('p', { class: 'fin-empty' }, `None yet. It started at ${pct(account.interestRate ?? 0)} a year${account.loanPayments ? ` over ${account.loanPayments} payments` : ''}. Add the bank’s rate revisions, and changes to the term or the payment, with Change rate or term… on the account.`)
      : h('ul', { class: 'fin-loan-changes' },
        ...list.map((c) => h('li', {},
          h('span', { class: 'fin-loan-change-date' }, fullDate(c.date)),
          h('span', {}, describe(c)),
          iconButton('trash', `Delete the change of ${fullDate(c.date)}`, () => {
            undoable('Change deleted.', ['accounts'], () => { account.loanChanges = account.loanChanges.filter((x) => x !== c); });
          }, { danger: true }))),
        h('li', { class: 'fin-loan-change-start' },
          h('span', { class: 'fin-loan-change-date' }, account.loanFirst ? fullDate(account.loanFirst) : 'Start'),
          h('span', {}, [`rate ${pct(account.interestRate ?? 0)}`, account.loanPayments && `${account.loanPayments} payments`].filter(Boolean).join(' · ')))));
}

export function openChangeDialog(account) {
  const cur = account.currency;
  const owed = Math.max(0, -accountValue(account));
  const term = loanTerm(account, today());
  const date = input({ type: 'date', required: true, value: today() });
  const rate = input({ type: 'number', step: '0.001', min: '0', max: '100', inputmode: 'decimal' });
  const payments = input({ type: 'number', step: '1', min: '0', max: '1200', inputmode: 'numeric' });
  const payment = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal' });
  const s = repaymentOf(account);
  const update = h('input', { type: 'checkbox', checked: true });
  const error = h('p', { class: 'fin-error', role: 'alert' });
  const close = () => { dialog.close(); render('loan-change'); };
  dialog.replaceChildren(h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      if (rate.value === '' && payments.value === '' && payment.value === '') { error.textContent = 'Fill in at least one of the rate, the payments left or the payment.'; rate.focus(); return; }
      const change = { date: date.value };
      if (rate.value !== '') change.rate = Number(rate.value);
      if (payments.value !== '') change.payments = Math.round(Number(payments.value));
      if (payment.value !== '') change.payment = toMinor(payment.value);
      undoable(`Change of ${fullDate(change.date)} added to ${account.name}.`, ['accounts', 'schedules'], () => {
        account.loanChanges = [...(account.loanChanges ?? []), change];
        if (!s || !update.checked) return;
        // The scheduled payment follows: as the bank set it, else the one that pays what's owed off
        // in the payments left at the new rate.
        const t = loanTerm(account, today());
        const amount = change.payment ?? (t?.left ? annuityPayment(owed, loanRateAt(account, change.date), t.left) : null);
        if (amount) s.amount = amount;
        if (change.payments != null && t?.end) s.endDate = t.end;
      });
      dialog.close();
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, `Change to ${account.name}`),
    h('p', { class: 'fin-meta' }, 'From the date on: a new interest rate (a variable rate revised), the payments left (the bank shortened or lengthened the loan), or a new monthly payment. Fill in what changed.'),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('From', date),
      field('Interest rate (% a year)', rate, `Now ${pct(loanRateAt(account, today()))}.`),
      field('Payments left', payments, term ? `Now ${term.left}, counting the next one.` : 'Counting the next one.'),
      field('Monthly payment', payment, `As the bank set it. Left empty, it’s worked out from what’s owed (${money(owed, cur)}).`)),
    s && h('label', { class: 'fin-check' }, update, ` Update the scheduled payment (${money(s.amount, cur)} from ${state.accounts.find((a) => a.id === s.accountId)?.name ?? 'another account'})`),
    error,
    h('div', { class: 'fin-dialog-actions' },
      button('Cancel', close),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Add change'))));
  dialog.showModal();
  rate.focus();
}

// ── paying in advance ──────────────────────────────────────────────────────

// Records a one-off payment into the loan, and what the bank did with it: kept the payment and
// shortened the loan, or kept the end date and lowered the payment. Each choice shows what it means.
export function openAdvanceDialog(account) {
  const cur = account.currency;
  const now = today();
  const owed = Math.max(0, -accountValue(account));
  const rateOn = (d) => loanRateAt(account, d);
  const term = loanTerm(account, now);
  const payment = currentPayment(account, owed, rateOn(now), term);
  const first = term?.next ?? repaymentOf(account)?.nextDate ?? addInterval(now, { every: 1, unit: 'month' }, Number(now.slice(8, 10)));
  const sources = payingAccounts();
  const amount = input({ type: 'number', step: '0.01', min: '0.01', max: String(owed / 100), required: true, inputmode: 'decimal' });
  const date = input({ type: 'date', required: true, value: now });
  const from = select(sources.map((a) => [a.id, a.name]), repaymentOf(account)?.accountId ?? sources[0]?.id);
  const feePct = input({ type: 'number', step: '0.01', min: '0', max: '100', inputmode: 'decimal' });
  const radio = (value, label, checked) => {
    const el = h('input', { type: 'radio', name: 'loan-advance', value, checked });
    el.addEventListener('change', preview);
    return h('label', { class: 'fin-check' }, el, ` ${label}`);
  };
  const choice = h('fieldset', { class: 'fin-fieldset' }, h('legend', { class: 'fin-legend-label' }, 'What the bank does with it'),
    radio('shorter', 'Shortens the loan (the payment stays)', true),
    radio('lower', 'Lowers the payment (the end date stays)', false));
  const out = h('div', { class: 'fin-loan-outcome', role: 'status' });
  const error = h('p', { class: 'fin-error', role: 'alert' });
  const picked = () => choice.querySelector('input:checked').value;

  // What each choice would do with the amount typed: the new end or payment, and the interest saved.
  const outcome = () => {
    const lump = Math.min(owed, toMinor(amount.value || 0));
    if (!(lump > 0) || !(payment > 0)) return { lump };
    const fee = Math.round((lump * Number(feePct.value || 0)) / 100);
    const base = loanPlan({ owed, rate: rateOn, payment, first, start: now });
    if (base.never) return { lump, fee };
    const shorter = loanPlan({ owed, rate: rateOn, payment, lump, first, start: now });
    const lower = annuityPayment(owed - lump, rateOn(now), term?.left || base.months);
    const lowerPlan = loanPlan({ owed: owed - lump, rate: rateOn, payment: lower, first, start: now });
    return { lump, fee, base, shorter, lower, lowerPlan };
  };
  function preview() {
    const o = outcome();
    const lines = [];
    if (o.base && o.shorter.months === 0) lines.push(`That pays the loan off: none of the ${money(o.base.interest, cur)} interest still to pay.`);
    else if (o.base && picked() === 'shorter') {
      const saved = o.base.interest - o.shorter.interest;
      lines.push(`The last payment moves to ${fullDate(o.shorter.end)}, ${months(o.base.months - o.shorter.months)} sooner, with ${money(saved, cur)} less interest${o.fee ? ` (${money(saved - o.fee, cur)} after the ${money(o.fee, cur)} fee)` : ''}.`);
    } else if (o.base && !o.lowerPlan.never) {
      const less = o.base.interest - o.lowerPlan.interest;
      lines.push(`Payments become ${money(o.lower, cur)}, ${money(payment - o.lower, cur)} less a month, with ${money(less, cur)} less interest${o.fee ? ` (${money(less - o.fee, cur)} after the ${money(o.fee, cur)} fee)` : ''}.`);
    }
    out.replaceChildren(...lines.map((t) => h('p', {}, t)));
  }
  [amount, feePct].forEach((el) => el.addEventListener('input', preview));
  const close = () => { dialog.close(); render('loan-advance'); };

  dialog.replaceChildren(h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const o = outcome();
      if (!(o.lump > 0)) { error.textContent = 'Enter the amount paid.'; amount.focus(); return; }
      if (!from.value) { error.textContent = 'Pick the account it was paid from.'; from.focus(); return; }
      const fee = o.fee ?? 0;
      dialog.close();
      // Without a payment to work from, the payment is recorded alone, the term left as it was.
      if (!o.base || o.base.never) recordAdvance(account, { lump: o.lump, fee, from: from.value, date: date.value });
      else if (picked() === 'shorter' || o.shorter.months === 0) recordAdvance(account, { lump: o.lump, fee, from: from.value, date: date.value, shorter: o.shorter });
      else recordAdvance(account, { lump: o.lump, fee, from: from.value, date: date.value, payment: o.lower });
    },
  },
    h('h2', { id: 'account-dialog-h', class: 'fin-dialog-title' }, `Pay ${account.name} in advance`),
    h('p', { class: 'fin-meta' }, `${money(owed, cur)} owed${payment ? `, ${money(payment, cur)} a month` : ''}${term?.left ? `, ${term.left} payments left` : ''}.`),
    h('div', { class: 'fin-grid fin-grid-2' },
      field('Amount', amount), field('Date', date),
      field('Paid from', from), field('Early repayment fee (%)', feePct, 'What the bank charges on it, if anything. Added as an expense where it was paid from.')),
    choice,
    out,
    error,
    h('div', { class: 'fin-dialog-actions' },
      button('Cancel', close),
      h('button', { type: 'submit', class: 'fin-btn btn-primary' }, 'Record payment'))));
  dialog.showModal();
  amount.focus();
}
