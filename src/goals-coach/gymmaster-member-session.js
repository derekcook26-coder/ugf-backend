"use strict";

const crypto = require("node:crypto");

const SESSION_COOKIE_NAME = "gc_member_session";
const MAXIMUM_SESSION_TTL_SECONDS = 15 * 60;

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

module.exports = {
  MAXIMUM_SESSION_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  buildGymMasterSessionCookie,
  createGymMasterMemberSessionAuthenticator,
  createGymMasterMemberSessionService,
  extractCookie,
};
