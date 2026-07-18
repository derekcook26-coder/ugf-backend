-- Goals Coach 2.0 Phase 1B workout state and coaching-turn provenance.
-- Additive only: no existing row is rewritten or deleted.

CREATE TABLE goals_coach_workout_sessions (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  workout_session_key TEXT NOT NULL CHECK (char_length(btrim(workout_session_key)) BETWEEN 1 AND 200),
  workout_day_key TEXT NOT NULL CHECK (char_length(btrim(workout_day_key)) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned', 'superseded')),
  current_plan_exercise_id BIGINT,
  current_exercise_index INTEGER NOT NULL DEFAULT 0 CHECK (current_exercise_index >= 0),
  current_exercise_key TEXT,
  current_exercise_name TEXT,
  current_set INTEGER NOT NULL DEFAULT 0 CHECK (current_set >= 0),
  target_sets INTEGER CHECK (target_sets IS NULL OR target_sets > 0),
  target_repetitions TEXT,
  target_duration_seconds INTEGER CHECK (target_duration_seconds IS NULL OR target_duration_seconds > 0),
  selected_modification_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(selected_modification_json) = 'object'),
  completed_exercises_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(completed_exercises_json) = 'array'),
  skipped_exercises_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skipped_exercises_json) = 'array'),
  reported_effort TEXT,
  reported_discomfort_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reported_discomfort_json) = 'object'),
  state_version BIGINT NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'completed' AND completed_at IS NOT NULL) OR (status <> 'completed' AND completed_at IS NULL)),
  CHECK (
    (current_plan_exercise_id IS NULL AND current_exercise_key IS NULL AND current_exercise_name IS NULL)
    OR
    (current_plan_exercise_id IS NOT NULL
      AND current_exercise_key IS NOT NULL
      AND char_length(btrim(current_exercise_key)) BETWEEN 1 AND 200
      AND current_exercise_name IS NOT NULL
      AND char_length(btrim(current_exercise_name)) BETWEEN 1 AND 300)
  ),
  FOREIGN KEY (conversation_id, member_id, plan_id)
    REFERENCES coaching_conversations(id, member_id, plan_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_plan_exercise_id, plan_id)
    REFERENCES coach_plan_exercises(id, plan_id) ON DELETE RESTRICT,
  UNIQUE (member_id, plan_id, workout_session_key),
  UNIQUE (id, member_id, conversation_id, plan_id)
);

CREATE UNIQUE INDEX uq_goals_coach_active_workout_per_conversation
  ON goals_coach_workout_sessions (conversation_id) WHERE status = 'active';
CREATE INDEX idx_goals_coach_workout_sessions_member
  ON goals_coach_workout_sessions (member_id, status, last_activity_at DESC, id DESC);

CREATE TABLE goals_coach_workout_state_events (
  id BIGSERIAL PRIMARY KEY,
  workout_session_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'session_started', 'step_advanced', 'session_modified',
    'session_completed', 'session_abandoned', 'session_superseded'
  )),
  previous_state_version BIGINT CHECK (previous_state_version IS NULL OR previous_state_version >= 1),
  resulting_state_version BIGINT NOT NULL CHECK (resulting_state_version >= 1),
  triggering_message_id BIGINT,
  triggering_message_sender_type TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('member', 'goals_coach', 'staff', 'system', 'provider')),
  idempotency_key UUID NOT NULL,
  previous_state_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(previous_state_json) = 'object'),
  resulting_state_json JSONB NOT NULL CHECK (jsonb_typeof(resulting_state_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (triggering_message_id IS NULL AND triggering_message_sender_type IS NULL)
    OR (triggering_message_id IS NOT NULL AND triggering_message_sender_type = 'member')
  ),
  FOREIGN KEY (workout_session_id, member_id, conversation_id, plan_id)
    REFERENCES goals_coach_workout_sessions(id, member_id, conversation_id, plan_id) ON DELETE RESTRICT,
  FOREIGN KEY (triggering_message_id, conversation_id, member_id, triggering_message_sender_type)
    REFERENCES coaching_messages(id, conversation_id, member_id, sender_type) ON DELETE RESTRICT,
  UNIQUE (workout_session_id, resulting_state_version),
  UNIQUE (workout_session_id, idempotency_key)
);
CREATE INDEX idx_goals_coach_workout_state_events_session
  ON goals_coach_workout_state_events (workout_session_id, created_at, id);

CREATE OR REPLACE FUNCTION preserve_goals_coach_workout_state_events()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'workout state events are append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'goals_coach_workout_state_events_append_only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_preserve_goals_coach_workout_state_events
BEFORE UPDATE OR DELETE ON goals_coach_workout_state_events
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_workout_state_events();

CREATE TABLE goals_coach_coaching_turns (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  workout_session_id BIGINT,
  member_message_id BIGINT NOT NULL,
  member_message_sender_type TEXT NOT NULL DEFAULT 'member' CHECK (member_message_sender_type = 'member'),
  coach_message_id BIGINT,
  coach_message_sender_type TEXT CHECK (coach_message_sender_type IS NULL OR coach_message_sender_type = 'goals_coach'),
  provider_identifier TEXT NOT NULL CHECK (char_length(btrim(provider_identifier)) BETWEEN 1 AND 100),
  model_identifier TEXT NOT NULL CHECK (char_length(btrim(model_identifier)) BETWEEN 1 AND 200),
  prompt_version TEXT NOT NULL CHECK (char_length(btrim(prompt_version)) BETWEEN 1 AND 100),
  structured_output_version TEXT NOT NULL CHECK (char_length(btrim(structured_output_version)) BETWEEN 1 AND 100),
  safety_rule_version TEXT NOT NULL CHECK (char_length(btrim(safety_rule_version)) BETWEEN 1 AND 100),
  request_id UUID NOT NULL UNIQUE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  provider_status TEXT NOT NULL DEFAULT 'pending' CHECK (provider_status IN ('pending', 'completed', 'failed')),
  failure_category TEXT,
  input_method TEXT NOT NULL DEFAULT 'text' CHECK (input_method IN ('text', 'voice')),
  context_digest TEXT NOT NULL CHECK (context_digest ~ '^[a-f0-9]{64}$'),
  structured_output_json JSONB,
  proposed_state_transition_json JSONB,
  provider_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (provider_status = 'pending' AND coach_message_id IS NULL AND coach_message_sender_type IS NULL
      AND provider_completed_at IS NULL AND failure_category IS NULL AND structured_output_json IS NULL)
    OR
    (provider_status = 'completed' AND coach_message_id IS NOT NULL AND coach_message_sender_type = 'goals_coach'
      AND provider_completed_at IS NOT NULL AND failure_category IS NULL
      AND structured_output_json IS NOT NULL AND jsonb_typeof(structured_output_json) = 'object')
    OR
    (provider_status = 'failed' AND coach_message_id IS NULL AND coach_message_sender_type IS NULL
      AND provider_completed_at IS NOT NULL AND failure_category IS NOT NULL
      AND char_length(btrim(failure_category)) BETWEEN 1 AND 100 AND structured_output_json IS NULL)
  ),
  CHECK (proposed_state_transition_json IS NULL OR jsonb_typeof(proposed_state_transition_json) = 'object'),
  FOREIGN KEY (conversation_id, member_id, plan_id)
    REFERENCES coaching_conversations(id, member_id, plan_id) ON DELETE RESTRICT,
  FOREIGN KEY (workout_session_id, member_id, conversation_id, plan_id)
    REFERENCES goals_coach_workout_sessions(id, member_id, conversation_id, plan_id) ON DELETE RESTRICT,
  FOREIGN KEY (member_message_id, conversation_id, member_id, member_message_sender_type)
    REFERENCES coaching_messages(id, conversation_id, member_id, sender_type) ON DELETE RESTRICT,
  FOREIGN KEY (coach_message_id, conversation_id, member_id, coach_message_sender_type)
    REFERENCES coaching_messages(id, conversation_id, member_id, sender_type) ON DELETE RESTRICT,
  UNIQUE (member_message_id, attempt_number),
  UNIQUE (coach_message_id)
);
CREATE INDEX idx_goals_coach_coaching_turns_member_message
  ON goals_coach_coaching_turns (member_message_id, attempt_number DESC);
CREATE UNIQUE INDEX uq_goals_coach_pending_turn_per_conversation
  ON goals_coach_coaching_turns (conversation_id) WHERE provider_status = 'pending';
CREATE INDEX idx_goals_coach_coaching_turns_failures
  ON goals_coach_coaching_turns (provider_status, created_at DESC) WHERE provider_status <> 'completed';

CREATE OR REPLACE FUNCTION preserve_completed_goals_coach_turns()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.provider_status IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'completed coaching-turn provenance is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'goals_coach_coaching_turns_final_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_preserve_completed_goals_coach_turns
BEFORE UPDATE OR DELETE ON goals_coach_coaching_turns
FOR EACH ROW EXECUTE FUNCTION preserve_completed_goals_coach_turns();
