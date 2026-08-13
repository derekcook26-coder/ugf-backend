-- Migration 011: nullable paired member display names and post-login member provisioning.
-- Explicit runner only. Migration 010 is intentionally not modified.

-- migrate_011_statement
ALTER TABLE coach_members
  ALTER COLUMN first_name DROP NOT NULL;

-- migrate_011_statement
ALTER TABLE coach_members
  ALTER COLUMN last_name DROP NOT NULL;

-- migrate_011_statement
ALTER TABLE coach_members
  ADD CONSTRAINT ck_coach_members_name_pair
  CHECK ((first_name IS NULL) = (last_name IS NULL)) NOT VALID;

-- migrate_011_statement
ALTER TABLE goals_coach_member_pending_enrollments
  ADD CONSTRAINT uq_goals_coach_member_pending_event_provenance
  UNIQUE (id, requested_by_staff_user_id, client_request_id);

-- migrate_011_statement
ALTER TABLE goals_coach_member_pending_enrollments
  ALTER COLUMN member_id DROP NOT NULL;

-- migrate_011_statement
ALTER TABLE goals_coach_member_pending_enrollments
  ADD CONSTRAINT ck_goals_coach_member_pending_consumed_member
  CHECK (
    status <> 'consumed'
    OR (member_id IS NOT NULL AND auth_mapping_id IS NOT NULL)
  ) NOT VALID;

-- migrate_011_statement
ALTER TABLE goals_coach_member_provisioning_events
  ALTER COLUMN member_id DROP NOT NULL;

-- migrate_011_statement
ALTER TABLE goals_coach_member_provisioning_events
  ADD CONSTRAINT fk_goals_coach_member_provisioning_event_pending
  FOREIGN KEY (pending_enrollment_id, staff_user_id, client_request_id)
  REFERENCES goals_coach_member_pending_enrollments
    (id, requested_by_staff_user_id, client_request_id)
  ON DELETE RESTRICT NOT VALID;

-- migrate_011_statement
ALTER TABLE goals_coach_member_provisioning_events
  ADD CONSTRAINT ck_goals_coach_member_provisioning_event_completed_member
  CHECK (action <> 'mapping_completed' OR member_id IS NOT NULL) NOT VALID;

-- migrate_011_statement
ALTER TABLE coach_members
  VALIDATE CONSTRAINT ck_coach_members_name_pair;

-- migrate_011_statement
ALTER TABLE goals_coach_member_pending_enrollments
  VALIDATE CONSTRAINT ck_goals_coach_member_pending_consumed_member;

-- migrate_011_statement
ALTER TABLE goals_coach_member_provisioning_events
  VALIDATE CONSTRAINT fk_goals_coach_member_provisioning_event_pending;

-- migrate_011_statement
ALTER TABLE goals_coach_member_provisioning_events
  VALIDATE CONSTRAINT ck_goals_coach_member_provisioning_event_completed_member;
