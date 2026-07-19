-- Lock Migration 005 relations in the same target-before-reference order used
-- by a coaching-turn transcription-link writer. ACCESS EXCLUSIVE serializes
-- the checks and DDL against all coaching-turn and attempt writers without a
-- backwards lock dependency.
LOCK TABLE goals_coach_coaching_turns IN ACCESS EXCLUSIVE MODE;

-- PHASE1C_ROLLBACK_COACHING_TURNS_LOCK_ACQUIRED
LOCK TABLE goals_coach_transcription_attempts IN ACCESS EXCLUSIVE MODE;

-- PHASE1C_ROLLBACK_LOCKS_ACQUIRED
-- Refuse to erase valid transcription provenance. An explicit preservation
-- procedure is required before rollback once any attempt exists or is linked.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM goals_coach_coaching_turns
    WHERE transcription_attempt_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM goals_coach_transcription_attempts
  ) THEN
    RAISE EXCEPTION 'Migration 005 rollback requires preservation of transcription provenance'
      USING ERRCODE = '23514',
        CONSTRAINT = 'goals_coach_transcription_rollback_preservation_required';
  END IF;
END;
$$;

DROP INDEX IF EXISTS uq_goals_coach_turn_transcription_attempt;
ALTER TABLE goals_coach_coaching_turns
  DROP CONSTRAINT IF EXISTS fk_goals_coach_turn_transcription_attempt;
ALTER TABLE goals_coach_coaching_turns
  DROP COLUMN IF EXISTS transcription_attempt_id;

DROP TRIGGER IF EXISTS trg_preserve_goals_coach_transcription_lifecycle
  ON goals_coach_transcription_attempts;
DROP FUNCTION IF EXISTS preserve_goals_coach_transcription_lifecycle();
DROP TRIGGER IF EXISTS trg_validate_goals_coach_transcription_attempt_insert
  ON goals_coach_transcription_attempts;
DROP FUNCTION IF EXISTS validate_goals_coach_transcription_attempt_insert();
DROP TABLE IF EXISTS goals_coach_transcription_attempts;
