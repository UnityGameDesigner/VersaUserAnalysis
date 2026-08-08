import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabase";
import { getCountryFromTimezone } from "./lib/timezone";
import { format } from "date-fns";

// "Tutor Comparison" — how many lessons users pack into their FIRST N days (from
// their first completed lesson), so an intensive app week can be stacked against
// a week with a human tutor. Backed by the first_window_lessons RPC.

interface Row {
  user_id: string;
  preferred_name: string | null;
  learning_language: string | null;
  level: string | null;
  time_zone: string | null;
  tutor: string | null;
  payment_status: string | null;
  attribution: string | null;
  first_lesson_at: string | null;
  lessons_in_window: number;
  days_active_in_window: number;
  turns_in_window: number;
  total_lessons: number;
  total_matches: number;
}

const MAX_ROWS = 1000;
// A human tutor typically runs ~3 sessions/week — the benchmark we compare to.
const TUTOR_SESSIONS_PER_WEEK = 3;

function prettyLang(code: string | null): string {
  if (!code || !code.trim()) return "—";
  return code
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : format(d, "MMM d, yyyy");
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const TutorComparison: React.FC<{ onUserClick?: (userId: string) => void }> = ({
  onUserClick,
}) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The window (in days) and the min lessons to qualify. Both adjustable.
  const [windowDays, setWindowDays] = useState(7);
  const [minLessons, setMinLessons] = useState(5);
  // Committed values actually sent to the RPC (debounced from the inputs).
  const [applied, setApplied] = useState({ days: 7, min: 5 });
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("lessons");

  // Debounce input changes so a heavy RPC doesn't fire on every keystroke.
  useEffect(() => {
    const days = Math.min(90, Math.max(1, Math.round(windowDays) || 1));
    const min = Math.min(500, Math.max(1, Math.round(minLessons) || 1));
    const t = setTimeout(() => setApplied({ days, min }), 500);
    return () => clearTimeout(t);
  }, [windowDays, minLessons]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc("first_window_lessons", {
        days: applied.days,
        min_lessons: applied.min,
        max_rows: MAX_ROWS,
      });
      if (error) throw new Error(error.message);
      const mapped: Row[] = (data ?? []).map((r: Record<string, unknown>) => ({
        user_id: String(r.user_id),
        preferred_name: (r.preferred_name as string) ?? null,
        learning_language: (r.learning_language as string) ?? null,
        level: (r.level as string) ?? null,
        time_zone: (r.time_zone as string) ?? null,
        tutor: (r.tutor as string) ?? null,
        payment_status: (r.payment_status as string) ?? null,
        attribution: (r.attribution as string) ?? null,
        first_lesson_at: (r.first_lesson_at as string) ?? null,
        lessons_in_window: Number(r.lessons_in_window ?? 0),
        days_active_in_window: Number(r.days_active_in_window ?? 0),
        turns_in_window: Number(r.turns_in_window ?? 0),
        total_lessons: Number(r.total_lessons ?? 0),
        total_matches: Number(r.total_matches ?? 0),
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
    fetchData();
  }, [fetchData]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.preferred_name || "").toLowerCase().includes(q) ||
        r.user_id.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sortBy) {
      case "days":
        list.sort((a, b) => b.days_active_in_window - a.days_active_in_window);
        break;
      case "turns":
        list.sort((a, b) => b.turns_in_window - a.turns_in_window);
        break;
      case "total":
        list.sort((a, b) => b.total_lessons - a.total_lessons);
        break;
      case "recent":
        list.sort((a, b) => {
          const at = a.first_lesson_at ? new Date(a.first_lesson_at).getTime() : 0;
          const bt = b.first_lesson_at ? new Date(b.first_lesson_at).getTime() : 0;
          return bt - at;
        });
        break;
      case "lessons":
      default:
        list.sort((a, b) => b.lessons_in_window - a.lessons_in_window);
        break;
    }
    return list;
  }, [filtered, sortBy]);

  const totalMatches = rows[0]?.total_matches ?? 0;
  const capped = totalMatches > rows.length;
  // A human tutor at ~3 sessions/week → this many sessions across the window.
  const tutorEquiv = Math.max(1, Math.round((TUTOR_SESSIONS_PER_WEEK * applied.days) / 7));
  const medLessons = useMemo(() => median(rows.map((r) => r.lessons_in_window)), [rows]);
  const medDays = useMemo(() => median(rows.map((r) => r.days_active_in_window)), [rows]);
  const topLessons = rows[0]?.lessons_in_window ?? 0;
  const multiple = tutorEquiv > 0 ? medLessons / tutorEquiv : 0;

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title" style={{ margin: 0 }}>
        Tutor Comparison
        <span className="lessons-detail-count">
          {totalMatches.toLocaleString()} intensive users
        </span>
      </h2>
      <p className="ret-chart-sub" style={{ marginTop: "0.4rem" }}>
        Users who completed at least <strong>{applied.min}</strong> lessons in their{" "}
        <strong>first {applied.days} days</strong> (from their first lesson, onboarding
        excluded). A human tutor at ~{TUTOR_SESSIONS_PER_WEEK} sessions/week would give
        about <strong>{tutorEquiv}</strong> session{tutorEquiv === 1 ? "" : "s"} in the same
        span — see how much more practice these learners packed in.
      </p>

      {/* Controls */}
      <div
        className="controls-bar"
        style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginTop: "1rem" }}
      >
        <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          First
          <input
            className="filter-select"
            type="number"
            min={1}
            max={90}
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            style={{ width: "4.5rem" }}
          />
          days
        </label>
        <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          Min lessons
          <input
            className="filter-select"
            type="number"
            min={1}
            max={500}
            value={minLessons}
            onChange={(e) => setMinLessons(Number(e.target.value))}
            style={{ width: "4.5rem" }}
          />
        </label>
        <input
          className="filter-select"
          type="text"
          placeholder="Search name or user id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: "200px" }}
        />
        <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          Sort by:
          <select className="filter-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="lessons">Lessons in window</option>
            <option value="days">Days active</option>
            <option value="turns">Speaking turns</option>
            <option value="total">Total lessons</option>
            <option value="recent">First lesson (recent)</option>
          </select>
        </label>
        <span className="filters-count">{sorted.length.toLocaleString()} shown</span>
      </div>

      {error && (
        <div className="error-box" style={{ margin: "1rem 0" }}>
          <p>Failed to load: {error}</p>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Crunching first-{applied.days}-day activity…</p>
        </div>
      ) : (
        <>
          {/* Headline comparison */}
          <section className="metrics-grid" style={{ marginTop: "1rem" }}>
            <div className="metric-card">
              <div className="metric-value">{totalMatches.toLocaleString()}</div>
              <div className="metric-label">Intensive Users</div>
              <div className="metric-description">
                ≥{applied.min} lessons in first {applied.days}d
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{medLessons}</div>
              <div className="metric-label">Median Lessons</div>
              <div className="metric-description">
                {multiple >= 1 ? `≈ ${multiple.toFixed(1)}× a tutor's ~${tutorEquiv}` : `vs tutor's ~${tutorEquiv}`}
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{topLessons}</div>
              <div className="metric-label">Top User</div>
              <div className="metric-description">Most lessons in the window</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{medDays}</div>
              <div className="metric-label">Median Active Days</div>
              <div className="metric-description">Distinct days used in window</div>
            </div>
          </section>

          {capped && (
            <div className="ret-chart-sub" style={{ marginTop: "0.75rem" }}>
              Showing the top {rows.length.toLocaleString()} of{" "}
              {totalMatches.toLocaleString()} matching users (by lessons). Raise “Min
              lessons” to narrow the list.
            </div>
          )}

          {sorted.length === 0 ? (
            <div className="empty-state" style={{ padding: "2rem" }}>
              No users match this window and threshold.
            </div>
          ) : (
            <div className="table-container" style={{ marginTop: "0.75rem" }}>
              <table className="data-table">
                <thead className="table-head">
                  <tr>
                    <th>Name</th>
                    <th>Country</th>
                    <th>Learning</th>
                    <th>Level</th>
                    <th>Tutor</th>
                    <th>First Lesson</th>
                    <th title={`Lessons completed in the first ${applied.days} days (onboarding excluded)`}>
                      Lessons ({applied.days}d)
                    </th>
                    <th title="Distinct days used within the window">Active Days</th>
                    <th title="Real student speaking turns within the window">Turns</th>
                    <th title="All-time lessons completed">Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {sorted.map((r) => {
                    const profileUrl = `${window.location.pathname}${window.location.search}#user-lookup:${r.user_id}`;
                    const status = (r.payment_status || "").toUpperCase();
                    const variant =
                      status === "ACTIVE"
                        ? "paying"
                        : status === "TRIAL"
                        ? "trial"
                        : status === "PAST_DUE"
                        ? "pastdue"
                        : "free";
                    return (
                      <tr
                        key={r.user_id}
                        className={onUserClick ? "table-row--clickable" : ""}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey) {
                            window.open(profileUrl, "_blank");
                            return;
                          }
                          onUserClick?.(r.user_id);
                        }}
                        onAuxClick={(e) => {
                          if (e.button === 1) {
                            e.preventDefault();
                            window.open(profileUrl, "_blank");
                          }
                        }}
                      >
                        <td>{r.preferred_name || "N/A"}</td>
                        <td>{getCountryFromTimezone(r.time_zone)}</td>
                        <td>{prettyLang(r.learning_language)}</td>
                        <td>{r.level || "—"}</td>
                        <td>{r.tutor || "—"}</td>
                        <td>{formatDate(r.first_lesson_at)}</td>
                        <td>
                          <span className="eng-score" style={{ fontSize: "1rem" }}>
                            {r.lessons_in_window}
                          </span>
                        </td>
                        <td>{r.days_active_in_window}</td>
                        <td>{r.turns_in_window.toLocaleString()}</td>
                        <td>{r.total_lessons}</td>
                        <td>
                          {status ? (
                            <span className={`plan-pill plan-pill--${variant}`}>
                              {status === "PAST_DUE" ? "Past Due" : status.charAt(0) + status.slice(1).toLowerCase()}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
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

export default TutorComparison;
