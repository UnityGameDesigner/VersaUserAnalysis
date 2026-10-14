-- country_conversion_rates()
--
-- Empirical conversion rate per country × PLATFORM, grounded in the WHOLE user
-- base (every signup, including free users who never started a trial). For each
-- (timezone, platform) it returns total users and how many ever became active
-- (became_active_at set); the client folds timezones into countries
-- (getCountryFromTimezone) and computes active ÷ total per country and per
-- country×platform.
--
-- Platform matters a lot and the demographic model gets its DIRECTION wrong
-- (gives Android a positive coef although iOS converts 2-5× more within every
-- market), so we ground platform empirically here instead of trusting the model.
-- NOTE: Android became_active_at is undercounted (no billing events), so Android
-- rates read a bit low — but iOS > Android holds even after inferring Android
-- conversions from post-trial lessons.

drop function if exists public.country_conversion_rates();

create or replace function public.country_conversion_rates()
returns table(
  time_zone text,
  platform text,
  total_users int,
  active_users int
)
language sql stable as $$
  select
    coalesce(time_zone, '') as time_zone,
    lower(coalesce(platform, '')) as platform,
    count(*)::int as total_users,
    count(became_active_at)::int as active_users
  from user_info
  group by coalesce(time_zone, ''), lower(coalesce(platform, ''));
$$;

grant execute on function public.country_conversion_rates() to anon, authenticated;
notify pgrst, 'reload schema';
