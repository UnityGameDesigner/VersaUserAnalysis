import React, { useState, useEffect, useRef } from "react";
import { supabase } from "./lib/supabase";
import { translateText } from "./lib/translate";
import { parseTranscript } from "./lib/lessonMetrics";
import { exportTranscriptsZip } from "./lib/exportTranscripts";
import {
  getSavedTranscript,
  isSaved as isTranscriptSaved,
  saveTranscript,
  updateNote,
  deleteSavedTranscript,
} from "./lib/savedStore";
import {
  getSavedProfile,
  isProfileSaved,
  saveProfile,
  updateProfileNote,
  deleteSavedProfile,
} from "./lib/savedProfilesStore";
import { evaluateTutor, type TutorEvaluation } from "./lib/evaluateTutor";
import { getSavedEvaluation, saveEvaluation } from "./lib/evalStore";
import TutorEvalPanel from "./TutorEvalPanel";
import SpeakingProgress from "./SpeakingProgress";
import { LessonBadges } from "./LessonBadges";
import { analyzeCancellation, reasonMeta, type CancelAnalysis } from "./lib/analyzeCancellation";
import { getCancelAnalysis, saveCancelAnalysis } from "./lib/cancelAnalysisStore";
import { format } from "date-fns";

interface UserInfo {
  user_id: string;
  preferred_name: string | null;
  age: number | null;
  gender: string | null;
  native_language: string | null;
  learning_language: string | null;
  level: string | null;
  reason: string | null;
  tutor: string | null;
  daily_streak: number;
  last_logged_in: string | null;
  time_zone: string | null;
  attribution: string | null;
  demand_tier: string | null;
  payment_status: string;
  canceled_at: string | null;
  last_completed_at: string | null;
}

interface NotificationRow {
  id: number;
  bucket: string | null;
  source: string | null;
  status: string | null;
  locale: string | null;
  sent_at: string | null;
  opened_at: string | null;
  error_detail: string | null;
}

interface CompletedLesson {
  id: number;
  created_at: string;
  user_id: string;
  lesson_id: number;
  conversation_transcript: unknown;
  phrase_feedback: unknown;
  user_improvement_feedback: string | null;
  user_rating_feedback: number | null;
  ended_early: boolean | null;
  payment_status: string;
  word_timeline: unknown;
  exit_phase: string | null;
  exit_trigger: string | null;
  early_end_reason: string | null;
  mic_mode: string | null;
}

const NOTIF_STATUS_META: Record<string, { label: string; color: string }> = {
  delivered: { label: "Delivered", color: "#059669" },
  sent: { label: "Sent", color: "#0ea5e9" },
  dead_token: { label: "Dead token", color: "#9ca3af" },
  failed: { label: "Failed", color: "#dc2626" },
  error: { label: "Error", color: "#dc2626" },
};

// Breakdown of the push notifications a user was sent — what types, whether they
// were delivered, and (rarely) opened. Reads user_info's notification_log rows.
const NotificationsPanel: React.FC<{ notifications: NotificationRow[] }> = ({ notifications }) => {
  const total = notifications.length;
  const opened = notifications.filter((n) => n.opened_at).length;
  const statusCount = (s: string) =>
    notifications.filter((n) => (n.status || "").toLowerCase() === s).length;
  const delivered = statusCount("delivered");
  const dead = statusCount("dead_token");
  const failed = statusCount("failed") + statusCount("error");

  const groups = new Map<string, { count: number; opened: number }>();
  notifications.forEach((n) => {
    const k = `${n.source ?? "?"} · ${n.bucket ?? "?"}`;
    const g = groups.get(k) ?? { count: 0, opened: 0 };
    g.count++;
    if (n.opened_at) g.opened++;
    groups.set(k, g);
  });
  const rows = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  const recent = notifications.slice(0, 12);

  return (
    <div className="lookup-lessons-section" style={{ marginTop: "1.5rem" }}>
      <h3 className="lookup-lessons-title">Notifications ({total})</h3>
      {total === 0 ? (
        <div className="empty-state">No notifications on record for this user.</div>
      ) : (
        <>
          <div className="metrics-grid" style={{ marginBottom: "1rem" }}>
            <div className="metric-card">
              <div className="metric-value">{total}</div>
              <div className="metric-label">Sent</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{delivered}</div>
              <div className="metric-label">Delivered</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{dead + failed}</div>
              <div className="metric-label">Dead / Failed</div>
              <div className="metric-description">{dead} dead token · {failed} failed</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{opened}</div>
              <div className="metric-label">Opened</div>
              <div className="metric-description">
                {total > 0 ? `${((opened / total) * 100).toFixed(0)}% open rate` : "—"}
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1rem" }}>
            <div className="table-container">
              <table className="data-table">
                <thead className="table-head">
                  <tr>
                    <th>Type (source · bucket)</th>
                    <th>Sent</th>
                    <th>Opened</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {rows.map(([k, g]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{g.count}</td>
                      <td>{g.opened}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-container">
              <table className="data-table">
                <thead className="table-head">
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {recent.map((n) => {
                    const sm = NOTIF_STATUS_META[(n.status || "").toLowerCase()] ?? {
                      label: n.status || "—",
                      color: "#6b7280",
                    };
                    return (
                      <tr key={n.id}>
                        <td>{n.sent_at ? format(new Date(n.sent_at), "MMM d, h:mm a") : "—"}</td>
                        <td>{`${n.source ?? "?"} · ${n.bucket ?? "?"}`}</td>
                        <td>
                          <span style={{ color: sm.color, fontWeight: 600 }}>{sm.label}</span>
                          {n.opened_at && <span style={{ color: "#4f46e5", marginLeft: "0.4rem" }}>· opened</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          {total > recent.length && (
            <p className="ret-chart-sub" style={{ marginTop: "0.5rem" }}>
              Showing the {recent.length} most recent of {total}.
            </p>
          )}
        </>
      )}
    </div>
  );
};

// LLM-inferred "why they likely cancelled" from the user's call logs + signals.
const CancellationCard: React.FC<{
  user: UserInfo;
  lessons: CompletedLesson[];
  notifications: NotificationRow[];
}> = ({ user, lessons, notifications }) => {
  const [analysis, setAnalysis] = useState<CancelAnalysis | null>(
    () => getCancelAnalysis(user.user_id)?.analysis ?? null,
  );
  const [analyzedAt, setAnalyzedAt] = useState<string | null>(
    () => getCancelAnalysis(user.user_id)?.analyzedAt ?? null,
  );
  const [analyzing, setAnalyzing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setAnalyzing(true);
    setErr(null);
    try {
      const real = lessons.filter((l) => l.lesson_id !== 42);
      const firstLessonAt = lessons.length
        ? [...lessons].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))[0].created_at
        : null;
      const result = await analyzeCancellation({
        userId: user.user_id,
        profile: {
          preferred_name: user.preferred_name,
          learning_language: user.learning_language,
          native_language: user.native_language,
          level: user.level,
          reason: user.reason,
          daily_streak: user.daily_streak,
          first_lesson_at: firstLessonAt,
          last_completed_at: user.last_completed_at,
          canceled_at: user.canceled_at,
        },
        lessons: lessons.map((l) => ({
          lesson_id: l.lesson_id,
          created_at: l.created_at,
          ended_early: l.ended_early,
          user_rating_feedback: l.user_rating_feedback,
          exit_phase: l.exit_phase,
          exit_trigger: l.exit_trigger,
          mic_mode: l.mic_mode,
          conversation_transcript: l.conversation_transcript,
        })),
        notifications: notifications.map((n) => ({
          bucket: n.bucket,
          source: n.source,
          status: n.status,
          sent_at: n.sent_at,
          opened_at: n.opened_at,
        })),
      });
      const at = new Date().toISOString();
      setAnalysis(result);
      setAnalyzedAt(at);
      saveCancelAnalysis({
        userId: user.user_id,
        analyzedAt: at,
        userName: user.preferred_name ?? null,
        lessonCount: real.length,
        analysis: result,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const meta = analysis ? reasonMeta(analysis.primary_reason) : null;

  return (
    <div
      className="lookup-profile-card"
      style={{ marginTop: "1rem", borderLeft: "4px solid #6366f1" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: "1.05rem", color: "#1a1a2e" }}>
          Why they likely cancelled
        </h3>
        <span
          style={{
            fontSize: "0.62rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            color: "#3730a3",
            background: "#eef2ff",
            border: "1px solid #c7d2fe",
            borderRadius: 999,
            padding: "0.1rem 0.45rem",
          }}
        >
          AI · inferred
        </span>
        <button
          className="transcript-toggle transcript-toggle--eval"
          onClick={run}
          disabled={analyzing}
          style={{ marginLeft: "auto" }}
          title="Have Gemini read this user's call logs and signals to infer why they cancelled"
        >
          {analyzing ? "Analyzing…" : analysis ? "Re-analyze" : "Analyze cancellation"}
        </button>
      </div>

      {err && <div className="eval-error" style={{ marginTop: "0.75rem" }}>Analysis failed: {err}</div>}

      {!analysis && !analyzing && !err && (
        <p className="ret-chart-sub" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
          Reads their lesson call-logs, exit signals and notifications and infers the most
          likely reason. It's an inference from behaviour, not a stated reason.
        </p>
      )}

      {analysis && meta && (
        <div style={{ marginTop: "0.85rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
            <span
              style={{
                fontWeight: 700,
                color: "#fff",
                background: meta.color,
                borderRadius: 999,
                padding: "0.2rem 0.7rem",
                fontSize: "0.9rem",
              }}
            >
              {meta.label}
            </span>
            <span style={{ fontSize: "0.78rem", color: "#6b7280" }}>
              {analysis.confidence} confidence
            </span>
          </div>
          <p style={{ margin: "0.6rem 0 0", color: "#374151", lineHeight: 1.55 }}>
            {analysis.summary}
          </p>
          {analysis.contributing_factors && analysis.contributing_factors.length > 0 && (
            <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
              {analysis.contributing_factors.map((f, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: "0.72rem",
                    color: "#4b5563",
                    background: "#f3f4f6",
                    border: "1px solid #e5e7eb",
                    borderRadius: 999,
                    padding: "0.12rem 0.5rem",
                  }}
                >
                  {f}
                </span>
              ))}
            </div>
          )}
          {analysis.evidence && analysis.evidence.length > 0 && (
            <ul style={{ margin: "0.6rem 0 0", paddingLeft: "1.1rem", color: "#6b7280", fontSize: "0.83rem", lineHeight: 1.5 }}>
              {analysis.evidence.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {analyzedAt && (
            <p className="ret-chart-sub" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
              Analyzed {format(new Date(analyzedAt), "MMM d, yyyy h:mm a")}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

const LessonCard: React.FC<{ lesson: CompletedLesson; user: UserInfo }> = ({ lesson: c, user }) => {
  const [open, setOpen] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const messages = parseTranscript(c.conversation_transcript);

  // Bookmark state for the Saved tab, seeded from localStorage so a save (and
  // its note) survives refreshes. Mirrors the All Transcripts card, writing to
  // the same store so anything saved here shows up under Saved → Conversations.
  const [saved, setSaved] = useState(() => isTranscriptSaved(c.id));
  const [note, setNote] = useState(() => getSavedTranscript(c.id)?.note ?? "");
  const [noteOpen, setNoteOpen] = useState(false);

  // Model-graded tutor performance for this conversation, seeded from
  // localStorage so an evaluation survives refreshes and feeds the Evaluations
  // tab. Mirrors the All Transcripts card exactly.
  const [evaluation, setEvaluation] = useState<TutorEvaluation | null>(
    () => getSavedEvaluation(c.id)?.evaluation ?? null,
  );
  const [showEval, setShowEval] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  const toggleSaved = () => {
    if (saved) {
      deleteSavedTranscript(c.id);
      setSaved(false);
      setNoteOpen(false);
      return;
    }
    saveTranscript({
      rowId: c.id,
      userId: c.user_id,
      lessonId: c.lesson_id,
      lessonDate: c.created_at,
      savedAt: new Date().toISOString(),
      userName: user.preferred_name ?? null,
      endedEarly: Boolean(c.ended_early),
      rating: c.user_rating_feedback ?? null,
      turnCount: messages.length,
      note,
    });
    setSaved(true);
    setNoteOpen(true); // reveal the note field so a note can be added right away
  };

  // Live-persist note edits to the already-saved record.
  const handleNoteChange = (value: string) => {
    setNote(value);
    updateNote(c.id, value);
  };

  // Grade the tutor once, then just toggle the panel. evaluateTutor caches by
  // transcript content, so a re-mount of the card won't re-bill either. Writes
  // to the same eval store as All Transcripts, so it also shows in Evaluations.
  const handleEvaluate = async () => {
    if (evaluation) {
      setShowEval((v) => !v);
      return;
    }
    setEvaluating(true);
    setEvalError(null);
    try {
      const result = await evaluateTutor(messages, {
        learningLanguage: user.learning_language,
        nativeLanguage: user.native_language,
        level: user.level,
        reason: user.reason,
        endedEarly: c.ended_early,
      });
      setEvaluation(result);
      setShowEval(true);
      saveEvaluation({
        rowId: c.id,
        userId: c.user_id,
        lessonId: c.lesson_id,
        lessonDate: c.created_at,
        evaluatedAt: new Date().toISOString(),
        userName: user.preferred_name ?? null,
        endedEarly: Boolean(c.ended_early),
        turnCount: messages.length,
        evaluation: result,
      });
    } catch (e) {
      setEvalError(e instanceof Error ? e.message : String(e));
    } finally {
      setEvaluating(false);
    }
  };

  // Per-message translations of the conversation, indexed to match `messages`.
  const [convTranslations, setConvTranslations] = useState<string[] | null>(null);
  const [showConvTranslation, setShowConvTranslation] = useState(false);
  const [translatingConv, setTranslatingConv] = useState(false);

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

  return (
    <div className="lesson-card">
      <div className="lesson-card-header">
        <span className="lesson-card-lesson-id">Lesson #{c.lesson_id}</span>
        <span className="lesson-card-date">
          {format(new Date(c.created_at), "MMM d, yyyy h:mm a")}
        </span>
        {user.canceled_at &&
          new Date(c.created_at).getTime() > new Date(user.canceled_at).getTime() && (
            <span
              className="lesson-card-badge"
              style={{ background: "#ede9fe", color: "#6d28d9", border: "1px solid #ddd6fe" }}
              title="This lesson was completed AFTER the user cancelled"
            >
              After cancel
            </span>
          )}
        {c.user_rating_feedback != null && (
          <span className="lesson-card-rating">
            {c.user_rating_feedback}★
          </span>
        )}
        <LessonBadges row={c} messages={messages} />
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
      </div>

      {saved && noteOpen && (
        <div className="tx-note">
          <label className="tx-note-label" htmlFor={`lookup-note-${c.id}`}>
            Note
          </label>
          <textarea
            id={`lookup-note-${c.id}`}
            className="tx-note-input"
            value={note}
            onChange={(e) => handleNoteChange(e.target.value)}
            placeholder="Why did you save this? (e.g. great correction example, tutor went off-script…)"
            rows={2}
          />
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

      {c.user_improvement_feedback && (
        <div className="lesson-card-feedback">
          <strong>Improvement Feedback:</strong> {c.user_improvement_feedback}
        </div>
      )}

      {evalError && (
        <div className="eval-error">Tutor evaluation failed: {evalError}</div>
      )}
      {showEval && evaluation && <TutorEvalPanel evaluation={evaluation} />}
    </div>
  );
};

const UserLookup: React.FC<{ initialUserId?: string | null }> = ({ initialUserId }) => {
  const [inputId, setInputId] = useState(initialUserId || "");
  const [user, setUser] = useState<UserInfo | null>(null);
  const [lessons, setLessons] = useState<CompletedLesson[]>([]);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Bookmark state for the profile itself (Saved → Profiles). Synced to the
  // saved-profiles store whenever a different user is loaded.
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileNote, setProfileNote] = useState("");
  const [profileNoteOpen, setProfileNoteOpen] = useState(false);

  const handleLookup = async (overrideId?: string) => {
    const trimmed = (overrideId ?? inputId).trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setUser(null);
    setLessons([]);
    setNotifications([]);
    setSearched(true);

    try {
      // Fetch user_info
      const { data: userData, error: userErr } = await supabase
        .from("user_info")
        .select(
          `user_id, preferred_name, age, gender, native_language,
           learning_language, level, reason, tutor, daily_streak, last_logged_in,
           time_zone, attribution, demand_tier, payment_status,
           canceled_at, last_completed_at`,
        )
        .eq("user_id", trimmed)
        .limit(1)
        .single();

      if (userErr) throw new Error(`User not found: ${userErr.message}`);
      setUser(userData);

      // Fetch all completed lessons for this user (paginated)
      let allLessons: CompletedLesson[] = [];
      let lastId = 0;
      let hasMore = true;

      while (hasMore) {
        const { data, error: lessonErr } = await supabase
          .from("completed_lessons")
          .select(
            `id, created_at, user_id, lesson_id, conversation_transcript,
             phrase_feedback, user_improvement_feedback, user_rating_feedback,
             ended_early, payment_status, word_timeline,
             exit_phase, exit_trigger, early_end_reason, mic_mode`,
          )
          .eq("user_id", trimmed)
          .gt("id", lastId)
          .order("id", { ascending: true })
          .limit(1000);

        if (lessonErr) throw new Error(lessonErr.message);

        if (data && data.length > 0) {
          allLessons = [...allLessons, ...data];
          lastId = data[data.length - 1].id;
          hasMore = data.length === 1000;
        } else {
          hasMore = false;
        }
      }

      allLessons.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      setLessons(allLessons);

      // Notifications sent to this user (non-fatal — panel shows none if it fails).
      const { data: notifData, error: notifErr } = await supabase
        .from("notification_log")
        .select("id, bucket, source, status, locale, sent_at, opened_at, error_detail")
        .eq("user_id", trimmed)
        .order("sent_at", { ascending: false })
        .limit(500);
      if (notifErr) {
        console.warn("notification_log fetch failed:", notifErr.message);
        setNotifications([]);
      } else {
        setNotifications((notifData as NotificationRow[]) ?? []);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const didAutoSearch = useRef(false);
  useEffect(() => {
    if (initialUserId && !didAutoSearch.current) {
      didAutoSearch.current = true;
      setInputId(initialUserId);
      handleLookup(initialUserId);
    }
  }, [initialUserId]);

  // Lessons with an empty conversation would export as a header-only CSV, so
  // only the ones that actually hold a transcript are exportable.
  const exportableLessons = lessons.filter(
    (l) => parseTranscript(l.conversation_transcript).length > 0,
  );

  const handleExportAll = async () => {
    if (!user || exporting || exportableLessons.length === 0) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportTranscriptsZip(
        exportableLessons,
        new Map([[user.user_id, user]]),
        user.preferred_name || user.user_id.slice(0, 8),
      );
    } catch (e) {
      setExportError(
        `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setExporting(false);
    }
  };

  const ratedLessons = lessons.filter((l) => l.user_rating_feedback != null);
  const avgRating =
    ratedLessons.length > 0
      ? ratedLessons.reduce((s, l) => s + l.user_rating_feedback!, 0) /
        ratedLessons.length
      : null;
  const earlyCount = lessons.filter((l) => l.ended_early).length;

  // Re-seed the profile bookmark state whenever a new user is loaded (the same
  // mount can look up several users in a row).
  useEffect(() => {
    if (!user) return;
    setProfileSaved(isProfileSaved(user.user_id));
    setProfileNote(getSavedProfile(user.user_id)?.note ?? "");
    setProfileNoteOpen(false);
  }, [user]);

  // Bookmark / un-bookmark this profile for the Saved → Profiles view. Saving
  // captures a snapshot of the stats the profile card shows; the live profile is
  // re-fetched by user_id when reopened from the Saved tab.
  const toggleProfileSaved = () => {
    if (!user) return;
    if (profileSaved) {
      deleteSavedProfile(user.user_id);
      setProfileSaved(false);
      setProfileNoteOpen(false);
      return;
    }
    saveProfile({
      userId: user.user_id,
      savedAt: new Date().toISOString(),
      userName: user.preferred_name ?? null,
      paymentStatus: user.payment_status ?? null,
      dailyStreak: user.daily_streak ?? null,
      lessonsCount: lessons.length,
      avgRating,
      nativeLanguage: user.native_language ?? null,
      learningLanguage: user.learning_language ?? null,
      tutor: user.tutor ?? null,
      demandTier: user.demand_tier ?? null,
      lastLoggedIn: user.last_logged_in ?? null,
      note: profileNote,
    });
    setProfileSaved(true);
    setProfileNoteOpen(true);
  };

  const handleProfileNoteChange = (value: string) => {
    if (!user) return;
    setProfileNote(value);
    updateProfileNote(user.user_id, value);
  };

  return (
    <div className="dashboard-container">
      <div className="dashboard-inner">
        {/* Search Bar */}
        <div className="lookup-search-bar">
          <input
            className="lookup-input"
            type="text"
            placeholder="Enter user ID..."
            value={inputId}
            onChange={(e) => setInputId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          />
          <button
            className="lookup-btn"
            onClick={() => handleLookup()}
            disabled={loading || !inputId.trim()}
          >
            {loading ? "Searching..." : "Look Up"}
          </button>
        </div>

        {error && (
          <div className="error-box">
            <h2 className="error-title">Lookup Error</h2>
            <p>{error}</p>
          </div>
        )}

        {loading && (
          <div className="loading-container">
            <div style={{ textAlign: "center" }}>
              <div className="loading-spinner"></div>
              <p className="loading-text">Fetching user data...</p>
            </div>
          </div>
        )}

        {!loading && searched && !error && user && (
          <>
            {/* User Profile Card */}
            <div className="lookup-profile-card">
              <div className="lookup-profile-header">
                <h2 className="lookup-profile-name">
                  {user.preferred_name || "Unnamed User"}
                </h2>
                <span
                  className={`plan-pill plan-pill--${
                    user.payment_status === "ACTIVE"
                      ? "paying"
                      : user.payment_status === "TRIAL"
                        ? "trial"
                        : "free"
                  }`}
                >
                  {user.payment_status}
                </span>
                <button
                  className="lookup-export-btn"
                  onClick={handleExportAll}
                  disabled={exporting || exportableLessons.length === 0}
                  title={
                    exportableLessons.length === 0
                      ? "This user has no lessons with a transcript"
                      : "Download every transcript for this user as CSVs in a .zip"
                  }
                >
                  {exporting
                    ? "Exporting…"
                    : `Download All Transcripts (${exportableLessons.length})`}
                </button>
                <button
                  className={`transcript-toggle transcript-toggle--save${profileSaved ? " transcript-toggle--saved" : ""}`}
                  onClick={toggleProfileSaved}
                  title={profileSaved ? "Remove from Saved → Profiles" : "Save this profile to the Saved tab"}
                >
                  {profileSaved ? "🔖 Profile Saved" : "🔖 Save Profile"}
                </button>
                {profileSaved && (
                  <button
                    className="transcript-toggle"
                    onClick={() => setProfileNoteOpen((v) => !v)}
                    title="Add or edit a note for this saved profile"
                  >
                    {profileNoteOpen ? "Hide Note" : profileNote.trim() ? "Edit Note" : "Add Note"}
                  </button>
                )}
              </div>
              <p className="lookup-profile-uid">{user.user_id}</p>
              {exportError && (
                <p className="lookup-export-error">{exportError}</p>
              )}
              {profileSaved && profileNoteOpen && (
                <div className="tx-note">
                  <label className="tx-note-label" htmlFor={`lookup-profile-note-${user.user_id}`}>
                    Note
                  </label>
                  <textarea
                    id={`lookup-profile-note-${user.user_id}`}
                    className="tx-note-input"
                    value={profileNote}
                    onChange={(e) => handleProfileNoteChange(e.target.value)}
                    placeholder="Why did you save this profile? (e.g. power user, churn risk, great case study…)"
                    rows={2}
                  />
                </div>
              )}
            </div>

            {/* Why they likely cancelled (AI) — churned users only */}
            {(user.payment_status === "CANCELED" || user.payment_status === "PAST_DUE") && (
              <CancellationCard user={user} lessons={lessons} notifications={notifications} />
            )}

            {/* Stats Grid */}
            <div className="metrics-grid lookup-metrics">
              <div className="metric-card">
                <div className="metric-value">{user.daily_streak}</div>
                <div className="metric-label">Daily Streak</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{lessons.length}</div>
                <div className="metric-label">Lessons Completed</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">
                  {avgRating != null ? avgRating.toFixed(1) + "★" : "—"}
                </div>
                <div className="metric-label">Avg Rating</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{earlyCount}</div>
                <div className="metric-label">Ended Early</div>
              </div>
            </div>

            {/* User Details */}
            <div className="lookup-details-grid">
              {user.age != null && user.age !== -1 && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Age</span>
                  <span className="lookup-detail-value">{user.age}</span>
                </div>
              )}
              {user.gender && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Gender</span>
                  <span className="lookup-detail-value">{user.gender}</span>
                </div>
              )}
              {user.native_language && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Native Language</span>
                  <span className="lookup-detail-value">
                    {user.native_language}
                  </span>
                </div>
              )}
              {user.tutor && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Tutor</span>
                  <span className="lookup-detail-value">{user.tutor}</span>
                </div>
              )}
              {user.time_zone && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Timezone</span>
                  <span className="lookup-detail-value">{user.time_zone}</span>
                </div>
              )}
              {user.attribution && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Attribution</span>
                  <span className="lookup-detail-value">
                    <span className="attribution-pill">{user.attribution}</span>
                  </span>
                </div>
              )}
              {user.demand_tier && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Demand Tier</span>
                  <span className="lookup-detail-value">
                    <span className="level-pill">{user.demand_tier}</span>
                  </span>
                </div>
              )}
              {user.last_logged_in && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Last Logged In</span>
                  <span className="lookup-detail-value">
                    {format(
                      new Date(user.last_logged_in),
                      "MMM d, yyyy h:mm a",
                    )}
                  </span>
                </div>
              )}
              {user.canceled_at && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Cancelled</span>
                  <span className="lookup-detail-value">
                    {format(new Date(user.canceled_at), "MMM d, yyyy h:mm a")}
                  </span>
                </div>
              )}
            </div>

            {/* Notifications sent to this user */}
            <NotificationsPanel notifications={notifications} />

            {/* Speaking trend from word_timeline (rate / fluency / words-per-turn) */}
            <SpeakingProgress lessons={lessons} />

            {/* Lessons */}
            <div className="lookup-lessons-section">
              <h3 className="lookup-lessons-title">
                Completed Lessons ({lessons.length})
                {(() => {
                  const ca = user.canceled_at;
                  const n = ca
                    ? lessons.filter(
                        (l) => new Date(l.created_at).getTime() > new Date(ca).getTime(),
                      ).length
                    : 0;
                  return n > 0 ? (
                    <span style={{ color: "#6d28d9", fontWeight: 600 }}> · {n} after cancel</span>
                  ) : null;
                })()}
              </h3>
              {lessons.length === 0 ? (
                <div className="empty-state">
                  No completed lessons found for this user.
                </div>
              ) : (
                <div className="lessons-cards">
                  {lessons.map((c) => (
                    <LessonCard key={c.id} lesson={c} user={user} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {!loading && searched && !error && !user && (
          <div className="empty-state">No user found with that ID.</div>
        )}

        {!searched && !loading && (
          <div className="empty-state">
            Enter a user ID above to look up their profile and lesson history.
          </div>
        )}
      </div>
    </div>
  );
};

export default UserLookup;
