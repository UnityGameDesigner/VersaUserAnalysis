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
} from "recharts";
import { format } from "date-fns";

// "Trial Conversion" — of users who START a trial, how many convert to paid, and
// how fast, by cohort. Uses user_info.trial_started_at + became_active_at (both
// backfilled from Superwall revenue events and maintained by superwall-webhook).
// Backed by the trial_conversion_trend RPC.

interface Row {
  cohort: string;
  trial_starts: number;
  conversions: number;
  conv_rate: number;
  median_days: number | null;
}

type Gran = "month" | "week";
type Metric = "rate" | "days";

const MIN_STARTS = 20;

function cohortLabel(iso: string, gran: Gran): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return gran === "month" ? format(d, "MMM ''yy") : format(d, "MMM d");
}

const TrialConversion: React.FC = () => {
  const [gran, setGran] = useState<Gran>("month");
  const [metric, setMetric] = useState<Metric>("rate");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc("trial_conversion_trend", { gran });
      if (error) throw new Error(error.message);
      const mapped: Row[] = (data ?? []).map((r: Record<string, unknown>) => ({
        cohort: String(r.cohort),
        trial_starts: Number(r.trial_starts ?? 0),
        conversions: Number(r.conversions ?? 0),
        conv_rate: Number(r.conv_rate ?? 0),
        median_days: r.median_days == null ? null : Number(r.median_days),
      }));
      setRows(mapped);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [gran]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const shown = useMemo(() => rows.filter((r) => r.trial_starts >= MIN_STARTS), [rows]);

  const chartData = useMemo(
    () =>
      shown.map((r) => ({
        label: cohortLabel(r.cohort, gran),
        trial_starts: r.trial_starts,
        conversions: r.conversions,
        value: metric === "rate" ? r.conv_rate : r.median_days ?? 0,
      })),
    [shown, metric, gran],
  );

  const summary = useMemo(() => {
    if (shown.length === 0) return null;
    const starts = shown.reduce((a, r) => a + r.trial_starts, 0);
    const convs = shown.reduce((a, r) => a + r.conversions, 0);
    const rate = starts ? (100 * convs) / starts : 0;
    const medianDays =
      shown.map((r) => r.median_days).filter((v): v is number => v != null).sort((a, b) => a - b)[
        Math.floor(shown.filter((r) => r.median_days != null).length / 2)
      ] ?? null;
    const first = shown[0];
    const last = shown[shown.length - 1];
    return { starts, convs, rate, medianDays, first, last };
  }, [shown]);

  const unit = metric === "rate" ? "%" : "d";

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title" style={{ margin: 0 }}>
        Trial Conversion
        {summary && (
          <span className="lessons-detail-count">
            {summary.starts.toLocaleString()} trials · {summary.convs.toLocaleString()} converted
          </span>
        )}
      </h2>
      <p className="ret-chart-sub" style={{ marginTop: "0.4rem", maxWidth: "74ch" }}>
        Of users who <strong>started a trial</strong> (from <code>trial_started_at</code>), the share who
        converted to paid (<code>became_active_at</code>), by the {gran} their trial began.
        Cohorts under {MIN_STARTS} trials, and trials from the last 14 days (not yet resolved), are excluded.
      </p>

      {/* Controls */}
      <div
        className="controls-bar"
        style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginTop: "1rem" }}
      >
        <div className="ret-seg" role="group" aria-label="Metric">
          <button className={`ret-seg-btn${metric === "rate" ? " ret-seg-btn--on" : ""}`} onClick={() => setMetric("rate")}>
            Conversion rate
          </button>
          <button className={`ret-seg-btn${metric === "days" ? " ret-seg-btn--on" : ""}`} onClick={() => setMetric("days")}>
            Days to convert
          </button>
        </div>
        <div className="ret-seg" role="group" aria-label="Granularity">
          <button className={`ret-seg-btn${gran === "month" ? " ret-seg-btn--on" : ""}`} onClick={() => setGran("month")}>
            Monthly
          </button>
          <button className={`ret-seg-btn${gran === "week" ? " ret-seg-btn--on" : ""}`} onClick={() => setGran("week")}>
            Weekly
          </button>
        </div>
      </div>

      {error && (
        <div className="error-box" style={{ margin: "1rem 0" }}>
          <p>Failed to load: {error}</p>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Computing trial → paid conversion by cohort…</p>
        </div>
      ) : chartData.length === 0 ? (
        <div className="empty-state" style={{ padding: "2rem" }}>
          No cohorts with at least {MIN_STARTS} resolved trials yet.
        </div>
      ) : (
        <>
          {summary && (
            <section className="metrics-grid" style={{ marginTop: "1rem" }}>
              <div className="metric-card">
                <div className="metric-value">{summary.rate.toFixed(1)}%</div>
                <div className="metric-label">Overall Conversion</div>
                <div className="metric-description">Trial → paid, all shown cohorts</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{summary.medianDays == null ? "—" : `${summary.medianDays.toFixed(1)}d`}</div>
                <div className="metric-label">Median Time to Convert</div>
                <div className="metric-description">From trial start</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{summary.last.conv_rate}%</div>
                <div className="metric-label">Latest Cohort</div>
                <div className="metric-description">{cohortLabel(summary.last.cohort, gran)}</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{summary.starts.toLocaleString()}</div>
                <div className="metric-label">Trial Starters</div>
                <div className="metric-description">{summary.convs.toLocaleString()} converted</div>
              </div>
            </section>
          )}

          <div className="chart-container" style={{ marginTop: "1.25rem" }}>
            <div className="ret-chart-head">
              <h3>{metric === "rate" ? "Conversion rate" : "Median days to convert"} by cohort</h3>
            </div>
            <p className="ret-chart-sub">
              Cohort = {gran} the trial started. Hover for cohort size.
            </p>
            <div style={{ width: "100%", height: 340 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 10, right: 28, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={20} />
                  <YAxis domain={[0, "auto"]} unit={unit} tick={{ fontSize: 12 }} width={48} />
                  <Tooltip
                    formatter={(v: number | undefined) => [
                      metric === "rate" ? `${v ?? 0}%` : `${v ?? 0} days`,
                      metric === "rate" ? "Conversion" : "Median days",
                    ]}
                    labelFormatter={(label) => {
                      const key = String(label);
                      const d = chartData.find((c) => c.label === key);
                      return d ? `${key} · ${d.trial_starts.toLocaleString()} trials, ${d.conversions} converted` : key;
                    }}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
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

          <p className="ret-chart-sub" style={{ marginTop: "0.75rem", maxWidth: "80ch" }}>
            <strong>Coverage:</strong> trial timing comes from Superwall revenue events, keyed to users whose
            <code> app_user_id</code> was their auth id. Trials started during the ~Mar–Jun 2026 window when
            Superwall <code>identify()</code> was disabled were anonymous and are absent, so those cohorts are
            sparse or missing. Going forward the webhook stamps <code>trial_started_at</code> on every trial start.
          </p>
        </>
      )}
    </div>
  );
};

export default TrialConversion;
