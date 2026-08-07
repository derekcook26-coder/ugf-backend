"use strict";

const express = require("express");
const {
  authenticatedEmailForIdentity,
} = require("./gymmaster-member-login");
const {
  validGymMasterIdentity,
} = require("./gymmaster-member-authorization");

const MEMBER_PENDING_ENROLLMENT_FLAG =
  "GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED";
const PENDING_ENROLLMENT_TTL_MILLISECONDS = 24 * 60 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATABASE_ID = /^[1-9]\d{0,18}$/;
const GYMMASTER_MEMBER_ID = /^[1-9]\d*$/;

function memberPendingEnrollmentEnabled(value) {
  return value === "true";
}

function pendingEnrollmentError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.exposeMessage = true;
  return error;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed) {
  if (!exactObject(value)) {
    throw pendingEnrollmentError(
      400,
      "MEMBER_PENDING_ENROLLMENT_INVALID",
      "Invalid member pending-enrollment request."
    );
  }
  const keys = Object.keys(value);
  if (
    keys.length !== allowed.length
    || keys.some((key) => !allowed.includes(key))
  ) {
    throw pendingEnrollmentError(
      400,
      "MEMBER_PENDING_ENROLLMENT_INVALID",
      "Invalid member pending-enrollment request."
    );
  }
}

function parsePendingEnrollmentRequest(body) {
  rejectUnknownKeys(body, ["gymmasterMemberId", "clientRequestId"]);
  if (
    typeof body.gymmasterMemberId !== "string"
    || !GYMMASTER_MEMBER_ID.test(body.gymmasterMemberId)
    || typeof body.clientRequestId !== "string"
    || !UUID.test(body.clientRequestId)
  ) {
    throw pendingEnrollmentError(
      400,
      "MEMBER_PENDING_ENROLLMENT_INVALID",
      "Invalid member pending-enrollment request."
    );
  }
  return Object.freeze({
    gymmasterMemberId: body.gymmasterMemberId,
    clientRequestId: body.clientRequestId,
  });
}

function validStaffActor(staffUser) {
  return Boolean(staffUser && DATABASE_ID.test(String(staffUser.id)));
}

function validMembershipVerifier(verifier) {
  return Boolean(verifier && typeof verifier.verifyActiveMember === "function");
}

function currentDate(now) {
  const value = new Date(now());
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Member pending-enrollment clock is invalid");
  }
  return value;
}

function isoTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Member pending-enrollment timestamp is invalid");
  }
  return date.toISOString();
}

function inactiveAuthorization() {
  return Object.freeze({ active: false });
}

async function withTransaction(db, action) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function replayResult(row) {
  return Object.freeze({
    created: false,
    status: row.status,
    expiresAt: isoTimestamp(row.expires_at),
  });
}

function createdResult(row) {
  return Object.freeze({
    created: true,
    status: "pending",
    expiresAt: isoTimestamp(row.expires_at),
  });
}

function createGymMasterMemberPendingEnrollmentService(options = {}) {
  const db = options.db;
  const membershipVerifier = options.membershipVerifier;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  if (!db || typeof db.query !== "function" || typeof db.connect !== "function") {
    throw new Error("Member pending enrollment requires a transactional database");
  }
  if (!validMembershipVerifier(membershipVerifier)) {
    throw new Error("Member pending enrollment requires a Gatekeeper membership verifier");
  }

  async function createPendingEnrollment(staffUser, input) {
    if (!validStaffActor(staffUser)) {
      throw pendingEnrollmentError(
        403,
        "ADMIN_ACCESS_REQUIRED",
        "Administrator access is required."
      );
    }
    const parsed = parsePendingEnrollmentRequest(input);
    const existingReplay = await db.query(
      `SELECT member_id, gymmaster_member_id, requested_by_staff_user_id,
              status, expires_at
       FROM goals_coach_member_pending_enrollments
       WHERE client_request_id = $1
       LIMIT 1`,
      [parsed.clientRequestId]
    );
    if (existingReplay.rows.length) {
      const row = existingReplay.rows[0];
      if (
        row.gymmaster_member_id === parsed.gymmasterMemberId
        && String(row.requested_by_staff_user_id) === String(staffUser.id)
      ) {
        return replayResult(row);
      }
      throw pendingEnrollmentError(
        409,
        "MEMBER_PENDING_ENROLLMENT_CONFLICT",
        "The pending-enrollment request conflicts with existing enrollment state."
      );
    }

    let membership;
    try {
      membership = await membershipVerifier.verifyActiveMember(
        parsed.gymmasterMemberId
      );
    } catch (_) {
      throw pendingEnrollmentError(
        503,
        "MEMBER_PENDING_ENROLLMENT_NOT_AVAILABLE",
        "Member pending enrollment is temporarily unavailable."
      );
    }
    if (!membership || membership.active !== true) {
      throw pendingEnrollmentError(
        409,
        "MEMBER_PENDING_ENROLLMENT_NOT_AVAILABLE",
        "The member is not available for pending enrollment."
      );
    }

    const createdAt = currentDate(now);
    const expiresAt = new Date(
      createdAt.getTime() + PENDING_ENROLLMENT_TTL_MILLISECONDS
    );
    return withTransaction(db, async (client) => {
      const member = await client.query(
        `SELECT id
         FROM coach_members
         WHERE gymmaster_member_id = $1
         FOR UPDATE`,
        [parsed.gymmasterMemberId]
      );
      if (member.rows.length !== 1) {
        throw pendingEnrollmentError(
          409,
          "MEMBER_PENDING_ENROLLMENT_NOT_AVAILABLE",
          "The member is not available for pending enrollment."
        );
      }
      const memberId = String(member.rows[0].id);

      const requestReplay = await client.query(
        `SELECT member_id, gymmaster_member_id, requested_by_staff_user_id,
                status, expires_at
         FROM goals_coach_member_pending_enrollments
         WHERE client_request_id = $1
         FOR UPDATE`,
        [parsed.clientRequestId]
      );
      if (requestReplay.rows.length) {
        const row = requestReplay.rows[0];
        if (
          String(row.member_id) === memberId
          && row.gymmaster_member_id === parsed.gymmasterMemberId
          && String(row.requested_by_staff_user_id) === String(staffUser.id)
        ) {
          return replayResult(row);
        }
        throw pendingEnrollmentError(
          409,
          "MEMBER_PENDING_ENROLLMENT_CONFLICT",
          "The pending-enrollment request conflicts with existing enrollment state."
        );
      }

      const mapping = await client.query(
        `SELECT id
         FROM goals_coach_member_auth_mappings
         WHERE auth_provider = 'gymmaster'
           AND (auth_subject = $1 OR member_id = $2)
         FOR UPDATE`,
        [`gymmaster:${parsed.gymmasterMemberId}`, memberId]
      );
      if (mapping.rows.length) {
        throw pendingEnrollmentError(
          409,
          "MEMBER_PENDING_ENROLLMENT_CONFLICT",
          "The pending-enrollment request conflicts with existing enrollment state."
        );
      }

      await client.query(
        `UPDATE goals_coach_member_pending_enrollments
         SET status = 'expired', expired_at = $2
         WHERE member_id = $1
           AND status = 'pending'
           AND expires_at <= $2`,
        [memberId, createdAt]
      );
      const liveEnrollment = await client.query(
        `SELECT id
         FROM goals_coach_member_pending_enrollments
         WHERE status = 'pending'
           AND (member_id = $1 OR gymmaster_member_id = $2)
         FOR UPDATE`,
        [memberId, parsed.gymmasterMemberId]
      );
      if (liveEnrollment.rows.length) {
        throw pendingEnrollmentError(
          409,
          "MEMBER_PENDING_ENROLLMENT_CONFLICT",
          "The pending-enrollment request conflicts with existing enrollment state."
        );
      }

      const inserted = await client.query(
        `INSERT INTO goals_coach_member_pending_enrollments
          (member_id, gymmaster_member_id, client_request_id,
           requested_by_staff_user_id, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         RETURNING id, expires_at`,
        [
          memberId,
          parsed.gymmasterMemberId,
          parsed.clientRequestId,
          String(staffUser.id),
          createdAt,
          expiresAt,
        ]
      );
      const pending = inserted.rows[0];
      await client.query(
        `INSERT INTO goals_coach_member_provisioning_events
          (pending_enrollment_id, member_id, staff_user_id, client_request_id,
           action, result, created_at)
         VALUES ($1, $2, $3, $4,
                 'pending_enrollment_created', 'created', $5)`,
        [
          String(pending.id),
          memberId,
          String(staffUser.id),
          parsed.clientRequestId,
          createdAt,
        ]
      );
      return createdResult(pending);
    });
  }

  async function completeAuthenticatedEnrollment(identity) {
    if (!validGymMasterIdentity(identity)) return inactiveAuthorization();
    const gymmasterMemberId = identity.authSubject.slice("gymmaster:".length);
    if (
      !GYMMASTER_MEMBER_ID.test(gymmasterMemberId)
      || identity.memberId !== gymmasterMemberId
    ) {
      return inactiveAuthorization();
    }
    const verifiedEmailSnapshot = authenticatedEmailForIdentity(identity);
    if (!verifiedEmailSnapshot) return inactiveAuthorization();

    const initialNow = currentDate(now);
    const candidateResult = await db.query(
      `SELECT id, member_id
       FROM goals_coach_member_pending_enrollments
       WHERE gymmaster_member_id = $1
         AND status = 'pending'
         AND expires_at > $2
       LIMIT 1`,
      [gymmasterMemberId, initialNow]
    );
    if (candidateResult.rows.length !== 1) return inactiveAuthorization();
    const candidate = candidateResult.rows[0];

    let membership;
    try {
      membership = await membershipVerifier.verifyActiveMember(gymmasterMemberId);
    } catch (_) {
      return inactiveAuthorization();
    }
    if (!membership || membership.active !== true) return inactiveAuthorization();

    const completedAt = currentDate(now);
    return withTransaction(db, async (client) => {
      const member = await client.query(
        `SELECT id
         FROM coach_members
         WHERE id = $1 AND gymmaster_member_id = $2
         FOR UPDATE`,
        [String(candidate.member_id), gymmasterMemberId]
      );
      if (member.rows.length !== 1) return inactiveAuthorization();
      const memberId = String(member.rows[0].id);

      const mappings = await client.query(
        `SELECT id, member_id, auth_subject, active, provisioning_reference
         FROM goals_coach_member_auth_mappings
         WHERE auth_provider = 'gymmaster'
           AND (auth_subject = $1 OR member_id = $2)
         FOR UPDATE`,
        [identity.authSubject, memberId]
      );
      if (mappings.rows.length) {
        if (mappings.rows.length !== 1) return inactiveAuthorization();
        const existing = mappings.rows[0];
        const consumed = await client.query(
          `SELECT auth_mapping_id, status
           FROM goals_coach_member_pending_enrollments
           WHERE id = $1 AND member_id = $2
           FOR UPDATE`,
          [String(candidate.id), memberId]
        );
        if (
          String(existing.member_id) === memberId
          && existing.auth_subject === identity.authSubject
          && existing.active === true
          && existing.provisioning_reference === `pending_enrollment:${candidate.id}`
          && consumed.rows.length === 1
          && consumed.rows[0].status === "consumed"
          && String(consumed.rows[0].auth_mapping_id) === String(existing.id)
        ) {
          return Object.freeze({
            active: true,
            mappingId: String(existing.id),
            memberId,
          });
        }
        return inactiveAuthorization();
      }

      const pendingResult = await client.query(
        `SELECT id, member_id, requested_by_staff_user_id,
                client_request_id, status, expires_at
         FROM goals_coach_member_pending_enrollments
         WHERE id = $1
           AND member_id = $2
           AND gymmaster_member_id = $3
         FOR UPDATE`,
        [String(candidate.id), memberId, gymmasterMemberId]
      );
      if (pendingResult.rows.length !== 1) return inactiveAuthorization();
      const pending = pendingResult.rows[0];
      if (
        pending.status !== "pending"
        || new Date(pending.expires_at).getTime() <= completedAt.getTime()
      ) {
        return inactiveAuthorization();
      }

      const mapping = await client.query(
        `INSERT INTO goals_coach_member_auth_mappings
          (member_id, auth_provider, auth_subject, verified_email_snapshot,
           active, provisioning_method, provisioning_reference,
           provisioned_by_staff_user_id)
         VALUES ($1, 'gymmaster', $2, $3, TRUE, 'administrative', $4, $5)
         RETURNING id, member_id`,
        [
          memberId,
          identity.authSubject,
          verifiedEmailSnapshot,
          `pending_enrollment:${pending.id}`,
          String(pending.requested_by_staff_user_id),
        ]
      );
      const createdMapping = mapping.rows[0];
      const consumed = await client.query(
        `UPDATE goals_coach_member_pending_enrollments
         SET status = 'consumed', auth_mapping_id = $2, consumed_at = $3
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [String(pending.id), String(createdMapping.id), completedAt]
      );
      if (consumed.rows.length !== 1) {
        throw new Error("Member pending-enrollment consumption failed");
      }
      await client.query(
        `INSERT INTO goals_coach_member_provisioning_events
          (pending_enrollment_id, auth_mapping_id, member_id, staff_user_id,
           client_request_id, action, result, created_at)
         VALUES ($1, $2, $3, $4, $5, 'mapping_completed', 'completed', $6)`,
        [
          String(pending.id),
          String(createdMapping.id),
          memberId,
          String(pending.requested_by_staff_user_id),
          pending.client_request_id,
          completedAt,
        ]
      );
      return Object.freeze({
        active: true,
        mappingId: String(createdMapping.id),
        memberId: String(createdMapping.member_id),
      });
    });
  }

  return Object.freeze({
    completeAuthenticatedEnrollment,
    createPendingEnrollment,
  });
}

function createGymMasterMemberPendingEnrollmentRouter(options = {}) {
  const service = options.service;
  const requireAdmin = options.requireAdmin;
  const mutationRateLimit = typeof options.mutationRateLimit === "function"
    ? options.mutationRateLimit
    : (_req, _res, next) => next();
  if (!service || typeof service.createPendingEnrollment !== "function") {
    throw new Error("Member pending-enrollment route requires its service");
  }
  if (typeof requireAdmin !== "function") {
    throw new Error("Member pending-enrollment route requires administrator authorization");
  }
  const router = express.Router();
  router.post(
    "/member-pending-enrollments",
    mutationRateLimit,
    requireAdmin,
    async (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      try {
        if (!req.is("application/json")) {
          throw pendingEnrollmentError(
            415,
            "MEMBER_PENDING_ENROLLMENT_MEDIA_TYPE_UNSUPPORTED",
            "Member pending enrollment requires application/json."
          );
        }
        if (Object.keys(req.query || {}).length !== 0) {
          throw pendingEnrollmentError(
            400,
            "MEMBER_PENDING_ENROLLMENT_INVALID",
            "Invalid member pending-enrollment request."
          );
        }
        const input = parsePendingEnrollmentRequest(req.body);
        const result = await service.createPendingEnrollment(req.staffUser, input);
        return res.status(result.created ? 201 : 200).json({
          pendingEnrollment: {
            status: result.status,
            expiresAt: result.expiresAt,
          },
          idempotentReplay: !result.created,
        });
      } catch (error) {
        return next(error);
      }
    }
  );
  return router;
}

module.exports = {
  MEMBER_PENDING_ENROLLMENT_FLAG,
  PENDING_ENROLLMENT_TTL_MILLISECONDS,
  createGymMasterMemberPendingEnrollmentRouter,
  createGymMasterMemberPendingEnrollmentService,
  memberPendingEnrollmentEnabled,
  parsePendingEnrollmentRequest,
};
