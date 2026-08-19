"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { GUIDANCE, MEMBER_TODAY_FLAG, canonical, enabled, execute, hash, itemHash, parse } = require("../src/goals-coach/gymmaster-member-today");
const { createGymMasterMemberTodayStartup } = require("../src/goals-coach/gymmaster-member-today-startup");
const { createApplicationJsonParser } = require("../src/goals-coach/transcription-route");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");

test("member today flag is exact-string disabled and startup isolated", () => {
  assert.equal(MEMBER_TODAY_FLAG, "GOALS_COACH_MEMBER_TODAY_ENABLED");
  assert.equal(enabled("true"), true); for (const value of [undefined, "false", "TRUE", " true", true]) assert.equal(enabled(value), false);
  let calls = 0; const startup = createGymMasterMemberTodayStartup({ environment: { GOALS_COACH_MEMBER_TODAY_ENABLED: "false" }, db: { connect() { calls++; } }, fetchImpl() { calls++; } });
  assert.equal(startup.status, "disabled"); assert.equal(startup.router, null); assert.equal(calls, 0); assert.equal(startup.providerCallsPermitted, false);
  assert.match(fs.readFileSync(".env.example", "utf8"), /^GOALS_COACH_MEMBER_TODAY_ENABLED=false$/m);
});
test("strict closed-choice contracts reject free text", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(parse({ clientRequestId: id }), { clientRequestId: id });
  assert.throws(() => parse({ clientRequestId: id, text: "pain" }), (error) => error.code === "MEMBER_TODAY_INVALID");
});
test("canonical item hashes cover exactly exposed live fields and key ordering", () => {
  assert.deepEqual(canonical({ z: 1, a: { y: 2, x: 3 } }), { a: { x: 3, y: 2 }, z: 1 });
  const a = itemHash({ exercise_name: "Squat", prescription_json: { reps: 8, load: { unit: "kg", value: 20 } }, status: "active" });
  assert.equal(a, itemHash({ exercise_name: "Squat", prescription_json: { load: { value: 20, unit: "kg" }, reps: 8 }, status: "retired" }));
  assert.notEqual(a, itemHash({ exercise_name: "Squat", prescription_json: { reps: 9, load: { unit: "kg", value: 20 } } }));
  assert.notEqual(a, itemHash({ exercise_name: "Squat edited", prescription_json: { reps: 8, load: { unit: "kg", value: 20 } } }));
});
test("fixed safety wording and provider isolation", () => {
  assert.equal(GUIDANCE.MODIFICATION_REQUIRED, "Use comfortable, pain-free movement; reduce intensity or range, and stop if symptoms increase.");
  const source = fs.readFileSync("src/goals-coach/gymmaster-member-today.js", "utf8") + fs.readFileSync("src/goals-coach/gymmaster-member-today-startup.js", "utf8");
  assert.doesNotMatch(source, /require\(["'](?:openai|\.\/transcription-adapter|\.\/coaching-engine)["']\)/i);
});

test("modification-required safety state remains attached to a ready Today action", async () => {
  const input = { clientRequestId: "00000000-0000-4000-8000-000000000018" };
  const planVersion = new Date("2026-01-01T00:00:00.000Z");
  const item = { id: "20", exercise_name: "Supported squat", prescription_json: { reps: 6 } };
  const db = database(async (sql) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.includes("auth_mappings")) return { rows: [{ id: "2" }] };
    if (sql.includes("safety_intake_v2")) return { rows: [{ outcome: "MODIFICATION_REQUIRED" }] };
    if (sql.includes("member_today_attempts WHERE")) return { rows: [] };
    if (sql.includes("coaching_consents")) return { rows: [{}] };
    if (sql.includes("FROM coach_plans")) return { rows: [{ id: "10", created_at: planVersion }] };
    if (sql.includes("FROM coach_plan_exercises")) return { rows: [item] };
    if (sql.includes("INSERT INTO goals_coach_member_today_attempts")) return { rows: [{ state_code: "READY", client_request_id: input.clientRequestId, safety_outcome: "MODIFICATION_REQUIRED", plan_id: "10", plan_version: planVersion, plan_item_id: "20" }] };
    assert.fail(`unexpected query: ${sql}`);
  });
  const result = await execute(db, identity, authorization, input);
  assert.equal(result.body.state, "READY");
  assert.equal(result.body.safetyConstraint, GUIDANCE.MODIFICATION_REQUIRED);
  assert.equal(result.body.action.name, "Supported squat");
});
test("application parser and concealed errors accept canonical case and slash variants", () => {
  const parser = createApplicationJsonParser();
  for (const path of ["/goalscoach/member/today", "/goalscoach/member/today/", "/GOALSCOACH/MEMBER/TODAY"]) { let continued = false; parser({ method: "POST", originalUrl: path, headers: {} }, {}, () => { continued = true; }); assert.equal(continued, true); let result; const res = { setHeader() {}, status(status) { result = { status }; return this; }, json(body) { result.body = body; return this; } }; goalsCoachErrorHandler(Object.assign(new Error("secret"), { type: "entity.parse.failed" }), { path }, res, () => assert.fail()); assert.deepEqual(result, { status: 400, body: { error: "MEMBER_TODAY_INVALID" } }); }
});
test("source recomputes all bindings without advisory timestamps", () => {
  const source = fs.readFileSync("src/goals-coach/gymmaster-member-today.js", "utf8");
  assert.doesNotMatch(source, /updated_at/); assert.match(source, /for \(const option of row\.option_ids\)/); assert.match(source, /itemHash\(item\)/);
});
function database(query) { return { async connect() { return { query(sql, params) { if (String(sql).includes("set_config('lock_timeout'")) return Promise.resolve({ rows: [] }); return query(sql, params); }, release() {} }; } }; }
const identity = { authProvider: "gymmaster", authSubject: "gymmaster:10482" }, authorization = { active: true, memberId: "1", mappingId: "2" };
test("question replay recomputes every original association and conceals any hash mismatch", async () => {
  const input = { clientRequestId: "00000000-0000-4000-8000-000000000019" };
  const planVersion = new Date("2026-01-01T00:00:00.000Z");
  const offered = [{ id: "20", exercise_name: "Squat", prescription_json: { reps: 8 } }, { id: "21", exercise_name: "Row", prescription_json: { reps: 10 } }];
  for (const changed of [false, true]) {
    let bindingQueries = 0;
    const db = database(async (sql) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("auth_mappings")) return { rows: [{ id: "2" }] };
      if (sql.includes("safety_intake_v2")) return { rows: [{ outcome: "SCREEN_COMPLETE" }] };
      if (sql.includes("member_today_attempts WHERE")) return { rows: [{ state_code: "QUESTION_REQUIRED", client_request_id: input.clientRequestId, request_hash: hash(input), plan_id: "10", plan_version: planVersion, option_ids: ["option-1", "option-2"], option_item_ids: { "option-1": "20", "option-2": "21" }, option_item_hashes: { "option-1": itemHash(offered[0]), "option-2": itemHash(offered[1]) } }] };
      if (sql.includes("coaching_consents")) return { rows: [{}] };
      if (sql.includes("FROM coach_plans")) return { rows: [{ id: "10", created_at: planVersion }] };
      if (sql.includes("id=ANY")) { bindingQueries++; return { rows: changed ? [offered[0], { ...offered[1], prescription_json: { reps: 11 } }] : offered }; }
      assert.fail(`unexpected query: ${sql}`);
    });
    const result = await execute(db, identity, authorization, input);
    assert.equal(bindingQueries, 1);
    assert.deepEqual(result.body, changed ? { state: "UNAVAILABLE" } : { state: "QUESTION_REQUIRED", attemptId: input.clientRequestId, question: { id: "TODAY_PLAN_ITEM", prompt: "Which planned item are you ready to start?", options: [{ id: "option-1", label: "Squat" }, { id: "option-2", label: "Row" }] } });
  }
});

const planVersion = new Date("2026-01-01T00:00:00.000Z");
const eligibleItem = { id: "20", exercise_name: "Squat", prescription_json: { reps: 8 }, status: "active", intent_validation_status: "validated" };
function liveRows(sql, rows) {
  assert.match(sql, /status='active'/);
  assert.match(sql, /intent_validation_status='validated'/);
  return { rows: rows.filter((row) => row.status === "active" && row.intent_validation_status === "validated") };
}
for (const [label, mutate] of [
  ["retirement", (item) => { item.status = "retired"; }],
  ["validation revocation", (item) => { item.intent_validation_status = "rejected"; }],
]) {
  test(`READY replay conceals ${label} after the original attempt`, async () => {
    const input = { clientRequestId: "00000000-0000-4000-8000-000000000020" };
    const changed = { ...eligibleItem }; mutate(changed);
    const original = { state_code: "READY", client_request_id: input.clientRequestId, request_hash: hash(input), plan_id: "10", plan_version: planVersion, plan_item_id: "20", plan_item_hash: itemHash(eligibleItem) };
    const db = database(async (sql) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("auth_mappings")) return { rows: [{ id: "2" }] };
      if (sql.includes("safety_intake_v2")) return { rows: [{ outcome: "SCREEN_COMPLETE" }] };
      if (sql.includes("member_today_attempts WHERE")) return { rows: [original] };
      if (sql.includes("coaching_consents")) return { rows: [{}] };
      if (sql.includes("FROM coach_plans")) return { rows: [{ id: "10", created_at: planVersion }] };
      if (sql.includes("id=ANY")) return liveRows(sql, [changed]);
      assert.fail(`unexpected query: ${sql}`);
    });
    assert.deepEqual((await execute(db, identity, authorization, input)).body, { state: "UNAVAILABLE" });
  });

  test(`QUESTION_REQUIRED replay conceals ${label} after the original attempt`, async () => {
    const input = { clientRequestId: "00000000-0000-4000-8000-000000000021" };
    const second = { ...eligibleItem, id: "21", exercise_name: "Row" }, changed = { ...eligibleItem }; mutate(changed);
    const original = { state_code: "QUESTION_REQUIRED", client_request_id: input.clientRequestId, request_hash: hash(input), plan_id: "10", plan_version: planVersion, option_ids: ["option-1", "option-2"], option_item_ids: { "option-1": "20", "option-2": "21" }, option_item_hashes: { "option-1": itemHash(eligibleItem), "option-2": itemHash(second) } };
    const db = database(async (sql) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("auth_mappings")) return { rows: [{ id: "2" }] };
      if (sql.includes("safety_intake_v2")) return { rows: [{ outcome: "SCREEN_COMPLETE" }] };
      if (sql.includes("member_today_attempts WHERE")) return { rows: [original] };
      if (sql.includes("coaching_consents")) return { rows: [{}] };
      if (sql.includes("FROM coach_plans")) return { rows: [{ id: "10", created_at: planVersion }] };
      if (sql.includes("id=ANY")) return liveRows(sql, [changed, second]);
      assert.fail(`unexpected query: ${sql}`);
    });
    assert.deepEqual((await execute(db, identity, authorization, input)).body, { state: "UNAVAILABLE" });
  });

  test(`continuation conceals ${label} after the original attempt`, async () => {
    const input = { clientRequestId: "00000000-0000-4000-8000-000000000022", continuation: { attemptId: "00000000-0000-4000-8000-000000000021", optionId: "option-1" } };
    const second = { ...eligibleItem, id: "21", exercise_name: "Row" }, changed = { ...eligibleItem }; mutate(changed);
    const original = { id: "30", state_code: "QUESTION_REQUIRED", client_request_id: input.continuation.attemptId, plan_id: "10", plan_version: planVersion, option_ids: ["option-1", "option-2"], option_item_ids: { "option-1": "20", "option-2": "21" }, option_item_hashes: { "option-1": itemHash(eligibleItem), "option-2": itemHash(second) } };
    const db = database(async (sql, params) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("auth_mappings")) return { rows: [{ id: "2" }] };
      if (sql.includes("safety_intake_v2")) return { rows: [{ outcome: "SCREEN_COMPLETE" }] };
      if (sql.includes("member_today_attempts WHERE") && !sql.includes("state_code")) return { rows: [] };
      if (sql.includes("coaching_consents")) return { rows: [{}] };
      if (sql.includes("FROM coach_plans")) return { rows: [{ id: "10", created_at: planVersion }] };
      if (sql.includes("state_code='QUESTION_REQUIRED'")) return { rows: [original] };
      if (sql.includes("id=ANY")) return liveRows(sql, [changed, second]);
      if (sql.includes("INSERT INTO goals_coach_member_today_attempts")) return { rows: [{ state_code: params[5] }] };
      assert.fail(`unexpected query: ${sql}`);
    });
    assert.deepEqual((await execute(db, identity, authorization, input)).body, { state: "UNAVAILABLE" });
  });
}
