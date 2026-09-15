import type { TranscriptMessage } from "./lessonMetrics";

// Tutor-evaluation rubric = the LearnLM helpfulness rubric (6 principles / 29
// underlying items) as used by EduClaw-Bench's Helpfulness axis. The paper's
// field study validated that this rubric transfers to real (non-simulated) tutor
// transcripts, which is exactly what we grade here. Each principle is scored 1–10.
export const EVAL_DIMENSIONS = [
  "Manages cognitive load",
  "Inspires active learning",
  "Deepens metacognition",
  "Stimulates curiosity",
  "Adapts to the learner",
  "Overall quality",
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

// One judge's contribution to the panel (or a record of why it couldn't run).
export interface PanelJudge {
  id: string;
  label: string;
  ok: boolean;
  overall_score?: number;
  error?: string;
}

export interface TutorEvaluation {
  overall_score: number; // 1–10 (panel mean when >1 judge)
  verdict: string;
  dimensions: DimensionScore[];
  strengths: string[];
  issues: string[];
  notable_moments: NotableMoment[];
  // Cross-family judge panel that produced this evaluation. Absent on evaluations
  // saved before the panel existed (single-judge). See EduClaw-Bench §judge panel.
  panel?: { judges: PanelJudge[]; n: number; spread?: number };
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
// API's schema subset, so the 1–10 bounds live in the descriptions. Used both as
// Gemini's responseJsonSchema and as Claude's tool input_schema (Vertex).
const EVAL_SCHEMA = {
  type: "object",
  properties: {
    overall_score: {
      type: "integer",
      description: "Overall tutor helpfulness, 1 (poor) to 10 (excellent).",
    },
    verdict: {
      type: "string",
      description: "One-sentence overall assessment of the tutor's performance.",
    },
    dimensions: {
      type: "array",
      description: "Exactly one entry per rubric principle.",
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

const SYSTEM_PROMPT = `You are an expert evaluator of AI language tutors. You review one lesson transcript between a language tutor (the "assistant"/teacher role) and a student (the "user" role) and grade the TUTOR's performance — never the student's. The lessons are spoken (voice) conversations.

Grade the tutor on the LearnLM pedagogy rubric — six principles, each scored 1–10:

1. Manages cognitive load: appropriate length and pacing, clear structure, logical order, no needless repetition or self-contradiction, effective use of examples/analogies.
2. Inspires active learning: creates real opportunities for the STUDENT to speak and produce language, prompts them to think, avoids handing over answers too quickly, keeps the student actively participating rather than lecturing.
3. Deepens metacognition: guides the student to notice and correct their own mistakes, gives clear and constructive feedback, acknowledges what the student got right, and communicates a clear plan or goal for the lesson.
4. Stimulates curiosity: sparks interest, responds well to confusion or frustration, and delivers feedback in an encouraging way.
5. Adapts to the learner: pitches vocabulary, pace, and corrections to the student's apparent level and stated goal, adapts when the student is stuck, proactively guides, and doesn't withhold help unproductively.
6. Overall quality: factual/linguistic accuracy, expresses uncertainty appropriately, doesn't refuse reasonable requests, and is comparable to an excellent human tutor. The single most important gross failure to catch: teaching in the WRONG language (e.g. a Spanish learner taught in Portuguese, or an English lesson conducted mostly in the student's native tongue) — call this out explicitly and score it down.

Be specific and cite what actually happened in the transcript.

Lessons are sometimes cut short by the student leaving. When the lesson note says the student ended the call early (or the transcript simply stops mid-conversation), grade ONLY the conversation that actually happened, as if it were a complete lesson of that length. Do not lower any score for a missing wrap-up, missing recap, or material the tutor never had the chance to cover. Treat the early ending as evidence against the tutor only if the transcript itself shows the tutor driving the student away (persistent confusion, ignoring requests, talking over them) — and in that case cite the moment. If the sample is too small to judge a principle, score it on what little is there and say so in that principle's comment rather than defaulting low.

Transcripts may be partly or fully in a language other than English — evaluate them in their original language and write your evaluation in English.`;

// ── Cross-family judge panel ────────────────────────────────────────────────
// EduClaw-Bench grades helpfulness with a THREE-family panel to guard against a
// model favouring its own outputs. We run Gemini (via Vertex) + Claude Sonnet 5
// (via Vertex Model Garden). A judge that can't run (e.g. Sonnet 5 with no
// Vertex quota) is skipped after its first failure this session, so the panel
// degrades to whatever judges are available rather than blocking.
interface Judge {
  id: string;
  label: string;
  provider: "gemini" | "claude";
  primary: boolean; // the panel needs at least the primary judge to succeed
}
const JUDGES: Judge[] = [
  { id: "gemini", label: "Gemini", provider: "gemini", primary: true },
  { id: "sonnet", label: "Sonnet 5", provider: "claude", primary: false },
];
// Secondary judges that failed with a model-unavailable status this session —
// don't keep hammering them (e.g. 300 lessons each retrying a 0-quota Sonnet).
const disabledJudges = new Set<string>();

// One evaluation per distinct transcript per page load — repeat clicks and card
// re-mounts reuse the result instead of re-billing the panel.
const RUBRIC_VERSION = "learnlm-panel-v1";
const cache = new Map<string, Promise<TutorEvaluation>>();

function cacheKey(messages: TranscriptMessage[], endedEarly: boolean): string {
  const s = messages.map((m) => `${m.role}:${m.text}`).join("\n");
  let hash = 5381;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  return `${RUBRIC_VERSION}|${s.length}|${hash}|${endedEarly ? "early" : "full"}`;
}

export function evaluateTutor(
  messages: TranscriptMessage[],
  student: StudentContext = {},
): Promise<TutorEvaluation> {
  const key = cacheKey(messages, Boolean(student.endedEarly));
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = runPanel(messages, student).catch((e) => {
    cache.delete(key); // don't cache failures
    throw e;
  });
  cache.set(key, promise);
  return promise;
}

async function runPanel(
  messages: TranscriptMessage[],
  student: StudentContext,
): Promise<TutorEvaluation> {
  const prompt = buildPrompt(messages, student);
  const active = JUDGES.filter((j) => j.primary || !disabledJudges.has(j.id));

  const settled = await Promise.allSettled(
    active.map((j) => runJudge(j, prompt)),
  );

  const results: { judge: Judge; ev: TutorEvaluation }[] = [];
  const panelJudges: PanelJudge[] = [];
  let primaryError: unknown = null;

  active.forEach((judge, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") {
      results.push({ judge, ev: r.value });
      panelJudges.push({ id: judge.id, label: judge.label, ok: true, overall_score: r.value.overall_score });
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      if (!judge.primary) disabledJudges.add(judge.id); // stop retrying an unavailable judge this session
      if (judge.primary) primaryError = r.reason;
      panelJudges.push({ id: judge.id, label: judge.label, ok: false, error: msg });
    }
  });

  if (results.length === 0) {
    throw primaryError instanceof Error ? primaryError : new Error("All judges failed.");
  }
  return aggregate(results, panelJudges);
}

// Merge the panel into a single evaluation: mean scores, unioned qualitative
// notes. With one judge this is an identity (its own evaluation, plus panel meta).
function aggregate(
  results: { judge: Judge; ev: TutorEvaluation }[],
  panelJudges: PanelJudge[],
): TutorEvaluation {
  const multi = results.length > 1;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const overalls = results.map((r) => r.ev.overall_score);

  const dimensions: DimensionScore[] = EVAL_DIMENSIONS.map((name) => {
    const found = results
      .map((r) => ({ judge: r.judge, d: r.ev.dimensions.find((d) => d.dimension === name) }))
      .filter((x): x is { judge: Judge; d: DimensionScore } => Boolean(x.d));
    if (found.length === 0) return { dimension: name, score: 0, comment: "No score returned." };
    const score = Math.round(mean(found.map((f) => f.d.score)));
    const comment = multi
      ? found.map((f) => `${f.judge.label}: ${f.d.comment}`).join("  ")
      : found[0].d.comment;
    return { dimension: name, score, comment };
  });

  const dedupe = (xs: string[], cap: number) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of xs) {
      const k = x.trim().toLowerCase();
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(x.trim());
      }
      if (out.length >= cap) break;
    }
    return out;
  };

  const moments: NotableMoment[] = [];
  const seenQuotes = new Set<string>();
  for (const r of results) {
    for (const m of r.ev.notable_moments) {
      const k = m.quote.trim().toLowerCase();
      if (k && !seenQuotes.has(k)) {
        seenQuotes.add(k);
        moments.push(m);
      }
      if (moments.length >= 4) break;
    }
  }

  const spread = overalls.length > 1 ? Math.max(...overalls) - Math.min(...overalls) : 0;
  const verdict = multi
    ? `Panel avg ${Math.round(mean(overalls) * 10) / 10}/10 (${panelJudges
        .filter((j) => j.ok)
        .map((j) => `${j.label} ${j.overall_score}`)
        .join(", ")}). ${results[0].ev.verdict}`
    : results[0].ev.verdict;

  return {
    overall_score: Math.round(mean(overalls)),
    verdict,
    dimensions,
    strengths: dedupe(results.flatMap((r) => r.ev.strengths), 6),
    issues: dedupe(results.flatMap((r) => r.ev.issues), 6),
    notable_moments: moments,
    panel: { judges: panelJudges, n: results.length, spread },
  };
}

function buildPrompt(messages: TranscriptMessage[], student: StudentContext): string {
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

  return (
    lessonNote +
    (contextLines.length > 0 ? `Student profile:\n${contextLines.join("\n")}\n\n` : "") +
    `Lesson transcript:\n${transcript}`
  );
}

// One judge call. The dev server's /api/evaluate-tutor middleware (vite.config.ts)
// forwards to Vertex — Gemini for provider "gemini", Claude on Vertex Model Garden
// for provider "claude" — using local gcloud/service-account credentials.
async function runJudge(judge: Judge, prompt: string): Promise<TutorEvaluation> {
  const res = await fetch("/api/evaluate-tutor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: SYSTEM_PROMPT, prompt, schema: EVAL_SCHEMA, provider: judge.provider }),
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
    throw new Error(`${judge.label}: ${detail}`);
  }
  const { text } = payload as { text: string | null };
  if (!text) throw new Error(`${judge.label}: evaluation returned no content.`);
  return JSON.parse(text) as TutorEvaluation;
}
