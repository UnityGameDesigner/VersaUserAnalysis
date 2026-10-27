-- Per-user plan & revenue, sourced from Superwall.
--
-- Supabase never stored WHICH plan a user bought or HOW MUCH they paid: the
-- superwall-webhook only writes payment_status (+ timestamps) and drops the
-- product/price it receives, and Android never reaches the webhook with billing
-- events at all. The authoritative record is Superwall's ClickHouse table
-- open_revenue.attributed_events_by_ts_rep (app 7959 = iOS, 7960 = Android).
--
-- Backfill scope: purchases on/after 2026-03-01.
--
-- Dedupe rule (applied before load): every purchase arrives twice — once from
-- the store integration (app_store_connect / google_play) and once from
-- revenue_cat. One row per (transaction_id, event), preferring the store copy and
-- falling back to revenue_cat only when no store copy exists.
--
--   subscription_products      — catalog from Superwall (period, list price, trial)
--   subscription_transactions  — one row per trial start / payment / refund
--   user_revenue               — per-user rollup (first & current plan, LTV)
--
-- Tables have RLS on with no policies; the dashboard reads through the
-- SECURITY DEFINER RPCs below. Idempotent — safe to re-run.

create table if not exists public.subscription_products (
  product_id      text primary key,      -- normalized: Superwall's ':sw-auto' suffix stripped
  platform        text not null,         -- 'ios' | 'android'
  period          text,                  -- 'week' | 'month' | 'year' (null = consumable)
  period_count    int,
  period_months   numeric,               -- normalized length, for grouping (week = 0.25)
  list_price_usd  numeric(10,2),
  trial_days      int
);

create table if not exists public.subscription_transactions (
  transaction_id          text not null,
  event                   text not null,   -- trial_start | initial_purchase | renewal | non_renewing_purchase | refund
  original_transaction_id text,
  app_user_id             text,            -- as Superwall sent it (may be an anonymous alias)
  user_id                 uuid,            -- set only when app_user_id is an auth uid
  platform                text not null,
  product_id              text,            -- normalized like subscription_products.product_id
  period_type             text,            -- TRIAL | NORMAL | INTRO | ...
  is_trial_conversion     boolean,
  price_usd               numeric(10,2),   -- negative for refunds
  proceeds_usd            numeric(10,2),   -- after store commission / tax
  currency                text,
  price_local             numeric(12,2),
  country                 text,
  purchased_at            timestamptz not null,
  source_integration      text,            -- which copy won the dedupe
  primary key (transaction_id, event)
);

create index if not exists subscription_transactions_user_idx
  on public.subscription_transactions (user_id, purchased_at);

alter table public.subscription_products enable row level security;
alter table public.subscription_transactions enable row level security;

-- Per-user rollup. "Paid" = initial_purchase / renewal / non_renewing_purchase
-- with price > 0; refunds subtract from net. One grouped pass over the table —
-- per-user correlated subqueries here took >10s and hit the statement timeout.
create or replace view public.user_revenue as
with t as (
  select st.*, sp.period_months,
         st.event in ('initial_purchase', 'renewal', 'non_renewing_purchase') and st.price_usd > 0 as paid
  from subscription_transactions st
  left join subscription_products sp on sp.product_id = st.product_id
  where st.user_id is not null
)
select
  user_id,
  (array_agg(platform order by purchased_at desc))[1]                                        as platform,
  (array_agg(product_id order by purchased_at) filter (where event = 'trial_start'))[1]       as trial_product_id,
  (array_agg(product_id order by purchased_at) filter (where paid))[1]                        as first_paid_product_id,
  (array_agg(product_id order by purchased_at desc) filter (where event <> 'refund'))[1]      as current_product_id,
  (array_agg(period_months order by purchased_at desc) filter (where event <> 'refund'))[1]   as current_period_months,
  (count(*) filter (where paid))::int                                                         as payments,
  min(purchased_at) filter (where paid)                                                       as first_paid_at,
  max(purchased_at) filter (where paid)                                                       as last_paid_at,
  coalesce(sum(price_usd) filter (where paid), 0)                                             as gross_usd,
  coalesce(sum(price_usd) filter (where event = 'refund'), 0)                                 as refunds_usd,
  coalesce(sum(proceeds_usd) filter (where paid or event = 'refund'), 0)                      as net_usd
from t
group by user_id;

-- The view reads RLS-protected tables, so expose it only through definer RPCs.
revoke all on public.user_revenue from anon, authenticated;

create or replace function public.get_user_revenue(p_user_id uuid)
returns setof public.user_revenue
language sql stable security definer set search_path = public as $$
  select * from user_revenue where user_id = p_user_id;
$$;

create or replace function public.get_user_transactions(p_user_id uuid)
returns table (
  event text, product_id text, period text, period_count int, period_type text,
  price_usd numeric, proceeds_usd numeric, currency text, price_local numeric,
  purchased_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select st.event, st.product_id, sp.period, sp.period_count, st.period_type,
         st.price_usd, st.proceeds_usd, st.currency, st.price_local, st.purchased_at
  from subscription_transactions st
  left join subscription_products sp on sp.product_id = st.product_id
  where st.user_id = p_user_id
  order by st.purchased_at;
$$;
