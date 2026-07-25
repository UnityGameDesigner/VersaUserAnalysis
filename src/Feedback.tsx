import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./lib/supabase";
import { translateCached, getCachedTranslation, translateText } from "./lib/translate";
import { parseTranscript } from "./lib/lessonMetrics";
import { format } from "date-fns";

// One lesson completion that carries written feedback. We only keep rows whose
// user_improvement_feedback is a non-empty string — the field is frequently a
// blank string even when present.
interface FeedbackRow {
  id: number;
  created_at: string;
  user_id: string;
  lesson_id: number;
  conversation_transcript: unknown;
  feedback: string; // trimmed, guaranteed non-empty
  rating: number | null;
}

interface UserMeta {
  preferred_name: string | null;
  native_language: string | null;
  time_zone: string | null;
  payment_status: string | null;
}

const SUPABASE_TABLE = "completed_lessons";
const PAGE_SIZE = 1000;
// How many translations to run at once. Google's gtx endpoint tolerates a
// modest burst; this keeps ~550 entries flowing without tripping rate limits.
const TRANSLATE_CONCURRENCY = 5;

// Stable content fingerprint so the duplicate completion rows the table stores
// (same user + lesson written twice under different ids) collapse to one entry.
function dedupeKey(r: FeedbackRow): string {
  let hash = 5381;
  const s = r.feedback;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  return `${r.user_id}|${r.lesson_id}|${hash}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Conversation viewer (lazy-translatable, reused per card) ──────────────────
// Also imported by the Evaluations tab to show the graded conversation.
export const Conversation: React.FC<{ transcript: unknown }> = ({ transcript }) => {
  const messages = useMemo(() => parseTranscript(transcript), [transcript]);
  const [translations, setTranslations] = useState<string[] | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translating, setTranslating] = useState(false);

  if (messages.length === 0) {
    return <div className="transcript-chat fb-empty-convo">No conversation recorded for this lesson.</div>;
  }

  const handleTranslate = async () => {
    if (translations) {
      setShowTranslation((v) => !v);
      return;
    }
    setTranslating(true);
    try {
      const results = await Promise.all(
        messages.map((m) => (m.text.trim() ? translateText(m.text) : Promise.resolve(m.text))),
      );
      setTranslations(results);
      setShowTranslation(true);
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className="transcript-chat">
      <div className="transcript-chat-toolbar">
        <button className="transcript-toggle" onClick={handleTranslate} disabled={translating}>
          {translating ? "Translating…" : showTranslation ? "Show Original" : "Translate Conversation"}
        </button>
      </div>
      {messages.map((m, i) => {
        const translated = showTranslation && translations ? translations[i] : null;
        return (
          <div
            key={i}
            className={`chat-bubble chat-bubble--${m.role === "user" ? "user" : "assistant"}`}
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
  );
};

// ── Feedback card ─────────────────────────────────────────────────────────────
const FeedbackCard: React.FC<{
  row: FeedbackRow;
  user?: UserMeta;
  english: string | undefined; // resolved translation, or undefined while pending
  showOriginal: boolean;
  onUserClick?: (userId: string) => void;
}> = ({ row, user, english, showOriginal, onUserClick }) => {
  const [open, setOpen] = useState(false);

  const pending = english === undefined;
  const isTranslated = english !== undefined && english !== row.feedback;
  const primary = english ?? row.feedback;

  return (
    <div className="lesson-card fb-card">
      <div className="lesson-card-header">
        <button
          className="lesson-card-user lesson-card-user--clickable"
          title={`View all lessons for ${row.user_id}`}
          onClick={() => onUserClick?.(row.user_id)}
        >
          {user?.preferred_name?.trim() || row.user_id.slice(0, 8) + "…"}
        </button>
        <span className="lesson-card-lesson-id">Lesson #{row.lesson_id}</span>
        <span className="lesson-card-date">
          {format(new Date(row.created_at), "MMM d, yyyy h:mm a")}
        </span>
        {row.rating != null && <span className="lesson-card-rating">{row.rating}★</span>}
        {user?.native_language && (
          <span className="fb-lang-badge">{user.native_language}</span>
        )}
        <button className="transcript-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide Conversation" : "Show Conversation"}
        </button>
      </div>

      <div className="fb-body">
        <p className={`fb-text${pending ? " fb-text--pending" : ""}`}>{primary}</p>
        {isTranslated && showOriginal && (
          <p className="fb-original">
            <span className="fb-original-label">Original</span> {row.feedback}
          </p>
        )}
        {pending && <span className="fb-translating">Translating…</span>}
      </div>

      {open && <Conversation transcript={row.conversation_transcript} />}
    </div>
  );
};

interface Props {
  onUserClick?: (userId: string) => void;
}

type RatingOp = "All" | "lt" | "gt" | "eq";
type SortMode = "newest" | "oldest" | "rating-high" | "rating-low";

const Feedback: React.FC<Props> = ({ onUserClick }) => {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [userMeta, setUserMeta] = useState<Map<string, UserMeta>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // English translation per feedback text (keyed by the trimmed source string so
  // identical feedback shares one entry).
  const [translations, setTranslations] = useState<Map<string, string>>(new Map());
  const [transTotal, setTransTotal] = useState(0);
  const [transDone, setTransDone] = useState(0);

  // Controls
  const [search, setSearch] = useState("");
  const [ratingOp, setRatingOp] = useState<RatingOp>("All");
  const [ratingValue, setRatingValue] = useState("3");
  const [filterLanguage, setFilterLanguage] = useState("All");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [showOriginal, setShowOriginal] = useState(true);

  // ── Load all feedback rows (ACTIVE/TRIAL scope) ─────────────────────────────
  // Scope is resolved through user_info.payment_status (the user's CURRENT
  // status), never through completed_lessons.payment_status: that column is a
  // per-lesson snapshot and stopped being written entirely on 2026-06-06, so
  // filtering on it silently drops every newer lesson.
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // 1. ACTIVE/TRIAL users, with the metadata the cards display.
        const metaMap = new Map<string, UserMeta>();
        let from = 0;
        while (true) {
          const { data: users, error: uErr } = await supabase
            .from("user_info")
            .select("user_id, preferred_name, native_language, time_zone, payment_status")
            .in("payment_status", ["ACTIVE", "TRIAL"])
            .range(from, from + PAGE_SIZE - 1);
          if (uErr) throw new Error(uErr.message);
          (users as Array<UserMeta & { user_id: string }> | null)?.forEach((u) => {
            const { user_id, ...meta } = u;
            metaMap.set(user_id, meta);
          });
          if (!users || users.length < PAGE_SIZE) break;
          from += PAGE_SIZE;
        }
        setUserMeta(metaMap);

        // 2. Their feedback-bearing lessons, fetched per user-id chunk (an .in()
        // filter with every id at once would blow past URL length limits).
        const ids = Array.from(metaMap.keys());
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
        const chunkResults = await Promise.all(
          chunks.map(async (chunk) => {
            const found: FeedbackRow[] = [];
            let lastId = 0;
            let hasMore = true;
            while (hasMore) {
              const { data, error } = await supabase
                .from(SUPABASE_TABLE)
                .select(
                  `id, created_at, user_id, lesson_id, conversation_transcript,
                   user_improvement_feedback, user_rating_feedback`,
                )
                .in("user_id", chunk)
                .not("user_improvement_feedback", "is", null)
                .gt("id", lastId)
                .order("id", { ascending: true })
                .limit(PAGE_SIZE);
              if (error) throw new Error(error.message);
              if (data && data.length > 0) {
                for (const d of data as Array<Record<string, unknown>>) {
                  const fb = String(d.user_improvement_feedback ?? "").trim();
                  if (fb) {
                    found.push({
                      id: d.id as number,
                      created_at: d.created_at as string,
                      user_id: d.user_id as string,
                      lesson_id: d.lesson_id as number,
                      conversation_transcript: d.conversation_transcript,
                      feedback: fb,
                      rating: (d.user_rating_feedback as number | null) ?? null,
                    });
                  }
                }
                lastId = (data[data.length - 1] as { id: number }).id;
                hasMore = data.length === PAGE_SIZE;
              } else {
                hasMore = false;
              }
            }
            return found;
          }),
        );
        const all = chunkResults.flat();

        // Drop duplicate completion records (identical feedback, same user+lesson).
        const seen = new Set<string>();
        const deduped = all.filter((r) => {
          const k = dedupeKey(r);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        setRows(deduped);
      } catch (e: unknown) {
        setError(`Failed to load feedback: ${e instanceof Error ? e.message : "Unknown error"}`);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // ── Auto-translate every feedback entry to English (concurrency-limited) ─────
  // No "already started" guard here: under React StrictMode this effect mounts,
  // is torn down (cancelling its workers), then mounts again. A persistent guard
  // would let the first run get cancelled and then block the restart, stalling
  // translation. Instead we rely on cancellation + the module-level translation
  // cache, so the second run restarts cleanly and reuses anything already
  // fetched. `rows` is set once, so this still runs effectively once in prod.
  useEffect(() => {
    if (rows.length === 0) return;
    let cancelled = false;

    // Unique source strings, seeded from any already-cached translations.
    const unique = Array.from(new Set(rows.map((r) => r.feedback)));
    const seeded = new Map<string, string>();
    const queue: string[] = [];
    for (const t of unique) {
      const cached = getCachedTranslation(t);
      if (cached !== undefined) seeded.set(t, cached);
      else queue.push(t);
    }
    if (seeded.size > 0) setTranslations((prev) => new Map([...prev, ...seeded]));
    setTransTotal(unique.length);
    setTransDone(seeded.size);

    let next = 0;
    const worker = async () => {
      while (!cancelled) {
        const i = next++;
        if (i >= queue.length) return;
        const text = queue[i];
        let result = text;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            result = await translateCached(text);
            break;
          } catch {
            if (attempt === 0) await sleep(600); // one retry on transient failure
          }
        }
        if (cancelled) return;
        setTranslations((prev) => new Map(prev).set(text, result));
        setTransDone((d) => d + 1);
      }
    };

    const workers = Array.from(
      { length: Math.min(TRANSLATE_CONCURRENCY, queue.length) },
      () => worker(),
    );
    Promise.all(workers).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [rows]);

  const availableLanguages = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => {
      const lang = userMeta.get(r.user_id)?.native_language;
      if (lang) set.add(lang);
    });
    return ["All", ...Array.from(set).sort()];
  }, [rows, userMeta]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const threshold = Number(ratingValue);
    const out = rows.filter((r) => {
      if (ratingOp !== "All") {
        if (r.rating == null) return false;
        if (ratingOp === "lt" && !(r.rating < threshold)) return false;
        if (ratingOp === "gt" && !(r.rating > threshold)) return false;
        if (ratingOp === "eq" && r.rating !== threshold) return false;
      }
      if (filterLanguage !== "All" && userMeta.get(r.user_id)?.native_language !== filterLanguage)
        return false;
      if (q) {
        const en = translations.get(r.feedback) ?? "";
        if (!r.feedback.toLowerCase().includes(q) && !en.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    out.sort((a, b) => {
      switch (sortMode) {
        case "oldest":
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "rating-high":
          return (b.rating ?? -1) - (a.rating ?? -1);
        case "rating-low":
          return (a.rating ?? 99) - (b.rating ?? 99);
        case "newest":
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });
    return out;
  }, [rows, userMeta, translations, search, ratingOp, ratingValue, filterLanguage, sortMode]);

  const avgRating = useMemo(() => {
    const rated = rows.filter((r) => r.rating != null);
    if (rated.length === 0) return null;
    return rated.reduce((s, r) => s + (r.rating as number), 0) / rated.length;
  }, [rows]);

  const translating = transTotal > 0 && transDone < transTotal;
  const ratingThresholds = ["1", "2", "3", "4", "5"];

  if (loading) {
    return (
      <div className="loading-container">
        <div style={{ textAlign: "center" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Loading feedback…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-box">
        <h2 className="error-title">Error Loading Feedback</h2>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title">
        Feedback
        <span className="lessons-detail-count">
          {rows.length} entr{rows.length === 1 ? "y" : "ies"}
          {avgRating != null && ` · ${avgRating.toFixed(1)}★ avg`}
          {" · ACTIVE/TRIAL"}
        </span>
      </h2>

      {translating && (
        <div className="fb-progress">
          <div className="fb-progress-bar">
            <div
              className="fb-progress-fill"
              style={{ width: `${transTotal ? (transDone / transTotal) * 100 : 0}%` }}
            />
          </div>
          <span className="fb-progress-label">
            Translating to English… {transDone} / {transTotal}
          </span>
        </div>
      )}

      <div className="tx-filters">
        <div className="tx-filters-row">
          <div className="tx-search">
            <svg className="tx-search-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
              <path d="m14 14 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              className="tx-search-input"
              type="text"
              placeholder="Search feedback…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search.trim() !== "" && (
              <button className="tx-search-clear" onClick={() => setSearch("")} aria-label="Clear search">
                ×
              </button>
            )}
          </div>

          <div className="tx-chips">
            <div className="tx-chip tx-chip--compound" data-active={ratingOp !== "All"}>
              <span className="tx-chip-label">Rating</span>
              <label className="tx-chip-segment">
                <select
                  className="tx-chip-select"
                  value={ratingOp}
                  onChange={(e) => setRatingOp(e.target.value as RatingOp)}
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
              {ratingOp !== "All" && (
                <label className="tx-chip-segment">
                  <select
                    className="tx-chip-select"
                    value={ratingValue}
                    onChange={(e) => setRatingValue(e.target.value)}
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

            <label className="tx-chip" data-active={sortMode !== "newest"}>
              <span className="tx-chip-label">Sort</span>
              <select
                className="tx-chip-select"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="rating-high">Highest rated</option>
                <option value="rating-low">Lowest rated</option>
              </select>
              <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>

            <button
              className="tx-chip fb-toggle"
              data-active={!showOriginal}
              onClick={() => setShowOriginal((v) => !v)}
              title="Show or hide the original (untranslated) feedback under each translation"
            >
              <span className="tx-chip-label">{showOriginal ? "Hide originals" : "Show originals"}</span>
            </button>
          </div>

          <span className="tx-result-count">
            <strong>{filteredRows.length}</strong> result{filteredRows.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="lessons-cards">
        {filteredRows.map((r) => (
          <FeedbackCard
            key={r.id}
            row={r}
            user={userMeta.get(r.user_id)}
            english={translations.get(r.feedback)}
            showOriginal={showOriginal}
            onUserClick={onUserClick}
          />
        ))}
      </div>

      {filteredRows.length === 0 && (
        <div className="empty-state" style={{ padding: "1.5rem" }}>
          No feedback matches these filters.
        </div>
      )}
    </div>
  );
};

export default Feedback;
