// Pulls user_info + completed_lessons from Supabase, applies the
// 2025-11-11 labeling cutoff, computes per-user features, and writes a CSV.
//
// Cohort filter: last_logged_in >= 2025-11-11 OR payment_status = 'ACTIVE'
//   - Rationale: ACTIVE labels weren't applied before mid-Nov 2025, so users
//     who churned earlier than that are unreliable negatives. We keep them
//     out of the training set, but we still keep every confirmed positive.
//
// Label: is_active = 1 if payment_status='ACTIVE' else 0
//
// FEATURE PHILOSOPHY: anything that's a downstream *consequence* of having
// paid (full-history lesson counts, demand_tier, lesson_credits, daily_streak,
// left_review, etc.) is excluded — those would leak the label. Engagement
// features are computed only over a first-7d window starting from the user's
// first completed lesson.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const CUTOFF_DATE = "2025-11-11";
const PAGE_SIZE = 1000;
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const OUTPUT_PATH = "scripts/features.csv";

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

// ── timezone → country (compact, just the buckets we care about) ──
const TZ_REGION = (tz) => {
  if (!tz) return null;
  const region = tz.split("/")[0];
  return region || null;
};

// ── 1. Pull cohort from user_info ────────────────────────────────
async function fetchCohort() {
  // last_logged_in is pulled only for the cohort filter, then dropped from output.
  const cols = [
    "id",
    "user_id",
    "age",
    "gender",
    "native_language",
    "reason",
    "level",
    "last_logged_in",
    "time_zone",
    "completed_tutorial",
    "main_lesson_id",
    "phone_number",
    "attribution",
    "is_creator",
    "tutor",
    "tutor_accent",
    "payment_status",
    "previous_experience",
    "messaging_platform",
    "learning_language",
    "initial_freemodal_seen",
  ].join(",");

  const rows = [];
  let lastId = 0;
  let hasMore = true;
  // OR filter: last_logged_in >= CUTOFF OR payment_status = 'ACTIVE'
  const orExpr = `last_logged_in.gte.${CUTOFF_DATE},payment_status.eq.ACTIVE`;
  while (hasMore) {
    const { data, error } = await supabase
      .from("user_info")
      .select(cols)
      .or(orExpr)
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw error;
    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }
    rows.push(...data);
    lastId = data[data.length - 1].id;
    hasMore = data.length === PAGE_SIZE;
    if (rows.length % 5000 === 0 || !hasMore) {
      console.log(`  fetched ${rows.length} user_info rows…`);
    }
  }
  return rows;
}

// ── 2. Pull all lessons for cohort, then aggregate within first-7d window ──
async function fetchFirstWindowAggregates(userIds) {
  const idSet = new Set(userIds);
  // Map<user_id, Array<{ts, rating, endedEarly, lessonId}>>
  const lessons = new Map();

  let lastId = 0;
  let hasMore = true;
  let pulled = 0;
  while (hasMore) {
    const { data, error } = await supabase
      .from("completed_lessons")
      .select("id, user_id, lesson_id, created_at, user_rating_feedback, ended_early")
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw error;
    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }
    for (const row of data) {
      if (!idSet.has(row.user_id)) continue;
      const ts = row.created_at ? Date.parse(row.created_at) : NaN;
      if (Number.isNaN(ts)) continue;
      const rating = typeof row.user_rating_feedback === "number"
        ? row.user_rating_feedback
        : Number(row.user_rating_feedback);
      let arr = lessons.get(row.user_id);
      if (!arr) {
        arr = [];
        lessons.set(row.user_id, arr);
      }
      arr.push({
        ts,
        rating: Number.isFinite(rating) ? rating : null,
        endedEarly: row.ended_early === true,
        lessonId: row.lesson_id,
      });
    }
    lastId = data[data.length - 1].id;
    pulled += data.length;
    hasMore = data.length === PAGE_SIZE;
    if (pulled % 20000 === 0 || !hasMore) {
      console.log(`  scanned ${pulled} completed_lessons rows, ${lessons.size} users matched…`);
    }
  }

  // Compute first-7d window aggregates per user.
  const agg = new Map();
  for (const [uid, arr] of lessons) {
    let firstTs = Infinity;
    for (const l of arr) if (l.ts < firstTs) firstTs = l.ts;
    if (!Number.isFinite(firstTs)) continue;
    const cutoff = firstTs + WINDOW_MS;
    let count = 0;
    let ratingSum = 0;
    let ratingCount = 0;
    let endedEarly = 0;
    const distinct = new Set();
    for (const l of arr) {
      if (l.ts > cutoff) continue;
      count++;
      if (l.rating != null) {
        ratingSum += l.rating;
        ratingCount++;
      }
      if (l.endedEarly) endedEarly++;
      if (l.lessonId != null) distinct.add(l.lessonId);
    }
    agg.set(uid, {
      first_7d_lessons: count,
      first_7d_avg_rating: ratingCount > 0 ? ratingSum / ratingCount : null,
      first_7d_pct_ended_early: count > 0 ? endedEarly / count : null,
      first_7d_distinct_lessons: distinct.size,
      first_lesson_ts: firstTs,
    });
  }
  return agg;
}

// ── 3. Combine + write CSV ──────────────────────────────────────
function csvEscape(v) {
  if (v == null) return "";
  // Strip embedded newlines so the CSV is one logical row per line —
  // friendlier to `wc -l` / `awk` / line-based tooling.
  const s = String(v).replace(/[\r\n]+/g, " ");
  if (s.includes(",") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildRow(user, windowAgg) {
  const a = windowAgg.get(user.user_id);
  const hadAnyLesson = a ? 1 : 0;
  return {
    // identifiers (not features)
    user_id: user.user_id,
    id: user.id,
    // label + ground truth (drop payment_status before training)
    is_active: user.payment_status === "ACTIVE" ? 1 : 0,
    payment_status: user.payment_status,
    // static profile features
    age: user.age,
    gender: user.gender,
    native_language: user.native_language,
    learning_language: user.learning_language,
    reason: user.reason,
    level: user.level,
    tz_region: TZ_REGION(user.time_zone),
    time_zone: user.time_zone,
    completed_tutorial: user.completed_tutorial === true ? 1 : user.completed_tutorial === false ? 0 : null,
    main_lesson_id: user.main_lesson_id,
    has_phone: user.phone_number ? 1 : 0,
    attribution: user.attribution,
    is_creator: user.is_creator === true ? 1 : 0,
    tutor: user.tutor,
    tutor_accent: user.tutor_accent,
    previous_experience: user.previous_experience,
    messaging_platform: user.messaging_platform,
    initial_freemodal_seen: user.initial_freemodal_seen === true ? 1 : user.initial_freemodal_seen === false ? 0 : null,
    // first-7d engagement window.
    // first_7d_lessons / first_7d_distinct_lessons are deliberately excluded:
    // free users are capped at 1 lesson, so a count > 1 implies conversion
    // (paywall-gated structural leakage).
    had_any_lesson: hadAnyLesson,
    first_7d_avg_rating: a?.first_7d_avg_rating ?? null,
    first_7d_pct_ended_early: a?.first_7d_pct_ended_early ?? null,
  };
}

console.log(`Pulling cohort with cutoff ${CUTOFF_DATE} (last_logged_in >= cutoff OR payment_status='ACTIVE')…`);
const cohort = await fetchCohort();
console.log(`Cohort size: ${cohort.length}`);

const positives = cohort.filter((u) => u.payment_status === "ACTIVE").length;
console.log(`Positives (ACTIVE): ${positives} (${((positives / cohort.length) * 100).toFixed(2)}%)`);

console.log(`Pulling lesson aggregates (first-${WINDOW_DAYS}d window) for ${cohort.length} users…`);
const windowAgg = await fetchFirstWindowAggregates(cohort.map((u) => u.user_id));
console.log(`Users with lesson activity: ${windowAgg.size}`);

const rows = cohort.map((u) => buildRow(u, windowAgg));
const header = Object.keys(rows[0]);
const lines = [header.join(",")];
for (const r of rows) {
  lines.push(header.map((h) => csvEscape(r[h])).join(","));
}
writeFileSync(resolve(__dirname, "..", OUTPUT_PATH), lines.join("\n") + "\n");
console.log(`Wrote ${rows.length} rows × ${header.length} cols → ${OUTPUT_PATH}`);
