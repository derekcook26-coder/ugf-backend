-- Goals Coach owner-only editable workout sessions alpha.
-- Additive only. These manually authored sessions are intentionally separate
-- from goals_coach_workout_sessions, whose rows require coaching
-- conversation/plan provenance.

CREATE TABLE goals_coach_tracked_workout_sessions (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES coach_members(id) ON DELETE RESTRICT,
  client_request_id UUID NOT NULL,
  client_request_hash TEXT NOT NULL
    CHECK (client_request_hash ~ '^[a-f0-9]{64}$'),
  source TEXT NOT NULL CHECK (source IN ('manual', 'plan_snapshot')),
  source_snapshot JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  workout_name TEXT NOT NULL
    CHECK (char_length(workout_name) BETWEEN 1 AND 200 AND workout_name = btrim(workout_name)),
  notes TEXT
    CHECK (char_length(notes) BETWEEN 1 AND 4000 AND notes = btrim(notes)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CHECK (
    (source = 'manual' AND source_snapshot IS NULL)
    OR
    (source = 'plan_snapshot'
      AND source_snapshot IS NOT NULL
      AND jsonb_typeof(source_snapshot) = 'object')
  ),
  CHECK (
    (status = 'draft' AND completed_at IS NULL)
    OR
    (status = 'completed' AND completed_at IS NOT NULL)
  ),
  UNIQUE (member_id, client_request_id),
  UNIQUE (id, member_id)
);

CREATE INDEX idx_goals_coach_tracked_workout_sessions_member_created
  ON goals_coach_tracked_workout_sessions (member_id, created_at DESC, id DESC);

CREATE TABLE goals_coach_tracked_workout_exercises (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  exercise_order INTEGER NOT NULL CHECK (exercise_order BETWEEN 1 AND 100),
  name TEXT NOT NULL
    CHECK (char_length(name) BETWEEN 1 AND 200 AND name = btrim(name)),
  state TEXT NOT NULL CHECK (state IN ('planned', 'completed', 'skipped')),
  notes TEXT
    CHECK (char_length(notes) BETWEEN 1 AND 4000 AND notes = btrim(notes)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (session_id, member_id)
    REFERENCES goals_coach_tracked_workout_sessions(id, member_id) ON DELETE RESTRICT,
  UNIQUE (session_id, session_version, exercise_order),
  UNIQUE (id, session_id, member_id, session_version)
);

CREATE INDEX idx_goals_coach_tracked_workout_exercises_revision
  ON goals_coach_tracked_workout_exercises
  (session_id, member_id, session_version, exercise_order);

CREATE TABLE goals_coach_tracked_workout_sets (
  id BIGSERIAL PRIMARY KEY,
  exercise_id BIGINT NOT NULL,
  session_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  set_order INTEGER NOT NULL CHECK (set_order BETWEEN 1 AND 50),
  actual_reps INTEGER NOT NULL CHECK (actual_reps BETWEEN 0 AND 10000),
  load NUMERIC(18, 6) CHECK (load > 0 AND load <= 1000000000),
  unit TEXT CHECK (char_length(unit) BETWEEN 1 AND 20 AND unit = btrim(unit)),
  notes TEXT
    CHECK (char_length(notes) BETWEEN 1 AND 2000 AND notes = btrim(notes)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((load IS NULL) = (unit IS NULL)),
  FOREIGN KEY (exercise_id, session_id, member_id, session_version)
    REFERENCES goals_coach_tracked_workout_exercises
      (id, session_id, member_id, session_version) ON DELETE RESTRICT,
  UNIQUE (exercise_id, set_order)
);

CREATE INDEX idx_goals_coach_tracked_workout_sets_revision
  ON goals_coach_tracked_workout_sets
  (session_id, member_id, session_version, exercise_id, set_order);

CREATE TABLE goals_coach_tracked_workout_events (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'draft_replaced', 'completed', 'correction_replacement'
  )),
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(event_data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (session_id, member_id)
    REFERENCES goals_coach_tracked_workout_sessions(id, member_id) ON DELETE RESTRICT
);

CREATE INDEX idx_goals_coach_tracked_workout_events_session
  ON goals_coach_tracked_workout_events (session_id, created_at, id);
CREATE UNIQUE INDEX uq_goals_coach_tracked_workout_completed_event
  ON goals_coach_tracked_workout_events (session_id)
  WHERE event_type = 'completed';

CREATE OR REPLACE FUNCTION preserve_goals_coach_tracked_workout_session()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tracked workout sessions cannot be deleted'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_tracked_workout_sessions_no_delete';
  END IF;

  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed tracked workout sessions are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_tracked_workout_completed_immutable';
  END IF;

  IF NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
     OR NEW.client_request_hash IS DISTINCT FROM OLD.client_request_hash
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tracked workout session identity and source are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_tracked_workout_session_identity_immutable';
  END IF;

  IF NEW.status = 'draft' AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'draft replacement must advance exactly one version'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_tracked_workout_version_transition';
  END IF;

  IF NEW.status = 'completed'
     AND (OLD.status <> 'draft' OR NEW.version <> OLD.version) THEN
    RAISE EXCEPTION 'invalid tracked workout completion transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_tracked_workout_completion_transition';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_goals_coach_tracked_workout_session
BEFORE UPDATE OR DELETE ON goals_coach_tracked_workout_sessions
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_tracked_workout_session();

CREATE OR REPLACE FUNCTION preserve_goals_coach_tracked_workout_revision()
RETURNS TRIGGER AS $$
DECLARE
  parent_status TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tracked workout execution revisions are append-only'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_tracked_workout_revisions_append_only';
  END IF;

  SELECT status INTO parent_status
  FROM goals_coach_tracked_workout_sessions
  WHERE id = NEW.session_id AND member_id = NEW.member_id
  FOR UPDATE;

  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'completed tracked workout execution data is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'goals_coach_tracked_workout_completed_immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_goals_coach_tracked_workout_exercises
BEFORE INSERT OR UPDATE OR DELETE ON goals_coach_tracked_workout_exercises
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_tracked_workout_revision();

CREATE TRIGGER trg_preserve_goals_coach_tracked_workout_sets
BEFORE INSERT OR UPDATE OR DELETE ON goals_coach_tracked_workout_sets
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_tracked_workout_revision();

CREATE OR REPLACE FUNCTION preserve_goals_coach_tracked_workout_events()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'tracked workout lifecycle events are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'goals_coach_tracked_workout_events_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_goals_coach_tracked_workout_events
BEFORE UPDATE OR DELETE ON goals_coach_tracked_workout_events
FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_tracked_workout_events();
