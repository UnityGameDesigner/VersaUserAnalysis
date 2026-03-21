import React, { useState, useEffect, useRef } from "react";
import "./App.css";
import ActiveUserDashboard from "./ActiveUserDashboard";
import CompletedLessons from "./CompletedLessons";
import UserLookup from "./UserLookup";
import ABComparison from "./ABComparison";

interface NavState {
  tab: Tab;
  lookupUserId: string | null;
}

type Tab = "dashboard" | "lessons" | "user-lookup" | "ab-compare";

function stateFromHash(): NavState {
  const hash = window.location.hash.replace("#", "");
  const [tab, userId] = hash.split(":");
  const validTabs: Tab[] = ["dashboard", "lessons", "user-lookup", "ab-compare"];
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
    <>
      <nav className="tab-bar">
        <button
          className={`tab-btn${activeTab === "dashboard" ? " tab-btn--active" : ""}`}
          onClick={() => navigate("dashboard")}
        >
          Dashboard
        </button>
        <button
          className={`tab-btn${activeTab === "lessons" ? " tab-btn--active" : ""}`}
          onClick={() => navigate("lessons")}
        >
          Lessons
        </button>
        <button
          className={`tab-btn${activeTab === "user-lookup" ? " tab-btn--active" : ""}`}
          onClick={() => navigate("user-lookup")}
        >
          User Lookup
        </button>
        <button
          className={`tab-btn${activeTab === "ab-compare" ? " tab-btn--active" : ""}`}
          onClick={() => navigate("ab-compare")}
        >
          A/B Compare
        </button>
      </nav>

      {activeTab === "dashboard" ? (
        <ActiveUserDashboard onUserClick={handleUserClick} />
      ) : activeTab === "user-lookup" ? (
        <UserLookup key={lookupUserId ?? "empty"} initialUserId={lookupUserId} />
      ) : activeTab === "ab-compare" ? (
        <ABComparison />
      ) : (
        <div className="dashboard-container">
          <div className="dashboard-inner">
            <CompletedLessons />
          </div>
        </div>
      )}
    </>
  );
};

export default App;
