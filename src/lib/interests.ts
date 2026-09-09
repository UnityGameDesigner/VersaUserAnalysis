// Learner interests, collected during onboarding into the user_interests table
// (user_id, interest_key). Only ~the recent onboarding cohorts have any, so most
// users return an empty list. interest_key is already human-ish ("travel",
// "social_media"); prettyInterest just tidies it for display.

import { supabase } from "./supabase";

export function prettyInterest(key: string): string {
  const s = (key ?? "").replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// Fetch interests for a set of users → Map<user_id, interest_key[]> (insertion
// order). Non-fatal: returns an empty map on error.
export async function fetchInterests(userIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (userIds.length === 0) return map;
  const { data, error } = await supabase
    .from("user_interests")
    .select("user_id, interest_key")
    .in("user_id", userIds)
    .order("created_at");
  if (error || !data) return map;
  for (const row of data as { user_id: string; interest_key: string }[]) {
    const arr = map.get(row.user_id);
    if (arr) arr.push(row.interest_key);
    else map.set(row.user_id, [row.interest_key]);
  }
  return map;
}
