-- Keeps subscription_transactions current from Superwall (it started as a
-- one-time backfill — see subscription_revenue.sql).
--
-- The superwall-tx-sync edge function re-pulls every Superwall transaction
-- since 2026-03-01 from ClickHouse (open_revenue.attributed_events_by_ts_rep),
-- deduped the same way as the original backfill, and hands the rows to
-- sync_subscription_transactions() below, which upserts on (transaction_id, event).
-- A full re-pull rather than "since last run" because events land late: a
-- revenue_cat or store copy can arrive weeks after purchasedAt (p99 ~10 days,
-- max 86), and the store copy must win the dedupe whenever it shows up.
-- It's ~6k rows and a sub-second query.
--
-- pg_cron calls the function every 3 hours. Every run is logged in
-- subscription_sync_runs; the function also refuses to run more than once per
-- 20 minutes, so its public URL can't be used to hammer Superwall.
-- Idempotent — safe to re-run.

create table if not exists public.subscription_sync_runs (
  id               bigint generated always as identity primary key,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  rows_received    int,
  rows_upserted    int,
  newest_purchase  timestamptz,
  unknown_products text[],          -- product ids not in subscription_products (excluded from coverage until added)
  error            text
);
alter table public.subscription_sync_runs enable row level security;

-- p_rows: JSON array of arrays, one per transaction, in this column order:
--   [transaction_id, event, original_transaction_id, app_user_id, platform ('i'|'a'),
--    product_id, period_type, is_trial_conversion, price_usd, proceeds_usd,
--    currency, price_local, country, purchased_at (unix seconds), source ('asc'|'gp'|'rc')]
-- Empty strings mean null. Service role only.
create or replace function public.sync_subscription_transactions(p_rows jsonb)
returns json
language sql volatile security definer set search_path = public as $$
  with r as (
    select x->>0 as tx, x->>1 as ev, nullif(x->>2, '') as otx, nullif(x->>3, '') as uid,
           case x->>4 when 'i' then 'ios' else 'android' end as platform,
           nullif(x->>5, '') as prod, nullif(x->>6, '') as pt,
           case lower(x->>7) when 'true' then true when '1' then true when 'false' then false when '0' then false end as conv,
           nullif(x->>8, '')::numeric as price, nullif(x->>9, '')::numeric as proceeds,
           nullif(x->>10, '') as cur, nullif(x->>11, '')::numeric as loc, nullif(x->>12, '') as cc,
           to_timestamp((x->>13)::bigint) as ts,
           case x->>14 when 'asc' then 'app_store_connect' when 'gp' then 'google_play' else 'revenue_cat' end as src
    from jsonb_array_elements(p_rows) x
  ), up as (
    insert into subscription_transactions as t (
      transaction_id, event, original_transaction_id, app_user_id, user_id, platform, product_id,
      period_type, is_trial_conversion, price_usd, proceeds_usd, currency, price_local, country,
      purchased_at, source_integration)
    select tx, ev, otx, uid,
           case when uid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then uid::uuid end,
           platform, prod, pt, conv, price, proceeds, cur, loc, cc, ts, src
    from r
    on conflict (transaction_id, event) do update set
      original_transaction_id = excluded.original_transaction_id,
      app_user_id             = excluded.app_user_id,
      user_id                 = excluded.user_id,
      platform                = excluded.platform,
      product_id              = excluded.product_id,
      period_type             = excluded.period_type,
      is_trial_conversion     = excluded.is_trial_conversion,
      price_usd               = excluded.price_usd,
      proceeds_usd            = excluded.proceeds_usd,
      currency                = excluded.currency,
      price_local             = excluded.price_local,
      country                 = excluded.country,
      purchased_at            = excluded.purchased_at,
      source_integration      = excluded.source_integration
    where (t.*) is distinct from (excluded.*)
    returning 1
  )
  select json_build_object(
    'received', (select count(*) from r),
    'upserted', (select count(*) from up),
    'newest_purchase', (select max(ts) from r),
    'unknown_products', (select json_agg(distinct prod) from r
                         where prod is not null
                           and not exists (select 1 from subscription_products p where p.product_id = r.prod)));
$$;

revoke all on function public.sync_subscription_transactions(jsonb) from public, anon, authenticated;
grant execute on function public.sync_subscription_transactions(jsonb) to service_role;

-- When the data was last refreshed, for the Revenue page.
create or replace function public.subscription_sync_status()
returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'last_success_at', (select max(finished_at) from subscription_sync_runs where error is null and finished_at is not null),
    'last_error',      (select error from subscription_sync_runs order by started_at desc limit 1),
    'newest_purchase', (select max(purchased_at) from subscription_transactions));
$$;
revoke all on function public.subscription_sync_status() from public, anon;
grant execute on function public.subscription_sync_status() to authenticated;

-- Every 3 hours. The function has verify_jwt off and its own 20-minute throttle.
select cron.unschedule('superwall-tx-sync') where exists (select 1 from cron.job where jobname = 'superwall-tx-sync');
select cron.schedule('superwall-tx-sync', '7 */3 * * *', $cron$
  select net.http_post(
    url := 'https://hngvsvjujxunowfwqzet.supabase.co/functions/v1/superwall-tx-sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$cron$);

notify pgrst, 'reload schema';
