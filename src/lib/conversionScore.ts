// Live trial-conversion likelihood score, computed in the browser from a user's
// signup/demographic fields (all already loaded into All Transcripts' userMeta —
// no extra queries). It is a logistic-regression "scorecard": coefficients were
// fit offline on resolved trials (label = became_active_at set) and exported to
// conversionScorecard.json; scoring here reproduces that model exactly.
//
// Honest framing: CV ROC-AUC ≈ 0.74 — a useful RANKING, not a per-user
// certainty. The High tier historically converts ~42% vs an ~18% base (2.3x),
// Low ~7%. Features are signup-time only (age, onboarding reason, demand_tier,
// language, tutor, platform, …), so it is usable from day 0 of a trial. See
// scripts in scratchpad / memory "conversion-signal-findings" for the analysis.

import scorecard from "./conversionScorecard.json";

export type ConvTier = "high" | "medium" | "low";

export interface ConversionScore {
  prob: number; // model probability (0..1)
  tier: ConvTier;
}

type NumericSpec = { name: string; median: number; mean: number; scale: number; coef: number };
type CategoricalSpec = {
  name: string;
  coefs: Record<string, number>;
  infrequent_coef: number;
  infrequent_values: string[];
};

const CARD = scorecard as unknown as {
  intercept: number;
  numeric: NumericSpec[];
  categorical: CategoricalSpec[];
  tiers: { high: number; medium: number };
  cv_auc: number;
  base_rate: number;
};

export const CONV_MODEL_AUC = CARD.cv_auc;

// Shared tier metadata (labels/variants/hints) for the likelihood pill + filter,
// used by both All Transcripts and User Lookup. High ≈ 42% convert, Medium ≈ 21%,
// Low ≈ 7% (base ~18%) — a model lean, not a certainty.
export const CONV_TIER_META: Record<
  ConvTier,
  { label: string; variant: string; hint: string }
> = {
  high: {
    label: "High",
    variant: "high",
    hint: `Predicted trial-conversion likelihood: HIGH (top ~20%, historically ~42% convert). Signup-demographics model, AUC ≈ ${CARD.cv_auc} — a lean, not a certainty.`,
  },
  medium: {
    label: "Medium",
    variant: "medium",
    hint: `Predicted trial-conversion likelihood: MEDIUM (historically ~21% convert). Model AUC ≈ ${CARD.cv_auc} — a lean, not a certainty.`,
  },
  low: {
    label: "Low",
    variant: "low",
    hint: `Predicted trial-conversion likelihood: LOW (bottom ~50%, historically ~7% convert). Model AUC ≈ ${CARD.cv_auc} — a lean, not a certainty.`,
  },
};

export const CONV_TIER_ORDER: ConvTier[] = ["high", "medium", "low"];

// Normalize a raw field to the string form the model was trained on:
// null/blank → "NA"; booleans → "true"/"false"; everything else → String().
function catValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "NA";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// meta is any object carrying the scorecard's feature fields (e.g. UserMeta).
export function scoreConversion(
  meta: Record<string, unknown> | null | undefined,
): ConversionScore | null {
  if (!meta) return null;
  let z = CARD.intercept;

  for (const n of CARD.numeric) {
    const raw = meta[n.name];
    const num = raw == null || raw === "" ? NaN : Number(raw);
    const val = Number.isNaN(num) ? n.median : num; // impute missing with training median
    z += n.coef * ((val - n.mean) / n.scale);
  }

  for (const c of CARD.categorical) {
    const v = catValue(meta[c.name]);
    if (Object.prototype.hasOwnProperty.call(c.coefs, v)) z += c.coefs[v];
    else if (c.infrequent_values.includes(v)) z += c.infrequent_coef;
    // unknown/unseen category → contributes 0 (matches OneHotEncoder handle_unknown="ignore")
  }

  const prob = 1 / (1 + Math.exp(-z));
  const tier: ConvTier =
    prob >= CARD.tiers.high ? "high" : prob >= CARD.tiers.medium ? "medium" : "low";
  return { prob, tier };
}
