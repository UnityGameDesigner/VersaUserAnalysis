import React, { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  CONV_SCORECARD,
  CONV_TIER_META,
  explainConversion,
  type ConvTier,
} from "./lib/conversionScore";

// Explainer + interactive scorer for the trial-conversion prediction model
// (src/lib/conversionScore.ts). The model is an additive logistic scorecard: a
// baseline (intercept) plus a log-odds contribution per signup factor; the sum is
// squashed to a probability. This page shows exactly what each factor contributes.

const CARD = CONV_SCORECARD;

const POS = "#16a34a"; // raises conversion odds
const NEG = "#dc2626"; // lowers conversion odds

const FEATURE_LABEL: Record<string, string> = {
  age: "Age",
  gender: "Gender",
  native_language: "Native language",
  learning_language: "Learning language",
  level: "Self-reported level",
  reason: "Reason for learning",
  demand_tier: "Demand tier",
  platform: "Device platform",
  messaging_platform: "Messaging platform",
  tutor: "Tutor",
  completed_tutorial: "Completed tutorial",
  previous_experience: "Onboarding experience",
  attribution: "Acquisition source",
  time_zone: "Time zone",
};
const feat = (k: string) => FEATURE_LABEL[k] ?? k;
const mult = (coef: number) => Math.exp(coef); // odds multiplier
const fmtCoef = (c: number) => `${c >= 0 ? "+" : ""}${c.toFixed(2)}`;

// Factors exposed as controls in the interactive scorer (the interpretable ones).
const SCORER_FIELDS = [
  "gender",
  "native_language",
  "level",
  "reason",
  "demand_tier",
  "platform",
  "tutor",
  "attribution",
  "time_zone",
  "completed_tutorial",
] as const;

function optionsFor(name: string): { value: string; label: string }[] {
  const c = CARD.categorical.find((x) => x.name === name);
  if (!c) return [];
  const opts = Object.keys(c.coefs).map((k) => ({ value: k, label: k }));
  if (c.infrequent_values.length) opts.push({ value: c.infrequent_values[0], label: "(other / infrequent)" });
  if (!Object.prototype.hasOwnProperty.call(c.coefs, "NA")) opts.push({ value: "", label: "NA (not set)" });
  return opts;
}

const ConversionModel: React.FC = () => {
  // ── Interactive scorer state ────────────────────────────────────────────────
  const [age, setAge] = useState(31);
  const [inputs, setInputs] = useState<Record<string, string>>({
    gender: "Male",
    native_language: "en",
    level: "A2 - Early Intermediate",
    reason: "Career opportunities",
    demand_tier: "silver",
    platform: "ios",
    tutor: "Riley",
    attribution: "facebook",
    time_zone: "Asia/Jakarta",
    completed_tutorial: "false",
  });

  const meta = useMemo(() => {
    const m: Record<string, unknown> = { age };
    for (const f of SCORER_FIELDS) {
      if (f === "completed_tutorial") {
        m[f] = inputs[f] === "true" ? true : inputs[f] === "false" ? false : null;
      } else {
        m[f] = inputs[f] === "" ? null : inputs[f];
      }
    }
    return m;
  }, [age, inputs]);

  const explanation = useMemo(() => explainConversion(meta), [meta]);

  // Waterfall: intercept + each term, sorted by magnitude, for the current input.
  const waterfall = useMemo(() => {
    if (!explanation) return [];
    const rows = explanation.terms.map((t) => ({
      label: `${feat(t.feature)}: ${t.value}`,
      contribution: Math.round(t.contribution * 1000) / 1000,
    }));
    rows.push({ label: "Baseline (intercept)", contribution: Math.round(explanation.intercept * 1000) / 1000 });
    return rows.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  }, [explanation]);

  // ── Strongest signals across the whole model (feature × value) ───────────────
  const topSignals = useMemo(() => {
    const rows: { label: string; coef: number }[] = [];
    for (const c of CARD.categorical) {
      for (const [val, coef] of Object.entries(c.coefs)) {
        rows.push({ label: `${feat(c.name)}: ${val}`, coef });
      }
      if (c.infrequent_coef !== 0 && c.infrequent_values.length) {
        rows.push({ label: `${feat(c.name)}: (other / infrequent)`, coef: c.infrequent_coef });
      }
    }
    return rows.sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef)).slice(0, 22);
  }, []);

  const tierBadge = (tier: ConvTier) => (
    <span className={`user-conv-badge user-conv-badge--${CONV_TIER_META[tier].variant}`}>{CONV_TIER_META[tier].label}</span>
  );

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title" style={{ margin: 0 }}>
        Conversion Model
        <span className="lessons-detail-count">AUC {CARD.cv_auc} · {CARD.trained_rows.toLocaleString()} trials</span>
      </h2>
      <p className="ret-chart-sub" style={{ marginTop: "0.4rem", maxWidth: "84ch" }}>
        Predicts <strong>trial → paid conversion likelihood</strong> from a user's <strong>signup demographics only</strong>
        {" "}(known from day 0), so it can flag likely converters before they do a single lesson. It's a{" "}
        <strong>logistic scorecard</strong>: a baseline plus a log-odds contribution per factor, summed and squashed to a
        probability. Cross-validated ROC-AUC <strong>{CARD.cv_auc}</strong> — a useful <em>ranking</em>, not a per-user
        certainty. Trained {CARD.trained_at} on {CARD.trained_rows.toLocaleString()} resolved trials; base conversion rate ≈{" "}
        {Math.round(CARD.base_rate * 1000) / 10}%.
      </p>

      {/* Tiers */}
      <section className="metrics-grid" style={{ marginTop: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <div className="metric-card">
          <div className="metric-value" style={{ color: "#16a34a" }}>{Math.round(CARD.tier_conv_recent.high * 100)}%</div>
          <div className="metric-label">High tier converts</div>
          <div className="metric-description">predicted prob ≥ {Math.round(CARD.tiers.high * 100)}% · ~3× base</div>
        </div>
        <div className="metric-card">
          <div className="metric-value" style={{ color: "#d97706" }}>{Math.round(CARD.tier_conv_recent.medium * 100)}%</div>
          <div className="metric-label">Medium tier converts</div>
          <div className="metric-description">prob {Math.round(CARD.tiers.medium * 100)}–{Math.round(CARD.tiers.high * 100)}%</div>
        </div>
        <div className="metric-card">
          <div className="metric-value" style={{ color: "#dc2626" }}>{Math.round(CARD.tier_conv_recent.low * 100)}%</div>
          <div className="metric-label">Low tier converts</div>
          <div className="metric-description">prob &lt; {Math.round(CARD.tiers.medium * 100)}% · bottom ~50%</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{Math.round(CARD.base_rate * 1000) / 10}%</div>
          <div className="metric-label">Base rate</div>
          <div className="metric-description">all recent trials (the average)</div>
        </div>
      </section>

      {/* Interactive scorer */}
      <div className="chart-container" style={{ marginTop: "1.5rem" }}>
        <div className="ret-chart-head"><h3>Try it — score a hypothetical user</h3></div>
        <p className="ret-chart-sub">
          Change any factor and watch the predicted likelihood and each factor's contribution update. Contributions are in
          <strong> log-odds</strong> (green raises conversion odds, red lowers); the bar's odds multiplier is in the tooltip.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 340px) 1fr", gap: "1.5rem", alignItems: "start" }}>
          {/* Controls + result */}
          <div>
            <div style={{ display: "flex", gap: "1rem", alignItems: "baseline", marginBottom: "0.75rem" }}>
              <div>
                <div style={{ fontSize: "2rem", fontWeight: 700, color: explanation && explanation.prob >= CARD.tiers.high ? "#16a34a" : explanation && explanation.prob >= CARD.tiers.medium ? "#d97706" : "#dc2626" }}>
                  {explanation ? `${Math.round(explanation.prob * 1000) / 10}%` : "—"}
                </div>
                <div className="metric-label">Model score (rank)</div>
              </div>
              {explanation && <div style={{ alignSelf: "center" }}>{tierBadge(explanation.tier)}</div>}
            </div>
            {explanation && (
              <p className="ret-chart-sub" style={{ margin: "0 0 0.75rem" }}>
                Lands in the <strong>{CONV_TIER_META[explanation.tier].label}</strong> tier → <strong>~{Math.round(CARD.tier_conv_recent[explanation.tier] * 100)}%</strong> of
                such users actually convert (vs {Math.round(CARD.base_rate * 1000) / 10}% base). The % above is the model's raw
                ranking score, which runs hotter than the real rate — trust the tier's empirical rate for absolute expectations.
              </p>
            )}
            <label className="filter-label" style={{ display: "block", marginBottom: "0.6rem" }}>
              Age: <strong>{age}</strong>
              <input type="range" min={13} max={75} value={age} onChange={(e) => setAge(Number(e.target.value))} style={{ width: "100%" }} />
            </label>
            {SCORER_FIELDS.map((f) => (
              <label key={f} className="filter-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", marginBottom: "0.5rem" }}>
                <span>{feat(f)}</span>
                <select
                  className="filter-select"
                  value={inputs[f] ?? ""}
                  onChange={(e) => setInputs((p) => ({ ...p, [f]: e.target.value }))}
                  style={{ maxWidth: "170px" }}
                >
                  {optionsFor(f).map((o) => (
                    <option key={o.value || "__na__"} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {/* Contribution waterfall for the current input */}
          <div style={{ width: "100%", height: Math.max(320, waterfall.length * 26) }}>
            <ResponsiveContainer>
              <BarChart data={waterfall} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="label" width={230} tick={{ fontSize: 11 }} interval={0} />
                <ReferenceLine x={0} stroke="#9ca3af" />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  formatter={(v: number | undefined) => [`${fmtCoef(Number(v))} log-odds (×${mult(Number(v)).toFixed(2)} odds)`, "Contribution"]}
                />
                <Bar dataKey="contribution" isAnimationActive={false} radius={[0, 3, 3, 0]}>
                  {waterfall.map((r, i) => (
                    <Cell key={i} fill={r.label.startsWith("Baseline") ? "#6b7280" : r.contribution >= 0 ? POS : NEG} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Strongest signals overall */}
      <div className="chart-container" style={{ marginTop: "1.5rem" }}>
        <div className="ret-chart-head"><h3>Strongest signals in the model</h3></div>
        <p className="ret-chart-sub">
          The factor values that move conversion likelihood the most, across all users (top {topSignals.length} by magnitude).
          Green raises the odds, red lowers them; length is the log-odds weight (tooltip shows the odds multiplier). This is
          what the model has learned actually separates converters — read it as correlation, not cause.
        </p>
        <div style={{ width: "100%", height: topSignals.length * 26 + 40 }}>
          <ResponsiveContainer>
            <BarChart data={topSignals} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="label" width={260} tick={{ fontSize: 11 }} interval={0} />
              <ReferenceLine x={0} stroke="#9ca3af" />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
                formatter={(v: number | undefined) => [`${fmtCoef(Number(v))} log-odds (×${mult(Number(v)).toFixed(2)} odds)`, "Weight"]}
              />
              <Bar dataKey="coef" isAnimationActive={false} radius={[0, 3, 3, 0]}>
                {topSignals.map((r, i) => (
                  <Cell key={i} fill={r.coef >= 0 ? POS : NEG} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Full factor library */}
      <div className="chart-container" style={{ marginTop: "1.5rem" }}>
        <div className="ret-chart-head"><h3>Every factor, broken down</h3></div>
        <p className="ret-chart-sub">
          One panel per factor the model uses. Within a factor, each value's log-odds contribution (sorted). Age is numeric:
          +{CARD.numeric[0].coef.toFixed(2)} log-odds per standard deviation (~{Math.round(CARD.numeric[0].scale)} years) — older
          learners convert somewhat more often.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "1rem" }}>
          {CARD.categorical.map((c) => {
            const rows = Object.entries(c.coefs).map(([val, coef]) => ({ val, coef }));
            if (c.infrequent_coef !== 0 && c.infrequent_values.length) rows.push({ val: "(other / infrequent)", coef: c.infrequent_coef });
            rows.sort((a, b) => b.coef - a.coef);
            const maxAbs = Math.max(0.001, ...rows.map((r) => Math.abs(r.coef)));
            return (
              <div key={c.name} style={{ border: "1px solid #eef2f7", borderRadius: 10, padding: "0.75rem 0.9rem" }}>
                <div className="user-group-title" style={{ marginBottom: "0.5rem" }}>{feat(c.name)}</div>
                {rows.map((r) => (
                  <div key={r.val} style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.2rem 0", fontSize: "0.8rem" }}>
                    <span style={{ flex: "0 0 44%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.val}>{r.val}</span>
                    <span style={{ flex: 1, position: "relative", height: 12, background: "#f3f4f6", borderRadius: 3 }}>
                      <span
                        style={{
                          position: "absolute",
                          left: r.coef >= 0 ? "50%" : `${50 - (Math.abs(r.coef) / maxAbs) * 50}%`,
                          width: `${(Math.abs(r.coef) / maxAbs) * 50}%`,
                          height: "100%",
                          background: r.coef >= 0 ? POS : NEG,
                          borderRadius: 3,
                        }}
                      />
                      <span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "#cbd5e1" }} />
                    </span>
                    <span style={{ flex: "0 0 42px", textAlign: "right", color: r.coef >= 0 ? POS : NEG, fontWeight: 600 }}>{fmtCoef(r.coef)}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <p className="ret-chart-sub" style={{ marginTop: "1rem", maxWidth: "84ch" }}>
        <strong>Read with care:</strong> these are model coefficients on signup demographics — associations the model exploits
        to rank, not causes. Some reflect data quirks (e.g. a missing/"NA" field can carry signal because of <em>who</em> leaves
        it blank), and correlated factors share credit. Engagement (lessons completed, etc.) is deliberately excluded so the
        score is available from day 0. AUC {CARD.cv_auc} means it ranks a random converter above a random non-converter ~{Math.round(CARD.cv_auc * 100)}% of the time.
      </p>
    </div>
  );
};

export default ConversionModel;
