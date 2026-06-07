// Shared per-lesson metric helpers, used by the All Transcripts and Lessons
// tabs so both render identical speaking-ratio and duration figures.

export interface TranscriptMessage {
  role: string;
  text: string;
}

export function parseTranscript(raw: unknown): TranscriptMessage[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (m: unknown): m is { role: string; text: string } =>
          typeof m === "object" &&
          m !== null &&
          "text" in m &&
          typeof (m as Record<string, unknown>).text === "string",
      )
      .filter((m) => m.role !== "ack")
      .map((m) => ({ role: m.role ?? "unknown", text: m.text }));
  } catch {
    return [];
  }
}

// "Speech volume" of a message, measured in non-whitespace characters. We use
// characters rather than splitting on spaces because several taught languages —
// Thai, Chinese, Japanese — don't separate words with whitespace, so a
// word-split wildly undercounts them and skews the ratio (e.g. a full Thai
// tutor sentence counting as ~4 "words"). Spread to count Unicode code points.
function speechLength(text: string): number {
  return [...text.replace(/\s+/g, "")].length;
}

// Student-to-teacher speaking ratio for a conversation, measured by characters
// spoken. The student is the "user" role; the teacher is everything else
// (assistant/tutor). `ratio` is student/teacher characters, or null when the
// teacher said nothing (avoids divide-by-zero). `studentShare` is the fraction
// of all characters spoken by the student (0–1).
export function speakingRatio(messages: TranscriptMessage[]): {
  studentChars: number;
  teacherChars: number;
  ratio: number | null;
  studentShare: number | null;
} {
  let studentChars = 0;
  let teacherChars = 0;
  for (const m of messages) {
    const len = speechLength(m.text);
    if (m.role === "user") studentChars += len;
    else teacherChars += len;
  }
  const total = studentChars + teacherChars;
  return {
    studentChars,
    teacherChars,
    ratio: teacherChars > 0 ? studentChars / teacherChars : null,
    studentShare: total > 0 ? studentChars / total : null,
  };
}

// A word_timeline segment: the student's transcribed speech for one utterance.
// `received_at` is a wall-clock epoch (ms) for that utterance; word `end_ms`
// values are offsets relative to the start of that utterance (they reset to 0
// each segment), so they can't be compared across segments.
interface TimelineSegment {
  received_at?: number;
  words?: { start_ms?: number; end_ms?: number }[];
}

function parseTimeline(raw: unknown): TimelineSegment[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? (arr as TimelineSegment[]) : [];
  } catch {
    return [];
  }
}

// Estimate a lesson's wall-clock length (ms) from the student's word_timeline.
// word_timeline only captures the student's speech, so we measure the span
// between the first and last student utterance (by received_at) plus the length
// of that final utterance. This is a LOWER BOUND on the true lesson length: it
// excludes the tutor's opening before the student first speaks and the wrap-up
// after the student's last word.
//
// Only within-row received_at deltas are used — some rows store received_at on
// an offset clock, but the span within a single row stays internally consistent
// (verified: summed active talk time never exceeds the span). A sanity ceiling
// guards against any mixed-clock corruption, falling back to active talk time.
export function estimateLessonDurationMs(raw: unknown): number | null {
  const segs = parseTimeline(raw);
  if (segs.length === 0) return null;

  const segDuration = (s: TimelineSegment) =>
    (s.words ?? []).reduce((m, w) => Math.max(m, w.end_ms ?? 0), 0);
  const activeTalk = segs.reduce((sum, s) => sum + segDuration(s), 0);

  const stamped = segs.filter((s) => typeof s.received_at === "number");
  if (stamped.length === 0) return activeTalk || null;

  let min = Infinity;
  let max = -Infinity;
  let lastSeg = stamped[0];
  for (const s of stamped) {
    const t = s.received_at as number;
    if (t < min) min = t;
    if (t > max) {
      max = t;
      lastSeg = s;
    }
  }
  const span = max - min + segDuration(lastSeg);

  // A span over 4h is implausible (mixed clocks) — fall back to active talk.
  const CEILING_MS = 4 * 60 * 60 * 1000;
  if (span < 0 || span > CEILING_MS) return activeTalk || null;
  return span;
}

// Format a duration in ms as "Mm Ss" (or "Ss" when under a minute).
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
