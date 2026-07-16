const { authenticateRequest, createClerkClient } = require("@clerk/express");

function parseExactOrigins(value, environment) {
  const origins = String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.map((origin) => {
    if (origin.includes("*") || origin.startsWith("/") || origin.endsWith("/")) {
      throw new Error("Staff origins must be exact origins without wildcards, regexes, paths, or trailing slashes");
    }
    const parsed = new URL(origin);
    if (parsed.origin !== origin) throw new Error(`Invalid exact staff origin: ${origin}`);
    if (environment === "production" && parsed.protocol !== "https:") {
      throw new Error("Production staff origins must use HTTPS");
    }
    if (environment !== "production" && !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Development staff origins must use HTTP or HTTPS");
    }
    return origin;
  });
}

function loadStaffAuthConfiguration(environment = process.env.NODE_ENV || "development") {
  const originVariable = environment === "production"
    ? "CLERK_AUTHORIZED_PARTIES_PRODUCTION"
    : "CLERK_AUTHORIZED_PARTIES_DEVELOPMENT";
  const authorizedParties = parseExactOrigins(process.env[originVariable], environment);

  return {
    environment,
    originVariable,
    authorizedParties,
    secretKey: process.env.CLERK_SECRET_KEY || "",
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
    issuer: process.env.CLERK_JWT_ISSUER || "",
  };
}

function configurationIsComplete(configuration) {
  return Boolean(
    configuration.secretKey
    && configuration.publishableKey
    && configuration.issuer
    && configuration.authorizedParties.length
  );
}

function setStaffCorsHeaders(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.setHeader("Vary", "Origin");
}

function createStaffOriginGuard(configuration) {
  const allowed = new Set(configuration.authorizedParties);

  return function staffOriginGuard(req, res, next) {
    const origin = req.get("Origin");
    if (req.method === "OPTIONS") {
      if (!origin || !allowed.has(origin)) {
        return res.status(403).json({ error: "STAFF_ORIGIN_NOT_ALLOWED" });
      }
      setStaffCorsHeaders(res, origin);
      return res.sendStatus(204);
    }
    if (origin && !allowed.has(origin)) {
      return res.status(403).json({ error: "STAFF_ORIGIN_NOT_ALLOWED" });
    }
    if (origin) setStaffCorsHeaders(res, origin);
    return next();
  };
}

function createStaffAuthenticator(options = {}) {
  const configuration = options.configuration || loadStaffAuthConfiguration();
  const authenticate = options.authenticateRequest || authenticateRequest;
  const clerkClient = options.clerkClient || (
    configurationIsComplete(configuration)
      ? createClerkClient({
          secretKey: configuration.secretKey,
          publishableKey: configuration.publishableKey,
        })
      : null
  );

  return async function authenticateStaff(req, res, next) {
    if (!configurationIsComplete(configuration) || !clerkClient) {
      return res.status(503).json({ error: "STAFF_AUTH_NOT_CONFIGURED" });
    }

    try {
      const state = await authenticate({
        clerkClient,
        request: req,
        options: {
          acceptsToken: "session_token",
          authorizedParties: configuration.authorizedParties,
          secretKey: configuration.secretKey,
          publishableKey: configuration.publishableKey,
        },
      });

      if (!state || !state.isAuthenticated || state.tokenType !== "session_token") {
        return res.status(401).json({ error: "STAFF_AUTHENTICATION_REQUIRED" });
      }

      const auth = state.toAuth();
      const claims = auth.sessionClaims || {};
      const authorizedParty = claims.azp;
      const issuer = claims.iss;
      const expiresAt = Number(claims.exp);

      if (!authorizedParty || !configuration.authorizedParties.includes(authorizedParty)) {
        return res.status(401).json({ error: "STAFF_AUTHORIZED_PARTY_INVALID" });
      }
      if (issuer !== configuration.issuer) {
        return res.status(401).json({ error: "STAFF_ISSUER_INVALID" });
      }
      if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
        return res.status(401).json({ error: "STAFF_SESSION_EXPIRED" });
      }
      if (!auth.userId || !auth.sessionId) {
        return res.status(401).json({ error: "STAFF_SESSION_INVALID" });
      }

      req.staffIdentity = Object.freeze({
        authProvider: "clerk",
        authSubject: auth.userId,
        sessionId: auth.sessionId,
      });
      return next();
    } catch (_) {
      return res.status(401).json({ error: "STAFF_AUTHENTICATION_REQUIRED" });
    }
  };
}

module.exports = {
  configurationIsComplete,
  createStaffAuthenticator,
  createStaffOriginGuard,
  loadStaffAuthConfiguration,
  parseExactOrigins,
};
