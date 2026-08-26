-- saved_profiles
--
-- Durable store for profiles the admin bookmarks from User Lookup (Saved →
-- Profiles). Replaces the previous localStorage-only store, which was lost
-- whenever the dev server came back on a different port (a different origin =
-- different localStorage). See src/lib/savedProfilesStore.ts — localStorage is
-- now just an instant cache that writes through to this table and is hydrated
-- from it on startup.
--
-- Single-admin internal tool: the app authenticates with the anon key, so the
-- policy grants anon full CRUD. Nothing here isn't already anon-readable via
-- user_info (it only holds bookmark snapshots + notes).

create table if not exists public.saved_profiles (
  user_id uuid primary key,
  saved_at timestamptz not null default now(),
  user_name text,
  payment_status text,
  daily_streak int,
  lessons_count int,
  avg_rating numeric,
  native_language text,
  learning_language text,
  tutor text,
  demand_tier text,
  last_logged_in timestamptz,
  note text not null default ''
);

alter table public.saved_profiles enable row level security;
drop policy if exists "saved_profiles anon all" on public.saved_profiles;
create policy "saved_profiles anon all" on public.saved_profiles for all to anon using (true) with check (true);
grant all on public.saved_profiles to anon;
