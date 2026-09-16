import React, { useState } from "react";
import { supabase } from "./lib/supabase";
import { parseTranscript } from "./lib/lessonMetrics";
import { scoreVariant } from "./lib/evaluateTutor";
import {
  evaluateJourney,
  type JourneyEvaluation,
  type JourneyLesson,
  type JourneyContext,
} from "./lib/evaluateJourney";
import { getSavedJourney, saveJourney } from "./lib/journeyStore";

const MIN_LESSONS = 3; // a "journey" needs a few sessions to judge
const JUDGE_CAP = 20; // max lessons sent to the judge (matches user_lesson_journey max_lessons)

// Long-horizon tutor eval over one learner's whole lesson sequence. On-demand
// (one LLM call), cached per user in journeyStore so it isn't re-billed.
const LearningJourneyPanel: React.FC<{
  userId: string;
  lessonCount: number;
  context: JourneyContext;
  converted: boolean;
}> = ({ userId, lessonCount, context, converted }) => {
  const saved = getSavedJourney(userId);
  const [ev, setEv] = useState<JourneyEvaluation | null>(saved?.evaluation ?? null);
  const [judgedCount, setJudgedCount] = useState<number>(saved?.lessonCount ?? 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Stale" only when there are new lessons we could actually capture — a power
  // user whose history exceeds the cap isn't stale (re-judging the same first N
  // gives the same result).
  const stale = ev != null && lessonCount > judgedCount && judgedCount < JUDGE_CAP;

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc("user_lesson_journey", {
        p_user_id: userId,
        max_lessons: JUDGE_CAP,
      });
      if (error) throw new Error(error.message);
      const lessons: JourneyLesson[] = ((data ?? []) as Record<string, unknown>[])
        .map((r) => ({
          date: String(r.created_at),
          turns: Number(r.turns ?? 0),
          rating: r.user_rating_feedback == null ? null : Number(r.user_rating_feedback),
          endedEarly: Boolean(r.ended_early),
          messages: parseTranscript(r.conversation_transcript),
        }))
        .filter((l) => l.messages.length > 0);
      if (lessons.length < MIN_LESSONS) {
        setError(`Only ${lessons.length} gradeable lesson${lessons.length === 1 ? "" : "s"} — need ${MIN_LESSONS}+ for a journey.`);
        return;
      }
      const result = await evaluateJourney(lessons, context);
      saveJourney({
        userId,
        evaluatedAt: new Date().toISOString(),
        lessonCount: lessons.length,
        userName: context.name ?? null,
        converted,
        evaluation: result,
      });
      setEv(result);
      setJudgedCount(lessons.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="user-exp">
      <div className="user-group-title">
        Learning Journey
        <span style={{ fontWeight: 400, color: "#8b929c", textTransform: "none", letterSpacing: 0 }}>
          {" "}· long-horizon tutor eval across {lessonCount} lessons
        </span>
      </div>
      <p className="ret-chart-sub" style={{ margin: "0.3rem 0 0.6rem", maxWidth: "70ch" }}>
        Judges the tutor <strong>across this learner's whole relationship</strong> — continuity, progression,
        memory &amp; personalization, and consistency — the things a single-lesson eval can't see.
      </p>

      {(!ev || stale) && (
        <button
          className="transcript-toggle transcript-toggle--eval"
          onClick={run}
          disabled={loading || lessonCount < MIN_LESSONS}
        >
          {loading
            ? "Judging journey…"
            : lessonCount < MIN_LESSONS
              ? `Needs ${MIN_LESSONS}+ lessons`
              : ev
                ? `Re-evaluate (+${lessonCount - judgedCount} new lessons)`
                : "Evaluate journey"}
        </button>
      )}

      {error && <div className="eval-error" style={{ marginTop: "0.5rem" }}>{error}</div>}

      {ev && (
        <div className="eval-panel" style={{ marginTop: "0.6rem" }}>
          <div className="eval-header">
            <span className={`eval-score eval-score--${scoreVariant(ev.overall_score)}`}>{ev.overall_score}/10</span>
            <span className="eval-verdict">{ev.verdict}</span>
            <span className="eval-evaluated-at">
              {judgedCount} lessons judged{converted ? " · converted" : " · not converted"}
            </span>
          </div>
          <div className="eval-dimensions">
            {ev.dimensions.map((d) => (
              <div key={d.dimension} className="eval-dim" title={d.comment}>
                <span className={`eval-dim-score eval-dim-score--${scoreVariant(d.score)}`}>{d.score}</span>
                <span className="eval-dim-name">{d.dimension}</span>
                <p className="eval-dim-comment">{d.comment}</p>
              </div>
            ))}
          </div>
          {ev.strengths.length > 0 && (
            <div className="eval-section">
              <div className="eval-section-title">Strengths across sessions</div>
              <ul className="eval-list">
                {ev.strengths.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {ev.issues.length > 0 && (
            <div className="eval-section">
              <div className="eval-section-title">Cross-session issues</div>
              <ul className="eval-list eval-list--issues">
                {ev.issues.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {ev.notable_moments.length > 0 && (
            <div className="eval-section">
              <div className="eval-section-title">Notable moments</div>
              {ev.notable_moments.map((m, i) => (
                <div key={i} className={`eval-moment eval-moment--${m.kind}`}>
                  <blockquote className="eval-moment-quote">“{m.quote}”</blockquote>
                  <p className="eval-moment-comment">{m.comment}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LearningJourneyPanel;
