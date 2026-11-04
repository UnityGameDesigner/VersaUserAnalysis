import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./lib/supabase";
import { BUCKETS, BUCKET_COLORS, num, usd, planName, statusVariant, fmtDate } from "./lib/revenueFormat";

// "Lapsed users" view of the Revenue tab — identified users whose paid
// subscription ended without a renewal, filterable by plan length and by the
// exact store plan. Reads the revenue_lapsed_users RPC
// (supabase/sql/revenue_page.sql), which judges lapses as of the newest
// backfilled transaction minus 3 days and returns the live payment_status.

type Platform = "all" | "ios" | "android";
type PlanMatch = "last" | "any"; // the plan they lapsed from, or any plan they paid for
type LapsedSort = "lapsed_on" | "gross" | "payments";

interface LapsedRow {
  user_id: string;
  preferred_name: string | null;
  payment_status: string | null;
  platform: string;
  last_product_id: string;
  last_bucket: string;
  plans: { id: string; bucket: string }[]; // every plan they paid for, with its length
  payments: number;
  gross: number;
  net: number;
  first_paid_at: string | null;
  last_paid_at: string | null;
  lapsed_on: string;
  days_lapsed: number;
  reason: "refunded" | "not renewed";
  resubscribed_before: boolean;
  as_of: string;
}

// The webhook keeps payment_status live, so these lapsed after the backfill
// cut-off by our data but have since renewed or restarted a trial.
const isLiveNow = (r: LapsedRow) => r.payment_status === "ACTIVE" || r.payment_status === "TRIAL";

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const LapsedUsers: React.FC<{ platform: Platform; onUserClick?: (userId: string) => void }> = ({
  platform,
  onUserClick,
}) => {
  const [rows, setRows] = useState<LapsedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<string>("all");
  const [plan, setPlan] = useState<string>("all");
  const [match, setMatch] = useState<PlanMatch>("last");
  const [hideLive, setHideLive] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LapsedSort>("lapsed_on");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    supabase
      .rpc("revenue_lapsed_users", { p_platform: platform === "all" ? null : platform })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        // An rpc() error must surface — read as "empty" it looks like "nobody lapsed".
        if (err) {
          setError(err.message);
          setRows([]);
        } else {
          setRows(
            ((data ?? []) as Record<string, unknown>[]).map((r) => ({
              user_id: String(r.user_id),
              preferred_name: (r.preferred_name as string) ?? null,
              payment_status: (r.payment_status as string) ?? null,
              platform: String(r.platform),
              last_product_id: String(r.last_product_id),
              last_bucket: String(r.last_bucket ?? ""),
              plans: (r.plans as { id: string; bucket: string }[]) ?? [],
              payments: num(r.payments),
              gross: num(r.gross),
              net: num(r.net),
              first_paid_at: (r.first_paid_at as string) ?? null,
              last_paid_at: (r.last_paid_at as string) ?? null,
              lapsed_on: String(r.lapsed_on),
              days_lapsed: num(r.days_lapsed),
              reason: r.reason === "refunded" ? "refunded" : "not renewed",
              resubscribed_before: Boolean(r.resubscribed_before),
              as_of: String(r.as_of),
            })),
          );
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  // Rows left after the status toggle and search — the base every plan count is taken from.
  const pool = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!hideLive || !isLiveNow(r)) &&
        (!q || r.user_id.toLowerCase().includes(q) || (r.preferred_name ?? "").toLowerCase().includes(q)),
    );
  }, [rows, hideLive, search]);

  // The plans a row is matched on: the one they lapsed from, or every plan they had.
  const rowPlans = useMemo(
    () => (r: LapsedRow) =>
      match === "last" ? [{ id: r.last_product_id, bucket: r.last_bucket }] : r.plans,
    [match],
  );

  const bucketCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of pool)
      for (const b of new Set(rowPlans(r).map((p) => p.bucket))) m.set(b, (m.get(b) ?? 0) + 1);
    return m;
  }, [pool, rowPlans]);

  // Specific plans within the chosen length, most lapsed users first.
  const planCounts = useMemo(() => {
    const m = new Map<string, { bucket: string; n: number }>();
    for (const r of pool)
      for (const p of rowPlans(r)) {
        if (bucket !== "all" && p.bucket !== bucket) continue;
        const cur = m.get(p.id) ?? { bucket: p.bucket, n: 0 };
        cur.n += 1;
        m.set(p.id, cur);
      }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [pool, bucket, rowPlans]);

  // A plan picked under one length may not exist under the next one.
  useEffect(() => {
    if (plan !== "all" && !planCounts.some(([p]) => p === plan)) setPlan("all");
  }, [planCounts, plan]);

  const shown = useMemo(() => {
    const out = pool.filter((r) =>
      rowPlans(r).some((p) => (bucket === "all" || p.bucket === bucket) && (plan === "all" || p.id === plan)),
    );
    const key = (r: LapsedRow) => (sort === "lapsed_on" ? Date.parse(r.lapsed_on) : r[sort]);
    return out.sort((a, b) => key(b) - key(a));
  }, [pool, bucket, plan, rowPlans, sort]);

  const liveCount = rows.filter(isLiveNow).length;
  const asOf = rows[0]?.as_of ?? null;
  const lostGross = shown.reduce((a, r) => a + r.gross, 0);
  const refunded = shown.filter((r) => r.reason === "refunded").length;

  const downloadCsv = () => {
    const header = [
      "user_id", "name", "platform", "status_now", "lapsed_from_plan", "lapsed_from_length", "plans_had",
      "payments", "gross_usd", "net_usd", "first_paid_at", "last_paid_at", "lapsed_on", "days_lapsed", "reason",
    ];
    const lines = shown.map((r) =>
      [
        r.user_id, r.preferred_name, r.platform, r.payment_status, r.last_product_id, r.last_bucket,
        r.plans.map((p) => p.id).join(" | "), r.payments, r.gross.toFixed(2), r.net.toFixed(2), r.first_paid_at, r.last_paid_at,
        r.lapsed_on, r.days_lapsed, r.reason,
      ].map(csvCell).join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `lapsed-users${bucket !== "all" ? `-${bucket}` : ""}${plan !== "all" ? `-${planName(plan)}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const sortTh = (active: boolean): React.CSSProperties => ({
    cursor: "pointer",
    whiteSpace: "nowrap",
    textDecoration: active ? "underline" : undefined,
  });

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "3rem" }}>
        <div className="loading-spinner"></div>
        <p className="loading-text">Loading lapsed users…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="error-box" style={{ margin: "1rem 0" }}>
        <p>Failed to load lapsed users: {error}</p>
      </div>
    );
  }

  return (
    <>
      <p className="ret-chart-sub" style={{ marginTop: "1rem", maxWidth: "80ch" }}>
        Identified users whose paid subscription ended without a renewal (or was refunded), as of{" "}
        <strong>{asOf ? fmtDate(asOf) : "—"}</strong> — 3 days before the newest transaction in the Superwall
        backfill, so a renewal that's merely late isn't counted. Status is live from <code>user_info</code>.
      </p>

      <section
        className="metrics-grid"
        style={{ marginTop: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
      >
        <div className="metric-card">
          <div className="metric-value">{shown.length.toLocaleString()}</div>
          <div className="metric-label">Lapsed users</div>
          <div className="metric-description">Matching the filters below</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{usd(lostGross)}</div>
          <div className="metric-label">Their lifetime gross</div>
          <div className="metric-description">
            {shown.length ? `${usd(lostGross / shown.length, 2)} per lapsed user` : "—"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{refunded.toLocaleString()}</div>
          <div className="metric-label">Ended by refund</div>
          <div className="metric-description">The rest simply didn't renew</div>
        </div>
      </section>

      <div className="chart-container" style={{ marginTop: "1.25rem" }}>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <div className="ret-seg" role="group" aria-label="Plan length">
            {["all", ...BUCKETS.filter((b) => b !== "One-off")].map((b) => (
              <button
                key={b}
                className={`ret-seg-btn${bucket === b ? " ret-seg-btn--on" : ""}`}
                onClick={() => setBucket(b)}
              >
                {b === "all" ? "All lengths" : b}
                {b !== "all" && ` (${bucketCounts.get(b) ?? 0})`}
              </button>
            ))}
          </div>
          <select
            className="tx-chip-select"
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            aria-label="Specific plan"
          >
            <option value="all">All plans</option>
            {planCounts.map(([p, v]) => (
              <option key={p} value={p}>
                {planName(p)}
                {v.bucket ? ` · ${v.bucket}` : ""} ({v.n})
              </option>
            ))}
          </select>
          <div className="ret-seg" role="group" aria-label="Which plan to match">
            <button
              className={`ret-seg-btn${match === "last" ? " ret-seg-btn--on" : ""}`}
              onClick={() => setMatch("last")}
              title="Filter on the plan the user was on when they lapsed"
            >
              Plan they lapsed from
            </button>
            <button
              className={`ret-seg-btn${match === "any" ? " ret-seg-btn--on" : ""}`}
              onClick={() => setMatch("any")}
              title="Filter on any plan the user ever paid for"
            >
              Any plan they had
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.75rem" }}>
          <input
            className="tx-search-input"
            placeholder="Search name or user id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={hideLive} onChange={(e) => setHideLive(e.target.checked)} />
            Hide users who are ACTIVE / TRIAL now ({liveCount} — likely back since {asOf ? fmtDate(asOf) : "the backfill"})
          </label>
          <button className="transcript-toggle" onClick={downloadCsv} disabled={shown.length === 0}>
            Download CSV
          </button>
        </div>

        {shown.length === 0 ? (
          <div className="empty-state" style={{ padding: "2rem" }}>
            {bucket === "Yearly"
              ? "No yearly subscriber has lapsed — the data starts Mar 1, 2026, so no yearly plan in it has come up for renewal yet."
              : "No lapsed users match."}
          </div>
        ) : (
          <div className="table-container" style={{ marginTop: "0.75rem" }}>
            <table className="data-table">
              <thead className="table-head">
                <tr>
                  <th>Name</th>
                  <th title="Live payment_status from user_info">Status now</th>
                  <th title="The plan they were on when coverage ended">Lapsed from</th>
                  <th title="Every plan they paid for since Mar 1">Plans had</th>
                  <th style={sortTh(sort === "payments")} onClick={() => setSort("payments")}>
                    Payments
                  </th>
                  <th style={sortTh(sort === "gross")} onClick={() => setSort("gross")}>
                    Gross
                  </th>
                  <th style={sortTh(sort === "lapsed_on")} onClick={() => setSort("lapsed_on")}>
                    Lapsed on
                  </th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {shown.slice(0, 500).map((r) => {
                  const profileUrl = `${window.location.pathname}${window.location.search}#user-lookup:${r.user_id}`;
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
                      <td>
                        {r.preferred_name || r.user_id.slice(0, 8) + "…"}
                        <div style={{ fontSize: 11, color: "#6b7280" }}>
                          {r.platform === "ios" ? "iOS" : "Android"}
                        </div>
                      </td>
                      <td>
                        {r.payment_status ? (
                          <span className={`plan-pill plan-pill--${statusVariant(r.payment_status)}`}>
                            {r.payment_status}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td title={r.last_product_id}>
                        <span style={{ color: BUCKET_COLORS[r.last_bucket] ?? "#374151", fontWeight: 600 }}>
                          {r.last_bucket}
                        </span>
                        <div style={{ fontSize: 11, color: "#6b7280" }}>{planName(r.last_product_id)}</div>
                      </td>
                      <td style={{ fontSize: 12 }} title={r.plans.map((p) => `${p.id} (${p.bucket})`).join("\n")}>
                        {r.plans.map((p) => planName(p.id)).join(", ")}
                      </td>
                      <td>{r.payments}</td>
                      <td>{usd(r.gross, 2)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {fmtDate(r.lapsed_on)}
                        <div style={{ fontSize: 11, color: "#6b7280" }}>{r.days_lapsed} days before as-of</div>
                      </td>
                      <td>
                        {r.reason === "refunded" ? "Refunded" : "Didn't renew"}
                        {r.resubscribed_before && (
                          <div style={{ fontSize: 11, color: "#6b7280" }} title="They lapsed before and came back">
                            lapsed before
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length > 500 && (
              <p className="ret-chart-sub" style={{ marginTop: "0.5rem" }}>
                Showing the first 500 of {shown.length.toLocaleString()} — the CSV has them all.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default LapsedUsers;
