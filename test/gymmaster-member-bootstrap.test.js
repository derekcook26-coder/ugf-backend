"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { createMemberBootstrap } = require("../src/goals-coach/member-bootstrap-contract");
const {
  MEMBER_BOOTSTRAP_FLAG,
  createBootstrapRequestHandler,
  createGymMasterMemberBootstrapRouter,
  memberBootstrapEnabled,
  runBoundedRead,
} = require("../src/goals-coach/gymmaster-member-bootstrap");
const { composeGymMasterMemberBootstrapRoute } = require("../src/goals-coach/gymmaster-member-bootstrap-route-composition");
const {
  createBoundedMemberAuthorization,
  createGymMasterMemberBootstrapStartup,
} = require("../src/goals-coach/gymmaster-member-bootstrap-startup");
const { SESSION_COOKIE_NAME, createGymMasterMemberSessionService } = require("../src/goals-coach/gymmaster-member-session");
const { jsonRequest, startApp } = require("./helpers/http-app");

const origin = "https://coach.example";
const secret = "synthetic-bootstrap-session-secret-123456";
const now = new Date("2026-08-21T12:00:00Z");
const passRateLimit = (_req, _res, next) => next();
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function environment(overrides = {}) {
  return { [MEMBER_BOOTSTRAP_FLAG]: "true", GOALS_COACH_MEMBER_LOGIN_ORIGIN: origin, GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: secret, ...overrides };
}
function cookie(subject = "gymmaster:10482") {
  const token = createGymMasterMemberSessionService({ secret, now: () => now }).issue({
    authProvider: "gymmaster", authSubject: subject, expiresInSeconds: 900,
  });
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}
function database(query, events = {}) {
  return {
    async connect() {
      if (events.connected) events.connected();
      return {
        async query(sql, values) {
          if (/^(?:BEGIN|COMMIT|ROLLBACK)|set_config\('/.test(String(sql))) {
            events.controlQueries?.push(String(sql));
            return { rows: [] };
          }
          return query(sql, values);
        },
        release(error) { events.releases?.push(error); },
      };
    },
  };
}
function options(overrides = {}) {
  return {
    environment: environment(),
    now: () => now,
    db: database(async () => ({ rows: [{ mapping_id: 9, member_id: 10482 }] })),
    rateLimit: passRateLimit,
    ...overrides,
  };
}
async function application(startupOptions) {
  const app = express();
  const startup = createGymMasterMemberBootstrapStartup(startupOptions);
  const composition = composeGymMasterMemberBootstrapRoute(app, startup);
  return { app, startup, composition };
}

test("bootstrap gate is exact and disabled/default startup is absent without calls", async (t) => {
  for (const value of [undefined, "", "TRUE", " true", "true ", true, 1]) assert.equal(memberBootstrapEnabled(value), false);
  assert.equal(memberBootstrapEnabled("true"), true);
  let calls = 0;
  const { app, startup, composition } = await application(options({ environment: {}, db: { connect: async () => { calls += 1; } } }));
  assert.equal(startup.status, "disabled");
  assert.deepEqual(composition, { mounted: false, path: null });
  const running = await startApp(app); t.after(() => running.close());
  assert.equal((await jsonRequest(running.url, "/goalscoach/member/bootstrap")).response.status, 404);
  assert.equal(calls, 0);
});

test("invalid prerequisites and mutating two-hour sessions fail closed at startup", () => {
  for (const override of [
    { GOALS_COACH_MEMBER_LOGIN_ORIGIN: "http://coach.example" },
    { GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: "short" },
    { GOALS_COACH_MEMBER_TWO_HOUR_SESSION_ENABLED: "true" },
  ]) assert.equal(createGymMasterMemberBootstrapStartup(options({ environment: environment(override) })).status, "not_ready");
  assert.equal(createGymMasterMemberBootstrapStartup({ environment: environment() }).status, "not_ready");
});

test("authenticated mapped member receives exact privacy-minimized bootstrap with exact-origin CORS", async (t) => {
  const queries = [];
  const controls = [];
  const releases = [];
  const { app, startup } = await application(options({ db: database(async (sql, values) => { queries.push({ sql, values }); return { rows: [{ mapping_id: 9, member_id: 10482 }] }; }, { controlQueries: controls, releases }) }));
  assert.equal(startup.status, "ready_for_separate_route_composition");
  assert.equal(startup.readOnly, true);
  assert.equal(startup.externalCallsPermitted, false);
  const running = await startApp(app); t.after(() => running.close());
  const result = await jsonRequest(running.url, "/goalscoach/member/bootstrap", { headers: { Origin: origin, Cookie: cookie() } });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, startup.bootstrap);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("access-control-allow-origin"), origin);
  assert.equal(result.response.headers.get("access-control-allow-credentials"), "true");
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /^SELECT/);
  assert.deepEqual(queries[0].values, ["gymmaster", "gymmaster:10482"]);
  assert.equal(controls[0], "BEGIN READ ONLY");
  assert.equal(controls.at(-1), "COMMIT");
  assert.deepEqual(releases, [undefined]);
  assert.deepEqual(startup.bootstrap.capabilities.conversation, {
    status: "unavailable", reason: "production_route_unavailable",
  });
  assert.equal(JSON.stringify(result.body).includes("10482"), false);
});

test("credentialed preflight permits only GET from the exact origin", async (t) => {
  const { app } = await application(options());
  const running = await startApp(app); t.after(() => running.close());
  const response = await fetch(`${running.url}/goalscoach/member/bootstrap`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.equal(response.headers.get("access-control-allow-methods"), "GET,OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"), null);
});

test("bootstrap exposes no mutation route and production startup imports no compatibility fixture", async (t) => {
  let databaseCalls = 0;
  const { app } = await application(options({
    db: database(async () => { databaseCalls += 1; return { rows: [] }; }),
  }));
  const running = await startApp(app); t.after(() => running.close());
  const response = await jsonRequest(running.url, "/goalscoach/member/bootstrap", {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie() },
    body: { capability: "ready" },
  });
  assert.equal(response.response.status, 404);
  assert.equal(databaseCalls, 0);
  const productionPaths = [
    path.join(__dirname, "../server.js"),
    ...fs.readdirSync(path.join(__dirname, "../src/goals-coach"))
      .filter((name) => name.includes("member-bootstrap") && name.endsWith(".js"))
      .map((name) => path.join(__dirname, "../src/goals-coach", name)),
  ];
  for (const productionPath of productionPaths) {
    const source = fs.readFileSync(productionPath, "utf8");
    assert.equal(source.includes("test/fixtures"), false);
    assert.equal(source.includes("member-bootstrap-v1.json"), false);
  }
  const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const bootstrapComposition = serverSource.slice(
    serverSource.indexOf("createGymMasterMemberBootstrapStartup({"),
    serverSource.indexOf("composeGymMasterMemberBootstrapRoute(app, memberBootstrapStartup)")
  );
  assert.equal(bootstrapComposition.includes("phase1bStartup"), false);
  assert.match(bootstrapComposition, /conversationStartup:\s*memberConversationTurnStartup/);
  const conversationComposition = serverSource.slice(
    serverSource.indexOf("createGymMasterMemberConversationTurnStartup({"),
    serverSource.indexOf("composeGymMasterMemberConversationTurnRoute(app, memberConversationTurnStartup)")
  );
  assert.match(conversationComposition, /provider:\s*null/);
  assert.equal(conversationComposition.includes("phase1bStartup"), false);
});

test("wrong origin and invalid or cross-member-concealed sessions never reach authorization", async (t) => {
  let calls = 0;
  const { app } = await application(options({ db: database(async () => { calls += 1; return { rows: [] }; }) }));
  const running = await startApp(app); t.after(() => running.close());
  const cases = [
    { Origin: "https://wrong.example", Cookie: cookie() },
    { Origin: origin },
    { Origin: origin, Cookie: `${SESSION_COOKIE_NAME}=forged` },
    { Origin: origin, Cookie: cookie("gymmaster:999") },
  ];
  const statuses = [];
  for (const headers of cases) statuses.push((await jsonRequest(running.url, "/goalscoach/member/bootstrap", { headers })).response.status);
  assert.deepEqual(statuses, [403, 401, 401, 401]);
  assert.equal(calls, 1);
});

test("authorization failure and deadline are minimized and late results cannot write", async (t) => {
  for (const authorizeIdentity of [
    async () => { throw new Error("synthetic database detail"); },
    async () => new Promise(() => {}),
  ]) {
    const app = express();
    app.use("/goalscoach/member/bootstrap", createGymMasterMemberBootstrapRouter({
      authenticateSession(req, _res, next) { req.alphaMemberIdentity = { authProvider: "gymmaster", authSubject: "gymmaster:10482" }; next(); },
      authorizeIdentity,
      origin,
      bootstrap: createMemberBootstrap(),
      rateLimit: passRateLimit,
      timeoutMilliseconds: 5,
    }));
    const running = await startApp(app); t.after(() => running.close());
    const result = await jsonRequest(running.url, "/goalscoach/member/bootstrap", { headers: { Origin: origin } });
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.body, { error: "MEMBER_BOOTSTRAP_UNAVAILABLE" });
  }
});

test("bounded authorization drains a late checkout without issuing a query", async (t) => {
  const checkout = deferred();
  const releases = [];
  const { app } = await application(options({
    db: { connect: () => checkout.promise },
    timeoutMilliseconds: 5,
  }));
  const running = await startApp(app); t.after(() => running.close());
  const result = await jsonRequest(running.url, "/goalscoach/member/bootstrap", {
    headers: { Origin: origin, Cookie: cookie() },
  });
  assert.equal(result.response.status, 503);
  checkout.resolve({
    query() { throw new Error("late client must not be queried"); },
    release(error) { releases.push(error); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(releases, [undefined]);
});

test("an unbounded pre-timeout query is discarded when the request deadline wins", async (t) => {
  const begin = deferred();
  const releases = [];
  const { app } = await application(options({
    db: {
      async connect() {
        return {
          query(sql) {
            if (sql === "BEGIN READ ONLY") return begin.promise;
            throw new Error("must not continue after an uncertain BEGIN");
          },
          release(error) { releases.push(error); },
        };
      },
    },
    timeoutMilliseconds: 5,
  }));
  const running = await startApp(app); t.after(() => running.close());
  const result = await jsonRequest(running.url, "/goalscoach/member/bootstrap", {
    headers: { Origin: origin, Cookie: cookie() },
  });
  assert.equal(result.response.status, 503);
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof Error);
  begin.resolve({ rows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
});

test("a late server-bounded authorization result cannot respond and releases safely", async (t) => {
  const select = deferred();
  const releases = [];
  const queries = [];
  const { app } = await application(options({
    db: {
      async connect() {
        return {
          query(sql) {
            queries.push(String(sql));
            if (String(sql).startsWith("SELECT mapping.id")) return select.promise;
            return Promise.resolve({ rows: [] });
          },
          release(error) { releases.push(error); },
        };
      },
    },
    timeoutMilliseconds: 5,
  }));
  const running = await startApp(app); t.after(() => running.close());
  const result = await jsonRequest(running.url, "/goalscoach/member/bootstrap", {
    headers: { Origin: origin, Cookie: cookie() },
  });
  assert.equal(result.response.status, 503);
  assert.deepEqual(result.body, { error: "MEMBER_BOOTSTRAP_UNAVAILABLE" });
  select.resolve({ rows: [{ mapping_id: 9, member_id: 10482 }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queries.includes("ROLLBACK"), true);
  assert.deepEqual(releases, [undefined]);
});

test("bounded read cancels response authority on abort", async () => {
  const { EventEmitter } = require("node:events");
  const req = Object.assign(new EventEmitter(), { complete: false, aborted: false, destroyed: false });
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
  let resolveOperation;
  let context;
  const pending = runBoundedRead((value) => {
    context = value;
    return new Promise((resolve) => { resolveOperation = resolve; });
  }, req, res, 50);
  await new Promise((resolve) => setImmediate(resolve));
  req.aborted = true;
  req.emit("aborted");
  resolveOperation({ active: true, mappingId: "9", memberId: "10482" });
  await assert.rejects(pending, { code: "request_aborted" });
  assert.equal(context.terminalState.isTerminal(), true);
  assert.equal(context.terminalState.responseAllowed(), false);
});

test("request abort discards an active pre-timeout database operation", async () => {
  const { EventEmitter } = require("node:events");
  const begin = deferred();
  const releases = [];
  const authorization = createBoundedMemberAuthorization({
    pool: {
      async connect() {
        return {
          query(sql) {
            if (sql === "BEGIN READ ONLY") return begin.promise;
            throw new Error("aborted authorization must not continue");
          },
          release(error) { releases.push(error); },
        };
      },
    },
    timeoutMilliseconds: 500,
  });
  const req = Object.assign(new EventEmitter(), { complete: false, aborted: false, destroyed: false });
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
  const pending = runBoundedRead(
    (context) => authorization.authorizeIdentity({
      authProvider: "gymmaster", authSubject: "gymmaster:10482",
    }, context),
    req,
    res,
    500
  );
  await new Promise((resolve) => setImmediate(resolve));
  req.aborted = true;
  req.emit("aborted");
  await assert.rejects(pending, { code: "request_aborted" });
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof Error);
  begin.resolve({ rows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
});

test("integrated abort handling drains database work without attempting a response", async () => {
  const { EventEmitter } = require("node:events");
  const begin = deferred();
  const releases = [];
  const authorization = createBoundedMemberAuthorization({
    pool: {
      async connect() {
        return {
          query(sql) {
            if (sql === "BEGIN READ ONLY") return begin.promise;
            throw new Error("aborted handler must not continue");
          },
          release(error) { releases.push(error); },
        };
      },
    },
    timeoutMilliseconds: 500,
  });
  const req = Object.assign(new EventEmitter(), {
    query: {},
    alphaMemberIdentity: { authProvider: "gymmaster", authSubject: "gymmaster:10482" },
    complete: false,
    aborted: false,
    destroyed: false,
  });
  const attempts = [];
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    status(code) { attempts.push(["status", code]); return this; },
    json(value) { attempts.push(["json", value]); this.writableEnded = true; return this; },
  });
  const handler = createBootstrapRequestHandler({
    authorizeIdentity: authorization.authorizeIdentity,
    bootstrap: createMemberBootstrap(),
    timeoutMilliseconds: 500,
  });
  const pending = handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  req.aborted = true;
  req.emit("aborted");
  assert.equal(await pending, undefined);
  assert.deepEqual(attempts, []);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(req.listenerCount("close"), 0);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof Error);
  begin.resolve({ rows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts, []);
  assert.equal(releases.length, 1);
});

test("integrated live-request deadline emits exactly one concealed 503", async () => {
  const { EventEmitter } = require("node:events");
  const req = Object.assign(new EventEmitter(), {
    query: {},
    alphaMemberIdentity: { authProvider: "gymmaster", authSubject: "gymmaster:10482" },
    complete: false,
    aborted: false,
    destroyed: false,
  });
  const attempts = [];
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    status(code) { attempts.push(["status", code]); return this; },
    json(value) { attempts.push(["json", value]); this.writableEnded = true; return this; },
  });
  const handler = createBootstrapRequestHandler({
    authorizeIdentity: async () => new Promise(() => {}),
    bootstrap: createMemberBootstrap(),
    timeoutMilliseconds: 5,
  });
  const keepAlive = setTimeout(() => {}, 100);
  try { await handler(req, res); }
  finally { clearTimeout(keepAlive); }
  assert.deepEqual(attempts, [
    ["status", 503],
    ["json", { error: "MEMBER_BOOTSTRAP_UNAVAILABLE" }],
  ]);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(req.listenerCount("close"), 0);
  assert.equal(res.listenerCount("close"), 0);
});
