-- trial_day_users(day)
--
-- The users who started a trial on a specific day (UTC date of trial_started_at),
-- with their trial-window engagement (distinct active days + total lessons in the
-- 7-day window), device platform, and the demographic fields the conversion
-- scorecard (src/lib/conversionScore) needs to compute a likelihood-to-convert
-- tier client-side. Powers the click-through from a bar in the Trial Retention
-- "Per day" view.

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
    u.trial_started_at, u.became_active_at,
    least(count(distinct (cl.created_at at time zone 'UTC')::date) filter (
      where cl.created_at >= u.trial_started_at
        and cl.created_at < u.trial_started_at + interval '7 days'
    ), 7)::int as active_days,
    count(cl.*) filter (
      where cl.created_at >= u.trial_started_at
        and cl.created_at < u.trial_started_at + interval '7 days'
    )::int as lessons,
    -- lessons after the 7-day trial ended: proof of paid access, so a trial with
    -- post_trial_lessens > 0 but no became_active_at converted-but-untracked
    -- (common on Android, which doesn't send billing events).
    count(cl.*) filter (
      where cl.created_at > u.trial_started_at + interval '8 days'
    )::int as post_trial_lessons,
    u.platform, u.gender, u.native_language, u.level, u.reason, u.demand_tier,
    u.messaging_platform, u.tutor, u.completed_tutorial, u.previous_experience, u.attribution
  from user_info u
  left join completed_lessons cl on cl.user_id = u.user_id
  where u.trial_started_at is not null
    and (u.trial_started_at at time zone 'UTC')::date = day
  group by u.user_id, u.preferred_name, u.learning_language, u.payment_status, u.age, u.time_zone,
    u.trial_started_at, u.became_active_at,
    u.platform, u.gender, u.native_language, u.level, u.reason, u.demand_tier,
    u.messaging_platform, u.tutor, u.completed_tutorial, u.previous_experience, u.attribution
  order by active_days desc, u.preferred_name;
$$;

grant execute on function public.trial_day_users(date) to anon, authenticated;
