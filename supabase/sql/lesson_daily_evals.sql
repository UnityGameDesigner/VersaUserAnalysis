-- lesson_daily_evals(start_date, end_date)
--
-- Per-DAY lesson-quality metrics for the Evals tab (src/Evals.tsx). One row per
-- UTC day in the range (default: last 14 days), aggregated over completed_lessons.
--
-- Returns per day:
--   lessons          — total lessons completed
--   rated            — # with a star rating (user_rating_feedback 1-5)
--   avg_rating       — mean star rating (nulls ignored)
--   rating_hist      — int[5]: counts of 1★,2★,3★,4★,5★
--   neg              — # rated 1-2★ (dissatisfied)
--   avg_turns        — mean conversation length in messages (array transcripts only)
--   early            — # ended early (ended_early)
--   silent           — # that connected but the learner never spoke (exit_phase
--                      = 'connected_no_user_turn') — a mic/speech-friction signal
--   never_connected  — # that never connected (exit_phase = 'never_connected')
--   text_feedback    — # that left written feedback (user_improvement_feedback)
--   avg_latency_ms   — mean tutor response latency across turns (from turn_metrics)
--
-- Perf: the created_at range is served by idx_completed_lessons_user_created via a
-- bitmap scan (~1.6s for 14 days); the turn_metrics latency parse adds ~0.2s. Keep
-- the default window modest — very wide ranges heap-fetch a large share of the
-- 1.1 GB table. See supabase/sql/perf_indexes.sql.

drop function if exists public.lesson_daily_evals(date, date);

create or replace function public.lesson_daily_evals(start_date date default null, end_date date default null)
returns table(
  d date,
  lessons int,
  rated int,
  avg_rating numeric,
  rating_hist int[],
  neg int,
  avg_turns numeric,
  early int,
  silent int,
  never_connected int,
  text_feedback int,
  avg_latency_ms numeric
)
language sql stable as $$
  with base as (
    select
      (created_at at time zone 'UTC')::date as d,
      user_rating_feedback as rating,
      case when json_typeof(conversation_transcript) = 'array'
           then json_array_length(conversation_transcript) end as turns,
      ended_early,
      exit_phase,
      (user_improvement_feedback is not null
        and length(btrim(user_improvement_feedback)) > 0) as has_text,
      -- mean tutor response latency for this lesson; guarded so a non-array
      -- turn_metrics (or null) doesn't error in jsonb_array_elements.
      case when jsonb_typeof(turn_metrics) = 'array' then (
        select avg((e->'metrics'->>'tutor_response_latency_ms')::numeric)
        from jsonb_array_elements(turn_metrics) e
        where (e->'metrics'->>'tutor_response_latency_ms') is not null
      ) end as lat
    from completed_lessons
    where created_at >= coalesce(start_date, (now() - interval '14 days')::date)
      and created_at <  coalesce(end_date, (now())::date) + interval '1 day'
  )
  select
    d,
    count(*)::int as lessons,
    count(rating)::int as rated,
    round(avg(rating), 2) as avg_rating,
    array[
      count(*) filter (where rating = 1)::int,
      count(*) filter (where rating = 2)::int,
      count(*) filter (where rating = 3)::int,
      count(*) filter (where rating = 4)::int,
      count(*) filter (where rating = 5)::int
    ] as rating_hist,
    count(*) filter (where rating in (1, 2))::int as neg,
    round(avg(turns), 2) as avg_turns,
    count(*) filter (where ended_early)::int as early,
    count(*) filter (where exit_phase = 'connected_no_user_turn')::int as silent,
    count(*) filter (where exit_phase = 'never_connected')::int as never_connected,
    count(*) filter (where has_text)::int as text_feedback,
    round(avg(lat), 0) as avg_latency_ms
  from base
  group by d
  order by d;
$$;

grant execute on function public.lesson_daily_evals(date, date) to anon, authenticated;
