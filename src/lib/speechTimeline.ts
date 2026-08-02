// Per-lesson "speaking" metrics derived from the student's word_timeline.
//
// The timeline stores, for each student utterance, the transcribed words with
// `start_ms`/`end_ms` offsets that RESET to 0 at the start of every utterance,
// plus a `received_at` epoch. Only WITHIN-utterance timing is reliable —
// received_at uses a mixed/offset clock on some rows (see
// lessonMetrics.estimateLessonDurationMs), so silence *between* turns can't be
// trusted. Every metric here is therefore computed inside a single utterance
// and then aggregated across the lesson.
//
// There is no ASR confidence score on words, so "confidence" is inferred purely
// from timing: faster, less-hesitant, longer answers read as more confident.

export interface WordToken {
  word?: string;
  start_ms?: number;
  end_ms?: number;
}

export interface TimelineSegment {
  id?: string;
  received_at?: number;
  words?: WordToken[];
}

export interface LessonSpeechMetrics {
  /** Speaking rate: student words per minute of speech (within-turn pauses
   *  counted, silence between turns excluded). */
  wpm: number;
  /** 0–1: share of speaking time filled by words rather than mid-sentence pauses. */
  fluency: number;
  /** Mean student words per utterance — willingness to produce longer answers. */
  wordsPerTurn: number;
  /** Median inter-word gap (ms) across counted utterances. */
  medianPauseMs: number;
  /** 0–1: share of counted utterances containing a >= LONG_PAUSE_MS hesitation. */
  longPauseRate: number;
  /** Student words behind the rate figure (utterances of >= MIN_WORDS words). */
  totalWords: number;
  /** Utterances used for the rate/pause figures. */
  utterances: number;
}

// A turn needs a few words before its rate/pauses mean anything — 1–2 word
// replies ("sí", "okay yes") make articulation rate wildly noisy.
const MIN_WORDS = 3;
// A silence this long between two words reads as a hesitation, not natural
// phrasing. Calibrated on real data: median gap ~180ms, p90 ~840ms.
const LONG_PAUSE_MS = 700;
// A lesson needs at least this many qualifying spoken words before it earns a
// point on the trend — otherwise a near-silent lesson would swing the chart.
const MIN_LESSON_WORDS = 8;

function parseTimeline(raw: unknown): TimelineSegment[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? (arr as TimelineSegment[]) : [];
  } catch {
    return [];
  }
}

interface TimedWord {
  start_ms: number;
  end_ms: number;
}

function timedWords(seg: TimelineSegment): TimedWord[] {
  return (seg.words ?? []).filter(
    (w): w is WordToken & TimedWord =>
      typeof w?.start_ms === "number" && typeof w?.end_ms === "number",
  );
}

// Compute the speaking metrics for one lesson from its raw word_timeline.
// Returns null when there isn't enough spoken material to say anything useful,
// so callers can simply drop the lesson from a trend.
export function lessonSpeechMetrics(raw: unknown): LessonSpeechMetrics | null {
  const segs = parseTimeline(raw);
  if (segs.length === 0) return null;

  let totalWords = 0; // across counted (>= MIN_WORDS) utterances — powers the rate
  let totalSpanMs = 0; // summed within-utterance spans
  let totalWordMs = 0; // summed word durations (for the fluency ratio)
  const pauses: number[] = [];
  let counted = 0;
  let longPauseUtterances = 0;

  let allTurnWordSum = 0; // across ALL utterances — powers words-per-turn
  let allTurns = 0;

  for (const seg of segs) {
    const ws = timedWords(seg);
    if (ws.length === 0) continue;
    allTurns += 1;
    allTurnWordSum += ws.length;
    if (ws.length < MIN_WORDS) continue;

    const span = ws[ws.length - 1].end_ms - ws[0].start_ms;
    if (span <= 0) continue;
    counted += 1;
    totalWords += ws.length;
    totalSpanMs += span;

    let hadLong = false;
    for (let i = 0; i < ws.length; i++) {
      totalWordMs += Math.max(0, ws[i].end_ms - ws[i].start_ms);
      if (i > 0) {
        const gap = ws[i].start_ms - ws[i - 1].end_ms;
        if (gap >= 0) pauses.push(gap);
        if (gap >= LONG_PAUSE_MS) hadLong = true;
      }
    }
    if (hadLong) longPauseUtterances += 1;
  }

  if (counted === 0 || totalWords < MIN_LESSON_WORDS || totalSpanMs <= 0) {
    return null;
  }

  pauses.sort((a, b) => a - b);
  const medianPauseMs = pauses.length ? pauses[Math.floor(pauses.length / 2)] : 0;

  return {
    wpm: totalWords / (totalSpanMs / 60000),
    fluency: Math.min(1, totalWordMs / totalSpanMs),
    wordsPerTurn: allTurns ? allTurnWordSum / allTurns : 0,
    medianPauseMs,
    longPauseRate: counted ? longPauseUtterances / counted : 0,
    totalWords,
    utterances: counted,
  };
}

// Least-squares slope/intercept over evenly-spaced points (x = 0,1,2,…). Used
// to draw the trend line and read off net change across a user's lessons.
export function linearTrend(ys: number[]): { slope: number; intercept: number } {
  const n = ys.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (ys[i] - meanY);
    den += (i - meanX) * (i - meanX);
  }
  const slope = den ? num / den : 0;
  return { slope, intercept: meanY - slope * meanX };
}
