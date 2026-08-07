-- Goals Coach member pending enrollment and authenticated mapping completion.
-- Additive only. Existing mappings, consents, safety-intake submissions, and
-- member records are never rewritten or backfilled.

LOCK TABLE goals_coach_member_auth_mappings IN SHARE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM goals_coach_member_auth_mappings
    WHERE auth_provider = 'gymmaster'
      AND auth_subject !~ '^gymmaster:[1-9][0-9]*$'
  ) THEN
    RAISE EXCEPTION 'Migration 010 preflight found a noncanonical GymMaster mapping identity'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_member_pending_enrollment_mapping_preflight';
  END IF;

  IF EXISTS (
    SELECT auth_provider, auth_subject
    FROM goals_coach_member_auth_mappings
    WHERE auth_provider = 'gymmaster'
    GROUP BY auth_provider, auth_subject
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migration 010 preflight found conflicting GymMaster mapping identities'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_member_pending_enrollment_mapping_preflight';
  END IF;
END;
$$;

CREATE TABLE goals_coach_member_pending_enrollments (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL
    REFERENCES coach_members(id) ON DELETE RESTRICT,
  gymmaster_member_id TEXT NOT NULL
    CHECK (gymmaster_member_id ~ '^[1-9][0-9]*$'),
  client_request_id UUID NOT NULL UNIQUE,
  requested_by_staff_user_id BIGINT NOT NULL
    REFERENCES staff_users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'expired')),
  auth_mapping_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  CHECK (expires_at = created_at + INTERVAL '24 hours'),
  CHECK (
    (status = 'pending'
      AND auth_mapping_id IS NULL
      AND consumed_at IS NULL
      AND expired_at IS NULL)
    OR
    (status = 'consumed'
      AND auth_mapping_id IS NOT NULL
      AND consumed_at IS NOT NULL
      AND expired_at IS NULL)
    OR
    (status = 'expired'
      AND auth_mapping_id IS NULL
      AND consumed_at IS NULL
      AND expired_at IS NOT NULL)
  ),
  UNIQUE (id, member_id),
  UNIQUE (
    id,
    member_id,
    requested_by_staff_user_id,
    client_request_id
  )
);

CREATE UNIQUE INDEX uq_goals_coach_member_pending_enrollment_member
  ON goals_coach_member_pending_enrollments (member_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX uq_goals_coach_member_pending_enrollment_gymmaster
  ON goals_coach_member_pending_enrollments (gymmaster_member_id)
  WHERE status = 'pending';

CREATE INDEX idx_goals_coach_member_pending_enrollment_expiry
  ON goals_coach_member_pending_enrollments (expires_at, id)
  WHERE status = 'pending';

CREATE TABLE goals_coach_member_provisioning_events (
  id BIGSERIAL PRIMARY KEY,
  pending_enrollment_id BIGINT NOT NULL,
  auth_mapping_id BIGINT,
  member_id BIGINT NOT NULL,
  staff_user_id BIGINT NOT NULL,
  client_request_id UUID NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('pending_enrollment_created', 'mapping_completed')),
  result TEXT NOT NULL
    CHECK (result IN ('created', 'completed')),
  reason_code TEXT
    CHECK (
      reason_code IS NULL
      OR (
        reason_code = btrim(reason_code)
        AND char_length(reason_code) BETWEEN 1 AND 100
        AND reason_code ~ '^[a-z][a-z0-9_]*$'
      )
    ),
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (
    pending_enrollment_id,
    member_id,
    staff_user_id,
    client_request_id
  ) REFERENCES goals_coach_member_pending_enrollments (
    id,
    member_id,
    requested_by_staff_user_id,
    client_request_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (auth_mapping_id, member_id)
    REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  CHECK (
    (action = 'pending_enrollment_created'
      AND result = 'created'
      AND auth_mapping_id IS NULL
      AND reason_code IS NULL)
    OR
    (action = 'mapping_completed'
      AND result = 'completed'
      AND auth_mapping_id IS NOT NULL
      AND reason_code IS NULL)
  ),
  UNIQUE (pending_enrollment_id, action)
);

CREATE INDEX idx_goals_coach_member_provisioning_events_member
  ON goals_coach_member_provisioning_events (member_id, created_at, id);

CREATE OR REPLACE FUNCTION preserve_goals_coach_member_provisioning_event()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'member provisioning events are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'goals_coach_member_provisioning_events_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_goals_coach_member_provisioning_event
BEFORE UPDATE OR DELETE ON goals_coach_member_provisioning_events
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_member_provisioning_event();

CREATE OR REPLACE FUNCTION preserve_goals_coach_member_pending_enrollment_deletion()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'member pending enrollments cannot be deleted'
    USING ERRCODE = '23514',
          CONSTRAINT = 'goals_coach_member_pending_enrollments_no_delete';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_goals_coach_member_pending_enrollment_deletion
BEFORE DELETE ON goals_coach_member_pending_enrollments
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_member_pending_enrollment_deletion();
