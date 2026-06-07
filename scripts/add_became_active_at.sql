-- ---------------------------------------------------------------------------
-- Add a conversion timestamp so we can analyze how users behave AFTER they
-- become pro/ACTIVE. Run in the Supabase SQL editor (or psql).
--
-- Why this is needed: nothing in the DB currently records WHEN a user
-- converted. user_info.payment_status is a current-status snapshot with no
-- timestamp, and completed_lessons.payment_status is a denormalized copy of the
-- user's current status (every active user's lessons read ACTIVE, including
-- their trial-era first lessons), so the transition can't be reconstructed.
-- Subscriptions are driven by Superwall, whose events live in Superwall, not
-- here -- so we capture the moment ourselves.
-- ---------------------------------------------------------------------------

ALTER TABLE user_info
  ADD COLUMN IF NOT EXISTS became_active_at timestamptz;

-- Helps cohort/range queries on the analysis side.
CREATE INDEX IF NOT EXISTS idx_user_info_became_active_at
  ON user_info (became_active_at);

COMMENT ON COLUMN user_info.became_active_at IS
  'UTC timestamp the user first converted to a paid/ACTIVE subscription '
  '(from Superwall). Set ONCE on first conversion; never overwritten.';

-- ---------------------------------------------------------------------------
-- POPULATION (backend work -- pick the source you have):
--
-- 1. Going forward: in the same code path that sets payment_status = 'ACTIVE'
--    (your Superwall transaction/subscription-start handler), also set
--    became_active_at, but only if it's still null, e.g.:
--
--      UPDATE user_info
--         SET payment_status = 'ACTIVE',
--             became_active_at = COALESCE(became_active_at, now())
--       WHERE user_id = $1;
--
--    Prefer the actual transaction timestamp from the Superwall event payload
--    over now() when available.
--
-- 2. Backfill history: Superwall keeps per-user conversion dates. Export them
--    (Superwall dashboard export or API), keyed by your app user id, then:
--
--      UPDATE user_info u
--         SET became_active_at = v.converted_at
--        FROM (VALUES
--               ('<app_user_id>'::text, '<iso_ts>'::timestamptz)
--               -- ...one row per converted user...
--             ) AS v(user_id, converted_at)
--       WHERE u.user_id = v.user_id
--         AND u.became_active_at IS NULL;
--
--    Without a Superwall export, historical conversion dates are unrecoverable
--    and we can only track conversions from the day population starts.
-- ---------------------------------------------------------------------------
