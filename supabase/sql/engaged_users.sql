-- engaged_users(min_lessons, since_days, max_rows)
--
-- A random sample of learners with a real multi-session RELATIONSHIP (>= min_lessons
-- lessons in the last since_days), plus their conversion outcome. Powers the Learning
-- Journey cohort runner in the Evals tab, which judges each user's journey and checks
-- whether the score separates converters from churners.
--
-- Random order so the sample mixes converters and non-converters (engaged users
-- skew toward converting, but not entirely). Only the engaged slice qualifies —
-- most users do ~1 lesson, so this is intentionally a few hundred users, not thousands.

drop function if exists public.engaged_users(int, int, int);

create or replace function public.engaged_users(
  min_lessons int default 5,
  since_days int default 45,
  max_rows int default 30
)
returns table(
  user_id uuid,
  preferred_name text,
  learning_language text,
  level text,
  native_language text,
  reason text,
  trial_started_at timestamptz,
  became_active_at timestamptz,
  payment_status text,
  lessons int,
  active_days int,
  first_lesson timestamptz,
  last_lesson timestamptz
)
language sql stable as $$
  with per as (
    select cl.user_id,
      count(*) as lessons,
      count(distinct (cl.created_at at time zone 'UTC')::date) as active_days,
      min(cl.created_at) as first_lesson,
      max(cl.created_at) as last_lesson
    from completed_lessons cl
    where cl.created_at >= now() - (since_days || ' days')::interval
      and json_typeof(cl.conversation_transcript) = 'array'
    group by cl.user_id
    having count(*) >= greatest(min_lessons, 2)
  )
  select p.user_id, u.preferred_name, u.learning_language, u.level, u.native_language, u.reason,
    u.trial_started_at, u.became_active_at, u.payment_status,
    p.lessons::int, p.active_days::int, p.first_lesson, p.last_lesson
  from per p
  join user_info u on u.user_id = p.user_id
  order by random()
  limit greatest(max_rows, 1);
$$;

grant execute on function public.engaged_users(int, int, int) to anon, authenticated;
