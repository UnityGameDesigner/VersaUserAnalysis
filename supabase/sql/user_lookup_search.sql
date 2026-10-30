-- RPC behind the User Lookup search box (src/UserLookup.tsx): find users by
-- user id or email. Email lives only in auth.users, which the dashboard can't
-- read, so this is SECURITY DEFINER and refuses anyone not in admin_users.
-- Returns just the fields the search needs — never auth tokens or metadata.
--
-- p_query: a full user id (exact match), or any part of an email
-- (case-insensitive; an exact email match sorts first). At most 25 rows.
-- Idempotent — safe to re-run.

drop function if exists public.lookup_users(text);
create or replace function public.lookup_users(p_query text)
returns table (
  user_id uuid, email text, preferred_name text, payment_status text, last_logged_in date
)
language plpgsql stable security definer set search_path = public, auth, pg_temp as $$
declare
  q text := lower(btrim(p_query));
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if q is null or length(q) < 3 then
    return;
  end if;

  if q ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return query
      select u.id, u.email::text, ui.preferred_name, ui.payment_status, ui.last_logged_in
      from auth.users u
      left join user_info ui on ui.user_id = u.id
      where u.id = q::uuid;
    return;
  end if;

  return query
    select u.id, u.email::text, ui.preferred_name, ui.payment_status, ui.last_logged_in
    from auth.users u
    left join user_info ui on ui.user_id = u.id
    -- Escape LIKE wildcards so "_" and "%" in an address match literally.
    where lower(u.email) like '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    order by lower(u.email) = q desc, ui.last_logged_in desc nulls last
    limit 25;
end;
$$;

revoke all on function public.lookup_users(text) from public, anon;
grant execute on function public.lookup_users(text) to authenticated;

notify pgrst, 'reload schema';
