import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, "..", ".env"), "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    let v = l.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return [l.slice(0, i).trim(), v];
  }),
);
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const candidates = [
  "subscriptions", "user_subscriptions", "payments", "payment_history",
  "subscription_events", "revenuecat_events", "transactions",
  "active_user_daily", "user_status_history", "definitely_not_a_real_table_xyz",
];
console.log("── Table probe (real row fetch) ──");
for (const t of candidates) {
  const { data, error } = await supabase.from(t).select("*").limit(1);
  if (error) console.log(`  ✗ ${t}: ${error.message}`);
  else console.log(`  ✓ ${t}: exists, sample keys = ${data?.[0] ? Object.keys(data[0]).join(",") : "(empty)"}`);
}
