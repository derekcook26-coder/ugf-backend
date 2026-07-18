DROP TRIGGER IF EXISTS trg_preserve_completed_goals_coach_turns ON goals_coach_coaching_turns;
DROP FUNCTION IF EXISTS preserve_completed_goals_coach_turns();
DROP TABLE IF EXISTS goals_coach_coaching_turns;
DROP TRIGGER IF EXISTS trg_preserve_goals_coach_workout_state_events ON goals_coach_workout_state_events;
DROP FUNCTION IF EXISTS preserve_goals_coach_workout_state_events();
DROP TABLE IF EXISTS goals_coach_workout_state_events;
DROP TABLE IF EXISTS goals_coach_workout_sessions;
