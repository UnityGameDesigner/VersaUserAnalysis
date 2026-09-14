-- trial_day_users(day)
--
-- The users who started a trial on a specific day (UTC date of trial_started_at),
-- with their trial-window engagement (distinct active days + total lessons in the
-- 7-day window), device platform, and the demographic fields the conversion
-- scorecard (src/lib/conversionScore) needs to compute a likelihood-to-convert
-- tier client-side. Powers the click-through from a bar in the Trial Retention
-- "Per day" view.
--
-- Performance: the day filter uses idx_user_info_trial_start_date and the per-user
-- lesson aggregation is a LATERAL subquery that hits idx_completed_lessons_user_created
-- (see supabase/sql/perf_indexes.sql) — so it reads only the matched day's ~10-25
-- users and only their lessons, instead of the old plan that seq-scanned the entire
-- 1.1 GB completed_lessons table on every click (~11s). count(*) is used inside the
-- lateral (not count(cl.*)) so the wide lesson rows are never materialised.

drop function if exists public.trial_day_users(date);

create or replace function public.trial_day_users(day date)
returns table(
  user_id uuid,
  preferred_name text,
  learning_language text,
  payment_status text,
  age text,
  time_zone text,
  trial_started_at timestamptz,
  became_active_at timestamptz,
  canceled_from text,
  active_days int,
  lessons int,
  post_trial_lessons int,
  platform text,
  gender text,
  native_language text,
  level text,
  reason text,
  demand_tier text,
  messaging_platform text,
  tutor text,
  completed_tutorial boolean,
  previous_experience text,
  attribution text
)
language sql stable as $$
  select u.user_id, u.preferred_name, u.learning_language, u.payment_status, u.age::text, u.time_zone,
    u.trial_started_at, u.became_active_at, u.canceled_from,
    agg.active_days, agg.lessons, agg.post_trial_lessons,
    u.platform, u.gender, u.native_language, u.level, u.reason, u.demand_tier,
    u.messaging_platform, u.tutor, u.completed_tutorial, u.previous_experience, u.attribution
  from user_info u
  left join lateral (
    select
      least(count(distinct (cl.created_at at time zone 'UTC')::date) filter (
        where cl.created_at >= u.trial_started_at
          and cl.created_at < u.trial_started_at + interval '7 days'
      ), 7)::int as active_days,
      count(*) filter (
        where cl.created_at >= u.trial_started_at
          and cl.created_at < u.trial_started_at + interval '7 days'
      )::int as lessons,
      -- lessons after the 7-day trial ended: proof of paid access, so a trial with
      -- post_trial_lessons > 0 but no became_active_at converted-but-untracked
      -- (common on Android, which doesn't send billing events).
      count(*) filter (
        where cl.created_at > u.trial_started_at + interval '8 days'
      )::int as post_trial_lessons
    from completed_lessons cl
    where cl.user_id = u.user_id
  ) agg on true
  where u.trial_started_at is not null
    and (u.trial_started_at at time zone 'UTC')::date = day
  order by agg.active_days desc, u.preferred_name;
$$;

grant execute on function public.trial_day_users(date) to anon, authenticated;
