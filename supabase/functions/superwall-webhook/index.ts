// supabase/functions/superwall-webhook/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function mapSuperwallStatus(eventType, data) {
  if (!eventType) return "UNKNOWN";
  const periodType = data?.periodType ?? null; // e.g. "TRIAL" | "NORMAL" | ...
  switch (eventType) {
    case "initial_purchase":
    case "renewal":
      {
        // Trial vs paid
        if (periodType === "TRIAL") {
          return "TRIAL";
        }
        return "ACTIVE";
      }
    case "billing_issue":
    case "grace_period":
      return "PAST_DUE";
    case "cancellation":
    case "expiration":
    case "refund":
      return "CANCELED";
    default:
      return "UNKNOWN";
  }
}

function mapRevenueCatStatus(rcType, rcEvent) {
  if (!rcType) return "UNKNOWN";
  const type = rcType.toUpperCase();
  const periodType = rcEvent?.period_type ?? null; // "TRIAL" | "NORMAL" | etc.
  switch (type) {
    // Trial-related
    case "TRIAL_STARTED":
    case "INITIAL_TRIAL_PURCHASE":
      return "TRIAL";
    case "INITIAL_PURCHASE":
    case "RENEWAL":
      {
        if (periodType === "TRIAL") {
          return "TRIAL";
        }
        return "ACTIVE";
      }
    case "TRIAL_CONVERTED":
    case "PRODUCT_CHANGE":
    case "PROMOTIONAL_RENEWAL":
    case "UNCANCELLATION":
      return "ACTIVE";
    case "BILLING_ISSUE":
    case "GRACE_PERIOD":
      return "PAST_DUE";
    case "CANCELLATION":
    case "EXPIRATION":
      return "CANCELED";
    // Test / unknown / other events
    default:
      return "UNKNOWN";
  }
}

// First-conversion timestamp: prefer the provider's own event time, otherwise
// fall back to receipt time. Accepts ISO strings or epoch-ms numbers.
function pickConversionTimestamp(source, body, swData, rcEvent) {
  try {
    if (source === "revenuecat") {
      const ms = rcEvent?.event_timestamp_ms ?? rcEvent?.purchased_at_ms ?? null;
      if (typeof ms === "number" && ms > 0) return new Date(ms).toISOString();
    } else {
      // Superwall — confirm the actual field against a real payload (see the
      // "Raw webhook payload" log). These are the common candidates; if none
      // match it safely falls back to now().
      const cand =
        swData?.transactionAt ??
        swData?.purchasedAt ??
        swData?.purchaseDate ??
        swData?.createdAt ??
        body?.createdAt ??
        null;
      if (cand != null) {
        const d = new Date(cand);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
    }
  } catch (_) {
    // fall through to receipt time
  }
  return new Date().toISOString();
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-superwall-signature",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }
  try {
    const body = await req.json();
    console.log("🚀 Raw webhook payload:", JSON.stringify(body));
    let userId = null;
    let rawEventType = null;
    let paymentStatus = "UNKNOWN";
    let source = "unknown";
    let swData = null;
    let rcEvent = null;
    // --------------------------------------------------------
    // Detect RevenueCat vs Superwall by shape
    // --------------------------------------------------------
    if (body && typeof body === "object" && "api_version" in body && "event" in body) {
      // RevenueCat
      source = "revenuecat";
      rcEvent = body.event ?? {};
      rawEventType = rcEvent.type ?? null;
      userId = rcEvent.app_user_id ?? null;
      paymentStatus = mapRevenueCatStatus(rawEventType, rcEvent);
    } else {
      // Superwall
      source = "superwall";
      swData = body.data ?? {};
      rawEventType = body.type ?? swData?.name ?? null; // usually "initial_purchase"
      userId = swData.originalAppUserId ?? swData.userAttributes?.appUserId ?? null;
      paymentStatus = mapSuperwallStatus(rawEventType, swData);
    }
    // If we have no userId, we can't map this to user_info.
    // Return 200 so providers don't retry endlessly.
    if (!userId) {
      console.log("ℹ️ Webhook with no userId, ignoring", {
        source,
        rawEventType
      });
      return new Response(JSON.stringify({
        ok: true,
        ignored: true,
        reason: "missing_user_id",
        source,
        eventType: rawEventType
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    console.log("✅ Parsed webhook:", {
      source,
      userId,
      rawEventType,
      paymentStatus
    });
    // Even if status is UNKNOWN, we still write it — so DB is the source of truth.
    const { error } = await supabase.from("user_info").update({
      payment_status: paymentStatus
    }).eq("user_id", userId); // change to .eq("id", userId) if your PK is numeric
    if (error) {
      console.error("Error updating payment_status:", error);
      return new Response(JSON.stringify({
        ok: false,
        error: "Database update failed",
        details: error.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // Stamp the FIRST time the user became paid/ACTIVE (write-once). The
    // `.is("became_active_at", null)` guard means renewals and re-subscribes
    // never overwrite the original conversion date.
    let becameActiveAt = null;
    if (paymentStatus === "ACTIVE") {
      becameActiveAt = pickConversionTimestamp(source, body, swData, rcEvent);
      const { error: convErr } = await supabase.from("user_info").update({
        became_active_at: becameActiveAt
      }).eq("user_id", userId).is("became_active_at", null);
      if (convErr) {
        // Non-fatal: payment_status is already updated. Log and continue.
        console.error("Error stamping became_active_at:", convErr);
      } else {
        console.log("🟢 became_active_at stamp (applies only if it was null):", {
          userId,
          becameActiveAt
        });
      }
    }
    return new Response(JSON.stringify({
      ok: true,
      source,
      userId,
      eventType: rawEventType,
      payment_status: paymentStatus,
      became_active_at: becameActiveAt
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    console.error("Unexpected error in webhook:", err);
    return new Response(JSON.stringify({
      ok: false,
      error: "Unexpected server error"
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});
