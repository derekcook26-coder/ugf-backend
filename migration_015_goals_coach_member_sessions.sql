-- Opaque, server-side Goals Coach member sessions. Raw bearer tokens are never stored.
CREATE TABLE goals_coach_member_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  auth_mapping_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_validated_at TIMESTAMPTZ,
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  CHECK (expires_at = issued_at + INTERVAL '7200 seconds'),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (last_validated_at IS NULL OR last_validated_at >= issued_at)
);
CREATE INDEX idx_goals_coach_member_sessions_mapping
  ON goals_coach_member_sessions(auth_mapping_id, member_id, expires_at);
