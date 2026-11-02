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
alter table settings add column if not exists last_backup_at timestamptz;
alter table settings add column if not exists backup_every integer not null default 7;

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

-- One row per account: balance up to `p_today`, how many transactions, and the ones dated after
-- today (planned: their sum up to `p_until`, and how many there are in all).
create or replace function account_summaries(p_today date, p_until date) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'accountId', account_id, 'balance', balance, 'count', n, 'past', past, 'planned', planned, 'plannedCount', planned_n)), '[]'::jsonb)
  from (
    select account_id,
      coalesce(sum(amount) filter (where date <= p_today), 0) as balance,
      count(*) as n,
      count(*) filter (where date <= p_today) as past,
      coalesce(sum(amount) filter (where date > p_today and date <= p_until), 0) as planned,
      count(*) filter (where date > p_today) as planned_n
    from transactions
    where user_id = auth.uid()
    group by account_id
  ) s
$$;

-- One page of an account's transactions up to today, newest first, each with the account balance
-- right after it (over all of the account's history, so filters don't change it). Also: how many
-- match, every transaction dated after today, and the other side of any transfer on the page.
-- Filters as in the app: p_text (normalised) in the description or memo, or p_amount (cents) as the
-- size; p_category with its subcategories; p_uncategorized; p_type expense/income/refund/transfer;
-- dates; sizes in cents.
create or replace function account_transactions(
  p_account text, p_today date, p_limit int default 100, p_offset int default 0,
  p_text text default null, p_amount bigint default null, p_category text default null,
  p_uncategorized boolean default false, p_type text default null,
  p_from date default null, p_to date default null, p_min bigint default null, p_max bigint default null
) returns jsonb
language sql stable as $$
  with t as (
    select tr.*, fin_cats(tr.category_ids, tr.category_id) as cats,
      sum(tr.amount) over (order by tr.date, tr.id rows unbounded preceding) as balance
    from transactions tr
    where tr.user_id = auth.uid() and tr.account_id = p_account and tr.date <= p_today
  ),
  wanted as (
    select array_agg(id) as ids from categories
    where user_id = auth.uid() and p_category is not null and (id = p_category or parent_id = p_category)
  ),
  f as (
    select t.* from t
    where (p_from is null or date >= p_from) and (p_to is null or date <= p_to)
      and (p_min is null or abs(amount) >= p_min) and (p_max is null or abs(amount) <= p_max)
      and (p_type is null
        or (p_type = 'transfer' and transfer_id is not null)
        or (p_type = 'refund' and kind = 'refund')
        or (p_type = 'expense' and transfer_id is null and kind is distinct from 'refund' and amount < 0)
        or (p_type = 'income' and transfer_id is null and kind is distinct from 'refund' and amount > 0))
      and (not p_uncategorized or (cardinality(cats) = 0 and transfer_id is null))
      and (p_category is null or cats && coalesce((select ids from wanted), array[p_category]))
      and (p_text is null or p_text = ''
        or strpos(fin_norm(description), p_text) > 0 or strpos(fin_norm(memo), p_text) > 0
        or abs(amount) = p_amount)
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
    'rows', coalesce((select jsonb_agg((to_jsonb(page) - 'user_id' - 'cats') order by date desc, id desc) from page), '[]'::jsonb),
    'planned', coalesce((select jsonb_agg(to_jsonb(planned) - 'user_id' order by date, id) from planned), '[]'::jsonb),
    'partners', coalesce((select jsonb_agg(to_jsonb(partners) - 'user_id') from partners), '[]'::jsonb)
  )
$$;

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
