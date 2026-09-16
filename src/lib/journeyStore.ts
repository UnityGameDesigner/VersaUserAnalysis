import type { JourneyEvaluation } from "./evaluateJourney";

// localStorage-backed store for Learning Journey evaluations, keyed by user_id, so
// a judged journey survives refreshes and the cohort runner never re-bills a user
// whose lesson count hasn't changed. Per-browser by design (single-admin dashboard).

export interface SavedJourney {
  userId: string;
  evaluatedAt: string;
  lessonCount: number; // how many lessons were judged — re-judge when this grows
  userName: string | null;
  converted: boolean;
  evaluation: JourneyEvaluation;
}

const STORAGE_KEY = "versa-journey-evals-v1";

function readAll(): Record<string, SavedJourney> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, SavedJourney>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn("Failed to persist journey evaluation:", e);
  }
}

export function getSavedJourney(userId: string): SavedJourney | undefined {
  return readAll()[userId];
}

export function saveJourney(record: SavedJourney): void {
  const map = readAll();
  map[record.userId] = record;
  writeAll(map);
}

export function getAllJourneys(): SavedJourney[] {
  return Object.values(readAll()).sort(
    (a, b) => +new Date(b.evaluatedAt) - +new Date(a.evaluatedAt),
  );
}
