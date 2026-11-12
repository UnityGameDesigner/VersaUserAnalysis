import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabase";
import {
  BarChart,
  Bar,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { format } from "date-fns";
import { BUCKETS, BUCKET_COLORS, num, usd, planName } from "./lib/revenueFormat";
import LapsedUsers from "./LapsedUsers";
import PlanRetention from "./PlanRetention";

// The Revenue section of the main dashboard (src/ActiveUserDashboard.tsx) —
// what each plan brought in. Reads the subscription_transactions /
// subscription_products tables (backfilled from Superwall ClickHouse, purchases
// since 2026-03-01, store-vs-RevenueCat duplicates removed by transactionId)
// through the revenue_monthly, revenue_by_plan, revenue_users and
// revenue_subscribers_daily RPCs (supabase/sql/revenue_page.sql). The per-user
// figures (plan, spend, retention score) are columns of the dashboard's user
// table, not shown here.

type Platform = "all" | "ios" | "android";
type Money = "gross" | "net";

interface MonthRow {
  month: string;
  bucket: string;
  gross: number;
  net: number;
  refunds: number;
  payments: number;
}

interface PlanRow {
  product_id: string;
  platform: string;
  bucket: string;
  list_price_usd: number | null;
  trial_days: number | null;
  trial_starts: number;
  trials_resolved: number;
  trial_conversions: number;
  first_purchases: number;
  renewals: number;
  payers: number;
  gross: number;
  net: number;
  refunds: number;
}

// Only what the payer KPIs need; the rest of revenue_users feeds the dashboard's user table.
interface UserRow {
  payments: number;
  gross: number;
}

interface SubDayRow {
  day: string;
  active: number;
  gained: number;
  lost: number;
}

type SubRange = 30 | 90 | 0; // days shown; 0 = everything since Mar 1

// Gains and losses are a polarity, so they get the two poles of a diverging pair.
const GAINED_COLOR = "#2a78d6";
const LOST_COLOR = "#eb6834";

function pct(n: number, d: number): string {
  return d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "—";
}

type PlanSort = "gross" | "net" | "trial_starts" | "conv" | "first_purchases" | "renewals";

const Revenue: React.FC<{ onUserClick?: (userId: string) => void }> = ({ onUserClick }) => {
  const [platform, setPlatform] = useState<Platform>("all");
  const [view, setView] = useState<"overview" | "plans" | "lapsed">("overview");
  const [money, setMoney] = useState<Money>("gross");
  const [months, setMonths] = useState<MonthRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [planSort, setPlanSort] = useState<PlanSort>("gross");
  const [subDays, setSubDays] = useState<SubDayRow[]>([]);
  const [subRange, setSubRange] = useState<SubRange>(90);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const p_platform = platform === "all" ? null : platform;
    try {
      // PostgREST caps a response at 1,000 rows, so page the user list.
      const fetchUsers = async () => {
        const all: Record<string, unknown>[] = [];
        for (let from = 0; ; from += 1000) {
          const r = await supabase
            .rpc("revenue_users", { p_platform, p_limit: 20000 })
            .range(from, from + 999);
          if (r.error) return r;
          all.push(...(r.data ?? []));
          if ((r.data ?? []).length < 1000) return { data: all, error: null };
        }
      };
      // Any rpc() error must surface — an error read as "empty" looks like "no revenue".
      const [m, p, u, sd] = await Promise.all([
        supabase.rpc("revenue_monthly", { p_platform }),
        supabase.rpc("revenue_by_plan", { p_platform }),
        fetchUsers(),
        supabase.rpc("revenue_subscribers_daily", { p_platform }),
      ]);
      for (const r of [m, p, u, sd]) if (r.error) throw new Error(r.error.message);
      setSubDays(
        (sd.data ?? []).map((r: Record<string, unknown>) => ({
          day: String(r.day),
          active: num(r.active),
          gained: num(r.gained),
          lost: num(r.lost),
        })),
      );
      setMonths(
        (m.data ?? []).map((r: Record<string, unknown>) => ({
          month: String(r.month),
          bucket: String(r.bucket),
          gross: num(r.gross),
          net: num(r.net),
          refunds: num(r.refunds),
          payments: num(r.payments),
        })),
      );
      setPlans(
        (p.data ?? []).map((r: Record<string, unknown>) => ({
          product_id: String(r.product_id),
          platform: String(r.platform),
          bucket: String(r.bucket),
          list_price_usd: r.list_price_usd == null ? null : Number(r.list_price_usd),
          trial_days: r.trial_days == null ? null : Number(r.trial_days),
          trial_starts: num(r.trial_starts),
          trials_resolved: num(r.trials_resolved),
          trial_conversions: num(r.trial_conversions),
          first_purchases: num(r.first_purchases),
          renewals: num(r.renewals),
          payers: num(r.payers),
          gross: num(r.gross),
          net: num(r.net),
          refunds: num(r.refunds),
        })),
      );
      setUsers(
        (u.data ?? []).map((r: Record<string, unknown>) => ({ payments: num(r.payments), gross: num(r.gross) })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMonths([]);
      setPlans([]);
      setUsers([]);
      setSubDays([]);
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const totals = useMemo(() => {
    const gross = months.reduce((a, r) => a + r.gross, 0);
    const net = months.reduce((a, r) => a + r.net, 0);
    const refunds = months.reduce((a, r) => a + r.refunds, 0);
    const payments = months.reduce((a, r) => a + r.payments, 0);
    const payers = users.filter((u) => u.payments > 0);
    const identifiedGross = payers.reduce((a, u) => a + u.gross, 0);
    return { gross, net, refunds, payments, payers: payers.length, identifiedGross };
  }, [months, users]);

  // One row per month, one key per plan length, for the stacked bars.
  const chartData = useMemo(() => {
    const byMonth = new Map<string, Record<string, number | string>>();
    for (const r of months) {
      const row = byMonth.get(r.month) ?? { month: r.month, label: format(new Date(r.month + "T00:00:00"), "MMM ''yy") };
      row[r.bucket] = Math.round(((row[r.bucket] as number) ?? 0) + (money === "gross" ? r.gross : r.net));
      byMonth.set(r.month, row);
    }
    return [...byMonth.values()].sort((a, b) => String(a.month).localeCompare(String(b.month)));
  }, [months, money]);

  // Losses plot below zero; the first day is the carried-in base, not a change.
  const subChart = useMemo(() => {
    const rows = subDays.slice(1).map((d) => ({
      ...d,
      label: format(new Date(`${d.day}T00:00:00`), "MMM d"),
      lostNeg: -d.lost,
      net: d.gained - d.lost,
    }));
    return subRange ? rows.slice(-subRange) : rows;
  }, [subDays, subRange]);

  const subSummary = useMemo(() => {
    if (subChart.length === 0) return null;
    const first = subChart[0];
    const last = subChart[subChart.length - 1];
    const gained = subChart.reduce((a, r) => a + r.gained, 0);
    const lost = subChart.reduce((a, r) => a + r.lost, 0);
    return { start: first.active + first.lost - first.gained, end: last.active, gained, lost, lastDay: last.day };
  }, [subChart]);

  const bucketsShown = useMemo(() => BUCKETS.filter((b) => months.some((m) => m.bucket === b)), [months]);

  const byBucket = useMemo(
    () =>
      bucketsShown.map((b) => {
        const rows = plans.filter((p) => p.bucket === b);
        const sum = (k: keyof PlanRow) => rows.reduce((a, r) => a + (r[k] as number), 0);
        return {
          bucket: b,
          payers: sum("payers"),
          first_purchases: sum("first_purchases"),
          renewals: sum("renewals"),
          trials_resolved: sum("trials_resolved"),
          trial_conversions: sum("trial_conversions"),
          gross: sum("gross"),
          net: sum("net"),
        };
      }),
    [plans, bucketsShown],
  );

  const sortedPlans = useMemo(() => {
    const key = (p: PlanRow) =>
      planSort === "conv" ? (p.trials_resolved ? p.trial_conversions / p.trials_resolved : -1) : p[planSort];
    return [...plans].sort((a, b) => key(b) - key(a));
  }, [plans, planSort]);

  const sortTh = (active: boolean): React.CSSProperties => ({
    cursor: "pointer",
    whiteSpace: "nowrap",
    textDecoration: active ? "underline" : undefined,
  });

  return (
    <section className="lessons-detail" style={{ margin: "1.5rem 0" }}>
      <h2 className="lessons-detail-title" style={{ margin: 0 }}>
        Revenue
        {!loading && (
          <span className="lessons-detail-count">
            {totals.payments.toLocaleString()} payments · {totals.payers.toLocaleString()} identified payers
          </span>
        )}
      </h2>
      <p className="ret-chart-sub" style={{ marginTop: "0.4rem", maxWidth: "80ch" }}>
        What each plan brought in, from Superwall's store transactions since <strong>Mar 1, 2026</strong> (App
        Store / Google Play, with RevenueCat duplicates removed). Gross is the price in USD; net is what we keep
        after the store's commission and tax. Refunds subtract from net. This section covers every transaction,
        so the segment and filters above don't narrow it — only the platform switch here does. Each user's plan
        and spend are in the Users table below.
      </p>

      <div className="tab-bar" style={{ marginTop: "1rem" }}>
        <button
          className={`tab-btn${view === "overview" ? " tab-btn--active" : ""}`}
          onClick={() => setView("overview")}
        >
          Overview
        </button>
        <button
          className={`tab-btn${view === "plans" ? " tab-btn--active" : ""}`}
          onClick={() => setView("plans")}
        >
          Plan retention
        </button>
        <button
          className={`tab-btn${view === "lapsed" ? " tab-btn--active" : ""}`}
          onClick={() => setView("lapsed")}
        >
          Lapsed users
        </button>
      </div>

      <div
        className="controls-bar"
        style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginTop: "1rem" }}
      >
        <div className="ret-seg" role="group" aria-label="Platform">
          {(["all", "ios", "android"] as Platform[]).map((p) => (
            <button
              key={p}
              className={`ret-seg-btn${platform === p ? " ret-seg-btn--on" : ""}`}
              onClick={() => setPlatform(p)}
            >
              {p === "all" ? "All platforms" : p === "ios" ? "iOS" : "Android"}
            </button>
          ))}
        </div>
        {view === "overview" && (
          <div className="ret-seg" role="group" aria-label="Revenue measure">
            <button className={`ret-seg-btn${money === "gross" ? " ret-seg-btn--on" : ""}`} onClick={() => setMoney("gross")}>
              Gross
            </button>
            <button className={`ret-seg-btn${money === "net" ? " ret-seg-btn--on" : ""}`} onClick={() => setMoney("net")}>
              Net
            </button>
          </div>
        )}
      </div>


      {view === "overview" && error && (
        <div className="error-box" style={{ margin: "1rem 0" }}>
          <p>Failed to load: {error}</p>
        </div>
      )}

      {view === "lapsed" ? (
        <LapsedUsers platform={platform} onUserClick={onUserClick} />
      ) : view === "plans" ? (
        <PlanRetention platform={platform} />
      ) : loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Loading plans and revenue…</p>
        </div>
      ) : months.length === 0 ? (
        <div className="empty-state" style={{ padding: "2rem" }}>
          No transactions for this selection.
        </div>
      ) : (
        <>
          <section
            className="metrics-grid"
            style={{ marginTop: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
          >
            <div className="metric-card">
              <div className="metric-value">{usd(totals.gross)}</div>
              <div className="metric-label">Gross Revenue</div>
              <div className="metric-description">{totals.payments.toLocaleString()} payments since Mar 1</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{usd(totals.net)}</div>
              <div className="metric-label">Net Revenue</div>
              <div className="metric-description">After store cut, tax and refunds</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{totals.payers.toLocaleString()}</div>
              <div className="metric-label">Paying Users</div>
              <div className="metric-description">Identified (linked to a Supabase user)</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">
                {totals.payers ? usd(totals.identifiedGross / totals.payers, 2) : "—"}
              </div>
              <div className="metric-label">Gross per Payer</div>
              <div className="metric-description">Identified payers only</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{usd(-totals.refunds)}</div>
              <div className="metric-label">Refunded</div>
              <div className="metric-description">{pct(-totals.refunds, totals.gross)} of gross</div>
            </div>
          </section>

          <div className="chart-container" style={{ marginTop: "1.25rem" }}>
            <div className="ret-chart-head">
              <h3>{money === "gross" ? "Gross" : "Net"} revenue by month and plan length</h3>
            </div>
            <p className="ret-chart-sub">
              Every payment, first purchases and renewals alike, by the month it was charged. The current month is
              partial. Hover a bar for the split.
            </p>
            <div style={{ width: "100%", height: 340 }}>
              <ResponsiveContainer>
                <BarChart data={chartData} margin={{ top: 10, right: 20, bottom: 8, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v: number) => usd(v)} tick={{ fontSize: 12 }} width={64} />
                  <Tooltip
                    formatter={(v: number | undefined, name) => [usd(Number(v ?? 0)), String(name)]}
                    labelFormatter={(label, payload) => {
                      let total = 0;
                      for (const p of payload ?? []) total += Number(p.value ?? 0);
                      return `${String(label)} · ${usd(total)} total`;
                    }}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    cursor={{ fill: "rgba(15, 23, 42, 0.04)" }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={(item) => BUCKETS.indexOf(String(item.value) as (typeof BUCKETS)[number])} />
                  {bucketsShown.map((b, i) => (
                    <Bar
                      key={b}
                      dataKey={b}
                      stackId="rev"
                      fill={BUCKET_COLORS[b]}
                      stroke="#ffffff"
                      strokeWidth={1}
                      radius={i === bucketsShown.length - 1 ? [4, 4, 0, 0] : 0}
                      isAnimationActive={false}
                      maxBarSize={56}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {subSummary && (
            <div className="chart-container" style={{ marginTop: "1.25rem" }}>
              <div
                className="ret-chart-head"
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}
              >
                <h3>Paying subscribers per day</h3>
                <div className="ret-seg" role="group" aria-label="Date range">
                  {([30, 90, 0] as SubRange[]).map((r) => (
                    <button
                      key={r}
                      className={`ret-seg-btn${subRange === r ? " ret-seg-btn--on" : ""}`}
                      onClick={() => setSubRange(r)}
                    >
                      {r ? `${r} days` : "Since Mar 1"}
                    </button>
                  ))}
                </div>
              </div>
              <p className="ret-chart-sub">
                {subSummary.start.toLocaleString()} → <strong>{subSummary.end.toLocaleString()}</strong> paying
                subscribers ({subSummary.end - subSummary.start >= 0 ? "+" : ""}
                {(subSummary.end - subSummary.start).toLocaleString()}): {subSummary.gained.toLocaleString()} started
                paying, {subSummary.lost.toLocaleString()} lapsed. A subscriber counts from a paid charge until that
                period runs out without a renewal (3-day grace), or until a refund. Includes buyers not linked to a
                user. Yearly plans bought before Mar 2026 and not yet renewed are missing, so the total is a floor.
                Data through {format(new Date(`${subSummary.lastDay}T00:00:00`), "MMM d, yyyy")}.
              </p>
              <div style={{ width: "100%", height: 200 }}>
                <ResponsiveContainer>
                  <LineChart data={subChart} syncId="subs" margin={{ top: 10, right: 20, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
                    <YAxis tick={{ fontSize: 12 }} width={64} domain={["auto", "auto"]} />
                    <Tooltip
                      formatter={(v: number | undefined) => [Number(v ?? 0).toLocaleString(), "Paying subscribers"]}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="active"
                      stroke="#0f172a"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ width: "100%", height: 220 }}>
                <ResponsiveContainer>
                  <ComposedChart
                    data={subChart}
                    syncId="subs"
                    stackOffset="sign"
                    margin={{ top: 10, right: 20, bottom: 8, left: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
                    <YAxis tick={{ fontSize: 12 }} width={64} allowDecimals={false} />
                    <ReferenceLine y={0} stroke="#94a3b8" />
                    <Tooltip
                      formatter={(v: number | undefined, name) => {
                        const n = Number(v ?? 0);
                        if (name === "Lapsed") return [(-n).toLocaleString(), String(name)];
                        return [`${name === "Net change" && n > 0 ? "+" : ""}${n.toLocaleString()}`, String(name)];
                      }}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      cursor={{ fill: "rgba(15, 23, 42, 0.04)" }}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: 12 }}
                      itemSorter={(item) => ["Started paying", "Lapsed", "Net change"].indexOf(String(item.value))}
                    />
                    <Bar
                      dataKey="gained"
                      name="Started paying"
                      stackId="chg"
                      fill={GAINED_COLOR}
                      radius={[2, 2, 0, 0]}
                      isAnimationActive={false}
                      maxBarSize={18}
                    />
                    <Bar
                      dataKey="lostNeg"
                      name="Lapsed"
                      stackId="chg"
                      fill={LOST_COLOR}
                      radius={[2, 2, 0, 0]}
                      isAnimationActive={false}
                      maxBarSize={18}
                    />
                    <Line
                      type="monotone"
                      dataKey="net"
                      name="Net change"
                      stroke="#0f172a"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="chart-container" style={{ marginTop: "1.25rem" }}>
            <div className="ret-chart-head">
              <h3>By plan length</h3>
            </div>
            <p className="ret-chart-sub">
              Trial conversion counts identified trials started 10+ days ago that were followed by a payment.
            </p>
            <div className="table-container" style={{ marginTop: "0.5rem" }}>
              <table className="data-table">
                <thead className="table-head">
                  <tr>
                    <th>Plan length</th>
                    <th>Payers</th>
                    <th>First purchases</th>
                    <th>Renewals</th>
                    <th>Trial → paid</th>
                    <th>Gross</th>
                    <th>Net</th>
                    <th>Gross per payer</th>
                    <th>Share of gross</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {byBucket.map((b) => (
                    <tr key={b.bucket}>
                      <td>
                        <span
                          aria-hidden
                          style={{
                            display: "inline-block",
                            width: 10,
                            height: 10,
                            borderRadius: 2,
                            background: BUCKET_COLORS[b.bucket],
                            marginRight: 8,
                          }}
                        />
                        {b.bucket}
                      </td>
                      <td>{b.payers.toLocaleString()}</td>
                      <td>{b.first_purchases.toLocaleString()}</td>
                      <td>{b.renewals.toLocaleString()}</td>
                      <td title={`${b.trial_conversions} of ${b.trials_resolved} resolved trials`}>
                        {pct(b.trial_conversions, b.trials_resolved)}
                      </td>
                      <td>{usd(b.gross)}</td>
                      <td>{usd(b.net)}</td>
                      <td>{b.payers ? usd(b.gross / b.payers, 2) : "—"}</td>
                      <td>{pct(b.gross, totals.gross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="chart-container" style={{ marginTop: "1.25rem" }}>
            <div className="ret-chart-head">
              <h3>By plan</h3>
            </div>
            <p className="ret-chart-sub">Every store product with activity. Click a column header to sort.</p>
            <div className="table-container" style={{ marginTop: "0.5rem" }}>
              <table className="data-table">
                <thead className="table-head">
                  <tr>
                    <th>Plan</th>
                    <th>Length</th>
                    <th>List price</th>
                    <th style={sortTh(planSort === "trial_starts")} onClick={() => setPlanSort("trial_starts")}>
                      Trials
                    </th>
                    <th style={sortTh(planSort === "conv")} onClick={() => setPlanSort("conv")}>
                      Trial → paid
                    </th>
                    <th style={sortTh(planSort === "first_purchases")} onClick={() => setPlanSort("first_purchases")}>
                      First buys
                    </th>
                    <th style={sortTh(planSort === "renewals")} onClick={() => setPlanSort("renewals")}>
                      Renewals
                    </th>
                    <th style={sortTh(planSort === "gross")} onClick={() => setPlanSort("gross")}>
                      Gross
                    </th>
                    <th style={sortTh(planSort === "net")} onClick={() => setPlanSort("net")}>
                      Net
                    </th>
                    <th>Refunds</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {sortedPlans.map((p) => (
                    <tr key={p.product_id}>
                      <td title={p.product_id}>
                        <code>{planName(p.product_id)}</code>
                        <div style={{ fontSize: 11, color: "#6b7280" }}>
                          {p.platform === "ios" ? "iOS" : "Android"}
                          {p.trial_days ? ` · ${p.trial_days}-day trial` : ""}
                        </div>
                      </td>
                      <td>{p.bucket}</td>
                      <td>{p.list_price_usd == null ? "—" : usd(p.list_price_usd, 2)}</td>
                      <td>{p.trial_starts.toLocaleString()}</td>
                      <td title={`${p.trial_conversions} of ${p.trials_resolved} resolved trials`}>
                        {pct(p.trial_conversions, p.trials_resolved)}
                      </td>
                      <td>{p.first_purchases.toLocaleString()}</td>
                      <td>{p.renewals.toLocaleString()}</td>
                      <td>{usd(p.gross)}</td>
                      <td>{usd(p.net)}</td>
                      <td>{p.refunds ? usd(-p.refunds) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="ret-chart-sub" style={{ marginTop: "0.75rem", maxWidth: "80ch" }}>
            <strong>Coverage:</strong> totals include every store transaction, but only ~65% carry a Supabase user
            id — the rest were bought while Superwall <code>identify()</code> wasn't running (mostly Mar–Jun 2026),
            so they count toward revenue but not toward any user. Android trial starts are only recorded from late
            July 2026. This is a one-time backfill; new purchases appear after the next sync.
          </p>
        </>
      )}
    </section>
  );
};

export default Revenue;
