import type { CancelAnalysis } from "./analyzeCancellation";

// localStorage-backed cache of per-user cancellation analyses, so a verdict
// survives refreshes, doesn't re-bill the LLM, and lets the Cancel Reasons tab
// accumulate results across runs. Per-browser by design (single-admin dashboard).

export interface SavedCancelAnalysis {
  userId: string;
  analyzedAt: string; // ISO
  userName: string | null;
  lessonCount: number; // real lessons at analysis time (invalidate if it grows a lot)
  analysis: CancelAnalysis;
}

const STORAGE_KEY = "versa-cancel-analyses-v1";

function readAll(): Record<string, SavedCancelAnalysis> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, SavedCancelAnalysis>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn("Failed to persist cancellation analysis:", e);
  }
}

export function getCancelAnalysis(userId: string): SavedCancelAnalysis | undefined {
  return readAll()[userId];
}

export function saveCancelAnalysis(record: SavedCancelAnalysis): void {
  const map = readAll();
  map[record.userId] = record;
  writeAll(map);
}

export function deleteCancelAnalysis(userId: string): void {
  const map = readAll();
  delete map[userId];
  writeAll(map);
}

export function getAllCancelAnalyses(): SavedCancelAnalysis[] {
  return Object.values(readAll()).sort(
    (a, b) => +new Date(b.analyzedAt) - +new Date(a.analyzedAt),
  );
}
