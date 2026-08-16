-- Provider-free member-today minimized provenance. No response or member prose is stored.
CREATE TABLE goals_coach_member_today_attempts (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL,
  auth_mapping_id BIGINT NOT NULL,
  client_request_id UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  original_attempt_id BIGINT,
  state_code TEXT NOT NULL CHECK (state_code IN ('SAFETY_REQUIRED','URGENT_STOP','MEDICAL_REVIEW_REQUIRED','CONSENT_REQUIRED','UNAVAILABLE','QUESTION_REQUIRED','READY')),
  safety_outcome TEXT CHECK (safety_outcome IN ('SCREEN_COMPLETE','MODIFICATION_REQUIRED','MEDICAL_REVIEW_REQUIRED','URGENT_STOP')),
  plan_id BIGINT,
  plan_version TIMESTAMPTZ,
  plan_item_id BIGINT,
  plan_item_hash TEXT CHECK (plan_item_hash IS NULL OR plan_item_hash ~ '^[a-f0-9]{64}$'),
  option_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(option_ids)='array'),
  option_item_ids JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(option_item_ids)='object'),
  option_item_hashes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(option_item_hashes)='object'),
  selected_option_id TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (auth_mapping_id, member_id) REFERENCES goals_coach_member_auth_mappings(id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (original_attempt_id, member_id) REFERENCES goals_coach_member_today_attempts(id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (plan_id, member_id) REFERENCES coach_plans(id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (plan_item_id, plan_id) REFERENCES coach_plan_exercises(id, plan_id) ON DELETE RESTRICT,
  UNIQUE (member_id, client_request_id), UNIQUE (id, member_id),
  CHECK ((state_code IN ('QUESTION_REQUIRED','READY') AND plan_id IS NOT NULL AND plan_version IS NOT NULL) OR (state_code NOT IN ('QUESTION_REQUIRED','READY') AND plan_id IS NULL AND plan_version IS NULL)),
  CHECK ((state_code='READY' AND plan_item_id IS NOT NULL AND plan_item_hash IS NOT NULL) OR (state_code<>'READY' AND plan_item_id IS NULL AND plan_item_hash IS NULL))
);
CREATE INDEX idx_goals_coach_member_today_attempts_scope ON goals_coach_member_today_attempts(member_id,created_at DESC,id DESC);
CREATE OR REPLACE FUNCTION preserve_goals_coach_member_today_attempt() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(OLD) - 'consumed_at') <> (to_jsonb(NEW) - 'consumed_at') OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'member today attempts are immutable except one-time consumption' USING ERRCODE='23514', CONSTRAINT='goals_coach_member_today_attempts_append_only';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_preserve_goals_coach_member_today_attempt BEFORE UPDATE OR DELETE ON goals_coach_member_today_attempts FOR EACH ROW EXECUTE FUNCTION preserve_goals_coach_member_today_attempt();
