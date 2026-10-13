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

export interface CountryRate {
  country: string;
  total: number; // all users from this country (incl. free, never-trial)
  active: number; // ever became active (became_active_at set)
  rate: number; // active / total (0..1)
}

export interface CountryConvData {
  byCountry: Map<string, CountryRate>;
  overallRate: number; // active / total across all users
  // Rate for a user, from their timezone → country. null if the country is unseen.
  rateForTimezone: (timeZone: string | null) => CountryRate | null;
  // Relative strength vs the overall rate (1 = average, 2 = twice the base …).
  relativeForTimezone: (timeZone: string | null) => number | null;
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
  };
}
