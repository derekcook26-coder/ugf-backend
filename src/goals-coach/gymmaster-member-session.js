"use strict";

const crypto = require("node:crypto");
const { createTerminalState, deadlineAfter, monotonicNow, runBoundedPostgresTransaction } = require("./bounded-postgres-transaction");

const SESSION_COOKIE_NAME = "gc_member_session";
const MAXIMUM_SESSION_TTL_SECONDS = 15 * 60;
const TWO_HOUR_SESSION_TTL_SECONDS = 7200;
const TWO_HOUR_SESSION_FLAG = "GOALS_COACH_MEMBER_TWO_HOUR_SESSION_ENABLED";
const TWO_HOUR_SESSION_DATABASE_MILLISECONDS = 5000;

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseBase64urlJson(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }
}

function sessionError() {
  const error = new Error("Member session is invalid or expired");
  error.code = "GYMMASTER_MEMBER_SESSION_INVALID";
  error.statusCode = 401;
  error.exposeMessage = true;
  return error;
}

function requiredSecret(value) {
  if (!(typeof value === "string" || Buffer.isBuffer(value)) || value.length < 32) {
    throw new Error("GymMaster member session requires a secret of at least 32 bytes");
  }
  return value;
}

function createGymMasterMemberSessionService(options = {}) {
  const secret = requiredSecret(options.secret);
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;

  function currentSeconds() {
    const value = now();
    const seconds = Math.floor(new Date(value).getTime() / 1000);
    if (!Number.isFinite(seconds)) throw new Error("GymMaster member session clock is invalid");
    return seconds;
  }

  function sign(payload) {
    return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  }

  function issue(identity) {
    if (
      !identity
      || identity.authProvider !== "gymmaster"
      || typeof identity.authSubject !== "string"
      || !/^gymmaster:[1-9]\d*$/.test(identity.authSubject)
      || !Number.isInteger(identity.expiresInSeconds)
      || identity.expiresInSeconds < 1
    ) {
      throw new Error("Verified GymMaster identity is required for a member session");
    }
    const issuedAt = currentSeconds();
    const ttlSeconds = Math.min(identity.expiresInSeconds, MAXIMUM_SESSION_TTL_SECONDS);
    const payload = base64urlJson({
      v: 1,
      sid: randomBytes(32).toString("base64url"),
      p: identity.authProvider,
      s: identity.authSubject,
      iat: issuedAt,
      exp: issuedAt + ttlSeconds,
    });
    return `${payload}.${sign(payload)}`;
  }

  function verify(token) {
    if (typeof token !== "string") throw sessionError();
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) throw sessionError();
    const expected = Buffer.from(sign(payload));
    const supplied = Buffer.from(signature);
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      throw sessionError();
    }
    const claims = parseBase64urlJson(payload);
    if (
      !claims
      || claims.v !== 1
      || typeof claims.sid !== "string"
      || claims.sid.length < 20
      || claims.p !== "gymmaster"
      || typeof claims.s !== "string"
      || !/^gymmaster:[1-9]\d*$/.test(claims.s)
      || !Number.isInteger(claims.iat)
      || !Number.isInteger(claims.exp)
      || claims.exp <= currentSeconds()
      || claims.exp - claims.iat > MAXIMUM_SESSION_TTL_SECONDS
    ) {
      throw sessionError();
    }
    return Object.freeze({
      authProvider: claims.p,
      authSubject: claims.s,
      sessionId: claims.sid,
    });
  }

  return Object.freeze({ issue, verify });
}

function buildGymMasterSessionCookie(token) {
  if (typeof token !== "string" || !token) throw new Error("GymMaster member session token is required");
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/goalscoach; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAXIMUM_SESSION_TTL_SECONDS}`;
}

function extractCookie(header, name = SESSION_COOKIE_NAME) {
  if (typeof header !== "string") return null;
  const prefix = `${name}=`;
  for (const piece of header.split(";")) {
    const part = piece.trim();
    if (part.startsWith(prefix)) {
      try {
        return decodeURIComponent(part.slice(prefix.length));
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

function createGymMasterMemberSessionAuthenticator(options = {}) {
  const sessionService = options.sessionService;
  if (!sessionService || typeof sessionService.verify !== "function") {
    throw new Error("GymMaster member session authenticator requires a session service");
  }
  return function authenticateGymMasterMemberSession(req, res, next) {
    try {
      const token = extractCookie(req.headers && req.headers.cookie);
      if (!token) return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      req.alphaMemberIdentity = sessionService.verify(token);
      return next();
    } catch (_) {
      return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
    }
  };
}

function twoHourSessionEnabled(value) {
  return value === "true";
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function validOpaqueToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function createTwoHourSessionRequestContext(req, res, options = {}) {
  const now = typeof options.monotonicNow === "function" ? options.monotonicNow : monotonicNow;
  const milliseconds = options.overallMilliseconds || TWO_HOUR_SESSION_DATABASE_MILLISECONDS;
  const terminalState = createTerminalState();
  const onAborted = () => terminalState.terminate("request_aborted", { responseAllowed: false });
  const onRequestClose = () => { if (!req.complete) terminalState.terminate("request_closed", { responseAllowed: false }); };
  const onResponseClose = () => terminalState.terminate("response_closed", { responseAllowed: false });
  const onResponseFinish = () => terminalState.terminate("response_finished", { responseAllowed: false });
  const timer = setTimeout(() => terminalState.terminate("session_database_deadline", { responseAllowed: true }), milliseconds);
  if (typeof timer.unref === "function") timer.unref();
  if (req && typeof req.once === "function") { req.once("aborted", onAborted); req.once("close", onRequestClose); }
  if (res && typeof res.once === "function") { res.once("close", onResponseClose); res.once("finish", onResponseFinish); }
  if (req && (req.aborted === true || req.destroyed === true)) terminalState.terminate("request_already_terminal", { responseAllowed: false });
  if (res && (res.writableEnded === true || res.destroyed === true)) terminalState.terminate("response_already_terminal", { responseAllowed: false });
  let cleaned = false;
  return Object.freeze({
    terminalState, outerDeadlineNs: deadlineAfter(now(), milliseconds), monotonicNow: now,
    responseAllowed: () => terminalState.responseAllowed(),
    cleanup() {
      if (cleaned) return; cleaned = true; clearTimeout(timer);
      if (req && typeof req.removeListener === "function") { req.removeListener("aborted", onAborted); req.removeListener("close", onRequestClose); }
      if (res && typeof res.removeListener === "function") { res.removeListener("close", onResponseClose); res.removeListener("finish", onResponseFinish); }
    },
  });
}

function createGymMasterTwoHourSessionService(options = {}) {
  const db = options.db;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
  if (!db || typeof db.connect !== "function") throw new Error("Two-hour member session requires a database pool");

  async function runOperation(work, operation = {}) {
    const clock = typeof operation.monotonicNow === "function" ? operation.monotonicNow : (options.monotonicNow || monotonicNow);
    const terminalState = operation.terminalState || createTerminalState();
    const milliseconds = options.databaseMilliseconds || TWO_HOUR_SESSION_DATABASE_MILLISECONDS;
    const outerDeadlineNs = operation.outerDeadlineNs || deadlineAfter(clock(), milliseconds);
    const result = await runBoundedPostgresTransaction({ pool: db, terminalState, outerDeadlineNs, monotonicNow: clock, phaseMilliseconds: milliseconds, work });
    if (terminalState.isTerminal()) throw sessionError();
    return result.value;
  }

  async function issue(identity, activeMember, operation) {
    if (!identity || identity.authProvider !== "gymmaster" || !/^gymmaster:[1-9]\d*$/.test(identity.authSubject || "")
      || !activeMember || activeMember.active !== true || !/^[1-9]\d*$/.test(String(activeMember.mappingId))
      || !/^[1-9]\d*$/.test(String(activeMember.memberId))) throw sessionError();
    const token = randomBytes(32).toString("base64url");
    await runOperation(({ query }) => query(
      `INSERT INTO goals_coach_member_sessions
         (token_hash, auth_mapping_id, member_id, issued_at, expires_at)
       VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + INTERVAL '7200 seconds')`,
      [tokenHash(token), activeMember.mappingId, activeMember.memberId, now()]
    ), operation);
    return token;
  }

  async function verify(token, operation) {
    if (!validOpaqueToken(token)) throw sessionError();
    const result = await runOperation(({ query }) => query(
      `UPDATE goals_coach_member_sessions session
          SET last_validated_at = $2
         FROM goals_coach_member_auth_mappings mapping
        WHERE session.token_hash = $1
          AND session.auth_mapping_id = mapping.id
          AND session.member_id = mapping.member_id
          AND mapping.active = TRUE
          AND session.revoked_at IS NULL
          AND session.expires_at > $2
      RETURNING session.auth_mapping_id, session.member_id,
                mapping.auth_provider, mapping.auth_subject`,
      [tokenHash(token), now()]
    ), operation);
    const row = result && result.rows && result.rows[0];
    if (!row || row.auth_provider !== "gymmaster") throw sessionError();
    return Object.freeze({ authProvider: row.auth_provider, authSubject: row.auth_subject,
      mappingId: String(row.auth_mapping_id), memberId: String(row.member_id) });
  }

  async function revoke(token, operation) {
    if (!validOpaqueToken(token)) return false;
    const result = await runOperation(({ query }) => query(
      `UPDATE goals_coach_member_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
        WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING id`, [tokenHash(token), now()]
    ), operation);
    return Boolean(result && result.rows && result.rows.length);
  }
  return Object.freeze({ issue, verify, revoke });
}

function createGymMasterTwoHourSessionAuthenticator(options = {}) {
  const sessionService = options.sessionService;
  if (!sessionService || typeof sessionService.verify !== "function") throw new Error("Two-hour session authenticator requires a service");
  return async function authenticate(req, res, next) {
    const route = createTwoHourSessionRequestContext(req, res, options);
    if (route.terminalState.isTerminal() && !route.responseAllowed()) { route.cleanup(); return undefined; }
    try {
      const token = extractCookie(req.headers && req.headers.cookie);
      if (!token) return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      req.alphaMemberIdentity = await sessionService.verify(token, route);
      if (route.terminalState.isTerminal()) return route.responseAllowed() ? res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" }) : undefined;
      return next();
    } catch (_) { return route.responseAllowed() ? res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" }) : undefined; }
    finally { route.cleanup(); }
  };
}

function buildGymMasterTwoHourSessionCookie(token) {
  if (!validOpaqueToken(token)) throw new Error("Opaque member session token is required");
  return `${SESSION_COOKIE_NAME}=${token}; Path=/goalscoach; HttpOnly; Secure; SameSite=Strict; Max-Age=${TWO_HOUR_SESSION_TTL_SECONDS}`;
}

function clearGymMasterTwoHourSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/goalscoach; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

module.exports = {
  MAXIMUM_SESSION_TTL_SECONDS,
  TWO_HOUR_SESSION_FLAG,
  TWO_HOUR_SESSION_TTL_SECONDS,
  TWO_HOUR_SESSION_DATABASE_MILLISECONDS,
  SESSION_COOKIE_NAME,
  buildGymMasterSessionCookie,
  createGymMasterMemberSessionAuthenticator,
  createGymMasterMemberSessionService,
  extractCookie,
  buildGymMasterTwoHourSessionCookie,
  clearGymMasterTwoHourSessionCookie,
  createGymMasterTwoHourSessionAuthenticator,
  createGymMasterTwoHourSessionService,
  createTwoHourSessionRequestContext,
  tokenHash,
  twoHourSessionEnabled,
};
