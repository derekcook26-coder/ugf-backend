"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createProductionMemberConversationAuthorizationAdapters,
} = require("../src/goals-coach/member-conversation-authorization-adapters");
const {
  createProductionMemberConversationProviderDispatchComposition,
} = require("../src/goals-coach/member-conversation-provider-dispatch-composition");

function productionAuthorization(pool, fetchImpl) {
  return createProductionMemberConversationAuthorizationAdapters({
    pool,
    fetchImpl,
    environment: {
      GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL:
        "https://synthetic.invalid/gatekeeper_api/v2/members",
      GYMMASTER_API_KEY: "synthetic-test-key",
      GYMMASTER_SITE: "synthetic-test-site",
    },
  });
}

test("production dispatch composition is provider-free and performs no startup work", () => {
  let connects = 0;
  let fetches = 0;
  const pool = { async connect() { connects += 1; throw new Error("must not connect"); } };
  const authorizationAdapters = productionAuthorization(pool, async () => {
    fetches += 1;
    throw new Error("must not fetch");
  });

  const composition = createProductionMemberConversationProviderDispatchComposition({
    pool,
    authorizationAdapters,
  });

  assert.equal(Object.isFrozen(composition), true);
  assert.equal(composition.providerFree, true);
  assert.equal(composition.externalEffectsPermitted, false);
  assert.equal(composition.runtimeWired, false);
  assert.equal(composition.dispatchService.providerFree, true);
  assert.equal(composition.dispatchService.externalEffectsPermitted, false);
  assert.equal(typeof composition.dispatchService.reserve, "function");
  assert.equal(typeof composition.dispatchService.startDispatch, "function");
  assert.equal(typeof composition.dispatchService.finalizeSuccess, "function");
  assert.equal(connects, 0);
  assert.equal(fetches, 0);
});

test("invalid pool or authorization adapters fail closed without a repository", () => {
  for (const options of [
    {},
    { pool: { connect() {} }, authorizationAdapters: null },
    { pool: { connect() {} }, authorizationAdapters: {} },
  ]) {
    assert.deepEqual(
      createProductionMemberConversationProviderDispatchComposition(options),
      {
        dispatchService: null,
        externalEffectsPermitted: false,
        providerFree: true,
        runtimeWired: false,
      }
    );
  }
});

test("production constructs the dormant repository but keeps turn runtime null and absent", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  const startup = fs.readFileSync(
    path.resolve(__dirname, "../src/goals-coach/gymmaster-member-conversation-turn-startup.js"),
    "utf8"
  );
  assert.match(server, /createProductionMemberConversationProviderDispatchComposition/);
  assert.match(server, /authorizationAdapters:\s*memberConversationAuthorization/);
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
  assert.doesNotMatch(startup, /member-conversation-provider-dispatch-composition/);
  assert.doesNotMatch(startup, /member-conversation-provider-dispatch-service/);
});
