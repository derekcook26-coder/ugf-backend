"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createGymMasterMemberLoginStartup } = require("../src/goals-coach/gymmaster-member-login-startup");
const token = Buffer.alloc(32, 4).toString("base64url");
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function response() { return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; }, send() { return this; } }; }
function startup(query, options = {}) { const db = options.db || { query, async connect() { return { async query(sql, values) { if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [] }; return query(sql, values); }, release() {} }; } }; return createGymMasterMemberLoginStartup({ db, fetchImpl: async () => { throw new Error("must not call provider"); }, ...(options.sessionDatabaseMilliseconds ? { sessionDatabaseMilliseconds: options.sessionDatabaseMilliseconds } : {}), environment: { GOALS_COACH_MEMBER_LOGIN_ENABLED: "true", GOALS_COACH_MEMBER_TWO_HOUR_SESSION_ENABLED: "true", GOALS_COACH_MEMBER_LOGIN_ORIGIN: "https://coach.example", GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL: "https://ugf.gymmasteronline.com/portal/api/v1/login", GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL: "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members", GOALS_COACH_GYMMASTER_MEMBER_API_KEY: "test", GYMMASTER_API_KEY: "test", GYMMASTER_SITE: "test", GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: "x".repeat(32) } }); }
test("enabled logout is exact-origin, idempotent, current-token-only, and clears matching cookie", async () => {
  const hashes = []; const s = startup(async (_sql, values) => { hashes.push(values[0]); return { rows: hashes.length === 1 ? [{ id: 1 }] : [] }; }); assert.equal(typeof s.logoutHandler, "function");
  for (let i = 0; i < 2; i++) { const res = response(); await s.logoutHandler({ get: () => "https://coach.example", headers: { cookie: `gc_member_session=${token}` } }, res); assert.equal(res.statusCode, 204); assert.equal(res.headers["Set-Cookie"], "gc_member_session=; Path=/goalscoach; HttpOnly; Secure; SameSite=Strict; Max-Age=0"); }
  assert.equal(hashes.length, 2); const wrong = response(); await s.logoutHandler({ get: () => "https://evil.example", headers: {} }, wrong); assert.equal(wrong.statusCode, 403); assert.equal(wrong.headers["Set-Cookie"], undefined);
});
test("missing and malformed cookies are concealed and database unavailability fails closed", async () => {
  const s = startup(async () => { throw new Error("offline"); }); const missing = response(); await s.logoutHandler({ get: () => "https://coach.example", headers: {} }, missing); assert.equal(missing.statusCode, 204);
  const malformed = response(); await s.logoutHandler({ get: () => "https://coach.example", headers: { cookie: "gc_member_session=bad" } }, malformed); assert.equal(malformed.statusCode, 204);
  const failed = response(); await s.logoutHandler({ get: () => "https://coach.example", headers: { cookie: `gc_member_session=${token}` } }, failed); assert.equal(failed.statusCode, 401); assert.deepEqual(failed.body, { error: "MEMBER_AUTHENTICATION_REQUIRED" });
});
test("logout cancellation drains the bounded query without a cookie or late response", async () => {
  const update = deferred(); const s = startup(async () => update.promise); const req = new EventEmitter(); req.get = () => "https://coach.example"; req.headers = { cookie: `gc_member_session=${token}` }; req.complete = false; const res = new EventEmitter(); res.writableEnded = false; let headers = 0; let responses = 0; res.setHeader = () => { headers += 1; }; res.status = () => ({ json() { responses += 1; }, send() { responses += 1; } });
  const pending = s.logoutHandler(req, res); await new Promise((resolve) => setImmediate(resolve)); req.emit("aborted"); update.resolve({ rows: [{ id: 1 }] }); await pending; assert.equal(headers, 0); assert.equal(responses, 0);
});
test("logout checkout timeout drains a late reusable client and cannot succeed", async () => {
  const keepAlive = setTimeout(() => {}, 100); const checkout = deferred(); const releases = []; const db = { async query() { return { rows: [] }; }, connect: () => checkout.promise }; const s = startup(async () => ({ rows: [] }), { db, sessionDatabaseMilliseconds: 5 }); const res = response(); await s.logoutHandler({ get: () => "https://coach.example", headers: { cookie: `gc_member_session=${token}` } }, res); assert.equal(res.statusCode, 401); assert.equal(res.headers["Set-Cookie"], undefined);
  checkout.resolve({ query() { throw new Error("late client must stay unused"); }, release(error) { releases.push(error); } }); await new Promise((resolve) => setImmediate(resolve)); clearTimeout(keepAlive); assert.deepEqual(releases, [undefined]);
});
test("response finish during logout revocation rolls back without commit, cookie, or late response", async () => {
  const update = deferred(); const queries = []; const releases = [];
  const db = { async query() { return { rows: [] }; }, async connect() { return { query(sql, values) { queries.push(sql); if (sql.includes("SET revoked_at")) return update.promise; return Promise.resolve({ rows: [] }); }, release(error) { releases.push(error); } }; } };
  const s = startup(async () => ({ rows: [] }), { db }); const req = Object.assign(new EventEmitter(), { get: () => "https://coach.example", headers: { cookie: `gc_member_session=${token}` }, complete: false });
  const res = Object.assign(new EventEmitter(), { writableEnded: false }); let headers = 0; let responses = 0;
  res.setHeader = () => { headers += 1; }; res.status = () => ({ json() { responses += 1; }, send() { responses += 1; } });
  const pending = s.logoutHandler(req, res); while (!queries.some((sql) => sql.includes("SET revoked_at"))) await new Promise((resolve) => setImmediate(resolve));
  res.emit("finish"); update.resolve({ rows: [{ id: 1 }] }); await pending;
  assert.equal(queries.includes("COMMIT"), false); assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1); assert.deepEqual(releases, [undefined]);
  assert.equal(headers, 0); assert.equal(responses, 0); assert.equal(res.listenerCount("finish"), 0); assert.equal(req.listenerCount("aborted"), 0);
});
