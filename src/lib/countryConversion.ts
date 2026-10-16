// Empirical conversion rate per country × PLATFORM × AGE-BUCKET, grounded in the
// WHOLE user base (every signup, including free users who never started a trial) —
// the honest "what share of users like this one (same country, platform, age)
// ever became active (paying)". This is the per-user "Conv. estimate" shown on the
// Trial Retention tables and the All Transcripts cards.
//
// All three drivers are grounded EMPIRICALLY (not the demographic model), because
// the model mis-estimates each: its platform coefficient is backwards (iOS
// converts 2-5× more at every age) and its age effect is far too weak (~2.4×
// young→old vs ~4-5× in reality). The empirical cell rate captures all three
// cleanly and lets them compound. We fall back to coarser cells (country×platform,
// then country) when a cell is too thin to trust.
//
// The server (country_conversion_rates RPC) returns per (timezone, platform, age
// bucket) totals; we fold timezones into countries here (getCountryFromTimezone).

import { supabase } from "./supabase";
import { getCountryFromTimezone } from "./timezone";

const MIN_AGE_CELL = 150; // min users to trust a country×platform×age rate
const MIN_PLAT_CELL = 200; // min users to trust a country×platform rate

export interface CountryRate {
  country: string;
  total: number; // all users (incl. free, never-trial)
  active: number; // ever became active (became_active_at set)
  rate: number; // active / total (0..1)
}

export interface BlendedEstimate {
  blended: number; // the conversion estimate for this user (0..1)
  countryRate: number; // same as blended (kept for the existing callers)
  country: string;
  platform: string; // "ios" | "android" | "" (unknown)
  ageBucket: string; // "<=24" | "25-34" | "35-49" | "50+" | "unknown"
  anchorLevel: "country+platform+age" | "country+platform" | "country";
  total: number; // sample behind the estimate
  active: number;
  lift: number; // always 1 now (kept for existing callers)
  baseline: number; // 0 (kept for existing callers)
}

export interface CountryConvData {
  byCountry: Map<string, CountryRate>; // summed over platform & age
  overallRate: number;
  rateForTimezone: (timeZone: string | null) => CountryRate | null;
  relativeForTimezone: (timeZone: string | null) => number | null;
  // Empirical conversion estimate for a user: their country×platform×age cell
  // rate, falling back to country×platform then country when a cell is thin.
  blendedFor: (meta: Record<string, unknown>) => BlendedEstimate | null;
}

const platKey = (p: unknown): string => String(p ?? "").toLowerCase();

export function ageBucket(age: unknown): string {
  const n = typeof age === "number" ? age : parseInt(String(age ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n <= 24) return "<=24";
  if (n <= 34) return "25-34";
  if (n <= 49) return "35-49";
  return "50+";
}

function withRate(c: CountryRate): CountryRate {
  c.rate = c.total ? c.active / c.total : 0;
  return c;
}
function bump(m: Map<string, CountryRate>, key: string, country: string, total: number, active: number) {
  const cur = m.get(key) ?? { country, total: 0, active: 0, rate: 0 };
  cur.total += total;
  cur.active += active;
  m.set(key, cur);
}

export async function fetchCountryConversionRates(): Promise<CountryConvData> {
  // The RPC returns one row per (timezone × platform × age bucket) — more than
  // PostgREST's 1000-row response cap — so page through it (ordered in the RPC for
  // stable pagination) instead of silently truncating to the first 1000.
  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .rpc("country_conversion_rates")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  const byCountry = new Map<string, CountryRate>();
  const byCell2 = new Map<string, CountryRate>(); // country|platform
  const byCell3 = new Map<string, CountryRate>(); // country|platform|ageBucket
  let totAll = 0;
  let actAll = 0;
  for (const r of rows) {
    const country = getCountryFromTimezone(String(r.time_zone ?? "")) || "Unknown";
    const plat = platKey(r.platform);
    const bucket = String(r.age_bucket ?? "unknown");
    const total = Number(r.total_users ?? 0);
    const active = Number(r.active_users ?? 0);
    totAll += total;
    actAll += active;
    bump(byCountry, country, country, total, active);
    bump(byCell2, `${country}|${plat}`, country, total, active);
    bump(byCell3, `${country}|${plat}|${bucket}`, country, total, active);
  }
  byCountry.forEach(withRate);
  byCell2.forEach(withRate);
  byCell3.forEach(withRate);
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
      const country = getCountryFromTimezone((meta.time_zone as string) ?? "") || "Unknown";
      const countryRate = byCountry.get(country);
      if (!countryRate) return null;
      const plat = platKey(meta.platform);
      const bucket = ageBucket(meta.age);

      // Finest reliable cell wins: country×platform×age → country×platform → country.
      const cell3 = byCell3.get(`${country}|${plat}|${bucket}`);
      const cell2 = byCell2.get(`${country}|${plat}`);
      let chosen: CountryRate;
      let anchorLevel: BlendedEstimate["anchorLevel"];
      if (cell3 && cell3.total >= MIN_AGE_CELL) {
        chosen = cell3;
        anchorLevel = "country+platform+age";
      } else if (cell2 && cell2.total >= MIN_PLAT_CELL) {
        chosen = cell2;
        anchorLevel = "country+platform";
      } else {
        chosen = countryRate;
        anchorLevel = "country";
      }
      return {
        blended: chosen.rate,
        countryRate: chosen.rate,
        country,
        platform: plat,
        ageBucket: bucket,
        anchorLevel,
        total: chosen.total,
        active: chosen.active,
        lift: 1,
        baseline: 0,
      };
    },
  };
}
