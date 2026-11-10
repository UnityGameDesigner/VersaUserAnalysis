// Onboarding situational assessment (user_info.previous_experience) parsing,
// shared by All Transcripts and User Lookup.

// native_language / learning_language are stored as lowercase codes
// ("english", "spanish", "brazilian portuguese"). Titlecase them for display
// while the raw code stays the filter value.
export function prettyLang(code: string): string {
  return code
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
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

export interface ExpAnswer {
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
export function parseExperience(
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

// The onboarding "How much of the language can you speak right now?" answer,
// surfaced as its own at-a-glance meter (level 1–4 → filled segments + colour)
// rather than buried among the other assessment chips. Only the newer assessment
// format records it (previous_experience contains an `ability:` token); returns
// null when it's absent, so the strip simply doesn't render.
const ABILITY_META: Record<string, { level: number; label: string; color: string; emoji: string }> = {
  none: { level: 1, label: "Starting from zero", color: "#ef4444", emoji: "🌱" },
  words: { level: 2, label: "A few words", color: "#f97316", emoji: "🐣" },
  simple: { level: 3, label: "Simple conversations", color: "#84cc16", emoji: "💬" },
  comfortable: { level: 4, label: "Comfortable — most topics", color: "#22c55e", emoji: "💪" },
};
export function speakingAbility(prev: string | null): { level: number; label: string; color: string; emoji: string } | null {
  if (!prev) return null;
  const m = /ability:([a-zA-Z]+)/.exec(prev);
  return m ? (ABILITY_META[m[1]] ?? null) : null;
}
