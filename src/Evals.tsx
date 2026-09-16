import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ComposedChart,
  LineChart,
  BarChart,
  Bar,
  Line,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { format, subDays } from "date-fns";
import { supabase } from "./lib/supabase";
import { evaluateTutor, scoreVariant, type TutorEvaluation } from "./lib/evaluateTutor";
import { parseTranscript } from "./lib/lessonMetrics";
import { getSavedEvaluation, saveEvaluation, getAllEvaluations, type SavedEvaluation } from "./lib/evalStore";
import {
  evaluateJourney,
  JOURNEY_DIMENSIONS,
  type JourneyEvaluation,
  type JourneyLesson,
} from "./lib/evaluateJourney";
import { getSavedJourney, saveJourney } from "./lib/journeyStore";
import TutorEvalPanel from "./TutorEvalPanel";
import { Conversation } from "./Feedback";

// "Evals" — daily lesson-quality tracking. Two layers:
//  1. Cheap per-day metrics over ALL lessons (lesson_daily_evals RPC): star
//     ratings, conversation length, early-end / silent / never-connected rates,
//     tutor response latency, written-feedback rate.
//  2. An on-demand LLM-judged random sample for a chosen day (lesson_eval_sample
//     RPC + the existing evaluateTutor rubric) — grades the TUTOR 1–10 and shows
//     per-lesson rationale. Results are cached in evalStore (localStorage), shared
//     with the Evaluations tab, so a lesson is never re-judged (or re-billed).

interface DailyRow {
  d: string;
  lessons: number;
  rated: number;
  avg_rating: number | null;
  rating_hist: number[]; // [1★,2★,3★,4★,5★]
  neg: number;
  avg_turns: number | null;
  early: number;
  silent: number;
  never_connected: number;
  text_feedback: number;
  avg_latency_ms: number | null;
}

interface SampleRow {
  id: number;
  session_id: string | null;
  user_id: string;
  lesson_id: number | null;
  created_at: string;
  user_rating_feedback: number | null;
  ended_early: boolean;
  early_end_reason: string | null;
  exit_phase: string | null;
  turns: number;
  preferred_name: string | null;
  learning_language: string | null;
  native_language: string | null;
  level: string | null;
  reason: string | null;
  conversation_transcript: unknown;
}

interface JudgedItem {
  row: SampleRow;
  status: "pending" | "done" | "error";
  evaluation?: TutorEvaluation;
  error?: string;
  cached?: boolean; // loaded from a prior judgement (not re-billed)
}

// One engaged user in the Learning Journey cohort run.
interface JourneyItem {
  userId: string;
  name: string | null;
  lessons: number;
  converted: boolean;
  learning: string | null;
  level: string | null;
  native: string | null;
  reason: string | null;
  status: "pending" | "done" | "error";
  journey?: JourneyEvaluation;
  error?: string;
  cached?: boolean;
}

const RATING_COLORS = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e"]; // 1★→5★
const JUDGE_CONCURRENCY = 4; // parallel LLM calls for a single day
const RANGE_CONCURRENCY = 6; // parallel LLM calls when judging a whole range
const iso = (d: Date) => format(d, "yyyy-MM-dd");

// Coerce one lesson_eval_sample RPC row into a SampleRow (used by both the
// single-day sample and the range judge).
function mapSampleRow(r: Record<string, unknown>): SampleRow {
  return {
    id: Number(r.id),
    session_id: (r.session_id as string) ?? null,
    user_id: String(r.user_id),
    lesson_id: r.lesson_id == null ? null : Number(r.lesson_id),
    created_at: String(r.created_at),
    user_rating_feedback: r.user_rating_feedback == null ? null : Number(r.user_rating_feedback),
    ended_early: Boolean(r.ended_early),
    early_end_reason: (r.early_end_reason as string) ?? null,
    exit_phase: (r.exit_phase as string) ?? null,
    turns: Number(r.turns ?? 0),
    preferred_name: (r.preferred_name as string) ?? null,
    learning_language: (r.learning_language as string) ?? null,
    native_language: (r.native_language as string) ?? null,
    level: (r.level as string) ?? null,
    reason: (r.reason as string) ?? null,
    conversation_transcript: r.conversation_transcript,
  };
}

const Evals: React.FC<{ onUserClick?: (userId: string) => void }> = ({ onUserClick }) => {
  // ── Daily metrics ──────────────────────────────────────────────────────────
  const [fromDate, setFromDate] = useState(() => iso(subDays(new Date(), 13)));
  const [toDate, setToDate] = useState(() => iso(new Date()));
  const [applied, setApplied] = useState({ from: iso(subDays(new Date(), 13)), to: iso(new Date()) });
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Saved LLM judgements (localStorage, shared with the Evaluations tab) — drives
  // the per-day LLM-quality trend, reconstructed by lesson date so it survives reloads.
  const [savedEvals, setSavedEvals] = useState<SavedEvaluation[]>(() => getAllEvaluations());
  const [rangeJudging, setRangeJudging] = useState(false);
  const [rangeProg, setRangeProg] = useState<{ done: number; total: number } | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const fetchDaily = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc("lesson_daily_evals", {
        start_date: applied.from || null,
        end_date: applied.to || null,
      });
      if (error) throw new Error(error.message);
      const mapped: DailyRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
        d: String(r.d),
        lessons: Number(r.lessons ?? 0),
        rated: Number(r.rated ?? 0),
        avg_rating: r.avg_rating == null ? null : Number(r.avg_rating),
        rating_hist: ((r.rating_hist as number[]) ?? []).map((v) => Number(v)),
        neg: Number(r.neg ?? 0),
        avg_turns: r.avg_turns == null ? null : Number(r.avg_turns),
        early: Number(r.early ?? 0),
        silent: Number(r.silent ?? 0),
        never_connected: Number(r.never_connected ?? 0),
        text_feedback: Number(r.text_feedback ?? 0),
        avg_latency_ms: r.avg_latency_ms == null ? null : Number(r.avg_latency_ms),
      }));
      setRows(mapped);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    fetchDaily();
  }, [fetchDaily]);

  // Debounce the date inputs.
  useEffect(() => {
    const t = setTimeout(() => setApplied({ from: fromDate, to: toDate }), 500);
    return () => clearTimeout(t);
  }, [fromDate, toDate]);

  const applyPreset = (days: number) => {
    setFromDate(iso(subDays(new Date(), days - 1)));
    setToDate(iso(new Date()));
  };

  const todayIso = iso(new Date());

  const chart = useMemo(
    () =>
      rows.map((r) => ({
        d: r.d,
        label: format(new Date(r.d + "T00:00:00"), "MMM d"),
        lessons: r.lessons,
        avg_rating: r.avg_rating ?? 0,
        avg_turns: r.avg_turns ?? 0,
        latency_s: r.avg_latency_ms != null ? Math.round((r.avg_latency_ms / 1000) * 10) / 10 : 0,
        pct_early: r.lessons ? Math.round((1000 * r.early) / r.lessons) / 10 : 0,
        pct_silent: r.lessons ? Math.round((1000 * r.silent) / r.lessons) / 10 : 0,
        pct_never: r.lessons ? Math.round((1000 * r.never_connected) / r.lessons) / 10 : 0,
        pct_neg: r.rated ? Math.round((1000 * r.neg) / r.rated) / 10 : 0,
        partial: r.d === todayIso,
      })),
    [rows, todayIso],
  );

  const summary = useMemo(() => {
    const lessons = rows.reduce((a, r) => a + r.lessons, 0);
    const rated = rows.reduce((a, r) => a + r.rated, 0);
    const hist = [0, 0, 0, 0, 0];
    for (const r of rows) for (let i = 0; i < 5; i++) hist[i] += r.rating_hist[i] ?? 0;
    const ratingSum = hist.reduce((a, c, i) => a + c * (i + 1), 0);
    const early = rows.reduce((a, r) => a + r.early, 0);
    const silent = rows.reduce((a, r) => a + r.silent, 0);
    const neverc = rows.reduce((a, r) => a + r.never_connected, 0);
    const neg = rows.reduce((a, r) => a + r.neg, 0);
    const text = rows.reduce((a, r) => a + r.text_feedback, 0);
    const latWeighted = rows.reduce((a, r) => a + (r.avg_latency_ms ?? 0) * r.lessons, 0);
    const turnsWeighted = rows.reduce((a, r) => a + (r.avg_turns ?? 0) * r.lessons, 0);
    return {
      lessons,
      rated,
      hist,
      avgRating: rated ? ratingSum / rated : null,
      pctRated: lessons ? (100 * rated) / lessons : 0,
      pctEarly: lessons ? (100 * early) / lessons : 0,
      pctSilent: lessons ? (100 * silent) / lessons : 0,
      pctNever: lessons ? (100 * neverc) / lessons : 0,
      pctNeg: rated ? (100 * neg) / rated : 0,
      pctText: lessons ? (100 * text) / lessons : 0,
      avgLatencyS: lessons ? latWeighted / lessons / 1000 : 0,
      avgTurns: lessons ? turnsWeighted / lessons : 0,
    };
  }, [rows]);

  const ratingDist = useMemo(
    () =>
      summary.hist.map((count, i) => ({
        star: `${i + 1}★`,
        count,
        pct: summary.rated ? Math.round((1000 * count) / summary.rated) / 10 : 0,
      })),
    [summary],
  );

  // Per-day LLM tutor-quality score, reconstructed from saved judgements whose
  // lesson date falls in the current range (survives reloads via evalStore).
  const llmByDay = useMemo(() => {
    const m = new Map<string, { sum: number; n: number }>();
    for (const e of savedEvals) {
      const day = format(new Date(e.lessonDate), "yyyy-MM-dd");
      if (applied.from && day < applied.from) continue;
      if (applied.to && day > applied.to) continue;
      const cur = m.get(day) ?? { sum: 0, n: 0 };
      cur.sum += e.evaluation.overall_score;
      cur.n += 1;
      m.set(day, cur);
    }
    return m;
  }, [savedEvals, applied]);

  const llmTrend = useMemo(
    () =>
      rows.map((r) => {
        const agg = llmByDay.get(r.d);
        return {
          d: r.d,
          label: format(new Date(r.d + "T00:00:00"), "MMM d"),
          llm_score: agg ? Math.round((agg.sum / agg.n) * 10) / 10 : null,
          llm_n: agg?.n ?? 0,
        };
      }),
    [rows, llmByDay],
  );

  const rangeStats = useMemo(() => {
    let sum = 0;
    let n = 0;
    let days = 0;
    for (const v of llmByDay.values()) {
      sum += v.sum;
      n += v.n;
      days += 1;
    }
    return { avg: n ? sum / n : null, judged: n, days };
  }, [llmByDay]);

  // ── LLM-judged sample ────────────────────────────────────────────────────────
  const [selectedDay, setSelectedDay] = useState(() => iso(subDays(new Date(), 1)));
  const [sampleSize, setSampleSize] = useState(10);
  const [minTurns] = useState(4);
  const [items, setItems] = useState<JudgedItem[]>([]);
  const [judging, setJudging] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const sampleRef = useRef<HTMLDivElement>(null);

  const updateItem = (idx: number, patch: Partial<JudgedItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const judgeRows = useCallback(async (sample: SampleRow[]) => {
    // Seed from cache; only uncached rows hit the API.
    const initial: JudgedItem[] = sample.map((row) => {
      const cached = getSavedEvaluation(row.id);
      return cached
        ? { row, status: "done" as const, evaluation: cached.evaluation, cached: true }
        : { row, status: "pending" as const };
    });
    setItems(initial);

    const pending = initial
      .map((it, idx) => ({ it, idx }))
      .filter((x) => x.it.status === "pending");
    if (pending.length === 0) return;

    setJudging(true);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const k = next++;
        if (k >= pending.length) return;
        const idx = pending[k].idx;
        const row = sample[idx];
        const messages = parseTranscript(row.conversation_transcript);
        if (messages.length === 0) {
          updateItem(idx, { status: "error", error: "No transcript to grade." });
          continue;
        }
        try {
          const ev = await evaluateTutor(messages, {
            learningLanguage: row.learning_language,
            nativeLanguage: row.native_language,
            level: row.level,
            reason: row.reason,
            endedEarly: row.ended_early,
          });
          saveEvaluation({
            rowId: row.id,
            userId: row.user_id,
            lessonId: row.lesson_id ?? 0,
            lessonDate: row.created_at,
            evaluatedAt: new Date().toISOString(),
            userName: row.preferred_name,
            endedEarly: row.ended_early,
            turnCount: messages.length,
            evaluation: ev,
          });
          updateItem(idx, { status: "done", evaluation: ev });
        } catch (e) {
          updateItem(idx, { status: "error", error: e instanceof Error ? e.message : String(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(JUDGE_CONCURRENCY, pending.length) }, worker));
    setJudging(false);
    setSavedEvals(getAllEvaluations()); // refresh the LLM-quality trend
  }, []);

  // Judge a random sample of EVERY day in the loaded range and build the per-day
  // LLM-quality trend. Fetches each day's sample, then judges the uncached lessons
  // through one global worker pool; already-judged lessons are skipped (not re-billed).
  const judgeRange = useCallback(async () => {
    if (rows.length === 0 || rangeJudging) return;
    setRangeJudging(true);
    setRangeError(null);
    setRangeProg(null);
    try {
      const days = rows.map((r) => r.d);
      // Pull each day's sample (bounded concurrency).
      const samples: SampleRow[] = [];
      let di = 0;
      const fetchWorker = async (): Promise<void> => {
        for (;;) {
          const k = di++;
          if (k >= days.length) return;
          const { data, error } = await supabase.rpc("lesson_eval_sample", {
            day: days[k],
            sample_size: sampleSize,
            min_turns: minTurns,
          });
          if (error) throw new Error(error.message);
          for (const r of (data ?? []) as Record<string, unknown>[]) samples.push(mapSampleRow(r));
        }
      };
      await Promise.all(Array.from({ length: Math.min(5, days.length) }, fetchWorker));

      const toJudge = samples.filter((r) => !getSavedEvaluation(r.id));
      let done = 0;
      setRangeProg({ done: 0, total: toJudge.length });
      if (toJudge.length === 0) {
        setSavedEvals(getAllEvaluations());
        return;
      }
      let ji = 0;
      const judgeWorker = async (): Promise<void> => {
        for (;;) {
          const k = ji++;
          if (k >= toJudge.length) return;
          const row = toJudge[k];
          const messages = parseTranscript(row.conversation_transcript);
          if (messages.length > 0) {
            try {
              const ev = await evaluateTutor(messages, {
                learningLanguage: row.learning_language,
                nativeLanguage: row.native_language,
                level: row.level,
                reason: row.reason,
                endedEarly: row.ended_early,
              });
              saveEvaluation({
                rowId: row.id,
                userId: row.user_id,
                lessonId: row.lesson_id ?? 0,
                lessonDate: row.created_at,
                evaluatedAt: new Date().toISOString(),
                userName: row.preferred_name,
                endedEarly: row.ended_early,
                turnCount: messages.length,
                evaluation: ev,
              });
            } catch {
              // one failed lesson shouldn't sink the batch
            }
          }
          done += 1;
          setRangeProg({ done, total: toJudge.length });
          if (done % 10 === 0) setSavedEvals(getAllEvaluations()); // progressive trend
        }
      };
      await Promise.all(Array.from({ length: Math.min(RANGE_CONCURRENCY, toJudge.length) }, judgeWorker));
      setSavedEvals(getAllEvaluations());
    } catch (e) {
      setRangeError(e instanceof Error ? e.message : String(e));
    } finally {
      setRangeJudging(false);
    }
  }, [rows, rangeJudging, sampleSize, minTurns]);

  const runSample = useCallback(
    async (day: string) => {
      setSampleError(null);
      setItems([]);
      try {
        const { data, error } = await supabase.rpc("lesson_eval_sample", {
          day,
          sample_size: sampleSize,
          min_turns: minTurns,
        });
        if (error) throw new Error(error.message);
        const sample: SampleRow[] = (data ?? []).map((r: Record<string, unknown>) => mapSampleRow(r));
        if (sample.length === 0) {
          setSampleError("No gradeable lessons found for this day (need array transcripts with ≥4 turns).");
          return;
        }
        await judgeRows(sample);
      } catch (e) {
        setSampleError(e instanceof Error ? e.message : String(e));
      }
    },
    [sampleSize, minTurns, judgeRows],
  );

  const judgeFromTable = (day: string) => {
    setSelectedDay(day);
    sampleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    runSample(day);
  };

  const sampleStats = useMemo(() => {
    const done = items.filter((it) => it.status === "done" && it.evaluation);
    const scores = done.map((it) => it.evaluation!.overall_score);
    const bands = { good: 0, mid: 0, bad: 0 };
    for (const s of scores) bands[scoreVariant(s) as "good" | "mid" | "bad"] += 1;
    return {
      total: items.length,
      done: done.length,
      errored: items.filter((it) => it.status === "error").length,
      avg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      bands,
    };
  }, [items]);

  // ── Learning Journey cohort — does the journey score separate converters? ──────
  const [jMinLessons, setJMinLessons] = useState(5);
  const [jSample, setJSample] = useState(20);
  const [jItems, setJItems] = useState<JourneyItem[]>([]);
  const [jRunning, setJRunning] = useState(false);
  const [jProg, setJProg] = useState<{ done: number; total: number } | null>(null);
  const [jError, setJError] = useState<string | null>(null);

  const runJourneyCohort = useCallback(async () => {
    if (jRunning) return;
    setJRunning(true);
    setJError(null);
    setJProg(null);
    setJItems([]);
    try {
      const { data, error } = await supabase.rpc("engaged_users", {
        min_lessons: jMinLessons,
        since_days: 45,
        max_rows: jSample,
      });
      if (error) throw new Error(error.message);
      const items: JourneyItem[] = ((data ?? []) as Record<string, unknown>[]).map((r) => {
        const userId = String(r.user_id);
        const cached = getSavedJourney(userId);
        return {
          userId,
          name: (r.preferred_name as string) ?? null,
          lessons: Number(r.lessons ?? 0),
          converted: r.became_active_at != null,
          learning: (r.learning_language as string) ?? null,
          level: (r.level as string) ?? null,
          native: (r.native_language as string) ?? null,
          reason: (r.reason as string) ?? null,
          status: cached ? "done" : "pending",
          journey: cached?.evaluation,
          cached: !!cached,
        };
      });
      setJItems(items);
      const pending = items.map((it, i) => ({ it, i })).filter((x) => x.it.status === "pending");
      let done = 0;
      setJProg({ done: 0, total: pending.length });
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const k = next++;
          if (k >= pending.length) return;
          const idx = pending[k].i;
          const it = items[idx];
          try {
            const { data: ld, error: le } = await supabase.rpc("user_lesson_journey", {
              p_user_id: it.userId,
              max_lessons: 20,
            });
            if (le) throw new Error(le.message);
            const lessons: JourneyLesson[] = ((ld ?? []) as Record<string, unknown>[])
              .map((r) => ({
                date: String(r.created_at),
                turns: Number(r.turns ?? 0),
                rating: r.user_rating_feedback == null ? null : Number(r.user_rating_feedback),
                endedEarly: Boolean(r.ended_early),
                messages: parseTranscript(r.conversation_transcript),
              }))
              .filter((l) => l.messages.length > 0);
            if (lessons.length < 3) {
              setJItems((prev) => prev.map((x, i) => (i === idx ? { ...x, status: "error", error: "too few gradeable lessons" } : x)));
            } else {
              const jev = await evaluateJourney(lessons, {
                name: it.name,
                learningLanguage: it.learning,
                level: it.level,
                nativeLanguage: it.native,
                reason: it.reason,
              });
              saveJourney({
                userId: it.userId,
                evaluatedAt: new Date().toISOString(),
                lessonCount: lessons.length,
                userName: it.name,
                converted: it.converted,
                evaluation: jev,
              });
              setJItems((prev) => prev.map((x, i) => (i === idx ? { ...x, status: "done", journey: jev } : x)));
            }
          } catch (e) {
            setJItems((prev) => prev.map((x, i) => (i === idx ? { ...x, status: "error", error: e instanceof Error ? e.message : String(e) } : x)));
          }
          done += 1;
          setJProg({ done, total: pending.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, pending.length || 1) }, worker));
    } catch (e) {
      setJError(e instanceof Error ? e.message : String(e));
    } finally {
      setJRunning(false);
    }
  }, [jRunning, jMinLessons, jSample]);

  const jStats = useMemo(() => {
    const done = jItems.filter((it) => it.status === "done" && it.journey);
    const conv = done.filter((it) => it.converted);
    const notc = done.filter((it) => !it.converted);
    const mean = (xs: JourneyItem[]) => (xs.length ? xs.reduce((a, it) => a + it.journey!.overall_score, 0) / xs.length : null);
    const dimMean = (xs: JourneyItem[], dim: string) => {
      const vals = xs
        .map((it) => it.journey!.dimensions.find((d) => d.dimension === dim)?.score)
        .filter((v): v is number => typeof v === "number");
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    return {
      done: done.length,
      convAvg: mean(conv),
      notAvg: mean(notc),
      convN: conv.length,
      notN: notc.length,
      dims: JOURNEY_DIMENSIONS.map((d) => ({ dim: d, conv: dimMean(conv, d), not: dimMean(notc, d) })),
    };
  }, [jItems]);

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title" style={{ margin: 0 }}>
        Evals
        {summary.lessons > 0 && (
          <span className="lessons-detail-count">
            {summary.lessons.toLocaleString()} lessons · {summary.avgRating?.toFixed(2) ?? "—"}★ avg
          </span>
        )}
      </h2>
      <p className="ret-chart-sub" style={{ marginTop: "0.4rem", maxWidth: "80ch" }}>
        Daily lesson-quality metrics over every completed lesson, plus an on-demand{" "}
        <strong>LLM-judged random sample</strong> for any day. Today is a partial day (still filling in).
      </p>

      {/* Range controls */}
      <div className="controls-bar" style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginTop: "1rem" }}>
        <div className="ret-seg" role="group" aria-label="Quick range">
          <button className="ret-seg-btn" onClick={() => applyPreset(7)}>7d</button>
          <button className="ret-seg-btn" onClick={() => applyPreset(14)}>14d</button>
          <button className="ret-seg-btn" onClick={() => applyPreset(30)}>30d</button>
        </div>
        <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          From
          <input className="filter-select" type="date" value={fromDate} max={toDate} onChange={(e) => setFromDate(e.target.value)} />
        </label>
        <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          To
          <input className="filter-select" type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
        <button
          className="transcript-toggle transcript-toggle--eval"
          style={{ marginLeft: "auto" }}
          onClick={judgeRange}
          disabled={rangeJudging || loading}
          title="Sample and LLM-judge lessons for every day in this range, then plot the per-day tutor-quality score. Already-judged lessons are reused, not re-billed."
        >
          {rangeJudging
            ? rangeProg
              ? `Judging ${rangeProg.done}/${rangeProg.total}…`
              : "Sampling days…"
            : `Judge range · ${sampleSize}/day`}
        </button>
        {rangeError && <span className="eval-error" style={{ marginLeft: "0.5rem" }}>{rangeError}</span>}
      </div>

      {error && (
        <div className="error-box" style={{ margin: "1rem 0" }}>
          <p>Failed to load: {error}</p>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Computing daily metrics…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty-state" style={{ padding: "2rem" }}>No lessons in this range.</div>
      ) : (
        <>
          {/* Summary cards */}
          <section className="metrics-grid" style={{ marginTop: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <div className="metric-card">
              <div className="metric-value">{summary.avgRating?.toFixed(2) ?? "—"}★</div>
              <div className="metric-label">Avg Rating</div>
              <div className="metric-description">{summary.rated.toLocaleString()} rated ({summary.pctRated.toFixed(0)}% of lessons)</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{summary.pctNeg.toFixed(1)}%</div>
              <div className="metric-label">Negative (1–2★)</div>
              <div className="metric-description">Share of rated lessons</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{summary.avgTurns.toFixed(1)}</div>
              <div className="metric-label">Avg Conversation Length</div>
              <div className="metric-description">Messages per lesson</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{summary.pctEarly.toFixed(1)}%</div>
              <div className="metric-label">Ended Early</div>
              <div className="metric-description">Learner hung up before the end</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{summary.pctSilent.toFixed(1)}%</div>
              <div className="metric-label">Silent Lessons</div>
              <div className="metric-description">Connected but learner never spoke</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{summary.pctNever.toFixed(1)}%</div>
              <div className="metric-label">Never Connected</div>
              <div className="metric-description">Call failed to start</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{summary.avgLatencyS.toFixed(1)}s</div>
              <div className="metric-label">Avg Tutor Latency</div>
              <div className="metric-description">Response time per turn</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{summary.lessons.toLocaleString()}</div>
              <div className="metric-label">Lessons</div>
              <div className="metric-description">In selected range</div>
            </div>
            {rangeStats.judged > 0 && (
              <div className="metric-card">
                <div className="metric-value">{rangeStats.avg?.toFixed(1)}/10</div>
                <div className="metric-label">Avg LLM Score</div>
                <div className="metric-description">{rangeStats.judged.toLocaleString()} judged · {rangeStats.days} days</div>
              </div>
            )}
          </section>

          {/* Rating & volume */}
          <div className="chart-container" style={{ marginTop: "1.25rem" }}>
            <h3>Avg star rating &amp; volume per day</h3>
            <p className="ret-chart-sub">Bars = lessons completed; line = average star rating (1–5, right axis) among rated lessons.</p>
            <div style={{ width: "100%", height: 300 }}>
              <ResponsiveContainer>
                <ComposedChart data={chart} margin={{ top: 12, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={8} />
                  <YAxis yAxisId="left" tick={{ fontSize: 12 }} width={44} allowDecimals={false} />
                  <YAxis yAxisId="right" orientation="right" domain={[0, 5]} tick={{ fontSize: 12 }} width={30} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Legend />
                  <Bar yAxisId="left" dataKey="lessons" name="Lessons" fill="#c7d2fe" isAnimationActive={false} radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="avg_rating" name="Avg rating" stroke="#4f46e5" strokeWidth={2.5} dot={{ r: 2 }} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* LLM tutor-quality trend (only after judging a range/day) */}
          {rangeStats.judged > 0 && (
            <div className="chart-container" style={{ marginTop: "1.25rem" }}>
              <h3>LLM tutor-quality score per day</h3>
              <p className="ret-chart-sub">
                Average rubric score (1–10) of each day's LLM-judged sample ({sampleSize}/day) — an estimate; hover for how many lessons were judged.
              </p>
              <div style={{ width: "100%", height: 260 }}>
                <ResponsiveContainer>
                  <LineChart data={llmTrend} margin={{ top: 10, right: 16, bottom: 8, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={8} />
                    <YAxis domain={[0, 10]} tick={{ fontSize: 12 }} width={36} />
                    <Tooltip
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      formatter={(v: number | undefined) => [`${v ?? 0}/10`, "Avg LLM score"]}
                      labelFormatter={(l) => {
                        const row = llmTrend.find((r) => r.label === String(l));
                        return row ? `${String(l)} · ${row.llm_n} judged` : String(l);
                      }}
                    />
                    <Line type="monotone" dataKey="llm_score" name="Avg LLM score" stroke="#7c3aed" strokeWidth={2.5} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Quality issues */}
          <div className="chart-container" style={{ marginTop: "1.25rem" }}>
            <h3>Failure signals per day (% of lessons)</h3>
            <p className="ret-chart-sub">
              Ended early, silent (connected but the learner never spoke), and never-connected — lower is better.
              Negative-rating % is out of rated lessons.
            </p>
            <div style={{ width: "100%", height: 280 }}>
              <ResponsiveContainer>
                <LineChart data={chart} margin={{ top: 10, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={8} />
                  <YAxis tick={{ fontSize: 12 }} width={40} unit="%" />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: number | undefined) => `${v ?? 0}%`} />
                  <Legend />
                  <Line type="monotone" dataKey="pct_early" name="Ended early" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="pct_silent" name="Silent" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="pct_never" name="Never connected" stroke="#8b5cf6" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="pct_neg" name="Negative rating" stroke="#dc2626" strokeWidth={1.6} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Engagement: turns + latency */}
          <div className="chart-container" style={{ marginTop: "1.25rem" }}>
            <h3>Conversation length &amp; tutor latency</h3>
            <p className="ret-chart-sub">Avg messages per lesson (left) and avg tutor response latency in seconds (right).</p>
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <ComposedChart data={chart} margin={{ top: 10, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={8} />
                  <YAxis yAxisId="left" tick={{ fontSize: 12 }} width={40} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} width={36} unit="s" />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Legend />
                  <Line yAxisId="left" type="monotone" dataKey="avg_turns" name="Avg turns" stroke="#0891b2" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  <Line yAxisId="right" type="monotone" dataKey="latency_s" name="Tutor latency (s)" stroke="#e11d48" strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Rating distribution */}
          <div className="chart-container" style={{ marginTop: "1.25rem" }}>
            <h3>Rating distribution (whole range)</h3>
            <p className="ret-chart-sub">{summary.rated.toLocaleString()} rated lessons.</p>
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={ratingDist} margin={{ top: 16, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                  <XAxis dataKey="star" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} width={48} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: number | undefined, _n, p) => [`${(v ?? 0).toLocaleString()} (${(p?.payload as { pct?: number })?.pct ?? 0}%)`, "Lessons"]} cursor={{ fill: "rgba(79,70,229,0.06)" }} />
                  <Bar dataKey="count" isAnimationActive={false} radius={[4, 4, 0, 0]}>
                    {ratingDist.map((_, i) => (
                      <Cell key={i} fill={RATING_COLORS[i]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Daily table */}
          <div className="table-container" style={{ marginTop: "1.25rem" }}>
            <table className="data-table">
              <thead className="table-head">
                <tr>
                  <th>Day</th>
                  <th title="Lessons completed">Lessons</th>
                  <th title="Average star rating among rated lessons">Avg ★</th>
                  <th title="Share of rated lessons that were 1–2★">Neg</th>
                  <th title="Average messages per lesson">Turns</th>
                  <th title="Share that ended early">Early</th>
                  <th title="Connected but learner never spoke">Silent</th>
                  <th title="Average tutor response latency">Latency</th>
                  <th></th>
                </tr>
              </thead>
              <tbody className="table-body">
                {[...chart].reverse().map((r) => {
                  const row = rows.find((x) => x.d === r.d)!;
                  return (
                    <tr key={r.d}>
                      <td>
                        {r.label}
                        {r.partial && <span className="plan-pill plan-pill--trial" style={{ marginLeft: 6 }}>partial</span>}
                      </td>
                      <td>{row.lessons.toLocaleString()}</td>
                      <td>{row.avg_rating != null ? `${row.avg_rating.toFixed(2)}` : "—"}</td>
                      <td>{r.pct_neg}%</td>
                      <td>{row.avg_turns != null ? row.avg_turns.toFixed(1) : "—"}</td>
                      <td>{r.pct_early}%</td>
                      <td>{r.pct_silent}%</td>
                      <td>{row.avg_latency_ms != null ? `${(row.avg_latency_ms / 1000).toFixed(1)}s` : "—"}</td>
                      <td>
                        <button className="ret-seg-btn" onClick={() => judgeFromTable(r.d)} disabled={judging}>
                          Judge sample →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── LLM-judged sample ─────────────────────────────────────────────────── */}
      <div ref={sampleRef} className="chart-container" style={{ marginTop: "2rem" }}>
        <div className="ret-chart-head">
          <h3>LLM-judged sample</h3>
        </div>
        <p className="ret-chart-sub" style={{ maxWidth: "80ch" }}>
          Pick a day and grade a random sample of its lessons with the <strong>LearnLM</strong> tutor rubric — manages
          cognitive load, inspires active learning, deepens metacognition, stimulates curiosity, adapts to the learner,
          overall quality (each 1–10) — scored by a cross-family panel (Gemini + Claude Sonnet 5, mean-aggregated to
          reduce single-model bias). Each lesson is judged once and cached (shared with the Evaluations tab), so
          re-running is free.
        </p>
        <div className="controls-bar" style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            Day
            <input className="filter-select" type="date" value={selectedDay} max={todayIso} onChange={(e) => setSelectedDay(e.target.value)} />
          </label>
          <div className="ret-seg" role="group" aria-label="Sample size">
            {[5, 10, 15, 20].map((n) => (
              <button key={n} className={`ret-seg-btn${sampleSize === n ? " ret-seg-btn--on" : ""}`} onClick={() => setSampleSize(n)}>
                {n}
              </button>
            ))}
          </div>
          <button className="transcript-toggle transcript-toggle--eval" onClick={() => runSample(selectedDay)} disabled={judging}>
            {judging ? "Judging…" : `Judge ${sampleSize} random lessons`}
          </button>
        </div>

        {sampleError && <div className="eval-error">{sampleError}</div>}

        {items.length > 0 && (
          <section className="metrics-grid" style={{ marginTop: "0.5rem", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <div className="metric-card">
              <div className="metric-value">{sampleStats.avg != null ? `${sampleStats.avg.toFixed(1)}/10` : "—"}</div>
              <div className="metric-label">Avg LLM Score</div>
              <div className="metric-description">{sampleStats.done}/{sampleStats.total} judged{judging ? " (running…)" : ""}</div>
            </div>
            <div className="metric-card">
              <div className="metric-value" style={{ color: "#16a34a" }}>{sampleStats.bands.good}</div>
              <div className="metric-label">High (8–10)</div>
            </div>
            <div className="metric-card">
              <div className="metric-value" style={{ color: "#d97706" }}>{sampleStats.bands.mid}</div>
              <div className="metric-label">Mid (5–7)</div>
            </div>
            <div className="metric-card">
              <div className="metric-value" style={{ color: "#dc2626" }}>{sampleStats.bands.bad}</div>
              <div className="metric-label">Low (1–4)</div>
            </div>
          </section>
        )}

        <div className="lessons-cards" style={{ marginTop: "1rem" }}>
          {items.map((it) => (
            <SampleCard key={it.row.id} item={it} onUserClick={onUserClick} />
          ))}
        </div>
      </div>

      {/* ── Learning Journey cohort: does journey quality track conversion? ────── */}
      <div className="chart-container" style={{ marginTop: "2rem" }}>
        <div className="ret-chart-head">
          <h3>Learning Journey cohort</h3>
        </div>
        <p className="ret-chart-sub" style={{ maxWidth: "82ch" }}>
          Long-horizon tutor eval across each engaged learner's whole lesson relationship, then split by outcome —
          the test of whether journey quality actually tracks conversion. Only engaged users qualify (most do ~1 lesson),
          so this is a small sample. Each user is judged once and cached (shared with the profile panel). One LLM call per uncached user.
        </p>
        <div className="controls-bar" style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            Min lessons
            <input
              className="filter-select"
              type="number"
              min={3}
              max={50}
              value={jMinLessons}
              onChange={(e) => setJMinLessons(Math.max(3, Number(e.target.value) || 3))}
              style={{ width: "4.5rem" }}
            />
          </label>
          <div className="ret-seg" role="group" aria-label="Cohort size">
            {[10, 20, 30].map((n) => (
              <button key={n} className={`ret-seg-btn${jSample === n ? " ret-seg-btn--on" : ""}`} onClick={() => setJSample(n)}>
                {n}
              </button>
            ))}
          </div>
          <button className="transcript-toggle transcript-toggle--eval" onClick={runJourneyCohort} disabled={jRunning}>
            {jRunning ? (jProg ? `Judging ${jProg.done}/${jProg.total}…` : "Sampling users…") : `Run cohort · ${jSample} users`}
          </button>
        </div>

        {jError && <div className="eval-error">{jError}</div>}

        {jStats.done > 0 && (
          <>
            <section className="metrics-grid" style={{ marginTop: "0.5rem", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
              <div className="metric-card">
                <div className="metric-value" style={{ color: "#16a34a" }}>{jStats.convAvg != null ? `${jStats.convAvg.toFixed(1)}/10` : "—"}</div>
                <div className="metric-label">Converters</div>
                <div className="metric-description">{jStats.convN} users · avg journey score</div>
              </div>
              <div className="metric-card">
                <div className="metric-value" style={{ color: "#dc2626" }}>{jStats.notAvg != null ? `${jStats.notAvg.toFixed(1)}/10` : "—"}</div>
                <div className="metric-label">Non-converters</div>
                <div className="metric-description">{jStats.notN} users · avg journey score</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">
                  {jStats.convAvg != null && jStats.notAvg != null ? `${(jStats.convAvg - jStats.notAvg >= 0 ? "+" : "")}${(jStats.convAvg - jStats.notAvg).toFixed(1)}` : "—"}
                </div>
                <div className="metric-label">Gap</div>
                <div className="metric-description">converter − non-converter</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{jStats.done}</div>
                <div className="metric-label">Judged</div>
                <div className="metric-description">of {jItems.length} sampled</div>
              </div>
            </section>

            <div className="table-container" style={{ marginTop: "1rem" }}>
              <table className="data-table">
                <thead className="table-head">
                  <tr>
                    <th>Dimension</th>
                    <th title="Average among converters">Converters</th>
                    <th title="Average among non-converters">Non-converters</th>
                    <th>Gap</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {jStats.dims.map((d) => (
                    <tr key={d.dim}>
                      <td>{d.dim}</td>
                      <td>{d.conv != null ? d.conv.toFixed(1) : "—"}</td>
                      <td>{d.not != null ? d.not.toFixed(1) : "—"}</td>
                      <td style={{ color: d.conv != null && d.not != null ? (d.conv - d.not >= 0 ? "#16a34a" : "#dc2626") : undefined }}>
                        {d.conv != null && d.not != null ? `${d.conv - d.not >= 0 ? "+" : ""}${(d.conv - d.not).toFixed(1)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {jItems.length > 0 && (
          <div className="table-container" style={{ marginTop: "1rem" }}>
            <table className="data-table">
              <thead className="table-head">
                <tr>
                  <th>User</th>
                  <th>Lessons</th>
                  <th>Outcome</th>
                  <th>Journey</th>
                  {JOURNEY_DIMENSIONS.map((d) => (
                    <th key={d} title={d}>{d.split(" ")[0]}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="table-body">
                {jItems.map((it) => {
                  const dimScore = (dim: string) => it.journey?.dimensions.find((d) => d.dimension === dim)?.score;
                  return (
                    <tr key={it.userId}>
                      <td>
                        <a href={`#user-lookup:${it.userId}`} target="_blank" rel="noopener noreferrer" style={{ color: "#4f46e5", textDecoration: "none", fontWeight: 500 }}>
                          {it.name?.trim() || it.userId.slice(0, 8) + "…"} ↗
                        </a>
                      </td>
                      <td>{it.lessons}</td>
                      <td>
                        <span className={`user-trial-badge user-trial-badge--${it.converted ? "converted" : "churned"}`}>
                          {it.converted ? "Converted" : "Not converted"}
                        </span>
                      </td>
                      <td>
                        {it.status === "pending" ? "…" : it.status === "error" ? <span title={it.error} style={{ color: "#b42318" }}>err</span> : it.journey ? (
                          <span className={`eval-score eval-score--${scoreVariant(it.journey.overall_score)}`}>{it.journey.overall_score}</span>
                        ) : "—"}
                      </td>
                      {JOURNEY_DIMENSIONS.map((d) => (
                        <td key={d}>{dimScore(d) ?? "—"}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// One judged lesson: header + eval panel (or spinner/error) + collapsible transcript.
const SampleCard: React.FC<{ item: JudgedItem; onUserClick?: (userId: string) => void }> = ({ item, onUserClick }) => {
  const { row } = item;
  const [showConvo, setShowConvo] = useState(false);
  return (
    <div className="lesson-card">
      <div className="lesson-card-header">
        <button
          className="lesson-card-user lesson-card-user--clickable"
          title={`View all lessons for ${row.user_id}`}
          onClick={() => onUserClick?.(row.user_id)}
        >
          {row.preferred_name?.trim() || row.user_id.slice(0, 8) + "…"}
        </button>
        {row.lesson_id != null && <span className="lesson-card-lesson-id">Lesson #{row.lesson_id}</span>}
        <span className="lesson-card-date">{format(new Date(row.created_at), "MMM d, yyyy h:mm a")}</span>
        {row.learning_language && (
          <span className="lesson-card-badge" title="Target language">{row.learning_language}</span>
        )}
        {row.user_rating_feedback != null && <span className="lesson-card-rating">{row.user_rating_feedback}★</span>}
        <span className="lesson-card-badge lesson-card-badge--turns" title="Conversation turns">💬 {row.turns}</span>
        {row.ended_early && (
          <span className="lesson-card-badge lesson-card-badge--early" title={row.early_end_reason ?? undefined}>
            Ended Early
          </span>
        )}
        {item.cached && <span className="eval-evaluated-at">cached</span>}
        <button className="transcript-toggle" onClick={() => setShowConvo((v) => !v)}>
          {showConvo ? "Hide Conversation" : "Show Conversation"}
        </button>
      </div>

      {item.status === "pending" && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.75rem 0" }}>
          <div className="loading-spinner" style={{ width: 18, height: 18 }}></div>
          <span className="loading-text" style={{ margin: 0 }}>Grading…</span>
        </div>
      )}
      {item.status === "error" && <div className="eval-error">Evaluation failed: {item.error}</div>}
      {item.status === "done" && item.evaluation && <TutorEvalPanel evaluation={item.evaluation} collapsible />}

      {showConvo && <Conversation transcript={row.conversation_transcript} />}
    </div>
  );
};

export default Evals;
