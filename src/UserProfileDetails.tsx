import React, { useEffect, useState } from "react";
import { format } from "date-fns";
import { supabase } from "./lib/supabase";
import { parseExperience, prettyLang } from "./lib/onboardingAssessment";

// Everything else we hold on a user, from the user_profile_details RPC
// (supabase/sql/user_profile_details.sql): the user_info columns the profile
// card doesn't show, activity totals, subscription history, what the tutor has
// learned about them, call-exit feedback, content they made, and emails.

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

interface Details {
  info: Record<string, Json> | null;
  activity: {
    lessons: number;
    active_days: number;
    first_lesson_at: string | null;
    last_lesson_at: string | null;
    lessons_7d: number;
    lessons_30d: number;
    distinct_lessons: number;
    voice_practice_sessions: number;
    voice_practice_minutes: number;
  } | null;
  revenue: {
    summary: {
      platform: string | null;
      trial_product_id: string | null;
      first_paid_product_id: string | null;
      current_product_id: string | null;
      payments: number;
      first_paid_at: string | null;
      last_paid_at: string | null;
      gross_usd: number;
      refunds_usd: number;
      net_usd: number;
    } | null;
    transactions: {
      event: string;
      product_id: string | null;
      platform: string | null;
      period_type: string | null;
      price_usd: number | null;
      proceeds_usd: number | null;
      currency: string | null;
      price_local: number | null;
      country: string | null;
      purchased_at: string;
    }[];
  };
  learner: {
    profile: {
      estimated_level: string | null;
      learning_mode: string | null;
      primary_goal: string | null;
      secondary_goals: Json;
      real_situations: Json;
      pain_points: Json;
      interests: Json;
      preferred_tutor_style: string | null;
      avoid_rules: Json;
      current_plan_focus: string | null;
      onboarding_context: Json;
      profile_confidence: number | null;
      updated_at: string | null;
    } | null;
    aims: { language: string; aim: string; source: string | null; revision: number; created_at: string }[];
    languages: { language: string; level: string | null; last_active_at: string | null }[];
  };
  exit_feedback: {
    lesson_id: string | null;
    exit_phase: string | null;
    reasons: string[] | null;
    written_reason: string | null;
    created_at: string;
  }[];
  content: {
    custom_lessons: { id: number; title: string | null; topic: string | null; level: string | null; source: string | null; created_at: string }[];
    custom_lessons_total: number;
    daily_lessons_total: number;
    saved_cards: { title: string | null; body: string | null; created_at: string }[];
  };
  email: {
    state: { unsubscribed: boolean | null; last_sent_at: string | null; last_email_type: string | null } | null;
    total: number;
    recent: { email_type: string | null; status: string | null; created_at: string; reopened_at: string | null; feedback_at: string | null }[];
  };
}

const fmtDate = (v: Json | undefined, withTime = true): string | null => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  // Plain dates (yyyy-mm-dd) have no time worth showing.
  return format(d, withTime && v.length > 10 ? "MMM d, yyyy h:mm a" : "MMM d, yyyy");
};

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

const humanize = (s: string) => s.replace(/_/g, " ");

// Render any json value compactly: arrays as comma lists, objects as k: v.
function show(v: Json | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.length ? v.map((x) => show(x) ?? "").filter(Boolean).join(", ") : null;
  if (typeof v === "object") {
    const parts = Object.entries(v)
      .map(([k, x]) => (show(x) ? `${humanize(k)}: ${show(x)}` : null))
      .filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }
  return String(v);
}

const Detail: React.FC<{ label: string; value: React.ReactNode; title?: string }> = ({ label, value, title }) =>
  value === null || value === undefined || value === "" ? null : (
    <div className="lookup-detail" title={title}>
      <span className="lookup-detail-label">{label}</span>
      <span className="lookup-detail-value">{value}</span>
    </div>
  );

const Chips: React.FC<{ items: Json | undefined }> = ({ items }) => {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="user-interests-row">
      {items.map((x, i) => (
        <span key={i} className="user-interest-chip">
          {humanize(show(x) ?? "")}
        </span>
      ))}
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="lookup-lessons-section" style={{ marginTop: "1.5rem" }}>
    <h3 className="lookup-lessons-title">{title}</h3>
    {children}
  </div>
);

const UserProfileDetails: React.FC<{ userId: string; previousExperience: string | null }> = ({
  userId,
  previousExperience,
}) => {
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setError(null);
    supabase.rpc("user_profile_details", { p_user_id: userId }).then(({ data, error: err }) => {
      if (cancelled) return;
      if (err) setError(err.message);
      else setDetails(data as Details);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (error) {
    return (
      <div className="error-box" style={{ marginTop: "1rem" }}>
        <p>Couldn't load the full profile: {error}</p>
      </div>
    );
  }
  if (!details) {
    return <p className="loading-text" style={{ marginTop: "1rem" }}>Loading full profile…</p>;
  }

  const i = details.info ?? {};
  const a = details.activity;
  const rev = details.revenue;
  const lp = details.learner.profile;
  const exp = parseExperience(previousExperience, typeof i.learning_language === "string" ? i.learning_language : null);
  const lang = (v: Json | undefined) => (typeof v === "string" && v ? prettyLang(v) : null);

  return (
    <>
      <Section title="Profile">
        <div className="lookup-details-grid">
          <Detail label="Learning" value={lang(i.learning_language)} />
          <Detail label="Level" value={show(i.level)} />
          <Detail label="Reason" value={show(i.reason)} />
          <Detail label="Native (L1 code)" value={show(i.native_l1)} />
          <Detail label="Explanations in" value={show(i.explanation_language)} />
          <Detail label="Also speaks" value={show(i.spoken_languages)} />
          <Detail label="Tutor accent" value={show(i.tutor_accent)} />
          <Detail label="Messaging" value={show(i.messaging_platform)} />
          <Detail label="Community name" value={show(i.community_username)} />
          <Detail label="Creator" value={show(i.creator_slug)} />
          <Detail label="Attribution detail" value={show(i.attribution_detail)} />
          <Detail label="Referral code" value={show(i.referral_code)} />
          <Detail label="Experiment" value={show(i.experiment_assignment_id)} />
          <Detail label="Tutorial" value={i.completed_tutorial == null ? null : i.completed_tutorial ? "Completed" : "Incomplete"} />
          <Detail label="Lesson credits" value={show(i.lesson_credits)} />
          <Detail label="Pro" value={show(i.is_pro)} />
          <Detail label="Free daily lesson" value={show(i.free_daily_lesson)} />
          <Detail label="Creator account" value={i.is_creator ? "Yes" : null} />
          <Detail label="Left review" value={show(i.left_review)} />
          <Detail label="Upsell" value={show(i.upsell)} />
          <Detail label="Practice days" value={show(i.practice_days)} />
          <Detail label="Practice time" value={show(i.practice_times) ?? show(i.practice_time)} />
          <Detail label="Next lesson" value={fmtDate(i.next_lesson_time)} />
          <Detail label="Scheduled lesson on" value={fmtDate(i.scheduled_lesson_on, false)} />
          <Detail
            label="Goal target date"
            value={fmtDate(i.goal_target_date, false)}
            title={i.goal_target_source ? `Set via ${show(i.goal_target_source)}` : undefined}
          />
          <Detail label="Last active (local)" value={fmtDate(i.last_active_local_date, false)} />
          <Detail label="Last lesson completed" value={fmtDate(i.last_completed_at)} />
          <Detail
            label="Push notifications"
            value={i.has_push_token ? (i.push_token_dead_at ? `Token dead since ${fmtDate(i.push_token_dead_at, false)}` : "Enabled") : "No token"}
          />
          <Detail label="Last notification" value={fmtDate(i.last_notification_at)} />
        </div>
        {exp.length > 0 && (
          <div className="user-exp" style={{ marginTop: "1rem" }}>
            <div className="user-group-title">Onboarding Assessment</div>
            <div className="user-exp-row">
              {exp.map((e) => (
                <span
                  key={e.key}
                  className={`user-exp-chip${e.answered ? "" : " user-exp-chip--empty"}`}
                  title={`${e.question}  →  ${e.full}`}
                >
                  <span className="user-exp-emoji">{e.emoji}</span>
                  <span className="user-exp-text">
                    <span className="user-exp-cat">{e.category}</span>
                    <span className="user-exp-val">{e.full}</span>
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Section>

      {a && (
        <Section title="Activity">
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-value">{a.active_days}</div>
              <div className="metric-label">Active days</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{a.lessons_7d} / {a.lessons_30d}</div>
              <div className="metric-label">Lessons last 7 / 30 days</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{a.distinct_lessons}</div>
              <div className="metric-label">Different lessons</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{a.voice_practice_minutes} min</div>
              <div className="metric-label">Voice practice</div>
              <div className="metric-description">{a.voice_practice_sessions} sessions</div>
            </div>
          </div>
          <div className="lookup-details-grid">
            <Detail label="First lesson" value={fmtDate(a.first_lesson_at)} />
            <Detail label="Latest lesson" value={fmtDate(a.last_lesson_at)} />
          </div>
        </Section>
      )}

      <Section title={`Subscription & Payments (${rev.transactions.length} events)`}>
        <div className="lookup-details-grid">
          <Detail label="Trial started" value={fmtDate(i.trial_started_at)} />
          <Detail label="Became paying" value={fmtDate(i.became_active_at)} />
          <Detail label="Cancelled from" value={show(i.canceled_from)} />
          <Detail label="Access expires" value={fmtDate(i.access_expires_at)} />
          <Detail label="Billing issue" value={fmtDate(i.billing_issue_at)} />
          <Detail label="Became past due" value={fmtDate(i.became_past_due_at)} />
          <Detail label="Past due" value={fmtDate(i.past_due_at)} />
          <Detail label="Last billing notification" value={fmtDate(i.last_billing_notification_at)} />
          <Detail label="Last win-back notification" value={fmtDate(i.last_winback_notification_at)} />
          {rev.summary && (
            <>
              <Detail label="Trial plan" value={rev.summary.trial_product_id} />
              <Detail label="First paid plan" value={rev.summary.first_paid_product_id} />
              <Detail label="Current plan" value={rev.summary.current_product_id} />
              <Detail label="Payments" value={rev.summary.payments} />
              <Detail label="First paid" value={fmtDate(rev.summary.first_paid_at)} />
              <Detail label="Last paid" value={fmtDate(rev.summary.last_paid_at)} />
              <Detail label="Gross" value={usd(rev.summary.gross_usd)} />
              <Detail label="Refunded" value={Number(rev.summary.refunds_usd) ? usd(rev.summary.refunds_usd) : null} />
              <Detail label="Net (after store fees)" value={usd(rev.summary.net_usd)} />
            </>
          )}
        </div>
        {rev.transactions.length === 0 ? (
          <div className="empty-state">No store transactions linked to this user (since Mar 2026).</div>
        ) : (
          <div className="table-container" style={{ marginTop: "1rem" }}>
            <table className="data-table">
              <thead className="table-head">
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Plan</th>
                  <th>Price</th>
                  <th>Net</th>
                  <th>Country</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {rev.transactions.map((t, k) => (
                  <tr key={k}>
                    <td>{fmtDate(t.purchased_at)}</td>
                    <td>{humanize(t.event)}</td>
                    <td>{t.product_id ?? "—"}</td>
                    <td>
                      {usd(t.price_usd)}
                      {t.currency && t.currency !== "USD" && t.price_local != null && (
                        <span style={{ color: "#9ca3af", marginLeft: 6 }}>
                          {t.price_local} {t.currency}
                        </span>
                      )}
                    </td>
                    <td>{usd(t.proceeds_usd)}</td>
                    <td>{t.country ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {(lp || details.learner.aims.length > 0 || details.learner.languages.length > 0) && (
        <Section title="What the tutor knows about them">
          {lp && (
            <>
              <div className="lookup-details-grid">
                <Detail label="Estimated level" value={lp.estimated_level ? humanize(lp.estimated_level) : null} />
                <Detail label="Learning mode" value={lp.learning_mode ? humanize(lp.learning_mode) : null} />
                <Detail label="Tutor style" value={lp.preferred_tutor_style} />
                <Detail label="Plan focus" value={lp.current_plan_focus} />
                <Detail
                  label="Profile confidence"
                  value={lp.profile_confidence != null ? `${Math.round(Number(lp.profile_confidence) * 100)}%` : null}
                />
                <Detail label="Profile updated" value={fmtDate(lp.updated_at)} />
              </div>
              {lp.primary_goal && (
                <p style={{ margin: "0.75rem 0" }}>
                  <strong>Primary goal:</strong> {lp.primary_goal}
                </p>
              )}
              {([
                ["Secondary goals", lp.secondary_goals],
                ["Real situations", lp.real_situations],
                ["Pain points", lp.pain_points],
                ["Interests", lp.interests],
                ["Tutor rules", lp.avoid_rules],
              ] as [string, Json][]).map(([label, items]) =>
                Array.isArray(items) && items.length > 0 ? (
                  <div key={label} style={{ marginTop: "0.6rem" }}>
                    <div className="user-group-title">{label}</div>
                    <Chips items={items} />
                  </div>
                ) : null,
              )}
              {show(lp.onboarding_context) && (
                <div style={{ marginTop: "0.6rem" }}>
                  <div className="user-group-title">Onboarding context</div>
                  <p style={{ margin: "0.25rem 0", color: "#4b5563" }}>{show(lp.onboarding_context)}</p>
                </div>
              )}
            </>
          )}
          {details.learner.aims.length > 0 && (
            <div style={{ marginTop: "0.6rem" }}>
              <div className="user-group-title">Learning aims</div>
              {details.learner.aims.map((aim, k) => (
                <p key={k} style={{ margin: "0.25rem 0" }}>
                  {aim.aim}{" "}
                  <span style={{ color: "#9ca3af" }}>
                    ({aim.language} · rev {aim.revision} · {fmtDate(aim.created_at, false)})
                  </span>
                </p>
              ))}
            </div>
          )}
          {details.learner.languages.length > 0 && (
            <div style={{ marginTop: "0.6rem" }}>
              <div className="user-group-title">Languages</div>
              <div className="user-interests-row">
                {details.learner.languages.map((l) => (
                  <span key={l.language} className="user-interest-chip" title={l.last_active_at ? `Last active ${fmtDate(l.last_active_at)}` : undefined}>
                    {prettyLang(l.language)}
                    {l.level && ` · ${l.level}`}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {details.exit_feedback.length > 0 && (
        <Section title={`Why they left calls (${details.exit_feedback.length})`}>
          <div className="table-container">
            <table className="data-table">
              <thead className="table-head">
                <tr>
                  <th>When</th>
                  <th>Lesson</th>
                  <th>Exit phase</th>
                  <th>Reasons</th>
                  <th>In their words</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {details.exit_feedback.map((f, k) => (
                  <tr key={k}>
                    <td>{fmtDate(f.created_at)}</td>
                    <td>#{f.lesson_id}</td>
                    <td>{f.exit_phase ? humanize(f.exit_phase) : "—"}</td>
                    <td>{(f.reasons ?? []).map(humanize).join(", ") || "—"}</td>
                    <td>{f.written_reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {(details.content.custom_lessons_total > 0 ||
        details.content.daily_lessons_total > 0 ||
        details.content.saved_cards.length > 0) && (
        <Section title="Content">
          <div className="lookup-details-grid">
            <Detail label="Custom lessons made" value={details.content.custom_lessons_total} />
            <Detail label="Daily lessons generated" value={details.content.daily_lessons_total} />
            <Detail label="Saved concept cards" value={details.content.saved_cards.length || null} />
          </div>
          {details.content.custom_lessons.length > 0 && (
            <div style={{ marginTop: "0.6rem" }}>
              <div className="user-group-title">Custom lessons</div>
              <div className="user-interests-row">
                {details.content.custom_lessons.map((c) => (
                  <span
                    key={c.id}
                    className="user-interest-chip"
                    title={[c.topic, c.level, c.source, fmtDate(c.created_at, false)].filter(Boolean).join(" · ")}
                  >
                    {c.title || `#${c.id}`}
                  </span>
                ))}
              </div>
            </div>
          )}
          {details.content.saved_cards.length > 0 && (
            <div style={{ marginTop: "0.6rem" }}>
              <div className="user-group-title">Saved concept cards</div>
              <div className="user-interests-row">
                {details.content.saved_cards.map((c, k) => (
                  <span key={k} className="user-interest-chip" title={c.body ?? undefined}>
                    {c.title || "Untitled"}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {(details.email.total > 0 || details.email.state) && (
        <Section title={`Emails (${details.email.total})`}>
          <div className="lookup-details-grid">
            <Detail label="Unsubscribed" value={details.email.state ? show(details.email.state.unsubscribed) : null} />
            <Detail label="Last email" value={fmtDate(details.email.state?.last_sent_at)} />
            <Detail label="Last email type" value={details.email.state?.last_email_type ? humanize(details.email.state.last_email_type) : null} />
          </div>
          {details.email.recent.length > 0 && (
            <div className="table-container" style={{ marginTop: "1rem" }}>
              <table className="data-table">
                <thead className="table-head">
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {details.email.recent.map((e, k) => (
                    <tr key={k}>
                      <td>{fmtDate(e.created_at)}</td>
                      <td>{e.email_type ? humanize(e.email_type) : "—"}</td>
                      <td>
                        {e.status ?? "—"}
                        {e.reopened_at && <span style={{ color: "#4f46e5", marginLeft: "0.4rem" }}>· reopened</span>}
                        {e.feedback_at && <span style={{ color: "#059669", marginLeft: "0.4rem" }}>· gave feedback</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {details.email.total > details.email.recent.length && (
            <p className="ret-chart-sub" style={{ marginTop: "0.5rem" }}>
              Showing the {details.email.recent.length} most recent of {details.email.total}.
            </p>
          )}
        </Section>
      )}
    </>
  );
};

export default UserProfileDetails;
