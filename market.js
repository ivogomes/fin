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

// Returns { name, currency, price } for a listing. `mic` pins the exchange (e.g. XETR for Xetra).
export async function fetchQuote(symbol, apiKey, mic) {
  if (!apiKey) throw new Error('Add a Twelve Data API key in Settings to fetch prices');
  const micParam = mic ? `&mic_code=${encodeURIComponent(mic)}` : '';
  const res = await fetch(`${QUOTE}?symbol=${encodeURIComponent(symbol)}${micParam}&apikey=${encodeURIComponent(apiKey)}`);
  const data = await res.json();
  if (data.status === 'error' || !data.close) throw new Error(data.message || `No quote for ${symbol}`);
  return { name: data.name, currency: data.currency, price: Number(data.close) };
}
