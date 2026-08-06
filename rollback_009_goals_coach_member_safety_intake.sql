-- Rollback 009 is preservation-first. It may remove only an unused safety-
-- intake schema and refuses to destroy any member submission provenance.

LOCK TABLE goals_coach_member_safety_intake_submissions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM goals_coach_member_safety_intake_submissions) THEN
    RAISE EXCEPTION 'Migration 009 rollback requires preservation of member safety-intake submissions'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_member_safety_intake_rollback_preservation_required';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_preserve_goals_coach_member_safety_intake_submission
  ON goals_coach_member_safety_intake_submissions;
DROP FUNCTION IF EXISTS preserve_goals_coach_member_safety_intake_submission();
DROP TABLE goals_coach_member_safety_intake_submissions;
