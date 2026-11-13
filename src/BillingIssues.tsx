import React, { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "./lib/supabase";
import { num, planName } from "./lib/revenueFormat";

// The Billing issues block of the dashboard's Revenue section (src/Revenue.tsx):
// charges the store couldn't collect (failed card, no funds…), from Superwall's
// billing_issue events in subscription_billing_issues. "Renewals" are failed
// renewals of a paid period; "Trial end" are failed first charges when a free
// trial ran out. Recovered = the same subscription was charged successfully
// afterwards. Per-plan counts come from the parent's revenue_by_plan rows; the
// monthly trend from revenue_billing_issues_monthly (supabase/sql/revenue_page.sql).

export interface BillingPlanRow {
  product_id: string;
  platform: string;
  renewals: number;
  renewal_billing_issues: number;
  renewal_billing_recovered: number;
  trial_billing_issues: number;
  trial_billing_recovered: number;
}

interface MonthRow {
  month: string;
  renewal_issues: number;
  renewal_recovered: number;
  trial_issues: number;
  trial_recovered: number;
}

type Kind = "renewal" | "trial";

const RECOVERED_COLOR = "#2a78d6";
const OPEN_COLOR = "#eb6834";
const TOP_PLANS = 10;

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");

const BillingIssues: React.FC<{ plans: BillingPlanRow[]; platform: "all" | "ios" | "android" }> = ({
  plans,
  platform,
}) => {
  const [kind, setKind] = useState<Kind>("renewal");
  const [months, setMonths] = useState<MonthRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    supabase
      .rpc("revenue_billing_issues_monthly", { p_platform: platform === "all" ? null : platform })
      .then(({ data, error: e }) => {
        if (cancelled) return;
        // An rpc() error must surface — read as "empty" it would look like "no billing issues".
        if (e) {
          setError(e.message);
          setMonths([]);
          return;
        }
        setMonths(
          (data ?? []).map((r: Record<string, unknown>) => ({
            month: String(r.month),
            renewal_issues: num(r.renewal_issues),
            renewal_recovered: num(r.renewal_recovered),
            trial_issues: num(r.trial_issues),
            trial_recovered: num(r.trial_recovered),
          })),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const totals = useMemo(() => {
    const sum = (k: keyof BillingPlanRow) => plans.reduce((a, p) => a + (p[k] as number), 0);
    return {
      renewals: sum("renewals"),
      renewalIssues: sum("renewal_billing_issues"),
      renewalRecovered: sum("renewal_billing_recovered"),
      trialIssues: sum("trial_billing_issues"),
      trialRecovered: sum("trial_billing_recovered"),
    };
  }, [plans]);

  const monthChart = useMemo(
    () =>
      months.map((m) => {
        const issues = kind === "renewal" ? m.renewal_issues : m.trial_issues;
        const recovered = kind === "renewal" ? m.renewal_recovered : m.trial_recovered;
        return {
          label: format(new Date(`${m.month}T00:00:00`), "MMM ''yy"),
          Recovered: recovered,
          "Not recovered": issues - recovered,
        };
      }),
    [months, kind],
  );

  const planChart = useMemo(
    () =>
      plans
        .map((p) => {
          const issues = kind === "renewal" ? p.renewal_billing_issues : p.trial_billing_issues;
          const recovered = kind === "renewal" ? p.renewal_billing_recovered : p.trial_billing_recovered;
          return {
            label: `${planName(p.product_id)} · ${p.platform === "ios" ? "iOS" : "Android"}`,
            issues,
            Recovered: recovered,
            "Not recovered": issues - recovered,
          };
        })
        .filter((p) => p.issues > 0)
        .sort((a, b) => b.issues - a.issues)
        .slice(0, TOP_PLANS),
    [plans, kind],
  );

  const plansWithIssues = plans.filter(
    (p) => (kind === "renewal" ? p.renewal_billing_issues : p.trial_billing_issues) > 0,
  ).length;
  const what = kind === "renewal" ? "renewal charges" : "trial-end charges";

  const tooltip = (
    <Tooltip
      formatter={(v: number | undefined, name) => [Number(v ?? 0).toLocaleString(), String(name)]}
      labelFormatter={(label, payload) => {
        let total = 0;
        for (const p of payload ?? []) total += Number(p.value ?? 0);
        return `${String(label)} · ${total.toLocaleString()} failed`;
      }}
      contentStyle={{ fontSize: 12, borderRadius: 8 }}
      cursor={{ fill: "rgba(15, 23, 42, 0.04)" }}
    />
  );
  const legend = (
    <Legend
      wrapperStyle={{ fontSize: 12 }}
      itemSorter={(item) => ["Recovered", "Not recovered"].indexOf(String(item.value))}
    />
  );

  return (
    <div className="chart-container" style={{ marginTop: "1.25rem" }}>
      <div className="ret-chart-head">
        <h3>Billing issues</h3>
        <div className="ret-seg" role="group" aria-label="Which failed charges">
          {(["renewal", "trial"] as Kind[]).map((k) => (
            <button
              key={k}
              className={`ret-seg-btn${kind === k ? " ret-seg-btn--on" : ""}`}
              onClick={() => setKind(k)}
            >
              {k === "renewal" ? "Renewals" : "Trial end"}
            </button>
          ))}
        </div>
      </div>
      <p className="ret-chart-sub">
        Charges the store couldn't collect (failed card, no funds…) since Mar 1, one per store transaction.
        Renewals are failed renewals of a paid period; Trial end are failed first charges when a free trial ran
        out. Recovered means the same subscription was charged successfully afterwards — recent issues may still
        recover.
      </p>

      <section
        className="metrics-grid"
        style={{ marginTop: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
      >
        <div className="metric-card">
          <div className="metric-value">{totals.renewalIssues.toLocaleString()}</div>
          <div className="metric-label">Failed Renewals</div>
          <div className="metric-description">
            vs {totals.renewals.toLocaleString()} successful renewals
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{pct(totals.renewalRecovered, totals.renewalIssues)}</div>
          <div className="metric-label">Renewals Recovered</div>
          <div className="metric-description">
            {totals.renewalRecovered.toLocaleString()} of {totals.renewalIssues.toLocaleString()} charged later
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-value">
            {(totals.renewalIssues - totals.renewalRecovered).toLocaleString()}
          </div>
          <div className="metric-label">Renewals Not Recovered</div>
          <div className="metric-description">No successful charge since</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{totals.trialIssues.toLocaleString()}</div>
          <div className="metric-label">Failed Trial-End Charges</div>
          <div className="metric-description">
            {totals.trialRecovered.toLocaleString()} recovered ({pct(totals.trialRecovered, totals.trialIssues)})
          </div>
        </div>
      </section>

      {error && (
        <p className="ret-chart-sub" style={{ color: "#b91c1c" }}>
          Couldn't load the monthly trend: {error}
        </p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "1.25rem" }}>
        <div>
          <h4 style={{ margin: "1rem 0 0.25rem", fontSize: 13, color: "#374151" }}>
            Failed {what} by month
          </h4>
          {monthChart.length === 0 ? (
            <div className="empty-state" style={{ padding: "2rem" }}>No billing issues for this selection.</div>
          ) : (
            <div style={{ width: "100%", height: 300 }}>
              <ResponsiveContainer>
                <BarChart data={monthChart} margin={{ top: 10, right: 20, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 12 }} width={44} allowDecimals={false} />
                  {tooltip}
                  {legend}
                  <Bar dataKey="Recovered" stackId="a" fill={RECOVERED_COLOR} stroke="#fff" strokeWidth={1} isAnimationActive={false} maxBarSize={36} />
                  <Bar dataKey="Not recovered" stackId="a" fill={OPEN_COLOR} stroke="#fff" strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        <div>
          <h4 style={{ margin: "1rem 0 0.25rem", fontSize: 13, color: "#374151" }}>
            Failed {what} by plan
            {plansWithIssues > TOP_PLANS ? ` (top ${TOP_PLANS} of ${plansWithIssues})` : ""}
          </h4>
          {planChart.length === 0 ? (
            <div className="empty-state" style={{ padding: "2rem" }}>No billing issues for this selection.</div>
          ) : (
            <div style={{ width: "100%", height: 300 }}>
              <ResponsiveContainer>
                <BarChart data={planChart} layout="vertical" margin={{ top: 10, right: 20, bottom: 8, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 12 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={190} interval={0} />
                  {tooltip}
                  {legend}
                  <Bar dataKey="Recovered" stackId="a" fill={RECOVERED_COLOR} stroke="#fff" strokeWidth={1} isAnimationActive={false} maxBarSize={18} />
                  <Bar dataKey="Not recovered" stackId="a" fill={OPEN_COLOR} stroke="#fff" strokeWidth={1} radius={[0, 4, 4, 0]} isAnimationActive={false} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BillingIssues;
