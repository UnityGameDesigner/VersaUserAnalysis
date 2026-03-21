import React, { useState, useEffect, useRef } from "react";
import { supabase } from "./lib/supabase";
import { format } from "date-fns";

interface UserInfo {
  user_id: string;
  preferred_name: string | null;
  age: number | null;
  gender: string | null;
  native_language: string | null;
  tutor: string | null;
  daily_streak: number;
  last_logged_in: string | null;
  time_zone: string | null;
  attribution: string | null;
  demand_tier: string | null;
  payment_status: string;
}

interface CompletedLesson {
  id: number;
  created_at: string;
  user_id: string;
  lesson_id: number;
  conversation_transcript: unknown;
  phrase_feedback: unknown;
  user_improvement_feedback: string | null;
  user_rating_feedback: number | null;
  ended_early: boolean | null;
  payment_status: string;
}

interface TranscriptMessage {
  role: string;
  text: string;
}

function parseTranscript(raw: unknown): TranscriptMessage[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (m: unknown): m is { role: string; text: string } =>
          typeof m === "object" &&
          m !== null &&
          "text" in m &&
          typeof (m as Record<string, unknown>).text === "string",
      )
      .filter((m) => m.role !== "ack")
      .map((m) => ({ role: m.role ?? "unknown", text: m.text }));
  } catch {
    return [];
  }
}

const LessonCard: React.FC<{ lesson: CompletedLesson }> = ({ lesson: c }) => {
  const [open, setOpen] = useState(false);
  const messages = parseTranscript(c.conversation_transcript);

  return (
    <div className="lesson-card">
      <div className="lesson-card-header">
        <span className="lesson-card-lesson-id">Lesson #{c.lesson_id}</span>
        <span className="lesson-card-date">
          {format(new Date(c.created_at), "MMM d, yyyy h:mm a")}
        </span>
        {c.user_rating_feedback != null && (
          <span className="lesson-card-rating">
            {c.user_rating_feedback}★
          </span>
        )}
        {c.ended_early && (
          <span className="lesson-card-badge lesson-card-badge--early">
            Ended Early
          </span>
        )}
        {messages.length > 0 && (
          <button
            className="transcript-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide Conversation" : "Show Conversation"}
          </button>
        )}
      </div>

      {open && messages.length > 0 && (
        <div className="transcript-chat">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`chat-bubble chat-bubble--${
                m.role === "user" ? "user" : "assistant"
              }`}
            >
              <span className="chat-role">{m.role}</span>
              <p className="chat-content">{m.text}</p>
            </div>
          ))}
        </div>
      )}

      {c.user_improvement_feedback && (
        <div className="lesson-card-feedback">
          <strong>Improvement Feedback:</strong> {c.user_improvement_feedback}
        </div>
      )}
    </div>
  );
};

const UserLookup: React.FC<{ initialUserId?: string | null }> = ({ initialUserId }) => {
  const [inputId, setInputId] = useState(initialUserId || "");
  const [user, setUser] = useState<UserInfo | null>(null);
  const [lessons, setLessons] = useState<CompletedLesson[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleLookup = async (overrideId?: string) => {
    const trimmed = (overrideId ?? inputId).trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setUser(null);
    setLessons([]);
    setSearched(true);

    try {
      // Fetch user_info
      const { data: userData, error: userErr } = await supabase
        .from("user_info")
        .select(
          `user_id, preferred_name, age, gender, native_language,
           tutor, daily_streak, last_logged_in, time_zone, attribution,
           demand_tier, payment_status`,
        )
        .eq("user_id", trimmed)
        .limit(1)
        .single();

      if (userErr) throw new Error(`User not found: ${userErr.message}`);
      setUser(userData);

      // Fetch all completed lessons for this user (paginated)
      let allLessons: CompletedLesson[] = [];
      let lastId = 0;
      let hasMore = true;

      while (hasMore) {
        const { data, error: lessonErr } = await supabase
          .from("completed_lessons")
          .select(
            `id, created_at, user_id, lesson_id, conversation_transcript,
             phrase_feedback, user_improvement_feedback, user_rating_feedback,
             ended_early, payment_status`,
          )
          .eq("user_id", trimmed)
          .gt("id", lastId)
          .order("id", { ascending: true })
          .limit(1000);

        if (lessonErr) throw new Error(lessonErr.message);

        if (data && data.length > 0) {
          allLessons = [...allLessons, ...data];
          lastId = data[data.length - 1].id;
          hasMore = data.length === 1000;
        } else {
          hasMore = false;
        }
      }

      allLessons.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      setLessons(allLessons);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const didAutoSearch = useRef(false);
  useEffect(() => {
    if (initialUserId && !didAutoSearch.current) {
      didAutoSearch.current = true;
      setInputId(initialUserId);
      handleLookup(initialUserId);
    }
  }, [initialUserId]);

  const ratedLessons = lessons.filter((l) => l.user_rating_feedback != null);
  const avgRating =
    ratedLessons.length > 0
      ? ratedLessons.reduce((s, l) => s + l.user_rating_feedback!, 0) /
        ratedLessons.length
      : null;
  const earlyCount = lessons.filter((l) => l.ended_early).length;

  return (
    <div className="dashboard-container">
      <div className="dashboard-inner">
        {/* Search Bar */}
        <div className="lookup-search-bar">
          <input
            className="lookup-input"
            type="text"
            placeholder="Enter user ID..."
            value={inputId}
            onChange={(e) => setInputId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          />
          <button
            className="lookup-btn"
            onClick={handleLookup}
            disabled={loading || !inputId.trim()}
          >
            {loading ? "Searching..." : "Look Up"}
          </button>
        </div>

        {error && (
          <div className="error-box">
            <h2 className="error-title">Lookup Error</h2>
            <p>{error}</p>
          </div>
        )}

        {loading && (
          <div className="loading-container">
            <div style={{ textAlign: "center" }}>
              <div className="loading-spinner"></div>
              <p className="loading-text">Fetching user data...</p>
            </div>
          </div>
        )}

        {!loading && searched && !error && user && (
          <>
            {/* User Profile Card */}
            <div className="lookup-profile-card">
              <div className="lookup-profile-header">
                <h2 className="lookup-profile-name">
                  {user.preferred_name || "Unnamed User"}
                </h2>
                <span
                  className={`plan-pill plan-pill--${
                    user.payment_status === "ACTIVE"
                      ? "paying"
                      : user.payment_status === "TRIAL"
                        ? "trial"
                        : "free"
                  }`}
                >
                  {user.payment_status}
                </span>
              </div>
              <p className="lookup-profile-uid">{user.user_id}</p>
            </div>

            {/* Stats Grid */}
            <div className="metrics-grid lookup-metrics">
              <div className="metric-card">
                <div className="metric-value">{user.daily_streak}</div>
                <div className="metric-label">Daily Streak</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{lessons.length}</div>
                <div className="metric-label">Lessons Completed</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">
                  {avgRating != null ? avgRating.toFixed(1) + "★" : "—"}
                </div>
                <div className="metric-label">Avg Rating</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">{earlyCount}</div>
                <div className="metric-label">Ended Early</div>
              </div>
            </div>

            {/* User Details */}
            <div className="lookup-details-grid">
              {user.age != null && user.age !== -1 && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Age</span>
                  <span className="lookup-detail-value">{user.age}</span>
                </div>
              )}
              {user.gender && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Gender</span>
                  <span className="lookup-detail-value">{user.gender}</span>
                </div>
              )}
              {user.native_language && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Native Language</span>
                  <span className="lookup-detail-value">
                    {user.native_language}
                  </span>
                </div>
              )}
              {user.tutor && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Tutor</span>
                  <span className="lookup-detail-value">{user.tutor}</span>
                </div>
              )}
              {user.time_zone && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Timezone</span>
                  <span className="lookup-detail-value">{user.time_zone}</span>
                </div>
              )}
              {user.attribution && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Attribution</span>
                  <span className="lookup-detail-value">
                    <span className="attribution-pill">{user.attribution}</span>
                  </span>
                </div>
              )}
              {user.demand_tier && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Demand Tier</span>
                  <span className="lookup-detail-value">
                    <span className="level-pill">{user.demand_tier}</span>
                  </span>
                </div>
              )}
              {user.last_logged_in && (
                <div className="lookup-detail">
                  <span className="lookup-detail-label">Last Logged In</span>
                  <span className="lookup-detail-value">
                    {format(
                      new Date(user.last_logged_in),
                      "MMM d, yyyy h:mm a",
                    )}
                  </span>
                </div>
              )}
            </div>

            {/* Lessons */}
            <div className="lookup-lessons-section">
              <h3 className="lookup-lessons-title">
                Completed Lessons ({lessons.length})
              </h3>
              {lessons.length === 0 ? (
                <div className="empty-state">
                  No completed lessons found for this user.
                </div>
              ) : (
                <div className="lessons-cards">
                  {lessons.map((c) => (
                    <LessonCard key={c.id} lesson={c} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {!loading && searched && !error && !user && (
          <div className="empty-state">No user found with that ID.</div>
        )}

        {!searched && !loading && (
          <div className="empty-state">
            Enter a user ID above to look up their profile and lesson history.
          </div>
        )}
      </div>
    </div>
  );
};

export default UserLookup;
