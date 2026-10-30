-- RPC behind the lesson titles on the User Lookup lesson cards (src/UserLookup.tsx).
-- completed_lessons.lesson_id points into one of three tables, told apart by
-- non-overlapping id ranges (checked 2026-10-30):
--   lessons         1 .. ~430            catalog lessons ('catalog')
--   custom_lessons  100,000 .. <1e9      a user's own custom lesson ('custom')
--   daily_lessons   >= 1,000,000,000     per-user generated daily lesson ('daily')
-- custom_lessons and daily_lessons are owner-read only, so this is SECURITY
-- DEFINER and refuses anyone not in admin_users. Ids with no row (e.g. -1)
-- are simply absent from the result. Idempotent — safe to re-run.

create or replace function public.lesson_titles(p_ids bigint[])
returns table (lesson_id bigint, title text, kind text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select l.id, l.title, 'catalog'::text from lessons l
    where l.id = any(p_ids) and l.id < 100000
    union all
    select c.id, c.title, 'custom'::text from custom_lessons c
    where c.id = any(p_ids) and c.id >= 100000 and c.id < 1000000000
    union all
    select d.id, d.title, 'daily'::text from daily_lessons d
    where d.id = any(p_ids) and d.id >= 1000000000;
end;
$$;

revoke all on function public.lesson_titles(bigint[]) from public, anon;
grant execute on function public.lesson_titles(bigint[]) to authenticated;

notify pgrst, 'reload schema';
