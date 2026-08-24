import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabase";
import {
  LineChart,
  Line,
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

const TrialRetention: React.FC = () => {
  const [windowDays, setWindowDays] = useState(14);
  const [gran, setGran] = useState<Gran>("month");
  const [metric, setMetric] = useState<Metric>("return");
  const [reachN, setReachN] = useState(3);
  // Which population: users who ever started a trial, or every app user.
  const [population, setPopulation] = useState<Population>("trial");
  // Cohort date range shown (empty string = open-ended in that direction).
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [applied, setApplied] = useState({ window: 14, gran: "month" as Gran, population: "trial" as Population });
  const [rows, setRows] = useState<CohortRaw[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const effReachN = Math.min(Math.max(2, Math.round(reachN) || 2), applied.window);

  // Cohorts big enough to show (RPC returns them ordered by cohort asc).
  const shownRows = useMemo(() => rows.filter((r) => r.users >= MIN_USERS), [rows]);
  // Available date bounds, used for the range inputs and presets.
  const bounds = useMemo(
    () => (shownRows.length ? { min: shownRows[0].cohort, max: shownRows[shownRows.length - 1].cohort } : null),
    [shownRows],
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

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title" style={{ margin: 0 }}>
        Trial Retention
        {summary && (
          <span className="lessons-detail-count">
            {summary.totalUsers.toLocaleString()} {popNoun} · {summary.count} cohorts
          </span>
        )}
      </h2>
      <p className="ret-chart-sub" style={{ marginTop: "0.4rem", maxWidth: "72ch" }}>
        Among <strong>{popNoun}</strong>{" "}
        {isTrial
          ? "(users who ever entered the trial funnel — Superwall status TRIAL / ACTIVE / CANCELED / PAST_DUE / EXPIRED)"
          : "(everyone who completed ≥1 lesson, most of whom never started a trial)"}
        , grouped by the {applied.gran} of their <strong>first lesson</strong>, the line tracks{" "}
        {METRICS[metric].blurb(effReachN, applied.window)} Rising = retention improving.
      </p>

      {/* Controls */}
      <div
        className="controls-bar"
        style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginTop: "1rem" }}
      >
        <div className="ret-seg" role="group" aria-label="Population">
          <button
            className={`ret-seg-btn${population === "trial" ? " ret-seg-btn--on" : ""}`}
            onClick={() => setPopulation("trial")}
            title="Only users who ever started a trial (Superwall status TRIAL/ACTIVE/CANCELED/PAST_DUE/EXPIRED)"
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
      </div>

      {/* Date range */}
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

      {error && (
        <div className="error-box" style={{ margin: "1rem 0" }}>
          <p>Failed to load: {error}</p>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Computing first-{applied.window}-day retention by cohort…</p>
        </div>
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
            <section className="metrics-grid" style={{ marginTop: "1rem" }}>
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
              First {applied.window} days from each user's first lesson. Cohorts under {MIN_USERS} users are hidden;
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
              ? "“Trial starters” are users who ever reached a Superwall subscription status (TRIAL / ACTIVE / CANCELED / PAST_DUE / EXPIRED). Their cohort is anchored at their first lesson, which can predate the actual trial start — no trial-start timestamp exists in the DB. Cohorts are small (~2.9k users total), so read monthly for the trend and treat single-month moves cautiously."
              : "This counts everyone who completed a lesson — only ~1.5% of them ever start a trial — so it is whole-funnel engagement, not trial retention. A falling line here largely reflects lower-intent acquisition as install volume scales. Switch to “Trial starters” for the trial-only signal."}
          </p>
        </>
      )}
    </div>
  );
};

export default TrialRetention;
