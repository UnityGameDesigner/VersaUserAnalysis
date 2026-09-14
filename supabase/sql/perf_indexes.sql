-- Performance indexes for the Trial Retention "Per day" view (and any other query
-- that joins completed_lessons by user or filters user_info by trial-start day).
--
-- Why: clicking a bar (trial_day_users) and loading the per-day chart
-- (trial_daily_activity) both did `left join completed_lessons cl on cl.user_id =
-- u.user_id`, but completed_lessons had NO index on user_id — only on id,
-- session_id, learner_goal_id. So Postgres seq-scanned the entire ~1.1 GB / 350k-row
-- completed_lessons table on every click (EXPLAIN: 10.85s of an 11.2s query) just to
-- find a handful of users' lessons. Both RPCs also filter user_info by
-- (trial_started_at at time zone 'UTC')::date, an expression no index covered, so
-- user_info (283k rows / 499 MB) got a full seq scan too.
--
-- Run these with CREATE INDEX CONCURRENTLY so building them does NOT lock out the
-- webhook writes into completed_lessons. CONCURRENTLY cannot run inside a
-- transaction block — execute each statement on its own (not wrapped in BEGIN/COMMIT,
-- and not via a migration runner that batches them into one transaction).

-- The big one: makes the completed_lessons join an index scan instead of a 1.1 GB
-- seq scan. Composite (user_id, created_at) also covers the trial-window date-range
-- filters in the aggregates, so most of the work is index-only.
create index concurrently if not exists idx_completed_lessons_user_created
  on public.completed_lessons (user_id, created_at);

-- Lets the trial-start-day filter (= day, and range >=/<=) use an index instead of
-- scanning all of user_info. Partial: only the ~2.6k rows that ever started a trial.
create index concurrently if not exists idx_user_info_trial_start_date
  on public.user_info (((trial_started_at at time zone 'UTC')::date))
  where trial_started_at is not null;
