const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProvisioningInput, provisionAlphaOwner } = require("../scripts/provision-alpha-owner");
const { createDisposableDatabase, seedMemberAndPlan } = require("./helpers/disposable-db");

function inputFor(memberId, overrides = {}) {
  return {
    action: "create",
    memberId: String(memberId),
    authProvider: "clerk",
    authSubject: "user_alpha_provisioned",
    verifiedEmail: "synthetic-owner@example.test",
    provisioningReference: "approved-phase-1a-test",
    activate: false,
    ...overrides,
  };
}

test("alpha provisioning accepts protected environment input and rejects malformed or missing values", () => {
  const valid = loadProvisioningInput({
    GOALS_COACH_PROVISION_ACTION: "create",
    GOALS_COACH_PROVISION_MEMBER_ID: "11",
    GOALS_COACH_PROVISION_AUTH_PROVIDER: "clerk",
    GOALS_COACH_PROVISION_AUTH_SUBJECT: "user_alpha_example",
    GOALS_COACH_PROVISION_VERIFIED_EMAIL: "synthetic@example.test",
    GOALS_COACH_PROVISIONING_REFERENCE: "approved-test",
  });
  assert.equal(valid.activate, false);
  assert.equal(valid.authSubject, "user_alpha_example");
  assert.throws(() => loadProvisioningInput({}), /GOALS_COACH_PROVISION_ACTION is required/);
  assert.throws(() => loadProvisioningInput({
    GOALS_COACH_PROVISION_ACTION: "create",
    GOALS_COACH_PROVISION_MEMBER_ID: "11",
    GOALS_COACH_PROVISION_AUTH_PROVIDER: "clerk",
    GOALS_COACH_PROVISION_AUTH_SUBJECT: "email@example.test",
    GOALS_COACH_PROVISION_VERIFIED_EMAIL: "synthetic@example.test",
    GOALS_COACH_PROVISIONING_REFERENCE: "approved-test",
  }), /not a valid immutable Clerk user subject/);
});

test("alpha provisioning creates inactive by default, safely reruns, and activates only explicitly", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "provision");
  const created = await provisionAlphaOwner({ pool: disposable.pool, input: inputFor(seeded.member.id) });
  assert.deepEqual(Object.keys(created).sort(), ["action", "active", "mappingId", "status"]);
  assert.equal(created.status, "created");
  assert.equal(created.active, false);
  const rerun = await provisionAlphaOwner({ pool: disposable.pool, input: inputFor(seeded.member.id) });
  assert.equal(rerun.status, "already_exists");
  assert.equal(rerun.mappingId, created.mappingId);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings")).rows[0].count, 1);
  const activated = await provisionAlphaOwner({
    pool: disposable.pool,
    input: inputFor(seeded.member.id, { activate: true }),
  });
  assert.equal(activated.status, "activated_existing");
  assert.equal(activated.active, true);
});

test("alpha provisioning refuses cross-member subjects and supports non-destructive deactivation", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const first = await seedMemberAndPlan(disposable.pool, "provision-a");
  const second = await seedMemberAndPlan(disposable.pool, "provision-b");
  await provisionAlphaOwner({
    pool: disposable.pool,
    input: inputFor(first.member.id, { activate: true }),
  });
  await assert.rejects(
    provisionAlphaOwner({ pool: disposable.pool, input: inputFor(second.member.id) }),
    /already mapped to a different member/
  );
  const deactivated = await provisionAlphaOwner({
    pool: disposable.pool,
    input: {
      action: "deactivate",
      memberId: String(first.member.id),
      authProvider: "clerk",
      authSubject: "user_alpha_provisioned",
      deactivationReason: "Synthetic test deactivation",
    },
  });
  assert.equal(deactivated.status, "deactivated");
  assert.equal(deactivated.active, false);
  const row = await disposable.pool.query("SELECT active, deactivated_at, deactivation_reason FROM goals_coach_member_auth_mappings");
  assert.equal(row.rows[0].active, false);
  assert.ok(row.rows[0].deactivated_at);
  assert.equal(row.rows[0].deactivation_reason, "Synthetic test deactivation");
});
