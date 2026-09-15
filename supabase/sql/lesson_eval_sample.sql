-- lesson_eval_sample(day, sample_size, min_turns)
--
-- A RANDOM sample of a given UTC day's lessons, with everything the client needs
-- to LLM-judge the tutor (src/Evals.tsx) in one round-trip: the transcript plus the
-- student context the eval rubric wants (learning language, level, native language,
-- goal). Only real conversations are eligible — array transcripts with at least
-- `min_turns` messages — so the judge has something to grade.
--
-- Returns up to sample_size rows in random order. Sampling a single day (~1-1.5k
-- lessons) with order by random() is cheap; the created_at range is sargable on
-- idx_completed_lessons_user_created and the user_info join uses user_info_uuid_key.

drop function if exists public.lesson_eval_sample(date, int, int);

create or replace function public.lesson_eval_sample(
  day date,
  sample_size int default 10,
  min_turns int default 4
)
returns table(
  id bigint,
  session_id text,
  user_id uuid,
  lesson_id bigint,
  created_at timestamptz,
  user_rating_feedback bigint,
  ended_early boolean,
  early_end_reason text,
  exit_phase text,
  turns int,
  preferred_name text,
  learning_language text,
  native_language text,
  level text,
  reason text,
  conversation_transcript json
)
language sql stable as $$
  -- json_array_length errors on a scalar, and the planner may evaluate it before
  -- the json_typeof filter, so every call is CASE-guarded (CASE is guaranteed
  -- short-circuit; a plain `typeof='array' AND array_length(...)` qual is not).
  select
    cl.id, cl.session_id, cl.user_id, cl.lesson_id, cl.created_at,
    cl.user_rating_feedback, cl.ended_early, cl.early_end_reason, cl.exit_phase,
    case when json_typeof(cl.conversation_transcript) = 'array'
         then json_array_length(cl.conversation_transcript) end as turns,
    u.preferred_name, u.learning_language, u.native_language, u.level, u.reason,
    cl.conversation_transcript
  from completed_lessons cl
  left join user_info u on u.user_id = cl.user_id
  where cl.created_at >= (day::timestamp) at time zone 'UTC'
    and cl.created_at <  ((day + 1)::timestamp) at time zone 'UTC'
    and case when json_typeof(cl.conversation_transcript) = 'array'
             then json_array_length(cl.conversation_transcript) else 0 end >= greatest(min_turns, 1)
  order by random()
  limit greatest(sample_size, 1);
$$;

grant execute on function public.lesson_eval_sample(date, int, int) to anon, authenticated;
