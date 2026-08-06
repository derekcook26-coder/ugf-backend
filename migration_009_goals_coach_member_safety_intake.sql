-- Goals Coach mapped-member safety-intake alpha.
-- Additive only. Each row is one immutable submission; effective member state
-- is derived across all submissions and is never inferred from only the newest
-- row.

CREATE TABLE goals_coach_member_safety_intake_submissions (
  id BIGSERIAL PRIMARY KEY,
  auth_mapping_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  client_request_id UUID NOT NULL,
  client_request_hash TEXT NOT NULL
    CHECK (client_request_hash ~ '^[a-f0-9]{64}$'),
  notice_version TEXT NOT NULL
    CHECK (
      char_length(notice_version) BETWEEN 1 AND 100
      AND notice_version = btrim(notice_version)
    ),
  current_pain_or_concerning_symptoms BOOLEAN NOT NULL,
  current_injury_concern BOOLEAN NOT NULL,
  recent_surgery BOOLEAN NOT NULL,
  medical_or_exercise_restriction BOOLEAN NOT NULL,
  other_training_safety_concern BOOLEAN NOT NULL,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('screen_complete', 'handoff_required')),
  safety_stop BOOLEAN NOT NULL,
  rule_version TEXT NOT NULL
    CHECK (rule_version = 'GC-MEMBER-SAFETY-INTAKE-1'),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  CHECK (
    safety_stop = (
      current_pain_or_concerning_symptoms
      OR current_injury_concern
      OR recent_surgery
      OR medical_or_exercise_restriction
      OR other_training_safety_concern
    )
  ),
  CHECK (
    (safety_stop = TRUE AND outcome = 'handoff_required')
    OR
    (safety_stop = FALSE AND outcome = 'screen_complete')
  ),
  UNIQUE (member_id, client_request_id)
);

CREATE INDEX idx_goals_coach_member_safety_intake_effective
  ON goals_coach_member_safety_intake_submissions
  (member_id, safety_stop, submitted_at DESC, id DESC);

CREATE OR REPLACE FUNCTION preserve_goals_coach_member_safety_intake_submission()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'member safety-intake submissions are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'goals_coach_member_safety_intake_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_goals_coach_member_safety_intake_submission
BEFORE UPDATE OR DELETE ON goals_coach_member_safety_intake_submissions
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_member_safety_intake_submission();
