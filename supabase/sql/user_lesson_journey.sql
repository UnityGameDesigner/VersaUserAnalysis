-- user_lesson_journey(p_user_id, max_lessons)
--
-- One learner's lessons in CHRONOLOGICAL order, with the full transcript, for the
-- long-horizon "Learning Journey" eval (src/lib/evaluateJourney.ts) — which judges
-- the tutor ACROSS a user's real multi-session relationship (continuity,
-- progression, memory, consistency), the thing single-lesson evals can't see.
--
-- Only real conversations (array transcript, >= 2 turns) are returned; the caller
-- budgets/truncates transcripts before sending them to the judge. Served by
-- idx_completed_lessons_user_created (user_id, created_at) — see perf_indexes.sql.

drop function if exists public.user_lesson_journey(uuid, int);

create or replace function public.user_lesson_journey(p_user_id uuid, max_lessons int default 20)
returns table(
  id bigint,
  lesson_id bigint,
  created_at timestamptz,
  turns int,
  user_rating_feedback bigint,
  ended_early boolean,
  exit_phase text,
  conversation_transcript json
)
language sql stable as $$
  select id, lesson_id, created_at,
    json_array_length(conversation_transcript) as turns,
    user_rating_feedback, ended_early, exit_phase, conversation_transcript
  from completed_lessons
  where user_id = p_user_id
    and json_typeof(conversation_transcript) = 'array'
    and case when json_typeof(conversation_transcript) = 'array'
             then json_array_length(conversation_transcript) else 0 end >= 2
  order by created_at
  limit greatest(max_lessons, 1);
$$;

grant execute on function public.user_lesson_journey(uuid, int) to anon, authenticated;
