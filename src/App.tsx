import React, { useState } from "react";
import "./App.css";
import ActiveUserDashboard from "./ActiveUserDashboard";
import CompletedLessons from "./CompletedLessons";

type Tab = "dashboard" | "lessons";

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
      </nav>

      {activeTab === "dashboard" ? <ActiveUserDashboard /> : (
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
