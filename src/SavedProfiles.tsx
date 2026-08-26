import React, { useState, useMemo, useEffect } from "react";
import {
  getAllSavedProfiles,
  loadSavedProfiles,
  deleteSavedProfile,
  updateProfileNote,
  type SavedProfile,
} from "./lib/savedProfilesStore";
import { format } from "date-fns";

interface Props {
  onUserClick?: (userId: string) => void;
}

type SortMode = "newest" | "oldest" | "name";

// One bookmarked profile. Only a metadata snapshot is kept in localStorage — the
// live profile and its lessons are re-fetched by user_id when you click through
// to User Lookup. The note is editable in place and written through as you type.
const ProfileCard: React.FC<{
  record: SavedProfile;
  onUserClick?: (userId: string) => void;
  onDelete: (userId: string) => void;
}> = ({ record, onUserClick, onDelete }) => {
  const [note, setNote] = useState(record.note);

  const handleNoteChange = (value: string) => {
    setNote(value);
    updateProfileNote(record.userId, value);
  };

  const planVariant =
    record.paymentStatus === "ACTIVE"
      ? "paying"
      : record.paymentStatus === "TRIAL"
        ? "trial"
        : "free";

  return (
    <div className="lesson-card">
      <div className="lesson-card-header">
        <button
          className="lesson-card-user lesson-card-user--clickable"
          title={`Open ${record.userName?.trim() || record.userId} in User Lookup`}
          onClick={() => onUserClick?.(record.userId)}
        >
          {record.userName?.trim() || record.userId.slice(0, 8) + "…"}
        </button>
        {record.paymentStatus && (
          <span className={`plan-pill plan-pill--${planVariant}`}>
            {record.paymentStatus}
          </span>
        )}
        {record.demandTier && (
          <span className="level-pill">{record.demandTier}</span>
        )}
        <span className="eval-evaluated-at">
          saved {format(new Date(record.savedAt), "MMM d, h:mm a")}
        </span>
        <button
          className="transcript-toggle transcript-toggle--danger"
          onClick={() => onDelete(record.userId)}
          title="Remove this profile from the Saved tab"
        >
          Remove
        </button>
      </div>

      {/* Snapshot stats captured when the profile was saved */}
      <div className="saved-profile-stats">
        <span className="saved-profile-stat">
          <strong>{record.dailyStreak ?? "—"}</strong> day streak
        </span>
        <span className="saved-profile-stat">
          <strong>{record.lessonsCount ?? "—"}</strong> lessons
        </span>
        <span className="saved-profile-stat">
          <strong>
            {record.avgRating != null ? record.avgRating.toFixed(1) + "★" : "—"}
          </strong>{" "}
          avg rating
        </span>
        {record.learningLanguage && (
          <span className="saved-profile-stat">
            learning <strong>{record.learningLanguage}</strong>
          </span>
        )}
        {record.nativeLanguage && (
          <span className="saved-profile-stat">
            native <strong>{record.nativeLanguage}</strong>
          </span>
        )}
        {record.tutor && (
          <span className="saved-profile-stat">
            tutor <strong>{record.tutor}</strong>
          </span>
        )}
        {record.lastLoggedIn && (
          <span className="saved-profile-stat">
            last login{" "}
            <strong>{format(new Date(record.lastLoggedIn), "MMM d, yyyy")}</strong>
          </span>
        )}
      </div>

      <div className="tx-note">
        <label className="tx-note-label" htmlFor={`saved-profile-note-${record.userId}`}>
          Note
        </label>
        <textarea
          id={`saved-profile-note-${record.userId}`}
          className="tx-note-input"
          value={note}
          onChange={(e) => handleNoteChange(e.target.value)}
          placeholder="Add a note for later…"
          rows={2}
        />
      </div>
    </div>
  );
};

const SavedProfiles: React.FC<Props> = ({ onUserClick }) => {
  const [records, setRecords] = useState<SavedProfile[]>(() => getAllSavedProfiles());
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [search, setSearch] = useState("");

  // Hydrate from the durable Supabase store on open (recovers saves after a
  // server restart / port change / different browser).
  useEffect(() => {
    let active = true;
    loadSavedProfiles().then((list) => {
      if (active) setRecords(list);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleDelete = (userId: string) => {
    deleteSavedProfile(userId);
    setRecords(getAllSavedProfiles());
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = records.filter((r) => {
      if (!q) return true;
      return (
        r.note.toLowerCase().includes(q) ||
        (r.userName ?? "").toLowerCase().includes(q) ||
        r.userId.toLowerCase().includes(q) ||
        (r.tutor ?? "").toLowerCase().includes(q) ||
        (r.learningLanguage ?? "").toLowerCase().includes(q)
      );
    });
    out.sort((a, b) => {
      switch (sortMode) {
        case "oldest":
          return +new Date(a.savedAt) - +new Date(b.savedAt);
        case "name":
          return (a.userName ?? "").localeCompare(b.userName ?? "");
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
        Saved Profiles
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
                placeholder="Search notes, name, user, tutor…"
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
                  <option value="name">Name (A–Z)</option>
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
          <ProfileCard
            key={r.userId}
            record={r}
            onUserClick={onUserClick}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {records.length === 0 && (
        <div className="empty-state" style={{ padding: "1.5rem" }}>
          No saved profiles yet — open User Lookup, search a user, and click
          “🔖 Save Profile”. Saved ones show up here with whatever note you add.
        </div>
      )}

      {records.length > 0 && visible.length === 0 && (
        <div className="empty-state" style={{ padding: "1.5rem" }}>
          No saved profiles match this search.
        </div>
      )}
    </div>
  );
};

export default SavedProfiles;
