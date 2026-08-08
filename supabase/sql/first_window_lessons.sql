-- Powers the Tutor Comparison tab: rank users by how many lessons they packed
-- into their FIRST `days` days (measured from their first completed lesson), so
-- an intensive app week can be compared to a week with a human tutor.
--
-- Onboarding lesson 42 is excluded (it's an assessment, not a practice session).
-- Only users with lessons_in_window >= min_lessons are returned, ordered by
-- lessons desc and capped to max_rows; total_matches (the true count before the
-- cap) is repeated on every row so the UI can tell when the list is capped.
--
-- turns_in_window parses conversation_transcript (array- or string-encoded) and
-- counts real student turns, matching engagement_by_user.sql. It is computed only
-- for the capped/matched set, and total_lessons is folded into the first-pass
-- group-by, so the function stays fast even over the full lessons table.

drop function if exists public.first_window_lessons(int, int, int);
create function public.first_window_lessons(
  days int default 7,
  min_lessons int default 5,
  max_rows int default 1000
)
returns table (
  user_id uuid,
  preferred_name text,
  learning_language text,
  level text,
  time_zone text,
  tutor text,
  payment_status text,
  attribution text,
  first_lesson_at timestamptz,
  lessons_in_window bigint,
  days_active_in_window bigint,
  turns_in_window bigint,
  total_lessons bigint,
  total_matches bigint
)
language sql
stable
as $$
with firsts as (
  -- one pass: first-lesson time AND all-time real-lesson count per user
  select cl.user_id,
    min(cl.created_at) as first_at,
    count(*) filter (where cl.lesson_id is distinct from 42) as total_lessons
  from public.completed_lessons cl
  group by cl.user_id
),
base as (
  select f.user_id, f.first_at, f.total_lessons,
    count(*) filter (where cl.lesson_id is distinct from 42) as lessons_in_window,
    count(distinct (cl.created_at at time zone 'utc')::date)
      filter (where cl.lesson_id is distinct from 42) as days_active
  from firsts f
  join public.completed_lessons cl on cl.user_id = f.user_id
    and cl.created_at >= f.first_at
    and cl.created_at < f.first_at + make_interval(days => days)
  group by f.user_id, f.first_at, f.total_lessons
),
matched as (
  select * from base
  where lessons_in_window >= min_lessons
  order by lessons_in_window desc, days_active desc
  limit greatest(1, max_rows)
),
tot as (
  select count(*) as total_matches from base where lessons_in_window >= min_lessons
),
turns as (
  select m.user_id, coalesce(sum(t.user_turns), 0) as turns_in_window
  from matched m
  join public.completed_lessons cl on cl.user_id = m.user_id
    and cl.created_at >= m.first_at
    and cl.created_at < m.first_at + make_interval(days => days)
    and cl.lesson_id is distinct from 42
  cross join lateral (
    select (select count(*) from jsonb_array_elements(
       case jsonb_typeof(cl.conversation_transcript::jsonb)
         when 'array' then cl.conversation_transcript::jsonb
         when 'string' then (cl.conversation_transcript::jsonb #>> '{}')::jsonb
         else '[]'::jsonb end) e
     where e ->> 'role' = 'user'
       and coalesce(e ->> 'text','') not in ('', '[NO_SPEECH_DETECTED]')) as user_turns
  ) t
  group by m.user_id
)
select m.user_id, ui.preferred_name, ui.learning_language, ui.level,
  ui.time_zone, ui.tutor, ui.payment_status, ui.attribution,
  m.first_at as first_lesson_at, m.lessons_in_window,
  m.days_active as days_active_in_window,
  coalesce(tn.turns_in_window, 0) as turns_in_window,
  m.total_lessons,
  (select total_matches from tot) as total_matches
from matched m
left join lateral (
  select preferred_name, learning_language, level, time_zone, tutor, payment_status, attribution
  from public.user_info ui where ui.user_id = m.user_id limit 1
) ui on true
left join turns tn on tn.user_id = m.user_id
order by m.lessons_in_window desc, m.days_active desc;
$$;

grant execute on function public.first_window_lessons(int, int, int) to anon, authenticated;
