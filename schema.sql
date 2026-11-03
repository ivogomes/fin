-- Finance tool schema for Supabase. Run once in the project's SQL editor (Database → SQL editor).
-- Every table is keyed by (user_id, id) and protected by row-level security, so each signed-in user
-- can only read and write their own rows.

create table if not exists accounts (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  name text not null,
  type text not null check (type in ('cash', 'checking', 'credit', 'investment', 'savings')),
  currency text not null default 'EUR',
  archived boolean not null default false,
  primary key (user_id, id)
);

create table if not exists categories (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  name text not null,
  primary key (user_id, id)
);

create table if not exists rules (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  pattern text not null,
  match text not null check (match in ('contains', 'starts', 'equals')),
  category_id text,
  position integer not null default 0,
  primary key (user_id, id)
);

create table if not exists transactions (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  account_id text not null,
  date date not null,
  description text not null default '',
  amount bigint not null,              -- minor units (cents) in the account's currency
  category_id text,
  rate double precision,               -- EUR per 1 unit of the account currency on `date`
  memo text,
  status text not null default 'cleared' check (status in ('cleared', 'pending')),
  transfer_id text,
  primary key (user_id, id),
  foreign key (user_id, account_id) references accounts (user_id, id) on delete cascade
);
create index if not exists transactions_account on transactions (user_id, account_id, date);

create table if not exists holdings (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  account_id text not null,
  symbol text not null,
  mic text,
  exchange text,
  name text,
  currency text not null default 'EUR',
  quantity double precision not null default 0,
  price double precision,
  price_at timestamptz,
  manual boolean not null default false,
  price_error text,
  source text,
  primary key (user_id, id),
  foreign key (user_id, account_id) references accounts (user_id, id) on delete cascade
);

-- The buys and sells of a holding (from an FT.com export, or added by hand). A holding with lots
-- takes its quantity from them.
create table if not exists lots (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  holding_id text not null,
  date date not null,
  kind text not null check (kind in ('buy', 'sell')),
  quantity double precision not null,
  price double precision not null,     -- per unit, in the holding's currency
  fees double precision not null default 0,
  primary key (user_id, id),
  foreign key (user_id, holding_id) references holdings (user_id, id) on delete cascade
);

-- Scheduled (recurring) transactions. Each due date is entered or skipped by hand.
create table if not exists schedules (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  description text not null default '',
  amount bigint not null,              -- positive minor units; the kind gives the direction
  kind text not null check (kind in ('expense', 'income', 'transfer')),
  account_id text not null,
  to_account_id text,                  -- transfers only
  category_id text,
  every integer not null default 1,
  unit text not null check (unit in ('day', 'week', 'month', 'year')),
  anchor_day integer,                  -- day of the month to aim for
  next_date date not null,
  end_date date,
  primary key (user_id, id),
  foreign key (user_id, account_id) references accounts (user_id, id) on delete cascade
);

-- IOUs: people, and entries of what they owe you (positive) or you owe them (negative).
create table if not exists people (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  name text not null,
  primary key (user_id, id)
);

create table if not exists ious (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  person_id text not null,
  date date not null,
  description text not null default '',
  amount bigint not null,              -- minor units, in EUR
  transaction_id text,                 -- the transaction that moved the money, if any
  kind text,                           -- loan, settlement, paid_for_friend or shared_bill
  primary key (user_id, id),
  foreign key (user_id, person_id) references people (user_id, id) on delete cascade
);

-- One snapshot per day of what investment accounts were worth at market prices, so net worth can
-- show investments over time (there's no price history before the first one).
create table if not exists snapshots (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,                    -- the date, one per day
  date date not null,
  "values" jsonb not null default '{}', -- { accountId: value in EUR minor units }
  primary key (user_id, id)
);

-- One row per user: API keys for market data and the last account viewed.
create table if not exists settings (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  quote_api_key text,
  av_api_key text,
  last_account_id text
);

-- Added later; safe to run on an existing database.
-- Categories can sit under a parent (two levels, like Buxfer).
alter table categories add column if not exists parent_id text;
-- A transaction can have several categories. Existing single categories are copied over once.
alter table transactions add column if not exists category_ids text[] not null default '{}';
update transactions set category_ids = array[category_id]
  where category_id is not null and category_ids = '{}';
-- A transaction's kind: null for an ordinary one, 'refund' (cancels part of an expense) or
-- 'opening' (an opening balance). Insights read it.
alter table transactions add column if not exists kind text;
-- The latest exchange rates and the day they're from, so they're fetched at most once a day.
alter table settings add column if not exists fx jsonb not null default '{}';
-- Weekly closing prices per holding, { date: price }, loaded once and kept, for charts over time.
alter table holdings add column if not exists price_history jsonb;
-- Backups: when one was last downloaded, and how many days between reminders (0 = none).
-- Credit cards: the credit limit (cents, in the account's currency), to show what's left.
alter table accounts add column if not exists credit_limit bigint;
-- Credit cards: the card network ('visa' or 'mastercard'), shown as a small mark by the name.
alter table accounts add column if not exists card_network text;
alter table settings add column if not exists last_backup_at timestamptz;
alter table settings add column if not exists backup_every integer not null default 7;
-- A transaction split across categories: [{ "categoryId": …, "amount": cents }], adding up to its amount.
alter table transactions add column if not exists splits jsonb;
-- A dividend (kind 'dividend'): the holding that paid it.
alter table transactions add column if not exists holding_id text;
-- Suggested schedules turned down ("Not recurring"), so they aren't offered again.
alter table settings add column if not exists hidden_suggestions jsonb not null default '[]';
-- A schedule can have several categories, like a transaction. Existing single ones are copied over once.
alter table schedules add column if not exists category_ids text[] not null default '{}';
update schedules set category_ids = array[category_id]
  where category_id is not null and category_ids = '{}';
-- A schedule marked as a subscription (Scheduled → Subscriptions lists it).
alter table schedules add column if not exists subscription boolean not null default false;
-- Account settings by type. Credit cards: the statement day and payment due day (of the month), and
-- the account the card is paid from.
alter table accounts add column if not exists statement_day integer;
alter table accounts add column if not exists due_day integer;
alter table accounts add column if not exists pay_from text;
-- Checking: warn when the balance is heading below this (cents); the main account (one at most).
alter table accounts add column if not exists low_balance bigint;
alter table accounts add column if not exists is_main boolean not null default false;
-- Savings: the yearly interest rate (percent) and how often it's paid (months).
alter table accounts add column if not exists interest_rate double precision;
alter table accounts add column if not exists interest_every integer;
-- Savings: the tax withheld from each interest payment (percent).
alter table accounts add column if not exists interest_tax double precision;
-- Investments: brokerage, pension, retirement, crypto or other.
alter table accounts add column if not exists investment_kind text;
-- Any account: when it was opened and closed, the bank, the last four digits of its number (to
-- match imports), whether it counts in totals, and a colour (0–7).
alter table accounts add column if not exists opened_on date;
alter table accounts add column if not exists closed_on date;
alter table accounts add column if not exists institution text;
alter table accounts add column if not exists last_four text;
alter table accounts add column if not exists exclude_totals boolean not null default false;
alter table accounts add column if not exists color text;

-- ── Calculations done in the database ─────────────────────────────────────────
-- The app doesn't load every transaction on every page: these functions return what a page shows.
-- They run as the signed-in user (row-level security applies) and return JSON, so a large answer
-- isn't cut at the 1000-row limit. Safe to re-run.

-- Text compared the way the app does: lowercase, trimmed, accents removed ("Café" = "cafe").
create or replace function fin_norm(t text) returns text
language sql immutable as $$
  select trim(translate(lower(coalesce(t, '')), 'áàâãäåāăąçćčďéèêëēėęěíìîïīįñńňóòôõöōőŕřśšşťúùûüūůűųýÿžźż', 'aaaaaaaaacccdeeeeeeeeiiiiiinnnooooooorrssstuuuuuuuuyyzzz'))
$$;

-- A transaction's categories (rows saved before several categories were allowed have category_id).
create or replace function fin_cats(ids text[], one text) returns text[]
language sql immutable as $$
  select case when cardinality(ids) > 0 then ids when one is not null then array[one] else '{}'::text[] end
$$;

-- Rounds the way the app does (Math.round: halves go up).
create or replace function fin_round(x double precision) returns bigint
language sql immutable as $$ select floor(x + 0.5)::bigint $$;

-- Whether a transaction matches the filters of a list (the app's filter bar): p_text (normalised)
-- in the description or memo, or p_amount (cents) as its size; p_wanted, categories any of which it
-- has (the chosen ones and their subcategories), or, with p_uncategorized, none (transfers aside);
-- p_types, any of expense/income/refund/dividend/transfer; dates; sizes in cents. Empty or null
-- means no filter. `cats` is fin_cats of the row.
-- (Before several categories and types could be picked, p_wanted came with one p_type.)
drop function if exists fin_match(transactions, text[], text, bigint, text[], boolean, text, date, date, bigint, bigint);
create or replace function fin_match(
  t transactions, cats text[], p_text text, p_amount bigint, p_wanted text[], p_uncategorized boolean,
  p_types text[], p_from date, p_to date, p_min bigint, p_max bigint
) returns boolean
language sql stable as $$
  select (p_from is null or t.date >= p_from) and (p_to is null or t.date <= p_to)
    and (p_min is null or abs(t.amount) >= p_min) and (p_max is null or abs(t.amount) <= p_max)
    and (coalesce(cardinality(p_types), 0) = 0
      or ('transfer' = any(p_types) and t.transfer_id is not null)
      or ('refund' = any(p_types) and t.kind = 'refund')
      or ('dividend' = any(p_types) and t.kind = 'dividend')
      or ('expense' = any(p_types) and t.transfer_id is null and t.kind is distinct from 'refund' and t.amount < 0)
      or ('income' = any(p_types) and t.transfer_id is null and t.kind is distinct from 'refund' and t.amount > 0))
    and ((coalesce(cardinality(p_wanted), 0) = 0 and not coalesce(p_uncategorized, false))
      or cats && p_wanted
      or (coalesce(p_uncategorized, false) and cardinality(cats) = 0 and t.transfer_id is null))
    and (p_text is null or p_text = ''
      or strpos(fin_norm(t.description), p_text) > 0 or strpos(fin_norm(t.memo), p_text) > 0
      or abs(t.amount) = p_amount)
$$;

-- Categories with their subcategories, for p_wanted (null when there are none to filter on).
drop function if exists fin_family(text);
create or replace function fin_family(p_categories text[]) returns text[]
language sql stable as $$
  select case when coalesce(cardinality(p_categories), 0) = 0 then null else
    array(select id from categories where user_id = auth.uid() and (id = any(p_categories) or parent_id = any(p_categories))) || p_categories end
$$;

-- One row per account: balance up to `p_today`, how many transactions, and the ones dated after
-- today (planned: their sum up to `p_until`, and how many there are in all).
create or replace function account_summaries(p_today date, p_until date) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'accountId', account_id, 'balance', balance, 'count', n, 'past', past, 'planned', planned, 'plannedCount', planned_n,
    'first', first)), '[]'::jsonb)
  from (
    select account_id,
      coalesce(sum(amount) filter (where date <= p_today), 0) as balance,
      count(*) as n,
      count(*) filter (where date <= p_today) as past,
      coalesce(sum(amount) filter (where date > p_today and date <= p_until), 0) as planned,
      count(*) filter (where date > p_today) as planned_n,
      min(date) as first
    from transactions
    where user_id = auth.uid()
    group by account_id
  ) s
$$;

-- One page of an account's transactions up to today, newest first, each with the account balance
-- right after it (over all of the account's history, so filters don't change it). Also: how many
-- match, every transaction dated after today, and the other side of any transfer on the page.
-- Filters as in the app: p_text (normalised) in the description or memo, or p_amount (cents) as the
-- size; p_categories (any of them, with their subcategories) or p_uncategorized; p_types (any of
-- expense/income/refund/dividend/transfer); dates; sizes in cents.
drop function if exists account_transactions(text, date, int, int, text, bigint, text, boolean, text, date, date, bigint, bigint);
create or replace function account_transactions(
  p_account text, p_today date, p_limit int default 100, p_offset int default 0,
  p_text text default null, p_amount bigint default null, p_categories text[] default null,
  p_uncategorized boolean default false, p_types text[] default null,
  p_from date default null, p_to date default null, p_min bigint default null, p_max bigint default null
) returns jsonb
language sql stable as $$
  -- The categories asked for (with their subcategories), worked out once, not once per row.
  with w as materialized (select fin_family(p_categories) as wanted),
  t as (
    select tr as r0, tr.*, fin_cats(tr.category_ids, tr.category_id) as cats,
      sum(tr.amount) over (order by tr.date, tr.id rows unbounded preceding) as balance
    from transactions tr
    where tr.user_id = auth.uid() and tr.account_id = p_account and tr.date <= p_today
  ),
  f as (
    select t.* from t, w
    where fin_match(t.r0, t.cats, p_text, p_amount, w.wanted, p_uncategorized, p_types, p_from, p_to, p_min, p_max)
  ),
  page as (
    select * from f order by date desc, id desc limit p_limit offset p_offset
  ),
  planned as (
    select tr.* from transactions tr
    where tr.user_id = auth.uid() and tr.account_id = p_account and tr.date > p_today
  ),
  partners as (
    select tr.* from transactions tr
    where tr.user_id = auth.uid() and tr.account_id <> p_account
      and tr.transfer_id in (select transfer_id from page where transfer_id is not null
                             union select transfer_id from planned where transfer_id is not null)
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((select jsonb_agg((to_jsonb(page) - 'user_id' - 'cats' - 'r0') order by date desc, id desc) from page), '[]'::jsonb),
    'planned', coalesce((select jsonb_agg(to_jsonb(planned) - 'user_id' order by date, id) from planned), '[]'::jsonb),
    'partners', coalesce((select jsonb_agg(to_jsonb(partners) - 'user_id') from partners), '[]'::jsonb)
  )
$$;

-- Search across accounts (p_accounts, or all when null), every date: one page, newest first, how
-- many match, In and Out in EUR (transfers left out; at each transaction's rate, else today's from
-- p_rates, { "USD": 0.92 }), and the other side of any transfer on the page. Filters as in
-- account_transactions.
drop function if exists search_transactions(text[], int, int, text, bigint, text, boolean, text, date, date, bigint, bigint, jsonb);
create or replace function search_transactions(
  p_accounts text[] default null, p_limit int default 100, p_offset int default 0,
  p_text text default null, p_amount bigint default null, p_categories text[] default null,
  p_uncategorized boolean default false, p_types text[] default null,
  p_from date default null, p_to date default null, p_min bigint default null, p_max bigint default null,
  p_rates jsonb default '{}'::jsonb
) returns jsonb
language sql stable as $$
  -- The categories asked for (with their subcategories), worked out once, not once per row.
  with w as materialized (select fin_family(p_categories) as wanted),
  f as (
    select tr.*, fin_round(tr.amount * coalesce(tr.rate, (p_rates ->> a.currency)::double precision, 1)) as eur
    from transactions tr
    join accounts a on a.user_id = tr.user_id and a.id = tr.account_id
    cross join w
    where tr.user_id = auth.uid() and (p_accounts is null or tr.account_id = any(p_accounts))
      and fin_match(tr, fin_cats(tr.category_ids, tr.category_id), p_text, p_amount, w.wanted,
                    p_uncategorized, p_types, p_from, p_to, p_min, p_max)
  ),
  page as (
    select * from f order by date desc, id limit p_limit offset p_offset
  ),
  partners as (
    select tr.* from transactions tr
    where tr.user_id = auth.uid() and tr.id not in (select id from page)
      and tr.transfer_id in (select transfer_id from page where transfer_id is not null)
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'in', (select coalesce(sum(eur), 0) from f where transfer_id is null and amount > 0),
    'out', (select coalesce(-sum(eur), 0) from f where transfer_id is null and amount < 0),
    'rows', coalesce((select jsonb_agg((to_jsonb(page) - 'user_id' - 'eur') order by date desc, id) from page), '[]'::jsonb),
    'partners', coalesce((select jsonb_agg(to_jsonb(partners) - 'user_id') from partners), '[]'::jsonb)
  )
$$;

-- Insights: income and spending from p_from to p_to, for some accounts (p_accounts) or all, added up
-- per day and per category; the app groups them into weeks or months and under parent categories.
-- The rules are the app's (model.js insightTotals): transfers and opening balances don't count; a
-- transaction counts after its IOU entries; amounts in EUR at the transaction's rate, else today's
-- (p_rates); a refund lowers spending, in its first category that isn't an income one (more in
-- than out over all of history), else under 'refunds'; one category per transaction (its first),
-- except a split one, whose parts count under their own categories (its IOU entries go with the
-- first part); dividends with no category under 'dividends'.
-- p_only keeps transactions in that category or its subcategories.
create or replace function insight_totals(
  p_from date, p_to date, p_accounts text[] default null, p_only text default null, p_rates jsonb default '{}'::jsonb
) returns jsonb
language sql stable as $$
  with cats as (
    select id, parent_id from categories where user_id = auth.uid()
  ),
  income_tops as (
    select coalesce(c.parent_id, x.cat) as top
    from (
      select (fin_cats(category_ids, category_id))[1] as cat, amount, rate from transactions
      where user_id = auth.uid() and transfer_id is null and kind is null
    ) x
    left join cats c on c.id = x.cat
    where x.cat is not null
    group by 1
    having sum(fin_round(x.amount * coalesce(x.rate, 1))) > 0
  ),
  iou as (
    select transaction_id, sum(amount) as amount from ious
    where user_id = auth.uid() and transaction_id is not null
    group by 1
  ),
  t as (
    select tr.date, tr.kind,
      fin_round(sp.amount * coalesce(tr.rate, (p_rates ->> a.currency)::double precision, 1))
        + case when sp.n = 1 then coalesce(i.amount, 0) else 0 end as eur,
      case
        when sp.split then case
          when sp.cat is null then case when tr.kind = 'dividend' then 'dividends' end
          when tr.kind = 'refund' and coalesce((select c.parent_id from cats c where c.id = sp.cat), sp.cat) in (select top from income_tops) then 'refunds'
          else sp.cat end
        when tr.kind = 'dividend' and cardinality(fin_cats(tr.category_ids, tr.category_id)) = 0 then 'dividends'
        when tr.kind is distinct from 'refund' then (fin_cats(tr.category_ids, tr.category_id))[1]
        when cardinality(fin_cats(tr.category_ids, tr.category_id)) = 0 then null
        else coalesce((
          select u.x from unnest(fin_cats(tr.category_ids, tr.category_id)) with ordinality as u(x, n)
          left join cats c on c.id = u.x
          where coalesce(c.parent_id, u.x) not in (select top from income_tops)
          order by u.n limit 1), 'refunds')
      end as cat
    from transactions tr
    join accounts a on a.user_id = tr.user_id and a.id = tr.account_id
    left join iou i on i.transaction_id = tr.id
    -- One row per part: a split transaction's parts, or the whole transaction.
    cross join lateral (
      select nullif(e.value ->> 'categoryId', '') as cat, (e.value ->> 'amount')::bigint as amount, e.n, true as split
      from jsonb_array_elements(case when jsonb_typeof(tr.splits) = 'array' then tr.splits else '[]'::jsonb end) with ordinality as e(value, n)
      union all
      select null, tr.amount, 1, false
      where coalesce(jsonb_array_length(case when jsonb_typeof(tr.splits) = 'array' then tr.splits end), 0) = 0
    ) sp
    where tr.user_id = auth.uid() and tr.date between p_from and p_to
      and (p_accounts is null or tr.account_id = any(p_accounts))
      and tr.transfer_id is null and tr.kind is distinct from 'opening'
  ),
  k as (
    select date, eur, cat, case when kind = 'refund' then 'refund' when eur < 0 then 'out' else 'in' end as side
    from t
    where eur <> 0
      and (p_only is null or cat in (select id from cats where id = p_only or parent_id = p_only union select p_only))
  )
  select jsonb_build_object(
    'income', (select coalesce(sum(eur), 0) from k where side = 'in'),
    'expenses', (select coalesce(-sum(eur), 0) from k where side <> 'in'),
    'refunds', (select coalesce(sum(eur), 0) from k where side = 'refund'),
    'count', (select count(*) from k),
    'days', coalesce((select jsonb_agg(jsonb_build_object('date', date, 'income', inc, 'expenses', spent)) from (
      select date, coalesce(sum(eur) filter (where side = 'in'), 0) as inc, coalesce(-sum(eur) filter (where side <> 'in'), 0) as spent
      from k group by date) d), '[]'::jsonb),
    'spend', coalesce((select jsonb_agg(jsonb_build_object('cat', cat, 'amount', amount)) from (
      select cat, -sum(eur) as amount from k where side <> 'in' group by cat) x), '[]'::jsonb),
    'earn', coalesce((select jsonb_agg(jsonb_build_object('cat', cat, 'amount', amount)) from (
      select cat, sum(eur) as amount from k where side = 'in' group by cat) x), '[]'::jsonb)
  )
$$;

-- Net worth over time: each account's transactions added up in EUR (at their rate, else today's from
-- p_rates) at each of p_dates (sorted), and the date of its last transaction. The app values
-- investments from their holdings itself (model.js netWorthHistory, accountRuns for the same in JS).
-- p_skip_opening leaves opening balances out (what was put into an investment account); p_native
-- keeps each account's own currency (an account's balance chart) instead of EUR.
drop function if exists balances_at(date[], jsonb, text[], boolean);
create or replace function balances_at(
  p_dates date[], p_rates jsonb default '{}'::jsonb, p_accounts text[] default null, p_skip_opening boolean default false,
  p_native boolean default false
) returns jsonb
language sql stable as $$
  with tx as (
    select tr.account_id, tr.date,
      case when p_native then tr.amount
        else fin_round(tr.amount * coalesce(tr.rate, (p_rates ->> a.currency)::double precision, 1)) end as eur
    from transactions tr
    join accounts a on a.user_id = tr.user_id and a.id = tr.account_id
    where tr.user_id = auth.uid() and (p_accounts is null or tr.account_id = any(p_accounts))
      and not (p_skip_opening and tr.kind is not distinct from 'opening')
  ),
  -- Each transaction counts from the first date on or after it: point i (past the last: not at all).
  per as (
    select account_id, width_bucket(date - 1, p_dates) + 1 as i, sum(eur) as eur, max(date) as last
    from tx group by account_id, 2
  ),
  vals as (
    select a.account_id, k, sum(coalesce(p.eur, 0)) over (partition by a.account_id order by k) as v
    from (select distinct account_id from per) a
    cross join generate_series(1, cardinality(p_dates)) as k
    left join per p on p.account_id = a.account_id and p.i = k
  )
  select coalesce(jsonb_object_agg(x.account_id, jsonb_build_object(
    'last', (select max(last) from per where per.account_id = x.account_id), 'values', x.vals)), '{}'::jsonb)
  from (select account_id, jsonb_agg(v order by k) as vals from vals group by account_id) x
$$;

-- Fund prices from EODHD (funds named by ISIN, e.g. LU0109981661). EODHD's API can't be called from
-- a web page (it doesn't allow other sites to read its answers), so the database calls it, with the
-- signed-in user's own EODHD key from settings. p_kind 'search': what the fund is (name, currency);
-- 'prices': its daily prices from p_from (default: the last two weeks). Needs the http extension.
create extension if not exists http with schema extensions;
alter table settings add column if not exists eodhd_api_key text;

create or replace function fund_data(p_isin text, p_kind text, p_from date default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  k text;
  url text;
  r http_response;
begin
  if p_isin !~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$' then raise exception 'Not an ISIN: %', p_isin; end if;
  select eodhd_api_key into k from settings where user_id = auth.uid();
  if coalesce(k, '') = '' then raise exception 'Add an EODHD API key in Settings to price funds'; end if;
  if p_kind = 'search' then
    url := format('https://eodhd.com/api/search/%s?api_token=%s&fmt=json', p_isin, urlencode(k));
  elsif p_kind = 'prices' then
    url := format('https://eodhd.com/api/eod/%s.EUFUND?api_token=%s&fmt=json&from=%s',
      p_isin, urlencode(k), coalesce(p_from, current_date - 14));
  else
    raise exception 'Unknown request: %', p_kind;
  end if;
  r := http_get(url);
  if r.status <> 200 then raise exception 'EODHD answered % for %', r.status, p_isin; end if;
  return r.content::jsonb;
end $$;
revoke execute on function fund_data(text, text, date) from public, anon;
grant execute on function fund_data(text, text, date) to authenticated;

-- Earlier descriptions for the suggestions when adding transactions: one entry per description
-- (normalised), from its latest use, with how often it's used. Transfers are listed from the side
-- money leaves, with the account it goes to.
create or replace function description_index() returns jsonb
language sql stable as $$
  with t as (
    select * from transactions
    where user_id = auth.uid() and kind is distinct from 'opening' and description <> ''
  ),
  incoming as (
    select distinct on (transfer_id) transfer_id, account_id from t
    where transfer_id is not null and amount > 0
    order by transfer_id, id
  ),
  uses as (
    select fin_norm(t.description) as key, t.description, t.date, t.amount, t.id,
      case when t.transfer_id is not null then 'transfer' else t.kind end as kind,
      case when t.transfer_id is not null then '{}'::text[] else fin_cats(t.category_ids, t.category_id) end as cats,
      t.account_id, i.account_id as to_account_id
    from t left join incoming i on i.transfer_id = t.transfer_id
    where t.transfer_id is null or (t.amount < 0 and i.account_id is not null)
  ),
  latest as (
    select distinct on (key) key, count(*) over (partition by key) as n, description, date, amount, kind, cats, account_id, to_account_id
    from uses
    order by key, date desc, id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', key, 'count', n, 'description', description, 'lastDate', date, 'amount', amount, 'kind', kind,
    'categoryIds', to_jsonb(cats), 'accountId', account_id, 'toAccountId', to_account_id)), '[]'::jsonb)
  from latest
$$;

-- Uncategorised transactions (not transfers) with this description (normalised): the ones a new
-- rule could fill in.
create or replace function same_description_uncategorized(p_key text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(tr) - 'user_id'), '[]'::jsonb)
  from transactions tr
  where tr.user_id = auth.uid() and tr.transfer_id is null
    and cardinality(fin_cats(tr.category_ids, tr.category_id)) = 0
    and fin_norm(tr.description) = p_key
$$;

-- Payments that may repeat: transactions from p_since to p_today grouped by account, description
-- (normalised) and direction, with their dates and amounts oldest first, for groups of p_min or more
-- (three; two finds yearly subscriptions). Transfers and special kinds are left out. The app decides
-- which look regular (model.js suggestSchedules and findSubscriptions; recurringGroups gives the same groups).
drop function if exists recurring_candidates(date, date);
create or replace function recurring_candidates(p_since date, p_today date, p_min int default 3) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'accountId', account_id, 'key', key, 'sign', sign, 'description', description,
    'categoryIds', cats, 'dates', dates, 'amounts', amounts)), '[]'::jsonb)
  from (
    select account_id, fin_norm(description) as key, sign(amount)::int as sign,
      (array_agg(description order by date desc, id desc))[1] as description,
      (jsonb_agg(to_jsonb(fin_cats(category_ids, category_id)) order by date desc, id desc)) -> 0 as cats,
      jsonb_agg(date order by date, id) as dates,
      jsonb_agg(amount order by date, id) as amounts
    from transactions
    where user_id = auth.uid() and transfer_id is null and kind is null and amount <> 0
      and trim(description) <> '' and date between p_since and p_today
    group by account_id, fin_norm(description), sign(amount)
    having count(*) >= p_min
  ) g
$$;

do $$
declare t text;
begin
  foreach t in array array['accounts', 'categories', 'rules', 'transactions', 'holdings', 'schedules', 'people', 'ious', 'snapshots', 'lots', 'settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists own_rows on %I', t);
    execute format(
      'create policy own_rows on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;
