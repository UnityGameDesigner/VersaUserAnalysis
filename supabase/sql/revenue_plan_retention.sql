-- RPC behind the Revenue page's "Plan retention" tab (src/PlanRetention.tsx):
-- how well each plan keeps the people who start on it.
--
-- Unit = one store subscription, keyed by original_transaction_id (renewals and
-- trial conversions carry the id of the purchase that started them). A
-- subscription belongs to the plan it STARTED on (a trial or first purchase on
-- or after the 2026-03-01 backfill start); subscriptions that began before then
-- only show up as renewals and are left out, so every cohort is complete.
-- Works for anonymous buyers too — only the engagement columns need a user_id.
--
-- Everything is returned as counts so the page can roll plans up into plan
-- lengths and compute rates itself. "Eligible" counts only subscriptions old
-- enough to have had the chance (e.g. a monthly bought 10 days ago isn't in the
-- renewal-1 denominator yet). as_of = newest transaction - 3 days, same as the
-- other revenue RPCs, so a renewal that's merely late isn't read as churn.
--
-- Coverage per payment = [purchased_at, purchased_at + plan length), cut short
-- by a refund of that payment. "Paying after N months" (m1..m6) = coverage
-- reaches more than 3 days past first payment + N months — comparable across
-- plan lengths (for a monthly plan m1 = renewal 1; a 3-month plan only faces
-- its first renewal at m3).
-- Idempotent — safe to re-run.

create or replace function public.revenue_plan_retention(p_platform text default null)
returns json
language sql stable security definer set search_path = public as $$
  with as_of as (
    select max(purchased_at)::date - 3 as d from subscription_transactions
  ), t as (
    select st.*, coalesce(st.original_transaction_id, st.transaction_id) as chain
    from subscription_transactions st
    where p_platform is null or st.platform = p_platform
  ), starts as (
    -- First event of each chain; keep chains that start inside the data window.
    select distinct on (chain) chain, event as start_event, product_id, platform, purchased_at as started_at
    from t where event in ('trial_start', 'initial_purchase', 'renewal')
    order by chain, purchased_at, (event = 'renewal')
  ), chains as (
    select s.*, sp.trial_days,
           case sp.period when 'week' then interval '1 week' when 'month' then interval '1 month'
                          when 'year' then interval '1 year' end * sp.period_count as len
    from starts s
    join subscription_products sp on sp.product_id = s.product_id
    where s.start_event <> 'renewal'
  ), pay as (
    select p.chain,
           count(*) as payments,
           min(p.purchased_at) as first_paid_at,
           sum(p.price_usd) as gross,
           max(least(p.purchased_at + c.len, coalesce(r.purchased_at, 'infinity'))) as covered_to
    from t p
    join chains c on c.chain = p.chain
    left join t r on r.transaction_id = p.transaction_id and r.event = 'refund'
    where p.event in ('initial_purchase', 'renewal', 'non_renewing_purchase') and p.price_usd > 0
    group by p.chain
  ), money as (
    select chain, sum(proceeds_usd) as net, bool_or(event = 'refund') as refunded,
           (array_agg(user_id) filter (where user_id is not null))[1] as user_id
    from t where chain in (select chain from chains)
    group by chain
  ), sub as (
    select c.chain, c.product_id, c.platform, c.start_event, c.started_at, c.trial_days, c.len,
           p.payments, p.first_paid_at, p.gross, p.covered_to, m.net, m.refunded, m.user_id
    from chains c
    left join pay p on p.chain = c.chain
    left join money m on m.chain = c.chain
  ), eng as (
    -- Distinct days with a lesson in the first 7 / 14 / 30 days after the first
    -- payment. Each window only counts subscriptions at least that old, so a
    -- new plan shows its 7- and 14-day numbers long before it has 30 days.
    select s.chain, s.first_paid_at <= now() - interval '14 days' as e14,
           s.first_paid_at <= now() - interval '30 days' as e30, x.*
    from sub s
    cross join lateral (
      select count(distinct (cl.created_at at time zone 'UTC')::date)
               filter (where cl.created_at < s.first_paid_at + interval '7 days')::int as days7,
             count(distinct (cl.created_at at time zone 'UTC')::date)
               filter (where cl.created_at < s.first_paid_at + interval '14 days')::int as days14,
             count(distinct (cl.created_at at time zone 'UTC')::date)::int as days
      from completed_lessons cl
      where cl.user_id = s.user_id
        and cl.created_at >= s.first_paid_at and cl.created_at < s.first_paid_at + interval '30 days'
        and cl.lesson_id is distinct from 42
    ) x
    where s.user_id is not null and s.first_paid_at <= now() - interval '7 days'
  ), per_plan as (
    select s.product_id,
           (array_agg(s.platform))[1] as platform,
           count(*) filter (where s.start_event = 'trial_start') as trials,
           count(*) filter (where s.start_event = 'trial_start'
                              and s.started_at::date + coalesce(s.trial_days, 3) + 1 <= a.d) as trials_resolved,
           count(*) filter (where s.start_event = 'trial_start'
                              and s.started_at::date + coalesce(s.trial_days, 3) + 1 <= a.d
                              and s.payments > 0) as trials_converted,
           count(*) filter (where s.payments > 0) as subscribers,
           count(*) filter (where s.payments > 0 and (s.first_paid_at + s.len)::date + 3 <= a.d) as r1_elig,
           count(*) filter (where s.payments > 0 and (s.first_paid_at + s.len)::date + 3 <= a.d and s.payments >= 2) as r1_kept,
           count(*) filter (where s.payments >= 2 and (s.first_paid_at + 2 * s.len)::date + 3 <= a.d) as r2_elig,
           count(*) filter (where s.payments >= 2 and (s.first_paid_at + 2 * s.len)::date + 3 <= a.d and s.payments >= 3) as r2_kept,
           count(*) filter (where s.payments > 0 and (s.first_paid_at + interval '1 month')::date + 3 <= a.d) as m1_elig,
           count(*) filter (where s.payments > 0 and (s.first_paid_at + interval '1 month')::date + 3 <= a.d
                              and s.covered_to > s.first_paid_at + interval '1 month' + interval '3 days') as m1_kept,
           count(*) filter (where s.payments > 0 and (s.first_paid_at + interval '2 month')::date + 3 <= a.d) as m2_elig,
           count(*) filter (where s.payments > 0 and (s.first_paid_at + interval '2 month')::date + 3 <= a.d
                              and s.covered_to > s.first_paid_at + interval '2 month' + interval '3 days') as m2_kept,
           count(*) filter (where s.payments > 0 and (s.first_paid_at + interval '3 month')::date + 3 <= a.d) as m3_elig,
           count(*) filter (where s.payments > 0 and (s.first_paid_at + interval '3 month')::date + 3 <= a.d
                              and s.covered_to > s.first_paid_at + interval '3 month' + interval '3 days') as m3_kept,
           count(*) filter (where s.payments > 0 and (s.first_paid_at + interval '6 month')::date + 3 <= a.d) as m6_elig,
           count(*) filter (where s.payments > 0 and (s.first_paid_at + interval '6 month')::date + 3 <= a.d
                              and s.covered_to > s.first_paid_at + interval '6 month' + interval '3 days') as m6_kept,
           count(*) filter (where s.payments > 0 and s.covered_to::date > a.d) as active_now,
           count(*) filter (where s.payments > 0 and s.refunded) as refunded,
           coalesce(sum(s.payments), 0) as payments,
           coalesce(sum(s.gross), 0) as gross,
           coalesce(sum(s.net) filter (where s.payments > 0), 0) as net,
           coalesce(sum(extract(epoch from least(s.covered_to, a.d::timestamptz) - s.first_paid_at) / 86400)
                    filter (where s.payments > 0), 0) as paid_days,
           -- Months of access bought (including periods not over yet), so a
           -- yearly plan paid upfront isn't priced per elapsed month.
           coalesce(sum(extract(epoch from s.covered_to - s.first_paid_at) / 86400)
                    filter (where s.payments > 0), 0) as bought_days,
           count(e.chain) as eng7_elig,
           coalesce(sum(e.days7), 0) as eng7_days,
           count(*) filter (where e.e14) as eng14_elig,
           coalesce(sum(e.days14) filter (where e.e14), 0) as eng14_days,
           count(*) filter (where e.e14 and e.days14 >= 5) as eng14_regular,   -- 5+ of 14 days
           count(*) filter (where e.e30) as eng_elig,
           coalesce(sum(e.days) filter (where e.e30), 0) as eng_days,
           count(*) filter (where e.e30 and e.days = 0) as eng_zero,
           count(*) filter (where e.e30 and e.days >= 8) as eng_weekly   -- ~2+ days a week
    from sub s
    cross join as_of a
    left join eng e on e.chain = s.chain
    group by s.product_id
  )
  select coalesce(json_agg(json_build_object(
           'product_id', pp.product_id,
           'platform', pp.platform,
           'bucket', plan_bucket(sp.period_months),
           'period_months', sp.period_months,
           'list_price_usd', sp.list_price_usd,
           'trial_days', sp.trial_days,
           'trials', pp.trials, 'trials_resolved', pp.trials_resolved, 'trials_converted', pp.trials_converted,
           'subscribers', pp.subscribers,
           'r1_elig', pp.r1_elig, 'r1_kept', pp.r1_kept,
           'r2_elig', pp.r2_elig, 'r2_kept', pp.r2_kept,
           'm1_elig', pp.m1_elig, 'm1_kept', pp.m1_kept,
           'm2_elig', pp.m2_elig, 'm2_kept', pp.m2_kept,
           'm3_elig', pp.m3_elig, 'm3_kept', pp.m3_kept,
           'm6_elig', pp.m6_elig, 'm6_kept', pp.m6_kept,
           'active_now', pp.active_now,
           'refunded', pp.refunded,
           'payments', pp.payments,
           'gross', round(pp.gross, 2),
           'net', round(pp.net, 2),
           'paid_days', round(pp.paid_days),
           'bought_days', round(pp.bought_days),
           'eng7_elig', pp.eng7_elig, 'eng7_days', pp.eng7_days,
           'eng14_elig', pp.eng14_elig, 'eng14_days', pp.eng14_days, 'eng14_regular', pp.eng14_regular,
           'eng_elig', pp.eng_elig, 'eng_days', pp.eng_days, 'eng_zero', pp.eng_zero, 'eng_weekly', pp.eng_weekly,
           'as_of', (select d from as_of)
         ) order by pp.subscribers desc), '[]'::json)
  from per_plan pp
  join subscription_products sp on sp.product_id = pp.product_id;
$$;

revoke all on function public.revenue_plan_retention(text) from public, anon;
grant execute on function public.revenue_plan_retention(text) to authenticated;

notify pgrst, 'reload schema';
