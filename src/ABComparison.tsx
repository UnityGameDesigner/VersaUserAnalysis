import React, { useState } from "react";
import { supabase } from "./lib/supabase";

interface CompletedLesson {
  id: number;
  created_at: string;
  user_id: string;
  lesson_id: number;
  version: string | null;
  conversation_transcript: unknown;
  user_improvement_feedback: string | null;
  user_rating_feedback: number | null;
  payment_status: string;
}

interface VersionStats {
  count: number;
  activeCount: number;
  ratings: number[];
  avgRating: number | null;
  feedbacks: string[];
  avgTurns: number | null;
  totalWithTranscript: number;
}

function countTurns(raw: unknown): number | null {
  if (!raw) return null;
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return null;
    return arr.filter(
      (m: unknown) =>
        typeof m === "object" && m !== null && "role" in m && (m as Record<string, unknown>).role !== "ack",
    ).length;
  } catch {
    return null;
  }
}

function computeStats(lessons: CompletedLesson[]): VersionStats {
  const activeCount = lessons.filter((l) => l.payment_status === "ACTIVE").length;
  const ratings = lessons
    .filter((l) => l.user_rating_feedback != null)
    .map((l) => l.user_rating_feedback!);
  const avgRating =
    ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  const feedbacks = lessons
    .filter((l) => l.user_improvement_feedback)
    .map((l) => l.user_improvement_feedback!);

  const turnCounts = lessons
    .map((l) => countTurns(l.conversation_transcript))
    .filter((t): t is number => t != null);
  const avgTurns =
    turnCounts.length > 0 ? turnCounts.reduce((a, b) => a + b, 0) / turnCounts.length : null;

  return { count: lessons.length, activeCount, ratings, avgRating, feedbacks, avgTurns, totalWithTranscript: turnCounts.length };
}

const PAGE_SIZE = 1000;

const ABComparison: React.FC = () => {
  const [lessonIdInput, setLessonIdInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [lessonId, setLessonId] = useState<number | null>(null);
  const [testStats, setTestStats] = useState<VersionStats | null>(null);
  const [controlStats, setControlStats] = useState<VersionStats | null>(null);

  const handleLookup = async () => {
    const parsed = parseInt(lessonIdInput.trim(), 10);
    if (isNaN(parsed)) return;

    setLoading(true);
    setError(null);
    setSearched(true);
    setLessonId(parsed);
    setTestStats(null);
    setControlStats(null);

    try {
      let allLessons: CompletedLesson[] = [];
      let lastId = 0;
      let hasMore = true;

      while (hasMore) {
        const { data, error: fetchErr } = await supabase
          .from("completed_lessons")
          .select(
            `id, created_at, user_id, lesson_id, version, conversation_transcript,
             user_improvement_feedback, user_rating_feedback, payment_status`,
          )
          .eq("lesson_id", parsed)
          .gt("id", lastId)
          .order("id", { ascending: true })
          .limit(PAGE_SIZE);

        if (fetchErr) throw new Error(fetchErr.message);

        if (data && data.length > 0) {
          allLessons = [...allLessons, ...data];
          lastId = data[data.length - 1].id;
          hasMore = data.length === PAGE_SIZE;
        } else {
          hasMore = false;
        }
      }

      const testLessons = allLessons.filter((l) => l.version === "test");
      const controlLessons = allLessons.filter((l) => l.version === "control");

      setTestStats(computeStats(testLessons));
      setControlStats(computeStats(controlLessons));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dashboard-container">
      <div className="dashboard-inner">
        {/* Search */}
        <div className="lookup-search-bar">
          <input
            className="lookup-input"
            type="text"
            placeholder="Enter lesson ID..."
            value={lessonIdInput}
            onChange={(e) => setLessonIdInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          />
          <button
            className="lookup-btn"
            onClick={handleLookup}
            disabled={loading || !lessonIdInput.trim()}
          >
            {loading ? "Loading..." : "Compare"}
          </button>
        </div>

        {error && (
          <div className="error-box">
            <h2 className="error-title">Error</h2>
            <p>{error}</p>
          </div>
        )}

        {loading && (
          <div className="loading-container">
            <div style={{ textAlign: "center" }}>
              <div className="loading-spinner"></div>
              <p className="loading-text">Fetching lesson data...</p>
            </div>
          </div>
        )}

        {!loading && searched && !error && testStats && controlStats && (
          <>
            <h2 className="ab-title">Lesson #{lessonId} — A/B Comparison</h2>

            {/* Stats comparison */}
            <div className="ab-comparison-grid">
              {/* Header row */}
              <div className="ab-header-cell"></div>
              <div className="ab-header-cell ab-header-cell--test">Test</div>
              <div className="ab-header-cell ab-header-cell--control">Control</div>

              {/* Total completions */}
              <div className="ab-label-cell">Total Completions</div>
              <div className="ab-value-cell">{testStats.count}</div>
              <div className="ab-value-cell">{controlStats.count}</div>

              {/* Active users */}
              <div className="ab-label-cell">Active (Paying) Users</div>
              <div className="ab-value-cell">
                <span className="ab-big-value">{testStats.activeCount}</span>
                {testStats.count > 0 && (
                  <span className="ab-pct">
                    ({((testStats.activeCount / testStats.count) * 100).toFixed(1)}%)
                  </span>
                )}
              </div>
              <div className="ab-value-cell">
                <span className="ab-big-value">{controlStats.activeCount}</span>
                {controlStats.count > 0 && (
                  <span className="ab-pct">
                    ({((controlStats.activeCount / controlStats.count) * 100).toFixed(1)}%)
                  </span>
                )}
              </div>

              {/* Avg Turns */}
              <div className="ab-label-cell">Avg Conversation Turns</div>
              <div className="ab-value-cell">
                <span className="ab-big-value">
                  {testStats.avgTurns != null ? testStats.avgTurns.toFixed(1) : "—"}
                </span>
                <span className="ab-pct">({testStats.totalWithTranscript} with transcript)</span>
              </div>
              <div className="ab-value-cell">
                <span className="ab-big-value">
                  {controlStats.avgTurns != null ? controlStats.avgTurns.toFixed(1) : "—"}
                </span>
                <span className="ab-pct">({controlStats.totalWithTranscript} with transcript)</span>
              </div>

              {/* Avg Rating */}
              <div className="ab-label-cell">Avg User Rating</div>
              <div className="ab-value-cell">
                <span className="ab-big-value">
                  {testStats.avgRating != null
                    ? testStats.avgRating.toFixed(2) + "★"
                    : "—"}
                </span>
                <span className="ab-pct">({testStats.ratings.length} rated)</span>
              </div>
              <div className="ab-value-cell">
                <span className="ab-big-value">
                  {controlStats.avgRating != null
                    ? controlStats.avgRating.toFixed(2) + "★"
                    : "—"}
                </span>
                <span className="ab-pct">({controlStats.ratings.length} rated)</span>
              </div>

              {/* Rating distribution */}
              <div className="ab-label-cell">Rating Distribution</div>
              <div className="ab-value-cell">
                <RatingDistribution ratings={testStats.ratings} />
              </div>
              <div className="ab-value-cell">
                <RatingDistribution ratings={controlStats.ratings} />
              </div>
            </div>

            {/* Feedback sections side by side */}
            <div className="ab-feedback-row">
              <div className="ab-feedback-col">
                <h3 className="ab-feedback-heading">
                  Test — Improvement Feedback ({testStats.feedbacks.length})
                </h3>
                {testStats.feedbacks.length === 0 ? (
                  <p className="ab-no-feedback">No feedback submitted.</p>
                ) : (
                  <ul className="ab-feedback-list">
                    {testStats.feedbacks.map((f, i) => (
                      <li key={i} className="ab-feedback-item">{f}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="ab-feedback-col">
                <h3 className="ab-feedback-heading">
                  Control — Improvement Feedback ({controlStats.feedbacks.length})
                </h3>
                {controlStats.feedbacks.length === 0 ? (
                  <p className="ab-no-feedback">No feedback submitted.</p>
                ) : (
                  <ul className="ab-feedback-list">
                    {controlStats.feedbacks.map((f, i) => (
                      <li key={i} className="ab-feedback-item">{f}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}

        {!loading && searched && !error && testStats && controlStats &&
          testStats.count === 0 && controlStats.count === 0 && (
          <div className="empty-state">
            No completions found for lesson #{lessonId}.
          </div>
        )}

        {!searched && !loading && (
          <div className="empty-state">
            Enter a lesson ID to compare test vs control performance.
          </div>
        )}
      </div>
    </div>
  );
};

const RatingDistribution: React.FC<{ ratings: number[] }> = ({ ratings }) => {
  if (ratings.length === 0) return <span className="ab-no-feedback">No ratings</span>;

  const counts: Record<number, number> = {};
  for (let i = 1; i <= 5; i++) counts[i] = 0;
  ratings.forEach((r) => {
    const bucket = Math.round(r);
    if (bucket >= 1 && bucket <= 5) counts[bucket]++;
  });

  const max = Math.max(...Object.values(counts), 1);

  return (
    <div className="ab-rating-dist">
      {[1, 2, 3, 4, 5].map((star) => (
        <div key={star} className="ab-rating-bar-row">
          <span className="ab-rating-bar-label">{star}★</span>
          <div className="ab-rating-bar-track">
            <div
              className="ab-rating-bar-fill"
              style={{ width: `${(counts[star] / max) * 100}%` }}
            />
          </div>
          <span className="ab-rating-bar-count">{counts[star]}</span>
        </div>
      ))}
    </div>
  );
};

export default ABComparison;
