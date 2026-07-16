-- Phase 2 Goals Coach coaching-foundation schema.
-- Additive only: no existing row is rewritten or deleted.

ALTER TABLE coach_plans
  ADD CONSTRAINT uq_coach_plans_id_member UNIQUE (id, member_id);

ALTER TABLE weekly_checkins
  ADD CONSTRAINT uq_weekly_checkins_id_member UNIQUE (id, member_id);

CREATE TABLE staff_users (
  id BIGSERIAL PRIMARY KEY,
  auth_provider TEXT NOT NULL DEFAULT 'clerk'
    CHECK (auth_provider = 'clerk'),
  auth_subject TEXT NOT NULL
    CHECK (auth_subject ~ '^user_[A-Za-z0-9_-]+$'),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  role TEXT NOT NULL CHECK (role IN ('coach', 'admin')),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auth_provider, auth_subject)
);

CREATE UNIQUE INDEX uq_staff_users_email_ci
  ON staff_users (lower(email));

CREATE TABLE member_coach_assignments (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES coach_members(id) ON DELETE RESTRICT,
  staff_user_id BIGINT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  assignment_type TEXT NOT NULL CHECK (assignment_type IN ('primary', 'secondary')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  created_by_staff_user_id BIGINT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  ended_by_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'active' AND ends_at IS NULL AND ended_by_staff_user_id IS NULL)
    OR
    (status = 'ended' AND ends_at IS NOT NULL AND ended_by_staff_user_id IS NOT NULL)
  ),
  UNIQUE (id, member_id, staff_user_id)
);

CREATE UNIQUE INDEX uq_member_active_primary_coach
  ON member_coach_assignments (member_id)
  WHERE status = 'active' AND assignment_type = 'primary';

CREATE UNIQUE INDEX uq_member_active_coach_pair
  ON member_coach_assignments (member_id, staff_user_id)
  WHERE status = 'active';

CREATE INDEX idx_member_coach_assignments_staff
  ON member_coach_assignments (staff_user_id, status, member_id);

CREATE TABLE coach_plan_exercises (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES coach_plans(id) ON DELETE CASCADE,
  plan_item_key TEXT NOT NULL CHECK (char_length(btrim(plan_item_key)) BETWEEN 1 AND 200),
  workout_label TEXT,
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
  exercise_name TEXT NOT NULL CHECK (char_length(btrim(exercise_name)) BETWEEN 1 AND 300),
  movement_pattern TEXT,
  primary_training_goal TEXT,
  muscle_groups_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(muscle_groups_json) = 'array'),
  workout_phase TEXT,
  program_role TEXT,
  equipment_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(equipment_json) = 'array'),
  limitation_considerations_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(limitation_considerations_json) = 'array'),
  program_balance_tags_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(program_balance_tags_json) = 'array'),
  prescription_json JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(prescription_json) = 'object'),
  intent_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (intent_source IN ('unknown', 'plan_generation', 'staff_review', 'imported')),
  intent_evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(intent_evidence_json) = 'object'),
  intent_validation_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (intent_validation_status IN ('unknown', 'unreviewed', 'validated', 'needs_revision')),
  intent_notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_id, plan_item_key),
  UNIQUE (id, plan_id)
);

CREATE TABLE coaching_conversations (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES coach_members(id) ON DELETE RESTRICT,
  plan_id BIGINT NOT NULL,
  assigned_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'superseded')),
  context_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(context_summary_json) = 'object'),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'active' AND archived_at IS NULL)
    OR
    (status IN ('archived', 'superseded') AND archived_at IS NOT NULL)
  ),
  FOREIGN KEY (plan_id, member_id)
    REFERENCES coach_plans(id, member_id) ON DELETE RESTRICT,
  UNIQUE (id, member_id),
  UNIQUE (id, member_id, plan_id)
);

CREATE UNIQUE INDEX uq_member_active_conversation_per_plan
  ON coaching_conversations (member_id, plan_id)
  WHERE status = 'active';

CREATE INDEX idx_coaching_conversations_member
  ON coaching_conversations (member_id, updated_at DESC);

CREATE TABLE coaching_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('member', 'goals_coach', 'staff')),
  sender_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  content TEXT NOT NULL CHECK (char_length(btrim(content)) BETWEEN 1 AND 8000),
  structured_response_json JSONB,
  client_message_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (sender_type = 'staff' AND sender_staff_user_id IS NOT NULL)
    OR
    (sender_type IN ('member', 'goals_coach') AND sender_staff_user_id IS NULL)
  ),
  CHECK (
    structured_response_json IS NULL
    OR jsonb_typeof(structured_response_json) = 'object'
  ),
  FOREIGN KEY (conversation_id, member_id)
    REFERENCES coaching_conversations(id, member_id) ON DELETE RESTRICT,
  UNIQUE (conversation_id, client_message_id),
  UNIQUE (id, conversation_id, member_id),
  UNIQUE (id, conversation_id, member_id, sender_type)
);

CREATE INDEX idx_coaching_messages_conversation
  ON coaching_messages (conversation_id, created_at, id);

CREATE TABLE coaching_concerns (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  source_message_sender_type TEXT NOT NULL DEFAULT 'member'
    CHECK (source_message_sender_type = 'member'),
  plan_id BIGINT NOT NULL,
  plan_exercise_id BIGINT,
  concern_category TEXT NOT NULL CHECK (concern_category IN (
    'pain', 'pressure', 'muscle_fatigue', 'instability', 'fear',
    'technique_confusion', 'equipment', 'schedule', 'recovery', 'other'
  )),
  safety_level TEXT NOT NULL CHECK (safety_level IN ('routine', 'caution', 'priority', 'urgent')),
  concerning_signals_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(concerning_signals_json) = 'array'),
  stop_exercise BOOLEAN NOT NULL DEFAULT FALSE,
  member_follow_up_required BOOLEAN NOT NULL DEFAULT FALSE,
  member_follow_up_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (member_follow_up_status IN ('not_required', 'pending', 'completed')),
  member_follow_up_completed_at TIMESTAMPTZ,
  member_description TEXT,
  recommendation_json JSONB CHECK (
    recommendation_json IS NULL OR jsonb_typeof(recommendation_json) = 'object'
  ),
  suggested_substitution_json JSONB CHECK (
    suggested_substitution_json IS NULL OR jsonb_typeof(suggested_substitution_json) = 'object'
  ),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved')),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status <> 'resolved' AND resolved_at IS NULL)
    OR
    (status = 'resolved' AND resolved_at IS NOT NULL)
  ),
  CHECK (
    (member_follow_up_required = FALSE
      AND member_follow_up_status = 'not_required'
      AND member_follow_up_completed_at IS NULL)
    OR
    (member_follow_up_required = TRUE
      AND member_follow_up_status = 'pending'
      AND member_follow_up_completed_at IS NULL)
    OR
    (member_follow_up_required = TRUE
      AND member_follow_up_status = 'completed'
      AND member_follow_up_completed_at IS NOT NULL)
  ),
  CHECK (
    status <> 'resolved'
    OR member_follow_up_required = FALSE
    OR member_follow_up_status = 'completed'
  ),
  FOREIGN KEY (conversation_id, member_id, plan_id)
    REFERENCES coaching_conversations(id, member_id, plan_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id, conversation_id, member_id, source_message_sender_type)
    REFERENCES coaching_messages(id, conversation_id, member_id, sender_type) ON DELETE RESTRICT,
  FOREIGN KEY (plan_exercise_id, plan_id)
    REFERENCES coach_plan_exercises(id, plan_id) ON DELETE RESTRICT,
  UNIQUE (id, member_id, conversation_id, plan_id)
);

CREATE INDEX idx_coaching_concerns_open
  ON coaching_concerns (member_id, status, safety_level, created_at DESC);

CREATE TABLE coaching_reviews (
  id BIGSERIAL PRIMARY KEY,
  concern_id BIGINT NOT NULL UNIQUE,
  member_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('routine', 'caution', 'priority', 'urgent')),
  review_category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_review'
    CHECK (status IN ('awaiting_review', 'assigned', 'in_review', 'resolved', 'no_action_needed')),
  assigned_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  assigned_by_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  resolution_note TEXT,
  follow_up_due_at TIMESTAMPTZ,
  member_follow_up_required BOOLEAN NOT NULL DEFAULT FALSE,
  member_follow_up_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (member_follow_up_status IN ('not_required', 'pending', 'completed')),
  member_follow_up_completed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (assigned_staff_user_id IS NULL AND status = 'awaiting_review')
    OR
    (assigned_staff_user_id IS NOT NULL AND status IN ('assigned', 'in_review', 'resolved', 'no_action_needed'))
  ),
  CHECK (
    (status IN ('resolved', 'no_action_needed') AND resolved_at IS NOT NULL)
    OR
    (status NOT IN ('resolved', 'no_action_needed') AND resolved_at IS NULL)
  ),
  CHECK (
    (member_follow_up_required = FALSE
      AND member_follow_up_status = 'not_required'
      AND member_follow_up_completed_at IS NULL)
    OR
    (member_follow_up_required = TRUE
      AND member_follow_up_status = 'pending'
      AND member_follow_up_completed_at IS NULL)
    OR
    (member_follow_up_required = TRUE
      AND member_follow_up_status = 'completed'
      AND member_follow_up_completed_at IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('resolved', 'no_action_needed')
    OR member_follow_up_required = FALSE
    OR member_follow_up_status = 'completed'
  ),
  FOREIGN KEY (concern_id, member_id, conversation_id, plan_id)
    REFERENCES coaching_concerns(id, member_id, conversation_id, plan_id) ON DELETE RESTRICT,
  UNIQUE (id, member_id)
);

CREATE INDEX idx_coaching_reviews_staff_queue
  ON coaching_reviews (assigned_staff_user_id, status, priority, created_at);

CREATE INDEX idx_coaching_reviews_unassigned_queue
  ON coaching_reviews (priority, created_at)
  WHERE assigned_staff_user_id IS NULL AND status = 'awaiting_review';

CREATE TABLE coaching_review_events (
  id BIGSERIAL PRIMARY KEY,
  review_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  actor_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'assigned', 'reassigned', 'review_started',
    'staff_message_added', 'member_follow_up_completed', 'resolved', 'no_action_needed'
  )),
  event_details_json JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(event_details_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (review_id, member_id)
    REFERENCES coaching_reviews(id, member_id) ON DELETE RESTRICT
);

CREATE INDEX idx_coaching_review_events_review
  ON coaching_review_events (review_id, created_at, id);

CREATE TABLE coaching_observations (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES coach_members(id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN (
    'exercise_preference', 'exercise_dislike', 'recurring_discomfort',
    'work_schedule', 'equipment_access', 'accountability_preference',
    'motivation_style', 'lifestyle', 'movement_limitation', 'other'
  )),
  observation_text TEXT NOT NULL CHECK (char_length(btrim(observation_text)) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'active', 'confirmed', 'superseded', 'retired', 'expired')),
  confidence TEXT NOT NULL DEFAULT 'reported'
    CHECK (confidence IN ('reported', 'staff_confirmed')),
  source_type TEXT NOT NULL CHECK (source_type IN ('member_message', 'weekly_checkin', 'staff')),
  source_message_id BIGINT,
  source_conversation_id BIGINT,
  source_message_sender_type TEXT,
  source_weekly_checkin_id BIGINT,
  source_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  supersedes_observation_id BIGINT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (source_type = 'member_message'
      AND source_message_id IS NOT NULL
      AND source_conversation_id IS NOT NULL
      AND source_message_sender_type = 'member'
      AND source_weekly_checkin_id IS NULL
      AND source_staff_user_id IS NULL)
    OR
    (source_type = 'weekly_checkin'
      AND source_message_id IS NULL
      AND source_conversation_id IS NULL
      AND source_message_sender_type IS NULL
      AND source_weekly_checkin_id IS NOT NULL
      AND source_staff_user_id IS NULL)
    OR
    (source_type = 'staff'
      AND source_message_id IS NULL
      AND source_conversation_id IS NOT NULL
      AND source_message_sender_type IS NULL
      AND source_weekly_checkin_id IS NULL
      AND source_staff_user_id IS NOT NULL)
  ),
  FOREIGN KEY (source_message_id, source_conversation_id, member_id, source_message_sender_type)
    REFERENCES coaching_messages(id, conversation_id, member_id, sender_type) ON DELETE RESTRICT,
  FOREIGN KEY (source_conversation_id, member_id)
    REFERENCES coaching_conversations(id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_weekly_checkin_id, member_id)
    REFERENCES weekly_checkins(id, member_id) ON DELETE RESTRICT,
  UNIQUE (id, member_id),
  FOREIGN KEY (supersedes_observation_id, member_id)
    REFERENCES coaching_observations(id, member_id) ON DELETE RESTRICT
);

CREATE INDEX idx_coaching_observations_member
  ON coaching_observations (member_id, status, category, updated_at DESC);

CREATE TABLE coaching_milestones (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES coach_members(id) ON DELETE RESTRICT,
  milestone_type TEXT NOT NULL,
  milestone_text TEXT NOT NULL CHECK (char_length(btrim(milestone_text)) BETWEEN 1 AND 2000),
  achieved_on DATE,
  status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded', 'confirmed', 'superseded', 'withdrawn')),
  source_type TEXT NOT NULL CHECK (source_type IN ('member_message', 'weekly_checkin', 'staff')),
  source_message_id BIGINT,
  source_conversation_id BIGINT,
  source_message_sender_type TEXT,
  source_weekly_checkin_id BIGINT,
  source_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  confirmed_by_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  confirmed_at TIMESTAMPTZ,
  supersedes_milestone_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (source_type = 'member_message'
      AND source_message_id IS NOT NULL
      AND source_conversation_id IS NOT NULL
      AND source_message_sender_type = 'member'
      AND source_weekly_checkin_id IS NULL
      AND source_staff_user_id IS NULL)
    OR
    (source_type = 'weekly_checkin'
      AND source_message_id IS NULL
      AND source_conversation_id IS NULL
      AND source_message_sender_type IS NULL
      AND source_weekly_checkin_id IS NOT NULL
      AND source_staff_user_id IS NULL)
    OR
    (source_type = 'staff'
      AND source_message_id IS NULL
      AND source_conversation_id IS NOT NULL
      AND source_message_sender_type IS NULL
      AND source_weekly_checkin_id IS NULL
      AND source_staff_user_id IS NOT NULL)
  ),
  CHECK (
    (status = 'confirmed' AND confirmed_by_staff_user_id IS NOT NULL AND confirmed_at IS NOT NULL)
    OR
    (status = 'recorded' AND confirmed_by_staff_user_id IS NULL AND confirmed_at IS NULL)
    OR
    (status IN ('superseded', 'withdrawn')
      AND ((confirmed_by_staff_user_id IS NULL AND confirmed_at IS NULL)
        OR (confirmed_by_staff_user_id IS NOT NULL AND confirmed_at IS NOT NULL)))
  ),
  FOREIGN KEY (source_message_id, source_conversation_id, member_id, source_message_sender_type)
    REFERENCES coaching_messages(id, conversation_id, member_id, sender_type) ON DELETE RESTRICT,
  FOREIGN KEY (source_conversation_id, member_id)
    REFERENCES coaching_conversations(id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_weekly_checkin_id, member_id)
    REFERENCES weekly_checkins(id, member_id) ON DELETE RESTRICT,
  UNIQUE (id, member_id),
  FOREIGN KEY (supersedes_milestone_id, member_id)
    REFERENCES coaching_milestones(id, member_id) ON DELETE RESTRICT
);

CREATE INDEX idx_coaching_milestones_member
  ON coaching_milestones (member_id, status, achieved_on DESC, created_at DESC);

CREATE TABLE coaching_plan_change_proposals (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  request_message_id BIGINT NOT NULL,
  request_message_sender_type TEXT NOT NULL DEFAULT 'member'
    CHECK (request_message_sender_type = 'member'),
  source_plan_id BIGINT NOT NULL,
  source_plan_exercise_id BIGINT,
  proposed_change_json JSONB NOT NULL CHECK (jsonb_typeof(proposed_change_json) = 'object'),
  coaching_intent_json JSONB NOT NULL CHECK (jsonb_typeof(coaching_intent_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn')),
  reviewed_by_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'proposed' AND reviewed_by_staff_user_id IS NULL AND reviewed_at IS NULL)
    OR
    (status IN ('approved', 'rejected') AND reviewed_by_staff_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
    OR
    (status = 'withdrawn' AND reviewed_at IS NULL)
  ),
  FOREIGN KEY (conversation_id, member_id, source_plan_id)
    REFERENCES coaching_conversations(id, member_id, plan_id) ON DELETE RESTRICT,
  FOREIGN KEY (request_message_id, conversation_id, member_id, request_message_sender_type)
    REFERENCES coaching_messages(id, conversation_id, member_id, sender_type) ON DELETE RESTRICT,
  FOREIGN KEY (source_plan_exercise_id, source_plan_id)
    REFERENCES coach_plan_exercises(id, plan_id) ON DELETE RESTRICT
);

CREATE INDEX idx_coaching_plan_change_proposals_review
  ON coaching_plan_change_proposals (status, created_at);

CREATE OR REPLACE FUNCTION prevent_assignment_end_with_open_reviews()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'coach assignments are historical records and cannot be deleted'
      USING ERRCODE = '23514',
            CONSTRAINT = 'member_coach_assignments_history_immutable';
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'ended' AND EXISTS (
    SELECT 1
    FROM coaching_reviews review
    WHERE review.member_id = OLD.member_id
      AND review.assigned_staff_user_id = OLD.staff_user_id
      AND review.status IN ('assigned', 'in_review')
  ) THEN
    RAISE EXCEPTION 'open coaching reviews must be reassigned or resolved before ending this assignment'
      USING ERRCODE = '23514',
            CONSTRAINT = 'member_coach_assignments_open_review_guard';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_assignment_end_with_open_reviews
BEFORE UPDATE OF status OR DELETE ON member_coach_assignments
FOR EACH ROW
EXECUTE FUNCTION prevent_assignment_end_with_open_reviews();
