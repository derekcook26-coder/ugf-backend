"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classifySafetyIntake } = require("../src/goals-coach/gymmaster-member-safety-intake");

const base = () => ({
  urgentWarningSigns: false, painOrStiffness: false, familiar: false, mild: false,
  severe: false, sharp: false, newOrWorsening: false, movementLimited: false,
  injuryOrInstability: false, recentSurgery: false, surgeryCleared: false,
  medicalOrExerciseRestriction: false, restrictionCanBeHonored: false,
  neurologicalSymptoms: false, otherUnsafeConcern: false,
});

test("v2 deterministically separates modification, medical review, and urgent outcomes", () => {
  assert.equal(classifySafetyIntake(base()), "SCREEN_COMPLETE");
  assert.equal(classifySafetyIntake({ ...base(), painOrStiffness: true, familiar: true, mild: true }), "MODIFICATION_REQUIRED");
  for (const field of ["severe", "sharp", "newOrWorsening", "movementLimited"]) {
    assert.equal(classifySafetyIntake({ ...base(), painOrStiffness: true, [field]: true }), "MEDICAL_REVIEW_REQUIRED");
  }
  assert.equal(classifySafetyIntake({ ...base(), urgentWarningSigns: true }), "URGENT_STOP");
});

test("v2 rejects contradictory conditional answers", () => {
  assert.throws(() => classifySafetyIntake({ ...base(), familiar: true }), /Invalid safety intake answers/);
  assert.throws(() => classifySafetyIntake({ ...base(), painOrStiffness: true, mild: true, severe: true }), /Invalid safety intake answers/);
});

test("urgent warning signs always take deterministic precedence", () => {
  assert.equal(classifySafetyIntake({
    ...base(), urgentWarningSigns: true, familiar: true,
    mild: true, severe: true, surgeryCleared: true,
  }), "URGENT_STOP");
});
