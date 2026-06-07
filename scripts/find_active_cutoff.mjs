import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, "..", ".env"), "utf8");
const env = Object.fromEntries(
  envText
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      const k = l.slice(0, i).trim();
      let v = l.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return [k, v];
    }),
);

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 1) Inspect one ACTIVE row to see what date columns exist
const { data: sample, error: sErr } = await supabase
  .from("user_info")
  .select("*")
  .eq("payment_status", "ACTIVE")
  .limit(1);
if (sErr) throw sErr;
console.log("ACTIVE row columns:", Object.keys(sample[0] ?? {}));
console.log("Sample row:", sample[0]);

// 2) Earliest ACTIVE user by last_logged_in (asc), excluding nulls
const { data: byLogin, error: e1 } = await supabase
  .from("user_info")
  .select("id, user_id, last_logged_in, payment_status")
  .eq("payment_status", "ACTIVE")
  .not("last_logged_in", "is", null)
  .order("last_logged_in", { ascending: true })
  .limit(5);
if (e1) throw e1;
console.log("\nEarliest ACTIVE users by last_logged_in:");
console.log(byLogin);

// 3) Earliest ACTIVE user by id (asc)
const { data: byId, error: e2 } = await supabase
  .from("user_info")
  .select("id, user_id, last_logged_in, payment_status")
  .eq("payment_status", "ACTIVE")
  .order("id", { ascending: true })
  .limit(5);
if (e2) throw e2;
console.log("\nEarliest ACTIVE users by id:");
console.log(byId);

// 4) If there's a created_at column, get earliest by that too
if (sample[0] && "created_at" in sample[0]) {
  const { data: byCreated, error: e3 } = await supabase
    .from("user_info")
    .select("id, user_id, created_at, last_logged_in, payment_status")
    .eq("payment_status", "ACTIVE")
    .not("created_at", "is", null)
    .order("created_at", { ascending: true })
    .limit(5);
  if (e3) throw e3;
  console.log("\nEarliest ACTIVE users by created_at:");
  console.log(byCreated);
}

// 5) Totals
const { count: activeCount } = await supabase
  .from("user_info")
  .select("id", { count: "exact", head: true })
  .eq("payment_status", "ACTIVE");
const { count: totalCount } = await supabase
  .from("user_info")
  .select("id", { count: "exact", head: true });
console.log(`\nTotals — ACTIVE: ${activeCount}, all rows: ${totalCount}`);
