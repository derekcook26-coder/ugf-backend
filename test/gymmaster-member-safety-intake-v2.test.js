"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classifySafetyIntake } = require("../src/goals-coach/gymmaster-member-safety-intake");

const base = () => ({
  urgentWarningSigns: false, painOrStiffness: false, painSeverity: null,
  injuryOrInstability: false, recentSurgery: false, surgeryCleared: null,
  medicalOrExerciseRestriction: false, restrictionAllowsSafeExercise: null,
  neurologicalSymptoms: false, otherUnsafeConcern: false,
});

test("v3 deterministically separates modification, medical review, and urgent outcomes", () => {
  assert.equal(classifySafetyIntake(base()), "SCREEN_COMPLETE");
  const pain = { ...base(), painOrStiffness: true, painSeverity: 3 };
  assert.equal(classifySafetyIntake(pain), "MODIFICATION_REQUIRED");
  assert.equal(classifySafetyIntake({ ...pain, painSeverity: 8 }), "MEDICAL_REVIEW_REQUIRED");
});

test("v3 rejects contradictory conditional answers", () => {
  assert.throws(() => classifySafetyIntake({ ...base(), painSeverity: 2 }), /Invalid safety intake answers/);
  assert.throws(() => classifySafetyIntake({ ...base(), surgeryCleared: true }), /Invalid safety intake answers/);
});

test("urgent warning signs always take deterministic precedence", () => {
  const urgent = Object.fromEntries(Object.keys(base()).map((field) => [field, null]));
  urgent.urgentWarningSigns = true;
  assert.equal(classifySafetyIntake(urgent), "URGENT_STOP");
});
