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

interface NavState {
  tab: Tab;
  lookupUserId: string | null;
}

type Tab = "dashboard" | "recent" | "lessons" | "transcripts" | "saved" | "evaluations" | "feedback" | "retention" | "cancelled-trials" | "user-lookup" | "ab-compare";

function stateFromHash(): NavState {
  const hash = window.location.hash.replace("#", "");
  const [tab, userId] = hash.split(":");
  const validTabs: Tab[] = ["dashboard", "recent", "lessons", "transcripts", "saved", "evaluations", "feedback", "retention", "cancelled-trials", "user-lookup", "ab-compare"];
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
            className={`sidebar-nav-btn${activeTab === "cancelled-trials" ? " sidebar-nav-btn--active" : ""}`}
            onClick={() => navigate("cancelled-trials")}
          >
            Cancelled Trials
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
              <AllTranscripts onUserClick={handleUserClick} />
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
        ) : activeTab === "cancelled-trials" ? (
          <div className="dashboard-container">
            <div className="dashboard-inner">
              <CancelledTrials onUserClick={handleUserClick} />
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
