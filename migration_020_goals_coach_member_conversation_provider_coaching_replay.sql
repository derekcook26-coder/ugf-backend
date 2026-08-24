-- Immutable provider-authored coaching replay for exact RESPONSE-2 reconstruction.
-- Existing turn idempotency and provider-dispatch rows are intentionally not backfilled.

DO $$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'provider coaching replay requires a UTF8 database'
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

ALTER TABLE goals_coach_member_conversation_turn_idempotency
  ADD CONSTRAINT uq_member_conversation_turn_idempotency_exact_identity
  UNIQUE (
    id,
    idempotency_key,
    conversation_binding_id,
    conversation_reference,
    conversation_version,
    conversation_provenance,
    request_signature_sha256
  );

CREATE TABLE goals_coach_member_conversation_provider_coaching_replays (
  id BIGSERIAL PRIMARY KEY,
  reservation_id BIGINT NOT NULL UNIQUE,
  migration_018_row_id BIGINT NOT NULL UNIQUE,
  idempotency_key UUID NOT NULL,
  conversation_binding_id BIGINT NOT NULL,
  conversation_reference UUID NOT NULL,
  conversation_version INTEGER NOT NULL,
  conversation_provenance TEXT NOT NULL,
  request_signature_sha256 CHAR(64) NOT NULL,
  response_contract_version TEXT NOT NULL
    CONSTRAINT chk_member_conversation_provider_coaching_response_version
    CHECK (response_contract_version = 'GC-MEMBER-CONVERSATION-TURN-RESPONSE-2'),
  coaching_text TEXT NOT NULL,
  response_digest_sha256 CHAR(64) NOT NULL
    CONSTRAINT chk_member_conversation_provider_coaching_response_digest
    CHECK (response_digest_sha256 ~ '^[0-9a-f]{64}$'),
  coaching_digest_sha256 CHAR(64) NOT NULL
    CONSTRAINT chk_member_conversation_provider_coaching_text_digest
    CHECK (coaching_digest_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_member_conversation_provider_coaching_identity
    CHECK (
      idempotency_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND conversation_reference::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND conversation_version = 1
      AND conversation_provenance = 'member_session'
      AND request_signature_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT chk_member_conversation_provider_coaching_text
    CHECK (
      length(coaching_text) BETWEEN 1 AND 800
      AND octet_length(coaching_text) <= 1600
      AND coaching_text !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
      AND coaching_text !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'
      AND coaching_text = normalize(coaching_text, NFC)
      AND coaching_text !~ U&'[\0001-\0009\000B-\001F\007F]'
    ),
  CONSTRAINT fk_member_conversation_provider_coaching_reservation
    FOREIGN KEY (
      reservation_id,
      idempotency_key,
      conversation_binding_id,
      conversation_reference,
      conversation_version,
      conversation_provenance,
      request_signature_sha256
    ) REFERENCES goals_coach_member_conversation_turn_reservations (
      id,
      idempotency_key,
      conversation_binding_id,
      conversation_reference,
      conversation_version,
      conversation_provenance,
      request_signature_sha256
    ) ON DELETE RESTRICT,
  CONSTRAINT fk_member_conversation_provider_coaching_final_row
    FOREIGN KEY (
      migration_018_row_id,
      idempotency_key,
      conversation_binding_id,
      conversation_reference,
      conversation_version,
      conversation_provenance,
      request_signature_sha256
    ) REFERENCES goals_coach_member_conversation_turn_idempotency (
      id,
      idempotency_key,
      conversation_binding_id,
      conversation_reference,
      conversation_version,
      conversation_provenance,
      request_signature_sha256
    ) ON DELETE RESTRICT
);

CREATE FUNCTION canonical_member_conversation_turn_response_v2(
  exact_idempotency_key UUID,
  exact_conversation_reference UUID,
  exact_conversation_version INTEGER,
  exact_conversation_provenance TEXT,
  exact_request_signature_sha256 TEXT,
  exact_safety_rule_version TEXT,
  exact_safety_source_rule_version TEXT,
  exact_coaching_text TEXT
)
RETURNS TEXT AS $$
  SELECT
    '{"contractVersion":"GC-MEMBER-CONVERSATION-TURN-RESPONSE-2"'
    || ',"requestContractVersion":"GC-MEMBER-CONVERSATION-TURN-1"'
    || ',"requestId":' || to_json(exact_idempotency_key::text)::text
    || ',"idempotencyKey":' || to_json(exact_idempotency_key::text)::text
    || ',"conversation":{"reference":' || to_json(exact_conversation_reference::text)::text
    || ',"version":' || exact_conversation_version::text
    || ',"provenance":' || to_json(exact_conversation_provenance)::text || '}'
    || ',"result":{"state":"safe_to_process","reason":null,"safety":{"ruleVersion":'
    || to_json(exact_safety_rule_version)::text
    || ',"sourceRuleVersion":' || to_json(exact_safety_source_rule_version)::text
    || ',"requestHash":' || to_json(exact_request_signature_sha256)::text
    || ',"classification":"clear","action":"allow_provider_processing"}}'
    || ',"coaching":' || to_json(exact_coaching_text)::text || '}';
$$ LANGUAGE SQL IMMUTABLE STRICT;

CREATE FUNCTION enforce_member_conversation_provider_coaching_replay_insert()
RETURNS TRIGGER AS $$
DECLARE
  reservation goals_coach_member_conversation_turn_reservations%ROWTYPE;
  final_row goals_coach_member_conversation_turn_idempotency%ROWTYPE;
  receipt goals_coach_member_conversation_turn_dispatch_events%ROWTYPE;
  canonical_response TEXT;
  calculated_response_digest TEXT;
  calculated_coaching_digest TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('goals_coach_member_conversation_turn_dispatch:' || NEW.reservation_id::text, 0)
  );

  SELECT * INTO reservation
  FROM goals_coach_member_conversation_turn_reservations
  WHERE id = NEW.reservation_id
    AND idempotency_key = NEW.idempotency_key
    AND conversation_binding_id = NEW.conversation_binding_id
    AND conversation_reference = NEW.conversation_reference
    AND conversation_version = NEW.conversation_version
    AND conversation_provenance = NEW.conversation_provenance
    AND request_signature_sha256 = NEW.request_signature_sha256
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact provider coaching reservation is unavailable' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO final_row
  FROM goals_coach_member_conversation_turn_idempotency
  WHERE id = NEW.migration_018_row_id
    AND idempotency_key = NEW.idempotency_key
    AND conversation_binding_id = NEW.conversation_binding_id
    AND conversation_reference = NEW.conversation_reference
    AND conversation_version = NEW.conversation_version
    AND conversation_provenance = NEW.conversation_provenance
    AND request_signature_sha256 = NEW.request_signature_sha256
    AND contract_version = 'GC-MEMBER-CONVERSATION-TURN-1'
    AND safety_rule_version = 'GC-MEMBER-CONVERSATION-SAFETY-1'
    AND safety_source_rule_version = 'GC-MEMBER-CONVERSATION-SAFETY-RULES-1'
    AND response_state = 'safe_to_process'
    AND response_reason IS NULL
    AND safety_classification = 'clear'
    AND safety_action = 'allow_provider_processing'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact safe provider coaching replay row is unavailable' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO receipt
  FROM goals_coach_member_conversation_turn_dispatch_events
  WHERE reservation_id = NEW.reservation_id
  ORDER BY event_sequence DESC
  LIMIT 1;
  IF NOT FOUND OR receipt.event_type <> 'provider_succeeded' THEN
    RAISE EXCEPTION 'current provider success receipt is unavailable' USING ERRCODE = '23514';
  END IF;

  canonical_response := canonical_member_conversation_turn_response_v2(
    final_row.idempotency_key,
    final_row.conversation_reference,
    final_row.conversation_version,
    final_row.conversation_provenance,
    final_row.request_signature_sha256,
    final_row.safety_rule_version,
    final_row.safety_source_rule_version,
    NEW.coaching_text
  );
  calculated_response_digest := encode(sha256(convert_to(canonical_response, 'UTF8')), 'hex');
  calculated_coaching_digest := encode(sha256(convert_to(NEW.coaching_text, 'UTF8')), 'hex');
  IF NEW.response_digest_sha256 <> calculated_response_digest
    OR receipt.response_digest_sha256 <> calculated_response_digest
    OR NEW.coaching_digest_sha256 <> calculated_coaching_digest THEN
    RAISE EXCEPTION 'provider coaching replay digest is invalid' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_member_conversation_provider_coaching_replay_before_insert
BEFORE INSERT ON goals_coach_member_conversation_provider_coaching_replays
FOR EACH ROW EXECUTE FUNCTION enforce_member_conversation_provider_coaching_replay_insert();

CREATE FUNCTION enforce_member_conversation_provider_coaching_finalization()
RETURNS TRIGGER AS $$
DECLARE
  prior goals_coach_member_conversation_turn_dispatch_events%ROWTYPE;
  companion goals_coach_member_conversation_provider_coaching_replays%ROWTYPE;
  final_row goals_coach_member_conversation_turn_idempotency%ROWTYPE;
  canonical_response TEXT;
  calculated_response_digest TEXT;
BEGIN
  IF NEW.event_type <> 'finalized' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO prior
  FROM goals_coach_member_conversation_turn_dispatch_events
  WHERE reservation_id = NEW.reservation_id
    AND event_sequence = NEW.event_sequence - 1;
  IF NOT FOUND OR prior.event_type <> 'provider_succeeded' THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('goals_coach_member_conversation_turn_dispatch:' || NEW.reservation_id::text, 0)
  );
  SELECT * INTO companion
  FROM goals_coach_member_conversation_provider_coaching_replays
  WHERE reservation_id = NEW.reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider coaching replay is required before finalization' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO final_row
  FROM goals_coach_member_conversation_turn_idempotency
  WHERE id = companion.migration_018_row_id
    AND idempotency_key = companion.idempotency_key
    AND conversation_binding_id = companion.conversation_binding_id
    AND conversation_reference = companion.conversation_reference
    AND conversation_version = companion.conversation_version
    AND conversation_provenance = companion.conversation_provenance
    AND request_signature_sha256 = companion.request_signature_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider coaching final replay identity is unavailable' USING ERRCODE = '23514';
  END IF;
  canonical_response := canonical_member_conversation_turn_response_v2(
    final_row.idempotency_key,
    final_row.conversation_reference,
    final_row.conversation_version,
    final_row.conversation_provenance,
    final_row.request_signature_sha256,
    final_row.safety_rule_version,
    final_row.safety_source_rule_version,
    companion.coaching_text
  );
  calculated_response_digest := encode(sha256(convert_to(canonical_response, 'UTF8')), 'hex');
  IF calculated_response_digest <> companion.response_digest_sha256
    OR calculated_response_digest <> prior.response_digest_sha256 THEN
    RAISE EXCEPTION 'provider coaching finalization digest is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER enforce_member_conversation_provider_coaching_finalization_insert
AFTER INSERT ON goals_coach_member_conversation_turn_dispatch_events
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_member_conversation_provider_coaching_finalization();

CREATE FUNCTION prevent_member_conversation_provider_coaching_replay_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'member conversation provider coaching replay rows are immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_member_conversation_provider_coaching_replay_update
BEFORE UPDATE ON goals_coach_member_conversation_provider_coaching_replays
FOR EACH ROW EXECUTE FUNCTION prevent_member_conversation_provider_coaching_replay_mutation();

CREATE TRIGGER prevent_member_conversation_provider_coaching_replay_delete
BEFORE DELETE ON goals_coach_member_conversation_provider_coaching_replays
FOR EACH ROW EXECUTE FUNCTION prevent_member_conversation_provider_coaching_replay_mutation();
