-- Goals Coach 2.0 Phase 1A private-alpha foundation.
-- Additive only: no existing row is rewritten or deleted.

CREATE TABLE goals_coach_member_auth_mappings (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES coach_members(id) ON DELETE RESTRICT,
  auth_provider TEXT NOT NULL
    CHECK (auth_provider ~ '^[a-z][a-z0-9_-]{1,39}$'),
  auth_subject TEXT NOT NULL
    CHECK (char_length(btrim(auth_subject)) BETWEEN 6 AND 200),
  verified_email_snapshot TEXT NOT NULL
    CHECK (
      char_length(btrim(verified_email_snapshot)) BETWEEN 3 AND 320
      AND position('@' IN verified_email_snapshot) > 1
    ),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  provisioning_method TEXT NOT NULL
    CHECK (provisioning_method IN ('owner_approved_script', 'administrative')),
  provisioning_reference TEXT NOT NULL
    CHECK (char_length(btrim(provisioning_reference)) BETWEEN 1 AND 200),
  provisioned_by_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  deactivated_by_staff_user_id BIGINT REFERENCES staff_users(id) ON DELETE RESTRICT,
  deactivation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deactivated_at TIMESTAMPTZ,
  CHECK (auth_provider <> 'clerk' OR auth_subject ~ '^user_[A-Za-z0-9_-]+$'),
  CHECK (
    (active = TRUE
      AND deactivated_at IS NULL
      AND deactivated_by_staff_user_id IS NULL
      AND deactivation_reason IS NULL)
    OR
    (active = FALSE
      AND (
        (deactivated_at IS NULL
          AND deactivated_by_staff_user_id IS NULL
          AND deactivation_reason IS NULL)
        OR
        (deactivated_at IS NOT NULL
          AND deactivation_reason IS NOT NULL
          AND char_length(btrim(deactivation_reason)) BETWEEN 1 AND 500)
      ))
  ),
  UNIQUE (auth_provider, auth_subject),
  UNIQUE (id, member_id),
  UNIQUE (id, member_id, auth_provider, auth_subject)
);

CREATE UNIQUE INDEX uq_goals_coach_member_active_auth_provider
  ON goals_coach_member_auth_mappings (member_id, auth_provider)
  WHERE active = TRUE;

CREATE INDEX idx_goals_coach_member_auth_member
  ON goals_coach_member_auth_mappings (member_id, active);

CREATE TABLE goals_coach_alpha_consents (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL,
  auth_mapping_id BIGINT NOT NULL,
  consent_version TEXT NOT NULL
    CHECK (char_length(btrim(consent_version)) BETWEEN 1 AND 100),
  environment TEXT NOT NULL
    CHECK (environment IN ('test', 'development', 'staging', 'private_alpha')),
  status TEXT NOT NULL
    CHECK (status IN ('accepted', 'declined', 'withdrawn')),
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'accepted'
      AND accepted_at IS NOT NULL
      AND declined_at IS NULL
      AND withdrawn_at IS NULL)
    OR
    (status = 'declined'
      AND accepted_at IS NULL
      AND declined_at IS NOT NULL
      AND withdrawn_at IS NULL)
    OR
    (status = 'withdrawn'
      AND accepted_at IS NOT NULL
      AND declined_at IS NULL
      AND withdrawn_at IS NOT NULL)
  ),
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  UNIQUE (member_id, consent_version, environment),
  UNIQUE (id, member_id, auth_mapping_id)
);

CREATE INDEX idx_goals_coach_alpha_consents_current
  ON goals_coach_alpha_consents (member_id, environment, consent_version, status);

CREATE TABLE goals_coach_alpha_consent_events (
  id BIGSERIAL PRIMARY KEY,
  consent_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  auth_mapping_id BIGINT NOT NULL,
  auth_provider TEXT NOT NULL,
  auth_subject TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  environment TEXT NOT NULL
    CHECK (environment IN ('test', 'development', 'staging', 'private_alpha')),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('accepted', 'declined', 'withdrawn')),
  request_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (consent_id, member_id, auth_mapping_id)
    REFERENCES goals_coach_alpha_consents(id, member_id, auth_mapping_id) ON DELETE RESTRICT,
  FOREIGN KEY (auth_mapping_id, member_id, auth_provider, auth_subject)
    REFERENCES goals_coach_member_auth_mappings(id, member_id, auth_provider, auth_subject)
    ON DELETE RESTRICT
);

CREATE INDEX idx_goals_coach_alpha_consent_events_member
  ON goals_coach_alpha_consent_events (member_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION preserve_goals_coach_alpha_consent_events()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'alpha consent events are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'goals_coach_alpha_consent_events_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_goals_coach_alpha_consent_events
BEFORE UPDATE OR DELETE ON goals_coach_alpha_consent_events
FOR EACH ROW
EXECUTE FUNCTION preserve_goals_coach_alpha_consent_events();

CREATE TABLE goals_coach_member_preferences (
  member_id BIGINT PRIMARY KEY REFERENCES coach_members(id) ON DELETE RESTRICT,
  updated_by_auth_mapping_id BIGINT NOT NULL,
  voice_input_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  spoken_responses_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  automatic_playback BOOLEAN NOT NULL DEFAULT FALSE,
  transcript_review_required BOOLEAN NOT NULL DEFAULT TRUE,
  reduced_motion BOOLEAN NOT NULL DEFAULT FALSE,
  larger_text BOOLEAN NOT NULL DEFAULT FALSE,
  notification_frequency TEXT NOT NULL DEFAULT 'off'
    CHECK (notification_frequency IN ('off', 'daily', 'weekly')),
  quiet_hours_start TIME,
  quiet_hours_end TIME,
  quiet_hours_timezone TEXT,
  private_notification_previews BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (transcript_review_required = TRUE),
  CHECK (
    (quiet_hours_start IS NULL
      AND quiet_hours_end IS NULL
      AND quiet_hours_timezone IS NULL)
    OR
    (quiet_hours_start IS NOT NULL
      AND quiet_hours_end IS NOT NULL
      AND quiet_hours_timezone IS NOT NULL
      AND char_length(btrim(quiet_hours_timezone)) BETWEEN 1 AND 100)
  ),
  FOREIGN KEY (updated_by_auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT
);

CREATE TABLE goals_coach_alpha_feedback (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES coach_members(id) ON DELETE RESTRICT,
  auth_mapping_id BIGINT NOT NULL,
  conversation_id BIGINT,
  expectation TEXT NOT NULL CHECK (char_length(btrim(expectation)) BETWEEN 1 AND 2000),
  what_occurred TEXT NOT NULL CHECK (char_length(btrim(what_occurred)) BETWEEN 1 AND 4000),
  page_or_feature TEXT NOT NULL CHECK (char_length(btrim(page_or_feature)) BETWEEN 1 AND 200),
  approximate_time TIMESTAMPTZ,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'blocking')),
  comments TEXT CHECK (comments IS NULL OR char_length(btrim(comments)) BETWEEN 1 AND 4000),
  app_version TEXT CHECK (app_version IS NULL OR char_length(btrim(app_version)) BETWEEN 1 AND 100),
  browser TEXT CHECK (browser IS NULL OR char_length(btrim(browser)) BETWEEN 1 AND 200),
  device_type TEXT CHECK (device_type IS NULL OR char_length(btrim(device_type)) BETWEEN 1 AND 200),
  event_id UUID,
  environment TEXT NOT NULL
    CHECK (environment IN ('test', 'development', 'staging', 'private_alpha')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id, member_id)
    REFERENCES coaching_conversations(id, member_id) ON DELETE RESTRICT
);

CREATE INDEX idx_goals_coach_alpha_feedback_member
  ON goals_coach_alpha_feedback (member_id, created_at DESC, id DESC);
