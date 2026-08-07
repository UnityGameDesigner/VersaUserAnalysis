import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabase";
import { getCountryFromTimezone } from "./lib/timezone";

// Users whose subscription is CANCELED. "Cancelled their trial" = CANCELED AND
// never converted (became_active_at is null): they started a trial and cancelled
// before paying. The 191-ish with became_active_at set DID convert and then
// churned — that's a paid cancellation, not a trial cancel, so it's a separate
// filter here. Caveat: became_active_at stamping is recent, so a few old paid
// cancellations pre-date it and land in "trial" — for a trial-first product the
// large majority are still genuine trial cancels.

interface CancelledUser {
  user_id: string;
  preferred_name: string | null;
  // user_info.age is a TEXT column — "0"/"-1" are unset sentinels, not real ages.
  age: number | string | null;
  gender: string | null;
  native_language: string | null;
  learning_language: string | null;
  level: string | null;
  tutor: string | null;
  reason: string | null;
  attribution: string | null;
  time_zone: string | null;
  daily_streak: number | null;
  last_logged_in: string | null;
  last_completed_at: string | null;
  became_active_at: string | null;
  // Churn type: CANCELED = actively cancelled, PAST_DUE = billing issue.
  payment_status: string | null;
  past_due_at: string | null;
  became_past_due_at: string | null;
  canceled_at: string | null;
}

const PAGE_SIZE = 1000;

// Per-user engagement (from the engagement_by_user RPC).
interface Engagement {
  lessons: number;
  turns: number;
  days: number;
}

// Aggregate insights (from the cancelled_trials_insights RPC).
interface Insights {
  window_days: number | null;
  funnel: {
    trial_cancels: number;
    never_started: number;
    onboarding_only: number;
    lessons_1_2: number;
    lessons_3_5: number;
    lessons_6_10: number;
    lessons_11plus: number;
    avg_lessons: number;
    avg_days: number;
    median_days: number;
    median_lessons: number;
  };
  by_days: {
    bucket: string;
    users: number;
    converted: number;
    conversion_rate: number;
  }[];
  by_source: {
    source: string;
    finished_trial: number;
    trial_cancels: number;
    pct_cancel: number;
  }[];
  cohorts: {
    cohort: string;
    users: number;
    avg_lessons: number;
    median_lessons: number;
    avg_days: number;
    median_days: number;
  }[];
  friction: {
    real_lesson_rows: number;
    zero_turn_lessons: number;
    pct_zero_turn: number;
    users: number;
  };
}

// native_language / learning_language are lowercase codes ("english"). Titlecase.
function prettyLang(code: string | null): string {
  if (!code || !code.trim()) return "N/A";
  return code
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function displayAge(ageRaw: number | string | null): string {
  if (ageRaw === null || ageRaw === undefined || ageRaw === "") return "—";
  const age = typeof ageRaw === "number" ? ageRaw : Number.parseInt(ageRaw, 10);
  return !Number.isFinite(age) || age <= 0 ? "—" : String(age);
}

// Voluntary cancel (CANCELED) vs involuntary billing issue (PAST_DUE).
function isBillingIssue(u: { payment_status: string | null }): boolean {
  return (u.payment_status || "").toUpperCase() === "PAST_DUE";
}

// When the billing issue was recorded. past_due_at is ~always set on PAST_DUE;
// became_past_due_at is our webhook column and only covers recent ones.
function billingIssueDate(u: CancelledUser): string | null {
  return u.past_due_at || u.became_past_due_at || null;
}

type FilterMode = "trial" | "paid" | "billing" | "all";

// Time window for the whole tab, anchored on last login (there is no reliable
// historical cancellation timestamp — canceled_at only started stamping recently).
// "All time" keeps the full history.
const WINDOW_OPTIONS: { label: string; days: number | null }[] = [
  { label: "Last 30 days", days: 30 },
  { label: "Last 60 days", days: 60 },
  { label: "Last 90 days", days: 90 },
  { label: "All time", days: null },
];

function windowLabelFor(days: number | null): string {
  return WINDOW_OPTIONS.find((o) => o.days === days)?.label ?? "All time";
}

// A simple horizontal bar row for the insights panel, in the app's light palette.
const InsightBar: React.FC<{
  label: string;
  pct: number; // fill width, 0–100
  caption: string;
  color?: string;
  highlight?: boolean;
}> = ({ label, pct, caption, color = "#6366f1", highlight = false }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", padding: "0.18rem 0" }}>
    <div
      style={{
        width: 92,
        flexShrink: 0,
        textAlign: "right",
        fontSize: "0.8rem",
        fontWeight: highlight ? 700 : 500,
        color: highlight ? "#1a1a2e" : "#4b5563",
      }}
    >
      {label}
    </div>
    <div style={{ flex: 1, height: 22, background: "#f1f5f9", borderRadius: 6, overflow: "hidden" }}>
      <div
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          minWidth: pct > 0 ? 3 : 0,
          height: "100%",
          background: color,
          borderRadius: 6,
        }}
      />
    </div>
    <div style={{ width: 172, flexShrink: 0, fontSize: "0.78rem", color: "#6b7280" }}>{caption}</div>
  </div>
);

// Small pill marking whether a metric follows the selected window or is all-time.
const ScopeTag: React.FC<{ text: string; tone?: "window" | "all" }> = ({ text, tone = "window" }) => (
  <span
    style={{
      fontSize: "0.6rem",
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.03em",
      padding: "0.1rem 0.4rem",
      borderRadius: 999,
      marginLeft: "0.45rem",
      verticalAlign: "middle",
      whiteSpace: "nowrap",
      color: tone === "window" ? "#3730a3" : "#6b7280",
      background: tone === "window" ? "#eef2ff" : "#f3f4f6",
      border: `1px solid ${tone === "window" ? "#c7d2fe" : "#e5e7eb"}`,
    }}
  >
    {text}
  </span>
);

const CancelledTrials: React.FC<{ onUserClick?: (userId: string) => void }> = ({
  onUserClick,
}) => {
  const [users, setUsers] = useState<CancelledUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<FilterMode>("trial");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("lastLoggedIn");
  // Time window (days) applied to the whole tab; null = all time. Default: last month.
  const [windowDays, setWindowDays] = useState<number | null>(30);
  // Per-user engagement + aggregate insights (server-side RPCs). null = loading.
  const [engagementMap, setEngagementMap] = useState<Map<string, Engagement> | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);

  const fetchCancelled = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Restrict to users last seen within the window (by last login). null = all time.
    const cutoff =
      windowDays != null
        ? new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10)
        : null;
    try {
      let all: CancelledUser[] = [];
      let lastId = 0;
      let hasMore = true;
      while (hasMore) {
        let q = supabase
          .from("user_info")
          .select(
            `id, user_id, preferred_name, age, gender, native_language,
             learning_language, level, tutor, reason, attribution, time_zone,
             daily_streak, last_logged_in, last_completed_at, became_active_at,
             payment_status, past_due_at, became_past_due_at, canceled_at`,
          )
          .in("payment_status", ["CANCELED", "PAST_DUE"])
          .gt("id", lastId)
          .order("id", { ascending: true })
          .limit(PAGE_SIZE);
        if (cutoff) q = q.gte("last_logged_in", cutoff);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        if (data && data.length > 0) {
          all = all.concat(data as unknown as (CancelledUser & { id: number })[]);
          lastId = (data[data.length - 1] as { id: number }).id;
          hasMore = data.length === PAGE_SIZE;
        } else {
          hasMore = false;
        }
      }
      // Dedupe by user_id (user_info can carry repeat rows).
      const seen = new Map<string, CancelledUser>();
      all.forEach((u) => {
        if (!seen.has(u.user_id)) seen.set(u.user_id, u);
      });
      setUsers(Array.from(seen.values()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    fetchCancelled();
  }, [fetchCancelled]);

  // Per-user engagement (for the table's Engagement column). Window-independent —
  // the table only looks up the rows it shows — so fetch once. Non-fatal.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: engRows, error: engErr } = await supabase.rpc("engagement_by_user", {
        statuses: ["CANCELED", "PAST_DUE"],
      });
      if (cancelled) return;
      if (engErr) {
        console.warn("engagement_by_user RPC unavailable — engagement column blank:", engErr.message);
        setEngagementMap(new Map());
      } else {
        const map = new Map<string, Engagement>();
        (engRows as { user_id: string; lessons: number; turns: number; days: number }[] | null)?.forEach(
          (r) =>
            map.set(r.user_id, {
              lessons: Number(r.lessons),
              turns: Number(r.turns),
              days: Number(r.days ?? 0),
            }),
        );
        setEngagementMap(map);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Aggregate insights, scoped to the selected window. Refetches when it changes.
  useEffect(() => {
    let cancelled = false;
    setInsights(null);
    setInsightsError(null);
    (async () => {
      const { data: ins, error: insErr } = await supabase.rpc("cancelled_trials_insights", {
        window_days: windowDays,
      });
      if (cancelled) return;
      if (insErr) {
        console.warn("cancelled_trials_insights RPC unavailable:", insErr.message);
        setInsightsError(insErr.message);
      } else {
        setInsights(ins as Insights);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  const counts = useMemo(() => {
    let trial = 0;
    let paid = 0;
    let billing = 0;
    users.forEach((u) => {
      if (isBillingIssue(u)) billing++;
      else if (u.became_active_at) paid++;
      else trial++;
    });
    return { trial, paid, billing, all: users.length };
  }, [users]);

  const filtered = useMemo(() => {
    let list = users;
    if (mode === "trial") list = list.filter((u) => !isBillingIssue(u) && !u.became_active_at);
    else if (mode === "paid") list = list.filter((u) => !isBillingIssue(u) && !!u.became_active_at);
    else if (mode === "billing") list = list.filter((u) => isBillingIssue(u));
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (u) =>
          (u.preferred_name || "").toLowerCase().includes(q) ||
          u.user_id.toLowerCase().includes(q),
      );
    }
    return list;
  }, [users, mode, query]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sortBy) {
      case "name":
        list.sort((a, b) =>
          (a.preferred_name || "").localeCompare(b.preferred_name || ""),
        );
        break;
      case "streak":
        list.sort((a, b) => (b.daily_streak || 0) - (a.daily_streak || 0));
        break;
      case "engagement":
        // Days-first (the primary signal), then turns, then lessons; no data sorts last.
        list.sort((a, b) => {
          const ae = engagementMap?.get(a.user_id);
          const be = engagementMap?.get(b.user_id);
          const ad = ae?.days ?? -1;
          const bd = be?.days ?? -1;
          if (bd !== ad) return bd - ad;
          const at = ae?.turns ?? -1;
          const bt = be?.turns ?? -1;
          if (bt !== at) return bt - at;
          return (be?.lessons ?? -1) - (ae?.lessons ?? -1);
        });
        break;
      case "lastCompleted":
        list.sort((a, b) => {
          const at = a.last_completed_at ? new Date(a.last_completed_at).getTime() : 0;
          const bt = b.last_completed_at ? new Date(b.last_completed_at).getTime() : 0;
          return bt - at;
        });
        break;
      case "lastLoggedIn":
      default:
        list.sort((a, b) => {
          const at = a.last_logged_in ? new Date(a.last_logged_in).getTime() : 0;
          const bt = b.last_logged_in ? new Date(b.last_logged_in).getTime() : 0;
          return bt - at;
        });
        break;
    }
    return list;
  }, [filtered, sortBy, engagementMap]);

  // "Tried it" = completed at least one lesson before cancelling.
  const triedIt = useMemo(
    () => filtered.filter((u) => u.last_completed_at).length,
    [filtered],
  );

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title" style={{ margin: 0 }}>
        Cancelled Trials
        <span className="lessons-detail-count">
          {counts.trial.toLocaleString()} cancelled · {counts.billing.toLocaleString()} billing
        </span>
      </h2>
      <p className="ret-chart-sub" style={{ marginTop: "0.4rem" }}>
        Trials and subscriptions that didn't stick, split by how they ended:{" "}
        <strong>Cancelled</strong> (chose to leave — <code>CANCELED</code>) vs{" "}
        <strong>Billing issue</strong> (payment failed — <code>PAST_DUE</code>, often
        recoverable). The <em>Exit</em> column and the tabs below tell them apart.{" "}
        <strong>Showing {windowLabelFor(windowDays).toLowerCase()}</strong> (by last login).
      </p>

      {error && (
        <div className="error-box" style={{ margin: "1rem 0" }}>
          <p>Failed to load cancelled trials: {error}</p>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Loading cancelled trials…</p>
        </div>
      ) : (
        <>
          {/* Cohort filter */}
          <div className="cohort-bar" style={{ marginTop: "1rem" }}>
            <span className="cohort-bar-label">Show</span>
            <div className="cohort-seg" role="tablist" aria-label="Churn type">
              {(
                [
                  { key: "trial", label: "Cancelled trial", count: counts.trial },
                  { key: "billing", label: "Billing issue", count: counts.billing },
                  { key: "paid", label: "Paid, then cancelled", count: counts.paid },
                  { key: "all", label: "All", count: counts.all },
                ] as const
              ).map((c) => (
                <button
                  key={c.key}
                  role="tab"
                  aria-selected={mode === c.key}
                  className={`cohort-seg-btn${mode === c.key ? " cohort-seg-btn--on" : ""}`}
                  onClick={() => setMode(c.key)}
                >
                  <span className="cohort-seg-name">{c.label}</span>
                  <span className="cohort-seg-count">{c.count}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Summary */}
          <section className="metrics-grid" style={{ marginTop: "1rem" }}>
            <div className="metric-card">
              <div className="metric-value">{filtered.length}</div>
              <div className="metric-label">
                {mode === "trial"
                  ? "Trial Cancels"
                  : mode === "paid"
                  ? "Paid Cancels"
                  : mode === "billing"
                  ? "Billing Issues"
                  : "Churned"}
              </div>
              <div className="metric-description">
                {mode === "trial"
                  ? "Never converted"
                  : mode === "paid"
                  ? "Converted, then churned"
                  : mode === "billing"
                  ? "Payment failed (PAST_DUE)"
                  : "Cancels + billing issues"}
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{triedIt}</div>
              <div className="metric-label">Tried It</div>
              <div className="metric-description">
                {filtered.length > 0
                  ? `${((triedIt / filtered.length) * 100).toFixed(0)}% completed a lesson`
                  : "—"}
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{filtered.length - triedIt}</div>
              <div className="metric-label">Never Opened</div>
              <div className="metric-description">No completed lesson</div>
            </div>
          </section>

          {/* Insights panel */}
          {insightsError ? (
            <div className="eng-warning" style={{ display: "inline-block", marginTop: "1.25rem" }}>
              Insights unavailable — run supabase/sql/cancelled_trials_insights.sql
            </div>
          ) : !insights ? (
            <div style={{ marginTop: "1.25rem", color: "#9ca3af", fontSize: "0.85rem" }}>
              Loading insights…
            </div>
          ) : (
            (() => {
              const f = insights.funnel;
              const conv = insights.cohorts.find((c) => c.cohort === "converted");
              const oneDay = insights.by_days.find((d) => d.bucket === "1 day");
              const winLabel = insights.window_days ? `last ${insights.window_days}d` : "all time";
              const engaged3 = f.lessons_3_5 + f.lessons_6_10 + f.lessons_11plus;
              const engagedPct = f.trial_cancels > 0 ? Math.round((engaged3 / f.trial_cancels) * 100) : 0;
              const barelyPct =
                f.trial_cancels > 0
                  ? Math.round(((f.never_started + f.onboarding_only) / f.trial_cancels) * 100)
                  : 0;
              const funnelRows = [
                { label: "Never opened", value: f.never_started },
                { label: "Onboarding only", value: f.onboarding_only },
                { label: "1–2 lessons", value: f.lessons_1_2 },
                { label: "3–5 lessons", value: f.lessons_3_5 },
                { label: "6–10 lessons", value: f.lessons_6_10 },
                { label: "11+ lessons", value: f.lessons_11plus },
              ];
              const funnelMax = Math.max(...funnelRows.map((r) => r.value), 1);
              const dayMax = Math.max(...insights.by_days.map((d) => d.conversion_rate), 1);
              const srcMax = Math.max(...insights.by_source.map((s) => s.pct_cancel), 1);
              const cardLeft = { textAlign: "left" as const, padding: "1rem 1.1rem" };
              const cardTitle = { fontWeight: 700, color: "#1a1a2e", marginBottom: "0.1rem" };
              const cardSub = { fontSize: "0.76rem", color: "#9ca3af", marginBottom: "0.6rem" };
              return (
                <section style={{ marginTop: "1.5rem" }}>
                  <h3 style={{ margin: "0 0 0.15rem", fontSize: "1.05rem", color: "#1a1a2e" }}>
                    Why they cancelled — trial insights
                  </h3>
                  <p className="ret-chart-sub" style={{ marginTop: 0 }}>
                    {f.trial_cancels.toLocaleString()} trial cancels
                    {insights.window_days ? ` from the last ${insights.window_days} days` : " (all time)"}.
                    Counts, funnel and friction follow the window; conversion and source
                    rates are all-time benchmarks (windowing them skews the converted
                    side — active users always have a recent login). Voluntary cancels
                    only — billing-issue churn is in the “Billing issue” tab.
                  </p>

                  {/* Headline stats */}
                  <div className="metrics-grid" style={{ marginTop: "0.75rem" }}>
                    <div className="metric-card">
                      <div className="metric-value">{engagedPct}%</div>
                      <div className="metric-label">
                        Were Engaged <ScopeTag text={winLabel} />
                      </div>
                      <div className="metric-description">Did 3+ real lessons before leaving</div>
                    </div>
                    <div className="metric-card">
                      <div className="metric-value">{f.median_days}</div>
                      <div className="metric-label">
                        Median Return Days <ScopeTag text={winLabel} />
                      </div>
                      <div className="metric-description">
                        Converters: {conv ? conv.median_days : "—"} days (all-time)
                      </div>
                    </div>
                    <div className="metric-card">
                      <div className="metric-value">{f.avg_lessons}</div>
                      <div className="metric-label">
                        Avg Lessons <ScopeTag text={winLabel} />
                      </div>
                      <div className="metric-description">
                        Converters avg {conv ? conv.avg_lessons : "—"} (all-time)
                      </div>
                    </div>
                    <div className="metric-card">
                      <div className="metric-value">{insights.friction.pct_zero_turn}%</div>
                      <div className="metric-label">
                        Silent Lessons <ScopeTag text={winLabel} />
                      </div>
                      <div className="metric-description">
                        {insights.friction.zero_turn_lessons.toLocaleString()} opened, never spoke
                      </div>
                    </div>
                  </div>

                  {/* Conversion-by-day + activation funnel */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
                      gap: "1rem",
                      marginTop: "1rem",
                    }}
                  >
                    <div className="metric-card" style={cardLeft}>
                      <div style={cardTitle}>
                        Conversion by days used <ScopeTag text="all-time" tone="all" />
                      </div>
                      <div style={cardSub}>Coming back for a 2nd day nearly doubles conversion.</div>
                      {insights.by_days.map((d) => (
                        <InsightBar
                          key={d.bucket}
                          label={d.bucket}
                          pct={(d.conversion_rate / dayMax) * 100}
                          caption={`${d.conversion_rate}% convert · ${d.users.toLocaleString()} users`}
                          color="#059669"
                          highlight={d.bucket === "1 day"}
                        />
                      ))}
                    </div>

                    <div className="metric-card" style={cardLeft}>
                      <div style={cardTitle}>
                        How far trial cancels got <ScopeTag text={winLabel} />
                      </div>
                      <div style={cardSub}>
                        Only {barelyPct}% barely tried it — most reached real lessons.
                      </div>
                      {funnelRows.map((r) => (
                        <InsightBar
                          key={r.label}
                          label={r.label}
                          pct={(r.value / funnelMax) * 100}
                          caption={`${r.value.toLocaleString()} users`}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Cancel rate by source */}
                  <div className="metric-card" style={{ ...cardLeft, marginTop: "1rem" }}>
                    <div style={cardTitle}>
                      Trial-cancel rate by acquisition source <ScopeTag text="all-time" tone="all" />
                    </div>
                    <div style={cardSub}>
                      Paid social brings the lowest-intent trials; organic converts far better.
                    </div>
                    {insights.by_source.map((s) => (
                      <InsightBar
                        key={s.source}
                        label={s.source}
                        pct={(s.pct_cancel / srcMax) * 100}
                        caption={`${s.pct_cancel}% cancel · ${s.finished_trial.toLocaleString()} trials`}
                        color={s.pct_cancel >= 75 ? "#dc2626" : s.pct_cancel >= 60 ? "#f59e0b" : "#059669"}
                      />
                    ))}
                  </div>

                  {/* Takeaways */}
                  <div
                    style={{
                      marginTop: "1rem",
                      background: "#f8fafc",
                      border: "1px solid #e5e7eb",
                      borderRadius: 12,
                      padding: "1rem 1.2rem",
                    }}
                  >
                    <div style={{ fontWeight: 700, color: "#1a1a2e", marginBottom: "0.4rem" }}>
                      What we could have done better
                    </div>
                    <ul
                      style={{
                        margin: 0,
                        paddingLeft: "1.1rem",
                        color: "#374151",
                        fontSize: "0.85rem",
                        lineHeight: 1.6,
                      }}
                    >
                      <li>
                        <strong>Day-2 return nudge.</strong> The biggest pool
                        {oneDay ? ` (${oneDay.users.toLocaleString()} users)` : ""} came back only
                        once and convert at {oneDay ? `${oneDay.conversion_rate}%` : "a low rate"}. A
                        push/email to pull them into a 2nd session is the highest-leverage fix.
                      </li>
                      <li>
                        <strong>Fix silent lessons.</strong> {insights.friction.pct_zero_turn}% of
                        cancellers' lessons had zero spoken turns — likely mic/speech-detection
                        friction worth instrumenting.
                      </li>
                      <li>
                        <strong>Tailor the paid-social trial.</strong> Facebook/TikTok cancel ~4 in 5
                        vs. ~1 in 3 organic; a stronger day-0 value moment (or tighter targeting)
                        would move the biggest cohort.
                      </li>
                      <li>
                        <strong>Capture a cancel reason.</strong> The reason field is ~99% blank, so
                        motivation is a guess — a one-tap exit survey would close the gap.
                      </li>
                    </ul>
                  </div>
                </section>
              );
            })()
          )}

          {/* Controls */}
          <div
            className="controls-bar"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1rem",
              flexWrap: "wrap",
              marginTop: "1rem",
            }}
          >
            <label
              className="filter-label"
              style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
            >
              Window:
              <select
                className="filter-select"
                value={windowDays === null ? "all" : String(windowDays)}
                onChange={(e) =>
                  setWindowDays(e.target.value === "all" ? null : Number(e.target.value))
                }
              >
                {WINDOW_OPTIONS.map((o) => (
                  <option key={o.label} value={o.days === null ? "all" : String(o.days)}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <input
              className="filter-select"
              type="text"
              placeholder="Search name or user id…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ minWidth: "220px" }}
            />
            <label
              className="filter-label"
              style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
            >
              Sort by:
              <select
                className="filter-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                <option value="lastLoggedIn">Last Logged In</option>
                <option value="lastCompleted">Last Lesson</option>
                <option value="name">Name (A-Z)</option>
                <option value="streak">Streak (highest first)</option>
                <option value="engagement">Engagement (most active days)</option>
              </select>
            </label>
            <span className="filters-count">{sorted.length} shown</span>
          </div>

          {sorted.length === 0 ? (
            <div className="empty-state" style={{ padding: "2rem" }}>
              No users match this selection.
            </div>
          ) : (
            <div className="table-container" style={{ marginTop: "0.75rem" }}>
              <table className="data-table">
                <thead className="table-head">
                  <tr>
                    <th>Name</th>
                    <th title="How the user churned: Cancelled = actively cancelled (CANCELED); Billing issue = payment failed (PAST_DUE), often recoverable.">
                      Exit
                    </th>
                    <th>Country</th>
                    <th>Learning</th>
                    <th>Level</th>
                    <th>Age</th>
                    <th>Gender</th>
                    <th>Reason</th>
                    <th>Tutor</th>
                    <th>Source</th>
                    <th>Streak</th>
                    <th title="Distinct days the user came back and actually spoke (at least one real turn) — the primary engagement signal — with total user turns and lessons below. Onboarding and no-speech opens are excluded.">
                      Engagement
                    </th>
                    <th>Last Lesson</th>
                    <th>Last Login</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {sorted.map((user) => {
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
                          {isBillingIssue(user) ? (
                            <span
                              className="plan-pill plan-pill--pastdue"
                              title={
                                billingIssueDate(user)
                                  ? `Billing issue on ${formatDate(billingIssueDate(user))}`
                                  : "Payment failed (past due)"
                              }
                            >
                              Billing issue
                            </span>
                          ) : (
                            <span className="plan-pill plan-pill--free" title="User actively cancelled">
                              Cancelled
                            </span>
                          )}
                        </td>
                        <td>{getCountryFromTimezone(user.time_zone)}</td>
                        <td>{prettyLang(user.learning_language)}</td>
                        <td>{user.level || "—"}</td>
                        <td>{displayAge(user.age)}</td>
                        <td>{user.gender || "—"}</td>
                        <td>{user.reason && user.reason.toLowerCase() !== "not specified" ? user.reason : "—"}</td>
                        <td>{user.tutor || "—"}</td>
                        <td>
                          {user.attribution ? (
                            <span className="attribution-pill">{user.attribution}</span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{user.daily_streak ?? 0}</td>
                        <td>
                          {(() => {
                            const eng = engagementMap?.get(user.user_id);
                            if (!engagementMap) return <span className="eng-muted">…</span>;
                            if (!eng || eng.lessons === 0)
                              return <span className="eng-muted">—</span>;
                            return (
                              <div className="eng-cell">
                                <span className="eng-score">
                                  {eng.days} {eng.days === 1 ? "day" : "days"}
                                </span>
                                <span className="eng-sub">
                                  {eng.turns.toLocaleString()} turns · {eng.lessons}{" "}
                                  {eng.lessons === 1 ? "lesson" : "lessons"}
                                </span>
                              </div>
                            );
                          })()}
                        </td>
                        <td>{formatDate(user.last_completed_at)}</td>
                        <td>{formatDate(user.last_logged_in)}</td>
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

export default CancelledTrials;
