-- Permit the reviewed adaptive Safety Intake v3 while retaining all immutable v2 history.

ALTER TABLE goals_coach_member_safety_intake_v2_assessments
  ADD COLUMN client_request_hash_key_version TEXT,
  DROP CONSTRAINT goals_coach_member_safety_intake_v2_assess_notice_version_check,
  DROP CONSTRAINT goals_coach_member_safety_intake_v2_assessme_rule_version_check;

ALTER TABLE goals_coach_member_safety_intake_v2_assessments
  ADD CONSTRAINT gc_member_safety_intake_version_pair_check CHECK (
    (notice_version = 'GC-MEMBER-SAFETY-NOTICE-2' AND rule_version = 'GC-MEMBER-SAFETY-INTAKE-2' AND client_request_hash_key_version IS NULL)
    OR
    (notice_version = 'GC-MEMBER-SAFETY-NOTICE-3' AND rule_version = 'GC-MEMBER-SAFETY-INTAKE-3' AND client_request_hash_key_version IS NOT NULL AND client_request_hash_key_version ~ '^[a-z0-9][a-z0-9_-]{0,31}$')
  );
