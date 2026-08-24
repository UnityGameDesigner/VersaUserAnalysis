-- trial_retention_trend(window_days, gran, trial_only)
--
-- Retention trend by signup cohort, to see whether product changes are moving
-- how long trial users stick around.
--
-- Cohort anchor = a user's FIRST completed lesson (their first app usage), since
-- the DB has no reliable trial-start timestamp (Superwall runs trials; user_info
-- has no signup date; user_account_info is a stale 1.3k-row table ending
-- Apr-2025; user_metadata.trial_start is sparse).
--
-- trial_only (default true): restrict the cohort universe to users who ever
-- entered the trial/subscription funnel — current user_info.payment_status in
-- (TRIAL, ACTIVE, CANCELED, PAST_DUE, EXPIRED), ~2.9k users. This is the honest
-- "trial retention" population. With trial_only = false the cohort is EVERY user
-- with a lesson (~178k), i.e. whole-funnel engagement retention — that view is
-- dominated by free users who never started a trial (only ~1.5% of app-starters
-- ever reach the trial funnel), so their retention masks the trial signal.
-- Note: "TRIAL" is never written to completed_lessons.payment_status, so the
-- funnel set must come from user_info.payment_status, not the per-lesson snapshot.
--
-- Per cohort, within each user's first `window_days` days:
--   users         — cohort size (only users whose full window has elapsed)
--   median_active — median distinct active days
--   ge_counts[k]  — # users with >= k distinct active days, for k = 1..window_days
-- The client derives every metric from ge_counts (avg = sum/users; return rate =
-- ge_counts[2]/users; reached-≥N = ge_counts[N]/users) so only window/gran/
-- trial_only re-query.
--
-- Right-censoring: a user is counted only if first_at < now() - window_days, so
-- every counted user has a complete window (the newest cohort is thus smaller).
--
-- Supports gran = 'month' | 'week' | 'day'. The histogram CTE keeps daily
-- (~500 cohorts) ~1.3s — a naive per_user x window cross join + correlated
-- array_agg times out on the anon role. statement_timeout is raised per-function.

drop function if exists public.trial_retention_trend(int, text);

create or replace function public.trial_retention_trend(
  window_days int default 14,
  gran text default 'month',
  trial_only boolean default true
)
returns table(cohort date, users int, median_active numeric, ge_counts int[])
language sql stable as $$
  with firsts as (
    select cl.user_id, min(cl.created_at) as first_at
    from completed_lessons cl
    where (not trial_only) or exists (
      select 1 from user_info u
      where u.user_id = cl.user_id
        and u.payment_status in ('TRIAL','ACTIVE','CANCELED','PAST_DUE','EXPIRED')
    )
    group by cl.user_id
  ),
  per_user as (
    select date_trunc(gran, f.first_at)::date as cohort,
      count(distinct ((cl.created_at at time zone 'UTC')::date)) as active_days
    from firsts f
    join completed_lessons cl
      on cl.user_id = f.user_id
     and cl.created_at >= f.first_at
     and cl.created_at < f.first_at + make_interval(days => window_days)
    where f.first_at >= '2025-01-01'
      and f.first_at < (now() - make_interval(days => window_days))
    group by f.user_id, date_trunc(gran, f.first_at)
  ),
  hist as (   -- at most (cohorts x window) rows, not (users x window)
    select cohort, active_days, count(*)::int as c
    from per_user group by cohort, active_days
  ),
  ge as (
    select h.cohort, k.k,
      coalesce(sum(h.c) filter (where h.active_days >= k.k), 0)::int as c
    from hist h cross join generate_series(1, window_days) as k(k)
    group by h.cohort, k.k
  ),
  ge_arr as (
    select cohort, array_agg(c order by k) as ge_counts from ge group by cohort
  ),
  stats as (
    select cohort, count(*)::int as users,
      percentile_cont(0.5) within group (order by active_days) as median_active
    from per_user group by cohort
  )
  select s.cohort, s.users, s.median_active, a.ge_counts
  from stats s join ge_arr a using (cohort)
  order by s.cohort;
$$;

alter function public.trial_retention_trend(int, text, boolean) set statement_timeout = '20s';
grant execute on function public.trial_retention_trend(int, text, boolean) to anon;
