-- UGF Weekly Check-In System
-- Run this in your Supabase SQL editor or any PostgreSQL client

CREATE TABLE IF NOT EXISTS members (
  id                  SERIAL PRIMARY KEY,
  gymmaster_member_id TEXT UNIQUE NOT NULL,
  first_name          TEXT NOT NULL,
  last_name           TEXT NOT NULL,
  email               TEXT,
  phone               TEXT,
  preferred_contact   TEXT DEFAULT 'email',
  trainer_email       TEXT DEFAULT 'staff@ugf.club',
  checkin_day         INTEGER DEFAULT 1,
  checkin_enabled     BOOLEAN DEFAULT TRUE,
  sms_consent         BOOLEAN DEFAULT FALSE,
  sms_consent_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workout_plans (
  id            SERIAL PRIMARY KEY,
  member_id     INTEGER REFERENCES members(id),
  plan_markdown TEXT NOT NULL,
  profile_json  JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS weekly_checkins (
  id                  SERIAL PRIMARY KEY,
  member_id           INTEGER REFERENCES members(id),
  week_start          DATE NOT NULL,
  token               TEXT UNIQUE NOT NULL,
  completed_at        TIMESTAMPTZ,
  responses_json      JSONB,
  ai_summary_json     JSONB,
  trainer_notified_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(member_id, week_start)
);

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_weekly_checkins_token ON weekly_checkins(token);

-- Index for scheduler query (members due for check-in today)
CREATE INDEX IF NOT EXISTS idx_members_checkin_day ON members(checkin_day) WHERE checkin_enabled = TRUE;
