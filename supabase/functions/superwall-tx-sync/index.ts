// supabase/functions/superwall-tx-sync/index.ts
//
// Keeps subscription_transactions current: re-pulls every Superwall
// transaction since 2026-03-01 from Superwall's ClickHouse and upserts it via
// sync_subscription_transactions() (supabase/sql/subscription_sync.sql).
// Called every 3 hours by pg_cron ('superwall-tx-sync').
//
// Each row carries Superwall's attribution of the purchase: the paywall (id and
// name), the placement that showed it, and the campaign audience ("experiment")
// and variant. The audience names live in superwall_audiences, which this also
// refreshes from Superwall's campaign list — but only when the API key has the
// campaigns:read scope; without it the refresh is skipped (logged in
// subscription_sync_runs.audience_error) and the transaction sync still runs.
//
// It also pulls Superwall's billing_issue events (failed renewal / trial-end
// charges) into subscription_billing_issues via
// sync_subscription_billing_issues(). That pull is non-fatal too
// (subscription_sync_runs.billing_issue_error).
//
// Secrets: SUPERWALL_API_KEY — an organization API key with the data:read scope
// (plus campaigns:read for the audience names).
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
// real auth uid over an anonymous alias for the user. The attribution comes
// from whichever copy has one (store copy first). Paywall names aren't on the
// integration rows, so they're read off the SDK's transaction_complete rows
// (latest name per paywall, all time — a renewal can point at a 2025 paywall).
// Column order must match sync_subscription_transactions().
const SQL = `
WITH r AS (
 SELECT transactionId, originalTransactionId, appUserId, applicationId, integration,
  replaceRegexpOne(coalesce(productId,''), ':sw-auto$', '') prod, periodType, isTrialConversion, price, proceeds,
  currencyCode, priceInPurchasedCurrency, countryCode, purchasedAt,
  coalesce(paywallId, 0) pwid, coalesce(experimentId, 0) expid, coalesce(variantId, 0) varid, coalesce(placement, '') plcm,
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
  argMin(coalesce(countryCode,''), pri) cc, min(purchasedAt) ts, argMin(integration, pri) integ,
  argMinIf(pwid, pri, pwid != 0) pw, argMinIf(plcm, pri, pwid != 0) plc,
  argMinIf(expid, pri, pwid != 0) ex, argMinIf(varid, pri, pwid != 0) vr
 FROM r WHERE ev != '' GROUP BY tx, ev),
n AS (
 SELECT assumeNotNull(paywallId) pid, argMax(JSONExtractString(props, '$paywall_name'), ts) nm
 FROM open_revenue.attributed_events_by_ts_rep
 WHERE applicationId IN (7959,7960) AND isSandbox=0 AND name='transaction_complete' AND paywallId IS NOT NULL
 GROUP BY pid)
SELECT tx, ev, if(otx=tx,'',coalesce(otx,'')), coalesce(uid,''), p, prod, pt, toString(conv),
  toString(coalesce(price,0)), toString(coalesce(proceeds,0)), cur, toString(coalesce(loc,0)), cc,
  toString(toUnixTimestamp(ts)), multiIf(integ='app_store_connect','asc',integ='google_play','gp','rc'),
  toString(pw), nm, plc, toString(ex), toString(vr)
FROM d LEFT JOIN n ON n.pid = d.pw ORDER BY ts, tx, ev`;

// One row per store transaction that hit a billing issue (the store and
// revenue_cat each send a copy, hours apart): the store copy wins, the earliest
// report is the time. Column order must match sync_subscription_billing_issues().
const BILLING_SQL = `
WITH r AS (
 SELECT transactionId, originalTransactionId, appUserId, applicationId, integration,
  replaceRegexpOne(coalesce(productId,''), ':sw-auto$', '') prod, periodType, countryCode, ts,
  if(integration='revenue_cat',1,0) pri,
  match(coalesce(appUserId,''), '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') isu
 FROM open_revenue.attributed_events_by_ts_rep
 WHERE applicationId IN (7959,7960) AND isSandbox=0 AND integration IS NOT NULL
   AND name='billing_issue' AND ts >= '2026-03-01' AND coalesce(transactionId,'') != ''),
d AS (
 SELECT transactionId tx,
  argMin(originalTransactionId, pri) otx,
  if(countIf(isu=1) > 0, argMinIf(appUserId, pri, isu=1), argMin(coalesce(appUserId,''), (coalesce(appUserId,'')='', pri))) uid,
  argMin(if(applicationId=7959,'i','a'), pri) p, argMin(prod, pri) prod,
  argMin(coalesce(periodType,''), pri) pt, argMin(coalesce(countryCode,''), pri) cc,
  min(ts) t, argMin(integration, pri) integ
 FROM r GROUP BY tx)
SELECT tx, if(otx=tx,'',coalesce(otx,'')), coalesce(uid,''), p, prod, pt, cc,
  toString(toUnixTimestamp(t)), multiIf(integ='app_store_connect','asc',integ='google_play','gp','rc')
FROM d ORDER BY t, tx`;

async function syncBillingIssues(): Promise<number> {
  const res = await fetch(
    `https://api.superwall.com/v2/organizations/${SUPERWALL_ORG_ID}/query?default_format=JSONCompact`,
    { method: "POST", headers: { Authorization: `Bearer ${SUPERWALL_API_KEY}` }, body: BILLING_SQL },
  );
  if (!res.ok) throw new Error(`Superwall query ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rows: string[][] = (await res.json()).data ?? [];
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { data, error } = await supabase.rpc("sync_subscription_billing_issues", { p_rows: rows.slice(i, i + CHUNK) });
    if (error) throw new Error(`billing issue upsert: ${error.message}`);
    upserted += data ?? 0;
  }
  return upserted;
}

const APPS: Record<string, string> = { "7959": "ios", "7960": "android" };

// Every campaign audience (live and archived campaigns) → superwall_audiences.
// Throws if the key lacks campaigns:read; the caller treats that as non-fatal.
async function syncAudiences(): Promise<number> {
  const rows: (string | number | boolean)[][] = [];
  for (const [appId, platform] of Object.entries(APPS)) {
    for (const archived of ["false", "true"]) {
      let after = "";
      for (let page = 0; page < 10; page++) {
        const url = `https://api.superwall.com/v2/campaigns?application_id=${appId}&archived=${archived}&limit=100` +
          (after ? `&starting_after=${after}` : "");
        const res = await fetch(url, { headers: { Authorization: `Bearer ${SUPERWALL_API_KEY}` } });
        if (!res.ok) throw new Error(`Superwall campaigns ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const body = await res.json();
        const campaigns = body.data ?? [];
        for (const c of campaigns) {
          for (const a of c.audiences ?? []) {
            rows.push([a.id, platform, c.id, c.description ?? "", a.description ?? "", !!c.archived]);
          }
        }
        if (!body.has_more || campaigns.length === 0) break;
        after = campaigns[campaigns.length - 1].id;
      }
    }
  }
  if (rows.length === 0) return 0;
  const { data, error } = await supabase.rpc("sync_superwall_audiences", { p_rows: rows });
  if (error) throw new Error(`audience upsert: ${error.message}`);
  return data ?? 0;
}

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

    // Audience names are a nice-to-have on top of the transactions.
    let audiences_upserted: number | null = null;
    let audience_error: string | null = null;
    try {
      audiences_upserted = await syncAudiences();
    } catch (e) {
      audience_error = e instanceof Error ? e.message : String(e);
      console.warn("audience refresh skipped:", audience_error);
    }

    let billing_issues_upserted: number | null = null;
    let billing_issue_error: string | null = null;
    try {
      billing_issues_upserted = await syncBillingIssues();
    } catch (e) {
      billing_issue_error = e instanceof Error ? e.message : String(e);
      console.warn("billing issue sync failed:", billing_issue_error);
    }

    const result = {
      audiences_upserted,
      audience_error,
      billing_issues_upserted,
      billing_issue_error,
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
