-- trial_conversion_trend(gran)
--
-- Trial -> paid conversion by cohort, using the trial_started_at / became_active_at
-- pair now populated on user_info (backfilled from Superwall revenue events +
-- maintained forward by the superwall-webhook edge function).
--
-- Cohort = month/week/day of trial_started_at. A trial "converted" if the user
-- also has a became_active_at at/after their trial start. Returns per cohort:
--   trial_starts, conversions, conv_rate (%), median_days (to convert).
--
-- Censoring: cohorts whose trial_started_at is within the last 14 days are
-- excluded so a not-yet-finished 7-day trial can't depress the rate.
--
-- Coverage caveat: trial_started_at only exists for users whose Superwall
-- app_user_id was their auth uuid (identify() had run). During the ~Mar–Jun 2026
-- window when identify() was disabled (the unmapped-purchases bug) those trials
-- were anonymous and are absent here, so those cohorts are sparse/missing.

create or replace function public.trial_conversion_trend(gran text default 'month')
returns table(cohort date, trial_starts int, conversions int, conv_rate numeric, median_days numeric)
language sql stable as $$
  with base as (
    select
      date_trunc(gran, trial_started_at)::date as cohort,
      trial_started_at,
      case when became_active_at is not null and became_active_at >= trial_started_at
           then became_active_at end as converted_at
    from user_info
    where trial_started_at is not null
      and trial_started_at < (now() - interval '14 days')
  )
  select cohort,
    count(*)::int as trial_starts,
    count(converted_at)::int as conversions,
    round(100.0 * count(converted_at) / nullif(count(*),0), 1) as conv_rate,
    round(percentile_cont(0.5) within group (
      order by extract(epoch from (converted_at - trial_started_at))/86400.0
    ) filter (where converted_at is not null)::numeric, 2) as median_days
  from base group by cohort order by cohort;
$$;

grant execute on function public.trial_conversion_trend(text) to anon;
