-- active_countries_window(hours)
--
-- Powers the world-map heatmap at the top of the All Transcripts page: how many
-- distinct users had a completed lesson in the trailing `hours` window, grouped
-- by their user_info.time_zone. The client maps each timezone to a country (via
-- getCountryFromTimezone) and sums — so the server stays country-agnostic and the
-- tz→country logic lives in one place (src/lib/timezone.ts).
--
-- Trailing-window recency scan is served by idx_completed_lessons_created_at.

create index if not exists idx_completed_lessons_created_at
  on public.completed_lessons (created_at);

drop function if exists public.active_countries_window(int);

create or replace function public.active_countries_window(hours int default 24)
returns table(
  time_zone text,
  users int,
  lessons int
)
language sql stable as $$
  select
    coalesce(u.time_zone, '') as time_zone,
    count(distinct cl.user_id)::int as users,
    count(*)::int as lessons
  from completed_lessons cl
  join user_info u on u.user_id = cl.user_id
  where cl.created_at >= now() - make_interval(hours => greatest(hours, 1))
  group by coalesce(u.time_zone, '');
$$;

grant execute on function public.active_countries_window(int) to anon, authenticated;
notify pgrst, 'reload schema';
