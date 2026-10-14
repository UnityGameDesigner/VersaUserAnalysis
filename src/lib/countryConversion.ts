// Empirical per-country conversion rate, grounded in the WHOLE user base (every
// signup, including free users who never started a trial) — the honest "what
// share of users from this country ever became active (paying)". This replaces
// the demographic prediction model as the per-user conversion signal on the Trial
// Retention tables: it reflects a user's MARKET rather than a global-tier lean, so
// a huge-free-base market like Jakarta reads ~0.7% (≈ overall) instead of "High".
//
// The server (country_conversion_rates RPC) stays country-agnostic and returns
// per-timezone totals; we fold timezones into countries here with the same
// getCountryFromTimezone used everywhere else.

import { supabase } from "./supabase";
import { getCountryFromTimezone } from "./timezone";
import { explainConversion } from "./conversionScore";
import baseline from "./convIndivBaseline.json";

// Per-country mean "individual log-odds" (model contributions excluding time_zone
// + intercept), used to CENTER the blended estimate so an average-demographics
// user in a country gets lift 1.0. See scripts in git history (_gen_baseline).
const BASELINE = baseline as unknown as {
  global: number;
  byCountry: Record<string, number>;
};

// How far the individual signal is allowed to move the market rate, and the hard
// cap on a blended probability (keeps sparse-feature outliers sane).
const LIFT_MIN = 0.2;
const LIFT_MAX = 5;
const BLEND_CAP = 0.98;

export interface CountryRate {
  country: string;
  total: number; // all users from this country (incl. free, never-trial)
  active: number; // ever became active (became_active_at set)
  rate: number; // active / total (0..1)
}

export interface BlendedEstimate {
  blended: number; // country rate adjusted by the user's individual signal (0..1)
  countryRate: number; // the market anchor (0..1)
  country: string;
  lift: number; // individual multiplier vs the country's average demographics
  baseline: number; // the country's mean individual log-odds used to center
}

export interface CountryConvData {
  byCountry: Map<string, CountryRate>;
  overallRate: number; // active / total across all users
  // Rate for a user, from their timezone → country. null if the country is unseen.
  rateForTimezone: (timeZone: string | null) => CountryRate | null;
  // Relative strength vs the overall rate (1 = average, 2 = twice the base …).
  relativeForTimezone: (timeZone: string | null) => number | null;
  // Blended per-user estimate: the user's country market rate, adjusted up/down by
  // their individual signal (age, level, reason, …) RELATIVE to their country's
  // average demographics. null if we have no rate for the country.
  blendedFor: (meta: Record<string, unknown>) => BlendedEstimate | null;
}

// The user's individual log-odds = sum of model contributions EXCLUDING time_zone
// (and the intercept) — the pure per-user signal, with the country effect left to
// the market anchor so it isn't double-counted.
function individualLogOdds(meta: Record<string, unknown>): number {
  const ex = explainConversion(meta);
  if (!ex) return 0;
  return ex.terms.reduce((s, t) => (t.feature === "time_zone" ? s : s + t.contribution), 0);
}

export async function fetchCountryConversionRates(): Promise<CountryConvData> {
  const { data, error } = await supabase.rpc("country_conversion_rates");
  if (error) throw new Error(error.message);

  const byCountry = new Map<string, CountryRate>();
  let totAll = 0;
  let actAll = 0;
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const country = getCountryFromTimezone(String(r.time_zone ?? "")) || "Unknown";
    const total = Number(r.total_users ?? 0);
    const active = Number(r.active_users ?? 0);
    totAll += total;
    actAll += active;
    const cur = byCountry.get(country) ?? { country, total: 0, active: 0, rate: 0 };
    cur.total += total;
    cur.active += active;
    byCountry.set(country, cur);
  }
  byCountry.forEach((c) => {
    c.rate = c.total ? c.active / c.total : 0;
  });
  const overallRate = totAll ? actAll / totAll : 0;

  const rateForTimezone = (timeZone: string | null): CountryRate | null => {
    const country = getCountryFromTimezone(timeZone ?? "") || "Unknown";
    return byCountry.get(country) ?? null;
  };

  return {
    byCountry,
    overallRate,
    rateForTimezone,
    relativeForTimezone: (timeZone) => {
      const cr = rateForTimezone(timeZone);
      if (!cr || overallRate === 0) return null;
      return cr.rate / overallRate;
    },
    blendedFor: (meta) => {
      const tz = (meta.time_zone as string) ?? null;
      const cr = rateForTimezone(tz);
      if (!cr) return null;
      const country = cr.country;
      const base = BASELINE.byCountry[country] ?? BASELINE.global;
      const rawLift = Math.exp(individualLogOdds(meta) - base);
      const lift = Math.min(LIFT_MAX, Math.max(LIFT_MIN, rawLift));
      const blended = Math.min(BLEND_CAP, cr.rate * lift);
      return { blended, countryRate: cr.rate, country, lift, baseline: base };
    },
  };
}
