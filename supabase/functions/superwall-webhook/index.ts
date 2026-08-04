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

// `user_info.user_id` is a Supabase auth uid. Anything else — Superwall's
// anonymous alias ($SuperwallAlias:…), RevenueCat's ($RCAnonymousID:…) — means
// the client never called identify(), so this event can NOT be mapped to a user.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeAuthUid(id) {
  return typeof id === "string" && UUID_RE.test(id.trim());
}

// One loud, greppable line per dropped purchase. Alert on UNMAPPED_PURCHASE.
// This is the failure that hid for two months: an .update().eq() that matches
// zero rows is NOT an error in supabase-js — it returns { error: null } — so the
// old code logged success and wrote nothing for every Android purchase made
// while Superwall identify was disabled.
function reportUnmapped(reason, ctx) {
  console.error(
    "🚨 UNMAPPED_PURCHASE",
    JSON.stringify({ reason, ...ctx })
  );
}

// Event timestamp: prefer the provider's own event time, otherwise fall back to
// receipt time, otherwise now(). Accepts ISO strings or epoch-ms numbers. Used
// to stamp both became_active_at (conversion) and became_past_due_at (billing
// issue) — in each case we want when the event actually happened.
function pickEventTimestamp(source, body, swData, rcEvent) {
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
    let idCandidates = [];
    if (body && typeof body === "object" && "api_version" in body && "event" in body) {
      // RevenueCat
      source = "revenuecat";
      rcEvent = body.event ?? {};
      rawEventType = rcEvent.type ?? null;
      // `app_user_id` is the CURRENT id; `original_app_user_id` is the first one
      // the user ever had — which for an anonymous-then-identified user is the
      // ANONYMOUS one. Aliases carry both. Prefer whichever is a real auth uid.
      idCandidates = [
        rcEvent.app_user_id,
        ...(Array.isArray(rcEvent.aliases) ? rcEvent.aliases : []),
        rcEvent.original_app_user_id
      ];
      paymentStatus = mapRevenueCatStatus(rawEventType, rcEvent);
    } else {
      // Superwall
      source = "superwall";
      swData = body.data ?? {};
      rawEventType = body.type ?? swData?.name ?? null; // usually "initial_purchase"
      // Do NOT trust a single field: the previous code read `originalAppUserId`
      // alone, and "original" may mean the pre-identify alias. Gather every
      // plausible carrier and pick the one that is actually an auth uid, so this
      // keeps working regardless of which field Superwall populates.
      idCandidates = [
        swData.appUserId,
        swData.userId,
        swData.userAttributes?.appUserId,
        swData.user?.appUserId,
        swData.user?.id,
        swData.originalAppUserId,
        ...(Array.isArray(swData.aliases) ? swData.aliases : []),
        body.appUserId
      ];
      paymentStatus = mapSuperwallStatus(rawEventType, swData);
    }
    idCandidates = idCandidates.filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
    // The auth uid wins wherever it appears; otherwise keep the first id we saw
    // purely so the unmapped report can show what the provider actually sent.
    userId = idCandidates.find(looksLikeAuthUid) ?? idCandidates[0] ?? null;
    // No id at all. If the event carries money (a recognized subscription
    // lifecycle event) this is a lost payment and must alarm. If it does not
    // (UNKNOWN — provider test pings and event types we don't map), stay quiet:
    // alarming on those is how an alert channel becomes noise and gets ignored.
    // Return 200 either way so providers don't retry endlessly.
    if (!userId) {
      const carriesMoney = paymentStatus !== "UNKNOWN";
      if (carriesMoney) {
        reportUnmapped("missing_user_id", {
          source,
          eventType: rawEventType,
          paymentStatus
        });
      } else {
        console.log("ℹ️ Webhook with no userId and no mapped status, ignoring", {
          source,
          rawEventType
        });
      }
      return new Response(JSON.stringify({
        ok: !carriesMoney,
        ignored: !carriesMoney,
        unmapped: carriesMoney,
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
    // The id must be an auth uid. An anonymous alias means identify() never ran
    // on that device, so there is nothing in user_info to match and writing is
    // pointless. Fail loudly instead of no-opping.
    if (!looksLikeAuthUid(userId)) {
      reportUnmapped("anonymous_app_user_id", {
        source,
        userId,
        // Every id the payload carried. If a real uid shows up here under a
        // field we are not reading, that is the bug — add the field above.
        idCandidates,
        eventType: rawEventType,
        paymentStatus
      });
      // 200: the provider did nothing wrong, and a retry would not help.
      return new Response(JSON.stringify({
        ok: false,
        unmapped: true,
        reason: "anonymous_app_user_id",
        source,
        userId,
        eventType: rawEventType
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    // Stamp WHEN the user hits a billing issue — but only on ENTRY into a
    // past-due spell. This runs BEFORE the status overwrite below and is guarded
    // to rows not already PAST_DUE (null counts as "not past due"), so repeated
    // billing_issue / grace_period events within one spell don't keep bumping the
    // date. It marks the first time they hit the issue, not the latest retry.
    let becamePastDueAt = null;
    if (paymentStatus === "PAST_DUE") {
      becamePastDueAt = pickEventTimestamp(source, body, swData, rcEvent);
      const { error: pdErr } = await supabase
        .from("user_info")
        .update({ became_past_due_at: becamePastDueAt })
        .eq("user_id", userId)
        .or("payment_status.is.null,payment_status.neq.PAST_DUE");
      if (pdErr) {
        // Non-fatal: the payment_status write below is what matters. Log only.
        console.error("Error stamping became_past_due_at:", pdErr);
      }
    }

    // Even if status is UNKNOWN, we still write it — so DB is the source of truth.
    // `.select("user_id")` is load-bearing: without it there is no way to tell an
    // update that hit a row from one that matched nothing — both return error: null.
    const { data: updated, error } = await supabase.from("user_info").update({
      payment_status: paymentStatus
    }).eq("user_id", userId).select("user_id");
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
    // A well-formed uid that matches no row: a real payment we cannot credit.
    if (!updated || updated.length === 0) {
      reportUnmapped("user_not_found", {
        source,
        userId,
        eventType: rawEventType,
        paymentStatus
      });
      return new Response(JSON.stringify({
        ok: false,
        unmapped: true,
        reason: "user_not_found",
        source,
        userId,
        eventType: rawEventType
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    console.log("💾 payment_status written:", {
      userId,
      paymentStatus,
      rowsUpdated: updated.length
    });
    // Stamp the FIRST time the user became paid/ACTIVE (write-once). The
    // `.is("became_active_at", null)` guard means renewals and re-subscribes
    // never overwrite the original conversion date.
    let becameActiveAt = null;
    if (paymentStatus === "ACTIVE") {
      becameActiveAt = pickEventTimestamp(source, body, swData, rcEvent);
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
      became_active_at: becameActiveAt,
      became_past_due_at: becamePastDueAt
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
