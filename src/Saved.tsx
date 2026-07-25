import React, { useState } from "react";
import SavedTranscripts from "./SavedTranscripts";
import SavedProfiles from "./SavedProfiles";

interface Props {
  onUserClick?: (userId: string) => void;
}

type SavedView = "conversations" | "profiles";

// Wraps the two Saved views (bookmarked conversations and bookmarked profiles)
// behind a sub-tab bar. Both are independent localStorage-backed stores.
const Saved: React.FC<Props> = ({ onUserClick }) => {
  const [view, setView] = useState<SavedView>("conversations");

  return (
    <>
      <div className="tab-bar">
        <button
          className={`tab-btn${view === "conversations" ? " tab-btn--active" : ""}`}
          onClick={() => setView("conversations")}
        >
          Conversations
        </button>
        <button
          className={`tab-btn${view === "profiles" ? " tab-btn--active" : ""}`}
          onClick={() => setView("profiles")}
        >
          Profiles
        </button>
      </div>

      {view === "conversations" ? (
        <SavedTranscripts onUserClick={onUserClick} />
      ) : (
        <SavedProfiles onUserClick={onUserClick} />
      )}
    </>
  );
};

export default Saved;
