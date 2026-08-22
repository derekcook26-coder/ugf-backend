-- Append-only ownership provenance for future authenticated member conversations.
-- Existing conversations are intentionally not backfilled.

ALTER TABLE goals_coach_member_sessions
  ADD CONSTRAINT uq_goals_coach_member_sessions_id_member_mapping
  UNIQUE (id, member_id, auth_mapping_id);

CREATE TABLE goals_coach_member_conversation_bindings (
  id BIGSERIAL PRIMARY KEY,
  conversation_reference UUID NOT NULL UNIQUE,
  conversation_version INTEGER NOT NULL DEFAULT 1
    CHECK (conversation_version = 1),
  provenance TEXT NOT NULL DEFAULT 'member_session'
    CHECK (provenance = 'member_session'),
  coaching_conversation_id BIGINT NOT NULL UNIQUE,
  member_id BIGINT NOT NULL,
  auth_mapping_id BIGINT NOT NULL,
  member_session_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (coaching_conversation_id, member_id)
    REFERENCES coaching_conversations(id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (member_session_id, member_id, auth_mapping_id)
    REFERENCES goals_coach_member_sessions(id, member_id, auth_mapping_id) ON DELETE RESTRICT
);

CREATE INDEX idx_goals_coach_member_conversation_bindings_owner
  ON goals_coach_member_conversation_bindings(member_id, auth_mapping_id, member_session_id);

CREATE FUNCTION prevent_goals_coach_member_conversation_binding_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'goals_coach_member_conversation_bindings rows are immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_goals_coach_member_conversation_binding_update
BEFORE UPDATE ON goals_coach_member_conversation_bindings
FOR EACH ROW EXECUTE FUNCTION prevent_goals_coach_member_conversation_binding_mutation();

CREATE TRIGGER prevent_goals_coach_member_conversation_binding_delete
BEFORE DELETE ON goals_coach_member_conversation_bindings
FOR EACH ROW EXECUTE FUNCTION prevent_goals_coach_member_conversation_binding_mutation();
