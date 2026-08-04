-- Per-user engagement aggregate for the main dashboard.
--
-- Returns, for each user in the requested payment cohorts:
--   days    - distinct calendar days (UTC) on which they took at least one REAL
--             user turn. This is the PRIMARY engagement signal: coming back on
--             many different days beats doing a lot in one sitting. A day where
--             the user opened a lesson but never spoke does NOT count.
--   turns   - total real user turns across those lessons (depth / tiebreak).
--   lessons - how many non-onboarding lessons they completed (incl. empty ones).
-- The onboarding lesson (lesson_id 42) is excluded from all of these.
--
-- A "real user turn" = a user-role message in conversation_transcript whose text
-- is non-empty and not the "[NO_SPEECH_DETECTED]" silence sentinel.
--
-- TRANSCRIPT ENCODING: conversation_transcript is stored inconsistently — ~62%
-- as a jsonb array, ~38% as a jsonb STRING containing the array as JSON text
-- (mostly rows still pending post-processing). A naive jsonb_typeof(...)='array'
-- check silently scored every string-encoded lesson as 0 turns — a huge
-- undercount, since those are full conversations. The CASE below normalizes both
-- encodings ((x #>> '{}')::jsonb re-parses the string form) so turns and days
-- are correct regardless. (Verified: 0 of the ~4.6k string transcripts are
-- malformed; if one ever were, the cast would fail the RPC and the dashboard
-- would fall back to a blank Engagement column — not crash.)
--
-- IMPORTANT: lessons are matched by the user's CURRENT status in user_info, NOT
-- by completed_lessons.payment_status (that per-lesson snapshot is null on every
-- trial user's lessons, so filtering by it drops all trial engagement).
--
-- SECURITY: runs as the caller (security invoker), subject to the same RLS the
-- dashboard already relies on. Idempotent — safe to re-run.

-- The `days` output column changes the return type, which CREATE OR REPLACE
-- cannot do — drop first so re-running this file stays idempotent.
drop function if exists public.engagement_by_user(text[]);

create function public.engagement_by_user(statuses text[])
returns table (user_id text, lessons bigint, turns bigint, days bigint)
language sql
stable
as $$
  select
    t.user_id,
    count(*)                                              as lessons,
    coalesce(sum(t.user_turns), 0)                        as turns,
    count(distinct t.day) filter (where t.user_turns > 0) as days
  from (
    select
      cl.user_id,
      -- UTC calendar date, matching the dashboard's own day bucketing.
      (cl.created_at at time zone 'utc')::date as day,
      (
        select count(*)
        from jsonb_array_elements(
          case jsonb_typeof(cl.conversation_transcript::jsonb)
            when 'array'  then cl.conversation_transcript::jsonb
            when 'string' then (cl.conversation_transcript::jsonb #>> '{}')::jsonb
            else '[]'::jsonb
          end
        ) e
        where e ->> 'role' = 'user'
          and coalesce(e ->> 'text', '') not in ('', '[NO_SPEECH_DETECTED]')
      ) as user_turns
    from public.completed_lessons cl
    where cl.user_id in (
      select ui.user_id
      from public.user_info ui
      where ui.payment_status = any(statuses)
    )
    and cl.lesson_id is distinct from 42
  ) t
  group by t.user_id;
$$;

grant execute on function public.engagement_by_user(text[]) to anon, authenticated;
