import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./lib/supabase";
import { getCountryFromTimezone } from "./lib/timezone";
import { translateText } from "./lib/translate";
import {
  parseTranscript,
  speakingRatio,
  estimateLessonDurationMs,
  formatDuration,
} from "./lib/lessonMetrics";
import { exportTranscriptsZip } from "./lib/exportTranscripts";
import { evaluateTutor, type TutorEvaluation } from "./lib/evaluateTutor";
import { getSavedEvaluation, saveEvaluation } from "./lib/evalStore";
import {
  getSavedTranscript,
  isSaved as isTranscriptSaved,
  saveTranscript,
  updateNote,
  deleteSavedTranscript,
} from "./lib/savedStore";
import TutorEvalPanel from "./TutorEvalPanel";
import { format } from "date-fns";

interface TranscriptRow {
  id: number;
  created_at: string;
  user_id: string;
  lesson_id: number;
  conversation_transcript: unknown;
  user_improvement_feedback: string | null;
  user_rating_feedback: number | null;
  ended_early: boolean | null;
  payment_status: string;
  word_timeline: unknown;
  exit_phase: string | null;
  exit_trigger: string | null;
}

const PAGE_SIZE = 200;
const SUPABASE_TABLE = "completed_lessons";

// Stable content fingerprint for a transcript row, used to drop duplicate
// records (same user + lesson + conversation written more than once under
// different ids). A compact djb2 hash of the serialized transcript keeps the
// key small without storing the full conversation in the dedupe set.
function rowDedupeKey(r: TranscriptRow): string {
  const raw = r.conversation_transcript;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `${r.user_id}|${r.lesson_id}|${hash}`;
}

function getAgeBucket(age: number | null): string {
  if (age === null || age === -1) return "Unknown";
  if (age < 18) return "Under 18";
  if (age < 23) return "18–22";
  if (age < 28) return "23–27";
  if (age < 33) return "28–32";
  if (age < 38) return "33–37";
  if (age < 43) return "38–42";
  if (age < 48) return "43–47";
  if (age < 53) return "48–52";
  if (age < 58) return "53–57";
  return "58+";
}

function tzToRegion(tz: string | null): string {
  if (!tz) return "Unknown";
  const part = tz.split("/")[0];
  const map: Record<string, string> = {
    America: "Americas", US: "Americas",
    Europe: "Europe",
    Asia: "Asia",
    Africa: "Africa",
    Australia: "Oceania", Pacific: "Oceania",
    Atlantic: "Atlantic",
    Indian: "Indian Ocean",
  };
  return map[part] ?? tz;
}

// native_language / learning_language are stored as lowercase codes
// ("english", "spanish", "brazilian portuguese"). Titlecase them for display
// while the raw code stays the filter value.
function prettyLang(code: string): string {
  return code
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

interface UserMeta {
  preferred_name: string | null;
  age: number | null;
  gender: string | null;
  native_language: string | null;
  learning_language: string | null;
  level: string | null;
  reason: string | null;
  daily_streak: number | null;
  time_zone: string | null;
  attribution: string | null;
  tutor: string | null;
  tutor_accent: string | null;
  demand_tier: string | null;
  messaging_platform: string | null;
  previous_experience: string | null;
  completed_tutorial: boolean | null;
  lesson_credits: number | null;
  is_creator: boolean | null;
  left_review: boolean | null;
  upsell: boolean | null;
  last_logged_in: string | null;
  payment_status: string | null;
  platform: string | null;
}

const USER_INFO_COLUMNS =
  "user_id, preferred_name, age, gender, native_language, learning_language, " +
  "level, reason, daily_streak, time_zone, attribution, tutor, tutor_accent, " +
  "demand_tier, messaging_platform, previous_experience, completed_tutorial, " +
  "lesson_credits, is_creator, left_review, upsell, last_logged_in, " +
  "payment_status, platform";

// Map a payment_status to a badge variant + label.
function statusBadge(status: string | null): { variant: string; label: string } {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE") return { variant: "active", label: "Active" };
  if (s === "TRIAL") return { variant: "trial", label: "Trial" };
  if (!s) return { variant: "inactive", label: "No status" };
  // FREE / EXPIRED / CANCELLED / anything else
  return { variant: "inactive", label: status as string };
}

// Map a user_info.platform value ("ios" / "android") to a badge label +
// variant. Returns null for missing/unrecognized values so the badge is
// simply omitted rather than rendering an empty pill.
function platformBadge(
  platform: string | null,
): { variant: string; label: string } | null {
  const p = (platform ?? "").trim().toLowerCase();
  if (p === "ios") return { variant: "ios", label: "iOS" };
  if (p === "android") return { variant: "android", label: "Android" };
  return null;
}

// Sentinel the Status filter uses for users with no payment_status set.
const NO_STATUS = "No status";

// Normalize a payment_status into a stable filter key. Null/empty collapses to
// the NO_STATUS sentinel; everything else is upper-cased so casing variants
// ("active" / "ACTIVE") group into one option.
function statusKey(status: string | null): string {
  const s = (status ?? "").trim();
  return s === "" ? NO_STATUS : s.toUpperCase();
}

// Human label for a Status filter key, matching the on-card badge wording.
function statusFilterLabel(key: string): string {
  return key === NO_STATUS ? NO_STATUS : statusBadge(key).label;
}

// Sentinel the Platform filter uses for users with no platform recorded.
const NO_PLATFORM = "Unknown";

// Normalize a platform into a stable filter key. Null/empty collapses to the
// NO_PLATFORM sentinel; everything else is lower-cased so casing variants
// ("iOS" / "ios") group into one option.
function platformKey(platform: string | null): string {
  const p = (platform ?? "").trim();
  return p === "" ? NO_PLATFORM : p.toLowerCase();
}

// Human label for a Platform filter key, matching the on-card badge wording.
// Falls back to the raw key for values platformBadge doesn't recognize.
function platformFilterLabel(key: string): string {
  return key === NO_PLATFORM ? NO_PLATFORM : (platformBadge(key)?.label ?? key);
}

// exit_phase (WHERE the learner dropped off) and exit_trigger (HOW the call was
// torn down) on completed_lessons. Values mirror LessonExitPhase /
// LessonExitTrigger in VersaFrontEnd/lib/lessonExit.ts. Both columns are
// additive and nullable and are written best-effort by the client, so lessons
// recorded before they shipped — and any the client failed to write — read null.
//
// The pair is what diagnoses: a never_connected row means something very
// different when its trigger is connection_error (our infra failed them) versus
// manual_end (they gave up while it loaded).
interface ExitMeta {
  label: string;
  variant: string;
  hint: string;
}

// Declaration order is the learner's funnel order and drives option ordering in
// the filters — earliest drop-off first, natural completion last.
const EXIT_PHASE_META: Record<string, ExitMeta> = {
  never_connected: {
    label: "Never connected",
    variant: "bad",
    hint: "The agent never connected — the learner never made it into the call.",
  },
  connected_no_user_turn: {
    label: "Never spoke",
    variant: "warn",
    hint: "The agent connected but the learner never spoke — froze, couldn't hear, or balked.",
  },
  after_user_turns: {
    label: "Left mid-lesson",
    variant: "warn",
    hint: "The learner spoke at least once, then left before the end.",
  },
  completed: {
    label: "Completed",
    variant: "good",
    hint: "Natural completion — not an abandonment.",
  },
};

const EXIT_TRIGGER_META: Record<string, ExitMeta> = {
  connection_error: {
    label: "Connection error",
    variant: "bad",
    hint: "WebRTC / transport failure tore the call down.",
  },
  startup_timeout: {
    label: "Startup timeout",
    variant: "bad",
    hint: "The room never became ready.",
  },
  inactivity_timeout: {
    label: "Idle timeout",
    variant: "warn",
    hint: 'The idle "still there?" prompt timed out.',
  },
  manual_end: {
    label: "Tapped End",
    variant: "neutral",
    hint: "The learner tapped End Call.",
  },
  natural: {
    label: "Natural end",
    variant: "good",
    hint: "The tutor ended the call.",
  },
};

// Sentinel the exit filters use for lessons with no exit value recorded —
// which is every lesson predating these columns, so it's a real bucket.
const NOT_RECORDED = "Not recorded";

// Normalize an exit_phase / exit_trigger into a stable filter key.
function exitKey(value: string | null): string {
  const v = (value ?? "").trim();
  return v === "" ? NOT_RECORDED : v.toLowerCase();
}

// Resolve a raw column value to its badge/label config. Unrecognized values
// (a client writing something new before this dashboard knows about it) keep
// their raw text rather than vanishing.
function exitMeta(value: string | null, table: Record<string, ExitMeta>): ExitMeta | null {
  const key = exitKey(value);
  if (key === NOT_RECORDED) return null;
  return table[key] ?? { label: value as string, variant: "neutral", hint: "" };
}

// Human label for an exit filter key.
function exitFilterLabel(key: string, table: Record<string, ExitMeta>): string {
  return key === NOT_RECORDED ? NOT_RECORDED : (table[key]?.label ?? key);
}

// Build the option list for an exit filter from the values actually loaded,
// ordered by the funnel order the meta table declares. Unknown values sort
// after known ones; NOT_RECORDED always sits last.
function exitOptions(present: Set<string>, table: Record<string, ExitMeta>): string[] {
  const order = Object.keys(table);
  const arr = Array.from(present).sort((a, b) => {
    if (a === NOT_RECORDED) return 1;
    if (b === NOT_RECORDED) return -1;
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  return ["All", ...arr];
}

function truncate(s: string, max = 48): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// previous_experience holds the onboarding situational assessment, serialized
// as "key:value,key:value" by VersaFrontEnd/lib/onboardingUserInfo.ts.
//
// The assessment was rewritten: the original four questions
// (frequency/context/history/goal) gave way to five orthogonal ones
// (goal/ability/speakingPartners/learningStyle/commitment). Rows written by the
// old build keep the old keys forever, so BOTH shapes are parsed and each row
// picks its own set — as of writing, recent signups are still a mix of the two.
// Configs mirror VersaFrontEnd/components/onboarding/SituationalAssessment.tsx;
// `short` is this dashboard's own compact wording for the chip.
interface ExpOption {
  value: string;
  emoji: string;
  label: string;
  short: string;
}
interface ExpQuestion {
  key: string;
  category: string;
  question: string;
  options: ExpOption[];
}

// Current assessment. Question text keeps the {{targetLanguage}} placeholder
// the app templates per learner; parseExperience substitutes it.
const EXPERIENCE_QUESTIONS: ExpQuestion[] = [
  {
    key: "goal",
    category: "Goal",
    question: "What's the main reason you're learning {{targetLanguage}}?",
    options: [
      { value: "work", emoji: "💼", label: "For my career", short: "Career" },
      { value: "travel", emoji: "✈️", label: "For travel", short: "Travel" },
      { value: "move", emoji: "🏠", label: "For daily life where I live", short: "Daily life" },
      { value: "family", emoji: "❤️", label: "To connect with my family", short: "Family" },
      { value: "school", emoji: "🎓", label: "For school", short: "School" },
      { value: "fun", emoji: "🎉", label: "Just for fun", short: "For fun" },
      { value: "other", emoji: "💭", label: "Something else", short: "Other" },
    ],
  },
  {
    key: "ability",
    category: "Ability",
    question: "How much {{targetLanguage}} can you speak right now?",
    options: [
      { value: "none", emoji: "🌱", label: "Nothing yet — I'm starting from zero", short: "From zero" },
      { value: "words", emoji: "🐣", label: "A few words, but no full sentences", short: "A few words" },
      { value: "simple", emoji: "💬", label: "Enough for simple conversations", short: "Simple chats" },
      { value: "comfortable", emoji: "💪", label: "A lot — I can discuss most topics", short: "Most topics" },
    ],
  },
  {
    key: "speakingPartners",
    category: "Speaks with",
    question: "Who do you speak {{targetLanguage}} with the most?",
    options: [
      { value: "nobody", emoji: "🤷", label: "Nobody yet", short: "Nobody" },
      { value: "family", emoji: "❤️", label: "My family", short: "Family" },
      { value: "friends", emoji: "💬", label: "My friends", short: "Friends" },
      { value: "work", emoji: "💼", label: "People at work", short: "Work" },
      { value: "school", emoji: "🎓", label: "People at school", short: "School" },
      { value: "other", emoji: "💭", label: "Someone else", short: "Other" },
    ],
  },
  {
    key: "learningStyle",
    category: "Focus",
    question: "How do you want to learn {{targetLanguage}}?",
    options: [
      { value: "speaking", emoji: "💬", label: "I want to start speaking ASAP", short: "Speaking" },
      { value: "grammar", emoji: "📖", label: "I want to learn the grammar and structure", short: "Grammar" },
      { value: "vocabulary", emoji: "📕", label: "I want to build my vocabulary", short: "Vocabulary" },
      { value: "listening", emoji: "👂", label: "I want to understand native speakers", short: "Listening" },
      { value: "other", emoji: "💭", label: "Something else", short: "Other" },
    ],
  },
  {
    key: "commitment",
    category: "Commitment",
    question: "How committed are you to learning?",
    options: [
      { value: "exploring", emoji: "🌱", label: "No routine — just trying it out", short: "Exploring" },
      { value: "casual", emoji: "📅", label: "A couple of times a week", short: "2× a week" },
      { value: "regular", emoji: "🔄", label: "About 15 minutes a day", short: "15 min/day" },
      { value: "serious", emoji: "🔥", label: "30 minutes or more a day", short: "30+ min/day" },
    ],
  },
];

// Superseded assessment, retained to read rows written before the rewrite.
// Note `goal` exists in both sets with DIFFERENT option values (career /
// dailyLife here vs work / move / school now), so it can't identify a format.
const LEGACY_EXPERIENCE_QUESTIONS: ExpQuestion[] = [
  {
    key: "frequency",
    category: "Frequency",
    question: "How often do you use the language?",
    options: [
      { value: "never", emoji: "🤷", label: "Almost never", short: "Rarely" },
      { value: "monthly", emoji: "📅", label: "A few times a month", short: "Monthly" },
      { value: "weekly", emoji: "💬", label: "A few times a week", short: "Weekly" },
      { value: "daily", emoji: "🔥", label: "Every day", short: "Daily" },
    ],
  },
  {
    key: "context",
    category: "Context",
    question: "Where do you use it the most?",
    options: [
      { value: "none", emoji: "🌱", label: "I don't really use it yet", short: "Not yet" },
      { value: "media", emoji: "📱", label: "Watching shows or social media", short: "Media" },
      { value: "social", emoji: "✈️", label: "Talking with friends or traveling", short: "Social" },
      { value: "work", emoji: "💼", label: "At work or school", short: "Work / school" },
    ],
  },
  {
    key: "history",
    category: "History",
    question: "Have you studied before?",
    options: [
      { value: "never", emoji: "🐣", label: "No, this is my first time", short: "First time" },
      { value: "longAgo", emoji: "📖", label: "I studied a long time ago", short: "Long ago" },
      { value: "onOff", emoji: "🔄", label: "I've been studying on and off", short: "On & off" },
      { value: "regularly", emoji: "💪", label: "I study or practice regularly", short: "Regularly" },
    ],
  },
  {
    key: "goal",
    category: "Goal",
    question: "What's your main goal?",
    options: [
      { value: "fun", emoji: "🎉", label: "Just for fun or curiosity", short: "For fun" },
      { value: "travel", emoji: "🌍", label: "Travel and everyday life", short: "Travel" },
      { value: "career", emoji: "🎓", label: "Career or school", short: "Career" },
      { value: "dailyLife", emoji: "🏠", label: "I need it for my daily life", short: "Daily life" },
    ],
  },
];

// Keys unique to the current assessment. The serializer always writes all five,
// so any one of these identifies a new-format row; `goal` is shared and can't.
const NEW_EXPERIENCE_KEYS = EXPERIENCE_QUESTIONS.map((q) => q.key).filter(
  (k) => k !== "goal",
);

interface ExpAnswer {
  key: string;
  category: string;
  question: string;
  emoji: string;
  short: string;
  full: string;
  answered: boolean;
}

// Parse the "key:value,key:value" string into resolved Q&A answers, reading
// whichever assessment version the row was written with. `learningLanguage`
// fills the {{targetLanguage}} placeholder in the current question text.
function parseExperience(
  raw: string | null,
  learningLanguage?: string | null,
): ExpAnswer[] {
  if (!raw || !raw.trim()) return [];
  const pairs = new Map<string, string>();
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    pairs.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  if (pairs.size === 0) return [];

  const questions = NEW_EXPERIENCE_KEYS.some((k) => pairs.has(k))
    ? EXPERIENCE_QUESTIONS
    : LEGACY_EXPERIENCE_QUESTIONS;
  const target = learningLanguage ? prettyLang(learningLanguage) : "the language";

  return questions.map((q) => {
    const question = q.question.replace("{{targetLanguage}}", target);
    const val = pairs.get(q.key);
    const opt = q.options.find((o) => o.value === val);
    if (opt) {
      return {
        key: q.key,
        category: q.category,
        question,
        emoji: opt.emoji,
        short: opt.short,
        full: opt.label,
        answered: true,
      };
    }
    // The serializer writes the literal "unknown" for a question the learner
    // skipped — distinct from a value this dashboard simply doesn't know, which
    // means the app shipped an option we haven't mirrored yet.
    const skipped = !val || val === "unknown";
    return {
      key: q.key,
      category: q.category,
      question,
      emoji: "❔",
      short: skipped ? "Not answered" : "Unrecognized",
      full: skipped ? "Not answered" : `Unrecognized value (${val})`,
      answered: false,
    };
  });
}

interface UserField {
  label: string;
  display: string;
  full: string;
}
interface UserGroup {
  title: string;
  fields: UserField[];
}

function field(label: string, value: unknown, maxLen = 26): UserField | null {
  if (value === null || value === undefined || value === "") return null;
  const full = String(value);
  return { label, display: truncate(full, maxLen), full };
}

function initials(name: string | null): string {
  if (!name || !name.trim()) return "?";
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? "").toUpperCase() + (parts[1]?.[0]?.toUpperCase() ?? "")
  ) || "?";
}

// Group a user's attributes into glanceable label/value columns.
function buildUserGroups(user: UserMeta): UserGroup[] {
  const yesNo = (v: boolean | null) => (v === null ? null : v ? "Yes" : "No");
  const streak =
    user.daily_streak != null
      ? `${user.daily_streak} day${user.daily_streak === 1 ? "" : "s"}`
      : null;
  const tutorial =
    user.completed_tutorial === null
      ? null
      : user.completed_tutorial
        ? "Completed"
        : "Incomplete";

  const raw: { title: string; fields: (UserField | null)[] }[] = [
    {
      title: "Learning",
      fields: [
        field("Native", user.native_language),
        field("Learning", user.learning_language),
        field("Level", user.level),
        field("Reason", user.reason),
      ],
    },
    {
      title: "Tutor",
      fields: [field("Tutor", user.tutor), field("Accent", user.tutor_accent)],
    },
    {
      title: "Engagement",
      fields: [
        field("Streak", streak),
        field("Last login", user.last_logged_in),
        field("Tutorial", tutorial),
        field("Credits", user.lesson_credits),
      ],
    },
    {
      title: "Account",
      fields: [
        field("Acquired via", user.attribution),
        field("Messaging", user.messaging_platform),
        field("Timezone", user.time_zone),
        field("Creator", user.is_creator ? "Yes" : null),
        field("Left review", yesNo(user.left_review)),
        field("Upsell", yesNo(user.upsell)),
      ],
    },
  ];
  return raw
    .map((g) => ({
      title: g.title,
      fields: g.fields.filter((f): f is UserField => f !== null),
    }))
    .filter((g) => g.fields.length > 0);
}

const TranscriptCard: React.FC<{
  row: TranscriptRow;
  user?: UserMeta;
  onUserClick?: (userId: string) => void;
  selected: boolean;
  onToggleSelect: (row: TranscriptRow) => void;
}> = ({ row, user, onUserClick, selected, onToggleSelect }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [translation, setTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  // Per-message translations of the conversation, indexed to match `messages`.
  const [convTranslations, setConvTranslations] = useState<string[] | null>(null);
  const [showConvTranslation, setShowConvTranslation] = useState(false);
  const [translatingConv, setTranslatingConv] = useState(false);
  // Model-graded tutor performance for this conversation. Seeded from
  // localStorage so an evaluation survives page refreshes.
  const [evaluation, setEvaluation] = useState<TutorEvaluation | null>(
    () => getSavedEvaluation(row.id)?.evaluation ?? null,
  );
  const [showEval, setShowEval] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  // Bookmark state for the Saved tab. Seeded from localStorage so a save (and
  // its note) survives refreshes. `note` is kept in component state even while
  // unsaved, so toggling save off and on again doesn't lose typed text.
  const [saved, setSaved] = useState(() => isTranscriptSaved(row.id));
  const [note, setNote] = useState(() => getSavedTranscript(row.id)?.note ?? "");
  const [noteOpen, setNoteOpen] = useState(false);

  const handleTranslate = async () => {
    if (!row.user_improvement_feedback) return;
    if (translation) { setTranslation(null); return; }
    setTranslating(true);
    try {
      const result = await translateText(row.user_improvement_feedback);
      setTranslation(result);
    } finally {
      setTranslating(false);
    }
  };
  const messages = parseTranscript(row.conversation_transcript);

  const handleTranslateConversation = async () => {
    // Translate once, then just toggle between original and translated views.
    if (convTranslations) {
      setShowConvTranslation((v) => !v);
      return;
    }
    setTranslatingConv(true);
    try {
      const results = await Promise.all(
        messages.map((m) => (m.text.trim() ? translateText(m.text) : Promise.resolve(m.text))),
      );
      setConvTranslations(results);
      setShowConvTranslation(true);
    } finally {
      setTranslatingConv(false);
    }
  };

  const copyJson = async () => {
    const raw = row.conversation_transcript;
    const obj = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : raw;
    const text = JSON.stringify(obj, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  // Grade the tutor once, then just toggle the panel. evaluateTutor caches by
  // transcript content, so a re-mount of the card won't re-bill either.
  const handleEvaluate = async () => {
    if (evaluation) {
      setShowEval((v) => !v);
      return;
    }
    setEvaluating(true);
    setEvalError(null);
    try {
      const result = await evaluateTutor(messages, {
        learningLanguage: user?.learning_language,
        nativeLanguage: user?.native_language,
        level: user?.level,
        reason: user?.reason,
        endedEarly: row.ended_early,
      });
      setEvaluation(result);
      setShowEval(true);
      saveEvaluation({
        rowId: row.id,
        userId: row.user_id,
        lessonId: row.lesson_id,
        lessonDate: row.created_at,
        evaluatedAt: new Date().toISOString(),
        userName: user?.preferred_name ?? null,
        endedEarly: Boolean(row.ended_early),
        turnCount: messages.length,
        evaluation: result,
      });
    } catch (e) {
      setEvalError(e instanceof Error ? e.message : String(e));
    } finally {
      setEvaluating(false);
    }
  };

  // Copy the conversation as readable "role: text" lines rather than raw JSON.
  const copyTranscript = async () => {
    const text = messages.map((m) => `${m.role}: ${m.text}`).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 1500);
    } catch {
      setCopiedText(false);
    }
  };

  // Bookmark / un-bookmark this conversation for the Saved tab. Saving captures
  // a snapshot of the metadata the Saved card shows; the transcript itself is
  // re-fetched there on demand. The current note is carried into the record.
  const toggleSaved = () => {
    if (saved) {
      deleteSavedTranscript(row.id);
      setSaved(false);
      setNoteOpen(false);
      return;
    }
    saveTranscript({
      rowId: row.id,
      userId: row.user_id,
      lessonId: row.lesson_id,
      lessonDate: row.created_at,
      savedAt: new Date().toISOString(),
      userName: user?.preferred_name ?? null,
      endedEarly: Boolean(row.ended_early),
      rating: row.user_rating_feedback ?? null,
      turnCount: messages.length,
      note,
    });
    setSaved(true);
    setNoteOpen(true); // reveal the note field so a note can be added right away
  };

  // Live-persist note edits to the already-saved record.
  const handleNoteChange = (value: string) => {
    setNote(value);
    updateNote(row.id, value);
  };

  return (
    <div className={`lesson-card${selected ? " lesson-card--selected" : ""}`}>
      <div className="lesson-card-header">
        <input
          type="checkbox"
          className="lesson-card-select"
          checked={selected}
          onChange={() => onToggleSelect(row)}
          title="Select for CSV export"
          aria-label={`Select lesson ${row.lesson_id} transcript for export`}
        />
        <button
          className="lesson-card-user lesson-card-user--clickable"
          title={`View all lessons for ${row.user_id}`}
          onClick={() => onUserClick?.(row.user_id)}
        >
          {row.user_id.slice(0, 8) + "…"}
        </button>
        <span className="lesson-card-lesson-id">Lesson #{row.lesson_id}</span>
        <span className="lesson-card-date">
          {format(new Date(row.created_at), "MMM d, yyyy h:mm a")}
        </span>
        {row.user_rating_feedback != null && (
          <span className="lesson-card-rating">{row.user_rating_feedback}★</span>
        )}
        {messages.length > 0 && (
          <span
            className="lesson-card-badge lesson-card-badge--turns"
            title={`${messages.length} conversational turn${messages.length === 1 ? "" : "s"} (messages exchanged between student and tutor)`}
          >
            💬 {messages.length} turn{messages.length === 1 ? "" : "s"}
          </span>
        )}
        {(() => {
          const ms = estimateLessonDurationMs(row.word_timeline);
          if (ms === null) return null;
          return (
            <span
              className="lesson-card-badge lesson-card-badge--duration"
              title={
                "Estimated lesson length, from the student's first to last spoken word (word_timeline).\n" +
                "Lower bound — excludes the tutor's intro before the student speaks and the wrap-up after."
              }
            >
              ⏱ {formatDuration(ms)}
            </span>
          );
        })()}
        {(() => {
          const { studentChars, teacherChars, ratio, studentShare } =
            speakingRatio(messages);
          if (studentChars + teacherChars === 0) return null;
          const ratioLabel = ratio === null ? "∞ : 1" : `${ratio.toFixed(2)} : 1`;
          const sharePct =
            studentShare === null ? "" : ` · ${Math.round(studentShare * 100)}% student`;
          return (
            <span
              className="lesson-card-badge lesson-card-badge--ratio"
              title={`Student-to-teacher speaking ratio (by characters)\nStudent: ${studentChars} chars · Teacher: ${teacherChars} chars`}
            >
              🗣 {ratioLabel}
              {sharePct}
            </span>
          );
        })()}
        {row.ended_early && (
          <span className="lesson-card-badge lesson-card-badge--early">
            Ended Early
          </span>
        )}
        {(() => {
          const phase = exitMeta(row.exit_phase, EXIT_PHASE_META);
          if (!phase) return null;
          return (
            <span
              className={`lesson-card-badge lesson-card-badge--exit-${phase.variant}`}
              title={`Exit phase — where the learner dropped off.\n${phase.hint}`}
            >
              ⇥ {phase.label}
            </span>
          );
        })()}
        {(() => {
          const trigger = exitMeta(row.exit_trigger, EXIT_TRIGGER_META);
          if (!trigger) return null;
          return (
            <span
              className={`lesson-card-badge lesson-card-badge--exit-${trigger.variant}`}
              title={`Exit trigger — how the call ended.\n${trigger.hint}`}
            >
              ⏻ {trigger.label}
            </span>
          );
        })()}
        {messages.length > 0 && (
          <button
            className="transcript-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide Conversation" : "Show Conversation"}
          </button>
        )}
        {messages.length > 0 && (
          <button className="transcript-toggle" onClick={copyTranscript}>
            {copiedText ? "Copied!" : "Copy Transcript"}
          </button>
        )}
        {row.conversation_transcript != null && (
          <button className="transcript-toggle" onClick={copyJson}>
            {copied ? "Copied!" : "Copy JSON"}
          </button>
        )}
        {messages.length > 0 && (
          <button
            className="transcript-toggle transcript-toggle--eval"
            onClick={handleEvaluate}
            disabled={evaluating}
            title="Have Claude grade the tutor's performance in this conversation"
          >
            {evaluating
              ? "Evaluating…"
              : evaluation
                ? showEval
                  ? "Hide Evaluation"
                  : "Show Evaluation"
                : "Evaluate Tutor"}
          </button>
        )}
        <button
          className={`transcript-toggle transcript-toggle--save${saved ? " transcript-toggle--saved" : ""}`}
          onClick={toggleSaved}
          title={saved ? "Remove from the Saved tab" : "Save this conversation to the Saved tab"}
        >
          {saved ? "🔖 Saved" : "🔖 Save"}
        </button>
        {saved && (
          <button
            className="transcript-toggle"
            onClick={() => setNoteOpen((v) => !v)}
            title="Add or edit a note for this saved conversation"
          >
            {noteOpen ? "Hide Note" : note.trim() ? "Edit Note" : "Add Note"}
          </button>
        )}
      </div>

      {saved && noteOpen && (
        <div className="tx-note">
          <label className="tx-note-label" htmlFor={`note-${row.id}`}>
            Note
          </label>
          <textarea
            id={`note-${row.id}`}
            className="tx-note-input"
            value={note}
            onChange={(e) => handleNoteChange(e.target.value)}
            placeholder="Why did you save this? (e.g. great correction example, tutor went off-script…)"
            rows={2}
          />
        </div>
      )}

      {user ? (
        <div className="user-panel">
          <div className="user-panel-identity">
            <span className="user-panel-avatar">{initials(user.preferred_name)}</span>
            <span className="user-panel-name">
              {user.preferred_name?.trim() || "Unknown"}
            </span>
            <span className="user-panel-sub">
              {[
                user.age != null && user.age !== -1 ? `${user.age}y` : null,
                user.gender,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <div className="user-panel-badges">
              {(() => {
                const b = statusBadge(user.payment_status);
                return (
                  <span className={`user-status-badge user-status-badge--${b.variant}`}>
                    <span className="user-status-dot" />
                    {b.label}
                  </span>
                );
              })()}
              {user.demand_tier && (
                <span
                  className={`user-tier-badge user-tier-badge--${user.demand_tier.toLowerCase()}`}
                >
                  {user.demand_tier}
                </span>
              )}
              {(() => {
                const p = platformBadge(user.platform);
                if (!p) return null;
                return (
                  <span
                    className={`user-platform-badge user-platform-badge--${p.variant}`}
                    title={`Platform: ${p.label}`}
                  >
                    {p.label}
                  </span>
                );
              })()}
            </div>
          </div>
          <div className="user-panel-grid">
            {buildUserGroups(user).map((g) => (
              <div key={g.title} className="user-group">
                <div className="user-group-title">{g.title}</div>
                {g.fields.map((f) => (
                  <div
                    key={f.label}
                    className="user-field"
                    title={`${f.label}: ${f.full}`}
                  >
                    <span className="user-field-label">{f.label}</span>
                    <span className="user-field-value">{f.display}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {(() => {
            const exp = parseExperience(user.previous_experience, user.learning_language);
            if (exp.length === 0) return null;
            return (
              <div className="user-exp">
                <div className="user-group-title">Onboarding Assessment</div>
                <div className="user-exp-row">
                  {exp.map((e) => (
                    <span
                      key={e.key}
                      className={`user-exp-chip${e.answered ? "" : " user-exp-chip--empty"}`}
                      title={`${e.question}  →  ${e.full}`}
                    >
                      <span className="user-exp-emoji">{e.emoji}</span>
                      <span className="user-exp-text">
                        <span className="user-exp-cat">{e.category}</span>
                        <span className="user-exp-val">{e.short}</span>
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="user-panel">
          <div className="user-panel-identity">
            <span className="user-panel-sub">Loading user details…</span>
          </div>
        </div>
      )}

      {evalError && (
        <div className="eval-error">
          Tutor evaluation failed: {evalError}
        </div>
      )}
      {showEval && evaluation && <TutorEvalPanel evaluation={evaluation} />}

      {open && messages.length > 0 && (
        <div className="transcript-chat">
          <div className="transcript-chat-toolbar">
            <button
              className="transcript-toggle"
              onClick={handleTranslateConversation}
              disabled={translatingConv}
            >
              {translatingConv
                ? "Translating…"
                : showConvTranslation
                  ? "Show Original"
                  : "Translate Conversation"}
            </button>
          </div>
          {messages.map((m, i) => {
            const translated = showConvTranslation && convTranslations
              ? convTranslations[i]
              : null;
            return (
              <div
                key={i}
                className={`chat-bubble chat-bubble--${
                  m.role === "user" ? "user" : "assistant"
                }`}
              >
                <span className="chat-role">{m.role}</span>
                <p className="chat-content">{translated ?? m.text}</p>
                {translated != null && translated !== m.text && (
                  <p className="chat-content chat-content--original">{m.text}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {row.user_improvement_feedback && (
        <div className="lesson-card-feedback">
          <strong>Improvement Feedback:</strong> {row.user_improvement_feedback}
          <button
            className="transcript-toggle"
            style={{ marginLeft: "0.5rem" }}
            onClick={handleTranslate}
            disabled={translating}
          >
            {translating ? "Translating…" : translation ? "Hide Translation" : "Translate"}
          </button>
          {translation && (
            <div style={{ marginTop: "0.35rem", color: "#6b7280", fontStyle: "italic" }}>
              <strong style={{ fontStyle: "normal" }}>Translation:</strong> {translation}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface Props {
  onUserClick?: (userId: string) => void;
}

const AllTranscripts: React.FC<Props> = ({ onUserClick }) => {
  const [rows, setRows] = useState<TranscriptRow[]>([]);
  const [userMeta, setUserMeta] = useState<Map<string, UserMeta>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  // Rating filter is a comparator (</>/=) plus a threshold value.
  const [filterRatingOp, setFilterRatingOp] = useState<"All" | "lt" | "gt" | "eq">("All");
  const [filterRatingValue, setFilterRatingValue] = useState<string>("3");
  const [filterAge, setFilterAge] = useState<string>("All");
  const [filterRegion, setFilterRegion] = useState<string>("All");
  const [filterCountry, setFilterCountry] = useState<string>("All");
  const [filterLanguage, setFilterLanguage] = useState<string>("All");
  const [filterLearningLanguage, setFilterLearningLanguage] = useState<string>("All");
  const [filterDemandTier, setFilterDemandTier] = useState<string>("All");
  const [filterTutor, setFilterTutor] = useState<string>("All");
  // Subscription status filter (ACTIVE / CANCELLED / No status / …), driven by
  // user_info.payment_status — the same value shown in the on-card badge.
  const [filterStatus, setFilterStatus] = useState<string>("All");
  // Device platform filter (iOS / Android / Unknown), driven by
  // user_info.platform — the same value shown in the on-card badge.
  const [filterPlatform, setFilterPlatform] = useState<string>("All");
  // Ended-early filter: "yes" keeps lessons the student ended early, "no" keeps
  // the rest. Only ended_early === true counts as early (matching the badge);
  // false/null are treated as completed normally.
  const [filterEndedEarly, setFilterEndedEarly] = useState<"All" | "yes" | "no">("All");
  // Exit diagnostics from completed_lessons: where the learner dropped off and
  // how the call was torn down. Null on lessons predating these columns, which
  // the NOT_RECORDED option surfaces rather than hides.
  const [filterExitPhase, setFilterExitPhase] = useState<string>("All");
  const [filterExitTrigger, setFilterExitTrigger] = useState<string>("All");
  const [filterLessonInput, setFilterLessonInput] = useState<string>("");
  // "is" matches the given lesson id; "isNot" excludes it.
  const [filterLessonMode, setFilterLessonMode] = useState<"is" | "isNot">("is");
  const [appliedLessonId, setAppliedLessonId] = useState<number | null>(null);

  // Rows ticked for CSV export, keyed by row id. Stores the full row (not just
  // the id) so a selection survives the rows[] reset that the lesson filter
  // triggers — letting you curate across several filters before exporting.
  const [selected, setSelected] = useState<Map<number, TranscriptRow>>(new Map());
  const [exporting, setExporting] = useState(false);

  const loadingRef = useRef(false);
  const offsetRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fetchedUsersRef = useRef<Set<string>>(new Set());

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);

    const from = offsetRef.current;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from(SUPABASE_TABLE)
      .select(
        `id, created_at, user_id, lesson_id, conversation_transcript,
         user_improvement_feedback, user_rating_feedback,
         ended_early, payment_status, word_timeline,
         exit_phase, exit_trigger`,
      );
    if (appliedLessonId !== null) {
      query =
        filterLessonMode === "isNot"
          ? query.neq("lesson_id", appliedLessonId)
          : query.eq("lesson_id", appliedLessonId);
    }
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);

    if (error) {
      setError(`Failed to load transcripts: ${error.message}`);
    } else if (data) {
      const pageRows = data as TranscriptRow[];
      // The table contains duplicate records: the same completion written more
      // than once with a different primary key and created_at (e.g. lesson 42
      // has ids 221277/221278 and 221270/221271 — same user, byte-identical
      // transcripts, seconds apart). Dedupe by content identity — user + lesson
      // + the transcript itself — so each distinct conversation renders once
      // while genuine retakes (a different transcript for the same lesson) are
      // still kept.
      setRows((prev) => {
        const seen = new Set(prev.map(rowDedupeKey));
        const fresh = pageRows.filter((r) => {
          const key = rowDedupeKey(r);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return [...prev, ...fresh];
      });
      offsetRef.current = from + pageRows.length;
      if (pageRows.length < PAGE_SIZE) setHasMore(false);

      const newUserIds = Array.from(
        new Set(
          pageRows
            .map((r) => r.user_id)
            .filter((uid) => !fetchedUsersRef.current.has(uid)),
        ),
      );
      if (newUserIds.length > 0) {
        newUserIds.forEach((uid) => fetchedUsersRef.current.add(uid));
        const { data: users, error: uErr } = await supabase
          .from("user_info")
          .select(USER_INFO_COLUMNS)
          .in("user_id", newUserIds);
        if (!uErr && users) {
          setUserMeta((prev) => {
            const next = new Map(prev);
            (users as unknown as (UserMeta & { user_id: string })[]).forEach((u) => {
              if (!next.has(u.user_id)) {
                const { user_id, ...meta } = u;
                next.set(user_id, meta);
              }
            });
            return next;
          });
        }
      }
    }

    loadingRef.current = false;
    setLoading(false);
  }, [hasMore, appliedLessonId, filterLessonMode]);

  // Debounce raw input → appliedLessonId
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = filterLessonInput.trim();
      if (trimmed === "") {
        setAppliedLessonId(null);
        return;
      }
      const parsed = Number.parseInt(trimmed, 10);
      setAppliedLessonId(Number.isFinite(parsed) ? parsed : null);
    }, 350);
    return () => clearTimeout(handle);
  }, [filterLessonInput]);

  // Initial load + reset whenever the lesson_id filter changes
  useEffect(() => {
    setRows([]);
    setHasMore(true);
    setError(null);
    offsetRef.current = 0;
    loadingRef.current = false;
    fetchedUsersRef.current = new Set();
    loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedLessonId, filterLessonMode]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore]);

  // Window scroll fallback. The IntersectionObserver should handle scroll
  // loading, but `html, body { height: 100% }` plus the sticky sidebar
  // layout in this app can cause the observer's root (the viewport) to
  // miss intersections in some browsers. A direct measurement on every
  // scroll is bulletproof, and loadingRef gates against duplicate calls.
  useEffect(() => {
    const onScroll = () => {
      if (loadingRef.current || !hasMore) return;
      const el = sentinelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.top <= window.innerHeight + 600) {
        loadMore();
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    };
  }, [hasMore, loadMore]);

  const ratingThresholds = ["1", "2", "3", "4", "5"];

  const availableAgeBuckets = React.useMemo(() => {
    const set = new Set<string>();
    userMeta.forEach((u) => set.add(getAgeBucket(u.age)));
    return ["All", ...Array.from(set).sort()];
  }, [userMeta]);

  const availableRegions = React.useMemo(() => {
    const set = new Set<string>();
    userMeta.forEach((u) => set.add(tzToRegion(u.time_zone)));
    return ["All", ...Array.from(set).sort()];
  }, [userMeta]);

  const availableCountries = React.useMemo(() => {
    const set = new Set<string>();
    userMeta.forEach((u) => set.add(getCountryFromTimezone(u.time_zone)));
    return ["All", ...Array.from(set).sort()];
  }, [userMeta]);

  const availableLanguages = React.useMemo(() => {
    const set = new Set<string>();
    userMeta.forEach((u) => { if (u.native_language) set.add(u.native_language); });
    return ["All", ...Array.from(set).sort()];
  }, [userMeta]);

  const availableLearningLanguages = React.useMemo(() => {
    const set = new Set<string>();
    userMeta.forEach((u) => { if (u.learning_language) set.add(u.learning_language); });
    return ["All", ...Array.from(set).sort()];
  }, [userMeta]);

  const availableDemandTiers = React.useMemo(() => {
    const set = new Set<string>();
    userMeta.forEach((u) => { if (u.demand_tier) set.add(u.demand_tier); });
    return ["All", ...Array.from(set).sort()];
  }, [userMeta]);

  const availableTutors = React.useMemo(() => {
    const set = new Set<string>();
    userMeta.forEach((u) => { if (u.tutor) set.add(u.tutor); });
    return ["All", ...Array.from(set).sort()];
  }, [userMeta]);

  const availableStatuses = React.useMemo(() => {
    const set = new Set<string>();
    userMeta.forEach((u) => set.add(statusKey(u.payment_status)));
    const arr = Array.from(set).sort((a, b) => {
      if (a === NO_STATUS) return 1; // keep "No status" last
      if (b === NO_STATUS) return -1;
      return a.localeCompare(b);
    });
    return ["All", ...arr];
  }, [userMeta]);

  const availablePlatforms = React.useMemo(() => {
    const set = new Set<string>();
    userMeta.forEach((u) => set.add(platformKey(u.platform)));
    const arr = Array.from(set).sort((a, b) => {
      if (a === NO_PLATFORM) return 1; // keep "Unknown" last
      if (b === NO_PLATFORM) return -1;
      return a.localeCompare(b);
    });
    return ["All", ...arr];
  }, [userMeta]);

  // Exit options come from the loaded rows (these live on completed_lessons,
  // not user_info) so the chips only ever offer values actually present.
  const availableExitPhases = React.useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(exitKey(r.exit_phase)));
    return exitOptions(set, EXIT_PHASE_META);
  }, [rows]);

  const availableExitTriggers = React.useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(exitKey(r.exit_trigger)));
    return exitOptions(set, EXIT_TRIGGER_META);
  }, [rows]);

  const filteredRows = React.useMemo(() => {
    const threshold = Number(filterRatingValue);
    const now = Date.now();
    return rows.filter((r) => {
      // Hide lessons with a future-dated timestamp — a few completed_lessons
      // rows carry a created_at ahead of now (bad data, e.g. dated weeks out).
      if (new Date(r.created_at).getTime() > now) return false;
      if (filterRatingOp !== "All") {
        const rating = r.user_rating_feedback;
        if (rating == null) return false;
        if (filterRatingOp === "lt" && !(rating < threshold)) return false;
        if (filterRatingOp === "gt" && !(rating > threshold)) return false;
        if (filterRatingOp === "eq" && rating !== threshold) return false;
      }
      if (filterEndedEarly === "yes" && r.ended_early !== true) return false;
      if (filterEndedEarly === "no" && r.ended_early === true) return false;
      if (filterExitPhase !== "All" && exitKey(r.exit_phase) !== filterExitPhase) return false;
      if (filterExitTrigger !== "All" && exitKey(r.exit_trigger) !== filterExitTrigger) return false;
      const meta = userMeta.get(r.user_id);
      if (filterAge !== "All" && getAgeBucket(meta?.age ?? null) !== filterAge) return false;
      if (filterRegion !== "All" && tzToRegion(meta?.time_zone ?? null) !== filterRegion) return false;
      if (filterCountry !== "All" && getCountryFromTimezone(meta?.time_zone ?? null) !== filterCountry) return false;
      if (filterLanguage !== "All" && (meta?.native_language ?? null) !== filterLanguage) return false;
      if (filterLearningLanguage !== "All" && (meta?.learning_language ?? null) !== filterLearningLanguage) return false;
      if (filterDemandTier !== "All" && (meta?.demand_tier ?? null) !== filterDemandTier) return false;
      if (filterTutor !== "All" && (meta?.tutor ?? null) !== filterTutor) return false;
      if (filterStatus !== "All" && statusKey(meta?.payment_status ?? null) !== filterStatus) return false;
      if (filterPlatform !== "All" && platformKey(meta?.platform ?? null) !== filterPlatform) return false;
      return true;
    });
  }, [rows, userMeta, filterRatingOp, filterRatingValue, filterAge, filterRegion, filterCountry, filterLanguage, filterLearningLanguage, filterDemandTier, filterTutor, filterStatus, filterPlatform, filterEndedEarly, filterExitPhase, filterExitTrigger]);

  const toggleSelect = useCallback((row: TranscriptRow) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
      return next;
    });
  }, []);

  const allFilteredSelected =
    filteredRows.length > 0 && filteredRows.every((r) => selected.has(r.id));

  // Add every currently filtered row to the selection (union, not replace).
  const selectAllFiltered = () => {
    setSelected((prev) => {
      const next = new Map(prev);
      filteredRows.forEach((r) => next.set(r.id, r));
      return next;
    });
  };

  const handleExport = async () => {
    if (selected.size === 0 || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const exportRows = Array.from(selected.values()).sort(
        (a, b) => +new Date(b.created_at) - +new Date(a.created_at),
      );
      await exportTranscriptsZip(exportRows, userMeta);
    } catch (e) {
      setError(
        `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setExporting(false);
    }
  };

  const anyFilterActive =
    filterRatingOp !== "All" ||
    filterAge !== "All" ||
    filterRegion !== "All" ||
    filterCountry !== "All" ||
    filterLanguage !== "All" ||
    filterLearningLanguage !== "All" ||
    filterDemandTier !== "All" ||
    filterTutor !== "All" ||
    filterStatus !== "All" ||
    filterPlatform !== "All" ||
    filterEndedEarly !== "All" ||
    filterExitPhase !== "All" ||
    filterExitTrigger !== "All" ||
    filterLessonInput.trim() !== "";

  // Keep loading while the sentinel stays in view.
  // The IntersectionObserver only fires on intersection *transitions*, so when
  // a client-side filter narrows the list enough that the sentinel never
  // leaves the viewport, the observer goes silent after one page. This
  // re-measures the sentinel after each load/filter change and continues
  // loading until the list fills the viewport or the table is exhausted.
  useEffect(() => {
    if (loading || !hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top <= window.innerHeight + 600) {
      loadMore();
    }
  }, [loading, hasMore, filteredRows.length, loadMore]);

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title">
        All Transcripts
        <span className="lessons-detail-count">
          {rows.length} loaded{hasMore ? "+" : ""}
        </span>
      </h2>

      <div className="tx-filters">
        <div className="tx-filters-row">
          <div className="tx-lesson-filter">
            <label className="tx-lesson-mode" data-active={filterLessonMode === "isNot"}>
              <select
                className="tx-chip-select"
                value={filterLessonMode}
                onChange={(e) => setFilterLessonMode(e.target.value as "is" | "isNot")}
                aria-label="Lesson ID match mode"
              >
                <option value="is">Lesson is</option>
                <option value="isNot">Lesson is not</option>
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>
            <div className="tx-search">
              <svg className="tx-search-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
                <path d="m14 14 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                className="tx-search-input"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="Lesson ID…"
                value={filterLessonInput}
                onChange={(e) => setFilterLessonInput(e.target.value)}
              />
              {filterLessonInput.trim() !== "" && (
                <button
                  className="tx-search-clear"
                  onClick={() => setFilterLessonInput("")}
                  title="Clear lesson ID"
                  aria-label="Clear lesson ID"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="tx-chips">
            <div className="tx-chip tx-chip--compound" data-active={filterRatingOp !== "All"}>
              <span className="tx-chip-label">Rating</span>
              <label className="tx-chip-segment">
                <select
                  className="tx-chip-select"
                  value={filterRatingOp}
                  onChange={(e) => setFilterRatingOp(e.target.value as typeof filterRatingOp)}
                  aria-label="Rating comparator"
                >
                  <option value="All">Any</option>
                  <option value="gt">Greater than</option>
                  <option value="lt">Less than</option>
                  <option value="eq">Equals</option>
                </select>
                <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </label>
              {filterRatingOp !== "All" && (
                <label className="tx-chip-segment">
                  <select
                    className="tx-chip-select"
                    value={filterRatingValue}
                    onChange={(e) => setFilterRatingValue(e.target.value)}
                    aria-label="Rating value"
                  >
                    {ratingThresholds.map((s) => (
                      <option key={s} value={s}>{s} ★</option>
                    ))}
                  </select>
                  <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </label>
              )}
            </div>

            <label className="tx-chip" data-active={filterAge !== "All"}>
              <span className="tx-chip-label">Age</span>
              <select
                className="tx-chip-select"
                value={filterAge}
                onChange={(e) => setFilterAge(e.target.value)}
              >
                {availableAgeBuckets.map((a) => (
                  <option key={a} value={a}>{a === "All" ? "Any" : a}</option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterRegion !== "All"}>
              <span className="tx-chip-label">Region</span>
              <select
                className="tx-chip-select"
                value={filterRegion}
                onChange={(e) => setFilterRegion(e.target.value)}
              >
                {availableRegions.map((r) => (
                  <option key={r} value={r}>{r === "All" ? "Any" : r}</option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterCountry !== "All"}>
              <span className="tx-chip-label">Country</span>
              <select
                className="tx-chip-select"
                value={filterCountry}
                onChange={(e) => setFilterCountry(e.target.value)}
              >
                {availableCountries.map((c) => (
                  <option key={c} value={c}>{c === "All" ? "Any" : c}</option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterLanguage !== "All"}>
              <span className="tx-chip-label">Native</span>
              <select
                className="tx-chip-select"
                value={filterLanguage}
                onChange={(e) => setFilterLanguage(e.target.value)}
              >
                {availableLanguages.map((l) => (
                  <option key={l} value={l}>{l === "All" ? "Any" : prettyLang(l)}</option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterLearningLanguage !== "All"}>
              <span className="tx-chip-label">Learning</span>
              <select
                className="tx-chip-select"
                value={filterLearningLanguage}
                onChange={(e) => setFilterLearningLanguage(e.target.value)}
              >
                {availableLearningLanguages.map((l) => (
                  <option key={l} value={l}>{l === "All" ? "Any" : prettyLang(l)}</option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterDemandTier !== "All"}>
              <span className="tx-chip-label">Tier</span>
              <select
                className="tx-chip-select"
                value={filterDemandTier}
                onChange={(e) => setFilterDemandTier(e.target.value)}
              >
                {availableDemandTiers.map((d) => (
                  <option key={d} value={d}>{d === "All" ? "Any" : d}</option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterTutor !== "All"}>
              <span className="tx-chip-label">Tutor</span>
              <select
                className="tx-chip-select"
                value={filterTutor}
                onChange={(e) => setFilterTutor(e.target.value)}
              >
                {availableTutors.map((t) => (
                  <option key={t} value={t}>{t === "All" ? "Any" : t}</option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterStatus !== "All"}>
              <span className="tx-chip-label">Status</span>
              <select
                className="tx-chip-select"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                {availableStatuses.map((s) => (
                  <option key={s} value={s}>{s === "All" ? "Any" : statusFilterLabel(s)}</option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterPlatform !== "All"}>
              <span className="tx-chip-label">Platform</span>
              <select
                className="tx-chip-select"
                value={filterPlatform}
                onChange={(e) => setFilterPlatform(e.target.value)}
              >
                {availablePlatforms.map((p) => (
                  <option key={p} value={p}>{p === "All" ? "Any" : platformFilterLabel(p)}</option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterEndedEarly !== "All"}>
              <span className="tx-chip-label">Ended early</span>
              <select
                className="tx-chip-select"
                value={filterEndedEarly}
                onChange={(e) => setFilterEndedEarly(e.target.value as typeof filterEndedEarly)}
              >
                <option value="All">Any</option>
                <option value="yes">Ended early</option>
                <option value="no">Completed</option>
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterExitPhase !== "All"}>
              <span className="tx-chip-label">Exit phase</span>
              <select
                className="tx-chip-select"
                value={filterExitPhase}
                onChange={(e) => setFilterExitPhase(e.target.value)}
                title="Where the learner dropped off"
              >
                {availableExitPhases.map((p) => (
                  <option key={p} value={p}>
                    {p === "All" ? "Any" : exitFilterLabel(p, EXIT_PHASE_META)}
                  </option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <label className="tx-chip" data-active={filterExitTrigger !== "All"}>
              <span className="tx-chip-label">Exit trigger</span>
              <select
                className="tx-chip-select"
                value={filterExitTrigger}
                onChange={(e) => setFilterExitTrigger(e.target.value)}
                title="How the call was torn down"
              >
                {availableExitTriggers.map((t) => (
                  <option key={t} value={t}>
                    {t === "All" ? "Any" : exitFilterLabel(t, EXIT_TRIGGER_META)}
                  </option>
                ))}
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            {anyFilterActive && (
              <button
                className="tx-clear-btn"
                onClick={() => {
                  setFilterRatingOp("All");
                  setFilterAge("All");
                  setFilterRegion("All");
                  setFilterCountry("All");
                  setFilterLanguage("All");
                  setFilterLearningLanguage("All");
                  setFilterDemandTier("All");
                  setFilterTutor("All");
                  setFilterStatus("All");
                  setFilterPlatform("All");
                  setFilterEndedEarly("All");
                  setFilterExitPhase("All");
                  setFilterExitTrigger("All");
                  setFilterLessonInput("");
                }}
              >
                Clear all
              </button>
            )}
          </div>

          <span className="tx-result-count">
            <strong>{filteredRows.length}</strong> transcript{filteredRows.length === 1 ? "" : "s"}
            {filteredRows.length > 0 && (
              <button
                className="tx-select-all-btn"
                onClick={selectAllFiltered}
                disabled={allFilteredSelected}
              >
                {allFilteredSelected ? "All selected" : "Select all"}
              </button>
            )}
          </span>
        </div>
      </div>

      {error && (
        <div className="error-box" style={{ marginBottom: "1rem" }}>
          <p>{error}</p>
        </div>
      )}

      <div className="lessons-cards">
        {filteredRows.map((r) => (
          <TranscriptCard
            key={r.id}
            row={r}
            user={userMeta.get(r.user_id)}
            onUserClick={onUserClick}
            selected={selected.has(r.id)}
            onToggleSelect={toggleSelect}
          />
        ))}
      </div>

      <div ref={sentinelRef} style={{ height: 1 }} />

      {loading && (
        <div style={{ textAlign: "center", padding: "1.5rem" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Loading more transcripts…</p>
        </div>
      )}

      {!hasMore && rows.length > 0 && (
        <div className="empty-state" style={{ padding: "1.5rem" }}>
          End of transcripts
        </div>
      )}

      {selected.size > 0 && (
        <div className="tx-select-bar">
          <span className="tx-select-bar-count">
            <strong>{selected.size}</strong> selected
          </span>
          {!allFilteredSelected && filteredRows.length > 0 && (
            <button className="tx-select-bar-btn" onClick={selectAllFiltered}>
              Select all {filteredRows.length}
            </button>
          )}
          <button
            className="tx-select-bar-btn"
            onClick={() => setSelected(new Map())}
          >
            Clear
          </button>
          <button
            className="tx-select-bar-btn tx-select-bar-btn--primary"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? "Exporting…" : "Export CSVs (.zip)"}
          </button>
        </div>
      )}
    </div>
  );
};

export default AllTranscripts;
