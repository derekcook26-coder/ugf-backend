-- General-member Goals Coach coaching consent. Consent records authority only;
-- it does not activate coaching, providers, plans, voice, or workout mutation.

CREATE TABLE goals_coach_member_coaching_consents (
  member_id BIGINT PRIMARY KEY REFERENCES coach_members(id) ON DELETE RESTRICT,
  auth_mapping_id BIGINT NOT NULL,
  notice_version TEXT NOT NULL CHECK (notice_version ~ '^GC-MEMBER-COACHING-CONSENT-[1-9][0-9]*$'),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'declined', 'withdrawn')),
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'accepted' AND accepted_at IS NOT NULL AND declined_at IS NULL AND withdrawn_at IS NULL)
    OR (status = 'declined' AND accepted_at IS NULL AND declined_at IS NOT NULL AND withdrawn_at IS NULL)
    OR (status = 'withdrawn' AND accepted_at IS NOT NULL AND declined_at IS NULL AND withdrawn_at IS NOT NULL
        AND withdrawn_at >= accepted_at)
  ),
  CHECK (updated_at = COALESCE(withdrawn_at, declined_at, accepted_at))
);

CREATE TABLE goals_coach_member_coaching_consent_events (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL,
  auth_mapping_id BIGINT NOT NULL,
  auth_provider TEXT NOT NULL CHECK (auth_provider = 'gymmaster'),
  auth_subject TEXT NOT NULL CHECK (auth_subject ~ '^gymmaster:[1-9][0-9]*$'),
  notice_version TEXT NOT NULL CHECK (notice_version ~ '^GC-MEMBER-COACHING-CONSENT-[1-9][0-9]*$'),
  event_type TEXT NOT NULL CHECK (event_type IN ('accepted', 'declined', 'withdrawn')),
  client_request_id UUID NOT NULL,
  client_request_hash TEXT NOT NULL CHECK (client_request_hash ~ '^[a-f0-9]{64}$'),
  result_notice_version TEXT NOT NULL CHECK (result_notice_version = notice_version),
  result_status TEXT NOT NULL CHECK (result_status IN ('accepted', 'declined', 'withdrawn')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  UNIQUE (member_id, client_request_id)
);

CREATE INDEX idx_goals_coach_member_coaching_consent_events_history
  ON goals_coach_member_coaching_consent_events (member_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION preserve_goals_coach_member_coaching_consent_event()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'member coaching consent events are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'goals_coach_member_coaching_consent_events_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_goals_coach_member_coaching_consent_event
BEFORE UPDATE OR DELETE ON goals_coach_member_coaching_consent_events
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_member_coaching_consent_event();
