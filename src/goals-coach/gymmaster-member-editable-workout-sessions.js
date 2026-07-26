"use strict";

const { validGymMasterIdentity } = require("./gymmaster-member-authorization");
const {
  createEditableWorkoutSessionsRouter,
} = require("./owner-editable-workout-sessions");

const MEMBER_EDITABLE_WORKOUT_SESSIONS_FLAG =
  "GOALS_COACH_MEMBER_EDITABLE_WORKOUT_SESSIONS_ALPHA_ENABLED";

function memberEditableWorkoutSessionsEnabled(value) {
  return value === "true";
}

function createGymMasterMemberEditableWorkoutSessionsRouter(options = {}) {
  return createEditableWorkoutSessionsRouter({
    ...options,
    authorizeMember: validGymMasterIdentity,
    authorizationProperty: "memberEditableWorkoutMemberId",
    originFailureCode: "MEMBER_ORIGIN_NOT_ALLOWED",
  });
}

module.exports = {
  MEMBER_EDITABLE_WORKOUT_SESSIONS_FLAG,
  createGymMasterMemberEditableWorkoutSessionsRouter,
  memberEditableWorkoutSessionsEnabled,
};
