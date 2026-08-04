-- Track WHEN a user hits a billing issue (enters PAST_DUE).
--
-- The superwall-webhook overwrites user_info.payment_status on every event but
-- never stamped a time for the PAST_DUE transition, so "when did they go past
-- due" was unrecoverable from our DB. This column, written by the webhook
-- (see supabase/functions/superwall-webhook/index.ts), records the moment they
-- entered their current past-due spell.
--
-- Semantics: stamped write-once-per-spell — set only when a user transitions
-- INTO past-due from a non-past-due status, so retry/grace events within the
-- same spell don't keep bumping the date. Left in place if they later recover
-- (it then reads as "last billing issue"), so it is only authoritative for users
-- whose CURRENT payment_status is PAST_DUE.
--
-- Backfill is impossible: the historical dates live only in Superwall/RevenueCat.
-- Existing past-due users stay null until their next webhook event.
--
-- Idempotent — safe to re-run.

alter table public.user_info
  add column if not exists became_past_due_at timestamptz;
