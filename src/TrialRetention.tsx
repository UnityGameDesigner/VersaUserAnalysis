import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabase";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  LabelList,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { format, subMonths } from "date-fns";

// "Trial Retention" — is retention improving for people who START the trial?
// Each user is cohorted by the month/week of their FIRST completed lesson (the
// app has no reliable signup date). For each cohort we condense "how many days
// they used the app" in their first N days into a single number and plot it over
// time, so the effect of product changes on retention is visible at a glance.
// Backed by the trial_retention_trend RPC (supabase/sql/trial_retention_trend.sql).

interface CohortRaw {
  cohort: string;
  users: number;
  median_active: number;
  ge_counts: number[]; // ge_counts[k-1] = # users with >= k distinct active days
}

type Gran = "month" | "week" | "day";
type Metric = "return" | "avg" | "reach";
type Population = "trial" | "all";

// Cohorts smaller than this are too noisy to read — hidden from the trend.
// Kept modest so the ~3k trial-only population still forms usable cohorts.
const MIN_USERS = 25;

const METRICS: Record<Metric, { label: string; unit: string; blurb: (n: number, w: number) => string }> = {
  return: {
    label: "Return rate",
    unit: "%",
    blurb: (_n, w) => `the share who used the app on 2+ separate days within their first ${w} days (came back at least once).`,
  },
  avg: {
    label: "Avg active days",
    unit: "",
    blurb: (_n, w) => `the average number of distinct days they used the app in their first ${w} days.`,
  },
  reach: {
    label: "Reached ≥ N days",
    unit: "%",
    blurb: (n, w) => `the share who used the app on ${n}+ separate days within their first ${w} days.`,
  },
};

function cohortLabel(iso: string, gran: Gran): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  if (gran === "month") return format(d, "MMM ''yy");
  if (gran === "day") return format(d, "MMM d, ''yy");
  return format(d, "MMM d"); // week (anchored on its Monday)
}

interface DailyRow {
  d: string;
  trials: number;
  avg_active: number;
  median_active: number;
  max_active: number;
  partial: boolean;
  hist: number[]; // hist[k] = # users with EXACTLY k active days (k = 0..7)
}

// Ordinal light→dark ramp for the exact-active-days stack (0 = grey "no return").
const DAY_COLORS = ["#d1d5db", "#c7d2fe", "#a5b4fc", "#818cf8", "#6366f1", "#4f46e5", "#4338ca", "#3730a3"];
const dayKey = (k: number) => `b${k}`;
const dayName = (k: number) => (k === 0 ? "0 days" : k === 1 ? "1 day" : k === 7 ? "7 (full)" : `${k} days`);

interface DayUser {
  user_id: string;
  preferred_name: string | null;
  learning_language: string | null;
  payment_status: string | null;
  active_days: number;
}
function prettyLang(code: string | null): string {
  if (!code || !code.trim()) return "—";
  return code
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
function statusVariant(status: string | null): string {
  const s = (status || "").toUpperCase();
  return s === "ACTIVE" ? "paying" : s === "TRIAL" ? "trial" : s === "PAST_DUE" ? "pastdue" : "free";
}

const TrialRetention: React.FC = () => {
  // "bars" = how many users reached ≥N distinct active days (pooled over the
  // timeframe); "trend" = the metric over time (cohort line); "recent" = a
  // per-day breakdown of the last N days (trial cohort engagement, no min-size).
  const [chartType, setChartType] = useState<"bars" | "trend" | "recent">("bars");
  const [windowDays, setWindowDays] = useState(7); // default = the 7-day trial length
  const [gran, setGran] = useState<Gran>("month");
  const [metric, setMetric] = useState<Metric>("return");
  const [reachN, setReachN] = useState(3);
  // Which population: users who ever started a trial, or every app user.
  const [population, setPopulation] = useState<Population>("trial");
  // Cohort date range shown (empty string = open-ended in that direction).
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [applied, setApplied] = useState({ window: 7, gran: "month" as Gran, population: "trial" as Population });
  const [rows, setRows] = useState<CohortRaw[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // "Per day" view: a start/end date range (empty = default last 20 days).
  const [recentFrom, setRecentFrom] = useState("");
  const [recentTo, setRecentTo] = useState("");
  const [appliedRange, setAppliedRange] = useState({ from: "", to: "" });
  // Per-day stack: raw counts, or 100%-stacked share (every bar full height).
  const [stackMode, setStackMode] = useState<"count" | "share">("share");
  // Click-through: a day's trial starters.
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayUsers, setDayUsers] = useState<DayUser[]>([]);
  const [dayUsersLoading, setDayUsersLoading] = useState(false);
  const [dailyRows, setDailyRows] = useState<DailyRow[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);

  // Debounce the window input; granularity applies immediately.
  useEffect(() => {
    const w = Math.min(90, Math.max(2, Math.round(windowDays) || 2));
    const t = setTimeout(() => setApplied((a) => ({ ...a, window: w })), 500);
    return () => clearTimeout(t);
  }, [windowDays]);
  useEffect(() => {
    setApplied((a) => ({ ...a, gran, population }));
  }, [gran, population]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc("trial_retention_trend", {
        window_days: applied.window,
        gran: applied.gran,
        trial_only: applied.population === "trial",
      });
      if (error) throw new Error(error.message);
      const mapped: CohortRaw[] = (data ?? []).map((r: Record<string, unknown>) => ({
        cohort: String(r.cohort),
        users: Number(r.users ?? 0),
        median_active: Number(r.median_active ?? 0),
        ge_counts: ((r.ge_counts as number[]) ?? []).map((v) => Number(v)),
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

  // Debounce the date-range inputs.
  useEffect(() => {
    const t = setTimeout(() => setAppliedRange({ from: recentFrom, to: recentTo }), 500);
    return () => clearTimeout(t);
  }, [recentFrom, recentTo]);

  // Fetch the per-day breakdown only when the "Per day" view is active.
  useEffect(() => {
    if (chartType !== "recent") return;
    let cancelled = false;
    (async () => {
      setDailyLoading(true);
      setDailyError(null);
      const { data, error } = await supabase.rpc("trial_daily_activity", {
        start_date: appliedRange.from || null,
        end_date: appliedRange.to || null,
      });
      if (cancelled) return;
      if (error) {
        setDailyError(error.message);
        setDailyRows([]);
      } else {
        setDailyRows(
          (data ?? []).map((r: Record<string, unknown>) => ({
            d: String(r.d),
            trials: Number(r.trials ?? 0),
            avg_active: Number(r.avg_active ?? 0),
            median_active: Number(r.median_active ?? 0),
            max_active: Number(r.max_active ?? 0),
            partial: Boolean(r.partial),
            hist: ((r.hist as number[]) ?? []).map((v) => Number(v)),
          })),
        );
      }
      setDailyLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [chartType, appliedRange]);

  // Fetch the trial starters for a clicked day.
  useEffect(() => {
    if (!selectedDay) return;
    let cancelled = false;
    (async () => {
      setDayUsersLoading(true);
      const { data, error } = await supabase.rpc("trial_day_users", { day: selectedDay });
      if (cancelled) return;
      setDayUsers(
        error
          ? []
          : (data ?? []).map((r: Record<string, unknown>) => ({
              user_id: String(r.user_id),
              preferred_name: (r.preferred_name as string) ?? null,
              learning_language: (r.learning_language as string) ?? null,
              payment_status: (r.payment_status as string) ?? null,
              active_days: Number(r.active_days ?? 0),
            })),
      );
      setDayUsersLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDay]);

  // Reset the day drill-down when the underlying data/range changes.
  useEffect(() => {
    setSelectedDay(null);
  }, [appliedRange, chartType]);

  const effReachN = Math.min(Math.max(2, Math.round(reachN) || 2), applied.window);

  // Cohorts big enough to show in the time-trend line (RPC returns them asc).
  const shownRows = useMemo(() => rows.filter((r) => r.users >= MIN_USERS), [rows]);
  // Date bounds for the range inputs — from ALL cohorts so the timeline covers
  // everything (the bar view pools every trial, not just big cohorts).
  const bounds = useMemo(
    () => (rows.length ? { min: rows[0].cohort, max: rows[rows.length - 1].cohort } : null),
    [rows],
  );

  const applyPreset = (months: number | null) => {
    if (months == null || !bounds) {
      setFromDate("");
      setToDate("");
      return;
    }
    setToDate("");
    setFromDate(format(subMonths(new Date(bounds.max + "T00:00:00"), months), "yyyy-MM-dd"));
  };
  const rangeActive = Boolean(fromDate || toDate);

  const chartData = useMemo(() => {
    return shownRows
      .filter((r) => (!fromDate || r.cohort >= fromDate) && (!toDate || r.cohort <= toDate))
      .map((r) => {
        const sum = r.ge_counts.reduce((a, b) => a + b, 0);
        const avg = r.users ? sum / r.users : 0;
        const ret = r.users ? (100 * (r.ge_counts[1] ?? 0)) / r.users : 0;
        const reach = r.users ? (100 * (r.ge_counts[effReachN - 1] ?? 0)) / r.users : 0;
        const raw = metric === "avg" ? avg : metric === "return" ? ret : reach;
        return {
          cohort: r.cohort,
          label: cohortLabel(r.cohort, applied.gran),
          users: r.users,
          value: metric === "avg" ? Math.round(raw * 100) / 100 : Math.round(raw * 10) / 10,
        };
      });
  }, [shownRows, fromDate, toDate, metric, effReachN, applied.gran]);

  const unit = METRICS[metric].unit;

  // Days-reached bar chart: pool EVERY trial in the timeframe (no per-cohort size
  // filter, so day/week/month and daily sparsity are irrelevant) and count how
  // many reached ≥ k distinct active days, for k = 1..window.
  const rangeRows = useMemo(
    () => rows.filter((r) => (!fromDate || r.cohort >= fromDate) && (!toDate || r.cohort <= toDate)),
    [rows, fromDate, toDate],
  );
  const barData = useMemo(() => {
    const W = applied.window;
    const totalUsers = rangeRows.reduce((a, r) => a + r.users, 0);
    const ge = new Array(W).fill(0);
    let sumDays = 0;
    for (const r of rangeRows) {
      for (let k = 0; k < W; k++) {
        const c = r.ge_counts[k] ?? 0;
        ge[k] += c;
        sumDays += c;
      }
    }
    const bars = ge.map((count, i) => ({
      day: i + 1,
      label: `≥${i + 1}`,
      count,
      pct: totalUsers ? Math.round((1000 * count) / totalUsers) / 10 : 0,
    }));
    return { totalUsers, bars, avgDays: totalUsers ? sumDays / totalUsers : 0 };
  }, [rangeRows, applied.window]);

  // Headline: latest value, trend (last 3 cohorts vs previous 3), and peak.
  const summary = useMemo(() => {
    const vals = chartData.map((d) => d.value);
    if (vals.length === 0) return null;
    const latest = chartData[chartData.length - 1];
    const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const recent = mean(vals.slice(-3));
    const prior = mean(vals.slice(-6, -3));
    const delta = prior ? recent - prior : 0;
    let peak = chartData[0];
    for (const d of chartData) if (d.value > peak.value) peak = d;
    const totalUsers = chartData.reduce((a, d) => a + d.users, 0);
    return { latest, recent, prior, delta, hasPrior: chartData.length >= 4, peak, totalUsers, count: chartData.length };
  }, [chartData]);

  const isTrial = applied.population === "trial";
  const popNoun = isTrial ? "trial starters" : "app users";

  const fmt = (v: number) => (metric === "avg" ? v.toFixed(2) : `${Math.round(v * 10) / 10}${unit}`);
  // For a retention metric, up is good.
  const trendDir = summary && summary.delta > 0.01 ? "up" : summary && summary.delta < -0.01 ? "down" : "flat";
  const isBars = chartType === "bars";
  const isRecent = chartType === "recent";
  const anchorNoun = isTrial ? "trial start" : "first lesson";

  // Per-day view derived data. Each row also gets b0..b7 = # users with EXACTLY
  // that many active days (non-overlapping), for the stacked bars.
  const dailyChart = useMemo(
    () =>
      dailyRows.map((r) => {
        const dt = new Date(r.d + "T00:00:00");
        const buckets: Record<string, number> = {};
        for (let k = 0; k <= 7; k++) buckets[dayKey(k)] = r.hist[k] ?? 0;
        return {
          ...r,
          ...buckets,
          // Engagement score: 0 = nobody returned, 100 = everyone active all 7 days.
          score: Math.round((r.avg_active / 7) * 100),
          label: Number.isNaN(dt.getTime()) ? r.d : format(dt, "MMM d"),
        };
      }),
    [dailyRows],
  );
  const rangeLabel = useMemo(() => {
    const fmtD = (s: string) => {
      const d = new Date(s + "T00:00:00");
      return Number.isNaN(d.getTime()) ? s : format(d, "MMM d, ''yy");
    };
    const { from, to } = appliedRange;
    if (!from && !to) return "last 20 days";
    return `${from ? fmtD(from) : "start"} → ${to ? fmtD(to) : "today"}`;
  }, [appliedRange]);
  const dailySummary = useMemo(() => {
    const trials = dailyRows.reduce((a, r) => a + r.trials, 0);
    const activeSum = dailyRows.reduce((a, r) => a + r.avg_active * r.trials, 0);
    const busiest = dailyRows.reduce<DailyRow | null>((b, r) => (!b || r.trials > b.trials ? r : b), null);
    const avgActive = trials ? activeSum / trials : 0;
    return { trials, avgActive, score: Math.round((avgActive / 7) * 100), busiest, days: dailyRows.length };
  }, [dailyRows]);

  const headCount = isBars ? barData.totalUsers : isRecent ? dailySummary.trials : summary?.totalUsers ?? 0;

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title" style={{ margin: 0 }}>
        Trial Retention
        {headCount > 0 && (
          <span className="lessons-detail-count">
            {headCount.toLocaleString()} {isRecent ? "trials" : popNoun}
            {isRecent ? ` · ${rangeLabel}` : !isBars && summary ? ` · ${summary.count} cohorts` : ""}
          </span>
        )}
      </h2>
      <p className="ret-chart-sub" style={{ marginTop: "0.4rem", maxWidth: "74ch" }}>
        {isRecent ? (
          <>
            For each <strong>day</strong> in {rangeLabel}, the users who <strong>started a trial</strong> that day,
            split into <strong>non-overlapping groups by exactly how many distinct days they were active</strong> (0–7)
            in their 7-day trial window. Days in the last week are still in progress (<em>partial</em>).
          </>
        ) : (
          <>
            Among <strong>{popNoun}</strong>{" "}
            {isTrial
              ? "(users with a recorded trial start, from Superwall)"
              : "(everyone who completed ≥1 lesson, most of whom never started a trial)"}
            {isBars ? (
              <>
                , the bars show <strong>how many used the app on ≥N distinct days</strong> within their first{" "}
                {applied.window} days of their {anchorNoun} — the trial-engagement funnel, pooled over the selected timeline.
              </>
            ) : (
              <>
                , grouped by the {applied.gran} of their <strong>{anchorNoun}</strong>, the line tracks{" "}
                {METRICS[metric].blurb(effReachN, applied.window)} Rising = retention improving.
              </>
            )}
          </>
        )}
      </p>

      {/* Controls */}
      <div
        className="controls-bar"
        style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginTop: "1rem" }}
      >
        <div className="ret-seg" role="group" aria-label="Chart type">
          <button
            className={`ret-seg-btn${chartType === "bars" ? " ret-seg-btn--on" : ""}`}
            onClick={() => setChartType("bars")}
            title="How many users reached ≥N distinct active days, pooled over the timeline"
          >
            Days reached
          </button>
          <button
            className={`ret-seg-btn${chartType === "trend" ? " ret-seg-btn--on" : ""}`}
            onClick={() => setChartType("trend")}
            title="A retention metric over time (cohort line)"
          >
            Over time
          </button>
          <button
            className={`ret-seg-btn${chartType === "recent" ? " ret-seg-btn--on" : ""}`}
            onClick={() => setChartType("recent")}
            title="Per-day breakdown of the last N days — each day's trial cohort and how many days they were active"
          >
            Per day
          </button>
        </div>

        {isRecent ? (
          <>
            <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              From
              <input
                className="filter-select"
                type="date"
                value={recentFrom}
                min="2025-03-01"
                max={recentTo || undefined}
                onChange={(e) => setRecentFrom(e.target.value)}
              />
            </label>
            <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              To
              <input
                className="filter-select"
                type="date"
                value={recentTo}
                min={recentFrom || "2025-03-01"}
                onChange={(e) => setRecentTo(e.target.value)}
              />
            </label>
            {(recentFrom || recentTo) && (
              <button
                className="filters-clear-btn"
                onClick={() => {
                  setRecentFrom("");
                  setRecentTo("");
                }}
              >
                Reset
              </button>
            )}
          </>
        ) : (
          <>
            <div className="ret-seg" role="group" aria-label="Population">
              <button
                className={`ret-seg-btn${population === "trial" ? " ret-seg-btn--on" : ""}`}
                onClick={() => setPopulation("trial")}
                title="Only users with a recorded trial start (user_info.trial_started_at), anchored on the trial-start date"
              >
                Trial starters
              </button>
              <button
                className={`ret-seg-btn${population === "all" ? " ret-seg-btn--on" : ""}`}
                onClick={() => setPopulation("all")}
                title="Everyone who completed at least one lesson (whole funnel, mostly free users)"
              >
                All app users
              </button>
            </div>
            <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              First
              <input
                className="filter-select"
                type="number"
                min={2}
                max={90}
                value={windowDays}
                onChange={(e) => setWindowDays(Number(e.target.value))}
                style={{ width: "4.5rem" }}
              />
              days
            </label>
          </>
        )}

        {chartType === "trend" && (
          <>
            <div className="ret-seg" role="group" aria-label="Metric">
              {(Object.keys(METRICS) as Metric[]).map((m) => (
                <button
                  key={m}
                  className={`ret-seg-btn${metric === m ? " ret-seg-btn--on" : ""}`}
                  onClick={() => setMetric(m)}
                >
                  {METRICS[m].label}
                </button>
              ))}
            </div>

            {metric === "reach" && (
              <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                N =
                <input
                  className="filter-select"
                  type="number"
                  min={2}
                  max={applied.window}
                  value={reachN}
                  onChange={(e) => setReachN(Number(e.target.value))}
                  style={{ width: "4rem" }}
                />
                days
              </label>
            )}

            <div className="ret-seg" role="group" aria-label="Granularity">
              <button className={`ret-seg-btn${gran === "month" ? " ret-seg-btn--on" : ""}`} onClick={() => setGran("month")}>
                Monthly
              </button>
              <button className={`ret-seg-btn${gran === "week" ? " ret-seg-btn--on" : ""}`} onClick={() => setGran("week")}>
                Weekly
              </button>
              <button className={`ret-seg-btn${gran === "day" ? " ret-seg-btn--on" : ""}`} onClick={() => setGran("day")}>
                Daily
              </button>
            </div>
          </>
        )}
      </div>

      {/* Date range (hidden in the per-day view — it has its own last-N-days window) */}
      {!isRecent && (
      <div
        className="controls-bar"
        style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.6rem" }}
      >
        <span className="filter-label" style={{ fontWeight: 600 }}>Timeline</span>
        <div className="ret-seg" role="group" aria-label="Quick range">
          <button className={`ret-seg-btn${!rangeActive ? " ret-seg-btn--on" : ""}`} onClick={() => applyPreset(null)}>All</button>
          <button className="ret-seg-btn" onClick={() => applyPreset(12)}>12M</button>
          <button className="ret-seg-btn" onClick={() => applyPreset(6)}>6M</button>
          <button className="ret-seg-btn" onClick={() => applyPreset(3)}>3M</button>
        </div>
        <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          From
          <input
            className="filter-select"
            type="date"
            value={fromDate}
            min={bounds?.min}
            max={toDate || bounds?.max}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>
        <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          To
          <input
            className="filter-select"
            type="date"
            value={toDate}
            min={fromDate || bounds?.min}
            max={bounds?.max}
            onChange={(e) => setToDate(e.target.value)}
          />
        </label>
        {rangeActive && (
          <button className="filters-clear-btn" onClick={() => applyPreset(null)}>
            Clear
          </button>
        )}
      </div>
      )}

      {error && (
        <div className="error-box" style={{ margin: "1rem 0" }}>
          <p>Failed to load: {error}</p>
        </div>
      )}

      {isRecent ? (
        dailyLoading ? (
          <div style={{ textAlign: "center", padding: "3rem" }}>
            <div className="loading-spinner"></div>
            <p className="loading-text">Loading {rangeLabel}…</p>
          </div>
        ) : dailyError ? (
          <div className="error-box" style={{ margin: "1rem 0" }}>
            <p>Failed to load: {dailyError}</p>
          </div>
        ) : dailyRows.length === 0 ? (
          <div className="empty-state" style={{ padding: "2rem" }}>
            No trials started in {rangeLabel}. {(recentFrom || recentTo) ? "Try a wider range — note ~Mar–Jun 2026 has almost no trial data (the identify() gap)." : ""}
          </div>
        ) : (
          <>
            <section
              className="metrics-grid"
              style={{ marginTop: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
            >
              <div className="metric-card">
                <div className="metric-value">{dailySummary.trials.toLocaleString()}</div>
                <div className="metric-label">Trials Started</div>
                <div className="metric-description">{rangeLabel}</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{dailySummary.score}</div>
                <div className="metric-label">Engagement Score</div>
                <div className="metric-description">avg days ÷ 7 × 100 (100 = all 7 days)</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{dailySummary.avgActive.toFixed(2)}</div>
                <div className="metric-label">Avg Active Days</div>
                <div className="metric-description">In the 7-day trial window</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">
                  {dailySummary.busiest ? format(new Date(dailySummary.busiest.d + "T00:00:00"), "MMM d") : "—"}
                </div>
                <div className="metric-label">Busiest Day</div>
                <div className="metric-description">
                  {dailySummary.busiest ? `${dailySummary.busiest.trials} trials started` : ""}
                </div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{dailySummary.days}</div>
                <div className="metric-label">Days Shown</div>
                <div className="metric-description">One bar &amp; row per day</div>
              </div>
            </section>

            <div className="chart-container" style={{ marginTop: "1.25rem" }}>
              <div className="ret-chart-head">
                <h3>{stackMode === "share" ? "Share of trials by active-days, per day" : "Trials by exact active-days, per day"}</h3>
                <div className="ret-seg" role="group" aria-label="Stack mode">
                  <button
                    className={`ret-seg-btn${stackMode === "share" ? " ret-seg-btn--on" : ""}`}
                    onClick={() => setStackMode("share")}
                    title="100%-stacked: every bar full height, showing the proportion in each day-bucket"
                  >
                    Share
                  </button>
                  <button
                    className={`ret-seg-btn${stackMode === "count" ? " ret-seg-btn--on" : ""}`}
                    onClick={() => setStackMode("count")}
                    title="Raw user counts stacked"
                  >
                    Count
                  </button>
                </div>
              </div>
              <p className="ret-chart-sub">
                Each bar = the users who started a trial that day, stacked into <strong>non-overlapping</strong> groups by
                exactly how many distinct days they were active (0–7) in their 7-day trial window — a 4-day user is only in
                the “4 days” slice. Darker = more days; faded bars are still in progress (partial).
                {stackMode === "share"
                  ? " Every bar is normalized to 100%, so you're comparing the mix, not the volume."
                  : " Hover for the breakdown."}{" "}
                <strong>Click a bar</strong> to list that day's trial starters.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem 0.9rem", margin: "0 0 0.6rem", fontSize: 12, color: "#52514e" }}>
                {Array.from({ length: 8 }, (_, k) => (
                  <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                    <span style={{ width: 11, height: 11, borderRadius: 3, background: DAY_COLORS[k], display: "inline-block" }} />
                    {dayName(k)}
                  </span>
                ))}
              </div>
              <div style={{ width: "100%", height: 320, cursor: "pointer" }}>
                <ResponsiveContainer>
                  <BarChart
                    data={dailyChart}
                    margin={{ top: 24, right: 20, bottom: 8, left: 0 }}
                    stackOffset={stackMode === "share" ? "expand" : undefined}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={8} />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      width={40}
                      allowDecimals={false}
                      domain={stackMode === "share" ? [0, 1] : undefined}
                      tickFormatter={stackMode === "share" ? (v: number) => `${Math.round(v * 100)}%` : undefined}
                    />
                    <Tooltip
                      cursor={{ fill: "rgba(79,70,229,0.06)" }}
                      content={(props) => {
                        const { active, payload, label } = props as unknown as {
                          active?: boolean;
                          label?: unknown;
                          payload?: Array<{ name?: string; value?: number; color?: string }>;
                        };
                        if (!active || !payload || payload.length === 0) return null;
                        const row = dailyChart.find((r) => r.label === String(label));
                        const items = payload.filter((p) => Number(p.value) > 0).reverse();
                        return (
                          <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px", fontSize: 12, boxShadow: "0 2px 10px rgba(0,0,0,.1)" }}>
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>
                              {String(label)} · {row?.trials ?? 0} trials{row?.partial ? " (partial)" : ""}
                            </div>
                            {items.map((p, i) => (
                              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ width: 10, height: 10, borderRadius: 2, background: p.color, display: "inline-block" }} />
                                {p.name}: {p.value}
                                {row && row.trials ? ` (${Math.round((100 * Number(p.value)) / row.trials)}%)` : ""}
                              </div>
                            ))}
                          </div>
                        );
                      }}
                    />
                    {Array.from({ length: 8 }, (_, k) => (
                      <Bar
                        key={k}
                        dataKey={dayKey(k)}
                        name={dayName(k)}
                        stackId="d"
                        fill={DAY_COLORS[k]}
                        isAnimationActive={false}
                        onClick={(data) => {
                          const d =
                            (data as { payload?: { d?: string }; d?: string })?.payload?.d ??
                            (data as { d?: string })?.d;
                          if (d) setSelectedDay(d);
                        }}
                      >
                        {dailyChart.map((r, i) => (
                          <Cell key={i} fillOpacity={r.partial ? 0.55 : 1} />
                        ))}
                        {k === 7 && (
                          <LabelList
                            dataKey="score"
                            position="top"
                            fontSize={10}
                            fontWeight={600}
                            fill="#374151"
                          />
                        )}
                      </Bar>
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {selectedDay && (
              <div className="chart-container" style={{ marginTop: "1rem" }}>
                <div className="ret-chart-head">
                  <h3>
                    Trials started{" "}
                    {(() => {
                      const d = new Date(selectedDay + "T00:00:00");
                      return Number.isNaN(d.getTime()) ? selectedDay : format(d, "MMM d, yyyy");
                    })()}
                    {!dayUsersLoading ? ` · ${dayUsers.length} users` : ""}
                  </h3>
                  <button className="filters-clear-btn" onClick={() => setSelectedDay(null)}>
                    Close
                  </button>
                </div>
                {dayUsersLoading ? (
                  <div style={{ textAlign: "center", padding: "1.5rem" }}>
                    <div className="loading-spinner"></div>
                  </div>
                ) : dayUsers.length === 0 ? (
                  <div className="empty-state" style={{ padding: "1.5rem" }}>No trial starters found for this day.</div>
                ) : (
                  <>
                    <p className="ret-chart-sub">
                      Sorted by active days. Click a name to open that user's profile in a new tab.
                    </p>
                    <div className="table-container">
                      <table className="data-table">
                        <thead className="table-head">
                          <tr>
                            <th>User</th>
                            <th>Learning</th>
                            <th>Status</th>
                            <th title="Distinct days with a completed lesson, in the 7-day trial window">Active days</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody className="table-body">
                          {dayUsers.map((u) => {
                            const href = `#user-lookup:${u.user_id}`;
                            const st = (u.payment_status || "").toUpperCase();
                            return (
                              <tr key={u.user_id}>
                                <td>
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ color: "#4f46e5", textDecoration: "none", fontWeight: 500 }}
                                  >
                                    {u.preferred_name || u.user_id.slice(0, 8) + "…"} ↗
                                  </a>
                                </td>
                                <td>{prettyLang(u.learning_language)}</td>
                                <td>
                                  {st ? (
                                    <span className={`plan-pill plan-pill--${statusVariant(u.payment_status)}`}>
                                      {st === "PAST_DUE" ? "Past Due" : st.charAt(0) + st.slice(1).toLowerCase()}
                                    </span>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td>{u.active_days}</td>
                                <td>
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ color: "#6b7280", fontSize: "0.8rem" }}
                                  >
                                    Open profile
                                  </a>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="chart-container" style={{ marginTop: "1.25rem" }}>
              <div className="ret-chart-head">
                <h3>Engagement score over the period</h3>
              </div>
              <p className="ret-chart-sub">
                Per-day engagement score (avg active days ÷ 7 × 100; 100 = every trial user active all 7 days). Recent
                partial days read low until their 7-day window completes.
              </p>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer>
                  <LineChart data={dailyChart} margin={{ top: 10, right: 24, bottom: 8, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={8} />
                    <YAxis domain={[0, "auto"]} tick={{ fontSize: 12 }} width={40} />
                    <Tooltip
                      formatter={(v: number | undefined) => [`${v ?? 0}`, "Score"]}
                      labelFormatter={(l) => {
                        const row = dailyChart.find((r) => r.label === String(l));
                        return row ? `${String(l)} · ${row.trials} trials${row.partial ? " · partial" : ""}` : String(l);
                      }}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="score"
                      stroke="#4f46e5"
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="table-container" style={{ marginTop: "1rem" }}>
              <table className="data-table">
                <thead className="table-head">
                  <tr>
                    <th>Trial start day</th>
                    <th>Trials</th>
                    <th title="Avg distinct active days in the 7-day trial window">Avg days</th>
                    <th title="Engagement score = avg days ÷ 7 × 100 (100 = all 7 days)">Score</th>
                    <th>Median</th>
                    <th>Max</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {[...dailyChart].reverse().map((r) => (
                    <tr key={r.d}>
                      <td>{r.label}</td>
                      <td>{r.trials}</td>
                      <td>{r.avg_active.toFixed(2)}</td>
                      <td>{r.score}</td>
                      <td>{r.median_active}</td>
                      <td>{r.max_active}</td>
                      <td>
                        {r.partial ? (
                          <span className="plan-pill plan-pill--trial">partial</span>
                        ) : (
                          ""
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="ret-chart-sub" style={{ marginTop: "0.75rem", maxWidth: "80ch" }}>
              <strong>Read with care:</strong> daily trial volume is small (~5–20/day), so single-day averages are
              noisy. Days within the last 7 are <em>partial</em> — their 7-day trial window hasn't finished, so their
              active-day counts will still rise.
            </p>
          </>
        )
      ) : loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Computing first-{applied.window}-day trial retention…</p>
        </div>
      ) : isBars ? (
        barData.totalUsers === 0 ? (
          <div className="empty-state" style={{ padding: "2rem" }}>
            No {popNoun} in the selected timeline — widen the date range.
          </div>
        ) : (
          <>
            <section className="metrics-grid" style={{ marginTop: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
              <div className="metric-card">
                <div className="metric-value">{barData.totalUsers.toLocaleString()}</div>
                <div className="metric-label">{isTrial ? "Trial Starters" : "App Users"}</div>
                <div className="metric-description">In selected timeline</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{barData.bars[1]?.pct ?? 0}%</div>
                <div className="metric-label">Came Back (≥2 days)</div>
                <div className="metric-description">{(barData.bars[1]?.count ?? 0).toLocaleString()} users</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{barData.bars[applied.window - 1]?.pct ?? 0}%</div>
                <div className="metric-label">Reached All {applied.window} Days</div>
                <div className="metric-description">{(barData.bars[applied.window - 1]?.count ?? 0).toLocaleString()} users</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{barData.avgDays.toFixed(2)}</div>
                <div className="metric-label">Avg Active Days</div>
                <div className="metric-description">First {applied.window} days</div>
              </div>
            </section>

            <div className="chart-container" style={{ marginTop: "1.25rem" }}>
              <div className="ret-chart-head">
                <h3>Users reaching ≥ N active days</h3>
              </div>
              <p className="ret-chart-sub">
                Distinct days used within the first {applied.window} days of the {anchorNoun}, pooled over the timeline. Hover for counts.
              </p>
              <div style={{ width: "100%", height: 340 }}>
                <ResponsiveContainer>
                  <BarChart data={barData.bars} margin={{ top: 18, right: 20, bottom: 8, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} width={48} allowDecimals={false} />
                    <Tooltip
                      formatter={(v: number | undefined) => [`${(v ?? 0).toLocaleString()} users`, "Reached"]}
                      labelFormatter={(l) => `${String(l)} active days`}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      cursor={{ fill: "rgba(79,70,229,0.06)" }}
                    />
                    <Bar dataKey="count" fill="#4f46e5" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      <LabelList dataKey="pct" position="top" formatter={(v) => `${v}%`} fontSize={10} fill="#6b7280" />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <p className="ret-chart-sub" style={{ marginTop: "0.75rem", maxWidth: "80ch" }}>
              <strong>Read with care:</strong> pooled over the selected timeline — use the Timeline range to compare periods.
              {isTrial
                ? ` Trials from the last ~${applied.window} days are excluded (window not finished), and trials from the identify()-disabled window (~Mar–Jun 2026) are absent.`
                : " This is whole-funnel engagement (mostly free users), not trial retention — switch to “Trial starters”."}
            </p>
          </>
        )
      ) : chartData.length === 0 ? (
        <div className="empty-state" style={{ padding: "2rem" }}>
          {shownRows.length === 0
            ? `No cohorts reach ${MIN_USERS}+ ${popNoun} at this granularity${isTrial ? " (trial cohorts are small)" : ""} — try Monthly.`
            : "No cohorts fall in the selected timeline — widen the date range."}
        </div>
      ) : (
        <>
          {/* Headline */}
          {summary && (
            <section className="metrics-grid" style={{ marginTop: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
              <div className="metric-card">
                <div className="metric-value">
                  {fmt(summary.latest.value)}
                </div>
                <div className="metric-label">Latest Cohort</div>
                <div className="metric-description">{summary.latest.label}</div>
              </div>
              <div className="metric-card">
                <div
                  className="metric-value"
                  style={{
                    color: trendDir === "up" ? "#059669" : trendDir === "down" ? "#dc2626" : undefined,
                  }}
                >
                  {trendDir === "up" ? "▲" : trendDir === "down" ? "▼" : "→"}{" "}
                  {summary.hasPrior ? `${summary.delta > 0 ? "+" : ""}${metric === "avg" ? summary.delta.toFixed(2) : `${Math.round(summary.delta * 10) / 10}${unit}`}` : "—"}
                </div>
                <div className="metric-label">Recent Trend</div>
                <div className="metric-description">Last 3 cohorts vs prior 3</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{fmt(summary.peak.value)}</div>
                <div className="metric-label">Peak</div>
                <div className="metric-description">{summary.peak.label}</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{summary.totalUsers.toLocaleString()}</div>
                <div className="metric-label">{isTrial ? "Trial Starters" : "App Users"}</div>
                <div className="metric-description">Across shown cohorts</div>
              </div>
            </section>
          )}

          {/* Trend chart */}
          <div className="chart-container" style={{ marginTop: "1.25rem" }}>
            <div className="ret-chart-head">
              <h3>
                {METRICS[metric].label}
                {metric === "reach" ? ` (≥${effReachN} days)` : ""} by cohort
              </h3>
            </div>
            <p className="ret-chart-sub">
              First {applied.window} days from each user's {isTrial ? "trial start" : "first lesson"}. Cohorts under {MIN_USERS} users are hidden;
              the most recent cohort counts only users whose full {applied.window}-day window has already elapsed.
            </p>
            <div style={{ width: "100%", height: 340 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 10, right: 28, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                    minTickGap={applied.gran === "day" ? 48 : 20}
                  />
                  <YAxis
                    domain={[0, "auto"]}
                    unit={unit}
                    tick={{ fontSize: 12 }}
                    width={48}
                  />
                  {summary && summary.hasPrior && (
                    <ReferenceLine
                      y={summary.prior}
                      stroke="#c7cdd6"
                      strokeDasharray="4 4"
                      label={{ value: "prior avg", position: "insideTopRight", fontSize: 10, fill: "#8b929c" }}
                    />
                  )}
                  <Tooltip
                    formatter={(v: number | undefined) => [
                      metric === "avg" ? `${v ?? 0} days` : `${v ?? 0}${unit}`,
                      METRICS[metric].label,
                    ]}
                    labelFormatter={(label) => {
                      const key = String(label);
                      const d = chartData.find((c) => c.label === key);
                      return d ? `${key} · ${d.users.toLocaleString()} users` : key;
                    }}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#4f46e5"
                    strokeWidth={applied.gran === "day" ? 1.6 : 2.5}
                    dot={applied.gran === "day" ? false : { r: 3 }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <p className="ret-chart-sub" style={{ marginTop: "0.75rem", maxWidth: "80ch" }}>
            <strong>Read with care:</strong>{" "}
            {isTrial
              ? "“Trial starters” are users with a recorded trial start (user_info.trial_started_at, from Superwall). Cohorts are anchored on the actual trial-start date, and activity is counted in the first N days of the trial — a trial user with no lessons in that window counts as 0. Coverage ~2.3k users; trials started while Superwall identify() was disabled (~Mar–Jun 2026) are anonymous and absent, so those cohorts are sparse or missing. Read monthly."
              : "This counts everyone who completed a lesson — only ~1.5% of them ever start a trial — so it is whole-funnel engagement, not trial retention. A falling line here largely reflects lower-intent acquisition as install volume scales. Switch to “Trial starters” for the trial-only signal."}
          </p>
        </>
      )}
    </div>
  );
};

export default TrialRetention;
