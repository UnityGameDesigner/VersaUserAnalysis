-- trial_day_users(day)
--
-- The users who started a trial on a specific day (UTC date of trial_started_at),
-- with how many distinct days they completed lessons in their 7-day trial window.
-- Powers the click-through from a bar in the Trial Retention "Per day" view.

create or replace function public.trial_day_users(day date)
returns table(
  user_id uuid,
  preferred_name text,
  learning_language text,
  payment_status text,
  trial_started_at timestamptz,
  active_days int
)
language sql stable as $$
  select u.user_id, u.preferred_name, u.learning_language, u.payment_status, u.trial_started_at,
    least(count(distinct (cl.created_at at time zone 'UTC')::date) filter (
      where cl.created_at >= u.trial_started_at
        and cl.created_at < u.trial_started_at + interval '7 days'
    ), 7)::int as active_days
  from user_info u
  left join completed_lessons cl on cl.user_id = u.user_id
  where u.trial_started_at is not null
    and (u.trial_started_at at time zone 'UTC')::date = day
  group by u.user_id, u.preferred_name, u.learning_language, u.payment_status, u.trial_started_at
  order by active_days desc, u.preferred_name;
$$;

grant execute on function public.trial_day_users(date) to anon;
