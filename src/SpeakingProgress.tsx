import React, { useMemo, useState } from "react";
import { format } from "date-fns";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { lessonSpeechMetrics, linearTrend, type LessonSpeechMetrics } from "./lib/speechTimeline";

// "Speaking progress" for one user: how their speaking rate / fluency / answer
// length move across their completed lessons over time. Each point is a lesson
// with enough spoken material to measure; the dashed line is the least-squares
// trend, and the headline chip reads net change off that trend. All three
// metrics come from the student's word_timeline (see lib/speechTimeline).

interface LessonLike {
  id: number;
  created_at: string;
  word_timeline: unknown;
}

type MetricKey = "wpm" | "fluency" | "wordsPerTurn";

const METRIC_META: Record<
  MetricKey,
  {
    label: string;
    help: string;
    fmt: (v: number) => string; // headline / tooltip value
    axisFmt: (v: number) => string; // y-axis tick
    domain?: [number, number];
  }
> = {
  wpm: {
    label: "Speaking rate",
    help: "Words per minute while actually speaking — within-turn pauses counted, silence between turns excluded. Rising over time means faster, more automatic speech.",
    fmt: (v) => `${Math.round(v)} WPM`,
    axisFmt: (v) => `${Math.round(v)}`,
  },
  fluency: {
    label: "Fluency",
    help: "Share of speaking time filled with words rather than mid-sentence pauses. Higher means fewer hesitations while forming a sentence.",
    fmt: (v) => `${Math.round(v * 100)}%`,
    axisFmt: (v) => `${Math.round(v * 100)}%`,
    domain: [0, 1],
  },
  wordsPerTurn: {
    label: "Words / turn",
    help: "Average words the student produces per response. Higher means longer, more confident answers instead of one-word replies.",
    fmt: (v) => v.toFixed(1),
    axisFmt: (v) => v.toFixed(0),
  },
};

const METRIC_ORDER: MetricKey[] = ["wpm", "fluency", "wordsPerTurn"];

// Need a few points before a trend line says anything.
const MIN_POINTS = 3;

const SpeakingProgress: React.FC<{ lessons: LessonLike[] }> = ({ lessons }) => {
  const [metric, setMetric] = useState<MetricKey>("wpm");

  // Lessons with enough spoken material, oldest → newest.
  const points = useMemo(() => {
    return lessons
      .map((l) => ({ date: l.created_at, m: lessonSpeechMetrics(l.word_timeline) }))
      .filter((p): p is { date: string; m: LessonSpeechMetrics } => p.m !== null)
      .sort((a, b) => +new Date(a.date) - +new Date(b.date));
  }, [lessons]);

  const meta = METRIC_META[metric];

  const { data, delta } = useMemo(() => {
    const ys = points.map((p) => p.m[metric]);
    const { slope, intercept } = linearTrend(ys);
    const trendVals = ys.map((_, i) => intercept + slope * i);
    const data = points.map((p, i) => ({
      label: format(new Date(p.date), "MMM d"),
      value: p.m[metric],
      trend: trendVals[i],
    }));
    const first = trendVals[0] ?? 0;
    const last = trendVals[trendVals.length - 1] ?? 0;
    const pct = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0;
    const dir = pct > 2 ? "up" : pct < -2 ? "down" : "flat";
    return { data, delta: { first, last, pct, dir } };
  }, [points, metric]);

  // No spoken lessons at all → nothing to show; stay out of the way.
  if (points.length === 0) return null;

  const arrow = delta.dir === "up" ? "▲" : delta.dir === "down" ? "▼" : "→";

  return (
    <div className="speaking-progress">
      <div className="speaking-progress-head">
        <div>
          <h3 className="speaking-progress-title">Speaking Progress</h3>
          <p className="speaking-progress-help">{meta.help}</p>
        </div>
        <div className="ret-seg" role="tablist" aria-label="Speaking metric">
          {METRIC_ORDER.map((k) => (
            <button
              key={k}
              className={`ret-seg-btn${metric === k ? " ret-seg-btn--on" : ""}`}
              onClick={() => setMetric(k)}
            >
              {METRIC_META[k].label}
            </button>
          ))}
        </div>
      </div>

      {points.length < MIN_POINTS ? (
        <p className="speaking-progress-note">
          Only {points.length} lesson{points.length === 1 ? "" : "s"} with enough
          spoken audio so far — need at least {MIN_POINTS} to chart a trend.
        </p>
      ) : (
        <>
          <div className={`speaking-progress-delta speaking-progress-delta--${delta.dir}`}>
            <span>
              {meta.fmt(delta.first)} → {meta.fmt(delta.last)}
            </span>
            <span>
              {arrow} {delta.pct >= 0 ? "+" : ""}
              {delta.pct.toFixed(0)}%
            </span>
            <small>trend over {points.length} lessons</small>
          </div>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  domain={meta.domain ?? ["auto", "auto"]}
                  tickFormatter={meta.axisFmt}
                  width={44}
                />
                <Tooltip
                  formatter={(v, name) => [
                    meta.fmt(typeof v === "number" ? v : Number(v)),
                    name === "trend" ? "Trend" : meta.label,
                  ]}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  name={meta.label}
                  stroke="#4f46e5"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
                <Line
                  type="linear"
                  dataKey="trend"
                  name="trend"
                  stroke="#9ca3af"
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  dot={false}
                  activeDot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
};

export default SpeakingProgress;
