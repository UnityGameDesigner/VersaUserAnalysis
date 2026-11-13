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
  error            text,
  audiences_upserted int,           -- superwall_audiences rows refreshed this run
  audience_error   text,            -- the audience refresh failing doesn't fail the run
  billing_issues_upserted int,      -- subscription_billing_issues rows changed this run
  billing_issue_error text          -- the billing-issue pull failing doesn't fail the run
);
alter table public.subscription_sync_runs
  add column if not exists audiences_upserted int,
  add column if not exists audience_error text,
  add column if not exists billing_issues_upserted int,
  add column if not exists billing_issue_error text;
alter table public.subscription_sync_runs enable row level security;

-- Names for subscription_transactions.experiment_id: Superwall's "experiment"
-- is a campaign audience. Seeded 2026-11-12 from Superwall's campaign list
-- (live and archived) and refreshed by superwall-tx-sync when its API key has
-- the campaigns:read scope. Audiences deleted from a campaign can't be listed,
-- so ~35% of attributed purchases have an experiment_id with no row here.
create table if not exists public.superwall_audiences (
  experiment_id     int primary key,
  platform          text not null,     -- 'ios' | 'android'
  campaign_id       int not null,
  campaign_name     text,
  audience_name     text,              -- null when the audience was never named
  campaign_archived boolean not null default false,
  updated_at        timestamptz not null default now()
);
alter table public.superwall_audiences enable row level security;

-- p_rows: JSON array of [experiment_id, platform, campaign_id, campaign_name,
-- audience_name, campaign_archived]. Service role only.
create or replace function public.sync_superwall_audiences(p_rows jsonb)
returns int
language sql volatile security definer set search_path = public as $$
  with up as (
    insert into superwall_audiences as a (experiment_id, platform, campaign_id, campaign_name, audience_name, campaign_archived)
    select (x->>0)::int, x->>1, (x->>2)::int, nullif(x->>3, ''), nullif(x->>4, ''), coalesce((x->>5)::boolean, false)
    from jsonb_array_elements(p_rows) x
    on conflict (experiment_id) do update set
      platform = excluded.platform, campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name,
      audience_name = excluded.audience_name, campaign_archived = excluded.campaign_archived, updated_at = now()
    where (a.platform, a.campaign_id, a.campaign_name, a.audience_name, a.campaign_archived)
          is distinct from (excluded.platform, excluded.campaign_id, excluded.campaign_name, excluded.audience_name, excluded.campaign_archived)
    returning 1
  )
  select count(*)::int from up;
$$;
revoke all on function public.sync_superwall_audiences(jsonb) from public, anon, authenticated;
grant execute on function public.sync_superwall_audiences(jsonb) to service_role;

-- p_rows: JSON array of arrays, one per transaction, in this column order:
--   [transaction_id, event, original_transaction_id, app_user_id, platform ('i'|'a'),
--    product_id, period_type, is_trial_conversion, price_usd, proceeds_usd,
--    currency, price_local, country, purchased_at (unix seconds), source ('asc'|'gp'|'rc'),
--    paywall_id, paywall_name, placement, experiment_id, variant_id]
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
           case x->>14 when 'asc' then 'app_store_connect' when 'gp' then 'google_play' else 'revenue_cat' end as src,
           nullif(nullif(x->>15, ''), '0')::int as paywall_id, nullif(x->>16, '') as paywall_name,
           nullif(x->>17, '') as placement, nullif(nullif(x->>18, ''), '0')::int as experiment_id,
           nullif(nullif(x->>19, ''), '0')::int as variant_id
    from jsonb_array_elements(p_rows) x
  ), up as (
    insert into subscription_transactions as t (
      transaction_id, event, original_transaction_id, app_user_id, user_id, platform, product_id,
      period_type, is_trial_conversion, price_usd, proceeds_usd, currency, price_local, country,
      purchased_at, source_integration, paywall_id, paywall_name, placement, experiment_id, variant_id)
    select tx, ev, otx, uid,
           case when uid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then uid::uuid end,
           platform, prod, pt, conv, price, proceeds, cur, loc, cc, ts, src,
           paywall_id, paywall_name, placement, experiment_id, variant_id
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
      source_integration      = excluded.source_integration,
      paywall_id              = excluded.paywall_id,
      paywall_name            = excluded.paywall_name,
      placement               = excluded.placement,
      experiment_id           = excluded.experiment_id,
      variant_id              = excluded.variant_id
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

-- p_rows: JSON array of arrays, one per billing issue, in this column order:
--   [transaction_id, original_transaction_id, app_user_id, platform ('i'|'a'),
--    product_id, period_type, country, occurred_at (unix seconds), source ('asc'|'gp'|'rc')]
-- Empty strings mean null. Service role only.
create or replace function public.sync_subscription_billing_issues(p_rows jsonb)
returns int
language sql volatile security definer set search_path = public as $$
  with r as (
    select x->>0 as tx, nullif(x->>1, '') as otx, nullif(x->>2, '') as uid,
           case x->>3 when 'i' then 'ios' else 'android' end as platform,
           nullif(x->>4, '') as prod, nullif(x->>5, '') as pt, nullif(x->>6, '') as cc,
           to_timestamp((x->>7)::bigint) as ts,
           case x->>8 when 'asc' then 'app_store_connect' when 'gp' then 'google_play' else 'revenue_cat' end as src
    from jsonb_array_elements(p_rows) x
  ), up as (
    insert into subscription_billing_issues as b (
      transaction_id, original_transaction_id, app_user_id, user_id, platform, product_id,
      period_type, country, occurred_at, source_integration)
    select tx, otx, uid,
           case when uid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then uid::uuid end,
           platform, prod, pt, cc, ts, src
    from r
    on conflict (transaction_id) do update set
      original_transaction_id = excluded.original_transaction_id,
      app_user_id             = excluded.app_user_id,
      user_id                 = excluded.user_id,
      platform                = excluded.platform,
      product_id              = excluded.product_id,
      period_type             = excluded.period_type,
      country                 = excluded.country,
      occurred_at             = excluded.occurred_at,
      source_integration      = excluded.source_integration
    where (b.*) is distinct from (excluded.*)
    returning 1
  )
  select count(*)::int from up;
$$;
revoke all on function public.sync_subscription_billing_issues(jsonb) from public, anon, authenticated;
grant execute on function public.sync_subscription_billing_issues(jsonb) to service_role;

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
