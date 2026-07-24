-- Goals Coach owner-only manual workout journal alpha.
-- Additive only. This intentionally does not reuse the governed coaching
-- milestone or workout-state lifecycles.

CREATE TABLE goals_coach_workout_logs (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES coach_members(id) ON DELETE RESTRICT,
  client_request_id UUID NOT NULL,
  performed_on DATE NOT NULL
    CHECK (performed_on BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
  workout_name TEXT NOT NULL
    CHECK (char_length(workout_name) BETWEEN 1 AND 200 AND workout_name = btrim(workout_name)),
  duration_minutes INTEGER
    CHECK (duration_minutes BETWEEN 1 AND 1440),
  notes TEXT
    CHECK (char_length(notes) BETWEEN 1 AND 4000 AND notes = btrim(notes)),
  source TEXT NOT NULL DEFAULT 'owner_manual' CHECK (source = 'owner_manual'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (member_id, client_request_id),
  UNIQUE (id, member_id)
);

CREATE INDEX idx_goals_coach_workout_logs_member_recent
  ON goals_coach_workout_logs (member_id, performed_on DESC, id DESC);

CREATE TABLE goals_coach_achievements (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES coach_members(id) ON DELETE RESTRICT,
  client_request_id UUID NOT NULL,
  achievement_type TEXT NOT NULL
    CHECK (achievement_type IN ('personal_record', 'achievement')),
  title TEXT NOT NULL
    CHECK (char_length(title) BETWEEN 1 AND 200 AND title = btrim(title)),
  achieved_on DATE NOT NULL
    CHECK (achieved_on BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
  metric_value NUMERIC(18, 6)
    CHECK (metric_value > 0 AND metric_value <= 1000000000),
  metric_unit TEXT
    CHECK (char_length(metric_unit) BETWEEN 1 AND 50 AND metric_unit = btrim(metric_unit)),
  workout_log_id BIGINT,
  notes TEXT
    CHECK (char_length(notes) BETWEEN 1 AND 4000 AND notes = btrim(notes)),
  source TEXT NOT NULL DEFAULT 'owner_manual' CHECK (source = 'owner_manual'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((metric_value IS NULL) = (metric_unit IS NULL)),
  FOREIGN KEY (workout_log_id, member_id)
    REFERENCES goals_coach_workout_logs(id, member_id) ON DELETE RESTRICT,
  UNIQUE (member_id, client_request_id)
);

CREATE INDEX idx_goals_coach_achievements_member_recent
  ON goals_coach_achievements (member_id, achieved_on DESC, id DESC);
