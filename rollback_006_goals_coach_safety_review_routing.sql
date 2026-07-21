-- Rollback 006 is intentionally preservation-first.  It can remove the
-- schema only when no Phase 1D concern, routing, alert, or restriction data
-- exists.  Existing pre-Phase-1D review history is left intact.
LOCK TABLE coaching_review_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE coaching_reviews IN ACCESS EXCLUSIVE MODE;
LOCK TABLE coaching_concerns IN ACCESS EXCLUSIVE MODE;
LOCK TABLE coaching_review_routing_attempts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE goals_coach_review_routing_alerts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE goals_coach_human_restrictions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM coaching_review_routing_attempts)
     OR EXISTS (SELECT 1 FROM goals_coach_review_routing_alerts)
     OR EXISTS (SELECT 1 FROM goals_coach_human_restrictions)
     OR EXISTS (
       SELECT 1 FROM coaching_concerns
       WHERE safety_rule_version IS NOT NULL
          OR safety_classifier_version IS NOT NULL
          OR classification_result_json IS NOT NULL
          OR member_response IS NOT NULL
          OR environment IS NOT NULL
     )
     OR EXISTS (
       SELECT 1 FROM coaching_reviews
       WHERE routing_attempt_count <> 0
          OR routing_status <> 'pending'
          OR route_destination_type IS NOT NULL
          OR last_route_attempt_at IS NOT NULL
          OR last_route_succeeded_at IS NOT NULL
          OR routing_error_code IS NOT NULL
          OR target_response_at IS NOT NULL
     )
     OR EXISTS (
       SELECT 1 FROM coaching_review_events
       WHERE event_type IN (
         'route_attempted', 'route_succeeded', 'route_failed', 'review_acknowledged',
         'internal_note_added', 'response_drafted', 'response_approved',
         'member_response_sent', 'restriction_added', 'review_reopened'
       )
     ) THEN
    RAISE EXCEPTION 'Migration 006 rollback requires preservation of Phase 1D safety and review-routing records'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_safety_review_rollback_preservation_required';
  END IF;
END;
$$;

DROP INDEX IF EXISTS idx_goals_coach_review_routing_alerts_open;
DROP TABLE IF EXISTS goals_coach_review_routing_alerts;
DROP INDEX IF EXISTS idx_goals_coach_human_restrictions_member;
DROP TABLE IF EXISTS goals_coach_human_restrictions;
DROP INDEX IF EXISTS idx_coaching_review_routing_attempts_review;
DROP TABLE IF EXISTS coaching_review_routing_attempts;

ALTER TABLE coaching_review_events
  DROP CONSTRAINT IF EXISTS coaching_review_events_event_type_check;
ALTER TABLE coaching_review_events
  ADD CONSTRAINT coaching_review_events_event_type_check CHECK (event_type IN (
    'created', 'assigned', 'reassigned', 'review_started',
    'staff_message_added', 'member_follow_up_completed', 'resolved', 'no_action_needed'
  ));

ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_assigned_staff_user_id_status_check;
ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_status_resolved_at_check;
ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_member_follow_up_complete_before_close;
ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_status_check;
ALTER TABLE coaching_reviews
  ADD CONSTRAINT coaching_reviews_status_check CHECK (status IN (
    'awaiting_review', 'assigned', 'in_review', 'resolved', 'no_action_needed'
  ));
ALTER TABLE coaching_reviews
  ADD CONSTRAINT coaching_reviews_assigned_staff_user_id_status_check CHECK (
    (assigned_staff_user_id IS NULL AND status = 'awaiting_review')
    OR
    (assigned_staff_user_id IS NOT NULL AND status IN ('assigned', 'in_review', 'resolved', 'no_action_needed'))
  );
ALTER TABLE coaching_reviews
  ADD CONSTRAINT coaching_reviews_status_resolved_at_check CHECK (
    (status IN ('resolved', 'no_action_needed') AND resolved_at IS NOT NULL)
    OR
    (status NOT IN ('resolved', 'no_action_needed') AND resolved_at IS NULL)
  );
ALTER TABLE coaching_reviews
  ADD CONSTRAINT coaching_reviews_member_follow_up_complete_before_close CHECK (
    status NOT IN ('resolved', 'no_action_needed')
    OR member_follow_up_required = FALSE
    OR member_follow_up_status = 'completed'
  );
ALTER TABLE coaching_reviews
  DROP COLUMN IF EXISTS routing_status,
  DROP COLUMN IF EXISTS routing_attempt_count,
  DROP COLUMN IF EXISTS route_destination_type,
  DROP COLUMN IF EXISTS last_route_attempt_at,
  DROP COLUMN IF EXISTS last_route_succeeded_at,
  DROP COLUMN IF EXISTS routing_error_code,
  DROP COLUMN IF EXISTS target_response_at;

ALTER TABLE coaching_concerns
  DROP CONSTRAINT IF EXISTS coaching_concerns_classification_result_object;
ALTER TABLE coaching_concerns
  DROP CONSTRAINT IF EXISTS coaching_concerns_concern_category_check;
ALTER TABLE coaching_concerns
  ADD CONSTRAINT coaching_concerns_concern_category_check CHECK (concern_category IN (
    'pain', 'pressure', 'muscle_fatigue', 'instability', 'fear',
    'technique_confusion', 'equipment', 'schedule', 'recovery', 'other'
  ));
ALTER TABLE coaching_concerns
  DROP COLUMN IF EXISTS safety_rule_version,
  DROP COLUMN IF EXISTS safety_classifier_version,
  DROP COLUMN IF EXISTS classification_result_json,
  DROP COLUMN IF EXISTS member_response,
  DROP COLUMN IF EXISTS environment;
