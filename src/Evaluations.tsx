import React, { useState, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { supabase } from "./lib/supabase";
import { getAllEvaluations, deleteEvaluation, type SavedEvaluation } from "./lib/evalStore";
import { scoreVariant } from "./lib/evaluateTutor";
import TutorEvalPanel from "./TutorEvalPanel";
import { Conversation } from "./Feedback";
import { format } from "date-fns";

// Score bands mirror scoreVariant() thresholds (good ≥8, mid 5–7, bad <5) and
// reuse the eval-score palette so the chart reads the same as the on-card badges.
const SCORE_BANDS = [
  { key: "good", label: "High (8–10)", fill: "#22c55e" },
  { key: "mid", label: "Mid (5–7)", fill: "#f59e0b" },
  { key: "bad", label: "Low (1–4)", fill: "#ef4444" },
] as const;

interface Props {
  onUserClick?: (userId: string) => void;
}

type SortMode = "newest" | "oldest" | "score-high" | "score-low";

// One saved evaluation. The conversation itself isn't kept in localStorage
// (transcripts are big) — it's fetched from Supabase on demand.
const EvaluationCard: React.FC<{
  record: SavedEvaluation;
  onUserClick?: (userId: string) => void;
  onDelete: (rowId: number) => void;
}> = ({ record, onUserClick, onDelete }) => {
  const [transcript, setTranscript] = useState<unknown>(undefined);
  const [showConvo, setShowConvo] = useState(false);
  const [loadingConvo, setLoadingConvo] = useState(false);
  const [convoError, setConvoError] = useState<string | null>(null);

  const handleShowConversation = async () => {
    if (transcript !== undefined) {
      setShowConvo((v) => !v);
      return;
    }
    setLoadingConvo(true);
    setConvoError(null);
    try {
      const { data, error } = await supabase
        .from("completed_lessons")
        .select("conversation_transcript")
        .eq("id", record.rowId)
        .single();
      if (error) throw new Error(error.message);
      setTranscript(data?.conversation_transcript ?? null);
      setShowConvo(true);
    } catch (e) {
      setConvoError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingConvo(false);
    }
  };

  return (
    <div className="lesson-card">
      <div className="lesson-card-header">
        <button
          className="lesson-card-user lesson-card-user--clickable"
          title={`View all lessons for ${record.userId}`}
          onClick={() => onUserClick?.(record.userId)}
        >
          {record.userName?.trim() || record.userId.slice(0, 8) + "…"}
        </button>
        <span className="lesson-card-lesson-id">Lesson #{record.lessonId}</span>
        <span className="lesson-card-date">
          {format(new Date(record.lessonDate), "MMM d, yyyy h:mm a")}
        </span>
        {record.turnCount != null && (
          <span
            className="lesson-card-badge lesson-card-badge--turns"
            title={`${record.turnCount} conversational turn${record.turnCount === 1 ? "" : "s"} (messages exchanged between student and tutor)`}
          >
            💬 {record.turnCount} turn{record.turnCount === 1 ? "" : "s"}
          </span>
        )}
        {record.endedEarly && (
          <span className="lesson-card-badge lesson-card-badge--early">Ended Early</span>
        )}
        <span className="eval-evaluated-at">
          evaluated {format(new Date(record.evaluatedAt), "MMM d, h:mm a")}
        </span>
        <button
          className="transcript-toggle"
          onClick={handleShowConversation}
          disabled={loadingConvo}
        >
          {loadingConvo ? "Loading…" : showConvo ? "Hide Conversation" : "Show Conversation"}
        </button>
        <button
          className="transcript-toggle transcript-toggle--danger"
          onClick={() => onDelete(record.rowId)}
          title="Remove this evaluation from the saved list"
        >
          Remove
        </button>
      </div>

      <TutorEvalPanel evaluation={record.evaluation} collapsible />

      {convoError && <div className="eval-error">Failed to load conversation: {convoError}</div>}
      {showConvo && transcript !== undefined && <Conversation transcript={transcript} />}
    </div>
  );
};

const Evaluations: React.FC<Props> = ({ onUserClick }) => {
  const [records, setRecords] = useState<SavedEvaluation[]>(() => getAllEvaluations());
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  const handleDelete = (rowId: number) => {
    deleteEvaluation(rowId);
    setRecords(getAllEvaluations());
  };

  const sorted = useMemo(() => {
    const out = [...records];
    out.sort((a, b) => {
      switch (sortMode) {
        case "oldest":
          return +new Date(a.evaluatedAt) - +new Date(b.evaluatedAt);
        case "score-high":
          return b.evaluation.overall_score - a.evaluation.overall_score;
        case "score-low":
          return a.evaluation.overall_score - b.evaluation.overall_score;
        case "newest":
        default:
          return +new Date(b.evaluatedAt) - +new Date(a.evaluatedAt);
      }
    });
    return out;
  }, [records, sortMode]);

  const avgScore = useMemo(() => {
    if (records.length === 0) return null;
    return records.reduce((s, r) => s + r.evaluation.overall_score, 0) / records.length;
  }, [records]);

  // Lessons-per-day, split by score band, for the stacked bar chart. Bucketed by
  // the lesson's own date (when the lesson happened), not when it was graded.
  const scoreByDay = useMemo(() => {
    const map = new Map<
      string,
      { day: string; label: string; good: number; mid: number; bad: number }
    >();
    for (const r of records) {
      const d = new Date(r.lessonDate);
      const day = format(d, "yyyy-MM-dd");
      let entry = map.get(day);
      if (!entry) {
        entry = { day, label: format(d, "MMM d"), good: 0, mid: 0, bad: 0 };
        map.set(day, entry);
      }
      entry[scoreVariant(r.evaluation.overall_score) as "good" | "mid" | "bad"] += 1;
    }
    return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
  }, [records]);

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <h2 className="lessons-detail-title">
        Tutor Evaluations
        <span className="lessons-detail-count">
          {records.length} saved
          {avgScore != null && ` · ${avgScore.toFixed(1)}/10 avg`}
        </span>
      </h2>

      {records.length > 0 && (
        <div className="tx-filters">
          <div className="tx-filters-row">
            <div className="tx-chips">
              <label className="tx-chip" data-active={sortMode !== "newest"}>
                <span className="tx-chip-label">Sort</span>
                <select
                  className="tx-chip-select"
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                >
                  <option value="newest">Recently evaluated</option>
                  <option value="oldest">Oldest evaluated</option>
                  <option value="score-high">Highest score</option>
                  <option value="score-low">Lowest score</option>
                </select>
                <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </label>
            </div>
          </div>
        </div>
      )}

      {scoreByDay.length > 0 && (
        <div className="chart-container" style={{ marginBottom: "1.25rem" }}>
          <h3>Lessons by Score, per Day</h3>
          <p className="ret-chart-sub">
            Number of evaluated lessons each day, stacked by score band. Bucketed by
            the day the lesson happened.
          </p>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={scoreByDay} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip
                  formatter={(v: number | undefined, name) => [`${v ?? 0} lesson${v === 1 ? "" : "s"}`, name]}
                />
                <Legend />
                {SCORE_BANDS.map((b, i) => (
                  <Bar
                    key={b.key}
                    dataKey={b.key}
                    stackId="score"
                    name={b.label}
                    fill={b.fill}
                    radius={i === SCORE_BANDS.length - 1 ? [4, 4, 0, 0] : undefined}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="lessons-cards">
        {sorted.map((r) => (
          <EvaluationCard
            key={r.rowId}
            record={r}
            onUserClick={onUserClick}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {records.length === 0 && (
        <div className="empty-state" style={{ padding: "1.5rem" }}>
          No saved evaluations yet — open All Transcripts and click “Evaluate Tutor” on a
          conversation. Results are saved here automatically.
        </div>
      )}
    </div>
  );
};

export default Evaluations;
