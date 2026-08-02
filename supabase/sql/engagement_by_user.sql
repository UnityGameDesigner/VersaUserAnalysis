-- Per-user engagement aggregate for the main dashboard.
--
-- Returns, for each user in the requested payment cohorts, how many lessons
-- they completed and how many USER turns they took across those lessons. A
-- "turn" is one user-role message in conversation_transcript — the signal that
-- separates people who actually talk from those who start-and-bail a lesson.
-- The onboarding lesson (lesson_id 42) is excluded from BOTH counts — see the
-- WHERE clause below.
--
-- Why a function instead of counting client-side: word_timeline is null on
-- ~89% of lessons so it can't be used, and fetching every conversation_transcript
-- would be ~35-55MB per dashboard load (10.9k active/trial lessons × ~5KB).
-- Aggregating here returns ~one small row per user instead.
--
-- conversation_transcript is cast to jsonb defensively so this works whether the
-- column is json or jsonb. Lessons whose transcript is missing/not an array
-- simply contribute 0 turns (but still count as a completed lesson).
--
-- IMPORTANT: we match lessons by the user's CURRENT status in user_info, NOT by
-- completed_lessons.payment_status. That per-lesson snapshot is null on every
-- trial user's lessons (and on active users' pre-conversion lessons), so
-- filtering by it drops all trial engagement. The membership subquery below
-- attributes every lesson to its user regardless of the lesson-time snapshot.
-- (IN on the subquery is dup-safe even though user_info has repeated user_ids.)
--
-- SECURITY: runs as the caller (security invoker, the default), so it is subject
-- to the same RLS the dashboard already relies on for user_info / completed_lessons.
--
-- Apply once in the Supabase SQL editor (or via `supabase db push` if you wire
-- up migrations). Idempotent — safe to re-run.

create or replace function public.engagement_by_user(statuses text[])
returns table (user_id text, lessons bigint, turns bigint)
language sql
stable
as $$
  select
    t.user_id,
    count(*)                       as lessons,
    coalesce(sum(t.user_turns), 0) as turns
  from (
    select
      cl.user_id,
      case
        when jsonb_typeof(cl.conversation_transcript::jsonb) = 'array' then (
          select count(*)
          from jsonb_array_elements(cl.conversation_transcript::jsonb) e
          where e ->> 'role' = 'user'
        )
        else 0
      end as user_turns
    from public.completed_lessons cl
    where cl.user_id in (
      select ui.user_id
      from public.user_info ui
      where ui.payment_status = any(statuses)
    )
    -- Exclude lesson 42, the onboarding lesson. ~95% of users complete it (often
    -- more than once) and it averages ~8.6 turns, so counting it just adds a near
    -- constant that says nothing about real trial engagement. `is distinct from`
    -- keeps rows with a null lesson_id rather than dropping them like `<> 42`.
    and cl.lesson_id is distinct from 42
  ) t
  group by t.user_id;
$$;

grant execute on function public.engagement_by_user(text[]) to anon, authenticated;
