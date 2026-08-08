import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabase";
import {
  analyzeCancellation,
  CANCEL_REASONS,
  reasonMeta,
  type CancelAnalysis,
} from "./lib/analyzeCancellation";
import { getCancelAnalysis, saveCancelAnalysis } from "./lib/cancelAnalysisStore";

// Aggregate "why are trials cancelling" — runs the per-user LLM analysis across a
// bounded batch of the most-recent trial cancels (from the last 14 days onward),
// caches each verdict (shared with the User Lookup card), and tallies the reasons.
// Results accumulate across runs; click Analyze again to cover more of the cohort.

const WINDOW_DAYS = 14;
const BATCH = 25; // users analyzed per Analyze click
const CONCURRENCY = 4; // parallel LLM calls per wave

interface CohortUser {
  user_id: string;
  preferred_name: string | null;
  learning_language: string | null;
  native_language: string | null;
  level: string | null;
  reason: string | null;
  daily_streak: number | null;
  canceled_at: string | null;
  last_completed_at: string | null;
}

async function fetchLessons(userId: string) {
  const { data } = await supabase
    .from("completed_lessons")
    .select(
      "id, created_at, lesson_id, conversation_transcript, ended_early, user_rating_feedback, exit_phase, exit_trigger, mic_mode",
    )
    .eq("user_id", userId)
    .order("id", { ascending: true })
    .limit(1000);
  return (data ?? []) as Array<{
    id: number;
    created_at: string;
    lesson_id: number;
    conversation_transcript: unknown;
    ended_early: boolean | null;
    user_rating_feedback: number | null;
    exit_phase: string | null;
    exit_trigger: string | null;
    mic_mode: string | null;
  }>;
}

async function fetchNotifs(userId: string) {
  const { data } = await supabase
    .from("notification_log")
    .select("bucket, source, status, sent_at, opened_at")
    .eq("user_id", userId)
    .limit(500);
  return (data ?? []) as Array<{
    bucket: string | null;
    source: string | null;
    status: string | null;
    sent_at: string | null;
    opened_at: string | null;
  }>;
}

const CancelReasons: React.FC<{ onUserClick?: (userId: string) => void }> = ({ onUserClick }) => {
  const [cohort, setCohort] = useState<CohortUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // user_id -> { analysis, name }
  const [analyses, setAnalyses] = useState<Record<string, { analysis: CancelAnalysis; name: string | null }>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [runError, setRunError] = useState<string | null>(null);

  const fetchCohort = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from("user_info")
        .select(
          "user_id, preferred_name, learning_language, native_language, level, reason, daily_streak, canceled_at, last_completed_at",
        )
        .eq("payment_status", "CANCELED")
        .is("became_active_at", null)
        .gte("canceled_at", cutoff)
        .order("canceled_at", { ascending: false })
        .limit(300);
      if (error) throw new Error(error.message);
      const seen = new Set<string>();
      const list: CohortUser[] = [];
      (data ?? []).forEach((u) => {
        if (!seen.has(u.user_id)) {
          seen.add(u.user_id);
          list.push(u as CohortUser);
        }
      });
      setCohort(list);
      // Seed from cache so prior verdicts show immediately and accumulate.
      const seeded: Record<string, { analysis: CancelAnalysis; name: string | null }> = {};
      list.forEach((u) => {
        const cached = getCancelAnalysis(u.user_id);
        if (cached) seeded[u.user_id] = { analysis: cached.analysis, name: cached.userName };
      });
      setAnalyses(seeded);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCohort();
  }, [fetchCohort]);

  const runBatch = async () => {
    const pending = cohort.filter((u) => !analyses[u.user_id]).slice(0, BATCH);
    if (pending.length === 0) return;
    setAnalyzing(true);
    setRunError(null);
    setProgress({ done: 0, total: pending.length });
    let done = 0;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const wave = pending.slice(i, i + CONCURRENCY);
      await Promise.all(
        wave.map(async (u) => {
          try {
            const [lessons, notifs] = await Promise.all([fetchLessons(u.user_id), fetchNotifs(u.user_id)]);
            const firstLessonAt = lessons.length
              ? [...lessons].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))[0].created_at
              : null;
            const result = await analyzeCancellation({
              userId: u.user_id,
              profile: {
                preferred_name: u.preferred_name,
                learning_language: u.learning_language,
                native_language: u.native_language,
                level: u.level,
                reason: u.reason,
                daily_streak: u.daily_streak,
                first_lesson_at: firstLessonAt,
                last_completed_at: u.last_completed_at,
                canceled_at: u.canceled_at,
              },
              lessons,
              notifications: notifs,
            });
            saveCancelAnalysis({
              userId: u.user_id,
              analyzedAt: new Date().toISOString(),
              userName: u.preferred_name ?? null,
              lessonCount: lessons.filter((l) => l.lesson_id !== 42).length,
              analysis: result,
            });
            setAnalyses((prev) => ({ ...prev, [u.user_id]: { analysis: result, name: u.preferred_name } }));
          } catch (e) {
            setRunError(e instanceof Error ? e.message : String(e));
          } finally {
            done++;
            setProgress({ done, total: pending.length });
          }
        }),
      );
    }
    setAnalyzing(false);
  };

  const analyzedList = useMemo(
    () =>
      cohort
        .filter((u) => analyses[u.user_id])
        .map((u) => ({ user: u, ...analyses[u.user_id] })),
    [cohort, analyses],
  );
  const analyzedCount = analyzedList.length;
  const remaining = cohort.length - analyzedCount;

  const tally = useMemo(() => {
    const counts = new Map<string, number>();
    Object.values(analyses).forEach((a) =>
      counts.set(a.analysis.primary_reason, (counts.get(a.analysis.primary_reason) ?? 0) + 1),
    );
    return CANCEL_REASONS.map((r) => ({ ...r, count: counts.get(r.key) ?? 0 }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [analyses]);
  const maxCount = Math.max(...tally.map((t) => t.count), 1);
  const topReason = tally[0];

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title" style={{ margin: 0 }}>
        Cancel Reasons
        <span className="lessons-detail-count">{cohort.length} recent trial cancels</span>
      </h2>
      <p className="ret-chart-sub" style={{ marginTop: "0.4rem" }}>
        AI-inferred reasons trials cancelled in the last {WINDOW_DAYS} days (and onward). Each
        run reads the next {BATCH} users' call-logs, exit signals and notifications via Gemini
        and tallies the likely reason. Verdicts are cached and accumulate — click Analyze again
        to cover more. Reasons are inferred from behaviour, not stated.
      </p>

      {error && (
        <div className="error-box" style={{ margin: "1rem 0" }}>
          <p>Failed to load cohort: {error}</p>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Loading recent trial cancels…</p>
        </div>
      ) : (
        <>
          {/* Controls */}
          <div
            className="controls-bar"
            style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginTop: "1rem" }}
          >
            <button
              className="transcript-toggle transcript-toggle--eval"
              onClick={runBatch}
              disabled={analyzing || remaining === 0}
              title="Analyze the next batch of un-analyzed users"
            >
              {analyzing
                ? `Analyzing… ${progress.done}/${progress.total}`
                : remaining === 0
                ? "All analyzed"
                : `Analyze next ${Math.min(BATCH, remaining)}`}
            </button>
            <button className="filter-select" onClick={fetchCohort} disabled={analyzing}>
              Refresh cohort
            </button>
            <span className="filters-count">
              {analyzedCount} analyzed · {remaining} remaining
            </span>
          </div>

          {runError && (
            <div className="eval-error" style={{ marginTop: "0.75rem" }}>
              Some analyses failed: {runError}
            </div>
          )}

          {/* Summary */}
          <section className="metrics-grid" style={{ marginTop: "1rem" }}>
            <div className="metric-card">
              <div className="metric-value">{cohort.length}</div>
              <div className="metric-label">Recent Cancels</div>
              <div className="metric-description">Last {WINDOW_DAYS} days (by cancel date)</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{analyzedCount}</div>
              <div className="metric-label">Analyzed</div>
              <div className="metric-description">
                {cohort.length > 0 ? `${((analyzedCount / cohort.length) * 100).toFixed(0)}% of cohort` : "—"}
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-value" style={{ color: topReason ? reasonMeta(topReason.key).color : undefined }}>
                {topReason ? topReason.count : "—"}
              </div>
              <div className="metric-label">Top Reason</div>
              <div className="metric-description">{topReason ? topReason.label : "Run an analysis"}</div>
            </div>
          </section>

          {/* Reason breakdown */}
          {tally.length > 0 && (
            <div className="metric-card" style={{ textAlign: "left", padding: "1rem 1.1rem", marginTop: "1rem" }}>
              <div style={{ fontWeight: 700, color: "#1a1a2e", marginBottom: "0.1rem" }}>
                Why they cancelled — {analyzedCount} analyzed
              </div>
              <div style={{ fontSize: "0.76rem", color: "#9ca3af", marginBottom: "0.7rem" }}>
                Primary inferred reason per user.
              </div>
              {tally.map((r) => (
                <div key={r.key} style={{ display: "flex", alignItems: "center", gap: "0.7rem", padding: "0.2rem 0" }} title={r.hint}>
                  <div style={{ width: 150, flexShrink: 0, fontSize: "0.82rem", color: "#4b5563" }}>{r.label}</div>
                  <div style={{ flex: 1, height: 22, background: "#f1f5f9", borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ width: `${(r.count / maxCount) * 100}%`, minWidth: r.count ? 4 : 0, height: "100%", background: r.color, borderRadius: 6 }} />
                  </div>
                  <div style={{ width: 130, flexShrink: 0, fontSize: "0.8rem", color: "#6b7280" }}>
                    {r.count} ({analyzedCount ? Math.round((r.count / analyzedCount) * 100) : 0}%)
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Per-user verdicts */}
          {analyzedList.length === 0 ? (
            <div className="empty-state" style={{ padding: "2rem" }}>
              No analyses yet — click “Analyze next {Math.min(BATCH, cohort.length)}”.
            </div>
          ) : (
            <div className="table-container" style={{ marginTop: "1rem" }}>
              <table className="data-table">
                <thead className="table-head">
                  <tr>
                    <th>Name</th>
                    <th>Likely Reason</th>
                    <th>Conf.</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {analyzedList.map(({ user, analysis }) => {
                    const m = reasonMeta(analysis.primary_reason);
                    const profileUrl = `${window.location.pathname}${window.location.search}#user-lookup:${user.user_id}`;
                    return (
                      <tr
                        key={user.user_id}
                        className={onUserClick ? "table-row--clickable" : ""}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey) {
                            window.open(profileUrl, "_blank");
                            return;
                          }
                          onUserClick?.(user.user_id);
                        }}
                        onAuxClick={(e) => {
                          if (e.button === 1) {
                            e.preventDefault();
                            window.open(profileUrl, "_blank");
                          }
                        }}
                      >
                        <td>{user.preferred_name || "N/A"}</td>
                        <td>
                          <span style={{ fontWeight: 600, color: "#fff", background: m.color, borderRadius: 999, padding: "0.12rem 0.55rem", fontSize: "0.78rem", whiteSpace: "nowrap" }}>
                            {m.label}
                          </span>
                        </td>
                        <td>{analysis.confidence}</td>
                        <td style={{ maxWidth: 520, color: "#374151" }}>{analysis.summary}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default CancelReasons;
