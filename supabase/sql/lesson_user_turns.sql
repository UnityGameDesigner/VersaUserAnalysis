-- Cache of user-turn counts per completed lesson, for revenue_user_retention
-- (revenue_page.sql). Older lessons have no turn_metrics / exit_phase, so the
-- retention score has to count user turns in the transcript to spot silent
-- lessons and estimate length. Reading ~17k transcripts on every Revenue page
-- load took 5.5s and pushed the RPC past the 8s statement timeout.
--
-- Only payers' lessons (users in user_revenue) are cached, and only once they're
-- an hour old — a finished transcript doesn't change. pg_cron tops it up every
-- 10 minutes; anything not cached yet is still counted inline by the RPC.
-- Idempotent — safe to re-run.

create table if not exists public.lesson_user_turns (
  lesson_row_id bigint primary key,   -- completed_lessons.id
  user_turns    int                   -- null = transcript isn't a json array
);
alter table public.lesson_user_turns enable row level security;

create or replace function public.fill_lesson_user_turns(p_limit int default 5000)
returns int
language sql volatile security definer set search_path = public as $$
  with todo as (
    select cl.id, cl.conversation_transcript t
    from user_revenue ur
    cross join lateral (
      select c.id, c.conversation_transcript from completed_lessons c
      where c.user_id = ur.user_id
        and c.created_at < now() - interval '1 hour'
        and c.lesson_id is distinct from 42
        and not exists (select 1 from lesson_user_turns x where x.lesson_row_id = c.id)
    ) cl
    limit p_limit
  ), ins as (
    insert into lesson_user_turns (lesson_row_id, user_turns)
    -- Same '"role":"user"' substring count as revenue_user_retention.
    select id, case when json_typeof(t) = 'array'
                    then (length(t::text) - length(replace(t::text, '"role":"user"', ''))) / 13 end
    from todo
    on conflict do nothing
    returning 1
  )
  select count(*)::int from ins;
$$;
revoke all on function public.fill_lesson_user_turns(int) from public, anon, authenticated;

select cron.unschedule('fill-lesson-user-turns') where exists (select 1 from cron.job where jobname = 'fill-lesson-user-turns');
select cron.schedule('fill-lesson-user-turns', '*/10 * * * *', $cron$ select public.fill_lesson_user_turns(5000); $cron$);
