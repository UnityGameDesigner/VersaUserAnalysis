-- RPC behind the "days used / first lesson" badge on the All Transcripts tiles
-- (src/AllTranscripts.tsx). For a batch of users: distinct UTC days with any
-- completed lesson (onboarding included — it's still a day they used the
-- app), lesson count, and first / last lesson time. Lifetime, not "as of"
-- the tile's lesson.
--
-- SECURITY INVOKER: reads completed_lessons under the caller's RLS (the
-- dashboard admin read policy). Served by idx_completed_lessons_user_created.
-- Idempotent — safe to re-run.

create or replace function public.user_activity_summary(p_user_ids uuid[])
returns table (user_id uuid, active_days int, lessons int, first_lesson_at timestamptz, last_lesson_at timestamptz)
language sql stable set search_path = public as $$
  select cl.user_id,
         count(distinct (cl.created_at at time zone 'UTC')::date)::int,
         count(*)::int,
         min(cl.created_at),
         max(cl.created_at)
  from completed_lessons cl
  where cl.user_id = any(p_user_ids)
  group by cl.user_id;
$$;

revoke all on function public.user_activity_summary(uuid[]) from public, anon;
grant execute on function public.user_activity_summary(uuid[]) to authenticated;

notify pgrst, 'reload schema';
