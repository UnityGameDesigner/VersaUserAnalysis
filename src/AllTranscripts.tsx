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
}

const USER_INFO_COLUMNS =
  "user_id, preferred_name, age, gender, native_language, learning_language, " +
  "level, reason, daily_streak, time_zone, attribution, tutor, tutor_accent, " +
  "demand_tier, messaging_platform, previous_experience, completed_tutorial, " +
  "lesson_credits, is_creator, left_review, upsell, last_logged_in, payment_status";

// Map a payment_status to a badge variant + label.
function statusBadge(status: string | null): { variant: string; label: string } {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE") return { variant: "active", label: "Active" };
  if (s === "TRIAL") return { variant: "trial", label: "Trial" };
  if (!s) return { variant: "inactive", label: "No status" };
  // FREE / EXPIRED / CANCELLED / anything else
  return { variant: "inactive", label: status as string };
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

function truncate(s: string, max = 48): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// previous_experience is stored as "frequency:x,context:y,history:z,goal:w" —
// 4 answers to the onboarding situational assessment. Config mirrors
// VersaFrontEnd/components/onboarding/SituationalAssessment.tsx.
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
const EXPERIENCE_QUESTIONS: ExpQuestion[] = [
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

interface ExpAnswer {
  key: string;
  category: string;
  question: string;
  emoji: string;
  short: string;
  full: string;
  answered: boolean;
}

// Parse the "key:value,key:value" string into resolved Q&A answers.
function parseExperience(raw: string | null): ExpAnswer[] {
  if (!raw || !raw.trim()) return [];
  const pairs = new Map<string, string>();
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    pairs.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  if (pairs.size === 0) return [];
  return EXPERIENCE_QUESTIONS.map((q) => {
    const val = pairs.get(q.key);
    const opt = q.options.find((o) => o.value === val);
    if (opt) {
      return {
        key: q.key,
        category: q.category,
        question: q.question,
        emoji: opt.emoji,
        short: opt.short,
        full: opt.label,
        answered: true,
      };
    }
    return {
      key: q.key,
      category: q.category,
      question: q.question,
      emoji: "❔",
      short: "Not answered",
      full: val ? `Unknown (${val})` : "Not answered",
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
}> = ({ row, user, onUserClick }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [translation, setTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  // Per-message translations of the conversation, indexed to match `messages`.
  const [convTranslations, setConvTranslations] = useState<string[] | null>(null);
  const [showConvTranslation, setShowConvTranslation] = useState(false);
  const [translatingConv, setTranslatingConv] = useState(false);

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
  return (
    <div className="lesson-card">
      <div className="lesson-card-header">
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
      </div>

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
            const exp = parseExperience(user.previous_experience);
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
  const [filterDemandTier, setFilterDemandTier] = useState<string>("All");
  // Subscription status filter (ACTIVE / CANCELLED / No status / …), driven by
  // user_info.payment_status — the same value shown in the on-card badge.
  const [filterStatus, setFilterStatus] = useState<string>("All");
  const [filterLessonInput, setFilterLessonInput] = useState<string>("");
  // "is" matches the given lesson id; "isNot" excludes it.
  const [filterLessonMode, setFilterLessonMode] = useState<"is" | "isNot">("is");
  const [appliedLessonId, setAppliedLessonId] = useState<number | null>(null);

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
         ended_early, payment_status, word_timeline`,
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

  const availableDemandTiers = React.useMemo(() => {
    const set = new Set<string>();
    userMeta.forEach((u) => { if (u.demand_tier) set.add(u.demand_tier); });
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

  const filteredRows = React.useMemo(() => {
    const threshold = Number(filterRatingValue);
    return rows.filter((r) => {
      if (filterRatingOp !== "All") {
        const rating = r.user_rating_feedback;
        if (rating == null) return false;
        if (filterRatingOp === "lt" && !(rating < threshold)) return false;
        if (filterRatingOp === "gt" && !(rating > threshold)) return false;
        if (filterRatingOp === "eq" && rating !== threshold) return false;
      }
      const meta = userMeta.get(r.user_id);
      if (filterAge !== "All" && getAgeBucket(meta?.age ?? null) !== filterAge) return false;
      if (filterRegion !== "All" && tzToRegion(meta?.time_zone ?? null) !== filterRegion) return false;
      if (filterCountry !== "All" && getCountryFromTimezone(meta?.time_zone ?? null) !== filterCountry) return false;
      if (filterLanguage !== "All" && (meta?.native_language ?? null) !== filterLanguage) return false;
      if (filterDemandTier !== "All" && (meta?.demand_tier ?? null) !== filterDemandTier) return false;
      if (filterStatus !== "All" && statusKey(meta?.payment_status ?? null) !== filterStatus) return false;
      return true;
    });
  }, [rows, userMeta, filterRatingOp, filterRatingValue, filterAge, filterRegion, filterCountry, filterLanguage, filterDemandTier, filterStatus]);

  const anyFilterActive =
    filterRatingOp !== "All" ||
    filterAge !== "All" ||
    filterRegion !== "All" ||
    filterCountry !== "All" ||
    filterLanguage !== "All" ||
    filterDemandTier !== "All" ||
    filterStatus !== "All" ||
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
              <span className="tx-chip-label">Language</span>
              <select
                className="tx-chip-select"
                value={filterLanguage}
                onChange={(e) => setFilterLanguage(e.target.value)}
              >
                {availableLanguages.map((l) => (
                  <option key={l} value={l}>{l === "All" ? "Any" : l}</option>
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

            {anyFilterActive && (
              <button
                className="tx-clear-btn"
                onClick={() => {
                  setFilterRatingOp("All");
                  setFilterAge("All");
                  setFilterRegion("All");
                  setFilterCountry("All");
                  setFilterLanguage("All");
                  setFilterDemandTier("All");
                  setFilterStatus("All");
                  setFilterLessonInput("");
                }}
              >
                Clear all
              </button>
            )}
          </div>

          <span className="tx-result-count">
            <strong>{filteredRows.length}</strong> transcript{filteredRows.length === 1 ? "" : "s"}
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
    </div>
  );
};

export default AllTranscripts;
