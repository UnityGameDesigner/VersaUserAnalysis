// supabase/functions/superwall-tx-sync/index.ts
//
// Keeps subscription_transactions current: re-pulls every Superwall
// transaction since 2026-03-01 from Superwall's ClickHouse and upserts it via
// sync_subscription_transactions() (supabase/sql/subscription_sync.sql).
// Called every 3 hours by pg_cron ('superwall-tx-sync').
//
// Secrets: SUPERWALL_API_KEY — an organization API key with the data:read scope.
// verify_jwt is off (pg_cron calls it with no JWT); a 20-minute throttle on
// subscription_sync_runs keeps the public URL from being used to spam Superwall.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPERWALL_API_KEY = Deno.env.get("SUPERWALL_API_KEY");
const SUPERWALL_ORG_ID = "4691"; // Versa; apps 7959 = iOS, 7960 = Android
const MIN_INTERVAL_MS = 20 * 60 * 1000;
const CHUNK = 1000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Same dedupe as the original backfill: one row per (transactionId, event),
// preferring the store integration's copy over revenue_cat's, and preferring a
// real auth uid over an anonymous alias for the user. Column order must match
// sync_subscription_transactions().
const SQL = `
WITH r AS (
 SELECT transactionId, originalTransactionId, appUserId, applicationId, integration,
  replaceRegexpOne(coalesce(productId,''), ':sw-auto$', '') prod, periodType, isTrialConversion, price, proceeds,
  currencyCode, priceInPurchasedCurrency, countryCode, purchasedAt,
  multiIf(name='initial_purchase' AND periodType='TRIAL' AND price=0, 'trial_start',
          name='cancellation' AND price<0, 'refund',
          name IN ('initial_purchase','renewal','non_renewing_purchase') AND price>0, name, '') ev,
  if(integration='revenue_cat',1,0) pri,
  match(coalesce(appUserId,''), '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') isu
 FROM open_revenue.attributed_events_by_ts_rep
 WHERE applicationId IN (7959,7960) AND isSandbox=0 AND integration IS NOT NULL
   AND purchasedAt >= '2026-03-01' AND coalesce(transactionId,'') != ''),
d AS (
 SELECT transactionId tx, ev,
  argMin(originalTransactionId, pri) otx,
  if(countIf(isu=1) > 0, argMinIf(appUserId, pri, isu=1), argMin(coalesce(appUserId,''), (coalesce(appUserId,'')='', pri))) uid,
  argMin(if(applicationId=7959,'i','a'), pri) p, argMin(prod, pri) prod,
  argMin(coalesce(periodType,''), pri) pt, argMin(isTrialConversion, pri) conv,
  argMin(price, pri) price, argMin(proceeds, pri) proceeds,
  argMin(coalesce(currencyCode,''), pri) cur, argMin(priceInPurchasedCurrency, pri) loc,
  argMin(coalesce(countryCode,''), pri) cc, min(purchasedAt) ts, argMin(integration, pri) integ
 FROM r WHERE ev != '' GROUP BY tx, ev)
SELECT tx, ev, if(otx=tx,'',coalesce(otx,'')), coalesce(uid,''), p, prod, pt, toString(conv),
  toString(coalesce(price,0)), toString(coalesce(proceeds,0)), cur, toString(coalesce(loc,0)), cc,
  toString(toUnixTimestamp(ts)), multiIf(integ='app_store_connect','asc',integ='google_play','gp','rc')
FROM d ORDER BY ts, tx, ev`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async () => {
  if (!SUPERWALL_API_KEY) return json({ error: "SUPERWALL_API_KEY is not set" }, 500);

  const { data: last } = await supabase
    .from("subscription_sync_runs").select("started_at")
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - new Date(last.started_at).getTime() < MIN_INTERVAL_MS) {
    return json({ skipped: "ran less than 20 minutes ago", last_started_at: last.started_at }, 429);
  }

  const { data: run, error: runErr } = await supabase
    .from("subscription_sync_runs").insert({}).select("id").single();
  if (runErr) return json({ error: runErr.message }, 500);

  const finish = (fields: Record<string, unknown>) =>
    supabase.from("subscription_sync_runs").update({ finished_at: new Date().toISOString(), ...fields }).eq("id", run.id);

  try {
    const res = await fetch(
      `https://api.superwall.com/v2/organizations/${SUPERWALL_ORG_ID}/query?default_format=JSONCompact`,
      { method: "POST", headers: { Authorization: `Bearer ${SUPERWALL_API_KEY}` }, body: SQL },
    );
    if (!res.ok) throw new Error(`Superwall query ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const rows: string[][] = (await res.json()).data ?? [];
    // An empty result would mean something upstream broke, not that nobody paid.
    if (rows.length === 0) throw new Error("Superwall returned 0 transactions");

    let upserted = 0;
    let newest: string | null = null;
    const unknown = new Set<string>();
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { data, error } = await supabase.rpc("sync_subscription_transactions", { p_rows: rows.slice(i, i + CHUNK) });
      if (error) throw new Error(`upsert: ${error.message}`);
      upserted += data.upserted;
      if (data.newest_purchase && (!newest || data.newest_purchase > newest)) newest = data.newest_purchase;
      for (const p of data.unknown_products ?? []) unknown.add(p);
    }

    const result = {
      rows_received: rows.length,
      rows_upserted: upserted,
      newest_purchase: newest,
      unknown_products: unknown.size ? [...unknown] : null,
    };
    await finish(result);
    return json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("superwall-tx-sync failed:", message);
    await finish({ error: message });
    return json({ error: message }, 502);
  }
});
