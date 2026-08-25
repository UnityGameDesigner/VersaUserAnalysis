import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import { format } from "date-fns";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// Retention is scoped to currently-ACTIVE (paying) users. Because every user
// here is still subscribed, these curves measure ENGAGEMENT retention — how
// consistently paying users keep completing lessons over time — not churn. A
// decaying curve flags paying-but-dormant users (a churn-risk signal). Each
// user's cohort is their FIRST completed lesson (pulled by user_id, so a
// trial-era first lesson still anchors the cohort correctly).

interface ActiveUserRow {
  id: number;
  user_id: string;
  tutor: string | null;
  native_language: string | null;
  attribution: string | null;
  demand_tier: string | null;
}

interface LessonRow {
  user_id: string;
  created_at: string;
}

const PAGE_SIZE = 1000;
const USER_ID_CHUNK = 60; // user_ids per `in.()` lessons query

type Gran = "month" | "week";

// ── period helpers ───────────────────────────────
const monthKey = (iso: string): string => iso.slice(0, 7); // YYYY-MM
const monthIndex = (key: string): number => {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + (m - 1);
};
// Monday-anchored week, keyed by the Monday's date (UTC).
const weekKey = (iso: string): string => {
  const d = new Date(iso);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow),
  );
  return monday.toISOString().slice(0, 10);
};
const weekIndex = (key: string): number =>
  Math.round(Date.parse(key + "T00:00:00Z") / (7 * 86400000));

const cohortLabel = (key: string, gran: Gran): string =>
  gran === "month"
    ? format(new Date(key + "-01T00:00:00Z"), "MMM yyyy")
    : format(new Date(key + "T00:00:00Z"), "MMM d");

interface CohortRow {
  key: string;
  idx: number;
  size: number;
  cells: (number | null)[]; // retention fraction per offset, null = no data yet
}
interface CohortResult {
  rows: CohortRow[];
  maxOffset: number;
  curve: { offset: number; retention: number | null; cohorts: number }[];
}

// Build the cohort retention triangle + averaged curve for a granularity.
function computeCohorts(
  lessons: LessonRow[],
  userIds: Set<string>,
  gran: Gran,
): CohortResult {
  const keyFn = gran === "month" ? monthKey : weekKey;
  const idxFn = gran === "month" ? monthIndex : weekIndex;

  const firstByUser = new Map<string, { idx: number; key: string }>();
  const activeByUser = new Map<string, Set<number>>();
  let lastIdx = -Infinity;

  for (const l of lessons) {
    if (!userIds.has(l.user_id)) continue;
    const key = keyFn(l.created_at);
    const idx = idxFn(key);
    lastIdx = Math.max(lastIdx, idx);
    const cur = firstByUser.get(l.user_id);
    if (!cur || idx < cur.idx) firstByUser.set(l.user_id, { idx, key });
    let set = activeByUser.get(l.user_id);
    if (!set) {
      set = new Set();
      activeByUser.set(l.user_id, set);
    }
    set.add(idx);
  }

  const cohorts = new Map<string, { idx: number; users: string[] }>();
  for (const [u, f] of firstByUser) {
    let c = cohorts.get(f.key);
    if (!c) {
      c = { idx: f.idx, users: [] };
      cohorts.set(f.key, c);
    }
    c.users.push(u);
  }

  if (cohorts.size === 0 || !isFinite(lastIdx)) {
    return { rows: [], maxOffset: 0, curve: [] };
  }

  const minCohortIdx = Math.min(...[...cohorts.values()].map((c) => c.idx));
  const maxOffset = Math.max(0, lastIdx - minCohortIdx);

  const rows: CohortRow[] = [...cohorts.entries()]
    .sort((a, b) => a[1].idx - b[1].idx)
    .map(([key, c]) => {
      const rowMax = lastIdx - c.idx;
      const cells: (number | null)[] = [];
      for (let k = 0; k <= maxOffset; k++) {
        if (k > rowMax) {
          cells.push(null);
          continue;
        }
        let retained = 0;
        for (const u of c.users) {
          if (activeByUser.get(u)!.has(c.idx + k)) retained++;
        }
        cells.push(retained / c.users.length);
      }
      return { key, idx: c.idx, size: c.users.length, cells };
    });

  const curve = [];
  for (let k = 0; k <= maxOffset; k++) {
    let ret = 0;
    let base = 0;
    for (const r of rows) {
      const v = r.cells[k];
      if (v != null) {
        ret += v * r.size;
        base += r.size;
      }
    }
    curve.push({
      offset: k,
      retention: base > 0 ? (ret / base) * 100 : null,
      cohorts: base,
    });
  }

  return { rows, maxOffset, curve };
}

// Heatmap cell background — red (low retention) → yellow → green (high), so
// cohort trends read at a glance. Lightness stays high enough for dark text.
const heatColor = (frac: number): string =>
  `hsl(${Math.round(frac * 130)}, 72%, ${Math.round(78 - Math.abs(frac - 0.5) * 26)}%)`;

const MAX_HEATMAP_COLS = 12;

const CohortHeatmap: React.FC<{
  title: string;
  subtitle: string;
  result: CohortResult;
  gran: Gran;
}> = ({ title, subtitle, result, gran }) => {
  const cols = Math.min(result.maxOffset, MAX_HEATMAP_COLS);
  const prefix = gran === "month" ? "M" : "W";
  if (result.rows.length === 0) {
    return (
      <div className="chart-container">
        <h3>{title}</h3>
        <div className="empty-state">No data for the current selection</div>
      </div>
    );
  }
  return (
    <div className="chart-container">
      <h3>{title}</h3>
      <p className="ret-chart-sub">{subtitle}</p>
      <div className="ret-heatmap-scroll">
        <table className="ret-heatmap">
          <thead>
            <tr>
              <th className="ret-heatmap-cohort">Cohort</th>
              <th className="ret-heatmap-size">Users</th>
              {Array.from({ length: cols + 1 }, (_, k) => (
                <th key={k}>
                  {prefix}
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.key}>
                <td className="ret-heatmap-cohort">{cohortLabel(r.key, gran)}</td>
                <td className="ret-heatmap-size">{r.size}</td>
                {Array.from({ length: cols + 1 }, (_, k) => {
                  const v = r.cells[k];
                  if (v == null) return <td key={k} className="ret-cell-empty" />;
                  const pct = Math.round(v * 100);
                  return (
                    <td
                      key={k}
                      className="ret-cell"
                      style={{
                        background: heatColor(v),
                        color: "#1f2937",
                      }}
                      title={`${cohortLabel(r.key, gran)} · ${prefix}${k}: ${pct}% (${Math.round(
                        v * r.size,
                      )}/${r.size})`}
                    >
                      {pct}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.6rem", fontSize: 12, color: "#52514e" }}>
        <span>Retention</span>
        <span>low</span>
        <span
          style={{
            height: 12,
            width: 140,
            borderRadius: 3,
            display: "inline-block",
            background: "linear-gradient(to right, hsl(0,72%,65%), hsl(65,72%,78%), hsl(130,72%,65%))",
          }}
        />
        <span>high</span>
      </div>
      {result.maxOffset > MAX_HEATMAP_COLS && (
        <p className="ret-chart-note">
          Showing first {MAX_HEATMAP_COLS} periods of {result.maxOffset}.
        </p>
      )}
    </div>
  );
};

interface Props {
  onUserClick?: (userId: string) => void;
}

const RetentionAnalysis: React.FC<Props> = () => {
  const [users, setUsers] = useState<ActiveUserRow[]>([]);
  const [lessons, setLessons] = useState<LessonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selTutor, setSelTutor] = useState("All");
  const [selLanguage, setSelLanguage] = useState("All");
  const [selAttribution, setSelAttribution] = useState("All");
  const [selDemandTier, setSelDemandTier] = useState("All");
  const [curveGran, setCurveGran] = useState<Gran>("month");

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        // 1. Active users (+ segment fields).
        let allUsers: ActiveUserRow[] = [];
        let lastId = 0;
        let more = true;
        while (more) {
          const { data, error } = await supabase
            .from("user_info")
            .select("id, user_id, tutor, native_language, attribution, demand_tier")
            .eq("payment_status", "ACTIVE")
            .gt("id", lastId)
            .order("id", { ascending: true })
            .limit(PAGE_SIZE);
          if (error) throw new Error(error.message);
          if (data && data.length > 0) {
            allUsers = [...allUsers, ...data];
            lastId = data[data.length - 1].id;
            more = data.length === PAGE_SIZE;
          } else {
            more = false;
          }
        }
        const dedup = new Map<string, ActiveUserRow>();
        allUsers.forEach((u) => {
          if (!dedup.has(u.user_id)) dedup.set(u.user_id, u);
        });
        const userRows = Array.from(dedup.values());
        setUsers(userRows);

        // 2. Their full lesson history, by user_id membership (not by the
        //    lesson's payment_status snapshot), batched to keep URLs short.
        const ids = userRows.map((u) => u.user_id);
        let allLessons: LessonRow[] = [];
        for (let i = 0; i < ids.length; i += USER_ID_CHUNK) {
          const chunk = ids.slice(i, i + USER_ID_CHUNK);
          let lid = 0;
          let m2 = true;
          while (m2) {
            const { data, error } = await supabase
              .from("completed_lessons")
              .select("id, user_id, created_at")
              .in("user_id", chunk)
              .gt("id", lid)
              .order("id", { ascending: true })
              .limit(PAGE_SIZE);
            if (error) throw new Error(error.message);
            if (data && data.length > 0) {
              allLessons = allLessons.concat(
                data.map((d) => ({ user_id: d.user_id, created_at: d.created_at })),
              );
              lid = data[data.length - 1].id;
              m2 = data.length === PAGE_SIZE;
            } else {
              m2 = false;
            }
          }
        }
        setLessons(allLessons);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };
    run();
  }, []);

  // ── filter option lists ──
  const opts = (pick: (u: ActiveUserRow) => string | null) => {
    const set = new Set<string>();
    users.forEach((u) => set.add(pick(u) || "Unknown"));
    return ["All", ...Array.from(set).sort()];
  };
  const tutorOpts = useMemo(() => opts((u) => u.tutor), [users]);
  const langOpts = useMemo(() => opts((u) => u.native_language), [users]);
  const attrOpts = useMemo(() => opts((u) => u.attribution), [users]);
  const tierOpts = useMemo(() => opts((u) => u.demand_tier), [users]);

  const filteredUserIds = useMemo(() => {
    const set = new Set<string>();
    users.forEach((u) => {
      if (selTutor !== "All" && (u.tutor || "Unknown") !== selTutor) return;
      if (selLanguage !== "All" && (u.native_language || "Unknown") !== selLanguage) return;
      if (selAttribution !== "All" && (u.attribution || "Unknown") !== selAttribution) return;
      if (selDemandTier !== "All" && (u.demand_tier || "Unknown") !== selDemandTier) return;
      set.add(u.user_id);
    });
    return set;
  }, [users, selTutor, selLanguage, selAttribution, selDemandTier]);

  const filteredLessons = useMemo(
    () => lessons.filter((l) => filteredUserIds.has(l.user_id)),
    [lessons, filteredUserIds],
  );

  const monthly = useMemo(
    () => computeCohorts(filteredLessons, filteredUserIds, "month"),
    [filteredLessons, filteredUserIds],
  );
  const weekly = useMemo(
    () => computeCohorts(filteredLessons, filteredUserIds, "week"),
    [filteredLessons, filteredUserIds],
  );

  // ── KPIs + lessons-per-user distribution ──
  const stats = useMemo(() => {
    const counts = new Map<string, number>();
    filteredUserIds.forEach((u) => counts.set(u, 0));
    filteredLessons.forEach((l) => counts.set(l.user_id, (counts.get(l.user_id) || 0) + 1));
    const arr = Array.from(counts.values());
    const n = arr.length;
    const total = arr.reduce((s, x) => s + x, 0);
    const sorted = [...arr].sort((a, b) => a - b);
    const median = n === 0 ? 0 : sorted[Math.floor(n / 2)];
    const ge2 = arr.filter((x) => x >= 2).length;

    const order = ["0", "1", "2", "3", "4", "5", "6–10", "11–20", "21+"];
    const bucket = (x: number) =>
      x <= 5 ? String(x) : x <= 10 ? "6–10" : x <= 20 ? "11–20" : "21+";
    const dist = new Map<string, number>();
    arr.forEach((x) => dist.set(bucket(x), (dist.get(bucket(x)) || 0) + 1));
    const distribution = order
      .filter((b) => dist.has(b))
      .map((b) => ({ name: b, value: dist.get(b)! }));

    return {
      n,
      total,
      avg: n ? total / n : 0,
      median,
      pctGe2: n ? (ge2 / n) * 100 : 0,
      distribution,
    };
  }, [filteredUserIds, filteredLessons]);

  const curve = curveGran === "month" ? monthly.curve : weekly.curve;
  const curveData = curve
    .filter((c) => c.retention != null)
    .map((c) => ({
      offset: `${curveGran === "month" ? "M" : "W"}${c.offset}`,
      retention: Math.round((c.retention as number) * 10) / 10,
    }));
  const m1 = monthly.curve[1]?.retention ?? null;
  const w1 = weekly.curve[1]?.retention ?? null;

  const anyFilter =
    selTutor !== "All" ||
    selLanguage !== "All" ||
    selAttribution !== "All" ||
    selDemandTier !== "All";

  if (loading) {
    return (
      <div className="dashboard-container">
        <div className="dashboard-inner">
          <div className="loading-container">
            <div style={{ textAlign: "center" }}>
              <div className="loading-spinner"></div>
              <p className="loading-text">Loading retention data…</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-container">
        <div className="dashboard-inner">
          <div className="error-box">
            <h2 className="error-title">Error Loading Retention</h2>
            <p>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <div className="dashboard-inner">
        <header className="ret-header">
          <h2 className="lessons-detail-title" style={{ marginBottom: 4 }}>
            Retention — Active Users
          </h2>
          <p className="ret-intro">
            Engagement retention for currently-active (paying) users. Each user's
            cohort is the {curveGran === "month" ? "month" : "week"} of their first
            completed lesson; a cell shows the share of that cohort who completed
            ≥1 lesson in a later period. Since all users here are still subscribed,
            a falling curve signals <strong>paying-but-dormant</strong> users, not
            cancellations.
          </p>
        </header>

        {/* Segment filters */}
        <section className="filters-bar" style={{ marginBottom: "1.25rem" }}>
          <div className="filters-bar-inner">
            <div className="filter-dropdown-group">
              <label className="filter-label">Tutor</label>
              <select className="filter-select" value={selTutor} onChange={(e) => setSelTutor(e.target.value)}>
                {tutorOpts.map((o) => (
                  <option key={o} value={o}>{o === "All" ? "All Tutors" : o}</option>
                ))}
              </select>
            </div>
            <div className="filter-dropdown-group">
              <label className="filter-label">Language</label>
              <select className="filter-select" value={selLanguage} onChange={(e) => setSelLanguage(e.target.value)}>
                {langOpts.map((o) => (
                  <option key={o} value={o}>{o === "All" ? "All Languages" : o}</option>
                ))}
              </select>
            </div>
            <div className="filter-dropdown-group">
              <label className="filter-label">Attribution</label>
              <select className="filter-select" value={selAttribution} onChange={(e) => setSelAttribution(e.target.value)}>
                {attrOpts.map((o) => (
                  <option key={o} value={o}>{o === "All" ? "All Sources" : o}</option>
                ))}
              </select>
            </div>
            <div className="filter-dropdown-group">
              <label className="filter-label">Demand Tier</label>
              <select className="filter-select" value={selDemandTier} onChange={(e) => setSelDemandTier(e.target.value)}>
                {tierOpts.map((o) => (
                  <option key={o} value={o}>{o === "All" ? "All Tiers" : o}</option>
                ))}
              </select>
            </div>
            {anyFilter && (
              <button
                className="filters-clear-btn"
                onClick={() => {
                  setSelTutor("All");
                  setSelLanguage("All");
                  setSelAttribution("All");
                  setSelDemandTier("All");
                }}
              >
                Clear All
              </button>
            )}
            <span className="filters-count">{stats.n} users</span>
          </div>
        </section>

        {/* KPIs */}
        <section className="metrics-grid" style={{ marginBottom: "1.25rem" }}>
          <div className="metric-card">
            <div className="metric-value">{stats.n}</div>
            <div className="metric-label">Active Users</div>
            <div className="metric-description">Currently paying</div>
          </div>
          <div className="metric-card">
            <div className="metric-value">{stats.avg.toFixed(1)}</div>
            <div className="metric-label">Avg Lessons / User</div>
            <div className="metric-description">Median {stats.median}</div>
          </div>
          <div className="metric-card">
            <div className="metric-value">{stats.pctGe2.toFixed(0)}%</div>
            <div className="metric-label">Did ≥ 2 Lessons</div>
            <div className="metric-description">Beyond first lesson</div>
          </div>
          <div className="metric-card">
            <div className="metric-value">{m1 == null ? "—" : `${Math.round(m1)}%`}</div>
            <div className="metric-label">Month-1 Retention</div>
            <div className="metric-description">Active in 2nd month</div>
          </div>
          <div className="metric-card">
            <div className="metric-value">{w1 == null ? "—" : `${Math.round(w1)}%`}</div>
            <div className="metric-label">Week-1 Retention</div>
            <div className="metric-description">Active in 2nd week</div>
          </div>
        </section>

        {/* Retention curve */}
        <div className="chart-container" style={{ marginBottom: "1.25rem" }}>
          <div className="ret-chart-head">
            <h3>Retention Curve</h3>
            <div className="ret-seg">
              <button
                className={`ret-seg-btn${curveGran === "month" ? " ret-seg-btn--on" : ""}`}
                onClick={() => setCurveGran("month")}
              >
                Monthly
              </button>
              <button
                className={`ret-seg-btn${curveGran === "week" ? " ret-seg-btn--on" : ""}`}
                onClick={() => setCurveGran("week")}
              >
                Weekly
              </button>
            </div>
          </div>
          <p className="ret-chart-sub">
            Share of users still completing lessons N periods after their first,
            weighted across cohorts with enough elapsed time.
          </p>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <LineChart data={curveData} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="offset" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number | undefined) => [`${v ?? 0}%`]} />
                <Line type="monotone" dataKey="retention" stroke="#4f46e5" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Cohort heatmaps */}
        <CohortHeatmap
          title="Monthly Cohort Retention"
          subtitle="Rows = month of first lesson · cells = % of cohort active that month offset"
          result={monthly}
          gran="month"
        />
        <div style={{ height: "1.25rem" }} />
        <CohortHeatmap
          title="Weekly Cohort Retention"
          subtitle="Rows = week of first lesson · small cohorts (≈few users/week) will be noisy"
          result={weekly}
          gran="week"
        />
        <div style={{ height: "1.25rem" }} />

        {/* Lessons per user */}
        <div className="chart-container">
          <h3>Lessons per User</h3>
          <p className="ret-chart-sub">How many lessons each active user has completed</p>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={stats.distribution} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number | undefined) => [`${v ?? 0} users`]} />
                <Bar dataKey="value" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RetentionAnalysis;
