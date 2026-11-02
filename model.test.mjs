import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinor, formatMoney, categorize, convert, rateFor, accountBalance,
  holdingValue, investmentValue, netWorth, defaultState, withRunningBalance,
  crossConvert, batchRow, makeTransfer,
  parseCsv, toCsv, parseAmount, parseDate, guessDateFormat, guessDecimal, guessMapping, importRows,
  findTransferPairs, detectBuxferFile, buxferImport,
  categoryPath, categoryResolver, categoriesOf, sortedCategories,
  parseBuxferIou, iouSign, iouType, personBalances, personHistory,
  periodRange, granularity, insights, netWorthHistory, isFtExport, ftImport, lotSummary, investedHistory,
  parseFrequency, addInterval, occurrences, forecast, scheduledTransactions, advanceSchedule,
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

test('batch rows: refunds are positive and marked', () => {
  const { tx } = batchRow({ description: 'Refund', amount: '5', sign: 'r', date: '2026-11-02', accountId: 'a', categoryId: '' }, []);
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
  assert.deepEqual([s['Reforço PPR'].accountId, s['Reforço PPR'].toAccountId, s['Reforço PPR'].categoryId], [bank.id, ppr.id, null]);
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
  const base = { date: '2026-11-02', accountId: 'a', categoryId: '', sign: '-' };
  assert.deepEqual(batchRow({ ...base, description: ' ', amount: '' }, rules), { skip: true });
  assert.equal(batchRow({ ...base, description: 'Lunch', amount: '' }, rules).error, 'needs an amount above zero');
  assert.equal(batchRow({ ...base, description: '', amount: '5' }, rules).error, 'needs a description');
  const { tx } = batchRow({ ...base, description: 'Lunch', amount: '12.50' }, rules);
  assert.equal(tx.amount, -1250);
  assert.deepEqual(tx.categoryIds, ['meals']);
  assert.equal(batchRow({ ...base, description: 'Refund', amount: '3', sign: '+' }, rules).tx.amount, 300);
  assert.deepEqual(batchRow({ ...base, description: 'Lunch', amount: '1', categoryId: 'fun' }, rules).tx.categoryIds, ['fun']);
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
