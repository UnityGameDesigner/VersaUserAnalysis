import React, { useState, useEffect, useRef } from "react";
import "./App.css";
import ActiveUserDashboard from "./ActiveUserDashboard";
import CompletedLessons from "./CompletedLessons";
import UserLookup from "./UserLookup";
import ABComparison from "./ABComparison";
import AllTranscripts from "./AllTranscripts";
import Saved from "./Saved";
import RetentionAnalysis from "./RetentionAnalysis";
import Feedback from "./Feedback";
import Evaluations from "./Evaluations";
import RecentUsers from "./RecentUsers";
import CancelledTrials from "./CancelledTrials";
import TutorComparison from "./TutorComparison";
import TrialRetention from "./TrialRetention";
import TrialConversion from "./TrialConversion";
import CancelReasons from "./CancelReasons";
import { loadSavedProfiles } from "./lib/savedProfilesStore";

interface NavState {
  tab: Tab;
  lookupUserId: string | null;
}

type Tab = "dashboard" | "recent" | "lessons" | "transcripts" | "saved" | "evaluations" | "feedback" | "retention" | "trial-retention" | "trial-conversion" | "cancelled-trials" | "cancel-reasons" | "tutor-comparison" | "user-lookup" | "ab-compare";

function stateFromHash(): NavState {
  const hash = window.location.hash.replace("#", "");
  const [tab, userId] = hash.split(":");
  const validTabs: Tab[] = ["dashboard", "recent", "lessons", "transcripts", "saved", "evaluations", "feedback", "retention", "trial-retention", "trial-conversion", "cancelled-trials", "cancel-reasons", "tutor-comparison", "user-lookup", "ab-compare"];
  return {
    tab: validTabs.includes(tab as Tab) ? (tab as Tab) : "dashboard",
    lookupUserId: userId || null,
  };
}

function hashFromState(state: NavState): string {
  return state.lookupUserId
    ? `#${state.tab}:${state.lookupUserId}`
    : `#${state.tab}`;
}

const App: React.FC = () => {
  const [navState, setNavState] = useState<NavState>(stateFromHash);
  const isPop = useRef(false);

  // Hydrate the durable saved-profiles set from Supabase once on startup, so
  // bookmarks survive server restarts / port changes and show as saved in User
  // Lookup even before the Saved page is opened.
  useEffect(() => {
    loadSavedProfiles().catch(() => {});
  }, []);

  const navigate = (tab: Tab, userId: string | null = null) => {
    const state: NavState = { tab, lookupUserId: userId };
    const hash = hashFromState(state);
    window.history.pushState(state, "", hash);
    setNavState(state);
  };

  const handleUserClick = (userId: string) => {
    navigate("user-lookup", userId);
  };

  // Listen for browser back/forward
  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      isPop.current = true;
      if (e.state && typeof e.state.tab === "string") {
        setNavState(e.state as NavState);
      } else {
        setNavState(stateFromHash());
      }
    };
    window.addEventListener("popstate", onPopState);

    // Replace initial state so first back works
    const initial = stateFromHash();
    window.history.replaceState(initial, "", hashFromState(initial));

    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const activeTab = navState.tab;
  const lookupUserId = navState.lookupUserId;

  return (
    <div className="app-layout">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <img src="AppIcon.png" alt="Versa Logo" className="versa-logo" />
          <h1 className="sidebar-title">Versa User Analysis</h1>
        </div>

        <nav className="sidebar-nav">
          <button
            className={`sidebar-nav-btn${activeTab === "dashboard" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "recent" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("recent")}
          >
            Recent Users
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "lessons" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("lessons")}
          >
            Lessons
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "transcripts" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("transcripts")}
          >
            All Transcripts
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "saved" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("saved")}
          >
            Saved
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "evaluations" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("evaluations")}
          >
            Evaluations
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "feedback" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("feedback")}
          >
            Feedback
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "retention" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("retention")}
          >
            Retention
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "trial-retention" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("trial-retention")}
          >
            Trial Retention
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "trial-conversion" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("trial-conversion")}
          >
            Trial Conversion
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "cancelled-trials" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("cancelled-trials")}
          >
            Cancelled Trials
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "cancel-reasons" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("cancel-reasons")}
          >
            Cancel Reasons
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "tutor-comparison" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("tutor-comparison")}
          >
            Tutor Comparison
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "user-lookup" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("user-lookup")}
          >
            User Lookup
          </button>
          <button
            className={`sidebar-nav-btn${activeTab === "ab-compare" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("ab-compare")}
          >
            A/B Compare
          </button>
        </nav>
      </aside>

      <main className="app-main">
        {activeTab === "dashboard" ? (
          <ActiveUserDashboard onUserClick={handleUserClick} />
        ) : activeTab === "recent" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <RecentUsers />
            </div>
          </div>
        ) : activeTab === "user-lookup" ? (
          <UserLookup key={lookupUserId ?? "empty"} initialUserId={lookupUserId} />
        ) : activeTab === "ab-compare" ? (
          <ABComparison />
        ) : activeTab === "transcripts" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <AllTranscripts />
            </div>
          </div>
        ) : activeTab === "saved" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <Saved onUserClick={handleUserClick} />
            </div>
          </div>
        ) : activeTab === "evaluations" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <Evaluations onUserClick={handleUserClick} />
            </div>
          </div>
        ) : activeTab === "feedback" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <Feedback onUserClick={handleUserClick} />
            </div>
          </div>
        ) : activeTab === "retention" ? (
          <RetentionAnalysis onUserClick={handleUserClick} />
        ) : activeTab === "trial-retention" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <TrialRetention />
            </div>
          </div>
        ) : activeTab === "trial-conversion" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <TrialConversion />
            </div>
          </div>
        ) : activeTab === "cancelled-trials" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <CancelledTrials onUserClick={handleUserClick} />
            </div>
          </div>
        ) : activeTab === "cancel-reasons" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <CancelReasons onUserClick={handleUserClick} />
            </div>
          </div>
        ) : activeTab === "tutor-comparison" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <TutorComparison onUserClick={handleUserClick} />
            </div>
          </div>
        ) : (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <CompletedLessons />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
