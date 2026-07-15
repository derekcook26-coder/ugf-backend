BEGIN;

CREATE TABLE IF NOT EXISTS coach_members (
  id BIGSERIAL PRIMARY KEY,
  gymmaster_member_id TEXT UNIQUE NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coach_plans (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL
    REFERENCES coach_members(id)
    ON DELETE CASCADE,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  assessment_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  plan_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS weekly_checkins (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL
    REFERENCES coach_members(id)
    ON DELETE CASCADE,
  week_start DATE NOT NULL,
  responses_json JSONB NOT NULL,
  ai_analysis_json JSONB,
  member_reply TEXT,
  trainer_summary TEXT,
  status TEXT
    CHECK (status IN ('green', 'yellow', 'red')),
  trainer_notified_at TIMESTAMPTZ,
  trainer_notification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      trainer_notification_status IN (
        'pending',
        'sent',
        'failed'
      )
    ),
  trainer_notification_attempts INTEGER NOT NULL DEFAULT 0,
  trainer_notification_last_error TEXT,
  trainer_notification_last_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (member_id, week_start)
);

CREATE TABLE IF NOT EXISTS checkin_email_log (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL
    REFERENCES coach_members(id)
    ON DELETE CASCADE,
  week_start DATE NOT NULL,
  gymmaster_template_id TEXT,
  delivery_status TEXT NOT NULL,
  provider_response JSONB,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (member_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_coach_plans_member_created
  ON coach_plans (member_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_weekly_checkins_member_week
  ON weekly_checkins (member_id, week_start DESC);

CREATE INDEX IF NOT EXISTS idx_weekly_checkins_notification
  ON weekly_checkins (
    trainer_notification_status,
    trainer_notified_at
  );

COMMIT;
