import React, { useState, useMemo } from "react";
import { supabase } from "./lib/supabase";
import {
  getAllSavedTranscripts,
  deleteSavedTranscript,
  updateNote,
  type SavedTranscript,
} from "./lib/savedStore";
import { Conversation } from "./Feedback";
import { format } from "date-fns";

interface Props {
  onUserClick?: (userId: string) => void;
}

type SortMode = "newest" | "oldest" | "lesson-newest" | "lesson-oldest";

// One bookmarked transcript. The conversation isn't kept in localStorage
// (transcripts are big) — it's fetched from Supabase on demand, exactly like
// the Evaluations tab. The note is editable in place and written through to
// localStorage as you type.
const SavedCard: React.FC<{
  record: SavedTranscript;
  onUserClick?: (userId: string) => void;
  onDelete: (rowId: number) => void;
}> = ({ record, onUserClick, onDelete }) => {
  const [transcript, setTranscript] = useState<unknown>(undefined);
  const [showConvo, setShowConvo] = useState(false);
  const [loadingConvo, setLoadingConvo] = useState(false);
  const [convoError, setConvoError] = useState<string | null>(null);
  const [note, setNote] = useState(record.note);

  const handleShowConversation = async () => {
    if (transcript !== undefined) {
      setShowConvo((v) => !v);
      return;
    }
    setLoadingConvo(true);
    setConvoError(null);
    try {
      const { data, error } = await supabase
        .from("completed_lessons")
        .select("conversation_transcript")
        .eq("id", record.rowId)
        .single();
      if (error) throw new Error(error.message);
      setTranscript(data?.conversation_transcript ?? null);
      setShowConvo(true);
    } catch (e) {
      setConvoError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingConvo(false);
    }
  };

  const handleNoteChange = (value: string) => {
    setNote(value);
    updateNote(record.rowId, value);
  };

  return (
    <div className="lesson-card">
      <div className="lesson-card-header">
        <button
          className="lesson-card-user lesson-card-user--clickable"
          title={`View all lessons for ${record.userId}`}
          onClick={() => onUserClick?.(record.userId)}
        >
          {record.userName?.trim() || record.userId.slice(0, 8) + "…"}
        </button>
        <span className="lesson-card-lesson-id">Lesson #{record.lessonId}</span>
        <span className="lesson-card-date">
          {format(new Date(record.lessonDate), "MMM d, yyyy h:mm a")}
        </span>
        {record.rating != null && (
          <span className="lesson-card-rating">{record.rating}★</span>
        )}
        {record.turnCount != null && (
          <span
            className="lesson-card-badge lesson-card-badge--turns"
            title={`${record.turnCount} conversational turn${record.turnCount === 1 ? "" : "s"} (messages exchanged between student and tutor)`}
          >
            💬 {record.turnCount} turn{record.turnCount === 1 ? "" : "s"}
          </span>
        )}
        {record.endedEarly && (
          <span className="lesson-card-badge lesson-card-badge--early">Ended Early</span>
        )}
        <span className="eval-evaluated-at">
          saved {format(new Date(record.savedAt), "MMM d, h:mm a")}
        </span>
        <button
          className="transcript-toggle"
          onClick={handleShowConversation}
          disabled={loadingConvo}
        >
          {loadingConvo ? "Loading…" : showConvo ? "Hide Conversation" : "Show Conversation"}
        </button>
        <button
          className="transcript-toggle transcript-toggle--danger"
          onClick={() => onDelete(record.rowId)}
          title="Remove this conversation from the Saved tab"
        >
          Remove
        </button>
      </div>

      <div className="tx-note">
        <label className="tx-note-label" htmlFor={`saved-note-${record.rowId}`}>
          Note
        </label>
        <textarea
          id={`saved-note-${record.rowId}`}
          className="tx-note-input"
          value={note}
          onChange={(e) => handleNoteChange(e.target.value)}
          placeholder="Add a note for later…"
          rows={2}
        />
      </div>

      {convoError && <div className="eval-error">Failed to load conversation: {convoError}</div>}
      {showConvo && transcript !== undefined && <Conversation transcript={transcript} />}
    </div>
  );
};

const SavedTranscripts: React.FC<Props> = ({ onUserClick }) => {
  const [records, setRecords] = useState<SavedTranscript[]>(() => getAllSavedTranscripts());
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [search, setSearch] = useState("");

  const handleDelete = (rowId: number) => {
    deleteSavedTranscript(rowId);
    setRecords(getAllSavedTranscripts());
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = records.filter((r) => {
      if (!q) return true;
      return (
        r.note.toLowerCase().includes(q) ||
        (r.userName ?? "").toLowerCase().includes(q) ||
        r.userId.toLowerCase().includes(q) ||
        String(r.lessonId).includes(q)
      );
    });
    out.sort((a, b) => {
      switch (sortMode) {
        case "oldest":
          return +new Date(a.savedAt) - +new Date(b.savedAt);
        case "lesson-newest":
          return +new Date(b.lessonDate) - +new Date(a.lessonDate);
        case "lesson-oldest":
          return +new Date(a.lessonDate) - +new Date(b.lessonDate);
        case "newest":
        default:
          return +new Date(b.savedAt) - +new Date(a.savedAt);
      }
    });
    return out;
  }, [records, sortMode, search]);

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title">
        Saved Conversations
        <span className="lessons-detail-count">{records.length} saved</span>
      </h2>

      {records.length > 0 && (
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
                placeholder="Search notes, user, lesson…"
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
              <label className="tx-chip" data-active={sortMode !== "newest"}>
                <span className="tx-chip-label">Sort</span>
                <select
                  className="tx-chip-select"
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                >
                  <option value="newest">Recently saved</option>
                  <option value="oldest">Oldest saved</option>
                  <option value="lesson-newest">Newest lesson</option>
                  <option value="lesson-oldest">Oldest lesson</option>
                </select>
                <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </label>
            </div>

            <span className="tx-result-count">
              <strong>{visible.length}</strong> result{visible.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}

      <div className="lessons-cards">
        {visible.map((r) => (
          <SavedCard
            key={r.rowId}
            record={r}
            onUserClick={onUserClick}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {records.length === 0 && (
        <div className="empty-state" style={{ padding: "1.5rem" }}>
          No saved conversations yet — open All Transcripts and click “🔖 Save” on a
          conversation. Saved ones show up here with whatever note you add.
        </div>
      )}

      {records.length > 0 && visible.length === 0 && (
        <div className="empty-state" style={{ padding: "1.5rem" }}>
          No saved conversations match this search.
        </div>
      )}
    </div>
  );
};

export default SavedTranscripts;
