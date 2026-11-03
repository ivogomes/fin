import test from 'node:test';
import assert from 'node:assert/strict';
import { makeZip, readZip, crc32 } from './zip.js';
import {
  toMinor, formatMoney, categorize, convert, rateFor, accountBalance, plannedTransactions,
  holdingValue, investmentValue, netWorth, defaultState, withRunningBalance,
  crossConvert, batchRow, makeTransfer,
  parseCsv, toCsv, parseAmount, parseDate, guessDateFormat, guessDecimal, guessMapping, importRows,
  findTransferPairs, detectBuxferFile, buxferImport, isFundMovements, fundMovementsToFt,
  categoryPath, categoryResolver, categoriesOf, sortedCategories, searchCategories,
  parseBuxferIou, iouSign, iouType, personBalances, personHistory,
  periodRange, granularity, insights, completeMonths, holdingHistory, accountRuns, historyPoints, incomeCategories, REFUNDS_UNMATCHED, netWorthHistory, isFtExport, ftImport, lotSummary, investedHistory,
  descriptionIndex, suggestDescriptions, filterTransactions, ruleSuggestion,
  parseFrequency, addInterval, occurrences, forecast, scheduledTransactions, advanceSchedule,
  splitsOf, scaleSplits, DIVIDENDS, recurringGroups, suggestSchedules, xirr, lotFlows, returnSummary, rulesFromHistory, findSubscriptions, withMarkedSchedules, timesAYear,
  lastStatementDate, dueAfter, balanceDip, savingsInterest,
} from './model.js';

test('periods: presets relative to today, Monday weeks, granularity', () => {
  const today = '2026-11-04'; // a Wednesday
  assert.deepEqual(periodRange('this-week', today), { from: '2026-11-02', to: '2026-11-08' });
  assert.deepEqual(periodRange('last-week', today), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(periodRange('this-month', today), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(periodRange('last-month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(periodRange('last-12m', today), { from: '2025-12-01', to: '2026-11-30' });
  assert.deepEqual(periodRange('last-year', today), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(periodRange('all', today, { first: '2014-03-11' }), { from: '2014-03-11', to: today });
  assert.deepEqual(periodRange('custom', today, { from: '2026-01-01', to: '2026-03-31' }), { from: '2026-01-01', to: '2026-03-31' });
  assert.equal(granularity('2026-11-02', '2026-11-08'), 'day');
  assert.equal(granularity('2026-11-01', '2026-11-30'), 'week');
  assert.equal(granularity('2026-01-01', '2026-12-31'), 'month');
  assert.equal(granularity('2014-01-01', '2026-12-31'), 'year');
});

test('insights: transfers and openings ignored, IOUs netted, refunds lower spending, USD converted', () => {
  const accounts = [{ id: 'eur', currency: 'EUR' }, { id: 'usd', currency: 'USD' }];
  const categories = [{ id: 'casa', name: 'Casa', parentId: null }, { id: 'luz', name: 'Luz', parentId: 'casa' }, { id: 'sal', name: 'Salary', parentId: null }];
  const tx = [
    { id: 's', accountId: 'eur', date: '2026-10-27', amount: 300000, categoryIds: ['sal'], rate: 1 },
    { id: 'l', accountId: 'eur', date: '2026-10-28', amount: -6000, categoryIds: ['luz'], rate: 1 },
    { id: 'r', accountId: 'eur', date: '2026-10-29', amount: 1000, categoryIds: ['luz'], rate: 1, kind: 'refund' },
    { id: 't1', accountId: 'eur', date: '2026-10-10', amount: -50000, transferId: 'x', rate: 1 },
    { id: 'o', accountId: 'eur', date: '2026-10-01', amount: 99999, kind: 'opening', rate: 1 },
    { id: 'loan', accountId: 'eur', date: '2026-10-05', amount: -900000, rate: 1 },
    { id: 'bill', accountId: 'eur', date: '2026-10-06', amount: -754, categoryIds: ['casa'], rate: 1 },
    { id: 'u', accountId: 'usd', date: '2026-10-07', amount: -10000, rate: 0.9 },
    { id: 'out', accountId: 'eur', date: '2026-09-30', amount: -100, rate: 1 }, // outside the period
  ];
  const ious = [{ transactionId: 'loan', amount: 900000 }, { transactionId: 'bill', amount: 500 }];
  const r = insights(tx, { from: '2026-10-01', to: '2026-10-31', accounts, categories, ious });
  assert.equal(r.income, 300000);
  assert.equal(r.expenses, 6000 - 1000 + 254 + 9000);
  assert.equal(r.refunds, 1000);
  assert.equal(r.net, 300000 - 14254);
  const casa = r.spending.find((c) => c.id === 'casa');
  assert.equal(casa.amount, 5000 + 254); // electricity after its refund, plus my share of the bill
  assert.deepEqual(casa.children, [{ id: 'luz', amount: 5000 }]);
  assert.equal(r.earning.find((c) => c.id === 'casa'), undefined); // a refund is never income
  assert.equal(r.spending.find((c) => c.id === '').amount, 9000); // uncategorised USD spend
  assert.equal(r.unit, 'week');
  assert.equal(r.series.reduce((s, b) => s + b.expenses, 0), r.expenses);
  const onlyUsd = insights(tx, { from: '2026-10-01', to: '2026-10-31', accounts, categories, ious, accountIds: new Set(['usd']) });
  assert.deepEqual([onlyUsd.income, onlyUsd.expenses], [0, 9000]);
});

test('net worth history: archived accounts close, investments at cost then snapshots then holdings', () => {
  const accounts = [
    { id: 'bank', type: 'checking', currency: 'EUR' },
    { id: 'old', type: 'savings', currency: 'EUR', archived: true },
    { id: 'etf', type: 'investment', currency: 'EUR' },
    { id: 'usd', type: 'checking', currency: 'USD' },
  ];
  const transactions = [
    { accountId: 'bank', date: '2026-01-05', amount: 100000, rate: 1 },
    { accountId: 'old', date: '2026-01-10', amount: 50000, rate: 1 },
    { accountId: 'old', date: '2026-03-10', amount: -45000, rate: 1 }, // closed with a 5,000 leftover
    { accountId: 'bank', date: '2026-03-10', amount: 45000, rate: 1 },
    { accountId: 'bank', date: '2026-02-01', amount: -30000, rate: 1 },
    { accountId: 'etf', date: '2026-02-01', amount: 30000, rate: 1 },
    { accountId: 'usd', date: '2026-01-20', amount: 10000, rate: 0.9 },
  ];
  const snapshots = [{ date: '2026-04-15', values: { etf: 33000 } }];
  const { points, unit, firstSnapshot } = netWorthHistory({ accounts, transactions, snapshots }, {
    from: '2026-01-01', to: '2026-05-31', today: '2026-05-20', holdingsValue: (a) => (a.id === 'etf' ? 36000 : null),
  });
  assert.equal(unit, 'month');
  assert.equal(firstSnapshot, '2026-04-15');
  const at = (k) => points.find((p) => p.key === k);
  assert.equal(at('2026-01').total, 100000 + 50000 + 9000);
  assert.equal(at('2026-02').total, 70000 + 50000 + 30000 + 9000); // the ETF at cost
  assert.equal(at('2026-03').total, 115000 + 30000 + 9000); // the old account closed: its leftover is gone
  assert.equal(at('2026-04').investments, 33000); // snapshot
  assert.equal(at('2026-05').date, '2026-05-31');
  assert.equal(at('2026-05').investments, 36000); // today's holdings
  assert.equal(at('2026-05').byType.checking, 115000 + 9000);
});

test('lots: FT.com import matches holdings, skips duplicates and dividends, recalculates units', () => {
  const rows = parseCsv([
    'Date,Name,Symbol,Type,Quantity,Price,Price Currency,Fees,Fees Currency,Shares,Amount',
    '2024-01-11,Vanguard FTSE All-World,VWCE:FRA:EUR,Long buy,175,138.4353,EUR,0,EUR,,',
    '2026-03-19,Vanguard FTSE All-World,VWCE:FRA:EUR,Long buy,25,145.1,EUR,0,EUR,,',
    '2026-04-01,Vanguard FTSE All-World,VWCE:FRA:EUR,Long sell,50,150,EUR,2,EUR,,',
    '2025-11-11,iShares Core S&P 500,SXR8:GER:EUR,Long buy,30,576.9083,EUR,0,EUR,,',
    '2026-05-01,Vanguard FTSE All-World,VWCE:FRA:EUR,Dividend,0,0,EUR,0,EUR,,',
  ].join('\n'));
  assert.ok(isFtExport(rows[0]));
  let n = 0;
  const ctx = { id: () => `n${++n}`, holdings: [{ id: 'h1', accountId: 'etf', symbol: 'VWCE', quantity: 1520, mic: null }], lots: [] };
  const res = ftImport(rows, 'etf', ctx);
  assert.equal(res.newLots.length, 4);
  assert.equal(res.skipped.length, 1);
  assert.deepEqual(res.holdingUpdates, [{ id: 'h1', quantity: 150, before: 1520, mic: 'XFRA', exchange: 'Frankfurt' }]);
  assert.equal(res.newHoldings.length, 1);
  assert.deepEqual([res.newHoldings[0].symbol, res.newHoldings[0].mic, res.newHoldings[0].quantity, res.newHoldings[0].price], ['SXR8', 'XETR', 30, 576.9083]);
  const again = ftImport(rows, 'etf', { ...ctx, holdings: [...ctx.holdings, ...res.newHoldings], lots: res.newLots });
  assert.deepEqual([again.newLots.length, again.duplicates], [0, 4]);

  const s = lotSummary(res.newLots.filter((l) => l.holdingId === 'h1'));
  assert.equal(s.quantity, 150);
  // 175 @ 138.4353 + 25 @ 145.1, then 50 sold at the average cost: 150 units keep 150/200 of the cost
  assert.equal(s.cost, Math.round(((175 * 138.4353 + 25 * 145.1) * 150) / 200 * 100));
});

test('net worth history: investments from lots before snapshots', () => {
  const accounts = [{ id: 'etf', type: 'investment', currency: 'EUR' }];
  const holdings = [{ id: 'h', accountId: 'etf', currency: 'EUR' }];
  const lots = [
    { holdingId: 'h', date: '2024-01-11', kind: 'buy', quantity: 100, price: 100 },
    { holdingId: 'h', date: '2025-06-01', kind: 'buy', quantity: 50, price: 120 },
  ];
  const transactions = [{ accountId: 'etf', date: '2024-01-10', amount: 1000000, rate: 1 }, { accountId: 'etf', date: '2025-05-30', amount: 600000, rate: 1 }];
  const { points } = netWorthHistory({ accounts, transactions, holdings, lots }, {
    from: '2023-01-01', to: '2026-12-31', today: '2026-11-02', holdingsValue: () => 2100000,
  });
  const at = (k) => points.find((p) => p.key === k).investments;
  assert.equal(at('2023'), 0);
  assert.equal(at('2024'), 100 * 100 * 100); // 100 units at the last trade price
  assert.equal(at('2025'), 150 * 120 * 100); // 150 units, priced at the latest buy
  assert.equal(at('2026'), 2100000); // today: market value
});

test('invested over time: from lots when every holding has them, otherwise money moved in', () => {
  const account = { id: 'etf', currency: 'EUR' };
  const holdings = [{ id: 'h', accountId: 'etf', currency: 'EUR' }];
  const lots = [
    { holdingId: 'h', date: '2024-01-11', kind: 'buy', quantity: 100, price: 100, fees: 5 },
    { holdingId: 'h', date: '2025-06-01', kind: 'sell', quantity: 50, price: 130 },
  ];
  const transactions = [{ accountId: 'etf', date: '2024-01-10', amount: 1000000, rate: 1 }];
  const dates = ['2023-12-31', '2024-12-31', '2025-12-31'];
  assert.deepEqual(investedHistory(account, { transactions, holdings, lots }, dates), [0, 1000500, 500250]);
  assert.deepEqual(investedHistory(account, { transactions, holdings, lots: [] }, dates), [0, 1000000, 1000000]);
});

test('description suggestions: one per name, latest use wins, ranked by match, account, use, date', () => {
  const tx = [
    { accountId: 'a', date: '2026-01-01', description: 'Continente', amount: -3000, categoryIds: ['groc'] },
    { accountId: 'a', date: '2026-03-01', description: 'continente', amount: -4500, categoryIds: ['groc', 'casa'] },
    { accountId: 'b', date: '2026-02-01', description: 'Café Continental', amount: -150, categoryIds: ['cafe'] },
    { accountId: 'a', date: '2026-02-10', description: 'Pingo Doce Continente', amount: -2000, categoryIds: [] },
    { accountId: 'a', date: '2026-02-11', description: 'Refund Continente', amount: 500, kind: 'refund', categoryIds: ['groc'] },
    { accountId: 'a', date: '2026-02-12', description: 'Pagamento Cartão', amount: -10000, transferId: 't' },
    { accountId: 'card', date: '2026-02-12', description: 'Pagamento Cartão', amount: 10000, transferId: 't' },
    { accountId: 'a', date: '2026-02-13', description: 'Orphan', amount: -100, transferId: 'lost' },
  ];
  const index = descriptionIndex(tx);
  assert.equal(index.length, 5); // the two "Continente" are one; a transfer counts once; a lone side is left out
  const pay = index.find((e) => e.key === 'pagamento cartao');
  assert.deepEqual([pay.kind, pay.accountId, pay.toAccountId, pay.amount, pay.count], ['transfer', 'a', 'card', -10000, 1]);
  const c = index.find((e) => e.key === 'continente');
  assert.deepEqual([c.count, c.description, c.amount, c.categoryIds], [2, 'continente', -4500, ['groc', 'casa']]);
  // Starts-with first; then word-start matches, the most recent first.
  assert.deepEqual(suggestDescriptions(index, 'conti').map((e) => e.description),
    ['continente', 'Refund Continente', 'Pingo Doce Continente', 'Café Continental']);
  // With an account given, matches used there come first within the same rank.
  assert.deepEqual(suggestDescriptions(index, 'conti', { accountId: 'b' }).map((e) => e.description),
    ['continente', 'Café Continental', 'Refund Continente', 'Pingo Doce Continente']);
  assert.equal(suggestDescriptions(index, 'cafe')[0].description, 'Café Continental'); // accents ignored
  assert.deepEqual(suggestDescriptions(index, ''), []);
  assert.equal(suggestDescriptions(index, 'refund')[0].kind, 'refund');
});

test('batch rows: transfers need a different account to go to', () => {
  const base = { description: 'Card payment', amount: '100', sign: 't', date: '2026-11-02', accountId: 'bank', categoryIds: [] };
  assert.equal(batchRow(base, []).error, 'needs an account to transfer to');
  assert.equal(batchRow({ ...base, toAccountId: 'bank' }, []).error, 'transfers to the same account');
  assert.deepEqual(batchRow({ ...base, toAccountId: 'card' }, []).transfer,
    { fromId: 'bank', toId: 'card', date: '2026-11-02', description: 'Card payment', sent: 10000 });
});

test('filters: text and amounts, categories with children, types, ranges, accounts', () => {
  const categories = [{ id: 'casa', name: 'Casa', parentId: null }, { id: 'luz', name: 'Luz', parentId: 'casa' }, { id: 'fun', name: 'Fun', parentId: null }];
  const tx = [
    { id: '1', accountId: 'a', date: '2026-10-01', description: 'Endesa', amount: -6216, categoryIds: ['luz'] },
    { id: '2', accountId: 'a', date: '2026-10-02', description: 'Cinema', memo: 'with Ana', amount: -1299, categoryIds: ['fun'] },
    { id: '3', accountId: 'b', date: '2026-10-03', description: 'Refund Endesa', amount: 1000, kind: 'refund', categoryIds: ['luz'] },
    { id: '4', accountId: 'a', date: '2026-10-04', description: 'Salary', amount: 300000, categoryIds: [] },
    { id: '5', accountId: 'a', date: '2026-10-05', description: 'Card payment', amount: -5000, transferId: 't' },
    { id: '6', accountId: 'a', date: '2026-09-30', description: 'Old', amount: -100, categoryIds: [] },
  ];
  const ids = (f) => filterTransactions(tx, f, { categories }).map((t) => t.id);
  assert.deepEqual(ids({ text: 'endesa' }), ['3', '1']);
  assert.deepEqual(ids({ text: 'ana' }), ['2']); // memo
  assert.deepEqual(ids({ text: '12,99' }), ['2']); // amount
  assert.deepEqual(ids({ categoryId: 'casa' }), ['3', '1']); // the parent includes its children
  assert.deepEqual(ids({ categoryId: '' }), ['4', '6']); // uncategorized, transfers excluded
  assert.deepEqual(ids({ type: 'expense' }), ['2', '1', '6']);
  assert.deepEqual(ids({ type: 'income' }), ['4']);
  assert.deepEqual(ids({ type: 'refund' }), ['3']);
  assert.deepEqual(ids({ type: 'transfer' }), ['5']);
  assert.deepEqual(ids({ min: '50', max: '100' }), ['5', '1']);
  assert.deepEqual(ids({ from: '2026-10-02', to: '2026-10-03' }), ['3', '2']);
  assert.deepEqual(ids({ accountIds: new Set(['b']) }), ['3']);
});

test('rule suggestions: offered unless the rules already pick it; counts others to fill', () => {
  const rules = [{ pattern: 'continente', match: 'contains', categoryId: 'groc' }];
  const tx = [
    { id: '1', description: 'Continente', categoryIds: ['groc'] },
    { id: '2', description: 'Lunch spot', categoryIds: ['meals'] },
    { id: '3', description: 'lunch SPOT', categoryIds: [] },
    { id: '4', description: 'Lunch spot', categoryIds: ['other'] },
  ];
  assert.equal(ruleSuggestion(tx[0], 'groc', rules, tx), null);
  assert.deepEqual(ruleSuggestion(tx[1], 'meals', rules, tx), { pattern: 'Lunch spot', match: 'equals', categoryId: 'meals', others: 1 });
  assert.ok(ruleSuggestion(tx[0], 'other', rules, tx)); // a different category than the rule's
});

test('insights for one category, and history priced from weekly closes', () => {
  const categories = [{ id: 'casa', name: 'Casa', parentId: null }, { id: 'luz', name: 'Luz', parentId: 'casa' }, { id: 'fun', name: 'Fun', parentId: null }];
  const tx = [
    { id: '1', accountId: 'a', date: '2026-10-01', amount: -6000, categoryIds: ['luz'], rate: 1 },
    { id: '2', accountId: 'a', date: '2026-10-02', amount: -1000, categoryIds: ['fun', 'luz'], rate: 1 },
    { id: '3', accountId: 'a', date: '2026-10-03', amount: -2000, categoryIds: ['casa'], rate: 1 },
  ];
  const r = insights(tx, { from: '2026-10-01', to: '2026-10-31', accounts: [{ id: 'a', currency: 'EUR' }], categories, onlyCategory: 'casa' });
  assert.equal(r.expenses, 8000); // its first category decides: the fun-first one isn't counted

  const accounts = [{ id: 'etf', type: 'investment', currency: 'EUR' }];
  const holdings = [{ id: 'h', accountId: 'etf', currency: 'EUR', priceHistory: { '2024-06-28': 110, '2024-12-27': 90 } }];
  const lots = [{ holdingId: 'h', date: '2024-01-11', kind: 'buy', quantity: 100, price: 100 }];
  const { points } = netWorthHistory({ accounts, transactions: [], holdings, lots }, {
    from: '2024-01-01', to: '2024-12-31', today: '2026-11-02', holdingsValue: () => 0,
  });
  const at = (k) => points.find((p) => p.key === k).investments;
  assert.equal(at('2024-03'), 100 * 100 * 100); // before the history starts: the trade price
  assert.equal(at('2024-08'), 100 * 110 * 100); // the latest weekly close by then
  assert.equal(at('2024-12'), 100 * 90 * 100);
});

test('zip: what makeZip writes, readZip reads back; also compressed entries from other tools', async () => {
  const files = [
    { name: 'README.txt', data: 'Backup of Finance' },
    { name: 'transactions.csv', data: 'Date,Description\n2026-11-02,Café ☕\n' },
    { name: 'empty.csv', data: '' },
  ];
  const back = await readZip(makeZip(files, new Date(2026, 10, 2, 15, 30)));
  const dec = new TextDecoder();
  assert.deepEqual([...back.keys()], ['README.txt', 'transactions.csv', 'empty.csv']);
  assert.equal(dec.decode(back.get('transactions.csv')), 'Date,Description\n2026-11-02,Café ☕\n');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926); // the standard check value
  await assert.rejects(readZip(new TextEncoder().encode('not a zip at all, just text')), /Not a ZIP/);

  // A compressed ("deflate") entry, as other zip tools write: rebuild the stored zip with the data
  // deflated and the method, sizes and offsets patched.
  const { deflateRawSync } = await import('node:zlib');
  const text = 'hello '.repeat(200);
  const plain = new TextEncoder().encode(text);
  const packed = new Uint8Array(deflateRawSync(plain));
  const stored = makeZip([{ name: 'a.txt', data: plain }]);
  const nameLen = 5;
  const local = stored.slice(0, 30 + nameLen);
  const central = stored.slice(30 + nameLen + plain.length, 30 + nameLen + plain.length + 46 + nameLen);
  const end = stored.slice(stored.length - 22);
  const lv = new DataView(local.buffer); lv.setUint16(8, 8, true); lv.setUint32(18, packed.length, true);
  const cv = new DataView(central.buffer); cv.setUint16(10, 8, true); cv.setUint32(20, packed.length, true);
  const ev = new DataView(end.buffer); ev.setUint32(16, local.length + packed.length, true);
  const zipped = new Uint8Array([...local, ...packed, ...central, ...end]);
  assert.equal(dec.decode((await readZip(zipped)).get('a.txt')), text);
});

test('batch rows: refunds are positive and marked', () => {
  const { tx } = batchRow({ description: 'Refund', amount: '5', sign: 'r', date: '2026-11-02', accountId: 'a', categoryIds: [] }, []);
  assert.deepEqual([tx.amount, tx.kind], [500, 'refund']);
});

test('IOUs: Buxfer column, signs, balances and history', () => {
  assert.deepEqual(parseBuxferIou('Íris/Sérgio: 9.000,00'), [{ name: 'Íris/Sérgio', amount: 900000 }]);
  assert.deepEqual(parseBuxferIou('Pedro Ivo: 2,50; Gonçalo Ribeiro: 2,50'), [{ name: 'Pedro Ivo', amount: 250 }, { name: 'Gonçalo Ribeiro', amount: 250 }]);
  assert.deepEqual(parseBuxferIou(' '), []);
  assert.equal(iouSign(-900000), 1); // a loan: money out, they owe you
  assert.equal(iouSign(1000000), -1); // a settlement: money in, they owe you less
  const ious = [
    { personId: 'p', date: '2024-04-03', amount: 900000 },
    { personId: 'p', date: '2022-06-28', amount: -1000000 },
    { personId: 'p', date: '2020-01-15', amount: 1000000 },
    { personId: 'q', date: '2020-01-01', amount: -500 },
  ];
  assert.deepEqual([...personBalances(ious)], [['p', 900000], ['q', -500]]);
  assert.deepEqual(personHistory('p', ious).map((e) => [e.date, e.balance]), [['2024-04-03', 900000], ['2022-06-28', 0], ['2020-01-15', 1000000]]);
});

test('import: IOU column becomes people and entries linked to their transactions', () => {
  const csv = [
    'ID,Date,Description,Currency,Amount,Type,Tags,Account,Status,Memo,IOU',
    '1,2024-04-03,Empréstimo,EUR,-9000,Loan,,Bank,Cleared,,"Íris/Sérgio: 9.000,00"',
    '2,2022-06-28,Devolução,EUR,10000,Settlement,,Bank,Cleared,,"íris/sérgio: 10.000,00"',
    '3,2023-01-01,Jantar,EUR,-7.54,Shared bill,,Bank,Cleared,,"Pedro Ivo: 2,50; Gonçalo Ribeiro: 2,50"',
    '4,2023-01-02,Café,EUR,-2,Expense,,Bank,Cleared,',
  ].join('\n');
  const [header, ...body] = parseCsv(csv);
  const mapping = guessMapping(header);
  assert.equal(mapping.iou, 10);
  let n = 0;
  const res = importRows(body, { mapping, dateFormat: 'ymd', decimal: '.', defaultAccountId: null },
    { id: () => `n${++n}`, accounts: [{ id: 'bank', name: 'Bank' }], categories: [], rules: [], transactions: [], people: [] });
  assert.deepEqual(res.newPeople.map((p) => p.name), ['Íris/Sérgio', 'Pedro Ivo', 'Gonçalo Ribeiro']); // matched case-insensitively
  const balances = personBalances(res.ious);
  assert.equal(balances.get(res.newPeople[0].id), -100000);
  assert.equal(balances.get(res.newPeople[1].id), 250);
  assert.ok(res.ious.every((e) => res.transactions.some((t) => t.id === e.transactionId)));
  assert.deepEqual(res.ious.map((e) => e.kind), ['loan', 'settlement', 'shared_bill', 'shared_bill']);
  assert.equal(iouType('Paid for friend', -1325), 'paid_for_friend');
  assert.equal(iouType('', 500), 'settlement');
});

test('categories: paths, resolving and creating parents, order, legacy single category', () => {
  let n = 0;
  const id = () => `c${++n}`;
  const existing = [{ id: 'compras', name: 'Compras', parentId: null }];
  const r = categoryResolver(existing, id);
  const merc = r.resolve('compras / Mercearia'); // parent found case-insensitively
  assert.deepEqual([merc.name, merc.parentId], ['Mercearia', 'compras']);
  assert.equal(r.resolve('Compras / MERCEARIA'), merc); // no duplicate
  const voos = r.resolve('Viagens / Voos'); // creates the parent too
  const viagens = r.created.find((c) => c.name === 'Viagens');
  assert.equal(voos.parentId, viagens.id);
  assert.deepEqual(r.created.map((c) => c.name), ['Mercearia', 'Viagens', 'Voos']);
  const all = [...existing, ...r.created];
  assert.equal(categoryPath(voos, all), 'Viagens / Voos');
  assert.deepEqual(sortedCategories(all).map((c) => categoryPath(c, all)), ['Compras', 'Compras / Mercearia', 'Viagens', 'Viagens / Voos']);
  assert.deepEqual(categoriesOf({ categoryId: 'x' }), ['x']);
  assert.deepEqual(categoriesOf({ categoryIds: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(categoriesOf({}), []);
});

test('import: several tags per row, each a path; Buxfer tags.csv builds the tree', () => {
  let n = 0;
  const files = {
    tags: parseCsv('"TAG NAME","PARENT TAG NAME"\nBanco,\n"Banco / Comissões e Despesas",Banco\nCasa,\nSeguros,'),
    transactions: parseCsv([
      'ID,Date,Description,Currency,Amount,Type,Tags,Account,Status,Memo',
      '1,2026-10-01,Insurance,EUR,-50,Expense,"Casa,Seguros",Bank,Cleared,',
      '2,2026-10-02,Fee,EUR,-1,Expense,"Banco / Comissões e Despesas",Bank,Cleared,',
      '3,2026-10-03,Flight,EUR,-200,Expense,"Viagens / Voos,Viagens / Islandia\'27",Bank,Cleared,',
    ].join('\n')),
  };
  const res = buxferImport(files, { id: () => `n${++n}`, today: '2026-11-02', accounts: [], categories: [], rules: [], transactions: [], holdings: [], schedules: [] });
  const cats = res.newCategories;
  const path = (cid) => categoryPath(cats.find((c) => c.id === cid), cats);
  assert.deepEqual(res.transactions.map((t) => t.categoryIds.map(path)), [
    ['Casa', 'Seguros'], ['Banco / Comissões e Despesas'], ['Viagens / Voos', "Viagens / Islandia'27"],
  ]);
  assert.equal(cats.filter((c) => c.name === 'Viagens').length, 1);
  assert.equal(cats.find((c) => c.name === 'Comissões e Despesas').parentId, cats.find((c) => c.name === 'Banco').id);
});

test('schedules: frequencies, month-end anchoring, occurrences, forecast', () => {
  assert.deepEqual(parseFrequency('1 month'), { every: 1, unit: 'month' });
  assert.deepEqual(parseFrequency('30 days'), { every: 30, unit: 'day' });
  assert.equal(parseFrequency('fortnightly'), null);

  const monthly = { every: 1, unit: 'month' };
  assert.equal(addInterval('2026-01-31', monthly, 31), '2026-02-28');
  assert.equal(addInterval('2026-02-28', monthly, 31), '2026-03-31'); // back to the 31st
  assert.equal(addInterval('2028-02-29', { every: 1, unit: 'year' }, 29), '2029-02-28');
  assert.equal(addInterval('2026-11-29', { every: 30, unit: 'day' }), '2026-12-29');
  assert.equal(addInterval('2026-11-02', { every: 2, unit: 'week' }), '2026-11-16');

  const netflix = { kind: 'expense', amount: 1299, accountId: 'card', every: 1, unit: 'month', anchorDay: 5, nextDate: '2026-11-05' };
  assert.deepEqual(occurrences(netflix, '2027-01-31'), ['2026-11-05', '2026-12-05', '2027-01-05']);
  assert.deepEqual(occurrences({ ...netflix, endDate: '2026-12-01' }, '2027-01-31'), ['2026-11-05']);

  const ppr = { kind: 'transfer', amount: 5000, accountId: 'bank', toAccountId: 'ppr', every: 1, unit: 'month', anchorDay: 6, nextDate: '2026-11-06' };
  const salary = { kind: 'income', amount: 488735, accountId: 'bank', every: 1, unit: 'month', anchorDay: 27, nextDate: '2026-11-27' };
  assert.equal(forecast('bank', 100000, [netflix, ppr, salary], '2026-12-02'), 100000 - 5000 + 488735);
  assert.equal(forecast('ppr', 0, [netflix, ppr, salary], '2026-12-02'), 5000);

  const [out, inn] = scheduledTransactions(ppr, '2026-11-06', [{ id: 'bank', name: 'Bank' }, { id: 'ppr', name: 'PPR' }], (() => { let n = 0; return () => `x${++n}`; })());
  assert.deepEqual([out.amount, inn.amount, out.transferId === inn.transferId], [-5000, 5000, true]);
  assert.equal(advanceSchedule(salary).nextDate, '2026-12-27');
});

test('Buxfer reminders: signs from type, transfers "A > B", missing account skipped, no duplicates', () => {
  const files = {
    accounts: parseCsv('NAME,BALANCE,TYPE,CURRENCY,BANK\nBank,0,Checking,EUR,X\nPPR,0,Investment,EUR,X'),
    reminders: parseCsv([
      'DESCRIPTION,"DUE DATE",FREQUENCY,"STOP DATE",TYPE,AMOUNT,ACCOUNT,TAGS',
      'Netflix,2026-11-05,"1 month",2026-10-04,expense,12.99,Bank,"Serviços / Subscrições Online"',
      'Salary,2026-11-27,"1 month",2026-01-27,income,-4887.35,Bank,Vencimento',
      'Reforço PPR,2026-11-06,"1 month",,transfer,50,"Bank > PPR",Poupança',
      'Amazon Prime,2027-07-05,"1 year",2025-07-04,expense,49.9,,',
    ].join('\n')),
  };
  assert.equal(detectBuxferFile(files.reminders[0]), 'reminders');
  let n = 0;
  const ctx = { id: () => `n${++n}`, today: '2026-11-02', accounts: [], categories: [], rules: [], transactions: [], holdings: [], schedules: [] };
  const res = buxferImport(files, ctx);
  const s = Object.fromEntries(res.schedules.map((x) => [x.description, x]));
  assert.deepEqual([s.Netflix.kind, s.Netflix.amount, s.Netflix.nextDate, s.Netflix.endDate], ['expense', 1299, '2026-11-05', null]);
  assert.deepEqual([s.Salary.kind, s.Salary.amount], ['income', 488735]);
  const bank = res.newAccounts.find((a) => a.name === 'Bank');
  const ppr = res.newAccounts.find((a) => a.name === 'PPR');
  assert.deepEqual([s['Reforço PPR'].accountId, s['Reforço PPR'].toAccountId, s['Reforço PPR'].categoryIds], [bank.id, ppr.id, []]);
  assert.deepEqual(res.skippedReminders.map((x) => [x.description, x.reason]), [['Amazon Prime', 'no account in Buxfer']]);
  assert.ok(res.newCategories.some((c) => c.name === 'Vencimento'));

  const again = buxferImport(files, { ...ctx, accounts: res.newAccounts, categories: res.newCategories, schedules: res.schedules });
  assert.equal(again.schedules.length, 0);
});

test('Buxfer export: accounts with types, archived extras, holdings from lots, opening balances', () => {
  const files = {
    accounts: parseCsv([
      'NAME,BALANCE,TYPE,CURRENCY,BANK',
      'Bank,150.00,Checking,EUR,X',
      'Card,-20.00,Credit card,EUR,X',
      'ETF,300.00,Investment,EUR,X',
      'Broker,50.00,Investment - 401K,USD,X',
    ].join('\n')),
    transactions: parseCsv([
      'ID,Date,Description,Currency,Amount,Type,Tags,Account,Status,Memo,IOU',
      '1,2026-01-10,Salary,EUR,100,Income,Vencimento,Bank,Cleared," "',
      '2,2026-01-11,Lunch,EUR,-20,Expense,Refeições,Card,Reconciled,',
      '3,2026-01-12,VWCE,EUR,-250,Transfer,Investimento,Bank,Cleared,',
      '3,2026-01-12,VWCE,EUR,250,Transfer,Investimento,ETF,Cleared,',
      '4,2026-01-13,Old,EUR,-5,Expense,,Closed account,Cleared,',
    ].join('\n')),
    investments: parseCsv([
      'ACCOUNT,SYMBOL,VALUE,QUANTITY,PRICE,DESCRIPTION',
      'ETF,VWCE,200.00,2,100,Vanguard All-World',
      'ETF,VWCE,100.00,1,100,Vanguard All-World',
    ].join('\n')),
  };
  assert.deepEqual(Object.values(files).map((f) => detectBuxferFile(f[0])), ['accounts', 'transactions', 'investments']);
  let n = 0;
  const ctx = { id: () => `n${++n}`, today: '2026-11-02', accounts: [], categories: [], rules: [], transactions: [], holdings: [] };
  const res = buxferImport(files, ctx);

  const acc = Object.fromEntries(res.newAccounts.map((a) => [a.name, a]));
  assert.deepEqual([acc.Bank.type, acc.Card.type, acc.ETF.type, acc.Broker.type, acc.Broker.currency], ['checking', 'credit', 'investment', 'investment', 'USD']);
  assert.equal(acc['Closed account'].archived, true);
  assert.equal(acc.Bank.archived, false);
  assert.equal(res.linkedTransfers, 1);

  assert.equal(res.newHoldings.length, 1); // two lots, one holding
  assert.deepEqual([res.newHoldings[0].quantity, res.newHoldings[0].price, res.newHoldings[0].manual], [3, 100, true]);

  const rec = Object.fromEntries(res.reconciliation.map((r) => [r.name, r]));
  // Bank: 100 - 250 = -150 from transactions, Buxfer says 150 → opening balance of +300
  assert.equal(rec.Bank.opening, 30000);
  assert.ok(rec.Bank.matches && rec.Card.matches && rec.ETF.matches);
  assert.equal(rec.ETF.valued, true);
  assert.equal(rec.ETF.opening, 0); // valued by holdings, never adjusted
  const opening = res.transactions.find((t) => t.description === 'Opening balance (from Buxfer)');
  assert.deepEqual([opening.date, opening.amount], ['2026-01-09', 30000]);
  // Broker has no transactions and no holdings: an opening balance gives it its Buxfer balance
  assert.equal(rec.Broker.opening, 5000);

  // Running it again on top of the result adds nothing.
  const after = {
    ...ctx, accounts: res.newAccounts, categories: res.newCategories,
    transactions: res.transactions, holdings: res.newHoldings,
  };
  const again = buxferImport(files, after);
  assert.deepEqual([again.newAccounts.length, again.imported, again.openings, again.newHoldings.length], [0, 0, 0, 0]);
  assert.equal(again.duplicates, 5);
});

test('import: Buxfer transfers (two rows sharing an id) become one linked transfer', () => {
  const csv = [
    'Id,Date,Description,Currency,Amount,Type,Tags,Account,Status,Memo',
    '246892753,2026-10-30,VWCE,EUR,-3385.04,Transfer,Investimento,ActivoBank,Cleared," "',
    '246892753,2026-10-30,VWCE,EUR,3385.04,Transfer,Investimento,"ActivoBank (ETF)",Cleared," "',
    '246892754,2026-10-29,Lunch,EUR,-12.50,Expense,Meals,ActivoBank,Cleared,',
    '246892755,2026-10-28,Orphan,EUR,-5,Transfer,,ActivoBank,Cleared,',
  ].join('\n');
  const [header, ...body] = parseCsv(csv);
  const mapping = guessMapping(header);
  assert.equal(mapping.reference, 0);
  assert.equal(mapping.category, 6);
  let n = 0;
  const ctx = {
    id: () => `n${++n}`, accounts: [{ id: 'bank', name: 'ActivoBank' }, { id: 'etf', name: 'ActivoBank (ETF)' }],
    categories: [{ id: 'meals', name: 'Meals' }], rules: [], transactions: [],
  };
  const res = importRows(body, { mapping, dateFormat: 'ymd', decimal: '.', defaultAccountId: null }, ctx);
  const [out, inn, lunch, orphan] = res.transactions;
  assert.equal(res.linkedTransfers, 1);
  assert.equal(res.unpairedTransfers, 1);
  assert.ok(out.transferId && out.transferId === inn.transferId);
  assert.deepEqual([out.accountId, out.amount, inn.accountId, inn.amount], ['bank', -338504, 'etf', 338504]);
  assert.deepEqual(out.categoryIds, []);
  assert.deepEqual(res.newCategories, []); // "Investimento" isn't created just for transfers
  assert.equal(lunch.transferId, undefined);
  assert.deepEqual(lunch.categoryIds, ['meals']);
  assert.equal(orphan.transferId, undefined);
});

test('import: a shared reference links a cross-currency transfer with different amounts', () => {
  let n = 0;
  const ctx = { id: () => `n${++n}`, accounts: [{ id: 'eur', name: 'Bank' }, { id: 'usd', name: 'Broker' }], categories: [], rules: [], transactions: [] };
  const mapping = { reference: 0, date: 1, description: 2, amount: 3, type: 4, account: 5, category: -1, memo: -1, currency: -1 };
  const rows = [['9', '2026-10-01', 'Fund', '-1000', 'Transfer', 'Bank'], ['9', '2026-10-01', 'Fund', '1117.40', 'Transfer', 'Broker']];
  const res = importRows(rows, { mapping, dateFormat: 'ymd', decimal: '.', defaultAccountId: null }, ctx);
  assert.equal(res.linkedTransfers, 1);
  assert.equal(res.transactions[0].transferId, res.transactions[1].transferId);
});

test('finding transfers in existing data: same date and description, opposite amounts, two accounts', () => {
  const tx = [
    { id: '1', accountId: 'bank', date: '2026-10-30', description: 'VWCE', amount: -338504 },
    { id: '2', accountId: 'etf', date: '2026-10-30', description: 'vwce', amount: 338504 },
    { id: '3', accountId: 'bank', date: '2026-10-30', description: 'Refund', amount: -500 },
    { id: '4', accountId: 'bank', date: '2026-10-30', description: 'Refund', amount: 500 }, // same account: not a transfer
    { id: '5', accountId: 'bank', date: '2026-10-29', description: 'X', amount: -100, transferId: 't' },
    { id: '6', accountId: 'etf', date: '2026-10-29', description: 'X', amount: 100, transferId: 't' },
  ];
  assert.deepEqual(findTransferPairs(tx).map(([a, b]) => [a.id, b.id]), [['1', '2']]);
});

test('CSV: quotes, doubled quotes, newlines in cells, CRLF, BOM, semicolons', () => {
  const text = '﻿Date;Description;Amount\r\n30/10/2026;"Lunch; ""team""";-12,50\r\n29/10/2026;"Two\nlines";5\r\n\r\n';
  assert.deepEqual(parseCsv(text), [
    ['Date', 'Description', 'Amount'],
    ['30/10/2026', 'Lunch; "team"', '-12,50'],
    ['29/10/2026', 'Two\nlines', '5'],
  ]);
});

test('CSV round-trips through toCsv', () => {
  const rows = [['a', 'b,c', 'say "hi"'], ['1', '', 'x\ny']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('amounts in both decimal styles, with signs and symbols', () => {
  assert.equal(parseAmount('1.234,56', ','), 123456);
  assert.equal(parseAmount('-12,50', ','), -1250);
  assert.equal(parseAmount('1,234.56', '.'), 123456);
  assert.equal(parseAmount('(3.00)', '.'), -300);
  assert.equal(parseAmount('€ 7', '.'), 700);
  assert.equal(parseAmount('12.50-', '.'), -1250);
  assert.ok(Number.isNaN(parseAmount('abc', '.')));
});

test('dates in three orders, rejecting impossible ones', () => {
  assert.equal(parseDate('31/12/2026', 'dmy'), '2026-12-31');
  assert.equal(parseDate('12/31/2026', 'mdy'), '2026-12-31');
  assert.equal(parseDate('2026-12-31', 'ymd'), '2026-12-31');
  assert.equal(parseDate('1.2.26', 'dmy'), '2026-02-01');
  assert.equal(parseDate('31/02/2026', 'dmy'), null);
  assert.equal(guessDateFormat(['2026-01-02']), 'ymd');
  assert.equal(guessDateFormat(['12/31/2026']), 'mdy');
  assert.equal(guessDateFormat(['01/02/2026']), 'dmy');
  assert.equal(guessDecimal(['-12,50', '3']), ',');
  assert.equal(guessDecimal(['1,234.50']), '.');
});

test('header mapping is guessed from common names', () => {
  const m = guessMapping(['Data', 'Descrição', 'Valor', 'Conta', 'Tags']);
  assert.deepEqual([m.date, m.description, m.amount, m.account, m.category, m.memo], [0, 1, 2, 3, 4, -1]);
});

test('import: creates missing accounts and categories, applies type, skips duplicates', () => {
  let n = 0;
  const ctx = {
    id: () => `n${++n}`,
    accounts: [{ id: 'a1', name: 'ActivoBank', currency: 'EUR' }],
    categories: [{ id: 'meals', name: 'Meals' }],
    rules: [{ pattern: 'uber', match: 'contains', categoryId: 'transport' }],
    transactions: [{ accountId: 'a1', date: '2026-10-30', amount: -1250, description: 'Lunch' }],
  };
  const rows = [
    ['30/10/2026', 'Lunch', '12,50', 'Expense', 'activobank', 'meals'], // duplicate of the existing one
    ['30/10/2026', 'Lunch', '12,50', 'Expense', 'ActivoBank', 'Meals'], // a second lunch: kept
    ['29/10/2026', 'Uber', '-8,00', '', 'Revolut', ''], // new account, category from rules
    ['28/10/2026', 'Salary', '2.000,00', 'Income', 'ActivoBank', 'Vencimento'], // new category
    ['99/99/2026', 'Bad', '1', '', 'ActivoBank', ''],
  ];
  const mapping = { date: 0, description: 1, amount: 2, type: 3, account: 4, category: 5, memo: -1, currency: -1 };
  const res = importRows(rows, { mapping, dateFormat: 'dmy', decimal: ',', defaultAccountId: null }, ctx);
  assert.equal(res.duplicates, 1);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].line, 6);
  assert.deepEqual(res.transactions.map((t) => [t.description, t.amount, t.categoryIds]), [
    ['Lunch', -1250, ['meals']], ['Uber', -800, ['transport']], ['Salary', 200000, [res.newCategories[0].id]],
  ]);
  assert.deepEqual(res.newAccounts.map((a) => a.name), ['Revolut']);
  assert.equal(res.transactions[1].accountId, res.newAccounts[0].id);
  assert.deepEqual(res.newCategories.map((c) => c.name), ['Vencimento']);
});

test('batch rows: skip empty, reject half-filled, sign and rules applied', () => {
  const rules = [{ pattern: 'lunch', match: 'contains', categoryId: 'meals' }];
  const base = { date: '2026-11-02', accountId: 'a', categoryIds: [], sign: '-' };
  assert.deepEqual(batchRow({ ...base, description: ' ', amount: '' }, rules), { skip: true });
  assert.equal(batchRow({ ...base, description: 'Lunch', amount: '' }, rules).error, 'needs an amount above zero');
  assert.equal(batchRow({ ...base, description: '', amount: '5' }, rules).error, 'needs a description');
  const { tx } = batchRow({ ...base, description: 'Lunch', amount: '12.50' }, rules);
  assert.equal(tx.amount, -1250);
  assert.deepEqual(tx.categoryIds, ['meals']);
  assert.equal(batchRow({ ...base, description: 'Refund', amount: '3', sign: '+' }, rules).tx.amount, 300);
  assert.deepEqual(batchRow({ ...base, description: 'Lunch', amount: '1', categoryIds: ['fun'] }, rules).tx.categoryIds, ['fun']);
  assert.deepEqual(batchRow({ ...base, description: 'Lunch', amount: '1', categoryIds: ['fun', 'meals'] }, rules).tx.categoryIds, ['fun', 'meals']);
  assert.deepEqual(batchRow({ ...base, description: 'Taxi', amount: '1' }, rules).tx.categoryIds, []);
});

test('transfers: two linked legs, out and in, in each account currency', () => {
  let n = 0;
  const id = () => `id${++n}`;
  const [out, inn] = makeTransfer({
    from: { id: 'eur', name: 'Bank' }, to: { id: 'usd', name: 'Broker' },
    sent: 10000, received: crossConvert(10000, 1, 0.9), date: '2026-11-02',
  }, id);
  assert.equal(out.transferId, inn.transferId);
  assert.deepEqual([out.accountId, out.amount], ['eur', -10000]);
  assert.deepEqual([inn.accountId, inn.amount], ['usd', 11111]);
  assert.equal(out.description, 'Transfer: Bank → Broker');
  assert.deepEqual(out.categoryIds, []);
});

test('running balance: newest first, same-day entries keep entry order', () => {
  const tx = [
    { id: 'b', accountId: 'a', date: '2026-10-02', amount: -300 },
    { id: 'a', accountId: 'a', date: '2026-10-01', amount: 1000 },
    { id: 'c', accountId: 'a', date: '2026-10-02', amount: -200 },
    { id: 'x', accountId: 'other', date: '2026-10-01', amount: 5 },
  ];
  const rows = withRunningBalance('a', tx);
  assert.deepEqual(rows.map((r) => [r.id, r.balance]), [['c', 500], ['b', 700], ['a', 1000]]);
});

test('money round-trips through minor units without float drift', () => {
  assert.equal(toMinor('0.1') + toMinor('0.2'), toMinor('0.3'));
  assert.equal(toMinor(19.99), 1999);
});

test('formats EUR and USD', () => {
  assert.match(formatMoney(123456, 'EUR', 'en-IE'), /€1,234\.56/);
  assert.match(formatMoney(123456, 'USD', 'en-US'), /\$1,234\.56/);
});

test('categorize: case, accents and match modes', () => {
  const rules = [
    { pattern: 'lunch', match: 'contains', categoryId: 'meals' },
    { pattern: 'uber', match: 'starts', categoryId: 'transport' },
    { pattern: 'rent', match: 'equals', categoryId: 'rent' },
  ];
  assert.equal(categorize('Team LUNCH at Café', rules), 'meals');
  assert.equal(categorize('Uber trip', rules), 'transport');
  assert.equal(categorize('my uber', rules), null);
  assert.equal(categorize('Rent', rules), 'rent');
  assert.equal(categorize('Parent', rules), null);
  assert.equal(categorize('', rules), null);
});

test('categorize: first matching rule wins', () => {
  const rules = [
    { pattern: 'coffee', match: 'contains', categoryId: 'a' },
    { pattern: 'coffee', match: 'contains', categoryId: 'b' },
  ];
  assert.equal(categorize('coffee', rules), 'a');
});

test('convert and rate lookup', () => {
  assert.equal(convert(10000, 0.895), 8950);
  assert.equal(rateFor('EUR', {}, '2026-10-30'), 1);
  assert.equal(rateFor('USD', { 'USD:2026-10-30': 0.9 }, '2026-10-30'), 0.9);
  assert.equal(rateFor('USD', {}, '2026-10-30'), null);
});

test('credit card balance is negative when money is owed', () => {
  const card = { id: 'c', type: 'credit', currency: 'EUR' };
  const tx = [{ accountId: 'c', amount: -5000 }, { accountId: 'c', amount: 1500 }, { accountId: 'x', amount: 99 }];
  assert.equal(accountBalance(card, tx), -3500);
});

test('transactions dated after today wait: out of the balance and net worth, listed as planned', () => {
  const acc = { id: 'a', type: 'checking', currency: 'EUR' };
  const tx = [
    { id: '1', accountId: 'a', date: '2026-11-02', amount: 10000 },
    { id: '3', accountId: 'a', date: '2026-12-01', amount: -2500 },
    { id: '2', accountId: 'a', date: '2026-11-03', amount: -1000 },
    { id: '4', accountId: 'b', date: '2026-11-20', amount: -700 },
  ];
  assert.equal(accountBalance(acc, tx, '2026-11-02'), 10000);
  assert.equal(accountBalance(acc, tx), 6500); // no date: everything, as before
  assert.deepEqual(plannedTransactions('a', tx, '2026-11-02').map((t) => t.id), ['2', '3']);
  const nw = netWorth({ accounts: [acc], transactions: tx, holdings: [] }, () => 1, '2026-11-02');
  assert.equal(nw.total, 10000);
});

test('investment value: holdings in another currency convert through EUR', () => {
  const acc = { id: 'i', type: 'investment', currency: 'EUR' };
  const holdings = [
    { accountId: 'i', quantity: 10, price: 100, currency: 'USD' },
    { accountId: 'i', quantity: 2, price: 50, currency: 'EUR' },
    { accountId: 'i', quantity: 1, price: null, currency: 'EUR' },
  ];
  const latest = (c) => (c === 'USD' ? 0.9 : 1);
  assert.equal(holdingValue(holdings[0]), 100000);
  const { total, invested, missing } = investmentValue(acc, holdings, [{ accountId: 'i', amount: 1000 }], latest);
  assert.equal(total, 90000 + 10000); // holdings only: money paid in is not counted twice
  assert.equal(invested, 1000);
  assert.equal(missing, 1);
});

test('investment value without holdings is the sum of its transactions', () => {
  const acc = { id: 'i', type: 'investment', currency: 'EUR' };
  const r = investmentValue(acc, [], [{ accountId: 'i', amount: 5000 }], () => 1);
  assert.deepEqual([r.total, r.invested, r.hasHoldings], [5000, 5000, false]);
});

test('net worth sums accounts in EUR and flags missing rates', () => {
  const s = defaultState();
  s.accounts = [
    { id: 'a', type: 'checking', currency: 'EUR' },
    { id: 'b', type: 'checking', currency: 'USD' },
    { id: 'c', type: 'credit', currency: 'USD' },
  ];
  s.transactions = [
    { accountId: 'a', amount: 100000 },
    { accountId: 'b', amount: 20000 },
    { accountId: 'c', amount: -5000 },
  ];
  assert.deepEqual(netWorth(s, (c) => (c === 'USD' ? 0.9 : 1)), { total: 100000 + 18000 - 4500, unconverted: 0 });
  assert.deepEqual(netWorth(s, (c) => (c === 'USD' ? null : 1)), { total: 100000, unconverted: 2 });
});

test('net worth leaves out archived accounts', () => {
  const s = defaultState();
  s.accounts = [{ id: 'a', type: 'checking', currency: 'EUR' }, { id: 'b', type: 'checking', currency: 'EUR', archived: true }];
  s.transactions = [{ accountId: 'a', amount: 100 }, { accountId: 'b', amount: 900 }];
  assert.equal(netWorth(s, () => 1).total, 100);
});

test('monthly averages use whole months finished by today', () => {
  assert.deepEqual(completeMonths('2026-01-01', '2026-12-31', '2026-11-02'), { from: '2026-01-01', to: '2026-10-31', months: 10 });
  assert.deepEqual(completeMonths('2025-01-01', '2025-12-31', '2026-11-02'), { from: '2025-01-01', to: '2025-12-31', months: 12 });
  // starts mid-month (all time from a first transaction): that month is left out
  assert.deepEqual(completeMonths('2014-08-21', '2026-11-02', '2026-11-02'), { from: '2014-09-01', to: '2026-10-31', months: 146 });
  assert.equal(completeMonths('2026-11-01', '2026-11-30', '2026-11-02'), null);
  assert.deepEqual(completeMonths('2026-10-01', '2026-10-31', '2026-11-02'), { from: '2026-10-01', to: '2026-10-31', months: 1 });
});

test('refunds tagged with an income category lower spending in their spending category, or on their own line', () => {
  const accounts = [{ id: 'a', currency: 'EUR' }];
  const categories = [{ id: 'sal', name: 'Salary', parentId: null }, { id: 'trip', name: 'Travel', parentId: null }];
  const tx = [
    { id: '1', accountId: 'a', date: '2025-01-28', amount: 300000, categoryIds: ['sal'], rate: 1 },
    { id: '2', accountId: 'a', date: '2025-03-01', amount: -90000, categoryIds: ['trip'], rate: 1 },
    { id: '3', accountId: 'a', date: '2025-03-20', amount: 40000, categoryIds: ['sal', 'trip'], rate: 1, kind: 'refund' },
    { id: '4', accountId: 'a', date: '2025-03-29', amount: 3000, categoryIds: ['sal'], rate: 1, kind: 'refund' },
  ];
  assert.deepEqual([...incomeCategories(tx, categories)], ['sal']);
  const r = insights(tx, { from: '2025-01-01', to: '2025-12-31', accounts, categories });
  assert.equal(r.income, 300000); // refunds are never income
  assert.equal(r.expenses, 90000 - 40000 - 3000);
  assert.equal(r.spending.find((c) => c.id === 'trip').amount, 90000 - 40000);
  assert.equal(r.spending.find((c) => c.id === REFUNDS_UNMATCHED).amount, -3000);
  assert.equal(r.spending.find((c) => c.id === 'sal'), undefined); // no negative salary spending
});

test('account runs: EUR totals at each date and the last date, as the database gives them for net worth', () => {
  const accounts = [{ id: 'a', currency: 'EUR' }, { id: 'u', currency: 'USD' }];
  const tx = [
    { accountId: 'a', date: '2026-01-10', amount: 1000, rate: 1, kind: 'opening' },
    { accountId: 'a', date: '2026-02-03', amount: -250, rate: 1 },
    { accountId: 'u', date: '2026-01-31', amount: 1000 }, // no rate: today's
    { accountId: 'a', date: '2026-04-01', amount: 5 }, // after the last date: only "last"
  ];
  const { unit, ends } = historyPoints('2026-01-01', '2026-03-15');
  assert.equal(unit, 'week');
  const dates = ['2026-01-31', '2026-02-28', '2026-03-15'];
  const runs = accountRuns(accounts, tx, dates, (c) => (c === 'USD' ? 0.9 : 1));
  assert.deepEqual(runs.get('a'), { last: '2026-04-01', values: [1000, 750, 750] });
  assert.deepEqual(runs.get('u'), { last: '2026-01-31', values: [900, 900, 900] });
  assert.deepEqual(accountRuns(accounts, tx, dates, () => 1, { skipOpening: true }).get('a').values, [0, -250, -250]);
  assert.equal(ends.at(-1).date, '2026-03-15');
});

test('fund movements list (pension fund export) → lots of one holding, priced by hand', () => {
  const rows = [
    ['Data', 'Carteira', 'Classe', 'Fundo', 'Operação', 'Nº UPs', 'Valor UP', 'Valor', 'Saldo Ups', 'Valorização', ''],
    ['15.03.2026', 'Work', 'Fundos Pensões', 'Some Pension Fund', 'Subscrição - UPC', '2,5000', '8,0000', '20,0000', '12,5100', '100,08', ''],
    ['10.02.2026', 'Work', 'Fundos Pensões', 'Some Pension Fund', 'Subs-Retroc.Comissão - RDC', '0,0100', '7,9000', '0,0800', '10,0100', '79,08', ''],
    ['05.01.2026', 'Work', 'Fundos Pensões', 'Some Pension Fund', 'Subscrição - UPC', '1.000,0000', '0,0100', '10,0000', '10,0000', '78,00', ''],
    ['01.01.2026', 'Work', 'Fundos Pensões', 'Some Pension Fund', 'Comissão de gestão', '0,1000', '7,8000', '0,7800', '', '', ''],
  ];
  assert.equal(isFundMovements(rows[0]), true);
  assert.equal(isFundMovements(['Date', 'Name', 'Symbol']), false);
  const ft = fundMovementsToFt(rows);
  assert.deepEqual(ft[1], ['2026-03-15', 'Some Pension Fund', 'Some Pension Fund', 'Buy', '2.5', '8', 'EUR', '0']);
  assert.equal(ft[3][4], '1000'); // thousands separator
  let n = 0;
  const res = ftImport(ft, 'acc', { id: () => `i${++n}`, holdings: [], lots: [] });
  assert.equal(res.newHoldings.length, 1);
  const h = res.newHoldings[0];
  assert.deepEqual([h.symbol, h.exchange, h.mic, h.manual, h.price], ['Some Pension Fund', 'By hand', null, true, 8]);
  assert.equal(res.newLots.length, 3);
  assert.equal(res.skipped.length, 1); // the fee row isn't a buy or a sell
  // a holding added by hand under a short name is matched by its name
  const byHand = [{ id: 'h', accountId: 'acc', symbol: 'PENSION', name: 'Some Pension Fund', currency: 'EUR', quantity: 0, manual: true }];
  const again = ftImport(ft, 'acc', { id: () => `j${++n}`, holdings: byHand, lots: [] });
  assert.equal(again.newHoldings.length, 0);
  assert.ok(again.newLots.every((l) => l.holdingId === 'h'));
});

test('holding history: price, units, cost and gain at each known price, from the first buy', () => {
  const x = { id: 'h', quantity: 15, price: 12, priceAt: '2026-03-10T09:00:00Z', priceHistory: { '2025-12-26': 9, '2026-01-09': 10, '2026-02-06': 11 } };
  const lots = [
    { holdingId: 'h', date: '2026-01-05', kind: 'buy', quantity: 10, price: 10, fees: 0 },
    { holdingId: 'h', date: '2026-02-20', kind: 'buy', quantity: 10, price: 11, fees: 0 },
    { holdingId: 'h', date: '2026-03-01', kind: 'sell', quantity: 5, price: 11.5, fees: 0 },
  ];
  const hist = holdingHistory(x, lots, '2026-03-15');
  assert.deepEqual(hist.map((p) => p.date), ['2026-01-05', '2026-01-09', '2026-02-06', '2026-02-20', '2026-03-01', '2026-03-10']);
  assert.deepEqual(hist[1], { date: '2026-01-09', price: 10, units: 10, cost: 10000, value: 10000, gain: 0 });
  assert.deepEqual(hist[2], { date: '2026-02-06', price: 11, units: 10, cost: 10000, value: 11000, gain: 1000 });
  const last = hist.at(-1); // 15 units left, costing 15 × 10.50 after the sell at average cost
  assert.deepEqual([last.units, last.cost, last.value, last.gain], [15, 15750, 18000, 2250]);
  // without buys and sells: today's units, no cost or gain
  const plain = holdingHistory({ ...x, id: 'other' }, lots, '2026-03-15');
  assert.equal(plain[0].date, '2025-12-26');
  assert.equal(plain[0].gain, null);
});

test('splits: each part counts under its own category; IOUs go with the first part; refunds too', () => {
  const accounts = [{ id: 'eur', currency: 'EUR' }];
  const categories = [{ id: 'food', name: 'Food', parentId: null }, { id: 'home', name: 'Home', parentId: null }, { id: 'pay', name: 'Pay', parentId: null }];
  const tx = [
    { id: 'p', accountId: 'eur', date: '2026-10-01', amount: 200000, categoryIds: ['pay'], rate: 1 },
    {
      id: 'shop', accountId: 'eur', date: '2026-10-03', amount: -5000, rate: 1, categoryIds: ['food', 'home'],
      splits: [{ categoryId: 'food', amount: -3200 }, { categoryId: 'home', amount: -1800 }],
    },
    { id: 'back', accountId: 'eur', date: '2026-10-04', amount: 900, rate: 1, kind: 'refund', categoryIds: ['home', 'pay'],
      splits: [{ categoryId: 'home', amount: 500 }, { categoryId: 'pay', amount: 400 }] },
  ];
  const ious = [{ transactionId: 'shop', amount: 1000 }];
  const r = insights(tx, { from: '2026-10-01', to: '2026-10-31', accounts, categories, ious });
  assert.equal(r.spending.find((c) => c.id === 'food').amount, 3200 - 1000);
  assert.equal(r.spending.find((c) => c.id === 'home').amount, 1800 - 500);
  assert.equal(r.spending.find((c) => c.id === REFUNDS_UNMATCHED).amount, -400); // a refund part in an income category
  assert.equal(r.expenses, 5000 - 1000 - 900);
  const onlyHome = insights(tx, { from: '2026-10-01', to: '2026-10-31', accounts, categories, ious, onlyCategory: 'home' });
  assert.equal(onlyHome.expenses, 1300);
  assert.deepEqual(scaleSplits([{ categoryId: 'a', amount: -3000 }, { categoryId: 'b', amount: -1000 }], -5001),
    [{ categoryId: 'a', amount: -3751 }, { categoryId: 'b', amount: -1250 }]);
  assert.equal(splitsOf({ splits: [] }), null);
});

test('dividends: income on their own line without a category, and a filter type', () => {
  const accounts = [{ id: 'eur', currency: 'EUR' }];
  const tx = [
    { id: 'd1', accountId: 'eur', date: '2026-10-02', amount: 1234, rate: 1, kind: 'dividend', categoryIds: [] },
    { id: 'd2', accountId: 'eur', date: '2026-10-03', amount: 500, rate: 1, kind: 'dividend', categoryIds: ['inv'] },
    { id: 'x', accountId: 'eur', date: '2026-10-03', amount: 700, rate: 1, categoryIds: [] },
  ];
  const r = insights(tx, { from: '2026-10-01', to: '2026-10-31', accounts, categories: [{ id: 'inv', name: 'Investing', parentId: null }] });
  assert.equal(r.income, 2434);
  assert.equal(r.earning.find((c) => c.id === DIVIDENDS).amount, 1234);
  assert.equal(r.earning.find((c) => c.id === 'inv').amount, 500);
  assert.deepEqual(filterTransactions(tx, { type: 'dividend' }).map((t) => t.id), ['d2', 'd1']);
});

test('recurring: monthly and weekly rhythms are suggested; irregular, stopped, varying or scheduled ones are not', () => {
  const t = (id, accountId, date, amount, description) => ({ id, accountId, date, amount, description, categoryIds: ['c'] });
  const tx = [
    // monthly rent, drifting a couple of days with weekends
    t('r1', 'a', '2026-07-01', -80000, 'Rent'), t('r2', 'a', '2026-08-03', -80000, 'rent'), t('r3', 'a', '2026-09-01', -80000, 'Rent'), t('r4', 'a', '2026-10-01', -80000, 'Rent'),
    // weekly lessons
    t('w1', 'a', '2026-10-06', -2000, 'Lesson'), t('w2', 'a', '2026-10-13', -2000, 'Lesson'), t('w3', 'a', '2026-10-20', -2000, 'Lesson'),
    // irregular
    t('i1', 'a', '2026-08-01', -500, 'Cafe'), t('i2', 'a', '2026-08-04', -500, 'Cafe'), t('i3', 'a', '2026-09-20', -500, 'Cafe'),
    // monthly, but stopped in June
    t('s1', 'a', '2026-04-10', -999, 'Gym'), t('s2', 'a', '2026-05-10', -999, 'Gym'), t('s3', 'a', '2026-06-10', -999, 'Gym'),
    // monthly, but the amounts wander
    t('v1', 'a', '2026-08-15', -1000, 'Shop'), t('v2', 'a', '2026-09-15', -5000, 'Shop'), t('v3', 'a', '2026-10-15', -9000, 'Shop'),
    // already scheduled
    t('k1', 'a', '2026-08-20', -3000, 'Phone'), t('k2', 'a', '2026-09-20', -3000, 'Phone'), t('k3', 'a', '2026-10-20', -3000, 'Phone'),
    // a transfer is never suggested
    { ...t('x1', 'a', '2026-08-25', -100, 'Save'), transferId: 'q1' }, { ...t('x2', 'a', '2026-09-25', -100, 'Save'), transferId: 'q2' }, { ...t('x3', 'a', '2026-10-25', -100, 'Save'), transferId: 'q3' },
  ];
  const groups = recurringGroups(tx, { since: '2025-11-01', until: '2026-11-02' });
  const list = suggestSchedules(groups, { today: '2026-11-02', schedules: [{ accountId: 'a', description: 'PHONE' }] });
  assert.deepEqual(list.map((s) => [s.description, s.every, s.unit, s.nextDate]), [
    ['Rent', 1, 'month', '2026-11-01'], // a day late may just not be entered yet
    ['Lesson', 1, 'week', '2026-11-03'],
  ]);
  const rent = list.find((s) => s.description === 'Rent');
  assert.deepEqual([rent.kind, rent.amount, rent.categoryIds, rent.count, rent.anchorDay], ['expense', 80000, ['c'], 4, 1]);
  assert.equal(suggestSchedules(groups, { today: '2026-11-02', hidden: [rent.id] }).some((s) => s.description === 'Rent'), false);
});

test('returns: XIRR on dated flows, lot flows, and no annual rate under a year', () => {
  // 1,000 in, worth 1,100 a year later: 10% a year.
  assert.ok(Math.abs(xirr([{ date: '2025-01-01', amount: -100000 }, { date: '2026-01-01', amount: 110000 }]) - 0.1) < 0.001);
  // Money added late counts for less time: 1,000 for two years and 1,000 for one, worth 2,300.
  const r = xirr([{ date: '2024-01-01', amount: -100000 }, { date: '2025-01-01', amount: -100000 }, { date: '2026-01-01', amount: 230000 }]);
  const yrs = (d) => (Date.parse('2026-01-01') - Date.parse(d)) / (365.25 * 864e5);
  assert.ok(Math.abs(100000 * (1 + r) ** yrs('2024-01-01') + 100000 * (1 + r) ** yrs('2025-01-01') - 230000) < 1);
  assert.equal(xirr([{ date: '2025-01-01', amount: -100 }]), null);
  assert.deepEqual(lotFlows([
    { date: '2025-01-01', kind: 'buy', quantity: 10, price: 50, fees: 2 },
    { date: '2025-06-01', kind: 'sell', quantity: 4, price: 60, fees: 1 },
  ]), [{ date: '2025-01-01', amount: -50200 }, { date: '2025-06-01', amount: 23900 }]);
  const short = returnSummary([{ date: '2026-09-01', amount: -100000 }, { date: '2026-11-01', amount: 105000 }]);
  assert.deepEqual([short.annual, short.gain, short.simple], [null, 5000, 0.05]);
});

test('net worth history: an investment without buys and sells climbs to its value instead of jumping', () => {
  const accounts = [{ id: 'fund', type: 'investment', currency: 'EUR' }];
  const transactions = [{ accountId: 'fund', date: '2026-01-01', amount: 100000, rate: 1 }];
  const opts = { from: '2026-01-01', to: '2026-05-31', today: '2026-05-31', holdingsValue: () => 120000 };
  const plain = netWorthHistory({ accounts, transactions }, opts);
  assert.deepEqual(plain.points.map((p) => p.total), [100000, 100000, 100000, 100000, 120000]);
  assert.equal(plain.estimated, false);
  const smooth = netWorthHistory({ accounts, transactions }, { ...opts, estimate: { paidIn: () => 100000, first: () => '2026-01-01' } });
  const totals = smooth.points.map((p) => p.total);
  assert.equal(smooth.estimated, true);
  assert.equal(totals.at(-1), 120000);
  assert.ok(totals.every((v, i) => i === 0 || v > totals[i - 1])); // rising all the way
  assert.equal(totals[0], Math.round(100000 * (1 + 0.2 * (30 / 150)))); // end of January: 30 of 150 days
});

test('rules from history: exact names, shared words when numbers vary, only when they are right', () => {
  let n = 0;
  const t = (description, cat, extra = {}) => ({ id: String(n += 1), accountId: 'a', date: '2026-01-01', amount: -100, description, categoryIds: cat ? [cat] : [], ...extra });
  const tx = [
    t('Netflix', 'fun'), t('NETFLIX', 'fun'), t('netflix', 'fun'), t('Netflix', null),
    t('CARD 1234 Green Grocer', 'food'), t('CARD 5678 Green Grocer', 'food'), t('CARD 9012 Green Grocer', 'food'), t('CARD 3456 Green Grocer', null),
    // the same shop in a different category too often: no rule
    t('Corner shop', 'food'), t('Corner shop', 'food'), t('Corner shop', 'home'), t('Corner shop', 'home'),
    // too few
    t('Rare place', 'food'), t('Rare place', 'food'),
    // already covered by a rule
    t('Uber trip', 'transport'), t('Uber trip', 'transport'), t('Uber trip', 'transport'),
    // transfers and splits don't teach rules
    t('To savings', 'x', { transferId: 'q' }), t('To savings', 'x', { transferId: 'r' }), t('To savings', 'x', { transferId: 's' }),
  ];
  const rules = [{ pattern: 'uber', match: 'contains', categoryId: 'transport' }];
  const list = rulesFromHistory(tx, rules);
  assert.deepEqual(list.map((r) => [r.pattern, r.match, r.categoryId, r.count, r.total, r.others]), [
    ['Green Grocer', 'contains', 'food', 3, 3, 1],
    ['Netflix', 'equals', 'fun', 3, 3, 1],
  ]);
});

test('subscriptions: steady prices, one price rise, yearly ones, stopped ones; bills and income left out', () => {
  const g = (key, sign, dates, amounts) => ({ accountId: 'a', key, sign, description: key, categoryIds: ['c'], dates, amounts });
  const groups = [
    g('streaming', -1, ['2026-06-03', '2026-07-03', '2026-08-03', '2026-09-03', '2026-10-03'], [-999, -999, -999, -1299, -1299]),
    g('cloud', -1, ['2023-11-20', '2024-11-20', '2025-11-20'], [-2999, -2999, -2999]),
    g('music', -1, ['2026-03-10', '2026-04-10', '2026-05-10'], [-1099, -1099, -1099]), // stopped in May
    g('power', -1, ['2026-07-15', '2026-08-15', '2026-09-15', '2026-10-15'], [-6000, -4500, -7200, -5100]), // a bill
    g('usd app', -1, ['2026-08-01', '2026-09-01', '2026-10-01'], [-1000, -1030, -990]), // currency wobble
    g('salary', 1, ['2026-08-25', '2026-09-25', '2026-10-25'], [300000, 300000, 300000]),
  ];
  const list = findSubscriptions(groups, { today: '2026-11-02' });
  assert.deepEqual(list.map((x) => [x.description, x.status, x.unit, x.monthly, x.nextDate]), [
    ['streaming', 'active', 'month', 1299, '2026-11-03'],
    ['usd app', 'active', 'month', 990, '2026-11-01'],
    ['cloud', 'active', 'year', 250, '2026-11-20'],
    ['music', 'stopped', 'month', 1099, '2026-06-10'],
  ]);
  assert.deepEqual(list[0].priceChange, { from: 999, to: 1299, date: '2026-09-03' });
  assert.equal(list.find((x) => x.description === 'cloud').yearly, 2999);
  assert.equal(findSubscriptions(groups, { today: '2026-11-02', hidden: [list[0].id] }).length, 3);
});

test('subscriptions: a yearly plan after two charges; marked schedules join or stand alone', () => {
  const g = (key, dates, amounts) => ({ accountId: 'a', key, sign: -1, description: key, categoryIds: [], dates, amounts });
  const found = findSubscriptions([
    g('domain', ['2024-12-01', '2025-11-28'], [-1500, -1500]), // two charges a year apart
    g('twice', ['2026-09-01', '2026-10-01'], [-500, -500]), // two a month apart: not enough
  ], { today: '2026-11-02' });
  assert.deepEqual(found.map((x) => [x.description, x.unit, x.nextDate, x.monthly]), [['domain', 'year', '2026-11-28', 125]]);
  const schedules = [
    { id: 's1', kind: 'expense', accountId: 'a', description: 'DOMAIN', amount: 1800, every: 1, unit: 'year', nextDate: '2026-11-28', subscription: true },
    { id: 's2', kind: 'expense', accountId: 'a', description: 'Gym', amount: 3000, every: 1, unit: 'month', nextDate: '2026-11-05', subscription: true },
    { id: 's3', kind: 'expense', accountId: 'a', description: 'Old box', amount: 900, every: 1, unit: 'month', nextDate: '2026-06-01', endDate: '2026-06-30', subscription: true },
    { id: 's4', kind: 'expense', accountId: 'a', description: 'Rent', amount: 90000, every: 1, unit: 'month', nextDate: '2026-11-01' },
  ];
  const all = withMarkedSchedules(found, schedules, '2026-11-02');
  assert.deepEqual(all.map((x) => [x.description, x.status, x.amount, x.monthly, x.scheduleId, x.lastDate]), [
    ['Gym', 'active', 3000, 3000, 's2', null],
    ['domain', 'active', 1800, 150, 's1', '2025-11-28'], // the schedule's price, what was found kept
    ['Old box', 'stopped', 900, 900, 's3', null],
  ]);
  assert.ok(Math.abs(timesAYear({ every: 2, unit: 'week' }) - 26.09) < 0.01);
});

test('account settings: statement and due dates, balance dips, savings interest, closing dates, last four digits', () => {
  assert.equal(lastStatementDate('2026-11-02', 20), '2026-10-20');
  assert.equal(lastStatementDate('2026-11-20', 20), '2026-11-20');
  assert.equal(lastStatementDate('2026-03-05', 31), '2026-02-28'); // a short month
  assert.equal(dueAfter('2026-10-20', 5), '2026-11-05');
  assert.equal(dueAfter('2026-10-05', 25), '2026-10-25');
  assert.equal(dueAfter('2026-01-31', 30), '2026-02-28');
  const dip = balanceDip(50000, [{ date: '2026-11-10', amount: 100000 }, { date: '2026-11-05', amount: -40000 }, { date: '2026-11-08', amount: -20000 }], 20000);
  assert.deepEqual(dip, { lowest: { date: '2026-11-08', balance: -10000 }, below: { date: '2026-11-05', balance: 10000 } });
  assert.equal(balanceDip(50000, [], 20000).below, null);
  const plain = { monthly: 2500, perPayment: 7500, yearly: 30000 };
  assert.deepEqual(savingsInterest(1200000, 2.5, 3), { ...plain, gross: plain });
  // 28% withheld: what arrives is 72% of it.
  assert.deepEqual(savingsInterest(1200000, 2.5, 3, 28), { monthly: 1800, perPayment: 5400, yearly: 21600, gross: plain });
  // A closing date ends an account in the net worth history even when it isn't archived.
  const { points } = netWorthHistory({ accounts: [{ id: 'x', type: 'savings', currency: 'EUR', closedOn: '2026-02-15' }], transactions: [{ accountId: 'x', date: '2026-01-05', amount: 5000, rate: 1 }] },
    { from: '2026-01-01', to: '2026-04-30', today: '2026-05-01', holdingsValue: () => null });
  assert.deepEqual(points.map((p) => p.total), [5000, 0, 0, 0]);
  // CSV rows find an account by the last four digits of its number.
  const r = importRows([['2026-01-02', 'Shop', '-5', 'VISA ****4321']], { mapping: { date: 0, description: 1, amount: 2, account: 3, type: -1, category: -1, memo: -1, currency: -1, reference: -1, iou: -1 }, dateFormat: 'ymd', decimal: '.', defaultAccountId: null },
    { accounts: [{ id: 'card', name: 'Travel card', currency: 'EUR', lastFour: '4321' }], categories: [], rules: [], transactions: [], id: (() => { let i = 0; return () => `n${i += 1}`; })() });
  assert.deepEqual([r.transactions[0].accountId, r.newAccounts.length], ['card', 0]);
});

test('category search: every word in the path, accents ignored, name prefix first', () => {
  const cats = [
    { id: 'food', name: 'Food' }, { id: 'gro', name: 'Groceries', parentId: 'food' }, { id: 'rest', name: 'Restaurants', parentId: 'food' },
    { id: 'home', name: 'Home' }, { id: 'furn', name: 'Furniture', parentId: 'home' }, { id: 'sau', name: 'Saúde' },
  ];
  const ids = (q, ex) => searchCategories(cats, q, ex).map((c) => c.id);
  assert.deepEqual(ids(''), ['food', 'gro', 'rest', 'home', 'furn', 'sau']);
  assert.deepEqual(ids('food'), ['food', 'gro', 'rest']);
  assert.deepEqual(ids('food gro'), ['gro']);
  assert.deepEqual(ids('saude'), ['sau']);
  assert.deepEqual(ids('f'), ['food', 'furn', 'gro', 'rest']);
  assert.deepEqual(ids('food', ['gro']), ['food', 'rest']);
  assert.deepEqual(ids('nothing'), []);
});
