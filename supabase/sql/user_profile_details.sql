-- RPC behind the "Everything we know" panels on the User Lookup profile
-- (src/UserProfileDetails.tsx): every per-user fact the dashboard doesn't
-- already load elsewhere, in one round trip.
--
--   info          user_info columns not already on the profile card (no
--                 push_token / phone_number / experiment token — only whether
--                 a push token exists)
--   activity      active days, lessons, first/last lesson, voice practice
--   revenue       user_revenue row + every subscription_transactions event
--   learner       learner_profiles (what the tutor has learned about them),
--                 learning_aims, user_language_progress
--   exit_feedback call_exit_feedback the user submitted (why they left a call)
--   content       custom lessons they made, daily lessons, saved concept cards
--   email         email_retention_state + email_send_log summary / recent sends
--
-- Several of these tables are owner-read only, so this is SECURITY DEFINER and
-- refuses anyone not in admin_users. Idempotent — safe to re-run.

create or replace function public.user_profile_details(p_user_id uuid)
returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return (
    select json_build_object(
      'info', (
        select json_build_object(
          'learning_language', ui.learning_language,
          'level', ui.level,
          'reason', ui.reason,
          'native_l1', ui.native_l1,
          'explanation_language', ui.explanation_language,
          'spoken_languages', ui.spoken_languages,
          'tutor_accent', ui.tutor_accent,
          'creator_slug', ui.creator_slug,
          'attribution_detail', ui.attribution_detail,
          'referral_code', ui.referral_code,
          'messaging_platform', ui.messaging_platform,
          'completed_tutorial', ui.completed_tutorial,
          'lesson_credits', ui.lesson_credits,
          'free_daily_lesson', ui.free_daily_lesson,
          'is_pro', ui.is_pro,
          'is_creator', ui.is_creator,
          'left_review', ui.left_review,
          'upsell', ui.upsell,
          'practice_days', ui.practice_days,
          'practice_time', ui.practice_time,
          'practice_times', ui.practice_times,
          'next_lesson_time', ui.next_lesson_time,
          'scheduled_lesson_on', ui.scheduled_lesson_on,
          'goal_target_date', ui.goal_target_date,
          'goal_target_source', ui.goal_target_source,
          'goal_target_set_at', ui.goal_target_set_at,
          'last_active_local_date', ui.last_active_local_date,
          'last_completed_at', ui.last_completed_at,
          'last_notification_at', ui.last_notification_at,
          'has_push_token', ui.push_token is not null and ui.push_token <> '',
          'push_token_dead_at', ui.push_token_dead_at,
          'trial_started_at', ui.trial_started_at,
          'became_active_at', ui.became_active_at,
          'became_past_due_at', ui.became_past_due_at,
          'past_due_at', ui.past_due_at,
          'billing_issue_at', ui.billing_issue_at,
          'canceled_from', ui.canceled_from,
          'access_expires_at', ui.access_expires_at,
          'last_billing_notification_at', ui.last_billing_notification_at,
          'last_winback_notification_at', ui.last_winback_notification_at,
          'experiment_assignment_id', ui.experiment_assignment_id,
          'community_username', (select cp.username from community_profiles cp where cp.user_id = p_user_id limit 1)
        )
        from user_info ui where ui.user_id = p_user_id
        limit 1
      ),
      'activity', (
        select json_build_object(
          'lessons', count(*),
          'active_days', count(distinct (cl.created_at at time zone 'UTC')::date),
          'first_lesson_at', min(cl.created_at),
          'last_lesson_at', max(cl.created_at),
          'lessons_7d', count(*) filter (where cl.created_at >= now() - interval '7 days'),
          'lessons_30d', count(*) filter (where cl.created_at >= now() - interval '30 days'),
          'distinct_lessons', count(distinct cl.lesson_id),
          'voice_practice_sessions', (select count(*) from voice_practice_sessions v where v.user_id = p_user_id),
          'voice_practice_minutes', (select round(coalesce(sum(v.seconds), 0) / 60.0) from voice_practice_sessions v where v.user_id = p_user_id)
        )
        from completed_lessons cl
        where cl.user_id = p_user_id and cl.lesson_id is distinct from 42
      ),
      'revenue', json_build_object(
        'summary', (select to_json(ur) from user_revenue ur where ur.user_id = p_user_id limit 1),
        'transactions', (
          select coalesce(json_agg(json_build_object(
                   'event', st.event, 'product_id', st.product_id, 'platform', st.platform,
                   'period_type', st.period_type, 'price_usd', st.price_usd, 'proceeds_usd', st.proceeds_usd,
                   'currency', st.currency, 'price_local', st.price_local, 'country', st.country,
                   'purchased_at', st.purchased_at
                 ) order by st.purchased_at desc), '[]'::json)
          from subscription_transactions st where st.user_id = p_user_id
        )
      ),
      'learner', json_build_object(
        'profile', (
          select json_build_object(
            'estimated_level', lp.estimated_level, 'learning_mode', lp.learning_mode,
            'primary_goal', lp.primary_goal, 'secondary_goals', lp.secondary_goals,
            'real_situations', lp.real_situations, 'pain_points', lp.pain_points,
            'interests', lp.interests, 'preferred_tutor_style', lp.preferred_tutor_style,
            'avoid_rules', lp.avoid_rules, 'current_plan_focus', lp.current_plan_focus,
            'onboarding_context', lp.onboarding_context,
            'profile_confidence', lp.profile_confidence, 'updated_at', lp.updated_at
          )
          from learner_profiles lp where lp.user_id = p_user_id limit 1
        ),
        'aims', (
          select coalesce(json_agg(json_build_object('language', a.language, 'aim', a.aim, 'source', a.source,
                                                     'revision', a.revision, 'created_at', a.created_at)
                                   order by a.created_at desc), '[]'::json)
          from learning_aims a where a.user_id = p_user_id
        ),
        'languages', (
          select coalesce(json_agg(json_build_object('language', p.language, 'level', p.level,
                                                     'last_active_at', p.last_active_at)
                                   order by p.last_active_at desc nulls last), '[]'::json)
          from user_language_progress p where p.user_id = p_user_id
        )
      ),
      'exit_feedback', (
        select coalesce(json_agg(json_build_object('lesson_id', c.lesson_id, 'exit_phase', c.exit_phase,
                                                   'reasons', c.reasons, 'written_reason', nullif(c.written_reason, ''),
                                                   'created_at', c.created_at)
                                 order by c.created_at desc), '[]'::json)
        from call_exit_feedback c where c.user_id = p_user_id and c.submitted
      ),
      'content', json_build_object(
        'custom_lessons', (
          select coalesce(json_agg(json_build_object('id', x.id, 'title', x.title, 'topic', x.topic,
                                                     'level', x.level, 'source', x.source, 'created_at', x.created_at)
                                   order by x.created_at desc), '[]'::json)
          from (select * from custom_lessons where user_id = p_user_id order by created_at desc limit 50) x
        ),
        'custom_lessons_total', (select count(*) from custom_lessons where user_id = p_user_id),
        'daily_lessons_total', (select count(*) from daily_lessons where user_id = p_user_id),
        'saved_cards', (
          select coalesce(json_agg(json_build_object('title', x.title, 'body', x.body, 'created_at', x.created_at)
                                   order by x.created_at desc), '[]'::json)
          from (select * from saved_concept_cards where user_id = p_user_id order by created_at desc limit 50) x
        )
      ),
      'email', json_build_object(
        'state', (
          select json_build_object('unsubscribed', e.unsubscribed, 'last_sent_at', e.last_sent_at,
                                   'last_email_type', e.last_email_type)
          from email_retention_state e where e.user_id = p_user_id limit 1
        ),
        'total', (select count(*) from email_send_log where user_id = p_user_id),
        'recent', (
          select coalesce(json_agg(json_build_object('email_type', x.email_type, 'status', x.status,
                                                     'created_at', x.created_at, 'reopened_at', x.reopened_at,
                                                     'feedback_at', x.feedback_at)
                                   order by x.created_at desc), '[]'::json)
          from (select * from email_send_log where user_id = p_user_id order by created_at desc limit 20) x
        )
      )
    )
  );
end;
$$;

revoke all on function public.user_profile_details(uuid) from public, anon;
grant execute on function public.user_profile_details(uuid) to authenticated;

notify pgrst, 'reload schema';
