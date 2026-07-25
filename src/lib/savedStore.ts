// localStorage-backed store for transcripts the admin has bookmarked from the
// All Transcripts tab, each with a free-text note for later reference. Mirrors
// evalStore.ts: per-browser by design (single-admin dashboard), and the
// conversation itself is NOT kept here — only lightweight metadata + the note.
// The transcript is re-fetched from Supabase on demand in the Saved tab.

export interface SavedTranscript {
  rowId: number; // completed_lessons.id
  userId: string;
  lessonId: number;
  lessonDate: string; // the lesson's created_at
  savedAt: string; // when it was bookmarked
  userName: string | null;
  endedEarly: boolean;
  rating: number | null; // user_rating_feedback at save time
  // Number of conversational turns in the saved transcript. Optional so records
  // saved before this field existed still load.
  turnCount?: number;
  note: string; // free-text note added by the admin
}

const STORAGE_KEY = "versa-saved-transcripts-v1";

function readAll(): Record<string, SavedTranscript> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, SavedTranscript>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    // Quota exceeded or storage unavailable — the save still holds for this
    // session, it just won't survive a refresh.
    console.warn("Failed to persist saved transcript:", e);
  }
}

export function getSavedTranscript(rowId: number): SavedTranscript | undefined {
  return readAll()[String(rowId)];
}

export function isSaved(rowId: number): boolean {
  return Object.prototype.hasOwnProperty.call(readAll(), String(rowId));
}

export function saveTranscript(record: SavedTranscript): void {
  const map = readAll();
  map[String(record.rowId)] = record;
  writeAll(map);
}

// Update just the note on an already-saved transcript. No-op if it isn't saved.
export function updateNote(rowId: number, note: string): void {
  const map = readAll();
  const existing = map[String(rowId)];
  if (!existing) return;
  existing.note = note;
  writeAll(map);
}

export function deleteSavedTranscript(rowId: number): void {
  const map = readAll();
  delete map[String(rowId)];
  writeAll(map);
}

export function getAllSavedTranscripts(): SavedTranscript[] {
  return Object.values(readAll()).sort(
    (a, b) => +new Date(b.savedAt) - +new Date(a.savedAt),
  );
}
