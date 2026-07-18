-- Roll back only the Phase 1A private-alpha foundation.

DROP TABLE IF EXISTS goals_coach_alpha_feedback;
DROP TABLE IF EXISTS goals_coach_member_preferences;
DROP TRIGGER IF EXISTS trg_preserve_goals_coach_alpha_consent_events
  ON goals_coach_alpha_consent_events;
DROP FUNCTION IF EXISTS preserve_goals_coach_alpha_consent_events();
DROP TABLE IF EXISTS goals_coach_alpha_consent_events;
DROP TABLE IF EXISTS goals_coach_alpha_consents;
DROP TABLE IF EXISTS goals_coach_member_auth_mappings;
