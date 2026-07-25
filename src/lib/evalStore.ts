import type { TutorEvaluation } from "./evaluateTutor";

// localStorage-backed store for tutor evaluations, so a graded conversation
// survives page refreshes and powers the Evaluations tab. Per-browser by
// design — this is a single-admin dashboard.

export interface SavedEvaluation {
  rowId: number; // completed_lessons.id
  userId: string;
  lessonId: number;
  lessonDate: string; // the lesson's created_at
  evaluatedAt: string; // when the evaluation ran
  userName: string | null;
  endedEarly: boolean;
  // Number of conversational turns (messages) in the graded transcript.
  // Optional so evaluations saved before this field was added still load.
  turnCount?: number;
  evaluation: TutorEvaluation;
}

const STORAGE_KEY = "versa-tutor-evals-v1";

function readAll(): Record<string, SavedEvaluation> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, SavedEvaluation>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    // Quota exceeded or storage unavailable — the evaluation still shows for
    // this session, it just won't survive a refresh.
    console.warn("Failed to persist tutor evaluation:", e);
  }
}

export function getSavedEvaluation(rowId: number): SavedEvaluation | undefined {
  return readAll()[String(rowId)];
}

export function saveEvaluation(record: SavedEvaluation): void {
  const map = readAll();
  map[String(record.rowId)] = record;
  writeAll(map);
}

export function deleteEvaluation(rowId: number): void {
  const map = readAll();
  delete map[String(rowId)];
  writeAll(map);
}

export function getAllEvaluations(): SavedEvaluation[] {
  return Object.values(readAll()).sort(
    (a, b) => +new Date(b.evaluatedAt) - +new Date(a.evaluatedAt),
  );
}
