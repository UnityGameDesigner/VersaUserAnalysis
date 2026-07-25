import React, { useState } from "react";
import { scoreVariant, type TutorEvaluation } from "./lib/evaluateTutor";

const TutorEvalPanel: React.FC<{
  evaluation: TutorEvaluation;
  // When true, only the score header is shown; the full writeup (dimensions,
  // strengths, issues, notable moments) sits behind a toggle. Defaults to the
  // original always-expanded behavior for inline use in All Transcripts.
  collapsible?: boolean;
  defaultExpanded?: boolean;
}> = ({ evaluation, collapsible = false, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const showDetail = !collapsible || expanded;

  return (
    <div className={`eval-panel${showDetail ? "" : " eval-panel--collapsed"}`}>
      <div className="eval-header">
        <span className={`eval-score eval-score--${scoreVariant(evaluation.overall_score)}`}>
          {evaluation.overall_score}/10
        </span>
        <span className="eval-verdict">{evaluation.verdict}</span>
        {collapsible && (
          <button
            className="transcript-toggle eval-detail-toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Hide full evaluation" : "Show full evaluation"}
          </button>
        )}
      </div>
      {showDetail && (
        <>
          <div className="eval-dimensions">
            {evaluation.dimensions.map((d) => (
              <div key={d.dimension} className="eval-dim" title={d.comment}>
                <span className={`eval-dim-score eval-dim-score--${scoreVariant(d.score)}`}>
                  {d.score}
                </span>
                <span className="eval-dim-name">{d.dimension}</span>
                <p className="eval-dim-comment">{d.comment}</p>
              </div>
            ))}
          </div>
          {evaluation.strengths.length > 0 && (
            <div className="eval-section">
              <div className="eval-section-title">Strengths</div>
              <ul className="eval-list">
                {evaluation.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {evaluation.issues.length > 0 && (
            <div className="eval-section">
              <div className="eval-section-title">Issues</div>
              <ul className="eval-list eval-list--issues">
                {evaluation.issues.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {evaluation.notable_moments.length > 0 && (
            <div className="eval-section">
              <div className="eval-section-title">Notable moments</div>
              {evaluation.notable_moments.map((m, i) => (
                <div key={i} className={`eval-moment eval-moment--${m.kind}`}>
                  <blockquote className="eval-moment-quote">“{m.quote}”</blockquote>
                  <p className="eval-moment-comment">{m.comment}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default TutorEvalPanel;
