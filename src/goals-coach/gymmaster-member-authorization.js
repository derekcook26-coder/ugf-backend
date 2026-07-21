"use strict";

function validGymMasterIdentity(identity) {
  return Boolean(
    identity
    && identity.authProvider === "gymmaster"
    && typeof identity.authSubject === "string"
    && /^gymmaster:[1-9]\d*$/.test(identity.authSubject)
  );
}

function createGymMasterMemberAuthorization(options = {}) {
  const db = options.db;
  if (!db || typeof db.query !== "function") {
    throw new Error("GymMaster member authorization requires a database query interface");
  }

  return Object.freeze({
    async authorizeIdentity(identity) {
      if (!validGymMasterIdentity(identity)) return Object.freeze({ active: false });
      const result = await db.query(
        `SELECT mapping.id AS mapping_id, mapping.member_id
         FROM goals_coach_member_auth_mappings mapping
         JOIN coach_members member ON member.id = mapping.member_id
         WHERE mapping.auth_provider = $1
           AND mapping.auth_subject = $2
           AND mapping.active = TRUE
         LIMIT 1`,
        [identity.authProvider, identity.authSubject]
      );
      const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
      if (!row || !/^[1-9]\d*$/.test(String(row.mapping_id)) || !/^[1-9]\d*$/.test(String(row.member_id))) {
        return Object.freeze({ active: false });
      }
      return Object.freeze({
        active: true,
        mappingId: String(row.mapping_id),
        memberId: String(row.member_id),
      });
    },
  });
}

module.exports = {
  createGymMasterMemberAuthorization,
  validGymMasterIdentity,
};
