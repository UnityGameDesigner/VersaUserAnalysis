-- trial_daily_activity(start_date, end_date)
--
-- Per-DAY trial-cohort engagement for a date range (default: last 20 days). For
-- users who started a trial on each day, how many distinct days they were active
-- within their 7-day trial window. Powers the Trial Retention tab's "Per day" view.
--
-- Returns per day:
--   trials, avg_active, median_active, max_active,
--   partial  — true if the day's 7-day window hasn't fully elapsed (counts "so far"),
--   hist     — int[8] where hist[k] = # users with EXACTLY k active days (k = 0..7,
--              capped at 7). Non-overlapping, so a 4-day user is only in hist[4].
--
-- No min-cohort filter or censoring (daily trial volume is only ~5-20/day); recent
-- days are shown but flagged partial. Coverage caveat: trials from the
-- identify()-disabled window (~Mar-Jun 2026) are anonymous and absent, so a range
-- in that window is near-empty.

drop function if exists public.trial_daily_activity(int);

create or replace function public.trial_daily_activity(start_date date default null, end_date date default null)
returns table(d date, trials int, avg_active numeric, median_active numeric, max_active int, partial boolean, hist int[])
language sql stable as $$
  with t as (
    select user_id, (trial_started_at at time zone 'UTC')::date as d, trial_started_at
    from user_info
    where trial_started_at is not null
      and (trial_started_at at time zone 'UTC')::date >= coalesce(start_date, (now() - interval '20 days')::date)
      and (trial_started_at at time zone 'UTC')::date <= coalesce(end_date, (now())::date)
  ),
  a as (
    select t.d, t.user_id,
      least(count(distinct (cl.created_at at time zone 'UTC')::date) filter (
        where cl.created_at >= t.trial_started_at
          and cl.created_at < t.trial_started_at + interval '7 days'
      ), 7) as active_days
    from t
    left join completed_lessons cl on cl.user_id = t.user_id
    group by t.d, t.user_id
  ),
  hist as (
    select a.d, k.k, count(*) filter (where a.active_days = k.k) as c
    from a cross join generate_series(0, 7) as k(k)
    group by a.d, k.k
  ),
  harr as (select d, array_agg(c order by k) as hist from hist group by d),
  stats as (
    select d, count(*)::int as trials,
      round(avg(active_days), 2) as avg_active,
      round(percentile_cont(0.5) within group (order by active_days)::numeric, 1) as median_active,
      max(active_days)::int as max_active,
      (d + interval '7 days' > now()) as partial
    from a group by d
  )
  select s.d, s.trials, s.avg_active, s.median_active, s.max_active, s.partial, h.hist
  from stats s join harr h using (d) order by s.d;
$$;

grant execute on function public.trial_daily_activity(date, date) to anon;
