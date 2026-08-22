"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  createTerminalState,
  deadlineAfter,
  monotonicNow,
} = require("./bounded-postgres-transaction");
const { validGymMasterIdentity } = require("./gymmaster-member-authorization");
const { parseMemberBootstrap } = require("./member-bootstrap-contract");

const MEMBER_BOOTSTRAP_FLAG = "GOALS_COACH_MEMBER_BOOTSTRAP_ENABLED";
const MEMBER_BOOTSTRAP_AUTHORIZATION_TIMEOUT_MILLISECONDS = 5000;
const DATABASE_ID = /^[1-9]\d{0,18}$/;

function memberBootstrapEnabled(value) {
  return value === "true";
}

function unavailable(res) {
  if (res.headersSent || res.writableEnded || res.destroyed) return undefined;
  return res.status(503).json({ error: "MEMBER_BOOTSTRAP_UNAVAILABLE" });
}

function authenticationRequired(res) {
  if (res.headersSent || res.writableEnded || res.destroyed) return undefined;
  return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
}

function runBoundedRead(operation, req, res, milliseconds) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const terminalState = createTerminalState();
    const outerDeadlineNs = deadlineAfter(monotonicNow(), milliseconds);
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req && typeof req.removeListener === "function") {
        req.removeListener("aborted", onAborted);
        req.removeListener("close", onRequestClose);
      }
      if (res && typeof res.removeListener === "function") res.removeListener("close", onResponseClose);
      action(value);
    };
    const terminate = (reason, responseAllowed) => {
      terminalState.terminate(reason, { responseAllowed });
      finish(reject, Object.assign(new Error(reason), { code: reason, responseAllowed }));
    };
    const onAborted = () => terminate("request_aborted", false);
    const onRequestClose = () => { if (!req.complete) onAborted(); };
    const onResponseClose = () => terminate("response_closed", false);
    const timer = setTimeout(
      () => terminate("member_bootstrap_deadline", true),
      milliseconds
    );
    if (typeof timer.unref === "function") timer.unref();
    if (req && typeof req.once === "function") {
      req.once("aborted", onAborted);
      req.once("close", onRequestClose);
    }
    if (res && typeof res.once === "function") res.once("close", onResponseClose);
    if (req && (req.aborted || req.destroyed)) return onAborted();
    Promise.resolve().then(() => operation(Object.freeze({ terminalState, outerDeadlineNs }))).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function validAuthorization(value) {
  return Boolean(value && value.active === true
    && DATABASE_ID.test(String(value.mappingId)) && DATABASE_ID.test(String(value.memberId)));
}

function createBootstrapRateLimit() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `member:${String(req.alphaMemberIdentity.authSubject)}`,
    handler: (_req, res) => res.status(429).json({ error: "RATE_LIMITED" }),
  });
}

function responseAuthorityRevoked(req, res, error) {
  return Boolean(error && error.responseAllowed === false)
    || Boolean(req && (req.aborted || req.destroyed))
    || Boolean(res && (res.writableEnded || res.destroyed || res.closed));
}

function createBootstrapRequestHandler(options = {}) {
  const { authorizeIdentity, bootstrap, timeoutMilliseconds } = options;
  return async (req, res) => {
    if (Object.keys(req.query).length || !validGymMasterIdentity(req.alphaMemberIdentity)) {
      return authenticationRequired(res);
    }
    try {
      const authorization = await runBoundedRead(
        (context) => authorizeIdentity(req.alphaMemberIdentity, context), req, res, timeoutMilliseconds
      );
      if (!validAuthorization(authorization)) return authenticationRequired(res);
      if (req.aborted || req.destroyed || res.writableEnded || res.destroyed || res.closed) return undefined;
      return res.status(200).json(bootstrap);
    } catch (error) {
      if (responseAuthorityRevoked(req, res, error)) return undefined;
      return unavailable(res);
    }
  };
}

function createGymMasterMemberBootstrapRouter(options = {}) {
  const { authenticateSession, authorizeIdentity, origin } = options;
  const bootstrap = parseMemberBootstrap(options.bootstrap);
  const timeoutMilliseconds = Number.isInteger(options.timeoutMilliseconds)
    && options.timeoutMilliseconds > 0 && options.timeoutMilliseconds <= MEMBER_BOOTSTRAP_AUTHORIZATION_TIMEOUT_MILLISECONDS
    ? options.timeoutMilliseconds : MEMBER_BOOTSTRAP_AUTHORIZATION_TIMEOUT_MILLISECONDS;
  if (typeof authenticateSession !== "function" || typeof authorizeIdentity !== "function" || !origin) {
    throw new Error("Member bootstrap dependencies are incomplete");
  }
  const router = express.Router();
  const limiter = options.rateLimit || createBootstrapRateLimit();
  const requestHandler = createBootstrapRequestHandler({
    authorizeIdentity,
    bootstrap,
    timeoutMilliseconds,
  });
  router.get(
    "/",
    (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.headers.origin !== origin) return res.status(403).json({ error: "MEMBER_ORIGIN_NOT_ALLOWED" });
      return authenticateSession(req, res, next);
    },
    limiter,
    requestHandler
  );
  return router;
}

module.exports = {
  MEMBER_BOOTSTRAP_AUTHORIZATION_TIMEOUT_MILLISECONDS,
  MEMBER_BOOTSTRAP_FLAG,
  createBootstrapRequestHandler,
  createGymMasterMemberBootstrapRouter,
  memberBootstrapEnabled,
  responseAuthorityRevoked,
  runBoundedRead,
};
