"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  MEMBER_BOOTSTRAP_MAXIMUM_BYTES,
  createMemberBootstrap,
  parseMemberBootstrap,
} = require("../src/goals-coach/member-bootstrap-contract");

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/member-bootstrap-v1.json"), "utf8"));

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function patch(value, instruction) {
  const parts = instruction.path.split(".");
  let target = value;
  while (parts.length > 1) target = target[parts.shift()];
  target[parts[0]] = instruction.value;
  return value;
}
function routeStartup(origin, status = "ready_for_separate_route_composition") {
  return { status, origin, router() {} };
}
function conversationStartup(ready) {
  if (!ready) return { status: "disabled", configuration: { aiEnabled: false } };
  const configuration = { aiEnabled: true, generationReady: true };
  return { status: "ready", configuration, engine: { configuration, generateTurn() {} } };
}

test("shared bootstrap corpus accepts exact synthetic contracts and rejects expanded or inconsistent values", () => {
  assert.equal(corpus.corpusVersion, "GC-MEMBER-BOOTSTRAP-CORPUS-1");
  for (const entry of corpus.valid) assert.deepEqual(parseMemberBootstrap(entry.value), entry.value, entry.name);
  for (const entry of corpus.invalid) {
    const value = patch(clone(corpus.valid[1].value), entry.patch);
    assert.throws(() => parseMemberBootstrap(value), { code: "MEMBER_BOOTSTRAP_CONTRACT_INVALID" }, entry.name);
  }
});

test("parser clones and freezes the bounded privacy-minimized contract", () => {
  const input = clone(corpus.valid[1].value);
  const parsed = parseMemberBootstrap(input);
  input.capabilities.safety.status = "disabled";
  assert.equal(parsed.capabilities.safety.status, "ready");
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.capabilities), true);
  assert.equal(Object.isFrozen(parsed.capabilities.safety), true);
  assert.ok(Buffer.byteLength(JSON.stringify(parsed), "utf8") <= MEMBER_BOOTSTRAP_MAXIMUM_BYTES);
  assert.equal(JSON.stringify(parsed).includes("memberId"), false);
  assert.equal(JSON.stringify(parsed).includes("provider"), false);
});

test("bootstrap exposes ready only from exact validated startups and fails dependencies closed", () => {
  const origin = "https://coach.example";
  const ready = createMemberBootstrap({
    origin,
    consentStartup: routeStartup(origin),
    safetyStartup: routeStartup(origin),
    workoutStartup: routeStartup(origin),
    conversationStartup: routeStartup(origin),
  });
  for (const capability of Object.values(ready.capabilities)) assert.equal(capability.status, "ready");

  const unavailable = createMemberBootstrap({
    origin,
    consentStartup: routeStartup("https://wrong.example"),
    safetyStartup: routeStartup(origin),
    workoutStartup: routeStartup(origin),
    conversationStartup: routeStartup(origin),
  });
  assert.deepEqual(unavailable.capabilities.consent, { status: "unavailable", reason: "consent_unavailable" });
  assert.deepEqual(unavailable.capabilities.workout, { status: "unavailable", reason: "dependencies_unavailable" });
  assert.deepEqual(unavailable.capabilities.conversation, { status: "unavailable", reason: "dependencies_unavailable" });
});

test("a private-alpha engine never proves an authenticated production member conversation route", () => {
  const origin = "https://coach.example";
  const bootstrap = createMemberBootstrap({
    origin,
    consentStartup: routeStartup(origin),
    safetyStartup: routeStartup(origin),
    workoutStartup: routeStartup(origin),
    conversationStartup: conversationStartup(true),
  });
  assert.deepEqual(bootstrap.capabilities.conversation, {
    status: "unavailable",
    reason: "production_route_unavailable",
  });
  assert.deepEqual(parseMemberBootstrap(bootstrap), bootstrap);
});
