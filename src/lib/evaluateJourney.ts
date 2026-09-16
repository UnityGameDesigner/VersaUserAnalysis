import type { TranscriptMessage } from "./lessonMetrics";
import type { NotableMoment } from "./evaluateTutor";

// Long-horizon "Learning Journey" eval: judge the TUTOR across a learner's real
// multi-session relationship — the thing single-lesson evals structurally miss.
// Inspired by EduClaw-Bench's long-horizon framing, but on REAL learner histories
// (no simulator). Uses the Gemini judge via /api/evaluate-tutor.

export const JOURNEY_DIMENSIONS = [
  "Continuity",
  "Progression",
  "Memory & personalization",
  "Consistency",
] as const;
export type JourneyDimension = (typeof JOURNEY_DIMENSIONS)[number];

export interface JourneyDimensionScore {
  dimension: JourneyDimension;
  score: number; // 1–10
  comment: string;
}

export interface JourneyEvaluation {
  overall_score: number; // 1–10
  verdict: string;
  dimensions: JourneyDimensionScore[];
  strengths: string[];
  issues: string[];
  notable_moments: NotableMoment[];
}

// One lesson in the sequence, already parsed and ready to render into the prompt.
export interface JourneyLesson {
  date: string; // ISO created_at
  turns: number;
  rating: number | null;
  endedEarly: boolean;
  messages: TranscriptMessage[];
}

export interface JourneyContext {
  learningLanguage?: string | null;
  nativeLanguage?: string | null;
  level?: string | null;
  reason?: string | null;
  name?: string | null;
}

const MAX_LESSONS = 15; // cap the sequence sent to the judge
const LESSON_CHAR_CAP = 8000; // per-lesson transcript budget (truncate the middle)

const JOURNEY_SCHEMA = {
  type: "object",
  properties: {
    overall_score: {
      type: "integer",
      description: "Overall long-horizon tutoring quality across the whole relationship, 1 (poor) to 10 (excellent).",
    },
    verdict: { type: "string", description: "One-sentence assessment of the tutor across the learner's whole journey." },
    dimensions: {
      type: "array",
      description: "Exactly one entry per journey dimension.",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string", enum: [...JOURNEY_DIMENSIONS] },
          score: { type: "integer", description: "1 (poor) to 10 (excellent)." },
          comment: { type: "string", description: "One or two sentences citing specific lessons (by number)." },
        },
        required: ["dimension", "score", "comment"],
        additionalProperties: false,
      },
    },
    strengths: { type: "array", description: "What the tutor did well ACROSS sessions — concrete.", items: { type: "string" } },
    issues: {
      type: "array",
      description: "Cross-session problems, concrete and lesson-referenced (e.g. 'reused the same opener in lessons 1–4', 'never revisited the stated goal', 'difficulty never increased').",
      items: { type: "string" },
    },
    notable_moments: {
      type: "array",
      description: "Up to 3 short verbatim tutor quotes that best illustrate strong or weak long-horizon tutoring; reference the lesson.",
      items: {
        type: "object",
        properties: {
          quote: { type: "string", description: "Verbatim tutor excerpt (prefix with 'Lesson N:')." },
          comment: { type: "string", description: "Why this moment matters across the journey." },
          kind: { type: "string", enum: ["good", "bad"] },
        },
        required: ["quote", "comment", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["overall_score", "verdict", "dimensions", "strengths", "issues", "notable_moments"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are an expert evaluator of AI language tutors. You are given the FULL SEQUENCE of lessons between one language tutor (the "assistant"/teacher) and one student (the "user"), in chronological order — their whole relationship over days or weeks. Judge the TUTOR's LONG-HORIZON performance across the sequence, never the student's, and never just a single lesson.

Score each dimension 1–10:
- Continuity: does the tutor build on prior lessons — pick up where they left off, reference earlier conversations — or reset every session (repeating the same opener, re-teaching the same material, asking questions already answered)? Reused openers and re-introductions are strong evidence against continuity.
- Progression: does difficulty, vocabulary, and expectation escalate appropriately over time, and does the student's own output visibly grow (longer/more complex turns, more target-language use)? A flat, non-escalating experience scores low.
- Memory & personalization: does the tutor remember and use the student's stated goal, interests, name, native language, and past struggles across sessions — genuinely personalizing — or treat every lesson as a stranger?
- Consistency: does teaching quality hold across the sequence, or does it drift/degrade (some lessons strong, others phoned-in)?

Cite specific lessons by number. Be concrete: name the actual repeated phrases, the goal that was or wasn't revisited, the mistakes that were or weren't followed up.

Transcripts may be truncated (marked) and may be partly in a language other than English — evaluate them as-is and write in English. Short or silent lessons in the sequence are still data — note them. Judge the arc of the relationship, not lesson polish.`;

export function buildJourneyPrompt(lessons: JourneyLesson[], ctx: JourneyContext): string {
  const contextLines = [
    ctx.name && `Student name: ${ctx.name}`,
    ctx.learningLanguage && `Learning: ${ctx.learningLanguage}`,
    ctx.level && `Self-reported level: ${ctx.level}`,
    ctx.nativeLanguage && `Native language: ${ctx.nativeLanguage}`,
    ctx.reason && `Stated goal: ${ctx.reason}`,
  ].filter(Boolean);

  const used = lessons.slice(0, MAX_LESSONS);
  const omitted = lessons.length - used.length;

  const blocks = used.map((l, i) => {
    let body = l.messages
      .map((m) => `${m.role === "user" ? "STUDENT" : "TUTOR"}: ${m.text}`)
      .join("\n");
    if (body.length > LESSON_CHAR_CAP) {
      const half = Math.floor(LESSON_CHAR_CAP / 2);
      body = body.slice(0, half) + "\n…[transcript trimmed]…\n" + body.slice(-half);
    }
    const d = new Date(l.date);
    const dateStr = Number.isNaN(d.getTime()) ? l.date : d.toISOString().slice(0, 10);
    const meta = `${dateStr} · ${l.turns} turns${l.rating != null ? ` · rated ${l.rating}★` : ""}${l.endedEarly ? " · ended early" : ""}`;
    return `=== Lesson ${i + 1} — ${meta} ===\n${body}`;
  });

  return (
    (contextLines.length ? `Student profile:\n${contextLines.join("\n")}\n\n` : "") +
    `This learner completed ${lessons.length} lesson${lessons.length === 1 ? "" : "s"}` +
    (omitted > 0 ? ` (showing the first ${used.length}; ${omitted} later omitted for length)` : "") +
    `. Full sequence follows, oldest first.\n\n` +
    blocks.join("\n\n")
  );
}

export async function evaluateJourney(
  lessons: JourneyLesson[],
  ctx: JourneyContext = {},
): Promise<JourneyEvaluation> {
  const res = await fetch("/api/evaluate-tutor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: SYSTEM_PROMPT, prompt: buildJourneyPrompt(lessons, ctx), schema: JOURNEY_SCHEMA, provider: "gemini" }),
  });

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error("Evaluation endpoint unavailable — run the dashboard via `npm run dev`.");
  }
  if (!res.ok) throw new Error((payload as { error?: string }).error ?? `HTTP ${res.status}`);
  const { text } = payload as { text: string | null };
  if (!text) throw new Error("Journey evaluation returned no content.");
  return JSON.parse(text) as JourneyEvaluation;
}
