-- get_user_goals / get_user_skills
--
-- Read helpers for the User Lookup profile: a learner's goal progress and skill
-- development, with human-readable names resolved. Used by src/UserLookup.tsx.
--
-- Live tables (learner_goals is empty/legacy — do not use):
--   user_goals   — one active goal per user (progress_score, readiness_score,
--                  status); goal name via goal_variant_id -> goal_variants.
--   user_skills  — per-user skill mastery (~843 users): state
--                  (introduced/practiced/demonstrated/retained/mastered),
--                  mastery_score 0..1; name via skill_variant_id -> skill_variants
--                  (+ skill_localizations for the display name).
--
-- SECURITY DEFINER so the single-admin dashboard (anon key) can read regardless
-- of RLS on the underlying tables; both are read-only.

create or replace function public.get_user_goals(p_user_id uuid)
returns table (
  goal_name text, level_code text, is_primary boolean, status text,
  progress_score numeric, readiness_score numeric, target_date date,
  last_activity_at timestamptz, user_motivation text
)
language sql stable security definer set search_path = public as $$
  select coalesce(gv.display_name, gl.display_name, gv.variant_key, 'Goal'),
         gv.level_code, ug.is_primary, ug.status,
         ug.progress_score, ug.readiness_score, ug.target_date::date,
         ug.last_activity_at, ug.user_motivation
  from user_goals ug
  left join goal_variants gv on gv.id = ug.goal_variant_id
  left join goal_localizations gl on gl.goal_id = gv.goal_id and gl.locale_code = 'en'
  where ug.user_id = p_user_id
  order by ug.is_primary desc nulls last, ug.last_activity_at desc nulls last;
$$;

create or replace function public.get_user_skills(p_user_id uuid)
returns table (
  skill_name text, level_code text, state text,
  mastery_score numeric, confidence_score numeric, last_practiced_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select coalesce(sv.display_name_override, sl.display_name, sv.variant_key, 'Skill'),
         sv.level_code, us.state, us.mastery_score, us.confidence_score, us.last_practiced_at
  from user_skills us
  left join skill_variants sv on sv.id = us.skill_variant_id
  left join skill_localizations sl on sl.skill_id = sv.skill_id and sl.locale_code = 'en'
  where us.user_id = p_user_id
  order by us.mastery_score desc nulls last;
$$;

grant execute on function public.get_user_goals(uuid) to anon, authenticated;
grant execute on function public.get_user_skills(uuid) to anon, authenticated;
