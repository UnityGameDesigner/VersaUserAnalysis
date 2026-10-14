// Empirical conversion rate per country × PLATFORM, grounded in the WHOLE user
// base (every signup, including free users who never started a trial) — the honest
// "what share of users from this country/platform ever became active (paying)".
// This is the market anchor for the per-user "Conv. estimate" on the Trial
// Retention tables: a huge-free-base market like Jakarta reads ~0.7%, and iOS vs
// Android is grounded in reality (iOS converts 2-5× more within a market — the
// demographic model gets that DIRECTION wrong, so platform is anchored here, not
// taken from the model coefficient).
//
// The server (country_conversion_rates RPC) returns per (timezone, platform)
// totals; we fold timezones into countries here (getCountryFromTimezone).

import { supabase } from "./supabase";
import { getCountryFromTimezone } from "./timezone";
import { explainConversion } from "./conversionScore";
import baseline from "./convIndivBaseline.json";

// Per-country(×platform) mean "individual log-odds" — model contributions
// EXCLUDING time_zone AND platform (both grounded in the anchor) + intercept —
// used to CENTER the blend so an average user in a country/platform gets lift 1.0.
const BASELINE = baseline as unknown as {
  global: number;
  byCountry: Record<string, number>;
  byCountryPlatform: Record<string, number>;
};

const LIFT_MIN = 0.2; // how far the individual signal can move the market rate
const LIFT_MAX = 5;
const BLEND_CAP = 0.98; // hard cap on a blended probability
const MIN_CELL_USERS = 200; // min users to trust a country×platform rate; else fall back to country

// The individual lift uses ONLY these genuinely-personal learner signals. Country
// & platform (and their proxies: native_language, messaging_platform, attribution,
// tutor…) are grounded empirically in the anchor, not the model — the model's
// platform coefficient is backwards (gives Android a boost though iOS converts
// 2-2.5× more at every age), so trusting it would double-count AND flip the sign.
const LIFT_INCLUDE = new Set(["age", "level", "reason"]);

export interface CountryRate {
  country: string;
  total: number; // all users (incl. free, never-trial)
  active: number; // ever became active (became_active_at set)
  rate: number; // active / total (0..1)
}

export interface BlendedEstimate {
  blended: number; // anchor adjusted by the user's individual signal (0..1)
  countryRate: number; // the market anchor used (0..1)
  country: string;
  platform: string; // "ios" | "android" | "none" — which anchor cell
  anchorLevel: "country+platform" | "country"; // granularity of the anchor used
  lift: number; // individual multiplier vs the anchor cell's average demographics
  baseline: number; // mean individual log-odds used to center
}

export interface CountryConvData {
  byCountry: Map<string, CountryRate>; // summed over platforms
  overallRate: number;
  rateForTimezone: (timeZone: string | null) => CountryRate | null;
  relativeForTimezone: (timeZone: string | null) => number | null;
  // Blended per-user estimate: the user's country×platform market rate, adjusted
  // up/down by their individual signal (age, level, reason…) vs that cell's norm.
  blendedFor: (meta: Record<string, unknown>) => BlendedEstimate | null;
}

// Individual log-odds = sum of model contributions for the clean learner signals
// only (age, level, reason) — the per-user deviation the lift adjusts for.
function individualLogOdds(meta: Record<string, unknown>): number {
  const ex = explainConversion(meta);
  if (!ex) return 0;
  return ex.terms.reduce((s, t) => (LIFT_INCLUDE.has(t.feature) ? s + t.contribution : s), 0);
}

const platKey = (p: unknown): string => String(p ?? "").toLowerCase() || "none";

export async function fetchCountryConversionRates(): Promise<CountryConvData> {
  const { data, error } = await supabase.rpc("country_conversion_rates");
  if (error) throw new Error(error.message);

  const byCountry = new Map<string, CountryRate>();
  const byCell = new Map<string, CountryRate>(); // "country|platform" → rate
  let totAll = 0;
  let actAll = 0;
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const country = getCountryFromTimezone(String(r.time_zone ?? "")) || "Unknown";
    const plat = platKey(r.platform);
    const total = Number(r.total_users ?? 0);
    const active = Number(r.active_users ?? 0);
    totAll += total;
    actAll += active;
    const cur = byCountry.get(country) ?? { country, total: 0, active: 0, rate: 0 };
    cur.total += total;
    cur.active += active;
    byCountry.set(country, cur);
    const ck = `${country}|${plat}`;
    const cell = byCell.get(ck) ?? { country, total: 0, active: 0, rate: 0 };
    cell.total += total;
    cell.active += active;
    byCell.set(ck, cell);
  }
  byCountry.forEach((c) => { c.rate = c.total ? c.active / c.total : 0; });
  byCell.forEach((c) => { c.rate = c.total ? c.active / c.total : 0; });
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
      const cr = rateForTimezone((meta.time_zone as string) ?? null);
      if (!cr) return null;
      const country = cr.country;
      const plat = platKey(meta.platform);
      const ck = `${country}|${plat}`;

      // Prefer the country×platform cell when it has a real sample and a baseline;
      // otherwise fall back to the country level (keeps anchor + centering aligned).
      const cell = byCell.get(ck);
      const cellBase = BASELINE.byCountryPlatform[ck];
      const useCell = !!cell && cell.total >= MIN_CELL_USERS && cellBase != null;

      const anchorRate = useCell ? cell!.rate : cr.rate;
      const base = useCell ? cellBase : BASELINE.byCountry[country] ?? BASELINE.global;

      const rawLift = Math.exp(individualLogOdds(meta) - base);
      const lift = Math.min(LIFT_MAX, Math.max(LIFT_MIN, rawLift));
      const blended = Math.min(BLEND_CAP, anchorRate * lift);
      return {
        blended,
        countryRate: anchorRate,
        country,
        platform: plat,
        anchorLevel: useCell ? "country+platform" : "country",
        lift,
        baseline: base,
      };
    },
  };
}
