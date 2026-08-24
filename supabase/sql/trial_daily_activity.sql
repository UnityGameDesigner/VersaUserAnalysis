-- trial_daily_activity(days)
--
-- Per-DAY trial-cohort engagement for the last `days` days: for users who
-- started a trial on each day, how many distinct days they were active within
-- their 7-day trial window. Powers the Trial Retention tab's "Per day" view.
--
-- Unlike trial_retention_trend, this has NO min-cohort filter (daily trial volume
-- is only ~5-20/day) and NO censoring — instead each day whose 7-day window has
-- not fully elapsed is flagged `partial = true` (active days counted "so far"),
-- so the most recent ~week is visible but clearly marked in-progress.

create or replace function public.trial_daily_activity(days int default 20)
returns table(d date, trials int, avg_active numeric, median_active numeric, max_active int, partial boolean)
language sql stable as $$
  with t as (
    select user_id, (trial_started_at at time zone 'UTC')::date as d, trial_started_at
    from user_info
    where trial_started_at >= (now() - make_interval(days => days))
  ),
  a as (
    select t.d, t.user_id,
      count(distinct (cl.created_at at time zone 'UTC')::date) filter (
        where cl.created_at >= t.trial_started_at
          and cl.created_at < t.trial_started_at + interval '7 days'
      ) as active_days
    from t
    left join completed_lessons cl on cl.user_id = t.user_id
    group by t.d, t.user_id
  )
  select d,
    count(*)::int as trials,
    round(avg(active_days), 2) as avg_active,
    round(percentile_cont(0.5) within group (order by active_days)::numeric, 1) as median_active,
    max(active_days)::int as max_active,
    (d + interval '7 days' > now()) as partial
  from a group by d order by d;
$$;

grant execute on function public.trial_daily_activity(int) to anon;
