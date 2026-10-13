-- country_conversion_rates()
--
-- Empirical conversion rate per country, grounded in the WHOLE user base (every
-- signup, including free users who never started a trial) — not the demographic
-- prediction model. For each timezone it returns the total users and how many
-- ever became active (became_active_at set); the client folds timezones into
-- countries (getCountryFromTimezone) and computes active ÷ total per country.
--
-- This answers "what share of all users from this country actually convert",
-- which deflates markets with a huge free base (e.g. Jakarta ~0.7%) that the
-- demographic model's global tiers over-stated.

drop function if exists public.country_conversion_rates();

create or replace function public.country_conversion_rates()
returns table(
  time_zone text,
  total_users int,
  active_users int
)
language sql stable as $$
  select
    coalesce(time_zone, '') as time_zone,
    count(*)::int as total_users,
    count(became_active_at)::int as active_users
  from user_info
  group by coalesce(time_zone, '');
$$;

grant execute on function public.country_conversion_rates() to anon, authenticated;
notify pgrst, 'reload schema';
