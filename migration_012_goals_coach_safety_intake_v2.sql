-- Goals Coach member safety-intake v2. Additive only: Migration 009 and every
-- immutable v1 submission remain byte-for-byte unchanged.

CREATE TABLE goals_coach_member_safety_intake_v2_assessments (
  id BIGSERIAL PRIMARY KEY,
  auth_mapping_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  client_request_id UUID NOT NULL,
  client_request_hash TEXT NOT NULL CHECK (client_request_hash ~ '^[a-f0-9]{64}$'),
  notice_version TEXT NOT NULL CHECK (notice_version = 'GC-MEMBER-SAFETY-NOTICE-2'),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'SCREEN_COMPLETE', 'MODIFICATION_REQUIRED',
    'MEDICAL_REVIEW_REQUIRED', 'URGENT_STOP'
  )),
  rule_version TEXT NOT NULL CHECK (rule_version = 'GC-MEMBER-SAFETY-INTAKE-2'),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  CHECK (valid_until > submitted_at AND valid_until <= submitted_at + INTERVAL '12 hours'),
  UNIQUE (member_id, client_request_id)
);

CREATE INDEX idx_goals_coach_member_safety_intake_v2_effective
  ON goals_coach_member_safety_intake_v2_assessments
  (member_id, submitted_at DESC, id DESC);

CREATE OR REPLACE FUNCTION preserve_goals_coach_member_safety_intake_v2_assessment()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'member safety-intake v2 assessments are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'goals_coach_member_safety_intake_v2_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_goals_coach_member_safety_intake_v2_assessment
BEFORE UPDATE OR DELETE ON goals_coach_member_safety_intake_v2_assessments
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_member_safety_intake_v2_assessment();
