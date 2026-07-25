import type { TranscriptMessage } from "./lessonMetrics";

// Fixed rubric so every evaluation renders the same way in the UI.
export const EVAL_DIMENSIONS = [
  "Student talk time",
  "Error correction",
  "Level fit",
  "Engagement & flow",
  "Teaching value",
] as const;
export type EvalDimension = (typeof EVAL_DIMENSIONS)[number];

export interface DimensionScore {
  dimension: EvalDimension;
  score: number; // 1–10
  comment: string;
}

export interface NotableMoment {
  quote: string;
  comment: string;
  kind: "good" | "bad";
}

export interface TutorEvaluation {
  overall_score: number; // 1–10
  verdict: string;
  dimensions: DimensionScore[];
  strengths: string[];
  issues: string[];
  notable_moments: NotableMoment[];
}

// Score → traffic-light variant for the evaluation badges.
export function scoreVariant(score: number): string {
  if (score >= 8) return "good";
  if (score >= 5) return "mid";
  return "bad";
}

export interface StudentContext {
  learningLanguage?: string | null;
  nativeLanguage?: string | null;
  level?: string | null;
  reason?: string | null;
  /** The student hung up before the lesson finished — grade pro-rated, not penalized. */
  endedEarly?: boolean | null;
}

// Structured-output schema. Numeric range constraints aren't supported by the
// API's schema subset, so the 1–10 bounds live in the descriptions.
const EVAL_SCHEMA = {
  type: "object",
  properties: {
    overall_score: {
      type: "integer",
      description: "Overall tutor performance, 1 (poor) to 10 (excellent).",
    },
    verdict: {
      type: "string",
      description: "One-sentence overall assessment of the tutor's performance.",
    },
    dimensions: {
      type: "array",
      description: "Exactly one entry per rubric dimension.",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string", enum: [...EVAL_DIMENSIONS] },
          score: { type: "integer", description: "1 (poor) to 10 (excellent)." },
          comment: { type: "string", description: "One or two sentences of justification." },
        },
        required: ["dimension", "score", "comment"],
        additionalProperties: false,
      },
    },
    strengths: {
      type: "array",
      description: "What the tutor did well — concrete, not generic praise.",
      items: { type: "string" },
    },
    issues: {
      type: "array",
      description: "What the tutor should have done differently. Empty if genuinely none.",
      items: { type: "string" },
    },
    notable_moments: {
      type: "array",
      description:
        "Up to 3 short verbatim tutor quotes from the transcript that best illustrate strong or weak tutoring.",
      items: {
        type: "object",
        properties: {
          quote: { type: "string", description: "Verbatim excerpt from a tutor message." },
          comment: { type: "string", description: "Why this moment matters." },
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

const SYSTEM_PROMPT = `You are an expert evaluator of AI language tutors. You review one lesson transcript between a language tutor (the "assistant"/teacher role) and a student (the "user" role) and grade the TUTOR's performance — never the student's.

Rubric (score each 1–10):
- Student talk time: did the tutor draw the student out with open questions and leave them room to speak, or lecture and dominate?
- Error correction: were student mistakes noticed and corrected in a useful, non-disruptive way? Over-correction and pronunciation nitpicking count against, as does silently ignoring repeated errors.
- Level fit: did the tutor's vocabulary, pace, and corrections match the student's apparent level?
- Engagement & flow: did the conversation feel natural and build on what the student said, or follow a rigid script? Did the tutor recover well from confusion?
- Teaching value: did the student walk away with something concrete — new vocabulary, structures, or corrected habits?

Be specific and cite what actually happened in the transcript.

Lessons are sometimes cut short by the student leaving. When the lesson note says the student ended the call early (or the transcript simply stops mid-conversation), grade ONLY the conversation that actually happened, as if it were a complete lesson of that length. Do not lower any score for a missing wrap-up, missing recap, or material the tutor never had the chance to cover. Treat the early ending as evidence against the tutor only if the transcript itself shows the tutor driving the student away (persistent confusion, ignoring requests, talking over them) — and in that case cite the moment. If the sample is too small to judge a dimension, score it on what little is there and say so in that dimension's comment rather than defaulting low.

Transcripts may be partly or fully in a language other than English — evaluate them in their original language and write your evaluation in English.`;

// One evaluation per distinct transcript per page load — repeat clicks and
// card re-mounts reuse the result instead of re-billing the API.
const cache = new Map<string, Promise<TutorEvaluation>>();

function cacheKey(messages: TranscriptMessage[], endedEarly: boolean): string {
  const s = messages.map((m) => `${m.role}:${m.text}`).join("\n");
  let hash = 5381;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  return `${s.length}|${hash}|${endedEarly ? "early" : "full"}`;
}

export function evaluateTutor(
  messages: TranscriptMessage[],
  student: StudentContext = {},
): Promise<TutorEvaluation> {
  const key = cacheKey(messages, Boolean(student.endedEarly));
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = runEvaluation(messages, student).catch((e) => {
    cache.delete(key); // don't cache failures
    throw e;
  });
  cache.set(key, promise);
  return promise;
}

async function runEvaluation(
  messages: TranscriptMessage[],
  student: StudentContext,
): Promise<TutorEvaluation> {
  const contextLines = [
    student.learningLanguage && `Learning: ${student.learningLanguage}`,
    student.level && `Self-reported level: ${student.level}`,
    student.nativeLanguage && `Native language: ${student.nativeLanguage}`,
    student.reason && `Stated goal: ${student.reason}`,
  ].filter(Boolean);

  const transcript = messages
    .map((m) => `${m.role === "user" ? "STUDENT" : "TUTOR"}: ${m.text}`)
    .join("\n");

  const lessonNote = student.endedEarly
    ? "Lesson note: the student ended the call early, so the transcript is truncated. Grade only the conversation that happened — do not penalize the tutor for the lesson being incomplete.\n\n"
    : "";

  // The dev server's /api/evaluate-tutor middleware (vite.config.ts) forwards
  // this to Gemini on Vertex AI using local gcloud credentials — Google auth
  // can't run in the browser, and this keeps no API key in client code.
  const res = await fetch("/api/evaluate-tutor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system: SYSTEM_PROMPT,
      prompt:
        lessonNote +
        (contextLines.length > 0 ? `Student profile:\n${contextLines.join("\n")}\n\n` : "") +
        `Lesson transcript:\n${transcript}`,
      schema: EVAL_SCHEMA,
    }),
  });

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error(
      "Evaluation endpoint unavailable — run the dashboard via `npm run dev` (the Vertex proxy lives in the dev server).",
    );
  }
  if (!res.ok) {
    const detail = (payload as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(detail);
  }
  const { text } = payload as { text: string | null };
  if (!text) throw new Error("Evaluation returned no content.");
  return JSON.parse(text) as TutorEvaluation;
}
