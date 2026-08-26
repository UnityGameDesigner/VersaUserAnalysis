import React from "react";
import {
  speakingRatio,
  estimateLessonDurationMs,
  formatDuration,
  type TranscriptMessage,
} from "./lib/lessonMetrics";

// Per-lesson badge strip shown on each transcript tile — turns, duration,
// speaking ratio, ended-early, exit phase/trigger and mic mode. Shared by the
// All Transcripts page and the User Lookup lesson cards so both stay identical.

// mic_mode: how the learner talked during the call. "button" = press-and-hold
// push-to-talk (the historical default), "auto" = hands-free / AutoMic. Null on
// lessons recorded before the field shipped.
export const MIC_MODE_META: Record<
  string,
  { label: string; icon: string; variant: string; hint: string }
> = {
  auto: {
    label: "Hands-free",
    icon: "🙌",
    variant: "auto",
    hint: "Hands-free / AutoMic — the learner just spoke and the tutor replied when they paused.",
  },
  button: {
    label: "Push-to-talk",
    icon: "👆",
    variant: "button",
    hint: "Press-and-hold mic — the learner held the mic button while speaking.",
  },
};

export function micModeMeta(mode: string | null) {
  if (!mode) return null;
  return MIC_MODE_META[mode] ?? null;
}

// exit_phase (WHERE the learner dropped off) and exit_trigger (HOW the call was
// torn down) on completed_lessons. Values mirror LessonExitPhase /
// LessonExitTrigger in VersaFrontEnd/lib/lessonExit.ts. Both columns are
// additive and nullable and are written best-effort by the client, so lessons
// recorded before they shipped — and any the client failed to write — read null.
export interface ExitMeta {
  label: string;
  variant: string;
  hint: string;
}

// Declaration order is the learner's funnel order and drives option ordering in
// the filters — earliest drop-off first, natural completion last.
export const EXIT_PHASE_META: Record<string, ExitMeta> = {
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

export const EXIT_TRIGGER_META: Record<string, ExitMeta> = {
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
export const NOT_RECORDED = "Not recorded";

// Normalize an exit_phase / exit_trigger into a stable filter key.
export function exitKey(value: string | null): string {
  const v = (value ?? "").trim();
  return v === "" ? NOT_RECORDED : v.toLowerCase();
}

// Resolve a raw column value to its badge/label config. Unrecognized values
// (a client writing something new before this dashboard knows about it) keep
// their raw text rather than vanishing.
export function exitMeta(value: string | null, table: Record<string, ExitMeta>): ExitMeta | null {
  const key = exitKey(value);
  if (key === NOT_RECORDED) return null;
  return table[key] ?? { label: value as string, variant: "neutral", hint: "" };
}

// Human label for an exit filter key.
export function exitFilterLabel(key: string, table: Record<string, ExitMeta>): string {
  return key === NOT_RECORDED ? NOT_RECORDED : (table[key]?.label ?? key);
}

// Build the option list for an exit filter from the values actually loaded,
// ordered by the funnel order the meta table declares. Unknown values sort
// after known ones; NOT_RECORDED always sits last.
export function exitOptions(present: Set<string>, table: Record<string, ExitMeta>): string[] {
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

// early_end_reason: the learner's SELF-REPORTED reason(s) for ending a call
// early — a comma-separated multi-select (e.g. "couldnt_hear_tutor,mic_not_working").
// Distinct from exit_trigger (how the call was torn down). Nullable/best-effort.
export const EARLY_END_REASON_META: Record<string, { label: string; variant: string }> = {
  audio_problems: { label: "Audio problems", variant: "bad" },
  mic_not_working: { label: "Mic not working", variant: "bad" },
  couldnt_hear_tutor: { label: "Couldn't hear tutor", variant: "bad" },
  never_loaded: { label: "Never loaded", variant: "bad" },
  slow_responses: { label: "Slow responses", variant: "bad" },
  couldnt_understand_tutor: { label: "Couldn't understand tutor", variant: "warn" },
  didnt_understand_me: { label: "Didn't understand me", variant: "warn" },
  didnt_know_what_to_do: { label: "Didn't know what to do", variant: "warn" },
  too_easy: { label: "Too easy", variant: "neutral" },
  too_hard: { label: "Too hard", variant: "neutral" },
  wrong_topic: { label: "Wrong topic", variant: "neutral" },
  out_of_time: { label: "Out of time", variant: "neutral" },
  took_too_long: { label: "Took too long", variant: "neutral" },
  just_looking: { label: "Just looking", variant: "neutral" },
  felt_awkward: { label: "Felt awkward", variant: "neutral" },
  boring: { label: "Boring", variant: "neutral" },
  didnt_want_to_chat: { label: "Didn't want to chat", variant: "neutral" },
};

function prettifyReason(raw: string): string {
  return raw
    .trim()
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Split the comma-separated early_end_reason into labelled chips.
export function earlyEndReasons(value: string | null): { label: string; variant: string }[] {
  if (!value || !value.trim()) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => EARLY_END_REASON_META[v.toLowerCase()] ?? { label: prettifyReason(v), variant: "neutral" });
}

// The per-lesson metrics a badge strip can read off a completed_lessons row.
export interface LessonBadgeRow {
  word_timeline: unknown;
  ended_early: boolean | null;
  exit_phase: string | null;
  exit_trigger: string | null;
  early_end_reason: string | null;
  mic_mode: string | null;
}

// The badge strip itself. Render it inside a `.lesson-card-header`, right after
// the rating, to match the All Transcripts tile.
export const LessonBadges: React.FC<{
  row: LessonBadgeRow;
  messages: TranscriptMessage[];
}> = ({ row, messages }) => (
  <>
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
      <span className="lesson-card-badge lesson-card-badge--early">Ended Early</span>
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
    {earlyEndReasons(row.early_end_reason).map((r, i) => (
      <span
        key={i}
        className={`lesson-card-badge lesson-card-badge--exit-${r.variant}`}
        title="Early-end reason — what the learner said when they ended the call early."
      >
        🚪 {r.label}
      </span>
    ))}
    {(() => {
      const mic = micModeMeta(row.mic_mode);
      if (!mic) return null;
      return (
        <span
          className={`lesson-card-badge lesson-card-badge--mic-${mic.variant}`}
          title={`Mic mode — ${mic.hint}`}
        >
          {mic.icon} {mic.label}
        </span>
      );
    })()}
  </>
);
