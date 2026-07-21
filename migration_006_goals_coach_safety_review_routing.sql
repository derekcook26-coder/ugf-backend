-- Goals Coach 2.0 Phase 1D safety, review routing, and human restriction provenance.
-- Additive only. Existing concern and review history remains readable under its
-- original lifecycle values.

ALTER TABLE coaching_concerns
  ADD COLUMN safety_rule_version TEXT,
  ADD COLUMN safety_classifier_version TEXT,
  ADD COLUMN classification_result_json JSONB,
  ADD COLUMN member_response TEXT,
  ADD COLUMN environment TEXT;

ALTER TABLE coaching_concerns
  DROP CONSTRAINT IF EXISTS coaching_concerns_concern_category_check;
ALTER TABLE coaching_concerns
  ADD CONSTRAINT coaching_concerns_concern_category_check CHECK (concern_category IN (
    'pain', 'pressure', 'muscle_fatigue', 'instability', 'fear',
    'technique_confusion', 'equipment', 'schedule', 'recovery', 'other',
    'member_request', 'plan_change', 'substitution_uncertainty',
    'technique_uncertainty', 'pain_or_injury', 'safety',
    'disputed_information', 'ai_uncertainty', 'technical_failure'
  ));
ALTER TABLE coaching_concerns
  ADD CONSTRAINT coaching_concerns_classification_result_object CHECK (
    classification_result_json IS NULL OR jsonb_typeof(classification_result_json) = 'object'
  );

ALTER TABLE coaching_reviews
  ADD COLUMN routing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (routing_status IN ('pending', 'attempting', 'delivered', 'failed', 'not_required')),
  ADD COLUMN routing_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (routing_attempt_count >= 0),
  ADD COLUMN route_destination_type TEXT,
  ADD COLUMN last_route_attempt_at TIMESTAMPTZ,
  ADD COLUMN last_route_succeeded_at TIMESTAMPTZ,
  ADD COLUMN routing_error_code TEXT,
  ADD COLUMN target_response_at TIMESTAMPTZ;

ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_status_check;
ALTER TABLE coaching_reviews
  ADD CONSTRAINT coaching_reviews_status_check CHECK (status IN (
    'awaiting_review', 'assigned', 'in_review', 'resolved', 'no_action_needed',
    'new', 'routed', 'acknowledged', 'under_review', 'waiting_for_member',
    'waiting_for_outside_guidance', 'response_ready', 'member_notified',
    'closed', 'routing_failed', 'reopened'
  ));
ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_assigned_staff_user_id_status_check;
ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_check;
ALTER TABLE coaching_reviews
  ADD CONSTRAINT coaching_reviews_assigned_staff_user_id_status_check CHECK (
    status NOT IN ('assigned', 'in_review', 'acknowledged', 'under_review',
      'waiting_for_member', 'waiting_for_outside_guidance', 'response_ready',
      'member_notified')
    OR assigned_staff_user_id IS NOT NULL
  );
ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_status_resolved_at_check;
ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_check1;
ALTER TABLE coaching_reviews
  ADD CONSTRAINT coaching_reviews_status_resolved_at_check CHECK (
    (status IN ('resolved', 'no_action_needed', 'closed') AND resolved_at IS NOT NULL)
    OR
    (status NOT IN ('resolved', 'no_action_needed', 'closed') AND resolved_at IS NULL)
  );
ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_member_follow_up_required_member_follow_up_status_member_follow_up_completed_at_check;
ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_check3;
ALTER TABLE coaching_reviews
  DROP CONSTRAINT IF EXISTS coaching_reviews_member_follow_up_complete_before_close;
ALTER TABLE coaching_reviews
  ADD CONSTRAINT coaching_reviews_member_follow_up_complete_before_close CHECK (
    status NOT IN ('resolved', 'no_action_needed', 'closed')
    OR member_follow_up_required = FALSE
    OR member_follow_up_status = 'completed'
  );

ALTER TABLE coaching_review_events
  DROP CONSTRAINT IF EXISTS coaching_review_events_event_type_check;
ALTER TABLE coaching_review_events
  ADD CONSTRAINT coaching_review_events_event_type_check CHECK (event_type IN (
    'created', 'assigned', 'reassigned', 'review_started',
    'staff_message_added', 'member_follow_up_completed', 'resolved', 'no_action_needed',
    'route_attempted', 'route_succeeded', 'route_failed', 'review_acknowledged',
    'internal_note_added', 'response_drafted', 'response_approved',
    'member_response_sent', 'restriction_added', 'review_reopened'
  ));

CREATE TABLE coaching_review_routing_attempts (
  id BIGSERIAL PRIMARY KEY,
  review_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  destination_type TEXT NOT NULL CHECK (char_length(btrim(destination_type)) BETWEEN 1 AND 100),
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('attempted', 'delivered', 'failed')),
  error_code TEXT,
  destination_receipt_reference TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  payload_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_summary_json) = 'object'),
  CHECK (
    (delivery_status = 'attempted' AND completed_at IS NULL AND error_code IS NULL AND destination_receipt_reference IS NULL)
    OR
    (delivery_status = 'delivered' AND completed_at IS NOT NULL AND error_code IS NULL AND destination_receipt_reference IS NOT NULL)
    OR
    (delivery_status = 'failed' AND completed_at IS NOT NULL AND error_code IS NOT NULL AND destination_receipt_reference IS NULL)
  ),
  FOREIGN KEY (review_id, member_id) REFERENCES coaching_reviews(id, member_id) ON DELETE RESTRICT,
  UNIQUE (review_id, attempt_number)
);
CREATE INDEX idx_coaching_review_routing_attempts_review
  ON coaching_review_routing_attempts (review_id, attempt_number DESC);

CREATE TABLE goals_coach_review_routing_alerts (
  id BIGSERIAL PRIMARY KEY,
  review_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'routing_failed', 'routing_retry_pending', 'routing_exhausted'
  )),
  delivery_attempt_number INTEGER NOT NULL CHECK (delivery_attempt_number >= 0),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  FOREIGN KEY (review_id, member_id) REFERENCES coaching_reviews(id, member_id) ON DELETE RESTRICT,
  UNIQUE (review_id, alert_type, delivery_attempt_number)
);
CREATE INDEX idx_goals_coach_review_routing_alerts_open
  ON goals_coach_review_routing_alerts (alert_type, acknowledged_at, created_at DESC);

CREATE TABLE goals_coach_human_restrictions (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  review_id BIGINT NOT NULL,
  author_staff_user_id BIGINT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  restriction_type TEXT NOT NULL CHECK (restriction_type IN (
    'prohibited_exercise', 'approved_substitution', 'intensity_limit',
    'paused_workout_category', 'review_required_before_progression', 'plan_reference'
  )),
  instruction_text TEXT NOT NULL CHECK (char_length(btrim(instruction_text)) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at IS NULL OR expires_at > effective_at),
  FOREIGN KEY (conversation_id, member_id) REFERENCES coaching_conversations(id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (review_id, member_id) REFERENCES coaching_reviews(id, member_id) ON DELETE RESTRICT
);
CREATE INDEX idx_goals_coach_human_restrictions_member
  ON goals_coach_human_restrictions (member_id, status, effective_at DESC, id DESC);
