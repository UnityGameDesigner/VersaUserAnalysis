-- RPCs behind the Revenue tab (src/Revenue.tsx). Read from the tables in
-- subscription_revenue.sql (backfilled from Superwall, purchases since 2026-03-01).
--
-- p_platform: 'ios' | 'android' | null (both).
-- "Paid" = initial_purchase / renewal / non_renewing_purchase with price > 0.
-- Money totals include transactions whose buyer was never identified (user_id
-- null) — that revenue is real even though it can't be attached to a user.
--
-- SECURITY DEFINER so the single-admin dashboard (anon key) can read the
-- RLS-protected tables. Read-only. Idempotent — safe to re-run.

create or replace function public.plan_bucket(p_period_months numeric)
returns text language sql immutable as $$
  select case
    when p_period_months is null then 'One-off'
    when p_period_months < 1 then 'Weekly'
    when p_period_months = 1 then 'Monthly'
    when p_period_months < 12 then '3-month'
    else 'Yearly'
  end;
$$;

-- Revenue per calendar month, split by plan length.
create or replace function public.revenue_monthly(p_platform text default null)
returns table (month date, bucket text, gross numeric, net numeric, refunds numeric, payments int)
language sql stable security definer set search_path = public as $$
  select date_trunc('month', st.purchased_at)::date,
         plan_bucket(sp.period_months),
         coalesce(sum(st.price_usd) filter (where st.event <> 'refund'), 0),
         coalesce(sum(st.proceeds_usd), 0),
         coalesce(sum(st.price_usd) filter (where st.event = 'refund'), 0),
         (count(*) filter (where st.event <> 'refund'))::int
  from subscription_transactions st
  left join subscription_products sp on sp.product_id = st.product_id
  where (st.event = 'refund' or (st.event <> 'trial_start' and st.price_usd > 0))
    and (p_platform is null or st.platform = p_platform)
  group by 1, 2
  order by 1, 2;
$$;

-- One row per plan. Trial conversion counts only trials started 10+ days ago
-- (every trial is <= 7 days, so those have resolved) and only identified users;
-- converted = the same user has any paid transaction after the trial started.
create or replace function public.revenue_by_plan(p_platform text default null)
returns table (
  product_id text, platform text, bucket text, list_price_usd numeric, trial_days int,
  trial_starts int, trials_resolved int, trial_conversions int,
  first_purchases int, renewals int, payers int, gross numeric, net numeric, refunds numeric
)
language sql stable security definer set search_path = public as $$
  with t as (
    select st.* from subscription_transactions st
    where p_platform is null or st.platform = p_platform
  ), trials as (
    select tr.product_id,
           count(*) as starts,
           count(*) filter (where tr.user_id is not null and tr.purchased_at < now() - interval '10 days') as resolved,
           count(*) filter (where tr.user_id is not null and tr.purchased_at < now() - interval '10 days'
             and exists (select 1 from subscription_transactions p
                         where p.user_id = tr.user_id and p.price_usd > 0
                           and p.event in ('initial_purchase', 'renewal')
                           and p.purchased_at > tr.purchased_at)) as converted
    from t tr where tr.event = 'trial_start'
    group by tr.product_id
  ), money as (
    select product_id,
           count(*) filter (where event = 'initial_purchase' and price_usd > 0) as firsts,
           count(*) filter (where event = 'renewal' and price_usd > 0) as renewals,
           count(distinct user_id) filter (where event <> 'refund' and event <> 'trial_start' and price_usd > 0) as payers,
           coalesce(sum(price_usd) filter (where event <> 'refund' and event <> 'trial_start'), 0) as gross,
           coalesce(sum(proceeds_usd) filter (where event <> 'trial_start'), 0) as net,
           coalesce(sum(price_usd) filter (where event = 'refund'), 0) as refunds
    from t group by product_id
  )
  select sp.product_id, sp.platform, plan_bucket(sp.period_months), sp.list_price_usd, sp.trial_days,
         coalesce(tr.starts, 0)::int, coalesce(tr.resolved, 0)::int, coalesce(tr.converted, 0)::int,
         coalesce(m.firsts, 0)::int, coalesce(m.renewals, 0)::int, coalesce(m.payers, 0)::int,
         coalesce(m.gross, 0), coalesce(m.net, 0), coalesce(m.refunds, 0)
  from subscription_products sp
  left join trials tr on tr.product_id = sp.product_id
  left join money m on m.product_id = sp.product_id
  where coalesce(tr.starts, 0) + coalesce(m.firsts, 0) + coalesce(m.renewals, 0) > 0
     or coalesce(m.gross, 0) > 0
  order by coalesce(m.gross, 0) desc;
$$;

-- Identified users with any plan activity, highest gross first.
create or replace function public.revenue_users(p_platform text default null, p_limit int default 500)
returns table (
  user_id uuid, preferred_name text, payment_status text, platform text,
  trial_product_id text, first_paid_product_id text, current_product_id text, current_bucket text,
  payments int, gross numeric, net numeric, refunds numeric,
  first_paid_at timestamptz, last_paid_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select ur.user_id, ui.preferred_name, ui.payment_status, ur.platform,
         ur.trial_product_id, ur.first_paid_product_id, ur.current_product_id,
         plan_bucket(ur.current_period_months),
         ur.payments, ur.gross_usd, ur.net_usd, ur.refunds_usd,
         ur.first_paid_at, ur.last_paid_at
  from user_revenue ur
  left join user_info ui on ui.user_id = ur.user_id
  where p_platform is null or ur.platform = p_platform
  order by ur.gross_usd desc, ur.last_paid_at desc nulls last, ur.user_id  -- total order: the client pages this
  limit p_limit;
$$;
