-- trial_retention_trend(window_days, gran, trial_only)
--
-- Retention trend by signup cohort, to see whether product changes are moving
-- how long trial users stick around.
--
-- trial_only (default true): TRIAL VIEW — population = users with a real
-- user_info.trial_started_at (backfilled from Superwall + maintained by the
-- webhook, ~2.3k users), and each cohort is anchored on that ACTUAL trial-start
-- date. Activity is measured in the first `window_days` FROM trial start, so a
-- trial user with no lessons in that window counts as 0 active days (LEFT join).
-- Coverage caveat: trials started while Superwall identify() was disabled
-- (~Mar–Jun 2026) were anonymous and lack trial_started_at, so those cohorts are
-- sparse/missing.
--
-- trial_only = false: ALL-USERS VIEW — anchor = a user's FIRST completed lesson
-- (first app use), every user with a lesson (~178k). Whole-funnel engagement
-- retention, dominated by free users who never started a trial — that view masks
-- the trial signal, so it's the fallback, not the default.
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
  with anchors as (
    -- trial mode: anchor = actual trial start; population = users with a trial start
    select u.user_id, u.trial_started_at as first_at
    from user_info u
    where trial_only and u.trial_started_at is not null
    union all
    -- all mode: anchor = first app use (first completed lesson), every user
    select cl.user_id, min(cl.created_at) as first_at
    from completed_lessons cl
    where not trial_only
    group by cl.user_id
  ),
  per_user as (
    -- LEFT join so a trial user with no lessons in the window counts as 0 active
    -- days. In all-mode the anchor is a lesson, so every user still has >= 1.
    select date_trunc(gran, a.first_at)::date as cohort,
      a.user_id,
      count(distinct ((cl.created_at at time zone 'UTC')::date)) as active_days
    from anchors a
    left join completed_lessons cl
      on cl.user_id = a.user_id
     and cl.created_at >= a.first_at
     and cl.created_at < a.first_at + make_interval(days => window_days)
    where a.first_at >= '2025-01-01'
      and a.first_at < (now() - make_interval(days => window_days))
    group by a.user_id, date_trunc(gran, a.first_at)
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
