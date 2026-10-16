-- country_conversion_rates()
--
-- Empirical conversion rate per country × PLATFORM × AGE-BUCKET, grounded in the
-- WHOLE user base (every signup, including free users who never started a trial).
-- For each (timezone, platform, age bucket) it returns total users and how many
-- ever became active (became_active_at set); the client folds timezones into
-- countries (getCountryFromTimezone) and computes active ÷ total.
--
-- Why all three dimensions are grounded empirically (not the demographic model):
-- the logistic model mis-estimates every main driver — its platform coef is
-- BACKWARDS (iOS converts 2-5× more at every age) and its age effect is too weak
-- (~2.4× young→old vs ~4-5× in reality). The empirical cell rate captures all
-- three cleanly and compounds (e.g. Indonesia android <=24 0.3%, 50+ ~1.5%;
-- iOS ≫ android within every cell). Age buckets: <=24 / 25-34 / 35-49 / 50+ /
-- unknown (age unset). The client falls back to coarser cells when a cell is thin.
-- NOTE: Android became_active_at is undercounted (no billing events), so Android
-- rates read a bit low.

drop function if exists public.country_conversion_rates();

create function public.country_conversion_rates()
returns table(
  time_zone text,
  platform text,
  age_bucket text,
  total_users int,
  active_users int
)
language sql stable as $$
  select
    coalesce(time_zone, '') as time_zone,
    lower(coalesce(platform, '')) as platform,
    case when age ~ '^[0-9]+$' and age::int > 0 then
           case when age::int <= 24 then '<=24'
                when age::int <= 34 then '25-34'
                when age::int <= 49 then '35-49'
                else '50+' end
         else 'unknown' end as age_bucket,
    count(*)::int as total_users,
    count(became_active_at)::int as active_users
  from user_info
  group by 1, 2, 3;
$$;

grant execute on function public.country_conversion_rates() to anon, authenticated;
notify pgrst, 'reload schema';
