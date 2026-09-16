// Headless daily eval job: LLM-judges a sample of each day's lessons (LearnLM
// rubric) and the engaged-user Learning Journeys, and persists to Supabase
// (lesson_evals / journey_evals) so the Evals tab can show trends without anyone
// clicking. Talks to Vertex directly (service account) — no dev server needed.
//
// Run with Node's built-in env loader:
//   node --env-file=.env scripts/eval-jobs.mjs daily          # yesterday + refresh journeys
//   node --env-file=.env scripts/eval-jobs.mjs backfill 14    # last 14 days + journeys
//
// NOTE: the two rubric prompts/schemas below MIRROR src/lib/evaluateTutor.ts and
// src/lib/evaluateJourney.ts — keep them in sync if those change.

import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const PROJECT = process.env.GCP_PROJECT_ID || "versa-443600";
const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const MODEL = process.env.GEMINI_EVAL_MODEL || "gemini-2.5-flash";
const KEYFILE = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;

if (!SB_URL || !SB_KEY) throw new Error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (run with --env-file=.env)");

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const ai = new GoogleGenAI({
  vertexai: true,
  project: PROJECT,
  location: LOCATION,
  ...(KEYFILE ? { googleAuthOptions: { keyFilename: KEYFILE } } : {}),
});

// Tunables
const LESSONS_PER_DAY = 10;
const LESSON_MIN_TURNS = 4;
const LESSON_CONCURRENCY = 6;
const JOURNEY_MIN_LESSONS = 5;
const JOURNEY_SINCE_DAYS = 45;
const JOURNEY_MAX_USERS = 40;
const JOURNEY_CONCURRENCY = 3;
const JOURNEY_CAP = 20; // lessons per journey sent to the judge
const JOURNEY_MAX_LESSONS = 15;
const JOURNEY_CHAR_CAP = 8000;

// ── shared helpers ────────────────────────────────────────────────────────────
const iso = (d) => d.toISOString().slice(0, 10);
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length || 1) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      await fn(items[k], k);
    }
  });
  await Promise.all(workers);
}
function parseTranscript(raw) {
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m) => m && typeof m === "object" && typeof m.text === "string" && m.role !== "ack")
      .map((m) => ({ role: m.role ?? "unknown", text: m.text }));
  } catch {
    return [];
  }
}
async function gemini(system, prompt, schema) {
  const resp = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: schema },
  });
  const text = resp.text ?? resp.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("no content from model");
  return JSON.parse(text);
}

// ── LearnLM per-lesson rubric (mirror of src/lib/evaluateTutor.ts) ─────────────
const LEARNLM_DIMS = ["Manages cognitive load", "Inspires active learning", "Deepens metacognition", "Stimulates curiosity", "Adapts to the learner", "Overall quality"];
const LESSON_SCHEMA = {
  type: "object",
  properties: {
    overall_score: { type: "integer", description: "Overall tutor helpfulness, 1 (poor) to 10 (excellent)." },
    verdict: { type: "string", description: "One-sentence overall assessment of the tutor's performance." },
    dimensions: {
      type: "array", description: "Exactly one entry per rubric principle.",
      items: { type: "object", properties: {
        dimension: { type: "string", enum: LEARNLM_DIMS },
        score: { type: "integer", description: "1 (poor) to 10 (excellent)." },
        comment: { type: "string", description: "One or two sentences of justification." },
      }, required: ["dimension", "score", "comment"], additionalProperties: false },
    },
    strengths: { type: "array", items: { type: "string" } },
    issues: { type: "array", items: { type: "string" } },
    notable_moments: { type: "array", items: { type: "object", properties: {
      quote: { type: "string" }, comment: { type: "string" }, kind: { type: "string", enum: ["good", "bad"] },
    }, required: ["quote", "comment", "kind"], additionalProperties: false } },
  },
  required: ["overall_score", "verdict", "dimensions", "strengths", "issues", "notable_moments"],
  additionalProperties: false,
};
const LESSON_SYSTEM = `You are an expert evaluator of AI language tutors. You review one lesson transcript between a language tutor (the "assistant"/teacher role) and a student (the "user" role) and grade the TUTOR's performance — never the student's. The lessons are spoken (voice) conversations.

Grade the tutor on the LearnLM pedagogy rubric — six principles, each scored 1–10:

1. Manages cognitive load: appropriate length and pacing, clear structure, logical order, no needless repetition or self-contradiction, effective use of examples/analogies.
2. Inspires active learning: creates real opportunities for the STUDENT to speak and produce language, prompts them to think, avoids handing over answers too quickly, keeps the student actively participating rather than lecturing.
3. Deepens metacognition: guides the student to notice and correct their own mistakes, gives clear and constructive feedback, acknowledges what the student got right, and communicates a clear plan or goal for the lesson.
4. Stimulates curiosity: sparks interest, responds well to confusion or frustration, and delivers feedback in an encouraging way.
5. Adapts to the learner: pitches vocabulary, pace, and corrections to the student's apparent level and stated goal, adapts when the student is stuck, proactively guides, and doesn't withhold help unproductively.
6. Overall quality: factual/linguistic accuracy, expresses uncertainty appropriately, doesn't refuse reasonable requests, and is comparable to an excellent human tutor. The single most important gross failure to catch: teaching in the WRONG language — call this out explicitly and score it down.

Be specific and cite what actually happened in the transcript. When the lesson ended early, grade only the conversation that happened. Transcripts may be partly in another language — evaluate as-is and write in English.`;

function buildLessonPrompt(messages, ctx) {
  const lines = [ctx.learning && `Learning: ${ctx.learning}`, ctx.level && `Self-reported level: ${ctx.level}`, ctx.native && `Native language: ${ctx.native}`, ctx.reason && `Stated goal: ${ctx.reason}`].filter(Boolean);
  const transcript = messages.map((m) => `${m.role === "user" ? "STUDENT" : "TUTOR"}: ${m.text}`).join("\n");
  const note = ctx.endedEarly ? "Lesson note: the student ended the call early, so the transcript is truncated. Grade only the conversation that happened.\n\n" : "";
  return note + (lines.length ? `Student profile:\n${lines.join("\n")}\n\n` : "") + `Lesson transcript:\n${transcript}`;
}

// ── Journey rubric (mirror of src/lib/evaluateJourney.ts) ──────────────────────
const JOURNEY_DIMS = ["Continuity", "Progression", "Memory & personalization", "Consistency"];
const JOURNEY_SCHEMA = {
  type: "object",
  properties: {
    overall_score: { type: "integer" },
    verdict: { type: "string" },
    dimensions: { type: "array", items: { type: "object", properties: {
      dimension: { type: "string", enum: JOURNEY_DIMS }, score: { type: "integer" }, comment: { type: "string" },
    }, required: ["dimension", "score", "comment"], additionalProperties: false } },
    strengths: { type: "array", items: { type: "string" } },
    issues: { type: "array", items: { type: "string" } },
    notable_moments: { type: "array", items: { type: "object", properties: {
      quote: { type: "string" }, comment: { type: "string" }, kind: { type: "string", enum: ["good", "bad"] },
    }, required: ["quote", "comment", "kind"], additionalProperties: false } },
  },
  required: ["overall_score", "verdict", "dimensions", "strengths", "issues", "notable_moments"],
  additionalProperties: false,
};
const JOURNEY_SYSTEM = `You are an expert evaluator of AI language tutors. You are given the FULL SEQUENCE of lessons between one language tutor (the "assistant"/teacher) and one student (the "user"), in chronological order — their whole relationship over days or weeks. Judge the TUTOR's LONG-HORIZON performance across the sequence, never the student's, and never just a single lesson.

Score each dimension 1–10:
- Continuity: does the tutor build on prior lessons — pick up where they left off, reference earlier conversations — or reset every session (repeating the same opener, re-teaching the same material, asking questions already answered)? Reused openers and re-introductions are strong evidence against continuity.
- Progression: does difficulty, vocabulary, and expectation escalate appropriately over time, and does the student's own output visibly grow? A flat, non-escalating experience scores low.
- Memory & personalization: does the tutor remember and use the student's stated goal, interests, name, native language, and past struggles across sessions?
- Consistency: does teaching quality hold across the sequence, or drift/degrade?

Cite specific lessons by number. Transcripts may be truncated (marked) and partly in another language — evaluate as-is, write in English.`;

function buildJourneyPrompt(lessons, ctx) {
  const lines = [ctx.name && `Student name: ${ctx.name}`, ctx.learning && `Learning: ${ctx.learning}`, ctx.level && `Self-reported level: ${ctx.level}`, ctx.native && `Native language: ${ctx.native}`, ctx.reason && `Stated goal: ${ctx.reason}`].filter(Boolean);
  const used = lessons.slice(0, JOURNEY_MAX_LESSONS);
  const omitted = lessons.length - used.length;
  const blocks = used.map((l, i) => {
    let body = l.messages.map((m) => `${m.role === "user" ? "STUDENT" : "TUTOR"}: ${m.text}`).join("\n");
    if (body.length > JOURNEY_CHAR_CAP) { const h = Math.floor(JOURNEY_CHAR_CAP / 2); body = body.slice(0, h) + "\n…[transcript trimmed]…\n" + body.slice(-h); }
    const meta = `${l.date.slice(0, 10)} · ${l.turns} turns${l.rating != null ? ` · rated ${l.rating}★` : ""}${l.endedEarly ? " · ended early" : ""}`;
    return `=== Lesson ${i + 1} — ${meta} ===\n${body}`;
  });
  return (lines.length ? `Student profile:\n${lines.join("\n")}\n\n` : "") +
    `This learner completed ${lessons.length} lesson${lessons.length === 1 ? "" : "s"}${omitted > 0 ? ` (showing the first ${used.length}; ${omitted} later omitted for length)` : ""}. Full sequence follows, oldest first.\n\n` +
    blocks.join("\n\n");
}
const dimScore = (ev, name) => ev.dimensions.find((d) => d.dimension === name)?.score ?? null;

// ── jobs ──────────────────────────────────────────────────────────────────────
async function judgeLessonDay(dayISO) {
  const { data, error } = await sb.rpc("lesson_eval_sample", { day: dayISO, sample_size: LESSONS_PER_DAY, min_turns: LESSON_MIN_TURNS });
  if (error) throw new Error(`lesson_eval_sample ${dayISO}: ${error.message}`);
  const rows = data ?? [];
  let ok = 0;
  await pool(rows, LESSON_CONCURRENCY, async (r) => {
    const messages = parseTranscript(r.conversation_transcript);
    if (messages.length < 2) return;
    try {
      const ev = await gemini(LESSON_SYSTEM, buildLessonPrompt(messages, { learning: r.learning_language, level: r.level, native: r.native_language, reason: r.reason, endedEarly: r.ended_early }), LESSON_SCHEMA);
      const { error: uerr } = await sb.rpc("upsert_lesson_eval", {
        p_id: r.id, p_user: r.user_id, p_date: dayISO, p_overall: ev.overall_score,
        p_dims: ev.dimensions, p_verdict: ev.verdict, p_model: MODEL,
      });
      if (uerr) throw new Error(uerr.message);
      ok++;
    } catch (e) { console.error(`  lesson ${r.id} failed: ${e.message}`); }
  });
  console.log(`[lessons] ${dayISO}: judged ${ok}/${rows.length}`);
  return ok;
}

async function judgeJourneys() {
  const { data, error } = await sb.rpc("engaged_users", { min_lessons: JOURNEY_MIN_LESSONS, since_days: JOURNEY_SINCE_DAYS, max_rows: JOURNEY_MAX_USERS });
  if (error) throw new Error(`engaged_users: ${error.message}`);
  let users = data ?? [];
  // Skip users already judged (idempotent daily runs).
  const { data: existing } = await sb.from("journey_evals").select("user_id");
  const seen = new Set((existing ?? []).map((e) => e.user_id));
  const todo = users.filter((u) => !seen.has(u.user_id));
  console.log(`[journeys] ${todo.length} to judge (${users.length} sampled, ${users.length - todo.length} already stored)`);
  let ok = 0;
  await pool(todo, JOURNEY_CONCURRENCY, async (u) => {
    try {
      const { data: ld, error: le } = await sb.rpc("user_lesson_journey", { p_user_id: u.user_id, max_lessons: JOURNEY_CAP });
      if (le) throw new Error(le.message);
      const lessons = (ld ?? []).map((r) => ({ date: String(r.created_at), turns: Number(r.turns ?? 0), rating: r.user_rating_feedback ?? null, endedEarly: !!r.ended_early, messages: parseTranscript(r.conversation_transcript) })).filter((l) => l.messages.length > 0);
      if (lessons.length < 3) return;
      const ev = await gemini(JOURNEY_SYSTEM, buildJourneyPrompt(lessons, { name: u.preferred_name, learning: u.learning_language, level: u.level, native: u.native_language, reason: u.reason }), JOURNEY_SCHEMA);
      const { error: uerr } = await sb.rpc("upsert_journey_eval", {
        p_user: u.user_id, p_count: lessons.length, p_last: String(u.last_lesson).slice(0, 10),
        p_converted: u.became_active_at != null, p_overall: ev.overall_score,
        p_continuity: dimScore(ev, "Continuity"), p_progression: dimScore(ev, "Progression"),
        p_memory: dimScore(ev, "Memory & personalization"), p_consistency: dimScore(ev, "Consistency"),
        p_verdict: ev.verdict, p_model: MODEL,
      });
      if (uerr) throw new Error(uerr.message);
      ok++;
    } catch (e) { console.error(`  journey ${u.user_id} failed: ${e.message}`); }
  });
  console.log(`[journeys] judged ${ok}/${todo.length}`);
  return ok;
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  const t0 = Date.now();
  if (mode === "backfill") {
    const days = Math.max(1, Number(arg) || 14);
    console.log(`Backfilling ${days} days of lesson evals…`);
    for (let i = 1; i <= days; i++) {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
      await judgeLessonDay(iso(d));
    }
    await judgeJourneys();
  } else if (mode === "daily") {
    const y = new Date(); y.setUTCDate(y.getUTCDate() - 1);
    console.log(`Daily run for ${iso(y)}…`);
    await judgeLessonDay(iso(y));
    await judgeJourneys();
  } else {
    console.log("Usage: node --env-file=.env scripts/eval-jobs.mjs [daily | backfill <days>]");
    process.exit(1);
  }
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
