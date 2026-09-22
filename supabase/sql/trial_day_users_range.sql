-- trial_day_users_range(start_date, end_date)
--
-- Like trial_day_users(day) but for a whole date RANGE, and it adds the trial-start
-- day per row. The Trial Retention "Per day" view fetches this once for the visible
-- range and aggregates per day CLIENT-SIDE, which lets it segment the per-day
-- retention by any user parameter (country, device, language, age, …) — including
-- country, which is derived from time_zone on the client (no server-side tz mapping).
--
-- Trial volume is low (~5-20/day), so a 20-45 day range is only a few hundred rows.
-- Served by idx_user_info_trial_start_date + idx_completed_lessons_user_created.

drop function if exists public.trial_day_users_range(date, date);

create or replace function public.trial_day_users_range(start_date date default null, end_date date default null)
returns table(
  trial_day date,
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
  select
    (u.trial_started_at at time zone 'UTC')::date as trial_day,
    u.user_id, u.preferred_name, u.learning_language, u.payment_status, u.age::text, u.time_zone,
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
      count(*) filter (
        where cl.created_at > u.trial_started_at + interval '8 days'
      )::int as post_trial_lessons
    from completed_lessons cl
    where cl.user_id = u.user_id
  ) agg on true
  where u.trial_started_at is not null
    and (u.trial_started_at at time zone 'UTC')::date >= coalesce(start_date, (now() - interval '20 days')::date)
    and (u.trial_started_at at time zone 'UTC')::date <= coalesce(end_date, (now())::date)
  order by trial_day, u.preferred_name;
$$;

grant execute on function public.trial_day_users_range(date, date) to anon, authenticated;
