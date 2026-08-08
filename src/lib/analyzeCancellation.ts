import { parseTranscript } from "./lessonMetrics";

// LLM-inferred "why did this user likely cancel their trial?" — feeds the user's
// profile, lesson call-logs, exit signals and notification history to Gemini (via
// the same /api/evaluate-tutor Vertex proxy the tutor evaluator uses) and gets a
// structured verdict. It is an INFERENCE from behaviour, not a stated reason —
// the app doesn't collect one — so the UI must frame it as "likely".

// Fixed reason taxonomy so verdicts aggregate cleanly on the Cancel Reasons tab.
export const CANCEL_REASONS = [
  {
    key: "never_activated",
    label: "Never activated",
    hint: "Barely used it — no or only trivial practice before cancelling.",
    color: "#6b7280",
  },
  {
    key: "technical_friction",
    label: "Technical friction",
    hint: "Mic / audio / connection problems, or silent calls where they never spoke.",
    color: "#dc2626",
  },
  {
    key: "low_perceived_value",
    label: "Low perceived value",
    hint: "Used it a little but didn't feel it was worth paying for.",
    color: "#f59e0b",
  },
  {
    key: "content_level_mismatch",
    label: "Content / level mismatch",
    hint: "Lessons too hard, too easy, or not aligned with their goal.",
    color: "#8b5cf6",
  },
  {
    key: "achieved_goal_quickly",
    label: "Achieved goal quickly",
    hint: "Got what they wanted fast and had no reason to continue.",
    color: "#0ea5e9",
  },
  {
    key: "engaged_but_churned",
    label: "Engaged but churned",
    hint: "Used it a lot yet still cancelled — price, habit, or an external reason.",
    color: "#059669",
  },
  {
    key: "price_sensitivity",
    label: "Price sensitivity",
    hint: "Signals pointing at cost being the blocker.",
    color: "#e11d48",
  },
  {
    key: "unclear",
    label: "Unclear",
    hint: "Not enough signal to attribute a reason with confidence.",
    color: "#9ca3af",
  },
] as const;

export type CancelReasonKey = (typeof CANCEL_REASONS)[number]["key"];

export function reasonMeta(key: string) {
  return CANCEL_REASONS.find((r) => r.key === key) ?? CANCEL_REASONS[CANCEL_REASONS.length - 1];
}

export interface CancelAnalysisInput {
  userId: string;
  profile: {
    preferred_name?: string | null;
    learning_language?: string | null;
    native_language?: string | null;
    level?: string | null;
    reason?: string | null;
    daily_streak?: number | null;
    first_lesson_at?: string | null;
    last_completed_at?: string | null;
    canceled_at?: string | null;
  };
  lessons: Array<{
    lesson_id: number;
    created_at: string;
    ended_early?: boolean | null;
    user_rating_feedback?: number | null;
    exit_phase?: string | null;
    exit_trigger?: string | null;
    mic_mode?: string | null;
    conversation_transcript?: unknown;
  }>;
  notifications: Array<{
    bucket?: string | null;
    source?: string | null;
    status?: string | null;
    sent_at?: string | null;
    opened_at?: string | null;
  }>;
}

export interface CancelAnalysis {
  primary_reason: CancelReasonKey | string;
  summary: string;
  confidence: "low" | "medium" | "high";
  contributing_factors?: string[];
  evidence?: string[];
}

const SYSTEM_PROMPT = `You are a product analyst for a voice-based language-learning app. You infer WHY a user most likely cancelled their free trial, from their behaviour — the app does not ask them, so this is an evidence-based inference, never a stated fact.

You are given the user's profile, their lesson call-logs (transcripts + how each call ended), and the push notifications they were sent. Weigh actual behaviour most heavily: how many real lessons they did, whether they spoke, how calls ended (e.g. "connected but never spoke" or connection errors = technical friction), ratings, and whether engagement was rising or flat.

Choose exactly one primary_reason from this list:
- never_activated: barely used it (0–1 real lessons, or only silent/aborted calls).
- technical_friction: mic/audio/connection problems, or calls where they connected but never spoke.
- low_perceived_value: some real usage, but it didn't seem worth paying for.
- content_level_mismatch: lessons too hard/easy or off their stated goal.
- achieved_goal_quickly: got what they needed fast.
- engaged_but_churned: substantial usage yet still cancelled (price/habit/external).
- price_sensitivity: signals that cost was the blocker.
- unclear: not enough signal.

Be concise and specific. summary is 1–2 sentences a PM can act on. evidence is short concrete signals from THIS user's data (quote sparingly). Do not invent facts not present in the input.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    primary_reason: {
      type: "string",
      enum: CANCEL_REASONS.map((r) => r.key),
    },
    summary: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    contributing_factors: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
  },
  required: ["primary_reason", "summary", "confidence"],
};

function daysBetween(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
  return Number.isFinite(d) ? Math.round(d) : null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

// Keep the prompt bounded: full detail for light users, first-2 + last-4 for heavy
// ones (the trial-cancel cohort is mostly light, so this rarely truncates).
function pickLessons<T>(lessons: T[]): T[] {
  if (lessons.length <= 6) return lessons;
  return [...lessons.slice(0, 2), ...lessons.slice(-4)];
}

function buildPrompt(input: CancelAnalysisInput): string {
  const p = input.profile;
  const real = input.lessons.filter((l) => l.lesson_id !== 42);
  const daysToCancel = daysBetween(p.first_lesson_at, p.canceled_at);

  const profileLines = [
    p.preferred_name && `Name: ${p.preferred_name}`,
    p.learning_language && `Learning: ${p.learning_language}`,
    p.native_language && `Native: ${p.native_language}`,
    p.level && `Self-reported level: ${p.level}`,
    p.reason && p.reason.toLowerCase() !== "not specified" && `Stated goal: ${p.reason}`,
    `Daily streak at cancel: ${p.daily_streak ?? 0}`,
    `Real lessons completed (onboarding excluded): ${real.length}`,
    daysToCancel != null && `Days from first lesson to cancel: ${daysToCancel}`,
  ].filter(Boolean);

  // Lesson call-logs, chronological.
  const ordered = [...real].sort(
    (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
  );
  const lessonBlocks = pickLessons(ordered).map((l, i) => {
    const msgs = parseTranscript(l.conversation_transcript);
    const userTurns = msgs.filter(
      (m) => m.role === "user" && m.text.trim() && m.text !== "[NO_SPEECH_DETECTED]",
    ).length;
    const meta = [
      `date ${new Date(l.created_at).toISOString().slice(0, 10)}`,
      `${userTurns} student turns`,
      l.ended_early ? "ended early" : null,
      l.user_rating_feedback != null ? `rated ${l.user_rating_feedback}★` : null,
      l.exit_phase ? `exit_phase=${l.exit_phase}` : null,
      l.exit_trigger ? `exit_trigger=${l.exit_trigger}` : null,
      l.mic_mode ? `mic=${l.mic_mode}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const convo = msgs
      .map((m) => `${m.role === "user" ? "STUDENT" : "TUTOR"}: ${m.text}`)
      .join("\n");
    return `Lesson ${i + 1} (#${l.lesson_id}; ${meta}):\n${truncate(convo, 1400) || "(no transcript)"}`;
  });

  // Notification summary — buckets sent and whether any were opened.
  const notifs = input.notifications;
  const opened = notifs.filter((n) => n.opened_at).length;
  const byBucket = new Map<string, number>();
  notifs.forEach((n) => {
    const k = `${n.source ?? "?"}/${n.bucket ?? "?"}`;
    byBucket.set(k, (byBucket.get(k) ?? 0) + 1);
  });
  const notifLine =
    notifs.length === 0
      ? "No notifications sent."
      : `${notifs.length} notifications sent (${opened} opened). Types: ${[...byBucket.entries()]
          .map(([k, n]) => `${k}×${n}`)
          .join(", ")}.`;

  return [
    "USER PROFILE",
    profileLines.join("\n"),
    "",
    "NOTIFICATIONS",
    notifLine,
    "",
    `LESSON CALL-LOGS (${real.length} real lesson${real.length === 1 ? "" : "s"}${
      ordered.length > lessonBlocks.length ? `, showing ${lessonBlocks.length}` : ""
    })`,
    lessonBlocks.join("\n\n") || "(none)",
  ].join("\n");
}

// Runs the analysis. Requires the dev server's Vertex proxy (same as the tutor
// evaluator) — i.e. `npm run dev` with gcloud application-default credentials.
export async function analyzeCancellation(
  input: CancelAnalysisInput,
): Promise<CancelAnalysis> {
  const res = await fetch("/api/evaluate-tutor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(input),
      schema: RESPONSE_SCHEMA,
    }),
  });

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error(
      "Analysis endpoint unavailable — run the dashboard via `npm run dev` (the Vertex proxy lives in the dev server).",
    );
  }
  if (!res.ok) {
    const detail = (payload as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(detail);
  }
  const { text } = payload as { text: string | null };
  if (!text) throw new Error("Analysis returned no content.");
  return JSON.parse(text) as CancelAnalysis;
}
