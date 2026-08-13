"use strict";

const express = require("express");
const {
  authenticatedEmailForIdentity,
} = require("./gymmaster-member-login");
const {
  validGymMasterIdentity,
} = require("./gymmaster-member-authorization");
const {
  createTerminalState,
  deadlineAfter,
  monotonicNow,
  runBoundedPostgresTransaction,
} = require("./bounded-postgres-transaction");
const {
  acquireGymMasterMemberProvisioningLock,
  canonicalGymMasterMemberId,
} = require("./gymmaster-member-provisioning-lock");

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

function currentDate(timestamp) {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Member pending-enrollment clock is invalid");
  }
  return value;
}

async function readTransactionDate(client, injectedTransactionTimestamp) {
  if (typeof injectedTransactionTimestamp === "function") {
    return currentDate(await injectedTransactionTimestamp());
  }
  const result = await client.query(
    "SELECT transaction_timestamp() AS transaction_now"
  );
  return currentDate(
    result && result.rows && result.rows[0] && result.rows[0].transaction_now
  );
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
  const started = monotonicNow();
  const terminalState = createTerminalState();
  try {
    const result = await runBoundedPostgresTransaction({
      pool: db,
      outerDeadlineNs: deadlineAfter(started, 5000),
      terminalState,
      phaseMilliseconds: 5000,
      work: action,
    });
    return result.value;
  } catch (error) {
    if (error && error.code === "work_failed" && error.cause) throw error.cause;
    throw error;
  }
}

class CompletionRejected extends Error {}

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
  const transactionTimestamp = options.transactionTimestamp;
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
    canonicalGymMasterMemberId(parsed.gymmasterMemberId);

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

    return withTransaction(db, async (client) => {
      await acquireGymMasterMemberProvisioningLock(
        client,
        parsed.gymmasterMemberId
      );
      const createdAt = await readTransactionDate(client, transactionTimestamp);
      const expiresAt = new Date(
        createdAt.getTime() + PENDING_ENROLLMENT_TTL_MILLISECONDS
      );

      await client.query(
        `UPDATE goals_coach_member_pending_enrollments
         SET status = 'expired', expired_at = $2
         WHERE gymmaster_member_id = $1
           AND status = 'pending'
           AND expires_at <= $2`,
        [parsed.gymmasterMemberId, createdAt]
      );

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

      const liveEnrollment = await client.query(
        `SELECT id
         FROM goals_coach_member_pending_enrollments
         WHERE status = 'pending'
           AND gymmaster_member_id = $1
         ORDER BY id
         FOR UPDATE`,
        [parsed.gymmasterMemberId]
      );
      if (liveEnrollment.rows.length) {
        throw pendingEnrollmentError(
          409,
          "MEMBER_PENDING_ENROLLMENT_CONFLICT",
          "The pending-enrollment request conflicts with existing enrollment state."
        );
      }

      const mapping = await client.query(
        `SELECT mapping.id
         FROM goals_coach_member_auth_mappings mapping
         JOIN coach_members member ON member.id = mapping.member_id
         WHERE mapping.auth_provider = 'gymmaster'
           AND (
             mapping.auth_subject = $1
             OR member.gymmaster_member_id = $2
           )
         ORDER BY mapping.id
         FOR UPDATE`,
        [`gymmaster:${parsed.gymmasterMemberId}`, parsed.gymmasterMemberId]
      );
      if (mapping.rows.length) {
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
          null,
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
          null,
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

    const candidateResult = await db.query(
      `SELECT id
       FROM goals_coach_member_pending_enrollments
       WHERE gymmaster_member_id = $1
         AND status IN ('pending', 'consumed')
       ORDER BY id
       LIMIT 2`,
      [gymmasterMemberId]
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

    try {
      return await withTransaction(db, async (client) => {
        await acquireGymMasterMemberProvisioningLock(client, gymmasterMemberId);
        const completedAt = await readTransactionDate(
          client,
          transactionTimestamp
        );
        const pendingRows = await client.query(
          `SELECT id, member_id, auth_mapping_id,
                  requested_by_staff_user_id, client_request_id,
                  status, expires_at
           FROM goals_coach_member_pending_enrollments
           WHERE gymmaster_member_id = $1
           ORDER BY id
           FOR UPDATE`,
          [gymmasterMemberId]
        );
        await client.query(
          `UPDATE goals_coach_member_pending_enrollments
           SET status = 'expired', expired_at = $2
           WHERE gymmaster_member_id = $1
             AND status = 'pending'
             AND expires_at <= $2`,
          [gymmasterMemberId, completedAt]
        );
        const candidatePending = pendingRows.rows.find(
          (row) => String(row.id) === String(candidate.id)
        );
        if (!candidatePending) throw new CompletionRejected();
        const candidateExpired =
          new Date(candidatePending.expires_at).getTime() <= completedAt.getTime();
        const candidateIsLive =
          candidatePending.status === "pending" && !candidateExpired;
        if (
          candidateIsLive
          && pendingRows.rows.filter((row) => (
            row.status === "pending"
            && new Date(row.expires_at).getTime() > completedAt.getTime()
          )).length !== 1
        ) {
          throw new CompletionRejected();
        }
        if (
          candidatePending.status === "expired"
          || (candidatePending.status === "pending" && candidateExpired)
        ) return inactiveAuthorization();
        if (
          candidatePending.status !== "pending"
          && candidatePending.status !== "consumed"
        ) throw new CompletionRejected();

        let member = await client.query(
          `SELECT id, first_name, last_name
           FROM coach_members
           WHERE gymmaster_member_id = $1
           FOR UPDATE`,
          [gymmasterMemberId]
        );
        if (!member.rows.length && candidateIsLive) {
          await client.query(
            `INSERT INTO coach_members
              (gymmaster_member_id, first_name, last_name)
             VALUES ($1, NULL, NULL)
             ON CONFLICT (gymmaster_member_id) DO NOTHING`,
            [gymmasterMemberId]
          );
          member = await client.query(
            `SELECT id, first_name, last_name
             FROM coach_members
             WHERE gymmaster_member_id = $1
             FOR UPDATE`,
            [gymmasterMemberId]
          );
        }
        if (member.rows.length !== 1) throw new CompletionRejected();
        const memberRow = member.rows[0];
        if ((memberRow.first_name === null) !== (memberRow.last_name === null)) {
          throw new CompletionRejected();
        }
        const memberId = String(memberRow.id);
        if (
          candidatePending.member_id !== null
          && String(candidatePending.member_id) !== memberId
        ) throw new CompletionRejected();

        const mappings = await client.query(
          `SELECT id, member_id, auth_subject, verified_email_snapshot,
                  active, provisioning_reference
           FROM goals_coach_member_auth_mappings
           WHERE auth_provider = 'gymmaster'
             AND (auth_subject = $1 OR member_id = $2)
           ORDER BY id
           FOR UPDATE`,
          [identity.authSubject, memberId]
        );
        if (mappings.rows.length) {
          if (mappings.rows.length !== 1) throw new CompletionRejected();
          const existing = mappings.rows[0];
          if (
            String(existing.member_id) === memberId
            && existing.auth_subject === identity.authSubject
            && existing.verified_email_snapshot === verifiedEmailSnapshot
            && existing.active === true
            && existing.provisioning_reference === `pending_enrollment:${candidate.id}`
            && candidatePending.status === "consumed"
            && String(candidatePending.member_id) === memberId
            && String(candidatePending.auth_mapping_id) === String(existing.id)
          ) {
            return Object.freeze({
              active: true,
              mappingId: String(existing.id),
              memberId,
            });
          }
          throw new CompletionRejected();
        }
        if (!candidateIsLive) throw new CompletionRejected();
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
            `pending_enrollment:${candidatePending.id}`,
            String(candidatePending.requested_by_staff_user_id),
          ]
        );
        const createdMapping = mapping.rows[0];
        const consumed = await client.query(
          `UPDATE goals_coach_member_pending_enrollments
           SET status = 'consumed', member_id = $2, auth_mapping_id = $3,
               consumed_at = $4
           WHERE id = $1
             AND status = 'pending'
             AND expires_at > $4
             AND (member_id IS NULL OR member_id = $2)
           RETURNING id`,
          [
            String(candidatePending.id),
            memberId,
            String(createdMapping.id),
            completedAt,
          ]
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
            String(candidatePending.id),
            String(createdMapping.id),
            memberId,
            String(candidatePending.requested_by_staff_user_id),
            candidatePending.client_request_id,
            completedAt,
          ]
        );
        return Object.freeze({
          active: true,
          mappingId: String(createdMapping.id),
          memberId: String(createdMapping.member_id),
        });
      });
    } catch (error) {
      if (error instanceof CompletionRejected) return inactiveAuthorization();
      return inactiveAuthorization();
    }
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
