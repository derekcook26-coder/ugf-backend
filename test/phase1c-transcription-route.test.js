const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");
const express = require("express");
const { runMigration } = require("../migrate_005");
const { createAlphaMemberAuthorization } = require("../src/auth/alpha-member-authorization");
const { createAlphaOriginGuard } = require("../src/auth/clerk-alpha-member-auth");
const { createAlphaFeatureGate } = require("../src/goals-coach/alpha-config");
const { createAlphaGoalsCoachRouter } = require("../src/goals-coach/alpha-routes");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const { createTranscriptionService } = require("../src/goals-coach/transcription-service");
const {
  classifyTranscriptionRouteRequest,
  createApplicationJsonParser,
  isTranscriptionRouteRequest,
} = require("../src/goals-coach/transcription-route");
const {
  createDisposableDatabase,
  seedAlphaMapping,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");
const {
  createDeterministicTranscriptionAdapter,
} = require("./helpers/deterministic-transcription-adapter");
const { startApp } = require("./helpers/http-app");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const ORIGIN = "https://alpha.example.test";
const MIME = "audio/webm;codecs=opus";
const REQUEST_ID = "56b95d7d-f9d4-4d99-8277-dc8a67a9365a";
const TRANSCRIPTION_ID = "431eb4fb-4ea4-4d7a-8768-3525eb917d24";
const BINDING_KEY = "synthetic-route-binding-key";
const readyStartup = Object.freeze({ status: "ready" });
const applicationConfiguration = Object.freeze({
  valid: true,
  consentVersion: "GC-ALPHA-CONSENT-1.0",
  alphaEnvironment: "test",
});
const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "embedded PostgreSQL refuses to run as root; run this test as UID/GID 65534"
  : false;

function resultFor(input, overrides = {}) {
  return {
    transcriptionId: TRANSCRIPTION_ID,
    requestId: input.requestId,
    attemptNumber: 1,
    transcript: "Normalized route transcript",
    durationMs: 1234,
    expiresAt: "2026-07-19T12:10:00.000Z",
    ...overrides,
  };
}

function useApplicationJsonParser(app) {
  app.use(createApplicationJsonParser());
}

async function parsedResponse(response) {
  const text = await response.text();
  if (!text) return { response, body: null };
  try {
    return { response, body: JSON.parse(text) };
  } catch (_) {
    return { response, body: text };
  }
}

async function audioRequest(running, path, options = {}) {
  const headers = { Origin: ORIGIN, ...(options.headers || {}) };
  if (options.mimeType !== null && !Object.hasOwn(headers, "Content-Type")) {
    headers["Content-Type"] = options.mimeType || MIME;
  }
  return parsedResponse(await fetch(`${running.url}${path}`, {
    method: "POST",
    headers,
    body: options.body === undefined ? Buffer.from("audio") : options.body,
    ...(options.duplex ? { duplex: options.duplex } : {}),
  }));
}

async function rawTcpRequest(running, path, headerLines, body = Buffer.from("audio")) {
  const url = new URL(running.url);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    const chunks = [];
    socket.setTimeout(3000, () => socket.destroy(new Error("Raw HTTP probe timed out")));
    socket.on("error", reject);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const response = Buffer.concat(chunks);
      const separator = response.indexOf("\r\n\r\n");
      assert.notEqual(separator, -1);
      const head = response.subarray(0, separator).toString("latin1");
      const statusMatch = /^HTTP\/1\.1 (\d{3})/m.exec(head);
      assert.ok(statusMatch);
      const responseBody = response.subarray(separator + 4).toString("utf8");
      resolve({
        status: Number(statusMatch[1]),
        body: responseBody ? JSON.parse(responseBody) : null,
      });
    });
    socket.on("connect", () => {
      const requestHead = [
        `POST ${path} HTTP/1.1`,
        `Host: ${url.host}`,
        `Origin: ${ORIGIN}`,
        ...headerLines,
        `Content-Length: ${body.length}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n");
      socket.end(Buffer.concat([Buffer.from(requestHead, "latin1"), body]));
    });
  });
}

async function createMockApp(options = {}) {
  const calls = [];
  const stages = [];
  let adapterCalls = 0;
  const db = options.db || {
    async query(sql, parameters) {
      stages.push("plan-query");
      if (
        sql.includes("FROM coaching_conversations")
        && String(parameters[0]) === "11"
        && String(parameters[1]) === "7"
      ) return { rows: [{ plan_id: "17" }] };
      return { rows: [] };
    },
  };
  const transcriptionService = options.hasService === false
    ? null
    : options.transcriptionService || {
      async transcribe(input) {
        stages.push("service");
        calls.push(input);
        adapterCalls += 1;
        return resultFor(input);
      },
    };
  const app = express();
  useApplicationJsonParser(app);
  app.use("/alpha/goals-coach", createAlphaOriginGuard({ authorizedParties: [ORIGIN] }));
  app.use(
    "/alpha/goals-coach",
    createAlphaFeatureGate({ enabled: options.enabled !== false }),
    (req, res, next) => {
      stages.push("authentication");
      if (options.authenticated === false) {
        return res.status(401).json({ error: "ALPHA_AUTHENTICATION_REQUIRED" });
      }
      req.alphaMemberIdentity = {
        authProvider: "clerk",
        authSubject: "user_authoritative",
        sessionId: "sess_authoritative",
      };
      return next();
    },
    (req, res, next) => {
      stages.push("active-member");
      if (options.activeMember === false) {
        return res.status(403).json({ error: "ALPHA_ACCESS_FORBIDDEN" });
      }
      req.alphaMember = {
        mappingId: "5",
        memberId: "7",
        authProvider: "clerk",
        authSubject: "user_authoritative",
      };
      return next();
    },
    createAlphaGoalsCoachRouter({
      db,
      service: {},
      applicationConfiguration,
      requireCurrentConsent(req, res, next) {
        stages.push("current-consent");
        if (options.currentConsent === false) {
          return res.status(403).json({ error: "ALPHA_CONSENT_REQUIRED" });
        }
        return next();
      },
      phase1cStartup: options.phase1cStartup || readyStartup,
      transcriptionService,
    })
  );
  app.use(goalsCoachErrorHandler);
  const running = await startApp(app);
  return { running, calls, stages, getAdapterCallCount: () => adapterCalls };
}

function routePath(requestId = REQUEST_ID, suffix = "") {
  return `/alpha/goals-coach/conversations/11/transcriptions/${requestId}${suffix}`;
}

test("route readiness is after alpha authorization and consent but before raw parsing", async (t) => {
  for (const configuration of [
    { phase1cStartup: { status: "disabled", reason: "voice_disabled" } },
    { phase1cStartup: { status: "unavailable", reason: "consent_update_required" } },
    { phase1cStartup: readyStartup, hasService: false },
  ]) {
    const harness = await createMockApp(configuration);
    t.after(() => harness.running.close());
    const response = await audioRequest(harness.running, routePath(), {
      body: Buffer.alloc(1048577),
    });
    assert.equal(response.response.status, 503);
    assert.deepEqual(response.body, {
      error: "TRANSCRIPTION_NOT_AVAILABLE",
      message: "Transcription is not available.",
    });
    assert.deepEqual(harness.stages, ["authentication", "active-member", "current-consent"]);
    assert.equal(harness.calls.length, 0);
  }

  for (const blocked of [
    { enabled: false, status: 404, error: "ALPHA_NOT_AVAILABLE" },
    { authenticated: false, status: 401, error: "ALPHA_AUTHENTICATION_REQUIRED" },
    { activeMember: false, status: 403, error: "ALPHA_ACCESS_FORBIDDEN" },
    { currentConsent: false, status: 403, error: "ALPHA_CONSENT_REQUIRED" },
  ]) {
    const harness = await createMockApp(blocked);
    t.after(() => harness.running.close());
    const response = await audioRequest(harness.running, routePath());
    assert.equal(response.response.status, blocked.status);
    assert.equal(response.body.error, blocked.error);
    assert.equal(harness.calls.length, 0);
  }

  const origin = await createMockApp();
  t.after(() => origin.running.close());
  const denied = await parsedResponse(await fetch(`${origin.running.url}${routePath()}`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": MIME },
    body: Buffer.from("audio"),
  }));
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error, "ALPHA_ORIGIN_NOT_ALLOWED");
  assert.equal(origin.calls.length, 0);
});

test("shared raw-path classifier and composed application reject every alternate functional path", async (t) => {
  const exactFunctional = routePath();
  const exactFallback = "/alpha/goals-coach/conversations/11/transcriptions";
  assert.equal(isTranscriptionRouteRequest({ method: "POST", originalUrl: exactFunctional }), true);
  assert.equal(isTranscriptionRouteRequest({ method: "POST", originalUrl: `${exactFunctional}?retry=true` }), true);
  assert.equal(isTranscriptionRouteRequest({ method: "POST", originalUrl: exactFallback }), true);
  assert.equal(
    classifyTranscriptionRouteRequest({ method: "POST", originalUrl: exactFunctional }).type,
    "functional"
  );
  assert.equal(
    classifyTranscriptionRouteRequest({ method: "POST", originalUrl: exactFallback }).type,
    "missing_request_id"
  );
  assert.equal(isTranscriptionRouteRequest({ method: "GET", originalUrl: exactFunctional }), false);

  const alternatePaths = [
    `/Alpha/goals-coach/conversations/11/transcriptions/${REQUEST_ID}`,
    `/alpha/Goals-Coach/conversations/11/transcriptions/${REQUEST_ID}`,
    `/alpha/goals-coach/Conversations/11/transcriptions/${REQUEST_ID}`,
    `/alpha/goals-coach/conversations/11/Transcriptions/${REQUEST_ID}`,
    `${exactFunctional}/`,
    `${exactFallback}/`,
    "/alpha/goals-coach/conversations/11/Transcriptions",
    `/alpha/goals-coach/conversations//11/transcriptions/${REQUEST_ID}`,
    `/alpha/goals-coach/conversations/./transcriptions/${REQUEST_ID}`,
    `/alpha/goals-coach/conversations/../transcriptions/${REQUEST_ID}`,
    `/alpha/goals-coach/conversations/11/transcriptions/${REQUEST_ID}%2Fextra`,
    `/alpha/goals-coach/conversations/11/transcriptions/${REQUEST_ID}/extra`,
    `/prefix/alpha/goals-coach/conversations/11/transcriptions/${REQUEST_ID}`,
    `/alpha/goals-coach/conversations-prefix/11/transcriptions/${REQUEST_ID}`,
    `/alpha/goals-coach/conversations/11/transcriptions-suffix/${REQUEST_ID}`,
    `/alpha/goals-coach/conversations/11/transcript%69ons/${REQUEST_ID}`,
    `/alpha/goals-coach/conversations/11/transcriptіons/${REQUEST_ID}`,
  ];
  for (const path of alternatePaths) {
    assert.equal(isTranscriptionRouteRequest({ method: "POST", originalUrl: path }), false, path);
  }

  const harness = await createMockApp();
  t.after(() => harness.running.close());
  for (const path of alternatePaths) {
    const response = await audioRequest(harness.running, path);
    assert.notEqual(response.response.status, 201, path);
  }
  assert.equal(harness.stages.includes("plan-query"), false);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.getAdapterCallCount(), 0);

  const fallback = await audioRequest(harness.running, exactFallback);
  assert.equal(fallback.response.status, 400);
  assert.deepEqual(fallback.body, {
    error: "TRANSCRIPTION_REQUEST_ID_INVALID",
    message: "Invalid transcription request ID.",
  });
  assert.equal(harness.stages.includes("plan-query"), false);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.getAdapterCallCount(), 0);

  const jsonApp = express();
  useApplicationJsonParser(jsonApp);
  jsonApp.post("/unrelated-json", (req, res) => res.status(200).json(req.body));
  const jsonRunning = await startApp(jsonApp);
  t.after(() => jsonRunning.close());
  const jsonResponse = await parsedResponse(await fetch(`${jsonRunning.url}/unrelated-json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ retained: true }),
  }));
  assert.equal(jsonResponse.response.status, 200);
  assert.deepEqual(jsonResponse.body, { retained: true });
});

test("canonical path and exact retry query are enforced before service invocation", async (t) => {
  const harness = await createMockApp();
  t.after(() => harness.running.close());
  for (const suffix of ["", "?retry=true"]) {
    const response = await audioRequest(harness.running, routePath(REQUEST_ID, suffix));
    assert.equal(response.response.status, 201);
  }
  assert.equal(harness.calls[0].retry, false);
  assert.equal(harness.calls[1].retry, true);

  const invalidPaths = [
    routePath(REQUEST_ID.toUpperCase()),
    routePath("not-a-uuid"),
    routePath("%20" + REQUEST_ID),
    routePath(`%7B${REQUEST_ID}%7D`),
    "/alpha/goals-coach/conversations/11/transcriptions",
    `/alpha/goals-coach/conversations/01/transcriptions/${REQUEST_ID}`,
    `/alpha/goals-coach/conversations/0/transcriptions/${REQUEST_ID}`,
  ];
  for (const path of invalidPaths) {
    const response = await audioRequest(harness.running, path);
    assert.equal(response.response.status, 400, path);
  }
  for (const query of [
    "?retry=false", "?retry=", "?retry=true&retry=true", "?retry=True",
    "?other=true", "?retry=true&other=true",
  ]) {
    const response = await audioRequest(harness.running, routePath(REQUEST_ID, query));
    assert.equal(response.response.status, 400, query);
    assert.deepEqual(response.body, {
      error: "TRANSCRIPTION_RETRY_INVALID",
      message: "Invalid transcription retry request.",
    });
  }
  assert.equal(harness.calls.length, 2);
});

test("conversation IDs are bounded to canonical safe-integer decimal strings before database access", async (t) => {
  const harness = await createMockApp();
  t.after(() => harness.running.close());
  for (const conversationId of ["1", "9007199254740991"]) {
    const response = await audioRequest(
      harness.running,
      `/alpha/goals-coach/conversations/${conversationId}/transcriptions/${crypto.randomUUID()}`
    );
    assert.equal(response.response.status, 404, conversationId);
    assert.equal(response.body.error, "TRANSCRIPTION_NOT_FOUND");
  }
  assert.equal(harness.stages.filter((stage) => stage === "plan-query").length, 2);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.getAdapterCallCount(), 0);

  const invalidIds = [
    "0",
    "-1",
    "+1",
    "01",
    "1.0",
    "1e3",
    "%201",
    "1%20",
    "9007199254740992",
    "9223372036854775807",
    "9223372036854775808",
    "9".repeat(500),
    "9".repeat(5000),
  ];
  for (const conversationId of invalidIds) {
    const response = await audioRequest(
      harness.running,
      `/alpha/goals-coach/conversations/${conversationId}/transcriptions/${crypto.randomUUID()}`
    );
    assert.equal(response.response.status, 400, conversationId.slice(0, 80));
    assert.deepEqual(response.body, {
      error: "TRANSCRIPTION_CONVERSATION_ID_INVALID",
      message: "Invalid conversation ID.",
    });
  }
  assert.equal(harness.stages.filter((stage) => stage === "plan-query").length, 2);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.getAdapterCallCount(), 0);
});

test("only exact approved MIME types and identity encoding are accepted", async (t) => {
  const harness = await createMockApp();
  t.after(() => harness.running.close());
  for (const mimeType of [MIME, "audio/mp4;codecs=mp4a.40.2", "audio/mp4"]) {
    const response = await audioRequest(harness.running, routePath(crypto.randomUUID()), { mimeType });
    assert.equal(response.response.status, 201, mimeType);
  }
  const rejected = [
    null, "application/json", "application/octet-stream", "multipart/form-data",
    "audio/wav", `${MIME};charset=utf-8`, "audio/webm; codecs=opus",
    "audio/webm;codecs=OPUS", "audio/*", `${MIME}, ${MIME}`,
  ];
  for (const mimeType of rejected) {
    const response = await audioRequest(harness.running, routePath(crypto.randomUUID()), { mimeType });
    assert.equal(response.response.status, 415, String(mimeType));
  }
  for (const encoding of ["gzip", "br", "deflate", "Identity", "compress", "identity, identity"]) {
    const response = await audioRequest(harness.running, routePath(crypto.randomUUID()), {
      headers: { "Content-Encoding": encoding },
    });
    assert.equal(response.response.status, 415, encoding);
  }
  const identity = await audioRequest(harness.running, routePath(crypto.randomUUID()), {
    headers: { "Content-Encoding": "identity" },
  });
  assert.equal(identity.response.status, 201);
});

test("raw TCP requests reject duplicate or ambiguous Content-Type and Content-Encoding lines", async (t) => {
  const harness = await createMockApp();
  t.after(() => harness.running.close());
  const cases = [
    {
      name: "identical duplicate Content-Type",
      headers: [`Content-Type: ${MIME}`, `Content-Type: ${MIME}`],
      error: "TRANSCRIPTION_MIME_UNSUPPORTED",
      message: "Audio type is unsupported.",
    },
    {
      name: "conflicting duplicate Content-Type",
      headers: [`Content-Type: ${MIME}`, "Content-Type: audio/mp4"],
      error: "TRANSCRIPTION_MIME_UNSUPPORTED",
      message: "Audio type is unsupported.",
    },
    {
      name: "case-varied duplicate Content-Type",
      headers: [`Content-Type: ${MIME}`, `content-type: ${MIME}`],
      error: "TRANSCRIPTION_MIME_UNSUPPORTED",
      message: "Audio type is unsupported.",
    },
    {
      name: "duplicate identity Content-Encoding",
      headers: [`Content-Type: ${MIME}`, "Content-Encoding: identity", "content-encoding: identity"],
      error: "TRANSCRIPTION_ENCODING_UNSUPPORTED",
      message: "Content encoding is unsupported.",
    },
    {
      name: "conflicting Content-Encoding",
      headers: [`Content-Type: ${MIME}`, "Content-Encoding: identity", "Content-Encoding: gzip"],
      error: "TRANSCRIPTION_ENCODING_UNSUPPORTED",
      message: "Content encoding is unsupported.",
    },
  ];
  for (const probe of cases) {
    const response = await rawTcpRequest(harness.running, routePath(), probe.headers);
    assert.equal(response.status, 415, probe.name);
    assert.deepEqual(response.body, { error: probe.error, message: probe.message });
  }
  assert.equal(harness.stages.includes("plan-query"), false);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.getAdapterCallCount(), 0);
});

test("raw body accepts one byte and exactly one MiB while bounding empty, oversized, and chunked bodies", async (t) => {
  const harness = await createMockApp();
  t.after(() => harness.running.close());
  assert.equal((await audioRequest(harness.running, routePath(), { body: Buffer.alloc(1) })).response.status, 201);
  assert.equal((await audioRequest(harness.running, routePath(crypto.randomUUID()), {
    body: Buffer.alloc(1048576),
  })).response.status, 201);
  const beforeOversize = harness.calls.length;
  const oversized = await audioRequest(harness.running, routePath(crypto.randomUUID()), {
    body: Buffer.alloc(1048577),
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(harness.calls.length, beforeOversize);
  const empty = await audioRequest(harness.running, routePath(crypto.randomUUID()), { body: Buffer.alloc(0) });
  assert.equal(empty.response.status, 422);

  const chunked = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("chunk-one"));
      controller.enqueue(Buffer.from("chunk-two"));
      controller.close();
    },
  });
  const chunkedResponse = await audioRequest(harness.running, routePath(crypto.randomUUID()), {
    body: chunked,
    duplex: "half",
  });
  assert.equal(chunkedResponse.response.status, 201);
});

test("route resolves plan authoritatively and passes only server-authored scope", async (t) => {
  const harness = await createMockApp();
  t.after(() => harness.running.close());
  const response = await audioRequest(
    harness.running,
    `${routePath()}?memberId=999&mappingId=999&planId=999&sessionId=browser&provider=x`
  );
  assert.equal(response.response.status, 400);
  assert.equal(harness.calls.length, 0);

  const accepted = await audioRequest(harness.running, routePath());
  assert.equal(accepted.response.status, 201);
  const input = harness.calls[0];
  assert.deepEqual(input.member, {
    mappingId: "5",
    memberId: "7",
    authProvider: "clerk",
    authSubject: "user_authoritative",
  });
  assert.equal(input.authenticatedSessionId, "sess_authoritative");
  assert.equal(input.conversationId, "11");
  assert.equal(input.planId, "17");
  assert.equal(input.requestId, REQUEST_ID);
  assert.equal(input.mimeType, MIME);
  assert.equal(input.retry, false);
  assert.ok(Buffer.isBuffer(input.audio));
  assert.equal(Object.hasOwn(input, "provider"), false);
  assert.equal(Object.hasOwn(input, "model"), false);

  const concealed = await createMockApp({ db: { async query() { return { rows: [] }; } } });
  t.after(() => concealed.running.close());
  const missing = await audioRequest(concealed.running, routePath());
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error, "TRANSCRIPTION_NOT_FOUND");
  assert.equal(concealed.calls.length, 0);
});

test("invalid or request-mismatched service results fail closed with one minimized response", async (t) => {
  let currentResult = resultFor({ requestId: REQUEST_ID });
  const protectedText = "invalid transcript provider payload sess_secret SELECT protected";
  const harness = await createMockApp({
    transcriptionService: {
      async transcribe(input) {
        return typeof currentResult === "function" ? currentResult(input) : currentResult;
      },
    },
  });
  t.after(() => harness.running.close());
  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(" "));
  t.after(() => { console.error = originalError; });

  async function assertInvalid(name, value) {
    currentResult = value;
    const response = await audioRequest(harness.running, routePath());
    assert.equal(response.response.status, 503, name);
    assert.deepEqual(response.body, {
      error: "TRANSCRIPTION_PROVIDER_UNAVAILABLE",
      message: "Transcription is temporarily unavailable.",
    });
    assert.doesNotMatch(JSON.stringify(response.body), /invalid transcript|provider payload|sess_secret|SELECT/i);
  }

  const valid = resultFor({ requestId: REQUEST_ID });
  await assertInvalid("different canonical requestId", {
    ...valid,
    requestId: "fe6f21bf-c69e-4bb4-b759-98f4b7f95c86",
  });
  await assertInvalid("uppercase requestId", { ...valid, requestId: REQUEST_ID.toUpperCase() });
  await assertInvalid("malformed requestId", { ...valid, requestId: "not-a-uuid" });
  await assertInvalid("uppercase transcriptionId", {
    ...valid,
    transcriptionId: TRANSCRIPTION_ID.toUpperCase(),
  });
  await assertInvalid("malformed transcriptionId", { ...valid, transcriptionId: "not-a-uuid" });

  for (const transcript of [
    "",
    "   ",
    ` ${protectedText}`,
    `${protectedText} `,
    "x".repeat(8001),
  ]) {
    await assertInvalid("invalid transcript", { ...valid, transcript });
  }
  for (const durationMs of [0, -1, 1.5, 30001]) {
    await assertInvalid("invalid duration", { ...valid, durationMs });
  }
  for (const expiresAt of [
    "not-a-date",
    "July 19, 2026 12:10:00 UTC",
    "2026-07-19T12:10:00Z",
    "2026-07-19T12:10:00.000+00:00",
  ]) {
    await assertInvalid("invalid expiry", { ...valid, expiresAt });
  }
  for (const attemptNumber of [0, 1.5, 3]) {
    await assertInvalid("invalid attempt number", { ...valid, attemptNumber });
  }
  for (const missingField of [
    "transcriptionId", "requestId", "attemptNumber", "transcript", "durationMs", "expiresAt",
  ]) {
    const missing = { ...valid };
    delete missing[missingField];
    await assertInvalid(`missing ${missingField}`, missing);
  }
  for (const extraField of [
    "provider", "model", "digest", "member", "plan", "diagnostic", "provenance", "other",
  ]) {
    await assertInvalid(`extra ${extraField}`, { ...valid, [extraField]: protectedText });
  }
  await assertInvalid("null", null);
  await assertInvalid("array", []);
  await assertInvalid("string primitive", protectedText);
  await assertInvalid("number primitive", 1);
  await assertInvalid("rejected Promise", () => Promise.reject(new Error(protectedText)));
  assert.doesNotMatch(logs.join("\n"), /invalid transcript|provider payload|sess_secret|SELECT/i);
});

test("exact six-field service result returns the exact non-cacheable HTTP 201 response", async (t) => {
  const harness = await createMockApp({
    transcriptionService: {
      async transcribe(input) {
        return resultFor(input);
      },
    },
  });
  t.after(() => harness.running.close());
  const response = await audioRequest(harness.running, routePath());
  assert.equal(response.response.status, 201);
  assert.deepEqual(response.body, {
    transcriptionId: TRANSCRIPTION_ID,
    requestId: REQUEST_ID,
    attemptNumber: 1,
    transcript: "Normalized route transcript",
    durationMs: 1234,
    expiresAt: "2026-07-19T12:10:00.000Z",
  });
  assert.equal(response.response.headers.get("cache-control"), "no-store");
  assert.equal(response.response.headers.get("x-content-type-options"), "nosniff");
});

test("service and parser failures are normalized without protected values", async (t) => {
  const cases = [
    ["TRANSCRIPTION_REQUEST_CONFLICT", 409], ["TRANSCRIPTION_IN_PROGRESS", 409],
    ["TRANSCRIPTION_ALREADY_COMPLETED", 409], ["TRANSCRIPTION_RETRY_REQUIRED", 409],
    ["TRANSCRIPTION_RETRY_DELAY", 409], ["TRANSCRIPTION_ATTEMPT_LIMIT_REACHED", 409],
    ["TRANSCRIPTION_MINUTE_LIMIT", 429], ["TRANSCRIPTION_DAILY_LIMIT", 429],
    ["TRANSCRIPTION_INVALID_AUDIO", 422], ["TRANSCRIPTION_AUDIO_UNINTELLIGIBLE", 422],
    ["TRANSCRIPTION_PROVIDER_TIMEOUT", 503], ["TRANSCRIPTION_PROVIDER_UNAVAILABLE", 503],
    ["TRANSCRIPTION_NOT_FOUND", 404],
  ];
  const protectedText = [
    "raw-provider-payload", "sess_secret", "binding-key-secret", "Bearer secret",
    "SELECT secret FROM protected", "raw transcript text",
  ].join(" ");
  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(" "));
  t.after(() => { console.error = originalError; });
  for (const [code, statusCode] of cases) {
    const harness = await createMockApp({
      transcriptionService: {
        async transcribe() {
          const error = new Error(protectedText);
          error.code = code;
          error.statusCode = statusCode;
          throw error;
        },
      },
    });
    const response = await audioRequest(harness.running, routePath());
    await harness.running.close();
    assert.equal(response.response.status, statusCode, code);
    assert.equal(response.body.error, code);
    assert.doesNotMatch(JSON.stringify(response.body), /raw-provider|sess_secret|binding-key|Bearer|SELECT|raw transcript/i);
  }
  const unexpected = await createMockApp({
    transcriptionService: { async transcribe() { throw new Error(protectedText); } },
  });
  const minimized = await audioRequest(unexpected.running, routePath());
  await unexpected.running.close();
  assert.equal(minimized.response.status, 503);
  assert.equal(minimized.body.error, "TRANSCRIPTION_PROVIDER_UNAVAILABLE");
  assert.doesNotMatch(logs.join("\n"), /raw-provider|sess_secret|binding-key|Bearer|SELECT|raw transcript/i);
});

async function seedIntegratedFixture(pool, suffix) {
  const seeded = await seedMemberAndPlan(pool, suffix);
  const mapping = await seedAlphaMapping(pool, seeded.member, suffix, true);
  const conversation = (await pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  return { ...seeded, mapping, conversation };
}

async function createIntegratedApp(pool, fixture, transcriptionService) {
  const authorization = createAlphaMemberAuthorization({ db: pool, applicationConfiguration });
  const app = express();
  useApplicationJsonParser(app);
  app.use("/alpha/goals-coach", createAlphaOriginGuard({ authorizedParties: [ORIGIN] }));
  app.use(
    "/alpha/goals-coach",
    createAlphaFeatureGate({ enabled: true }),
    (req, res, next) => {
      req.alphaMemberIdentity = {
        authProvider: "clerk",
        authSubject: fixture.mapping.auth_subject,
        sessionId: "synthetic-route-session",
      };
      return next();
    },
    authorization.loadActiveAlphaMember,
    createAlphaGoalsCoachRouter({
      db: pool,
      service: {},
      applicationConfiguration,
      requireCurrentConsent: authorization.requireCurrentAlphaConsent,
      phase1cStartup: readyStartup,
      transcriptionService,
    })
  );
  app.use(goalsCoachErrorHandler);
  return startApp(app);
}

async function authorizeFixture(pool, fixture) {
  await pool.query(
    `INSERT INTO goals_coach_alpha_consents
      (member_id, auth_mapping_id, consent_version, environment, status, accepted_at)
     VALUES ($1, $2, $3, $4, 'accepted', NOW())`,
    [fixture.member.id, fixture.mapping.id, applicationConfiguration.consentVersion,
      applicationConfiguration.alphaEnvironment]
  );
}

function integratedService(pool, deterministic, options = {}) {
  return createTranscriptionService({
    db: pool,
    adapter: deterministic.adapter,
    bindingKey: BINDING_KEY,
    providerTimeoutMs: 40,
    operationTimeoutMs: 100,
    retryDelayMs: 2000,
    expiryMs: 600000,
    maximumPerMinute: 3,
    maximumPerDay: 30,
    ...options,
  });
}

test("authenticated HTTP integration persists provenance but no transcript, message, turn, or workout", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const fixture = await seedIntegratedFixture(disposable.pool, "route-pglite");
  await authorizeFixture(disposable.pool, fixture);
  const deterministic = createDeterministicTranscriptionAdapter({
    text: "  Editable integrated transcript  ", durationMs: 1500,
  });
  const service = integratedService(disposable.pool, deterministic);
  const running = await createIntegratedApp(disposable.pool, fixture, service);
  t.after(() => running.close());
  const path = `/alpha/goals-coach/conversations/${fixture.conversation.id}/transcriptions/${REQUEST_ID}`;
  const response = await audioRequest(running, path, { body: Buffer.from("integrated-audio") });
  assert.equal(response.response.status, 201);
  assert.equal(response.body.transcript, "Editable integrated transcript");
  assert.equal(deterministic.getCallCount(), 1);
  const attempts = await disposable.pool.query("SELECT * FROM goals_coach_transcription_attempts");
  assert.equal(attempts.rows.length, 1);
  assert.equal(attempts.rows[0].status, "completed");
  assert.doesNotMatch(JSON.stringify(attempts.rows), /Editable integrated transcript|integrated-audio/);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages")).rows[0].count, 0);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns")).rows[0].count, 0);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns WHERE transcription_attempt_id IS NOT NULL"
  )).rows[0].count, 0);
});

test("real PostgreSQL authenticated route preserves scope, concurrency, retry binding, and coaching isolation", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const fixture = await seedIntegratedFixture(disposable.pool, "route-real-owner");
  const other = await seedIntegratedFixture(disposable.pool, "route-real-other");
  await authorizeFixture(disposable.pool, fixture);

  let releaseAdapter;
  let adapterStarted;
  const started = new Promise((resolve) => { adapterStarted = resolve; });
  const held = new Promise((resolve) => { releaseAdapter = resolve; });
  const deterministic = createDeterministicTranscriptionAdapter({
    text: "Real PostgreSQL route transcript",
    onCall: async () => { adapterStarted(); await held; },
  });
  const service = integratedService(disposable.pool, deterministic, {
    providerTimeoutMs: 1000, operationTimeoutMs: 2000,
  });
  const running = await createIntegratedApp(disposable.pool, fixture, service);
  t.after(() => running.close());
  const path = `/alpha/goals-coach/conversations/${fixture.conversation.id}/transcriptions/${REQUEST_ID}`;
  const firstPromise = audioRequest(running, path, { body: Buffer.from("real-route-audio") });
  await started;
  const duplicate = await audioRequest(running, path, { body: Buffer.from("real-route-audio") });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error, "TRANSCRIPTION_IN_PROGRESS");
  assert.equal(deterministic.getCallCount(), 1);
  releaseAdapter();
  const first = await firstPromise;
  assert.equal(first.response.status, 201);
  assert.equal(first.body.transcript, "Real PostgreSQL route transcript");

  const concealed = await audioRequest(
    running,
    `/alpha/goals-coach/conversations/${other.conversation.id}/transcriptions/${crypto.randomUUID()}`
  );
  assert.equal(concealed.response.status, 404);
  assert.equal(deterministic.getCallCount(), 1);

  let now = new Date();
  const retryAdapter = createDeterministicTranscriptionAdapter({ outcomes: [
    { type: "failure", failureCategory: "provider_unavailable" },
    { type: "success", text: "Real retry transcript", durationMs: 1600 },
  ] });
  const retryService = integratedService(disposable.pool, retryAdapter, { now: () => now });
  const retryRunning = await createIntegratedApp(disposable.pool, fixture, retryService);
  t.after(() => retryRunning.close());
  const retryId = crypto.randomUUID();
  const retryPath = `/alpha/goals-coach/conversations/${fixture.conversation.id}/transcriptions/${retryId}`;
  assert.equal((await audioRequest(retryRunning, retryPath, { body: Buffer.from("retry-audio") })).response.status, 503);
  now = new Date(now.getTime() + 2000);
  const changedAudio = await audioRequest(retryRunning, `${retryPath}?retry=true`, {
    body: Buffer.from("changed-audio"),
  });
  assert.equal(changedAudio.response.status, 409);
  const changedMime = await audioRequest(retryRunning, `${retryPath}?retry=true`, {
    body: Buffer.from("retry-audio"), mimeType: "audio/mp4",
  });
  assert.equal(changedMime.response.status, 409);
  assert.equal(retryAdapter.getCallCount(), 1);
  const retried = await audioRequest(retryRunning, `${retryPath}?retry=true`, {
    body: Buffer.from("retry-audio"),
  });
  assert.equal(retried.response.status, 201);
  assert.equal(retried.body.attemptNumber, 2);
  assert.equal(retryAdapter.getCallCount(), 2);

  const provenance = await disposable.pool.query(
    "SELECT status, audio_digest, transcript_digest FROM goals_coach_transcription_attempts ORDER BY created_at"
  );
  assert.equal(provenance.rows.length, 3);
  assert.doesNotMatch(JSON.stringify(provenance.rows), /Real PostgreSQL route transcript|Real retry transcript|real-route-audio|retry-audio/);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages")).rows[0].count, 0);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns")).rows[0].count, 0);
});

test("chunked request uses actual byte count and remains bounded", async (t) => {
  const harness = await createMockApp();
  t.after(() => harness.running.close());
  const url = new URL(`${harness.running.url}${routePath()}`);
  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": MIME, "Transfer-Encoding": "chunked" },
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({
        status: incoming.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.write(Buffer.from("one"));
    request.write(Buffer.from("two"));
    request.end();
  });
  assert.equal(response.status, 201);
  assert.equal(harness.calls[0].audio.toString("utf8"), "onetwo");
});
