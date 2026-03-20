import React, { useState } from "react";
import "./App.css";
import ActiveUserDashboard from "./ActiveUserDashboard";
import CompletedLessons from "./CompletedLessons";
import UserLookup from "./UserLookup";
import ABComparison from "./ABComparison";

type Tab = "dashboard" | "lessons" | "user-lookup" | "ab-compare";

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  return (
    <>
      <nav className="tab-bar">
        <button
          className={`tab-btn${activeTab === "dashboard" ? " tab-btn--active" : ""}`}
          onClick={() => setActiveTab("dashboard")}
        >
          Dashboard
        </button>
        <button
          className={`tab-btn${activeTab === "lessons" ? " tab-btn--active" : ""}`}
          onClick={() => setActiveTab("lessons")}
        >
          Lessons
        </button>
        <button
          className={`tab-btn${activeTab === "user-lookup" ? " tab-btn--active" : ""}`}
          onClick={() => setActiveTab("user-lookup")}
        >
          User Lookup
        </button>
        <button
          className={`tab-btn${activeTab === "ab-compare" ? " tab-btn--active" : ""}`}
          onClick={() => setActiveTab("ab-compare")}
        >
          A/B Compare
        </button>
      </nav>

      {activeTab === "dashboard" ? <ActiveUserDashboard /> : activeTab === "user-lookup" ? <UserLookup /> : activeTab === "ab-compare" ? <ABComparison /> : (
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
