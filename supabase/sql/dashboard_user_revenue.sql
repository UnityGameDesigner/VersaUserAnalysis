-- RPC behind the revenue sort options on the main dashboard
-- (src/ActiveUserDashboard.tsx): one row per paying user from user_revenue.
-- user_revenue is a view the browser can't read, so this is SECURITY DEFINER
-- and refuses anyone not in admin_users. Idempotent — safe to re-run.

create or replace function public.dashboard_user_revenue()
returns table (user_id uuid, payments int, gross_usd numeric, net_usd numeric,
               first_paid_at timestamptz, last_paid_at timestamptz,
               current_product_id text, current_period_months numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select ur.user_id, ur.payments, ur.gross_usd, ur.net_usd, ur.first_paid_at, ur.last_paid_at,
           ur.current_product_id, ur.current_period_months
    from user_revenue ur
    where ur.user_id is not null;
end;
$$;

revoke all on function public.dashboard_user_revenue() from public, anon;
grant execute on function public.dashboard_user_revenue() to authenticated;

notify pgrst, 'reload schema';
