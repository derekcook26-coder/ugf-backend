DROP TRIGGER IF EXISTS trg_prevent_assignment_end_with_open_reviews
  ON member_coach_assignments;
DROP FUNCTION IF EXISTS prevent_assignment_end_with_open_reviews();

DROP TABLE IF EXISTS coaching_plan_change_proposals;
DROP TABLE IF EXISTS coaching_milestones;
DROP TABLE IF EXISTS coaching_observations;
DROP TABLE IF EXISTS coaching_review_events;
DROP TABLE IF EXISTS coaching_reviews;
DROP TABLE IF EXISTS coaching_concerns;
DROP TABLE IF EXISTS coaching_messages;
DROP TABLE IF EXISTS coaching_conversations;
DROP TABLE IF EXISTS coach_plan_exercises;
DROP TABLE IF EXISTS member_coach_assignments;
DROP TABLE IF EXISTS staff_users;

ALTER TABLE weekly_checkins
  DROP CONSTRAINT IF EXISTS uq_weekly_checkins_id_member;

ALTER TABLE coach_plans
  DROP CONSTRAINT IF EXISTS uq_coach_plans_id_member;
