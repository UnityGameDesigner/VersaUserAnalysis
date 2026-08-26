// Store for user profiles the admin has bookmarked from User Lookup, each with a
// free-text note. The durable source of truth is the Supabase `saved_profiles`
// table, so saves survive dev-server restarts, port changes, browser-data clears
// and even work across devices. localStorage is kept as an INSTANT sync cache so
// the existing (synchronous) callers stay simple and reads paint immediately;
// every mutation writes through to Supabase, and `loadSavedProfiles()` hydrates
// the cache from the table on startup and when the Saved page opens.

import { supabase } from "./supabase";

export interface SavedProfile {
  userId: string;
  savedAt: string; // when it was bookmarked
  userName: string | null;
  paymentStatus: string | null;
  dailyStreak: number | null;
  lessonsCount: number | null; // completed lessons at save time
  avgRating: number | null; // avg user_rating_feedback at save time
  nativeLanguage: string | null;
  learningLanguage: string | null;
  tutor: string | null;
  demandTier: string | null;
  lastLoggedIn: string | null;
  note: string; // free-text note added by the admin
}

const STORAGE_KEY = "versa-saved-profiles-v1";
const TABLE = "saved_profiles";

// ── localStorage cache (instant, sync) ───────────────────────────────
function readCache(): Record<string, SavedProfile> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeCache(map: Record<string, SavedProfile>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn("Failed to cache saved profiles:", e);
  }
}

// ── row <-> record mapping (snake_case columns <-> camelCase) ─────────
type Row = Record<string, unknown>;
function rowToProfile(r: Row): SavedProfile {
  return {
    userId: String(r.user_id),
    savedAt: (r.saved_at as string) ?? new Date().toISOString(),
    userName: (r.user_name as string) ?? null,
    paymentStatus: (r.payment_status as string) ?? null,
    dailyStreak: r.daily_streak == null ? null : Number(r.daily_streak),
    lessonsCount: r.lessons_count == null ? null : Number(r.lessons_count),
    avgRating: r.avg_rating == null ? null : Number(r.avg_rating),
    nativeLanguage: (r.native_language as string) ?? null,
    learningLanguage: (r.learning_language as string) ?? null,
    tutor: (r.tutor as string) ?? null,
    demandTier: (r.demand_tier as string) ?? null,
    lastLoggedIn: (r.last_logged_in as string) ?? null,
    note: (r.note as string) ?? "",
  };
}
function profileToRow(p: SavedProfile): Row {
  return {
    user_id: p.userId,
    saved_at: p.savedAt,
    user_name: p.userName,
    payment_status: p.paymentStatus,
    daily_streak: p.dailyStreak,
    lessons_count: p.lessonsCount,
    avg_rating: p.avgRating,
    native_language: p.nativeLanguage,
    learning_language: p.learningLanguage,
    tutor: p.tutor,
    demand_tier: p.demandTier,
    last_logged_in: p.lastLoggedIn,
    note: p.note,
  };
}

function sortByNewest(list: SavedProfile[]): SavedProfile[] {
  return list.sort((a, b) => +new Date(b.savedAt) - +new Date(a.savedAt));
}

// ── hydration: pull the durable set from Supabase into the cache ──────
export async function loadSavedProfiles(): Promise<SavedProfile[]> {
  const { data, error } = await supabase.from(TABLE).select("*");
  if (error) {
    console.warn("Failed to load saved profiles from Supabase:", error.message);
    return getAllSavedProfiles(); // fall back to whatever the cache holds
  }
  const map: Record<string, SavedProfile> = {};
  (data ?? []).forEach((r) => {
    const p = rowToProfile(r as Row);
    map[p.userId] = p;
  });
  writeCache(map);
  return sortByNewest(Object.values(map));
}

// ── sync reads (cache-backed) — callers unchanged ────────────────────
export function getSavedProfile(userId: string): SavedProfile | undefined {
  return readCache()[userId];
}

export function isProfileSaved(userId: string): boolean {
  return Object.prototype.hasOwnProperty.call(readCache(), userId);
}

export function getAllSavedProfiles(): SavedProfile[] {
  return sortByNewest(Object.values(readCache()));
}

// ── mutations: update cache immediately, write through to Supabase ───
export function saveProfile(record: SavedProfile): void {
  const map = readCache();
  map[record.userId] = record;
  writeCache(map);
  supabase
    .from(TABLE)
    .upsert(profileToRow(record), { onConflict: "user_id" })
    .then(({ error }) => {
      if (error) console.warn("Failed to persist saved profile:", error.message);
    });
}

// Update just the note on an already-saved profile. No-op if it isn't saved.
export function updateProfileNote(userId: string, note: string): void {
  const map = readCache();
  const existing = map[userId];
  if (!existing) return;
  existing.note = note;
  writeCache(map);
  supabase
    .from(TABLE)
    .update({ note })
    .eq("user_id", userId)
    .then(({ error }) => {
      if (error) console.warn("Failed to persist note:", error.message);
    });
}

export function deleteSavedProfile(userId: string): void {
  const map = readCache();
  delete map[userId];
  writeCache(map);
  supabase
    .from(TABLE)
    .delete()
    .eq("user_id", userId)
    .then(({ error }) => {
      if (error) console.warn("Failed to delete saved profile:", error.message);
    });
}
