-- Aggregated "why did trials cancel" insights for the Cancelled Trials tab.
-- Read-only, server-side so we never ship raw transcripts to the browser.
--
-- Cohort: post-trial users = payment_status in ACTIVE / CANCELED / PAST_DUE.
-- "trial_cancel" = CANCELED and never converted (became_active_at is null).
-- "converted" = everyone else in the cohort.
--
-- window_days: null = all time; N = "recent" means last_logged_in within N days.
-- There is no reliable historical cancellation timestamp (user_info.canceled_at only
-- started stamping recently), so last_logged_in is the most complete recency anchor.
--
-- IMPORTANT — mixed scope, on purpose:
--   * WINDOWED (respect window_days): funnel + friction. These describe *which trial
--     cancels happened recently* and are what the window is for.
--   * ALL-TIME (ignore window_days): by_days, by_source, cohorts. These are
--     cross-cohort RATE benchmarks. Windowing them on last_logged_in biases the
--     "converted" side badly — active subscribers always have a recent login, so a
--     short window keeps ~all converters but only recent cancels, inflating
--     conversion and flattening the by-source signal. Base rates belong over all
--     history; the window only scopes the descriptive cancel metrics.
--
-- Lesson 42 (onboarding) is excluded from engagement, matching engagement_by_user.sql.
-- Transcripts are stored as either a JSON array or a JSON string; both encodings are
-- normalised before counting real user turns.
--
-- Returns: { window_days, funnel, friction, by_days, by_source, cohorts }.

drop function if exists public.cancelled_trials_insights();
drop function if exists public.cancelled_trials_insights(integer);
create function public.cancelled_trials_insights(window_days integer default null)
returns jsonb
language sql
stable
as $$
with post as (
  select distinct on (user_id) user_id, payment_status, became_active_at, attribution, last_logged_in
  from public.user_info
  where payment_status in ('ACTIVE','CANCELED','PAST_DUE')
  order by user_id
),
eng as (
  select p.user_id, p.attribution,
    (window_days is null
       or p.last_logged_in >= (now() - make_interval(days => window_days))::date) as in_window,
    (p.payment_status in ('ACTIVE','PAST_DUE') or p.became_active_at is not null) as converted,
    (p.payment_status='CANCELED' and p.became_active_at is null) as trial_cancel,
    count(cl.id) filter (where cl.lesson_id is distinct from 42) as real_lessons,
    count(cl.id) filter (where cl.lesson_id = 42) as onboarding_lessons,
    count(distinct (cl.created_at at time zone 'utc')::date) filter (where cl.lesson_id is distinct from 42) as active_days
  from post p
  left join public.completed_lessons cl on cl.user_id = p.user_id
  group by p.user_id, p.attribution, p.last_logged_in, p.payment_status, p.became_active_at
),
-- ── WINDOWED: descriptive metrics for trial cancels in the window ──
funnel as (
  select
    count(*) filter (where trial_cancel and in_window) as trial_cancels,
    count(*) filter (where trial_cancel and in_window and real_lessons=0 and onboarding_lessons=0) as never_started,
    count(*) filter (where trial_cancel and in_window and onboarding_lessons>0 and real_lessons=0) as onboarding_only,
    count(*) filter (where trial_cancel and in_window and real_lessons between 1 and 2) as lessons_1_2,
    count(*) filter (where trial_cancel and in_window and real_lessons between 3 and 5) as lessons_3_5,
    count(*) filter (where trial_cancel and in_window and real_lessons between 6 and 10) as lessons_6_10,
    count(*) filter (where trial_cancel and in_window and real_lessons > 10) as lessons_11plus,
    round(avg(real_lessons) filter (where trial_cancel and in_window),2) as avg_lessons,
    round(avg(active_days) filter (where trial_cancel and in_window),2) as avg_days,
    round((percentile_cont(0.5) within group (order by active_days)
           filter (where trial_cancel and in_window))::numeric,1) as median_days,
    round((percentile_cont(0.5) within group (order by real_lessons)
           filter (where trial_cancel and in_window))::numeric,1) as median_lessons
  from eng
),
friction as (
  select
    count(*) as real_lesson_rows,
    count(*) filter (where user_turns=0) as zero_turn_lessons,
    round(100.0*count(*) filter (where user_turns=0)/nullif(count(*),0),1) as pct_zero_turn,
    count(distinct user_id) as users
  from (
    select cl.user_id,
      (select count(*) from jsonb_array_elements(
         case jsonb_typeof(cl.conversation_transcript::jsonb)
           when 'array' then cl.conversation_transcript::jsonb
           when 'string' then (cl.conversation_transcript::jsonb #>> '{}')::jsonb
           else '[]'::jsonb end) ev
       where ev->>'role'='user' and coalesce(ev->>'text','') not in ('','[NO_SPEECH_DETECTED]')) as user_turns
    from public.completed_lessons cl
    where cl.user_id in (select user_id from eng where trial_cancel and in_window)
      and cl.lesson_id is distinct from 42
  ) z
),
-- ── ALL-TIME: cross-cohort benchmarks (see header note on why these ignore the window) ──
by_days as (
  select bucket, ord, users, converted,
    round(100.0*converted/nullif(users,0),1) as conversion_rate
  from (
    select
      case when active_days=0 then '0 days'
           when active_days=1 then '1 day'
           when active_days=2 then '2 days'
           when active_days=3 then '3 days'
           when active_days between 4 and 6 then '4-6 days'
           else '7+ days' end as bucket,
      min(active_days) as ord,
      count(*) as users,
      count(*) filter (where converted) as converted
    from eng group by 1
  ) b
),
by_source as (
  select source, finished_trial, trial_cancels,
    round(100.0*trial_cancels/nullif(finished_trial,0),1) as pct_cancel
  from (
    select coalesce(nullif(attribution,''),'(none)') as source,
      count(*) as finished_trial,
      count(*) filter (where trial_cancel) as trial_cancels
    from eng group by 1
  ) s
  where finished_trial >= 20
),
cohorts as (
  select
    case when trial_cancel then 'trial_cancel' else 'converted' end as cohort,
    count(*) as users,
    round(avg(real_lessons),2) as avg_lessons,
    round(percentile_cont(0.5) within group (order by real_lessons)::numeric,1) as median_lessons,
    round(avg(active_days),2) as avg_days,
    round(percentile_cont(0.5) within group (order by active_days)::numeric,1) as median_days
  from eng group by 1
)
select jsonb_build_object(
  'window_days', window_days,
  'funnel', (select to_jsonb(f) from funnel f),
  'friction', (select to_jsonb(fr) from friction fr),
  'by_days', (select jsonb_agg((to_jsonb(d) - 'ord') order by d.ord) from by_days d),
  'by_source', (select jsonb_agg(to_jsonb(s) order by s.finished_trial desc) from by_source s),
  'cohorts', (select jsonb_agg(to_jsonb(c)) from cohorts c)
);
$$;

grant execute on function public.cancelled_trials_insights(integer) to anon, authenticated;
