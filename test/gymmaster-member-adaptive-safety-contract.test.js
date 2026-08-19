"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  MEMBER_SAFETY_NOTICE_VERSION,
  classifySafetyIntake,
  parseSafetyIntake,
  parseSafetyHashConfiguration,
  safetyIntakeRequestHash,
} = require("../src/goals-coach/gymmaster-member-safety-intake");

test("v3 provenance hashing is keyed, versioned, rotatable, and fail closed", () => {
  const keys = { "key-1": "a".repeat(32), "key-2": "b".repeat(32) };
  const configuration = parseSafetyHashConfiguration({
    GOALS_COACH_MEMBER_SAFETY_HASH_CURRENT_VERSION: "key-2",
    GOALS_COACH_MEMBER_SAFETY_HASH_KEYS_JSON: JSON.stringify(keys),
  });
  assert.equal(configuration.currentVersion, "key-2");
  const parsed = parseSafetyIntake(request(baseline()), MEMBER_SAFETY_NOTICE_VERSION);
  assert.notEqual(safetyIntakeRequestHash(parsed, keys["key-1"]), safetyIntakeRequestHash(parsed, keys["key-2"]));
  for (const environment of [{}, { GOALS_COACH_MEMBER_SAFETY_HASH_CURRENT_VERSION: "key-1", GOALS_COACH_MEMBER_SAFETY_HASH_KEYS_JSON: "{}" }, { GOALS_COACH_MEMBER_SAFETY_HASH_CURRENT_VERSION: "key-1", GOALS_COACH_MEMBER_SAFETY_HASH_KEYS_JSON: JSON.stringify({ "key-1": "short" }) }]) assert.equal(parseSafetyHashConfiguration(environment), null);
});

function request(answers) {
  return {
    clientRequestId: "00000000-0000-4000-8000-000000000001",
    noticeVersion: MEMBER_SAFETY_NOTICE_VERSION,
    answers,
  };
}

function baseline(overrides = {}) {
  return Object.assign({
    urgentWarningSigns: false,
    painOrStiffness: false,
    painSeverity: null,
    injuryOrInstability: false,
    recentSurgery: false,
    surgeryCleared: null,
    medicalOrExerciseRestriction: false,
    restrictionAllowsSafeExercise: null,
    neurologicalSymptoms: false,
    otherUnsafeConcern: false,
  }, overrides);
}

test("Migration 016 rollback CLI fails closed without explicit confirmation", () => {
  const environment = { ...process.env };
  delete environment.CONFIRM_GOALS_COACH_ADAPTIVE_SAFETY_ROLLBACK;
  delete environment.DATABASE_URL;
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "rollback_016.js")], { encoding: "utf8", env: environment });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Migration 016 rollback is unavailable for this database state/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /database_url|password|credential/i);
});

test("skipped adaptive branches are explicit null and classify safe", () => {
  const parsed = parseSafetyIntake(request(baseline()), MEMBER_SAFETY_NOTICE_VERSION);
  assert.equal(classifySafetyIntake(parsed.answers), "SCREEN_COMPLETE");
});

test("pain uses exactly one bounded rating follow-up and is never classified fully safe", () => {
  const mild = baseline({ painOrStiffness: true, painSeverity: 3 });
  assert.equal(classifySafetyIntake(parseSafetyIntake(request(mild), MEMBER_SAFETY_NOTICE_VERSION).answers), "MODIFICATION_REQUIRED");
  const severe = { ...mild, painSeverity: 8 };
  assert.equal(classifySafetyIntake(parseSafetyIntake(request(severe), MEMBER_SAFETY_NOTICE_VERSION).answers), "MEDICAL_REVIEW_REQUIRED");
  for (const invalid of [0, 11, 2.5, "3"]) {
    assert.throws(() => parseSafetyIntake(request({ ...mild, painSeverity: invalid }), MEMBER_SAFETY_NOTICE_VERSION), /Invalid safety intake answers/);
  }
});

test("conditional answers cannot be guessed or supplied when skipped", () => {
  assert.throws(() => classifySafetyIntake(parseSafetyIntake(request(baseline({ painSeverity: 2 })), MEMBER_SAFETY_NOTICE_VERSION).answers), /Invalid safety intake answers/);
  assert.throws(() => classifySafetyIntake(parseSafetyIntake(request(baseline({ surgeryCleared: true })), MEMBER_SAFETY_NOTICE_VERSION).answers), /Invalid safety intake answers/);
  assert.throws(() => classifySafetyIntake(parseSafetyIntake(request(baseline({ restrictionAllowsSafeExercise: true })), MEMBER_SAFETY_NOTICE_VERSION).answers), /Invalid safety intake answers/);
});

test("surgery and restriction branches fail closed", () => {
  assert.equal(classifySafetyIntake(parseSafetyIntake(request(baseline({ recentSurgery: true, surgeryCleared: false })), MEMBER_SAFETY_NOTICE_VERSION).answers), "MEDICAL_REVIEW_REQUIRED");
  assert.equal(classifySafetyIntake(parseSafetyIntake(request(baseline({ medicalOrExerciseRestriction: true, restrictionAllowsSafeExercise: false })), MEMBER_SAFETY_NOTICE_VERSION).answers), "MEDICAL_REVIEW_REQUIRED");
  assert.equal(classifySafetyIntake(parseSafetyIntake(request(baseline({ recentSurgery: true, surgeryCleared: true })), MEMBER_SAFETY_NOTICE_VERSION).answers), "MODIFICATION_REQUIRED");
  assert.equal(classifySafetyIntake(parseSafetyIntake(request(baseline({ medicalOrExerciseRestriction: true, restrictionAllowsSafeExercise: true })), MEMBER_SAFETY_NOTICE_VERSION).answers), "MODIFICATION_REQUIRED");
});

test("an urgent answer stops immediately without guessing later answers", () => {
  const urgent = Object.fromEntries(Object.keys(baseline()).map((field) => [field, null]));
  urgent.urgentWarningSigns = true;
  assert.equal(classifySafetyIntake(parseSafetyIntake(request(urgent), MEMBER_SAFETY_NOTICE_VERSION).answers), "URGENT_STOP");
  assert.throws(() => classifySafetyIntake(parseSafetyIntake(request({ ...urgent, painOrStiffness: false }), MEMBER_SAFETY_NOTICE_VERSION).answers), /Invalid safety intake answers/);
});
