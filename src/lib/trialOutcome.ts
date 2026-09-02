// Actual trial outcome derived from the ground-truth trial_started_at /
// became_active_at on user_info (added by the conversion-tracking work). This is
// the ACTUAL outcome, not a prediction: "converted" = became active out of a
// trial; "churned" = the trial is old enough to have resolved with no
// activation; "in_trial" = trial started recently, outcome not yet certain;
// "none" = no trial recorded. Analysis of resolved trials: ~88% of conversions
// land by day 14 and p90 ≈ 30 days, so a trial with no activation after
// TRIAL_RESOLVE_DAYS is safely counted as churned; more recent ones stay
// "in trial" rather than be mislabeled. Shared by All Transcripts and User Lookup.

export const TRIAL_RESOLVE_DAYS = 21;

export type TrialOutcome = "converted" | "churned" | "in_trial" | "none";

export const TRIAL_OUTCOME_META: Record<
  TrialOutcome,
  { label: string; variant: string; hint: string }
> = {
  converted: {
    label: "Converted",
    variant: "converted",
    hint: "Started a trial and became an active (paying) user.",
  },
  churned: {
    label: "Churned",
    variant: "churned",
    hint: `Trial ended without converting (no activation ${TRIAL_RESOLVE_DAYS}+ days after it started).`,
  },
  in_trial: {
    label: "In trial",
    variant: "in-trial",
    hint: `Trial started in the last ${TRIAL_RESOLVE_DAYS} days — outcome not yet certain.`,
  },
  none: {
    label: "No trial",
    variant: "none",
    hint: "No trial recorded for this user.",
  },
};

// Order for the filter dropdown (skips "All", which the UI prepends).
export const TRIAL_OUTCOME_ORDER: TrialOutcome[] = ["converted", "churned", "in_trial", "none"];

export function trialOutcome(
  meta: { trial_started_at?: string | null; became_active_at?: string | null } | undefined | null,
): TrialOutcome {
  if (!meta) return "none";
  if (meta.became_active_at) return "converted";
  if (!meta.trial_started_at) return "none";
  const started = new Date(meta.trial_started_at).getTime();
  if (Number.isNaN(started)) return "none";
  return started <= Date.now() - TRIAL_RESOLVE_DAYS * 86_400_000 ? "churned" : "in_trial";
}
