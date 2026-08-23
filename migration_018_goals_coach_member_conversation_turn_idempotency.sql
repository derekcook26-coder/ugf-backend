-- Durable, minimized replay provenance for future authenticated member turns.
-- Existing conversation bindings are intentionally not backfilled.

ALTER TABLE goals_coach_member_conversation_bindings
  ADD CONSTRAINT uq_goals_coach_member_conversation_bindings_exact_identity
  UNIQUE (id, conversation_reference, conversation_version, provenance);

CREATE TABLE goals_coach_member_conversation_turn_idempotency (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key UUID NOT NULL UNIQUE
    CONSTRAINT chk_member_conversation_turn_idempotency_key
    CHECK (idempotency_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  conversation_binding_id BIGINT NOT NULL,
  conversation_reference UUID NOT NULL
    CONSTRAINT chk_member_conversation_turn_idempotency_reference
    CHECK (conversation_reference::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  conversation_version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT chk_member_conversation_turn_idempotency_conversation_version
    CHECK (conversation_version = 1),
  conversation_provenance TEXT NOT NULL DEFAULT 'member_session'
    CONSTRAINT chk_member_conversation_turn_idempotency_conversation_provenance
    CHECK (conversation_provenance = 'member_session'),
  request_signature_sha256 CHAR(64) NOT NULL
    CONSTRAINT chk_member_conversation_turn_idempotency_request_signature
    CHECK (request_signature_sha256 ~ '^[0-9a-f]{64}$'),
  contract_version TEXT NOT NULL DEFAULT 'GC-MEMBER-CONVERSATION-TURN-1'
    CONSTRAINT chk_member_conversation_turn_idempotency_contract_version
    CHECK (contract_version = 'GC-MEMBER-CONVERSATION-TURN-1'),
  safety_rule_version TEXT NOT NULL DEFAULT 'GC-MEMBER-CONVERSATION-SAFETY-1'
    CONSTRAINT chk_member_conversation_turn_idempotency_safety_rule_version
    CHECK (safety_rule_version = 'GC-MEMBER-CONVERSATION-SAFETY-1'),
  safety_source_rule_version TEXT NOT NULL DEFAULT 'GC-MEMBER-CONVERSATION-SAFETY-RULES-1'
    CONSTRAINT chk_member_conversation_turn_idempotency_safety_source_version
    CHECK (safety_source_rule_version = 'GC-MEMBER-CONVERSATION-SAFETY-RULES-1'),
  response_state TEXT NOT NULL,
  response_reason TEXT,
  safety_classification TEXT NOT NULL,
  safety_action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_member_conversation_turn_idempotency_binding
    FOREIGN KEY (
      conversation_binding_id,
      conversation_reference,
      conversation_version,
      conversation_provenance
    ) REFERENCES goals_coach_member_conversation_bindings (
      id,
      conversation_reference,
      conversation_version,
      provenance
    ) ON DELETE RESTRICT,
  CONSTRAINT chk_member_conversation_turn_idempotency_response
    CHECK (
      (
        response_state = 'unavailable'
        AND response_reason = 'provider_unavailable'
        AND safety_classification = 'unavailable'
        AND safety_action = 'unavailable'
      ) OR (
        response_state = 'blocked'
        AND response_reason = 'safety_stop'
        AND safety_classification IN ('pain_or_instability', 'concerning_symptoms')
        AND safety_action = 'stop'
      ) OR (
        response_state = 'safe_to_process'
        AND response_reason IS NULL
        AND safety_classification = 'clear'
        AND safety_action = 'allow_provider_processing'
      )
    )
);

CREATE INDEX idx_member_conversation_turn_idempotency_binding
  ON goals_coach_member_conversation_turn_idempotency(conversation_binding_id);

CREATE FUNCTION prevent_member_conversation_turn_idempotency_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'goals_coach_member_conversation_turn_idempotency rows are immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_member_conversation_turn_idempotency_update
BEFORE UPDATE ON goals_coach_member_conversation_turn_idempotency
FOR EACH ROW EXECUTE FUNCTION prevent_member_conversation_turn_idempotency_mutation();

CREATE TRIGGER prevent_member_conversation_turn_idempotency_delete
BEFORE DELETE ON goals_coach_member_conversation_turn_idempotency
FOR EACH ROW EXECUTE FUNCTION prevent_member_conversation_turn_idempotency_mutation();
