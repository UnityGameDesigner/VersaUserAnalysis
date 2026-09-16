-- Persisted eval results, written by the daily headless job (scripts/eval-jobs.mjs)
-- and read by the Evals tab for trend charts. Replaces the per-browser localStorage
-- caches for the AUTOMATED trend (the on-demand buttons still use localStorage).

-- Per-lesson LearnLM judge result (the daily LLM sample).
create table if not exists public.lesson_evals (
  lesson_row_id bigint primary key,   -- completed_lessons.id
  user_id       uuid,
  lesson_date   date not null,        -- UTC date of the lesson
  overall       int,                  -- 1-10
  dims          jsonb,                -- [{dimension,score,comment}]
  verdict       text,
  model         text,
  judged_at     timestamptz default now()
);
create index if not exists idx_lesson_evals_date on public.lesson_evals (lesson_date);

-- Per-user Learning Journey (long-horizon) judge result.
create table if not exists public.journey_evals (
  user_id         uuid primary key,
  lesson_count    int,                -- how many lessons were judged
  last_lesson_date date,              -- for the weekly trend
  converted       boolean,
  overall         int,
  continuity      int,
  progression     int,
  memory          int,
  consistency     int,
  verdict         text,
  model           text,
  judged_at       timestamptz default now()
);
create index if not exists idx_journey_evals_last on public.journey_evals (last_lesson_date);

-- Writes go through SECURITY DEFINER upserts so the job can use the anon key
-- (same posture as the rest of this internal dashboard) without table-level RLS grants.
create or replace function public.upsert_lesson_eval(
  p_id bigint, p_user uuid, p_date date, p_overall int, p_dims jsonb, p_verdict text, p_model text
) returns void language sql security definer as $$
  insert into public.lesson_evals(lesson_row_id, user_id, lesson_date, overall, dims, verdict, model, judged_at)
  values (p_id, p_user, p_date, p_overall, p_dims, p_verdict, p_model, now())
  on conflict (lesson_row_id) do update
    set overall = excluded.overall, dims = excluded.dims, verdict = excluded.verdict,
        model = excluded.model, user_id = excluded.user_id, lesson_date = excluded.lesson_date, judged_at = now();
$$;
grant execute on function public.upsert_lesson_eval(bigint, uuid, date, int, jsonb, text, text) to anon, authenticated;

create or replace function public.upsert_journey_eval(
  p_user uuid, p_count int, p_last date, p_converted boolean, p_overall int,
  p_continuity int, p_progression int, p_memory int, p_consistency int, p_verdict text, p_model text
) returns void language sql security definer as $$
  insert into public.journey_evals(user_id, lesson_count, last_lesson_date, converted, overall,
    continuity, progression, memory, consistency, verdict, model, judged_at)
  values (p_user, p_count, p_last, p_converted, p_overall, p_continuity, p_progression, p_memory, p_consistency, p_verdict, p_model, now())
  on conflict (user_id) do update
    set lesson_count = excluded.lesson_count, last_lesson_date = excluded.last_lesson_date, converted = excluded.converted,
        overall = excluded.overall, continuity = excluded.continuity, progression = excluded.progression,
        memory = excluded.memory, consistency = excluded.consistency, verdict = excluded.verdict,
        model = excluded.model, judged_at = now();
$$;
grant execute on function public.upsert_journey_eval(uuid, int, date, boolean, int, int, int, int, int, text, text) to anon, authenticated;

-- Reads: daily lesson-judge trend, weekly journey/continuity trend, converter split.
create or replace function public.lesson_eval_daily(start_date date default null, end_date date default null)
returns table(d date, n int, avg_overall numeric)
language sql stable as $$
  select lesson_date, count(*)::int, round(avg(overall), 2)
  from lesson_evals
  where lesson_date >= coalesce(start_date, (now() - interval '30 days')::date)
    and lesson_date <= coalesce(end_date, now()::date)
  group by lesson_date order by lesson_date;
$$;
grant execute on function public.lesson_eval_daily(date, date) to anon, authenticated;

create or replace function public.journey_eval_weekly()
returns table(week date, n int, avg_continuity numeric, avg_overall numeric, avg_progression numeric, avg_memory numeric, avg_consistency numeric)
language sql stable as $$
  select date_trunc('week', last_lesson_date)::date as week, count(*)::int,
    round(avg(continuity), 2), round(avg(overall), 2), round(avg(progression), 2), round(avg(memory), 2), round(avg(consistency), 2)
  from journey_evals where last_lesson_date is not null
  group by 1 order by 1;
$$;
grant execute on function public.journey_eval_weekly() to anon, authenticated;

create or replace function public.journey_eval_summary()
returns table(converted boolean, n int, avg_overall numeric, avg_continuity numeric, avg_progression numeric, avg_memory numeric, avg_consistency numeric)
language sql stable as $$
  select converted, count(*)::int, round(avg(overall), 2), round(avg(continuity), 2),
    round(avg(progression), 2), round(avg(memory), 2), round(avg(consistency), 2)
  from journey_evals group by converted;
$$;
grant execute on function public.journey_eval_summary() to anon, authenticated;
