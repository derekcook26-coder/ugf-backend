-- Durable at-most-once provider-dispatch provenance for future authenticated member turns.
-- Existing idempotency rows and conversation bindings are intentionally not backfilled.

CREATE TABLE goals_coach_member_conversation_turn_reservations (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key UUID NOT NULL UNIQUE
    CONSTRAINT chk_member_conversation_turn_reservation_key
    CHECK (idempotency_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  conversation_binding_id BIGINT NOT NULL,
  conversation_reference UUID NOT NULL,
  conversation_version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT chk_member_conversation_turn_reservation_conversation_version
    CHECK (conversation_version = 1),
  conversation_provenance TEXT NOT NULL DEFAULT 'member_session'
    CONSTRAINT chk_member_conversation_turn_reservation_provenance
    CHECK (conversation_provenance = 'member_session'),
  request_signature_sha256 CHAR(64) NOT NULL
    CONSTRAINT chk_member_conversation_turn_reservation_request_signature
    CHECK (request_signature_sha256 ~ '^[0-9a-f]{64}$'),
  contract_version TEXT NOT NULL DEFAULT 'GC-MEMBER-CONVERSATION-TURN-1'
    CONSTRAINT chk_member_conversation_turn_reservation_contract_version
    CHECK (contract_version = 'GC-MEMBER-CONVERSATION-TURN-1'),
  safety_rule_version TEXT NOT NULL DEFAULT 'GC-MEMBER-CONVERSATION-SAFETY-1'
    CONSTRAINT chk_member_conversation_turn_reservation_safety_rule_version
    CHECK (safety_rule_version = 'GC-MEMBER-CONVERSATION-SAFETY-1'),
  safety_source_rule_version TEXT NOT NULL DEFAULT 'GC-MEMBER-CONVERSATION-SAFETY-RULES-1'
    CONSTRAINT chk_member_conversation_turn_reservation_safety_source_version
    CHECK (safety_source_rule_version = 'GC-MEMBER-CONVERSATION-SAFETY-RULES-1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_member_conversation_turn_reservation_exact_identity
    UNIQUE (
      id,
      idempotency_key,
      conversation_binding_id,
      conversation_reference,
      conversation_version,
      conversation_provenance,
      request_signature_sha256
    ),
  CONSTRAINT fk_member_conversation_turn_reservation_binding
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
    ) ON DELETE RESTRICT
);

CREATE TABLE goals_coach_member_conversation_turn_dispatch_events (
  id BIGSERIAL PRIMARY KEY,
  reservation_id BIGINT NOT NULL,
  event_sequence BIGINT NOT NULL,
  event_type TEXT NOT NULL
    CONSTRAINT chk_member_conversation_turn_dispatch_event_type
    CHECK (event_type IN (
      'reserved',
      'lease_acquired',
      'dispatch_started',
      'provider_succeeded',
      'provider_rejected',
      'indeterminate',
      'finalized'
    )),
  attempt_id UUID,
  lease_expires_at TIMESTAMPTZ,
  reconciliation_not_before TIMESTAMPTZ,
  provider_contract_version TEXT,
  client_request_id UUID,
  provider_request_id VARCHAR(255),
  provider_response_id VARCHAR(255),
  response_digest_sha256 CHAR(64),
  terminal_category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_member_conversation_turn_dispatch_reservation
    FOREIGN KEY (reservation_id)
    REFERENCES goals_coach_member_conversation_turn_reservations(id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_member_conversation_turn_dispatch_event
    UNIQUE (reservation_id, event_sequence),
  CONSTRAINT chk_member_conversation_turn_dispatch_event_shape
    CHECK (
      (
        event_type = 'reserved'
        AND attempt_id IS NULL
        AND lease_expires_at IS NULL
        AND reconciliation_not_before IS NULL
        AND provider_contract_version IS NULL
        AND client_request_id IS NULL
        AND provider_request_id IS NULL
        AND provider_response_id IS NULL
        AND response_digest_sha256 IS NULL
        AND terminal_category IS NULL
      ) OR (
        event_type = 'lease_acquired'
        AND attempt_id IS NOT NULL
        AND attempt_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND lease_expires_at > created_at
        AND lease_expires_at <= created_at + INTERVAL '60 seconds'
        AND reconciliation_not_before IS NULL
        AND provider_contract_version IS NULL
        AND client_request_id IS NULL
        AND provider_request_id IS NULL
        AND provider_response_id IS NULL
        AND response_digest_sha256 IS NULL
        AND terminal_category IS NULL
      ) OR (
        event_type = 'dispatch_started'
        AND attempt_id IS NOT NULL
        AND lease_expires_at IS NULL
        AND reconciliation_not_before > created_at
        AND reconciliation_not_before <= created_at + INTERVAL '5 minutes'
        AND provider_contract_version = 'GC-MEMBER-CONVERSATION-PROVIDER-1'
        AND client_request_id = attempt_id
        AND provider_request_id IS NULL
        AND provider_response_id IS NULL
        AND response_digest_sha256 IS NULL
        AND terminal_category IS NULL
      ) OR (
        event_type = 'provider_succeeded'
        AND attempt_id IS NOT NULL
        AND lease_expires_at IS NULL
        AND reconciliation_not_before IS NULL
        AND provider_contract_version = 'GC-MEMBER-CONVERSATION-PROVIDER-1'
        AND client_request_id = attempt_id
        AND provider_request_id IS NOT NULL
        AND length(provider_request_id) BETWEEN 1 AND 255
        AND provider_response_id IS NOT NULL
        AND length(provider_response_id) BETWEEN 1 AND 255
        AND response_digest_sha256 ~ '^[0-9a-f]{64}$'
        AND terminal_category = 'success'
      ) OR (
        event_type = 'provider_rejected'
        AND attempt_id IS NOT NULL
        AND lease_expires_at IS NULL
        AND reconciliation_not_before IS NULL
        AND provider_contract_version = 'GC-MEMBER-CONVERSATION-PROVIDER-1'
        AND client_request_id = attempt_id
        AND provider_request_id IS NOT NULL
        AND length(provider_request_id) BETWEEN 1 AND 255
        AND provider_response_id IS NULL
        AND response_digest_sha256 IS NULL
        AND terminal_category IN ('authentication_rejected', 'request_rejected', 'rate_limited')
      ) OR (
        event_type = 'indeterminate'
        AND attempt_id IS NOT NULL
        AND lease_expires_at IS NULL
        AND reconciliation_not_before IS NULL
        AND provider_contract_version = 'GC-MEMBER-CONVERSATION-PROVIDER-1'
        AND client_request_id = attempt_id
        AND provider_request_id IS NULL
        AND provider_response_id IS NULL
        AND response_digest_sha256 IS NULL
        AND terminal_category = 'provider_contact_indeterminate'
      ) OR (
        event_type = 'finalized'
        AND attempt_id IS NULL
        AND lease_expires_at IS NULL
        AND reconciliation_not_before IS NULL
        AND provider_contract_version IS NULL
        AND client_request_id IS NULL
        AND provider_request_id IS NULL
        AND provider_response_id IS NULL
        AND response_digest_sha256 IS NULL
        AND terminal_category IS NULL
      )
    )
);

CREATE INDEX idx_member_conversation_turn_dispatch_events_reservation
  ON goals_coach_member_conversation_turn_dispatch_events(reservation_id, event_sequence);

CREATE FUNCTION enforce_member_conversation_turn_dispatch_transition()
RETURNS TRIGGER AS $$
DECLARE
  prior goals_coach_member_conversation_turn_dispatch_events%ROWTYPE;
  reservation goals_coach_member_conversation_turn_reservations%ROWTYPE;
  final_row goals_coach_member_conversation_turn_idempotency%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('goals_coach_member_conversation_turn_dispatch:' || NEW.reservation_id::text, 0)
  );
  NEW.created_at := clock_timestamp();

  SELECT * INTO reservation
  FROM goals_coach_member_conversation_turn_reservations
  WHERE id = NEW.reservation_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown member conversation turn reservation' USING ERRCODE = '23503';
  END IF;

  SELECT * INTO prior
  FROM goals_coach_member_conversation_turn_dispatch_events
  WHERE reservation_id = NEW.reservation_id
  ORDER BY event_sequence DESC
  LIMIT 1;

  NEW.event_sequence := COALESCE(prior.event_sequence, 0) + 1;

  IF NOT FOUND THEN
    IF NEW.event_type <> 'reserved' THEN
      RAISE EXCEPTION 'first dispatch event must be reserved' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF prior.event_type IN ('provider_rejected', 'indeterminate', 'finalized') THEN
    RAISE EXCEPTION 'terminal dispatch event cannot transition' USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type = 'lease_acquired' THEN
    IF prior.event_type NOT IN ('reserved', 'lease_acquired')
      OR (prior.event_type = 'lease_acquired' AND prior.lease_expires_at > NEW.created_at) THEN
      RAISE EXCEPTION 'dispatch lease is unavailable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_type = 'dispatch_started' THEN
    IF prior.event_type <> 'lease_acquired'
      OR prior.attempt_id <> NEW.attempt_id
      OR prior.lease_expires_at <= NEW.created_at THEN
      RAISE EXCEPTION 'dispatch attempt does not own an active lease' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_type IN ('provider_succeeded', 'provider_rejected') THEN
    IF prior.event_type <> 'dispatch_started' OR prior.attempt_id <> NEW.attempt_id THEN
      RAISE EXCEPTION 'provider result does not match dispatch authority' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_type = 'indeterminate' THEN
    IF prior.event_type <> 'dispatch_started'
      OR prior.attempt_id <> NEW.attempt_id
      OR prior.reconciliation_not_before > NEW.created_at THEN
      RAISE EXCEPTION 'dispatch is not eligible for indeterminate transition' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_type = 'finalized' THEN
    SELECT * INTO final_row
    FROM goals_coach_member_conversation_turn_idempotency
    WHERE idempotency_key = reservation.idempotency_key
      AND conversation_binding_id = reservation.conversation_binding_id
      AND conversation_reference = reservation.conversation_reference
      AND conversation_version = reservation.conversation_version
      AND conversation_provenance = reservation.conversation_provenance
      AND request_signature_sha256 = reservation.request_signature_sha256
      AND contract_version = reservation.contract_version
      AND safety_rule_version = reservation.safety_rule_version
      AND safety_source_rule_version = reservation.safety_source_rule_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'final replay row is unavailable' USING ERRCODE = '23514';
    END IF;
    IF prior.event_type = 'reserved' THEN
      IF final_row.response_state NOT IN ('blocked', 'unavailable') THEN
        RAISE EXCEPTION 'pre-provider final state is invalid' USING ERRCODE = '23514';
      END IF;
    ELSIF prior.event_type = 'provider_succeeded' THEN
      IF final_row.response_state <> 'safe_to_process' THEN
        RAISE EXCEPTION 'provider final state is invalid' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'dispatch cannot finalize from current state' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid dispatch transition' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_member_conversation_turn_dispatch_event_insert
BEFORE INSERT ON goals_coach_member_conversation_turn_dispatch_events
FOR EACH ROW EXECUTE FUNCTION enforce_member_conversation_turn_dispatch_transition();

CREATE FUNCTION enforce_member_conversation_turn_final_replay_transition()
RETURNS TRIGGER AS $$
DECLARE
  reservation goals_coach_member_conversation_turn_reservations%ROWTYPE;
  prior goals_coach_member_conversation_turn_dispatch_events%ROWTYPE;
BEGIN
  SELECT * INTO reservation
  FROM goals_coach_member_conversation_turn_reservations
  WHERE idempotency_key = NEW.idempotency_key
    AND conversation_binding_id = NEW.conversation_binding_id
    AND conversation_reference = NEW.conversation_reference
    AND conversation_version = NEW.conversation_version
    AND conversation_provenance = NEW.conversation_provenance
    AND request_signature_sha256 = NEW.request_signature_sha256
    AND contract_version = NEW.contract_version
    AND safety_rule_version = NEW.safety_rule_version
    AND safety_source_rule_version = NEW.safety_source_rule_version
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact provider-dispatch reservation is unavailable' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('goals_coach_member_conversation_turn_dispatch:' || reservation.id::text, 0)
  );
  SELECT * INTO prior
  FROM goals_coach_member_conversation_turn_dispatch_events
  WHERE reservation_id = reservation.id
  ORDER BY event_sequence DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider-dispatch reservation has no event state' USING ERRCODE = '23514';
  END IF;

  IF prior.event_type = 'reserved' AND NEW.response_state IN ('blocked', 'unavailable') THEN
    RETURN NEW;
  END IF;
  IF prior.event_type = 'provider_succeeded' AND NEW.response_state = 'safe_to_process' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'final replay is not authorized by provider-dispatch state' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_member_conversation_turn_final_replay_insert
BEFORE INSERT ON goals_coach_member_conversation_turn_idempotency
FOR EACH ROW EXECUTE FUNCTION enforce_member_conversation_turn_final_replay_transition();

CREATE FUNCTION prevent_member_conversation_turn_provider_dispatch_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'member conversation provider-dispatch rows are immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_member_conversation_turn_reservation_update
BEFORE UPDATE ON goals_coach_member_conversation_turn_reservations
FOR EACH ROW EXECUTE FUNCTION prevent_member_conversation_turn_provider_dispatch_mutation();

CREATE TRIGGER prevent_member_conversation_turn_reservation_delete
BEFORE DELETE ON goals_coach_member_conversation_turn_reservations
FOR EACH ROW EXECUTE FUNCTION prevent_member_conversation_turn_provider_dispatch_mutation();

CREATE TRIGGER prevent_member_conversation_turn_dispatch_event_update
BEFORE UPDATE ON goals_coach_member_conversation_turn_dispatch_events
FOR EACH ROW EXECUTE FUNCTION prevent_member_conversation_turn_provider_dispatch_mutation();

CREATE TRIGGER prevent_member_conversation_turn_dispatch_event_delete
BEFORE DELETE ON goals_coach_member_conversation_turn_dispatch_events
FOR EACH ROW EXECUTE FUNCTION prevent_member_conversation_turn_provider_dispatch_mutation();
