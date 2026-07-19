-- Goals Coach Phase 1C voice-transcription provenance.
-- Additive only: raw audio and transcript text are never persisted.

CREATE TABLE goals_coach_transcription_attempts (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number IN (1, 2)),
  member_id BIGINT NOT NULL,
  auth_mapping_id BIGINT NOT NULL,
  auth_session_digest CHAR(64) NOT NULL
    CHECK (auth_session_digest ~ '^[a-f0-9]{64}$'),
  conversation_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'consumed', 'expired')),
  mime_type TEXT NOT NULL CHECK (mime_type IN (
    'audio/webm;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4'
  )),
  audio_byte_count INTEGER NOT NULL CHECK (audio_byte_count > 0),
  audio_duration_ms INTEGER
    CHECK (audio_duration_ms IS NULL OR audio_duration_ms BETWEEN 1 AND 30000),
  audio_digest CHAR(64) NOT NULL CHECK (audio_digest ~ '^[a-f0-9]{64}$'),
  transcript_digest CHAR(64) CHECK (
    transcript_digest IS NULL OR transcript_digest ~ '^[a-f0-9]{64}$'
  ),
  provider_identifier TEXT CHECK (
    provider_identifier IS NULL
    OR char_length(btrim(provider_identifier)) BETWEEN 1 AND 100
  ),
  model_identifier TEXT CHECK (
    model_identifier IS NULL
    OR char_length(btrim(model_identifier)) BETWEEN 1 AND 200
  ),
  failure_category TEXT CHECK (
    failure_category IS NULL OR failure_category IN (
      'invalid_audio',
      'unintelligible_audio',
      'provider_timeout',
      'provider_unavailable',
      'provider_error'
    )
  ),
  provider_started_at TIMESTAMPTZ,
  provider_completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  consumed_member_message_id BIGINT,
  transcript_edited BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'pending'
      AND audio_duration_ms IS NULL
      AND transcript_digest IS NULL
      AND failure_category IS NULL
      AND provider_completed_at IS NULL
      AND expires_at IS NULL
      AND consumed_at IS NULL
      AND consumed_member_message_id IS NULL
      AND transcript_edited = FALSE)
    OR
    (status = 'completed'
      AND audio_duration_ms IS NOT NULL
      AND transcript_digest IS NOT NULL
      AND provider_identifier IS NOT NULL
      AND model_identifier IS NOT NULL
      AND failure_category IS NULL
      AND provider_started_at IS NOT NULL
      AND provider_completed_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > provider_completed_at
      AND consumed_at IS NULL
      AND consumed_member_message_id IS NULL
      AND transcript_edited = FALSE)
    OR
    (status = 'failed'
      AND audio_duration_ms IS NULL
      AND transcript_digest IS NULL
      AND failure_category IS NOT NULL
      AND provider_identifier IS NOT NULL
      AND model_identifier IS NOT NULL
      AND provider_started_at IS NOT NULL
      AND provider_completed_at IS NOT NULL
      AND expires_at IS NULL
      AND consumed_at IS NULL
      AND consumed_member_message_id IS NULL
      AND transcript_edited = FALSE)
    OR
    (status = 'consumed'
      AND audio_duration_ms IS NOT NULL
      AND transcript_digest IS NOT NULL
      AND provider_identifier IS NOT NULL
      AND model_identifier IS NOT NULL
      AND failure_category IS NULL
      AND provider_started_at IS NOT NULL
      AND provider_completed_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > provider_completed_at
      AND consumed_at IS NOT NULL
      AND consumed_at <= expires_at
      AND consumed_member_message_id IS NOT NULL)
    OR
    (status = 'expired'
      AND audio_duration_ms IS NOT NULL
      AND transcript_digest IS NOT NULL
      AND provider_identifier IS NOT NULL
      AND model_identifier IS NOT NULL
      AND failure_category IS NULL
      AND provider_started_at IS NOT NULL
      AND provider_completed_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > provider_completed_at
      AND consumed_at IS NULL
      AND consumed_member_message_id IS NULL
      AND transcript_edited = FALSE)
  ),
  CHECK (
    provider_started_at IS NULL
    OR provider_started_at >= created_at
  ),
  CHECK (
    provider_completed_at IS NULL
    OR (provider_started_at IS NOT NULL AND provider_completed_at >= provider_started_at)
  ),
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id, member_id, plan_id)
    REFERENCES coaching_conversations(id, member_id, plan_id) ON DELETE RESTRICT,
  FOREIGN KEY (consumed_member_message_id, conversation_id, member_id)
    REFERENCES coaching_messages(id, conversation_id, member_id) ON DELETE RESTRICT,
  UNIQUE (member_id, request_id, attempt_number),
  UNIQUE (consumed_member_message_id),
  UNIQUE (id, member_id, conversation_id, plan_id)
);

CREATE UNIQUE INDEX uq_goals_coach_pending_transcription_per_member
  ON goals_coach_transcription_attempts (member_id)
  WHERE status = 'pending';
CREATE INDEX idx_goals_coach_transcription_request
  ON goals_coach_transcription_attempts
    (request_id, member_id, attempt_number DESC);
CREATE INDEX idx_goals_coach_transcription_member_rate
  ON goals_coach_transcription_attempts
    (member_id, created_at DESC);
CREATE INDEX idx_goals_coach_transcription_expiry
  ON goals_coach_transcription_attempts
    (expires_at, id)
  WHERE status = 'completed';

CREATE OR REPLACE FUNCTION validate_goals_coach_transcription_attempt_insert()
RETURNS TRIGGER AS $$
DECLARE
  prior goals_coach_transcription_attempts%ROWTYPE;
BEGIN
  IF NEW.attempt_number = 2 THEN
    SELECT * INTO prior
    FROM goals_coach_transcription_attempts
    WHERE member_id = NEW.member_id
      AND request_id = NEW.request_id
      AND attempt_number = 1
    FOR SHARE;

    IF NOT FOUND
      OR prior.status <> 'failed'
      OR prior.auth_mapping_id <> NEW.auth_mapping_id
      OR prior.auth_session_digest <> NEW.auth_session_digest
      OR prior.conversation_id <> NEW.conversation_id
      OR prior.plan_id <> NEW.plan_id
      OR prior.audio_digest <> NEW.audio_digest
      OR prior.mime_type <> NEW.mime_type
    THEN
      RAISE EXCEPTION 'second transcription attempt requires one matching failed first attempt'
        USING ERRCODE = '23514',
          CONSTRAINT = 'goals_coach_transcription_attempt_two_requires_failed_first';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_goals_coach_transcription_attempt_insert
BEFORE INSERT ON goals_coach_transcription_attempts
FOR EACH ROW EXECUTE FUNCTION validate_goals_coach_transcription_attempt_insert();

CREATE OR REPLACE FUNCTION preserve_goals_coach_transcription_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transcription-attempt provenance cannot be deleted'
      USING ERRCODE = '23514',
        CONSTRAINT = 'goals_coach_transcription_attempt_delete_prohibited';
  END IF;

  IF OLD.id <> NEW.id
    OR OLD.request_id <> NEW.request_id
    OR OLD.attempt_number <> NEW.attempt_number
    OR OLD.member_id <> NEW.member_id
    OR OLD.auth_mapping_id <> NEW.auth_mapping_id
    OR OLD.auth_session_digest <> NEW.auth_session_digest
    OR OLD.conversation_id <> NEW.conversation_id
    OR OLD.plan_id <> NEW.plan_id
    OR OLD.mime_type <> NEW.mime_type
    OR OLD.audio_byte_count <> NEW.audio_byte_count
    OR OLD.audio_digest <> NEW.audio_digest
    OR OLD.created_at <> NEW.created_at
  THEN
    RAISE EXCEPTION 'transcription-attempt identity and audio provenance are immutable'
      USING ERRCODE = '23514',
        CONSTRAINT = 'goals_coach_transcription_attempt_identity_immutable';
  END IF;

  IF OLD.status <> NEW.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('completed', 'failed'))
    OR (OLD.status = 'completed' AND NEW.status IN ('consumed', 'expired'))
  ) THEN
    RAISE EXCEPTION 'invalid transcription-attempt lifecycle transition'
      USING ERRCODE = '23514',
        CONSTRAINT = 'goals_coach_transcription_attempt_lifecycle';
  END IF;

  IF OLD.status IN ('failed', 'consumed', 'expired')
    OR (OLD.status = 'completed' AND NEW.status = 'completed')
  THEN
    RAISE EXCEPTION 'terminal transcription-attempt provenance is immutable'
      USING ERRCODE = '23514',
        CONSTRAINT = 'goals_coach_transcription_attempt_terminal_immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_goals_coach_transcription_lifecycle
BEFORE UPDATE OR DELETE ON goals_coach_transcription_attempts
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_transcription_lifecycle();

ALTER TABLE goals_coach_coaching_turns
  ADD COLUMN transcription_attempt_id UUID;

ALTER TABLE goals_coach_coaching_turns
  ADD CONSTRAINT fk_goals_coach_turn_transcription_attempt
  FOREIGN KEY (transcription_attempt_id, member_id, conversation_id, plan_id)
  REFERENCES goals_coach_transcription_attempts
    (id, member_id, conversation_id, plan_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX uq_goals_coach_turn_transcription_attempt
  ON goals_coach_coaching_turns (transcription_attempt_id)
  WHERE transcription_attempt_id IS NOT NULL;
