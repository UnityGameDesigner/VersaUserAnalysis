import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./lib/supabase";
import { format } from "date-fns";

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

interface UserInfo {
  user_id: string;
  preferred_name: string | null;
  age: number | null;
  gender: string | null;
  native_language: string | null;
  tutor: string | null;
  daily_streak: number;
  time_zone: string | null;
  demand_tier: string | null;
  payment_status: string;
}

interface TranscriptMessage {
  role: string;
  text: string;
}

interface LessonGroup {
  lesson_id: number;
  completions: CompletedLesson[];
  avgRating: number | null;
}

const PAGE_SIZE = 1000;
const SUPABASE_TABLE = "completed_lessons";

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

const LessonCard: React.FC<{
  lesson: CompletedLesson;
  user: UserInfo | undefined;
  onUserClick?: (userId: string) => void;
  showLessonId?: boolean;
}> = ({ lesson: c, user, onUserClick, showLessonId }) => {
  const [open, setOpen] = useState(false);
  const messages = parseTranscript(c.conversation_transcript);
  const isUserView = !!showLessonId;
  return (
    <div className="lesson-card">
      <div className="lesson-card-header">
        {!isUserView && (
          <button
            className="lesson-card-user lesson-card-user--clickable"
            title={`View all lessons for ${c.user_id}`}
            onClick={() => onUserClick?.(c.user_id)}
          >
            {user?.preferred_name || c.user_id.slice(0, 8) + "…"}
          </button>
        )}
        {isUserView && (
          <span className="lesson-card-lesson-id">Lesson #{c.lesson_id}</span>
        )}
        <span className="lesson-card-date">
          {format(new Date(c.created_at), "MMM d, yyyy h:mm a")}
        </span>
        {!isUserView && c.user_rating_feedback != null && (
          <span className="lesson-card-rating">
            {c.user_rating_feedback}★
          </span>
        )}
        {!isUserView && c.ended_early && (
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

      {!isUserView && user && (
        <div className="lesson-card-user-props">
          {user.age != null && user.age !== -1 && (
            <span className="user-prop">Age: {user.age}</span>
          )}
          {user.gender && <span className="user-prop">Gender: {user.gender}</span>}
          {user.native_language && <span className="user-prop">Lang: {user.native_language}</span>}
          {user.time_zone && <span className="user-prop">TZ: {user.time_zone}</span>}
          {user.demand_tier && <span className="user-prop">Demand: {user.demand_tier}</span>}
          {user.tutor && <span className="user-prop">Tutor: {user.tutor}</span>}
          <span className="user-prop">Streak: {user.daily_streak}</span>
          <span className="user-prop">{user.payment_status}</span>
        </div>
      )}

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

const CompletedLessons: React.FC = () => {
  const [lessons, setLessons] = useState<CompletedLesson[]>([]);
  const [userMap, setUserMap] = useState<Map<string, UserInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLessonId, setSelectedLessonId] = useState<number | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      setError(null);

      try {
        // Fetch completed lessons
        let allLessons: CompletedLesson[] = [];
        let lastId = 0;
        let hasMore = true;

        while (hasMore) {
          const { data, error } = await supabase
            .from(SUPABASE_TABLE)
            .select(
              `id, created_at, user_id, lesson_id, conversation_transcript,
               phrase_feedback, user_improvement_feedback, user_rating_feedback,
               ended_early, payment_status`,
            )
            .in("payment_status", ["ACTIVE", "TRIAL"])
            .gt("id", lastId)
            .order("id", { ascending: true })
            .limit(PAGE_SIZE);

          if (error) throw new Error(error.message);

          if (data && data.length > 0) {
            allLessons = [...allLessons, ...data];
            lastId = data[data.length - 1].id;
            hasMore = data.length === PAGE_SIZE;
          } else {
            hasMore = false;
          }
        }

        // Fetch user_info for ACTIVE/TRIAL users
        let allUsers: UserInfo[] = [];
        lastId = 0;
        hasMore = true;

        while (hasMore) {
          const { data, error } = await supabase
            .from("user_info")
            .select(
              `id, user_id, preferred_name, age, gender, native_language,
               tutor, daily_streak, time_zone, demand_tier, payment_status`,
            )
            .in("payment_status", ["ACTIVE", "TRIAL"])
            .gt("id", lastId)
            .order("id", { ascending: true })
            .limit(PAGE_SIZE);

          if (error) throw new Error(error.message);

          if (data && data.length > 0) {
            allUsers = [...allUsers, ...data];
            lastId = data[data.length - 1].id;
            hasMore = data.length === PAGE_SIZE;
          } else {
            hasMore = false;
          }
        }

        const map = new Map<string, UserInfo>();
        allUsers.forEach((u) => {
          if (!map.has(u.user_id)) map.set(u.user_id, u);
        });

        setLessons(allLessons);
        setUserMap(map);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        setError(`Failed to fetch completed lessons: ${msg}`);
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
  }, []);

  const groupedLessons = useMemo(() => {
    const map = new Map<number, CompletedLesson[]>();
    lessons.forEach((l) => {
      const arr = map.get(l.lesson_id) || [];
      arr.push(l);
      map.set(l.lesson_id, arr);
    });

    const groups: LessonGroup[] = [];
    map.forEach((completions, lesson_id) => {
      const rated = completions.filter((c) => c.user_rating_feedback != null);
      const avgRating =
        rated.length > 0
          ? rated.reduce((s, c) => s + c.user_rating_feedback!, 0) / rated.length
          : null;
      groups.push({ lesson_id, completions, avgRating });
    });

    groups.sort((a, b) => a.lesson_id - b.lesson_id);
    return groups;
  }, [lessons]);

  const selectedGroup = useMemo(
    () => groupedLessons.find((g) => g.lesson_id === selectedLessonId) ?? null,
    [groupedLessons, selectedLessonId],
  );

  const userLessons = useMemo(() => {
    if (!selectedUserId) return [];
    return lessons
      .filter((l) => l.user_id === selectedUserId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [lessons, selectedUserId]);

  if (loading) {
    return (
      <div className="loading-container">
        <div style={{ textAlign: "center" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Loading completed lessons...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-box">
        <h2 className="error-title">Error Loading Lessons</h2>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="lessons-layout">
      {/* Left panel — lesson index */}
      <aside className="lessons-index">
        <h3 className="lessons-index-title">
          Lessons ({groupedLessons.length})
        </h3>
        <div className="lessons-index-list">
          {groupedLessons.map((g) => (
            <button
              key={g.lesson_id}
              className={`lesson-index-item${
                selectedLessonId === g.lesson_id ? " lesson-index-item--active" : ""
              }`}
              onClick={() => setSelectedLessonId(g.lesson_id)}
            >
              <span className="lesson-index-name">Lesson #{g.lesson_id}</span>
              <span className="lesson-index-meta">
                {g.completions.length} completion{g.completions.length !== 1 ? "s" : ""}
                {g.avgRating != null && ` · ${g.avgRating.toFixed(1)}★`}
              </span>
            </button>
          ))}
        </div>
      </aside>

      {/* Right panel — transcript detail or user timeline */}
      <section className="lessons-detail">
        {selectedUserId ? (
          <>
            <div className="lessons-detail-header-row">
              <button
                className="back-btn"
                onClick={() => setSelectedUserId(null)}
              >
                &larr; Back
              </button>
              <h2 className="lessons-detail-title">
                {userMap.get(selectedUserId)?.preferred_name || selectedUserId.slice(0, 8) + "…"}
                <span className="lessons-detail-count">
                  {userLessons.length} lesson{userLessons.length !== 1 ? "s" : ""}
                </span>
              </h2>
            </div>

            {userMap.get(selectedUserId) && (
              <div className="lesson-card-user-props" style={{ marginBottom: "1rem", borderRadius: 8 }}>
                {(() => {
                  const u = userMap.get(selectedUserId)!;
                  return (
                    <>
                      {u.age != null && u.age !== -1 && <span className="user-prop">Age: {u.age}</span>}
                      {u.gender && <span className="user-prop">Gender: {u.gender}</span>}
                      {u.native_language && <span className="user-prop">Lang: {u.native_language}</span>}
                      {u.time_zone && <span className="user-prop">TZ: {u.time_zone}</span>}
                      {u.demand_tier && <span className="user-prop">Demand: {u.demand_tier}</span>}
                      {u.tutor && <span className="user-prop">Tutor: {u.tutor}</span>}
                      <span className="user-prop">Streak: {u.daily_streak}</span>
                      <span className="user-prop">{u.payment_status}</span>
                    </>
                  );
                })()}
              </div>
            )}

            <div className="lessons-cards">
              {userLessons.map((c) => (
                <LessonCard key={c.id} lesson={c} user={userMap.get(c.user_id)} showLessonId />
              ))}
            </div>
          </>
        ) : !selectedGroup ? (
          <div className="empty-state">Select a lesson to view transcripts</div>
        ) : (
          <>
            <h2 className="lessons-detail-title">
              Lesson #{selectedGroup.lesson_id}
              <span className="lessons-detail-count">
                {selectedGroup.completions.length} completion
                {selectedGroup.completions.length !== 1 ? "s" : ""}
              </span>
            </h2>

            <div className="lessons-cards">
              {selectedGroup.completions
                .sort(
                  (a, b) =>
                    new Date(b.created_at).getTime() -
                    new Date(a.created_at).getTime(),
                )
                .map((c) => (
                  <LessonCard
                    key={c.id}
                    lesson={c}
                    user={userMap.get(c.user_id)}
                    onUserClick={(uid) => setSelectedUserId(uid)}
                  />
                ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
};

export default CompletedLessons;
