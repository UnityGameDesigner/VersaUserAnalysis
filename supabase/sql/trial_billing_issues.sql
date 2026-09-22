-- trial_billing_issues(start_date, end_date)
--
-- Every trial user who hit a billing issue (the trial-end / renewal charge FAILED),
-- with WHEN it happened: both days-since-trial-start (when in the trial lifecycle)
-- and the calendar date (when on the clock). Powers the "Billing issues" view on the
-- Trial Retention tab. Filtered by TRIAL-START date so it lines up with the page's
-- Timeline range (cohort-based, like the other views).
--
-- Billing-issue timestamp = user_info.past_due_at (100% populated on PAST_DUE — the
-- reliable one; became_past_due_at is our ~52% webhook, billing_issue_at is unused).
-- ~86% land on day 7-8 (the trial-end charge); a small tail is later renewal failures.

drop function if exists public.trial_billing_issues(date, date);

create or replace function public.trial_billing_issues(start_date date default null, end_date date default null)
returns table(
  trial_day date,
  past_due_day date,
  days_since int,
  converted boolean,   -- did they ever convert (became_active_at) before the issue
  platform text,
  payment_status text,
  canceled_from text
)
language sql stable as $$
  select
    (u.trial_started_at at time zone 'UTC')::date as trial_day,
    (u.past_due_at at time zone 'UTC')::date as past_due_day,
    greatest(((u.past_due_at at time zone 'UTC')::date - (u.trial_started_at at time zone 'UTC')::date), 0)::int as days_since,
    (u.became_active_at is not null) as converted,
    u.platform, u.payment_status, u.canceled_from
  from user_info u
  where u.trial_started_at is not null
    and u.past_due_at is not null
    and (u.trial_started_at at time zone 'UTC')::date >= coalesce(start_date, '2025-01-01'::date)
    and (u.trial_started_at at time zone 'UTC')::date <= coalesce(end_date, (now())::date);
$$;

grant execute on function public.trial_billing_issues(date, date) to anon, authenticated;
