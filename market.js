// Market data. FX comes from Frankfurter (ECB reference rates, free, no key, CORS-enabled).
// Stock and ETF quotes come from Twelve Data, which needs a free API key set in Settings: Yahoo and
// most other free quote feeds block browser requests, so there is no key-less option from a static page.

import { BASE } from './model.js';

const FX = 'https://api.frankfurter.dev/v2/rates';
const QUOTE = 'https://api.twelvedata.com/quote';
const SEARCH = 'https://api.twelvedata.com/symbol_search';

export const today = () => new Date().toISOString().slice(0, 10);

// Base-currency units per 1 unit of `currency` on `date`. Weekends and holidays resolve to the last
// published rate, which is what "daily exchange rate" means for ECB data.
export async function fetchRate(currency, date = today()) {
  if (currency === BASE) return 1;
  const url = `${FX}?date=${date}&base=${BASE}&quotes=${currency}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Exchange rate unavailable (${res.status})`);
  const rows = await res.json();
  const perBase = rows[0]?.rate;
  if (!perBase) throw new Error(`No ${currency} rate for ${date}`);
  return 1 / perBase;
}

// Daily rates for a date range in one request: { 'YYYY-MM-DD': rate } for each published day.
// Used to price many imported transactions at once instead of one request per date.
export async function fetchRateRange(currency, from, to) {
  const res = await fetch(`${FX}?from=${from}&to=${to}&base=${BASE}&quotes=${currency}`);
  if (!res.ok) throw new Error(`Exchange rates unavailable (${res.status})`);
  return Object.fromEntries((await res.json()).map((r) => [r.date, 1 / r.rate]));
}

// Search by ticker or name ("VWCE", "apple"). Works without an API key. Each match is one listing,
// so the same ETF appears once per exchange, with the currency it trades in there.
export async function searchSymbols(query, signal) {
  const res = await fetch(`${SEARCH}?symbol=${encodeURIComponent(query)}&outputsize=12`, { signal });
  if (!res.ok) throw new Error(`Search unavailable (${res.status})`);
  const { data = [] } = await res.json();
  return data.map((d) => ({
    symbol: d.symbol, name: d.instrument_name, exchange: d.exchange, mic: d.mic_code,
    type: d.instrument_type, country: d.country, currency: d.currency,
  }));
}

// Alpha Vantage prices listings that Twelve Data's free plan refuses (Xetra and other non-US
// exchanges). It names a listing by ticker plus an exchange suffix. DEX, LON and TRT are documented
// by Alpha Vantage; the others follow the same scheme and are unconfirmed.
const AV = 'https://www.alphavantage.co/query';
const AV_SUFFIX = { XETR: 'DEX', XFRA: 'FRK', XLON: 'LON', XPAR: 'PAR', XAMS: 'AMS', XTSE: 'TRT', XTSX: 'TRV' };

export const alphaVantageCovers = (mic) => mic in AV_SUFFIX;

// Returns { price }. Alpha Vantage doesn't report a currency, so the listing's own is kept.
export async function fetchQuoteAV(symbol, mic, apiKey) {
  if (!apiKey) throw new Error('Add an Alpha Vantage API key in Settings to price this listing');
  const ticker = `${symbol}.${AV_SUFFIX[mic]}`;
  const res = await fetch(`${AV}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`);
  const data = await res.json();
  // Limits and key problems come back as 200 with an Information, Note or Error Message field.
  const notice = data.Information || data.Note || data['Error Message'];
  if (notice) throw new Error(notice);
  const price = Number(data['Global Quote']?.['05. price']);
  if (!price) throw new Error(`Alpha Vantage has no price for ${ticker}`);
  return { price };
}

// Weekly closing prices for a listing, { 'YYYY-MM-DD': price }, as far back as the provider goes:
// Alpha Vantage for the non-US exchanges it covers, Twelve Data otherwise. One request each.
export async function fetchHistory(symbol, mic, { avKey, tdKey }) {
  if (alphaVantageCovers(mic)) {
    if (!avKey) throw new Error('Add an Alpha Vantage API key in Settings to load price history');
    const ticker = `${symbol}.${AV_SUFFIX[mic]}`;
    const res = await fetch(`${AV}?function=TIME_SERIES_WEEKLY&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(avKey)}`);
    const data = await res.json();
    const notice = data.Information || data.Note || data['Error Message'];
    if (notice) throw new Error(notice);
    const series = data['Weekly Time Series'];
    if (!series) throw new Error(`Alpha Vantage has no history for ${ticker}`);
    return Object.fromEntries(Object.entries(series).map(([date, v]) => [date, Number(v['4. close'])]).filter(([, v]) => v > 0));
  }
  if (!tdKey) throw new Error('Add a Twelve Data API key in Settings to load price history');
  const micParam = mic ? `&mic_code=${encodeURIComponent(mic)}` : '';
  const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}${micParam}&interval=1week&outputsize=5000&apikey=${encodeURIComponent(tdKey)}`);
  const data = await res.json();
  if (data.status === 'error' || !Array.isArray(data.values)) throw new Error(data.message || `No history for ${symbol}`);
  return Object.fromEntries(data.values.map((v) => [v.datetime, Number(v.close)]).filter(([, v]) => v > 0));
}

// Returns { name, currency, price } for a listing. `mic` pins the exchange (e.g. XETR for Xetra).
export async function fetchQuote(symbol, apiKey, mic) {
  if (!apiKey) throw new Error('Add a Twelve Data API key in Settings to fetch prices');
  const micParam = mic ? `&mic_code=${encodeURIComponent(mic)}` : '';
  const res = await fetch(`${QUOTE}?symbol=${encodeURIComponent(symbol)}${micParam}&apikey=${encodeURIComponent(apiKey)}`);
  const data = await res.json();
  if (data.status === 'error' || !data.close) throw new Error(data.message || `No quote for ${symbol}`);
  return { name: data.name, currency: data.currency, price: Number(data.close) };
}

// Funds (named by ISIN) come from EODHD, through the database's fund_data function (schema.sql),
// as EODHD can't be called from a web page. `call(args)` runs it: rpc('fund_data', args).
export const FUND_MIC = 'EUFUND';
export const isIsin = (text) => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(String(text).trim().toUpperCase());

// What the fund is, as a search result ({ symbol, name, exchange, mic, type, country, currency }), or null.
// Without a currency in EODHD's data it's taken as EUR, and `currencyGuessed` says so.
export async function fundSearch(isin, call) {
  const list = await call({ p_isin: isin, p_kind: 'search' });
  const f = (Array.isArray(list) ? list : []).find((x) => x.Exchange === FUND_MIC) ?? (Array.isArray(list) ? list[0] : null);
  if (!f) return null;
  return { symbol: isin, name: f.Name, exchange: 'Funds (EODHD)', mic: FUND_MIC, type: f.Type || 'Fund', country: f.Country || isin.slice(0, 2), currency: f.Currency || 'EUR', currencyGuessed: !f.Currency };
}

// The latest price (NAV) from the last two weeks: { price }.
export async function fundQuote(isin, call) {
  const rows = await call({ p_isin: isin, p_kind: 'prices' });
  const last = (Array.isArray(rows) ? rows : []).filter((r) => Number(r.close) > 0).at(-1);
  if (!last) throw new Error(`EODHD has no recent price for ${isin}`);
  return { price: Number(last.close) };
}

// Weekly prices (the last of each week), { 'YYYY-MM-DD': price }, as far back as EODHD goes.
export async function fundHistory(isin, call) {
  const rows = await call({ p_isin: isin, p_kind: 'prices', p_from: '2000-01-01' });
  const byWeek = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!(Number(r.close) > 0)) continue;
    const d = new Date(`${r.date}T00:00:00Z`);
    const monday = new Date(d - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
    const had = byWeek.get(monday);
    if (!had || r.date > had[0]) byWeek.set(monday, [r.date, Number(r.close)]);
  }
  if (!byWeek.size) throw new Error(`EODHD has no history for ${isin}`);
  return Object.fromEntries(byWeek.values());
}
