import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./lib/supabase";
import { BUCKETS, BUCKET_COLORS, num, usd, planName, fmtDate } from "./lib/revenueFormat";

// "Plan retention" view of the Revenue tab — how well each plan keeps the
// subscriptions that start on it. Reads revenue_plan_retention
// (supabase/sql/revenue_plan_retention.sql), which returns raw counts per plan
// (numerator + eligible denominator for every rate) so plan lengths can be
// rolled up here by summing.

type Platform = "all" | "ios" | "android";
type SortKey =
  | "subscribers" | "trial" | "m1" | "m2" | "m3" | "m6" | "r1" | "refund" | "months" | "ltv" | "arppu_mo"
  | "days7" | "days14" | "days" | "zero";

interface PlanRow {
  product_id: string;
  platform: string;
  bucket: string;
  period_months: number | null; // plan length (weekly = 0.25); null = one-off
  list_price_usd: number | null;
  trial_days: number | null;
  trials: number;
  trials_resolved: number;
  trials_converted: number;
  subscribers: number;
  r1_elig: number;
  r1_kept: number;
  r2_elig: number;
  r2_kept: number;
  m1_elig: number;
  m1_kept: number;
  m2_elig: number;
  m2_kept: number;
  m3_elig: number;
  m3_kept: number;
  m6_elig: number;
  m6_kept: number;
  active_now: number;
  refunded: number;
  payments: number;
  gross: number;
  net: number;
  paid_days: number; // paid coverage elapsed up to the as-of date
  bought_days: number; // paid coverage bought, including periods not over yet
  // Distinct days with a lesson in the first 7 / 14 / 30 days after paying,
  // each over the identified subscribers at least that old.
  eng7_elig: number;
  eng7_days: number;
  eng14_elig: number;
  eng14_days: number;
  eng14_regular: number; // 5+ active days of the first 14
  eng_elig: number;
  eng_days: number;
  eng_zero: number;
  eng_weekly: number;
  as_of: string;
}

const COUNT_KEYS = [
  "trials", "trials_resolved", "trials_converted", "subscribers", "r1_elig", "r1_kept", "r2_elig", "r2_kept",
  "m1_elig", "m1_kept", "m2_elig", "m2_kept", "m3_elig", "m3_kept", "m6_elig", "m6_kept", "active_now",
  "refunded", "payments", "gross", "net", "paid_days", "bought_days", "eng7_elig", "eng7_days", "eng14_elig", "eng14_days",
  "eng14_regular", "eng_elig", "eng_days", "eng_zero", "eng_weekly",
] as const;

// Below this many eligible subscriptions a rate is shown faded; below MIN_SHOWN it isn't shown.
const SMALL_SAMPLE = 20;
const MIN_SHOWN = 5;

const rate = (kept: number, elig: number) => (elig >= MIN_SHOWN ? kept / elig : null);

// "Paying after N months" only says something about retention once the plan has
// come up for renewal by month N. Before that (a yearly plan at 1–6 months, a
// 3-month plan at 1–2) it's ~100% by construction — only refunds lower it — so
// those cells aren't shaded or ranked against plans that did face a renewal.
const CHECKPOINT_MONTHS: Partial<Record<SortKey, number>> = { m1: 1, m2: 2, m3: 3, m6: 6 };
function renewalDue(r: PlanRow, k: SortKey): boolean {
  const n = CHECKPOINT_MONTHS[k];
  return n == null || (r.period_months != null && n >= r.period_months);
}
// The value a column is sorted and shaded by: null where it isn't a retention signal.
const ranked = (r: PlanRow, k: SortKey) => (renewalDue(r, k) ? metric(r, k) : null);

// Sort / compare value for each sortable column; null sorts last.
function metric(r: PlanRow, k: SortKey): number | null {
  switch (k) {
    case "subscribers": return r.subscribers;
    case "trial": return rate(r.trials_converted, r.trials_resolved);
    case "m1": return rate(r.m1_kept, r.m1_elig);
    case "m2": return rate(r.m2_kept, r.m2_elig);
    case "m3": return rate(r.m3_kept, r.m3_elig);
    case "m6": return rate(r.m6_kept, r.m6_elig);
    case "r1": return rate(r.r1_kept, r.r1_elig);
    case "refund": return r.subscribers >= MIN_SHOWN ? r.refunded / r.subscribers : null;
    case "months": return r.subscribers ? r.paid_days / 30.44 / r.subscribers : null;
    // ARPPU to date: gross per paying subscriber. Per month: gross per month of
    // access bought — the effective monthly price after intro offers and refunds.
    case "ltv": return r.subscribers ? r.gross / r.subscribers : null;
    case "arppu_mo": return r.bought_days > 0 ? r.gross / (r.bought_days / 30.44) : null;
    case "days7": return r.eng7_elig >= MIN_SHOWN ? r.eng7_days / r.eng7_elig : null;
    case "days14": return r.eng14_elig >= MIN_SHOWN ? r.eng14_days / r.eng14_elig : null;
    case "days": return r.eng_elig >= MIN_SHOWN ? r.eng_days / r.eng_elig : null;
    case "zero": return r.eng_elig >= MIN_SHOWN ? r.eng_zero / r.eng_elig : null;
  }
}

// Green for high retention, red for low — scaled to the column, since a 3-month
// plan's month-1 rate (~100%) isn't comparable to a weekly plan's.
function heat(v: number | null, lo: number, hi: number, invert = false): React.CSSProperties {
  if (v == null || hi <= lo) return {};
  let t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  if (invert) t = 1 - t;
  return { background: `hsla(${Math.round(t * 120)}, 70%, 45%, 0.14)` };
}

const pctText = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

function sumRows(rows: PlanRow[], id: string, bucket: string): PlanRow {
  const out = { ...rows[0], product_id: id, bucket, platform: "", list_price_usd: null, trial_days: null } as PlanRow;
  for (const k of COUNT_KEYS) (out[k] as number) = rows.reduce((a, r) => a + r[k], 0);
  return out;
}

const PlanRetention: React.FC<{ platform: Platform }> = ({ platform }) => {
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<string>("all");
  const [hideSmall, setHideSmall] = useState(true);
  const [sort, setSort] = useState<SortKey>("subscribers");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    supabase
      .rpc("revenue_plan_retention", { p_platform: platform === "all" ? null : platform })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        // An rpc() error must surface — read as "empty" it looks like "no plans".
        if (err) {
          setError(err.message);
          setRows([]);
        } else {
          setRows(
            ((data ?? []) as Record<string, unknown>[]).map((r) => {
              const row: Record<string, unknown> = {
                product_id: String(r.product_id),
                platform: String(r.platform ?? ""),
                bucket: String(r.bucket ?? ""),
                period_months: r.period_months == null ? null : num(r.period_months),
                list_price_usd: r.list_price_usd == null ? null : num(r.list_price_usd),
                trial_days: r.trial_days == null ? null : num(r.trial_days),
                as_of: String(r.as_of),
              };
              for (const k of COUNT_KEYS) row[k] = num(r[k]);
              return row as unknown as PlanRow;
            }),
          );
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const lengths = useMemo(
    () =>
      BUCKETS.filter((b) => b !== "One-off")
        .map((b) => {
          const rs = rows.filter((r) => r.bucket === b);
          return rs.length ? sumRows(rs, b, b) : null;
        })
        .filter((r): r is PlanRow => r !== null),
    [rows],
  );

  const shown = useMemo(() => {
    const out = rows.filter(
      (r) =>
        r.bucket !== "One-off" &&
        (bucket === "all" || r.bucket === bucket) &&
        (!hideSmall || r.subscribers >= SMALL_SAMPLE),
    );
    return out.sort((a, b) => (ranked(b, sort) ?? -Infinity) - (ranked(a, sort) ?? -Infinity));
  }, [rows, bucket, hideSmall, sort]);

  // Column ranges for the heat shading, over the plans on screen.
  const ranges = useMemo(() => {
    const m = new Map<SortKey, [number, number]>();
    for (const k of [
      "trial", "m1", "m2", "m3", "m6", "r1", "refund", "months", "ltv", "arppu_mo", "days7", "days14", "days", "zero",
    ] as SortKey[]) {
      const vs = shown.map((r) => ranked(r, k)).filter((v): v is number => v != null);
      if (vs.length) m.set(k, [Math.min(...vs), Math.max(...vs)]);
    }
    return m;
  }, [shown]);

  const asOf = rows[0]?.as_of ?? null;
  const hiddenCount = rows.filter(
    (r) => r.bucket !== "One-off" && (bucket === "all" || r.bucket === bucket) && r.subscribers < SMALL_SAMPLE,
  ).length;

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "3rem" }}>
        <div className="loading-spinner"></div>
        <p className="loading-text">Loading plan retention…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="error-box" style={{ margin: "1rem 0" }}>
        <p>Failed to load plan retention: {error}</p>
      </div>
    );
  }

  const sortTh = (k: SortKey, title: string, label: React.ReactNode) => (
    <th
      title={title}
      onClick={() => setSort(k)}
      style={{ cursor: "pointer", whiteSpace: "nowrap", textDecoration: sort === k ? "underline" : undefined }}
    >
      {label}
    </th>
  );

  // One rate cell: the percentage, shaded within its column, with "kept / eligible" underneath.
  const rateCell = (r: PlanRow, k: SortKey, kept: number, elig: number, shade: boolean, invert = false) => {
    const v = metric(r, k);
    const range = ranges.get(k);
    if (!renewalDue(r, k)) {
      return (
        <td
          style={{ whiteSpace: "nowrap", color: "#9ca3af" }}
          title={`No renewal is due by month ${CHECKPOINT_MONTHS[k]} on a ${r.bucket.toLowerCase()} plan, so this is ~100% by default — only refunds lower it. Not a retention signal.`}
        >
          {pctText(v)}
          <div style={{ fontSize: 11 }}>before 1st renewal</div>
        </td>
      );
    }
    return (
      <td
        style={{
          whiteSpace: "nowrap",
          ...(shade && range ? heat(v, range[0], range[1], invert) : {}),
          opacity: elig < SMALL_SAMPLE ? 0.55 : 1,
        }}
        title={elig < SMALL_SAMPLE ? `Small sample: ${elig} eligible` : undefined}
      >
        {pctText(v)}
        <div style={{ fontSize: 11, color: "#6b7280" }}>{elig ? `${kept}/${elig}` : "not yet"}</div>
      </td>
    );
  };

  // Average active days in a window, shaded within its column, with a detail line underneath.
  const daysCell = (r: PlanRow, k: SortKey, elig: number, sub: React.ReactNode, shade: boolean, title: string) => {
    const v = metric(r, k);
    const range = ranges.get(k);
    return (
      <td
        style={{
          whiteSpace: "nowrap",
          ...(shade && range ? heat(v, range[0], range[1]) : {}),
          opacity: elig < SMALL_SAMPLE ? 0.55 : 1,
        }}
        title={title}
      >
        {v == null ? "—" : v.toFixed(1)}
        <div style={{ fontSize: 11, color: "#6b7280" }}>{elig >= MIN_SHOWN ? sub : elig ? `${elig} users` : "not yet"}</div>
      </td>
    );
  };

  const row = (r: PlanRow, isLength: boolean) => {
    const months = metric(r, "months");
    const ltv = metric(r, "ltv");
    const ltvRange = ranges.get("ltv");
    const arppuMo = metric(r, "arppu_mo");
    const moRange = ranges.get("arppu_mo");
    return (
      <tr key={(isLength ? "len:" : "") + r.product_id} style={isLength ? { fontWeight: 600 } : undefined}>
        <td title={r.product_id}>
          <span style={{ color: BUCKET_COLORS[r.bucket] ?? "#374151", fontWeight: 600 }}>
            {isLength ? r.bucket : planName(r.product_id)}
          </span>
          {!isLength && (
            <div style={{ fontSize: 11, color: "#6b7280" }}>
              {r.bucket} · {r.platform === "ios" ? "iOS" : "Android"}
              {r.list_price_usd != null && ` · ${usd(r.list_price_usd, 2)}`}
              {r.trial_days ? ` · ${r.trial_days}-day trial` : ""}
            </div>
          )}
        </td>
        <td style={{ whiteSpace: "nowrap" }}>
          {r.subscribers.toLocaleString()}
          <div style={{ fontSize: 11, color: "#6b7280" }}>{r.active_now.toLocaleString()} paying now</div>
        </td>
        {r.trials_resolved > 0
          ? rateCell(r, "trial", r.trials_converted, r.trials_resolved, !isLength)
          : <td style={{ color: "#9ca3af" }}>no trial</td>}
        {rateCell(r, "m1", r.m1_kept, r.m1_elig, !isLength)}
        {rateCell(r, "m2", r.m2_kept, r.m2_elig, !isLength)}
        {rateCell(r, "m3", r.m3_kept, r.m3_elig, !isLength)}
        {rateCell(r, "m6", r.m6_kept, r.m6_elig, !isLength)}
        {rateCell(r, "r1", r.r1_kept, r.r1_elig, !isLength)}
        <td style={{ whiteSpace: "nowrap" }} title="Of those who renewed once and whose 2nd period has ended, the share who renewed again">
          {pctText(rate(r.r2_kept, r.r2_elig))}
          <div style={{ fontSize: 11, color: "#6b7280" }}>{r.r2_elig ? `${r.r2_kept}/${r.r2_elig}` : "not yet"}</div>
        </td>
        {rateCell(r, "refund", r.refunded, r.subscribers, !isLength, true)}
        <td style={{ whiteSpace: "nowrap" }}>
          {months == null ? "—" : months.toFixed(1)}
          <div style={{ fontSize: 11, color: "#6b7280" }}>{r.payments.toLocaleString()} payments</div>
        </td>
        <td style={{ whiteSpace: "nowrap", ...(!isLength && ltvRange ? heat(ltv, ltvRange[0], ltvRange[1]) : {}) }}>
          {ltv == null ? "—" : usd(ltv, 2)}
          <div style={{ fontSize: 11, color: "#6b7280" }}>
            {r.subscribers ? `${usd(r.net / r.subscribers, 2)} net` : "—"}
          </div>
        </td>
        <td style={{ whiteSpace: "nowrap", ...(!isLength && moRange ? heat(arppuMo, moRange[0], moRange[1]) : {}) }}>
          {arppuMo == null ? "—" : usd(arppuMo, 2)}
          <div style={{ fontSize: 11, color: "#6b7280" }}>
            {arppuMo == null || !r.gross ? "—" : `${usd((arppuMo * r.net) / r.gross, 2)} net`}
          </div>
        </td>
        {daysCell(r, "days7", r.eng7_elig, `${r.eng7_elig} users`, !isLength,
          `${r.eng7_elig} identified subscribers whose first payment was 7+ days ago`)}
        {daysCell(r, "days14", r.eng14_elig, `${pctText(r.eng14_regular / r.eng14_elig)} on 5+ days`, !isLength,
          `${r.eng14_elig} identified subscribers whose first payment was 14+ days ago`)}
        {daysCell(r, "days", r.eng_elig, `${pctText(r.eng_weekly / r.eng_elig)} on 8+ days`, !isLength,
          `${r.eng_elig} identified subscribers whose first payment was 30+ days ago`)}
        {rateCell(r, "zero", r.eng_zero, r.eng_elig, !isLength, true)}
      </tr>
    );
  };

  const head = (
    <thead className="table-head">
      <tr>
        <th>Plan</th>
        {sortTh("subscribers", "Subscriptions that started on this plan since Mar 1 and made at least one payment", "Subscribers")}
        {sortTh("trial", "Trials started on this plan that turned into a payment (trials still running are left out)", "Trial → paid")}
        {sortTh("m1", "Still paying 1 month after the first payment (3-day grace). Rate among subscriptions at least 1 month + 3 days old", "Paying after 1 mo")}
        {sortTh("m2", "Still paying 2 months after the first payment", "2 mo")}
        {sortTh("m3", "Still paying 3 months after the first payment", "3 mo")}
        {sortTh("m6", "Still paying 6 months after the first payment", "6 mo")}
        {sortTh("r1", "Share that renewed at least once, among those whose first period has ended. Not yet possible for yearly plans", "1st renewal")}
        <th title="Of those who renewed once, the share who renewed again">2nd renewal</th>
        {sortTh("refund", "Share of subscribers with a refund", "Refunded")}
        {sortTh("months", "Average months of paid coverage per subscriber so far (up to the as-of date)", "Paid months")}
        {sortTh("ltv", "Average revenue per paying user so far: gross per subscriber since they started. Underneath: net, after store fees and refunds", "ARPPU")}
        {sortTh("arppu_mo", "ARPPU per month: gross per month of access bought (a yearly plan's price spread over 12 months), i.e. the effective monthly price after intro offers and refunds. Underneath: net", "ARPPU / mo")}
        {sortTh("days7", "Average distinct days with a lesson in the first 7 days after paying (identified users, first payment 7+ days ago)", "Active days, 1st 7d")}
        {sortTh("days14", "Average distinct days with a lesson in the first 14 days after paying (first payment 14+ days ago). Underneath: share on 5+ of those days", "1st 14d")}
        {sortTh("days", "Average distinct days with a lesson in the first 30 days after paying (first payment 30+ days ago). Underneath: share on 8+ of those days", "1st 30d")}
        {sortTh("zero", "Share with no lesson at all in their first 30 paid days", "No lessons, 1st 30d")}
      </tr>
    </thead>
  );

  return (
    <>
      <p className="ret-chart-sub" style={{ marginTop: "1rem", maxWidth: "90ch" }}>
        Each store subscription is counted under the plan it <strong>started</strong> on (trial or first purchase since
        Mar 1, 2026), as of <strong>{asOf ? fmtDate(asOf) : "—"}</strong>. Every rate only counts subscriptions old
        enough to have reached that point — the small "kept / eligible" figure under each one. "Paying after N mo"
        compares plan lengths fairly: a 3-month plan is ~100% at 1 and 2 months and first faces renewal at 3. To see
        whether a new plan's users come back more often, sort by <strong>Active days, 1st 7d / 14d</strong> — those
        fill in after a week or two, long before renewal numbers exist. Faded cells are based on fewer than{" "}
        {SMALL_SAMPLE} subscriptions.
      </p>

      <div className="chart-container" style={{ marginTop: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>By plan length</h3>
        <div className="table-container" style={{ marginTop: "0.5rem" }}>
          <table className="data-table">
            {head}
            <tbody className="table-body">{lengths.map((r) => row(r, true))}</tbody>
          </table>
        </div>
      </div>

      <div className="chart-container" style={{ marginTop: "1.25rem" }}>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>By plan</h3>
          <div className="ret-seg" role="group" aria-label="Plan length">
            {["all", ...BUCKETS.filter((b) => b !== "One-off")].map((b) => (
              <button
                key={b}
                className={`ret-seg-btn${bucket === b ? " ret-seg-btn--on" : ""}`}
                onClick={() => setBucket(b)}
              >
                {b === "all" ? "All lengths" : b}
              </button>
            ))}
          </div>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={hideSmall} onChange={(e) => setHideSmall(e.target.checked)} />
            Hide plans with fewer than {SMALL_SAMPLE} subscribers{hiddenCount ? ` (${hiddenCount})` : ""}
          </label>
        </div>
        {shown.length === 0 ? (
          <div className="empty-state" style={{ padding: "2rem" }}>No plans match.</div>
        ) : (
          <div className="table-container" style={{ marginTop: "0.75rem" }}>
            <table className="data-table">
              {head}
              <tbody className="table-body">{shown.map((r) => row(r, false))}</tbody>
            </table>
          </div>
        )}
        <p className="ret-chart-sub" style={{ marginTop: "0.5rem" }}>
          Shading compares plans within each column (green = better). Grey "before 1st renewal" cells — e.g. a yearly
          plan at 1–6 months — aren't shaded or ranked, since nobody on that plan could have churned yet. Click a column
          header to sort.
        </p>
      </div>
    </>
  );
};

export default PlanRetention;
