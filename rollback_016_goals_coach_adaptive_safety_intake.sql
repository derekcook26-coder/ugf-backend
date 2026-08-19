ALTER TABLE goals_coach_member_safety_intake_v2_assessments
  DROP CONSTRAINT gc_member_safety_intake_version_pair_check;

ALTER TABLE goals_coach_member_safety_intake_v2_assessments
  DROP COLUMN client_request_hash_key_version;

ALTER TABLE goals_coach_member_safety_intake_v2_assessments
  ADD CONSTRAINT goals_coach_member_safety_intake_v2_assess_notice_version_check
    CHECK (notice_version = 'GC-MEMBER-SAFETY-NOTICE-2'),
  ADD CONSTRAINT goals_coach_member_safety_intake_v2_assessme_rule_version_check
    CHECK (rule_version = 'GC-MEMBER-SAFETY-INTAKE-2');
