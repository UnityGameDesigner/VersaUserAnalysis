// localStorage-backed store for user profiles the admin has bookmarked from the
// User Lookup tab, each with a free-text note for later reference. Mirrors
// savedStore.ts: per-browser by design (single-admin dashboard). Only a
// lightweight metadata snapshot + the note is kept here — the live profile and
// its lessons are re-fetched by user_id on demand when you jump back into User
// Lookup, so the snapshot is just what the Saved → Profiles card displays.

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

function readAll(): Record<string, SavedProfile> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, SavedProfile>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    // Quota exceeded or storage unavailable — the save still holds for this
    // session, it just won't survive a refresh.
    console.warn("Failed to persist saved profile:", e);
  }
}

export function getSavedProfile(userId: string): SavedProfile | undefined {
  return readAll()[userId];
}

export function isProfileSaved(userId: string): boolean {
  return Object.prototype.hasOwnProperty.call(readAll(), userId);
}

export function saveProfile(record: SavedProfile): void {
  const map = readAll();
  map[record.userId] = record;
  writeAll(map);
}

// Update just the note on an already-saved profile. No-op if it isn't saved.
export function updateProfileNote(userId: string, note: string): void {
  const map = readAll();
  const existing = map[userId];
  if (!existing) return;
  existing.note = note;
  writeAll(map);
}

export function deleteSavedProfile(userId: string): void {
  const map = readAll();
  delete map[userId];
  writeAll(map);
}

export function getAllSavedProfiles(): SavedProfile[] {
  return Object.values(readAll()).sort(
    (a, b) => +new Date(b.savedAt) - +new Date(a.savedAt),
  );
}
