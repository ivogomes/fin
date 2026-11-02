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
