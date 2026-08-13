"use strict";

const CANONICAL_GYMMASTER_MEMBER_ID = /^[1-9][0-9]*$/;
const GYMMASTER_PROVISIONING_LOCK_NAMESPACE =
  "ugf.goals_coach.member_provisioning.gymmaster.v1:";
const GYMMASTER_PROVISIONING_LOCK_SEED = "8272051101";

const GYMMASTER_PROVISIONING_LOCK_SQL = `SELECT pg_advisory_xact_lock(
  hashtextextended(
    '${GYMMASTER_PROVISIONING_LOCK_NAMESPACE}' || $1::text,
    ${GYMMASTER_PROVISIONING_LOCK_SEED}::bigint
  )
)`;

function canonicalGymMasterMemberId(value) {
  if (typeof value !== "string" || !CANONICAL_GYMMASTER_MEMBER_ID.test(value)) {
    throw new Error("GymMaster member ID must be a canonical decimal string");
  }
  return value;
}

async function acquireGymMasterMemberProvisioningLock(client, memberId) {
  if (!client || typeof client.query !== "function") {
    throw new Error("GymMaster provisioning lock requires a transaction client");
  }
  const canonicalMemberId = canonicalGymMasterMemberId(memberId);
  await client.query(GYMMASTER_PROVISIONING_LOCK_SQL, [canonicalMemberId]);
}

module.exports = {
  CANONICAL_GYMMASTER_MEMBER_ID,
  GYMMASTER_PROVISIONING_LOCK_NAMESPACE,
  GYMMASTER_PROVISIONING_LOCK_SEED,
  GYMMASTER_PROVISIONING_LOCK_SQL,
  acquireGymMasterMemberProvisioningLock,
  canonicalGymMasterMemberId,
};
