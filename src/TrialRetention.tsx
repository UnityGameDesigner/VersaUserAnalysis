import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabase";
import { getCountryFromTimezone } from "./lib/timezone";
import { scoreConversion, CONV_TIER_META } from "./lib/conversionScore";
import {
  LineChart,
  Line,
  BarChart,
  ComposedChart,
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
  conversions: number; // # of that day's trial starters who became active (paying)
  avg_active: number;
  median_active: number;
  max_active: number;
  partial: boolean;
  hist: number[]; // hist[k] = # users with EXACTLY k active days (k = 0..7)
}

// Multi-hue engagement gradient for the exact-active-days buckets (0 = grey "no
// return"; warm/low days → cool/high days) so each bucket is easy to tell apart.
const DAY_COLORS = [
  "#94a3b8", // 0 days — slate grey
  "#ef4444", // 1 day  — red
  "#f97316", // 2 days — orange
  "#eab308", // 3 days — yellow
  "#84cc16", // 4 days — lime
  "#22c55e", // 5 days — green
  "#06b6d4", // 6 days — cyan
  "#6366f1", // 7 days — indigo
];
const dayKey = (k: number) => `b${k}`;
const dayName = (k: number) => (k === 0 ? "0 days" : k === 1 ? "1 day" : k === 7 ? "7 (full)" : `${k} days`);

interface DayUser {
  user_id: string;
  preferred_name: string | null;
  learning_language: string | null;
  payment_status: string | null;
  age: string | null;
  time_zone: string | null;
  trial_started_at: string | null;
  became_active_at: string | null;
  canceled_at: string | null; // when they cancelled (trial or later renewal)
  canceled_from: string | null; // state they cancelled from: TRIAL / PAST_DUE / …
  active_days: number;
  lessons: number;
  post_trial_lessons: number; // lessons after day 8 = proof of paid access
  // Device + the demographic fields the conversion scorecard needs.
  platform: string | null;
  gender: string | null;
  native_language: string | null;
  level: string | null;
  reason: string | null;
  demand_tier: string | null;
  messaging_platform: string | null;
  tutor: string | null;
  completed_tutorial: boolean | null;
  previous_experience: string | null;
  attribution: string | null;
}

// Compact device label from user_info.platform (see the User Lookup device badge).
function deviceLabel(platform: string | null): { icon: string; label: string; variant: string } {
  const p = (platform ?? "").toLowerCase();
  if (p === "ios") return { icon: "🍎", label: "iOS", variant: "ios" };
  if (p === "android") return { icon: "🤖", label: "Android", variant: "android" };
  return { icon: "📱", label: "Unknown", variant: "unknown" };
}

// Whether the trial user ever CONVERTED (became a paying/active user =
// revenue-generating), from became_active_at — NOT their current payment_status
// snapshot. A converted-then-cancelled user still generated revenue, so they read
// "Converted"; a trial cancelled before it ever charged reads "Not converted".
function convertedBadge(u: DayUser): { label: string; variant: string; hint: string } {
  if (u.became_active_at) {
    return {
      label: "Converted",
      variant: "converted",
      hint: `Became a paying user${u.payment_status ? ` (now ${u.payment_status})` : ""} — revenue-generating.`,
    };
  }
  // No conversion event, but they completed lessons after the 7-day trial ended —
  // they had paid access, so they converted-but-untracked (common on Android,
  // which doesn't send billing events). Manually inferred.
  if (u.post_trial_lessons > 0) {
    return {
      label: "Converted*",
      variant: "converted",
      hint: `Inferred: no conversion event was recorded, but ${u.post_trial_lessons} lesson${u.post_trial_lessons === 1 ? "" : "s"} were completed after the trial ended (paid access). Android doesn't send billing events, so its conversions are undercounted.`,
    };
  }
  const started = u.trial_started_at ? new Date(u.trial_started_at).getTime() : NaN;
  // Only "In trial" while still inside the 7-day trial window. Past day 7 the
  // charge has been attempted, so the outcome is decided even if Android never
  // updated payment_status off "TRIAL".
  const stillPending =
    Number.isFinite(started) &&
    started > Date.now() - 7 * 86_400_000 &&
    !/CANCEL|EXPIRE|PAST_DUE|INACTIVE|FREE/i.test(u.payment_status ?? "");
  if (stillPending) {
    return { label: "In trial", variant: "in-trial", hint: "Trial still in progress — may still convert." };
  }
  return {
    label: "Not converted",
    variant: "churned",
    hint: `Trial ended without converting${u.payment_status ? ` (${u.payment_status})` : ""} — no revenue.`,
  };
}

// The cancellation / billing state shown alongside the Converted badge. Billing
// issues (involuntary — the trial-end charge failed) are the analog of iOS's
// PAST_DUE. Because Android sends no billing events, they don't show as PAST_DUE:
// instead canceled_from records the past-due origin (canceled_from='PAST_DUE'),
// and where even that is missing we INFER a billing issue — an Android trial that
// reached its charge day without converting and without a voluntary trial cancel
// (the charge must have failed). Voluntary trial cancels (canceled_from='TRIAL')
// stay "Cancelled". Reuses the plan-pill styles.
function statusTag(u: DayUser): { label: string; variant: string; hint?: string } | null {
  const s = (u.payment_status ?? "").toUpperCase();
  const cf = (u.canceled_from ?? "").toUpperCase();

  // Recorded billing issue — iOS PAST_DUE status, or the past-due origin captured
  // in canceled_from (how Android's billing issues actually land).
  if (s === "PAST_DUE" || cf === "PAST_DUE") return { label: "Billing issue", variant: "pastdue" };
  // Voluntary opt-out during the trial.
  if (cf === "TRIAL") return { label: "Cancelled", variant: "free" };

  // Inferred billing issue: an Android trial that reached day 7 without converting
  // (tracked or inferred) and without a voluntary trial cancel — the charge failed
  // but no event was sent.
  const started = u.trial_started_at ? new Date(u.trial_started_at).getTime() : NaN;
  const reachedChargeDay = Number.isFinite(started) && started <= Date.now() - 7 * 86_400_000;
  const notConverted = !u.became_active_at && u.post_trial_lessons === 0;
  if (
    u.platform === "android" &&
    reachedChargeDay &&
    notConverted &&
    s !== "ACTIVE" &&
    cf !== "ACTIVE"
  ) {
    return {
      label: "Billing issue*",
      variant: "pastdue",
      hint: "Inferred: Android sends no billing events, but this trial reached its charge day without converting or being voluntarily cancelled — the charge most likely failed.",
    };
  }

  if (s === "CANCELED" || s === "CANCELLED") return { label: "Cancelled", variant: "free" };
  if (s === "EXPIRED") return { label: "Expired", variant: "free" };
  return null;
}
// user_info.age is TEXT with "0"/"-1" unset sentinels — show real ages only.
function prettyAge(age: string | null): string {
  const n = parseInt((age ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? String(n) : "—";
}
function prettyLang(code: string | null): string {
  if (!code || !code.trim()) return "—";
  return code
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Sortable columns of the per-day trial-starters drill-down table.
type DaySortKey =
  | "name" | "country" | "age" | "learning" | "device"
  | "converted" | "canceled_after" | "active_days" | "lessons" | "likely";
// Text columns default to A→Z on first click; numeric ones to high→low.
const DAY_STRING_COLS = new Set<DaySortKey>(["name", "country", "learning", "device"]);
// Numeric age for sorting; unset ("0"/"-1"/blank) sorts as -1 (bottom when desc).
function dayAgeNum(u: DayUser): number {
  const n = parseInt((u.age ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : -1;
}
// Rank the converted status for sorting: converted > in-trial > not converted.
function convRank(u: DayUser): number {
  const v = convertedBadge(u).variant;
  return v === "converted" ? 2 : v === "in-trial" ? 1 : 0;
}
// Milliseconds from trial start to cancellation (−1 when they never cancelled or
// either timestamp is missing) — used both for the label and for sorting.
function canceledAfterMs(u: DayUser): number {
  if (!u.canceled_at || !u.trial_started_at) return -1;
  const ms = new Date(u.canceled_at).getTime() - new Date(u.trial_started_at).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : -1;
}
// Human "canceled after" label: coarsest sensible unit (Xd Yh / Xh Ym / Xm),
// "—" when they never cancelled. >7 days ⇒ they cancelled a paid renewal, not the trial.
function canceledAfterLabel(u: DayUser): string {
  const ms = canceledAfterMs(u);
  if (ms < 0) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    const rem = mins % 60;
    return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  }
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}

// One trial starter row from trial_day_users_range (a DayUser + its trial-start day).
type TrialUserRow = DayUser & { trial_day: string };

// One billing-issue row from trial_billing_issues.
interface BillingRow {
  trial_day: string;
  past_due_day: string;
  days_since: number;
  converted: boolean;
  platform: string | null;
  payment_status: string | null;
  canceled_from: string | null;
}

function ageGroup(age: string | null): string {
  const n = parseInt((age ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return "Unknown";
  if (n < 18) return "Under 18";
  if (n < 25) return "18–24";
  if (n < 35) return "25–34";
  if (n < 45) return "35–44";
  return "45+";
}

// Parameters the per-day retention can be segmented by, and how to read each user's
// value. Country is derived from time_zone client-side (getCountryFromTimezone).
const SEG_PARAMS: { key: string; label: string; value: (u: TrialUserRow) => string }[] = [
  { key: "country", label: "Country", value: (u) => getCountryFromTimezone(u.time_zone) || "Unknown" },
  { key: "device", label: "Device", value: (u) => deviceLabel(u.platform).label },
  { key: "learning", label: "Learning language", value: (u) => prettyLang(u.learning_language) },
  { key: "native", label: "Native language", value: (u) => (u.native_language ? prettyLang(u.native_language) : "Unknown") },
  { key: "age", label: "Age group", value: (u) => ageGroup(u.age) },
  { key: "gender", label: "Gender", value: (u) => u.gender || "Unknown" },
  { key: "demand_tier", label: "Demand tier", value: (u) => u.demand_tier || "Unknown" },
  { key: "level", label: "Level", value: (u) => u.level || "Unknown" },
  { key: "reason", label: "Reason for learning", value: (u) => u.reason || "Unknown" },
  { key: "attribution", label: "Acquisition source", value: (u) => u.attribution || "Unknown" },
];
const segAccessor = (key: string) => SEG_PARAMS.find((p) => p.key === key)?.value;

const TrialRetention: React.FC = () => {
  // "bars" = how many users reached ≥N distinct active days (pooled over the
  // timeframe); "trend" = the metric over time (cohort line); "recent" = a
  // per-day breakdown of the last N days (trial cohort engagement, no min-size).
  const [chartType, setChartType] = useState<"bars" | "trend" | "recent" | "billing">("bars");
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
  // Client-side sort for the drill-down table (sort by any user parameter).
  const [daySort, setDaySort] = useState<{ key: DaySortKey; dir: "asc" | "desc" }>({
    key: "active_days",
    dir: "desc",
  });
  // Per-day view: every trial starter in range, fetched once and aggregated +
  // filtered CLIENT-SIDE so retention can be segmented by any user parameter.
  const [rangeUsers, setRangeUsers] = useState<TrialUserRow[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);
  // Segment filter: which parameter, and which value ("" = all of that parameter).
  const [segParam, setSegParam] = useState<string>("all");
  const [segValue, setSegValue] = useState<string>("");
  // "Billing issues" view: trial users whose trial-end/renewal charge failed (PAST_DUE).
  const [billingRows, setBillingRows] = useState<BillingRow[]>([]);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);

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

  // Fetch every trial starter in range once (Per-day view). The per-day chart and
  // the drill-down are aggregated CLIENT-SIDE from `rangeUsers`, which is what lets
  // the whole view be segmented by any user parameter.
  useEffect(() => {
    if (chartType !== "recent") return;
    let cancelled = false;
    (async () => {
      setDailyLoading(true);
      setDailyError(null);
      const { data, error } = await supabase.rpc("trial_day_users_range", {
        start_date: appliedRange.from || null,
        end_date: appliedRange.to || null,
      });
      if (cancelled) return;
      if (error) {
        setDailyError(error.message);
        setRangeUsers([]);
      } else {
        setRangeUsers(
          ((data ?? []) as Record<string, unknown>[]).map((r) => ({
            trial_day: String(r.trial_day),
            user_id: String(r.user_id),
            preferred_name: (r.preferred_name as string) ?? null,
            learning_language: (r.learning_language as string) ?? null,
            payment_status: (r.payment_status as string) ?? null,
            age: (r.age as string) ?? null,
            time_zone: (r.time_zone as string) ?? null,
            trial_started_at: (r.trial_started_at as string) ?? null,
            became_active_at: (r.became_active_at as string) ?? null,
            canceled_at: (r.canceled_at as string) ?? null,
            canceled_from: (r.canceled_from as string) ?? null,
            active_days: Number(r.active_days ?? 0),
            lessons: Number(r.lessons ?? 0),
            post_trial_lessons: Number(r.post_trial_lessons ?? 0),
            platform: (r.platform as string) ?? null,
            gender: (r.gender as string) ?? null,
            native_language: (r.native_language as string) ?? null,
            level: (r.level as string) ?? null,
            reason: (r.reason as string) ?? null,
            demand_tier: (r.demand_tier as string) ?? null,
            messaging_platform: (r.messaging_platform as string) ?? null,
            tutor: (r.tutor as string) ?? null,
            completed_tutorial: (r.completed_tutorial as boolean) ?? null,
            previous_experience: (r.previous_experience as string) ?? null,
            attribution: (r.attribution as string) ?? null,
          })),
        );
      }
      setDailyLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [chartType, appliedRange]);

  // (The clicked-day drill-down is derived client-side from the filtered range —
  // see the `dayUsers` memo — so no separate fetch is needed.)

  // Reset the day drill-down when the underlying data/range/segment changes.
  useEffect(() => {
    setSelectedDay(null);
  }, [appliedRange, chartType, segParam, segValue]);

  const effReachN = Math.min(Math.max(2, Math.round(reachN) || 2), applied.window);

  // ── Billing issues view: when trial charges fail ─────────────────────────────
  // Fetch when the Billing view is active; filter by trial-start date (the page Timeline).
  useEffect(() => {
    if (chartType !== "billing") return;
    let cancelled = false;
    (async () => {
      setBillingLoading(true);
      setBillingError(null);
      const { data, error } = await supabase.rpc("trial_billing_issues", {
        start_date: fromDate || null,
        end_date: toDate || null,
      });
      if (cancelled) return;
      if (error) {
        setBillingError(error.message);
        setBillingRows([]);
      } else {
        setBillingRows(
          ((data ?? []) as Record<string, unknown>[]).map((r) => ({
            trial_day: String(r.trial_day),
            past_due_day: String(r.past_due_day),
            days_since: Number(r.days_since ?? 0),
            converted: Boolean(r.converted),
            platform: (r.platform as string) ?? null,
            payment_status: (r.payment_status as string) ?? null,
            canceled_from: (r.canceled_from as string) ?? null,
          })),
        );
      }
      setBillingLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [chartType, fromDate, toDate]);

  // Days-from-trial-start distribution (capped at 15 = "15+"), for the "when in the
  // trial" histogram — the trial-end charge lands on day 7-8.
  const billingDays = useMemo(() => {
    const counts = new Array(16).fill(0);
    for (const r of billingRows) counts[Math.min(15, Math.max(0, r.days_since))] += 1;
    return counts.map((n, day) => ({ day, label: day === 15 ? "15+" : `d${day}`, n }));
  }, [billingRows]);

  // Billing issues by the calendar week they occurred (when on the clock).
  const billingWeekly = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of billingRows) {
      const d = new Date(r.past_due_day + "T00:00:00");
      if (Number.isNaN(d.getTime())) continue;
      const dow = (d.getUTCDay() + 6) % 7;
      const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
      const wk = mon.toISOString().slice(0, 10);
      m.set(wk, (m.get(wk) ?? 0) + 1);
    }
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([wk, n]) => ({ wk, label: format(new Date(wk + "T00:00:00"), "MMM d"), n }));
  }, [billingRows]);

  const billingSummary = useMemo(() => {
    const total = billingRows.length;
    const day78 = billingRows.filter((r) => r.days_since === 7 || r.days_since === 8).length;
    const days = billingRows.map((r) => r.days_since).sort((a, b) => a - b);
    const median = days.length ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) : 0;
    return { total, day78, pctDay78: total ? Math.round((100 * day78) / total) : 0, median };
  }, [billingRows]);

  // ── Per-day segmentation + client-side aggregation ───────────────────────────
  // Distinct values for the chosen segment parameter (with counts), for the dropdown.
  const segOptions = useMemo(() => {
    const acc = segAccessor(segParam);
    if (!acc) return [] as { v: string; n: number }[];
    const counts = new Map<string, number>();
    for (const u of rangeUsers) counts.set(acc(u), (counts.get(acc(u)) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([v, n]) => ({ v, n }));
  }, [segParam, rangeUsers]);

  // The trial starters after applying the active segment filter.
  const filteredUsers = useMemo(() => {
    const acc = segAccessor(segParam);
    if (!acc || !segValue) return rangeUsers;
    return rangeUsers.filter((u) => acc(u) === segValue);
  }, [rangeUsers, segParam, segValue]);

  // Aggregate the filtered users into per-day rows (same shape trial_daily_activity
  // returned): trials, conversions, and the exact-active-days histogram (0–7).
  const dailyRows = useMemo<DailyRow[]>(() => {
    const byDay = new Map<string, { trials: number; conversions: number; hist: number[]; active: number[] }>();
    for (const u of filteredUsers) {
      let e = byDay.get(u.trial_day);
      if (!e) {
        e = { trials: 0, conversions: 0, hist: new Array(8).fill(0), active: [] };
        byDay.set(u.trial_day, e);
      }
      e.trials += 1;
      if (u.became_active_at) e.conversions += 1;
      const a = Math.max(0, Math.min(7, u.active_days));
      e.hist[a] += 1;
      e.active.push(a);
    }
    const now = Date.now();
    return [...byDay.entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([d, e]) => {
        const sorted = [...e.active].sort((a, b) => a - b);
        const n = sorted.length;
        const avg = n ? sorted.reduce((a, b) => a + b, 0) / n : 0;
        const median = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : 0;
        return {
          d,
          trials: e.trials,
          conversions: e.conversions,
          avg_active: Math.round(avg * 100) / 100,
          median_active: Math.round(median * 10) / 10,
          max_active: n ? sorted[n - 1] : 0,
          partial: new Date(d + "T00:00:00").getTime() + 7 * 86_400_000 > now,
          hist: e.hist,
        };
      });
  }, [filteredUsers]);

  // The clicked day's trial starters (already filtered by segment).
  const dayUsers = useMemo(
    () => (selectedDay ? filteredUsers.filter((u) => u.trial_day === selectedDay) : []),
    [filteredUsers, selectedDay],
  );
  const segLabel = segParam === "all" ? null : SEG_PARAMS.find((p) => p.key === segParam)?.label ?? null;

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
  const isBilling = chartType === "billing";
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

  // The drill-down table, sorted by the chosen user parameter.
  const sortedDayUsers = useMemo(() => {
    const { key, dir } = daySort;
    const name = (u: DayUser) => (u.preferred_name || u.user_id).toLowerCase();
    const prob = (u: DayUser) => scoreConversion(u as unknown as Record<string, unknown>)?.prob ?? -1;
    const arr = [...dayUsers];
    arr.sort((a, b) => {
      let r = 0;
      switch (key) {
        case "name": r = name(a).localeCompare(name(b)); break;
        case "country": r = getCountryFromTimezone(a.time_zone).localeCompare(getCountryFromTimezone(b.time_zone)); break;
        case "age": r = dayAgeNum(a) - dayAgeNum(b); break;
        case "learning": r = (a.learning_language ?? "").localeCompare(b.learning_language ?? ""); break;
        case "device": r = deviceLabel(a.platform).label.localeCompare(deviceLabel(b.platform).label); break;
        case "converted": r = convRank(a) - convRank(b); break;
        case "canceled_after": r = canceledAfterMs(a) - canceledAfterMs(b); break;
        case "active_days": r = a.active_days - b.active_days; break;
        case "lessons": r = a.lessons - b.lessons; break;
        case "likely": r = prob(a) - prob(b); break;
      }
      if (r === 0) r = name(a).localeCompare(name(b)); // stable tiebreak by name
      return dir === "asc" ? r : -r;
    });
    return arr;
  }, [dayUsers, daySort]);

  const sortDayBy = (key: DaySortKey) =>
    setDaySort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DAY_STRING_COLS.has(key) ? "asc" : "desc" },
    );
  const sortInd = (key: DaySortKey) => (
    <span style={{ color: daySort.key === key ? "#4f46e5" : "#cbd5e1", marginLeft: 3 }}>
      {daySort.key === key ? (daySort.dir === "asc" ? "▲" : "▼") : "↕"}
    </span>
  );
  const sortThStyle: React.CSSProperties = { cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" };

  const headCount = isBilling ? billingSummary.total : isBars ? barData.totalUsers : isRecent ? dailySummary.trials : summary?.totalUsers ?? 0;

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title" style={{ margin: 0 }}>
        Trial Retention
        {headCount > 0 && (
          <span className="lessons-detail-count">
            {headCount.toLocaleString()} {isBilling ? "billing issues" : isRecent ? "trials" : popNoun}
            {isBilling ? "" : isRecent ? ` · ${rangeLabel}` : !isBars && summary ? ` · ${summary.count} cohorts` : ""}
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
        ) : isBilling ? (
          <>
            <strong>When trial users hit a billing issue</strong> — i.e. the trial-end (or later renewal) charge{" "}
            <strong>failed</strong> (PAST_DUE, from <code>user_info.past_due_at</code>). Shown two ways: how many{" "}
            <strong>days after their trial start</strong> it happened (the charge lands on day 7–8), and when it happened on
            the calendar. Filter cohorts with the Timeline range below.
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
          <button
            className={`ret-seg-btn${chartType === "billing" ? " ret-seg-btn--on" : ""}`}
            onClick={() => setChartType("billing")}
            title="When trial users hit a billing issue (the trial-end / renewal charge failed)"
          >
            Billing issues
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
            <span style={{ width: 1, height: 22, background: "#e5e7eb", margin: "0 0.2rem" }} />
            <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              Segment
              <select
                className="filter-select"
                value={segParam}
                onChange={(e) => {
                  setSegParam(e.target.value);
                  setSegValue("");
                }}
              >
                <option value="all">All users</option>
                {SEG_PARAMS.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
            </label>
            {segParam !== "all" && (
              <select
                className="filter-select"
                value={segValue}
                onChange={(e) => setSegValue(e.target.value)}
                title="Pick a value to show only that segment"
              >
                <option value="">All {segLabel?.toLowerCase()} ({rangeUsers.length})</option>
                {segOptions.map((o) => (
                  <option key={o.v} value={o.v}>{o.v} ({o.n})</option>
                ))}
              </select>
            )}
            {segParam !== "all" && segValue && (
              <button className="filters-clear-btn" onClick={() => { setSegParam("all"); setSegValue(""); }}>
                Clear segment
              </button>
            )}
          </>
        ) : isBilling ? null : (
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

      {isBilling ? (
        billingLoading ? (
          <div style={{ textAlign: "center", padding: "3rem" }}>
            <div className="loading-spinner"></div>
            <p className="loading-text">Loading billing issues…</p>
          </div>
        ) : billingError ? (
          <div className="error-box" style={{ margin: "1rem 0" }}><p>Failed to load: {billingError}</p></div>
        ) : billingRows.length === 0 ? (
          <div className="empty-state" style={{ padding: "2rem" }}>No billing issues in the selected timeline.</div>
        ) : (
          <>
            <section className="metrics-grid" style={{ marginTop: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
              <div className="metric-card">
                <div className="metric-value">{billingSummary.total.toLocaleString()}</div>
                <div className="metric-label">Billing Issues</div>
                <div className="metric-description">trial-end / renewal charge failed</div>
              </div>
              <div className="metric-card">
                <div className="metric-value" style={{ color: "#dc2626" }}>{billingSummary.pctDay78}%</div>
                <div className="metric-label">On Day 7–8</div>
                <div className="metric-description">right at the trial-end charge</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{billingSummary.median}</div>
                <div className="metric-label">Median Day</div>
                <div className="metric-description">days after trial start</div>
              </div>
            </section>

            <div className="chart-container" style={{ marginTop: "1.25rem" }}>
              <div className="ret-chart-head"><h3>When in the trial the charge fails</h3></div>
              <p className="ret-chart-sub">
                Billing issues by <strong>days after trial start</strong>. The 7-day trial ends and the card is charged
                on day 7 — the spike at <strong>day 7–8</strong> is that charge failing. Bars past day 8 are later
                subscription-renewal failures.
              </p>
              <div style={{ width: "100%", height: 320 }}>
                <ResponsiveContainer>
                  <BarChart data={billingDays} margin={{ top: 18, right: 20, bottom: 8, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} width={48} allowDecimals={false} />
                    <Tooltip
                      formatter={(v: number | undefined) => [`${(v ?? 0).toLocaleString()} billing issues`, "Count"]}
                      labelFormatter={(l) => (String(l) === "15+" ? "15+ days after start" : `Day ${String(l).slice(1)} after trial start`)}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      cursor={{ fill: "rgba(220,38,38,0.06)" }}
                    />
                    <ReferenceLine x="d7" stroke="#c7cdd6" strokeDasharray="4 4" label={{ value: "trial ends", position: "top", fontSize: 10, fill: "#8b929c" }} />
                    <Bar dataKey="n" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      {billingDays.map((b, i) => (
                        <Cell key={i} fill={b.day === 7 || b.day === 8 ? "#dc2626" : "#f4a3a3"} />
                      ))}
                      <LabelList dataKey="n" position="top" fontSize={10} fill="#6b7280" formatter={(v: React.ReactNode) => (Number(v) > 0 ? String(v) : "")} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="chart-container" style={{ marginTop: "1.25rem" }}>
              <div className="ret-chart-head"><h3>Billing issues over time</h3></div>
              <p className="ret-chart-sub">Count of billing issues by the calendar week they occurred (trial starts in the Timeline range).</p>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer>
                  <LineChart data={billingWeekly} margin={{ top: 10, right: 24, bottom: 8, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={20} />
                    <YAxis tick={{ fontSize: 12 }} width={40} allowDecimals={false} />
                    <Tooltip formatter={(v: number | undefined) => [`${v ?? 0} billing issues`, "That week"]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Line type="monotone" dataKey="n" stroke="#dc2626" strokeWidth={2.5} dot={{ r: 2 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <p className="ret-chart-sub" style={{ marginTop: "0.75rem", maxWidth: "82ch" }}>
              <strong>Read with care:</strong> a billing issue = the charge <strong>failed</strong> (PAST_DUE / involuntary),
              distinct from a voluntary cancel. ~{billingSummary.pctDay78}% land on day 7–8 (the trial-end charge). Timing is
              from <code>user_info.past_due_at</code>; Android sends no billing events, so some Android failures are undercounted.
            </p>
          </>
        )
      ) : isRecent ? (
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
                the “4 days” slice. Warm = fewer days, cool = more (see legend); faded bars are still in progress (partial).
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
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontWeight: 600, color: "#111827" }}>
                  <span style={{ width: 16, height: 3, borderRadius: 2, background: "#111827", display: "inline-block" }} />
                  Conversions (right axis)
                </span>
              </div>
              <div style={{ width: "100%", height: 320, cursor: "pointer" }}>
                <ResponsiveContainer>
                  <ComposedChart
                    data={dailyChart}
                    margin={{ top: 24, right: 44, bottom: 8, left: 0 }}
                    stackOffset={stackMode === "share" ? "expand" : undefined}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={8} />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 12 }}
                      width={40}
                      allowDecimals={false}
                      domain={stackMode === "share" ? [0, 1] : undefined}
                      tickFormatter={stackMode === "share" ? (v: number) => `${Math.round(v * 100)}%` : undefined}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 11, fill: "#111827" }}
                      width={30}
                      allowDecimals={false}
                      domain={[0, "auto"]}
                      label={{ value: "conv", angle: 90, position: "insideRight", fontSize: 10, fill: "#6b7280" }}
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
                        const items = payload
                          .filter((p) => p.name !== "Conversions" && Number(p.value) > 0)
                          .reverse();
                        return (
                          <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px", fontSize: 12, boxShadow: "0 2px 10px rgba(0,0,0,.1)" }}>
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>
                              {String(label)} · {row?.trials ?? 0} trials{row?.partial ? " (partial)" : ""}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontWeight: 600 }}>
                              <span style={{ width: 10, height: 2, background: "#111827", display: "inline-block" }} />
                              Converted: {row?.conversions ?? 0}
                              {row && row.trials ? ` (${Math.round((100 * (row.conversions ?? 0)) / row.trials)}%)` : ""}
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
                        yAxisId="left"
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
                    {/* Conversions per day — count of that day's trial starters who
                        became paying. Own right axis; drawn on top of the bars. */}
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="conversions"
                      name="Conversions"
                      stroke="#111827"
                      strokeWidth={2.5}
                      isAnimationActive={false}
                      dot={{ r: 3, fill: "#111827", stroke: "#fff", strokeWidth: 1.5 }}
                      activeDot={{ r: 5 }}
                    >
                      <LabelList
                        dataKey="conversions"
                        position="top"
                        fontSize={10}
                        fontWeight={700}
                        fill="#111827"
                        formatter={(v: React.ReactNode) => (Number(v) > 0 ? String(v) : "")}
                      />
                    </Line>
                  </ComposedChart>
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
                    {` · ${dayUsers.length} users`}
                    {segLabel && segValue ? ` · ${segLabel}: ${segValue}` : ""}
                  </h3>
                  <button className="filters-clear-btn" onClick={() => setSelectedDay(null)}>
                    Close
                  </button>
                </div>
                {dayUsers.length === 0 ? (
                  <div className="empty-state" style={{ padding: "1.5rem" }}>No trial starters found for this day.</div>
                ) : (
                  <>
                    <p className="ret-chart-sub">
                      Click any column header to sort by that parameter (click again to reverse). Click a name to open that user's profile in a new tab.
                    </p>
                    <div className="table-container">
                      <table className="data-table">
                        <thead className="table-head">
                          <tr>
                            <th style={sortThStyle} onClick={() => sortDayBy("name")} title="Sort by name">User{sortInd("name")}</th>
                            <th style={sortThStyle} onClick={() => sortDayBy("country")} title="Sort by country">Country{sortInd("country")}</th>
                            <th style={sortThStyle} onClick={() => sortDayBy("age")} title="Sort by age">Age{sortInd("age")}</th>
                            <th style={sortThStyle} onClick={() => sortDayBy("learning")} title="Sort by learning language">Learning{sortInd("learning")}</th>
                            <th style={sortThStyle} onClick={() => sortDayBy("device")} title="Sort by device">Device{sortInd("device")}</th>
                            <th style={sortThStyle} onClick={() => sortDayBy("converted")} title="Sort by converted status (converted > in-trial > not converted). Converted = ever became_active_at; a converted-then-cancelled user still generated revenue.">Converted{sortInd("converted")}</th>
                            <th style={sortThStyle} onClick={() => sortDayBy("canceled_after")} title="Time from trial start to cancellation. Under 7d = cancelled during the trial; over 7d = cancelled a paid renewal later. — = never cancelled.">Canceled after{sortInd("canceled_after")}</th>
                            <th style={sortThStyle} onClick={() => sortDayBy("active_days")} title="Sort by active days — distinct days with a completed lesson in the 7-day trial window">Active days{sortInd("active_days")}</th>
                            <th style={sortThStyle} onClick={() => sortDayBy("lessons")} title="Sort by lessons completed in the 7-day trial window">Lessons{sortInd("lessons")}</th>
                            <th style={sortThStyle} onClick={() => sortDayBy("likely")} title="Sort by predicted trial-conversion likelihood (signup-demographics scorecard — a lean, not a certainty)">Likely convert{sortInd("likely")}</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody className="table-body">
                          {sortedDayUsers.map((u) => {
                            const href = `#user-lookup:${u.user_id}`;
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
                                <td>{getCountryFromTimezone(u.time_zone)}</td>
                                <td>{prettyAge(u.age)}</td>
                                <td>{prettyLang(u.learning_language)}</td>
                                <td>
                                  {(() => {
                                    const d = deviceLabel(u.platform);
                                    return (
                                      <span
                                        className={`device-badge device-badge--${d.variant}`}
                                        title={d.variant === "unknown" ? "Device unknown (user_info.platform not set)" : `Device: ${d.label}`}
                                      >
                                        {d.icon} {d.label}
                                      </span>
                                    );
                                  })()}
                                </td>
                                <td>
                                  {(() => {
                                    const b = convertedBadge(u);
                                    const tag = statusTag(u);
                                    return (
                                      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0.3rem", alignItems: "center" }}>
                                        <span
                                          className={`user-trial-badge user-trial-badge--${b.variant}`}
                                          title={b.hint}
                                        >
                                          {b.label}
                                        </span>
                                        {tag && (
                                          <span
                                            className={`plan-pill plan-pill--${tag.variant}`}
                                            title={tag.hint ?? `Current status: ${u.payment_status}${u.canceled_from ? ` · cancelled from ${u.canceled_from}` : ""}`}
                                          >
                                            {tag.label}
                                          </span>
                                        )}
                                      </span>
                                    );
                                  })()}
                                </td>
                                <td>
                                  {(() => {
                                    const ms = canceledAfterMs(u);
                                    if (ms < 0) return <span style={{ color: "#9ca3af" }}>—</span>;
                                    const withinTrial = ms <= 7 * 24 * 3600 * 1000;
                                    return (
                                      <span
                                        style={{ color: withinTrial ? "#b91c1c" : "#6b7280", fontWeight: withinTrial ? 600 : 400, whiteSpace: "nowrap" }}
                                        title={`Cancelled ${new Date(u.canceled_at as string).toLocaleString()} — ${canceledAfterLabel(u)} after starting the trial${withinTrial ? " (during the 7-day trial)" : " (a paid renewal, after the trial)"}${u.canceled_from ? ` · from ${u.canceled_from}` : ""}`}
                                      >
                                        {canceledAfterLabel(u)}
                                      </span>
                                    );
                                  })()}
                                </td>
                                <td>{u.active_days}</td>
                                <td>{u.lessons}</td>
                                <td>
                                  {(() => {
                                    const cs = scoreConversion(u as unknown as Record<string, unknown>);
                                    if (!cs) return "—";
                                    const m = CONV_TIER_META[cs.tier];
                                    return (
                                      <span
                                        className={`user-conv-badge user-conv-badge--${m.variant}`}
                                        title={`${m.hint} This user: ${Math.round(cs.prob * 100)}%.`}
                                      >
                                        ≈ {m.label} {Math.round(cs.prob * 100)}%
                                      </span>
                                    );
                                  })()}
                                </td>
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
                    <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      {barData.bars.map((b, i) => (
                        <Cell key={i} fill={DAY_COLORS[Math.min(b.day, 7)]} />
                      ))}
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
