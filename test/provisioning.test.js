const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseArguments,
  provisionStaffUser,
  validateOptions,
} = require("../scripts/provision-staff-user");
const { createDisposableDatabase } = require("./helpers/disposable-db");

function options(overrides = {}) {
  return {
    provider: "clerk",
    subject: "user_provision_valid",
    email: "coach@example.test",
    displayName: "Coach Example",
    role: "coach",
    activate: false,
    ...overrides,
  };
}

test("staff provisioning requires an immutable well-formed Clerk subject and rejects credential arguments", () => {
  assert.throws(() => validateOptions(options({ subject: "" })));
  assert.throws(() => validateOptions(options({ subject: "not-a-clerk-user" })));
  assert.throws(() => parseArguments(["--clerk-secret", "do-not-accept"]));
  assert.throws(() => parseArguments(["--token", "do-not-accept"]));
});

test("staff provisioning defaults inactive, activates only explicitly, and is idempotent", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());

  const created = await provisionStaffUser(options(), { pool: disposable.pool });
  assert.deepEqual(created, {
    operation: "created",
    staffUserId: created.staffUserId,
    provider: "clerk",
    role: "coach",
    active: false,
  });
  assert.equal(Object.hasOwn(created, "authSubject"), false);
  assert.equal(Object.hasOwn(created, "email"), false);

  const activated = await provisionStaffUser(options({ activate: true }), { pool: disposable.pool });
  assert.equal(activated.operation, "updated_existing_mapping");
  assert.equal(activated.active, true);
  const rerunWithoutActivation = await provisionStaffUser(options(), { pool: disposable.pool });
  assert.equal(rerunWithoutActivation.active, true);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM staff_users")).rows[0].count, 1);
});

test("staff provisioning refuses a different provider-subject mapping for an existing email", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  await provisionStaffUser(options(), { pool: disposable.pool });
  await assert.rejects(
    provisionStaffUser(
      options({ subject: "user_provision_different" }),
      { pool: disposable.pool }
    ),
    /different provider subject/
  );
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM staff_users")).rows[0].count, 1);
});
