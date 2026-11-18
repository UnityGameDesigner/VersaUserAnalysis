// Estimated 12-month LTV per new paying subscriber on a plan:
//
//   average payment  ×  expected number of payments in the first 12 months
//
// Expected payments = the sum, over every charge date in the first 12 months
// (0, L, 2L, … for a plan of length L months), of the share of subscriptions
// still paying at that date. That survival curve comes from the renewal data
// in revenue_plan_retention:
//   - "paying after 1 / 2 / 3 / 6 months" (m1..m6), where a renewal was due
//   - for weekly plans also the first and second weekly renewal (r1, r2)
// Between observed points it is interpolated; past the plan's last observed
// point it follows the shape of the plan-length average (all plans of the same
// length), and past that average's own last point it keeps decaying at the
// average monthly rate seen so far. That last rate is conservative: real
// churn slows down over time.
//
// A yearly plan is charged once in 12 months, so its figure is simply the
// average payment — no renewal assumption (and no renewal value) in it.

export interface LtvInput {
  period_months: number | null;
  payments: number;
  gross: number;
  net: number;
  r1_kept: number; r1_elig: number;
  r2_kept: number; r2_elig: number;
  m1_kept: number; m1_elig: number;
  m2_kept: number; m2_elig: number;
  m3_kept: number; m3_elig: number;
  m6_kept: number; m6_elig: number;
}

export interface LtvEstimate {
  gross: number; // estimated 12-month gross per new paying subscriber
  net: number; // same, after store fees and refunds
  expectedPayments: number;
  avgPayment: number; // gross per payment
  // How far the plan's own renewal data reaches, in months (0 = none yet).
  observedTo: number;
  // "own": no renewal assumption needed, or own data covers the 12 months' shape start to its last point;
  // "length": the plan has no renewal data of its own yet — the whole curve is the plan-length average.
  basis: "own" | "length";
}

const HORIZON = 12; // months
const MIN_ELIG = 5; // same floor as the renewal-rate columns
const EPS = 1e-9;

interface Anchor { t: number; s: number }

function periodLength(periodMonths: number | null): number | null {
  if (periodMonths == null || periodMonths <= 0) return null;
  return periodMonths < 1 ? HORIZON / 52 : periodMonths; // weekly
}

// Observed survival points, t in months, starting at (0, 1) and never rising.
function anchors(k: LtvInput, L: number): Anchor[] {
  const pts: Anchor[] = [{ t: 0, s: 1 }];
  if (L < 1 && k.r1_elig >= MIN_ELIG) {
    const r1 = k.r1_kept / k.r1_elig;
    pts.push({ t: L, s: r1 });
    if (k.r2_elig >= MIN_ELIG) pts.push({ t: 2 * L, s: r1 * (k.r2_kept / k.r2_elig) });
  }
  for (const n of [1, 2, 3, 6] as const) {
    const elig = k[`m${n}_elig`];
    // Before the first renewal is due the rate only reflects refunds — skip it.
    if (n + EPS < L || elig < MIN_ELIG) continue;
    pts.push({ t: n, s: k[`m${n}_kept`] / elig });
  }
  pts.sort((a, b) => a.t - b.t);
  for (let i = 1; i < pts.length; i++) pts[i].s = Math.min(pts[i].s, pts[i - 1].s);
  return pts;
}

function interpolate(a: Anchor, b: Anchor, t: number): number {
  const f = (t - a.t) / (b.t - a.t);
  if (a.s <= 0 || b.s <= 0) return a.s + (b.s - a.s) * f;
  return a.s * Math.pow(b.s / a.s, f); // constant churn rate between the two points
}

type Curve = (t: number) => number | null;

// Survival at month t. Past the last observed point: follow `fallback`'s
// shape when given, otherwise keep the average monthly decay seen so far.
function curve(pts: Anchor[], fallback: Curve | null): Curve {
  const last = pts[pts.length - 1];
  return (t: number) => {
    if (t <= last.t + EPS) {
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i].t + EPS) return interpolate(pts[i - 1], pts[i], t);
      }
      return last.s;
    }
    if (fallback) {
      const at = fallback(last.t);
      const then = fallback(t);
      if (at == null || then == null) return null;
      return at > 0 ? last.s * Math.min(1, then / at) : 0;
    }
    if (last.t === 0) return null; // nothing observed at all
    if (last.s <= 0) return 0;
    // Decay measured from the first point a month or more in (the drop at the
    // very first renewal is much steeper than what follows) to the last one.
    const from = pts.find((p) => p.t >= 1 - EPS && p.t < last.t - EPS && p.s > 0) ?? pts[0];
    const monthly = Math.pow(last.s / from.s, 1 / (last.t - from.t));
    return last.s * Math.pow(monthly, t - last.t);
  };
}

/** The plan-length average curve, used as the fallback shape for its plans. */
export function lengthCurve(pooled: LtvInput): Curve | null {
  const L = periodLength(pooled.period_months);
  return L == null ? null : curve(anchors(pooled, L), null);
}

export function estimateLtv(k: LtvInput | undefined, fallback: Curve | null): LtvEstimate | null {
  if (!k || k.payments <= 0) return null;
  const L = periodLength(k.period_months);
  if (L == null) return null;
  const pts = anchors(k, L);
  const s = curve(pts, fallback);
  let expected = 0;
  for (let i = 0; i * L < HORIZON - EPS; i++) {
    const v = i === 0 ? 1 : s(i * L);
    if (v == null) return null;
    expected += v;
  }
  const observedTo = pts[pts.length - 1].t;
  return {
    gross: (k.gross / k.payments) * expected,
    net: (k.net / k.payments) * expected,
    expectedPayments: expected,
    avgPayment: k.gross / k.payments,
    observedTo,
    basis: L >= HORIZON - EPS || observedTo > 0 ? "own" : "length",
  };
}
