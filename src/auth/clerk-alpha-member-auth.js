const { authenticateRequest, createClerkClient } = require("@clerk/express");

function parseExactAlphaOrigins(value, environment) {
  const origins = String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.map((origin) => {
    if (origin.includes("*") || origin.startsWith("/") || origin.endsWith("/")) {
      throw new Error("Alpha origins must be exact origins without wildcards, regexes, paths, or trailing slashes");
    }
    const parsed = new URL(origin);
    if (parsed.origin !== origin) throw new Error(`Invalid exact alpha origin: ${origin}`);
    if (environment === "production" && parsed.protocol !== "https:") {
      throw new Error("Production alpha origins must use HTTPS");
    }
    if (environment !== "production" && !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Development alpha origins must use HTTP or HTTPS");
    }
    return origin;
  });
}

function loadAlphaAuthConfiguration(environment = process.env.NODE_ENV || "development") {
  const originVariable = environment === "production"
    ? "GOALS_COACH_ALPHA_ORIGIN"
    : "GOALS_COACH_ALPHA_DEVELOPMENT_ORIGINS";
  return {
    environment,
    originVariable,
    authorizedParties: parseExactAlphaOrigins(process.env[originVariable], environment),
    secretKey: process.env.GOALS_COACH_MEMBER_CLERK_SECRET_KEY || "",
    publishableKey: process.env.GOALS_COACH_MEMBER_CLERK_PUBLISHABLE_KEY || "",
    issuer: process.env.GOALS_COACH_MEMBER_CLERK_ISSUER || "",
    audience: process.env.GOALS_COACH_MEMBER_CLERK_AUDIENCE || "",
  };
}

function alphaAuthConfigurationIsComplete(configuration) {
  return Boolean(
    configuration.secretKey
    && configuration.publishableKey
    && configuration.issuer
    && configuration.audience
    && configuration.authorizedParties.length
  );
}

function setAlphaCorsHeaders(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.setHeader("Vary", "Origin");
}

function createAlphaOriginGuard(configuration) {
  const allowed = new Set(configuration.authorizedParties);
  return function alphaOriginGuard(req, res, next) {
    const origin = req.get("Origin");
    if (req.method === "OPTIONS") {
      if (!origin || !allowed.has(origin)) {
        return res.status(403).json({ error: "ALPHA_ORIGIN_NOT_ALLOWED" });
      }
      setAlphaCorsHeaders(res, origin);
      return res.sendStatus(204);
    }
    if (origin && !allowed.has(origin)) {
      return res.status(403).json({ error: "ALPHA_ORIGIN_NOT_ALLOWED" });
    }
    if (origin) setAlphaCorsHeaders(res, origin);
    return next();
  };
}

function audienceMatches(claim, expected) {
  if (typeof claim === "string") return claim === expected;
  if (Array.isArray(claim)) return claim.length === 1 && claim[0] === expected;
  return false;
}

function hasSecondFactorVerification(factorVerificationAge) {
  return Array.isArray(factorVerificationAge)
    && factorVerificationAge.length >= 2
    && Number.isFinite(Number(factorVerificationAge[1]))
    && Number(factorVerificationAge[1]) >= 0;
}

function createAlphaMemberAuthenticator(options = {}) {
  const configuration = options.configuration || loadAlphaAuthConfiguration();
  const authenticate = options.authenticateRequest || authenticateRequest;
  const clerkClient = options.clerkClient || (
    alphaAuthConfigurationIsComplete(configuration)
      ? createClerkClient({
          secretKey: configuration.secretKey,
          publishableKey: configuration.publishableKey,
        })
      : null
  );

  return async function authenticateAlphaMember(req, res, next) {
    if (!alphaAuthConfigurationIsComplete(configuration) || !clerkClient) {
      return res.status(503).json({ error: "ALPHA_AUTH_NOT_CONFIGURED" });
    }

    try {
      const state = await authenticate({
        clerkClient,
        request: req,
        options: {
          acceptsToken: "session_token",
          audience: configuration.audience,
          authorizedParties: configuration.authorizedParties,
          secretKey: configuration.secretKey,
          publishableKey: configuration.publishableKey,
        },
      });

      if (!state || !state.isAuthenticated || state.tokenType !== "session_token") {
        return res.status(401).json({ error: "ALPHA_AUTHENTICATION_REQUIRED" });
      }

      const auth = state.toAuth();
      const claims = auth.sessionClaims || {};
      const expiresAt = Number(claims.exp);
      if (!claims.azp || !configuration.authorizedParties.includes(claims.azp)) {
        return res.status(401).json({ error: "ALPHA_AUTHORIZED_PARTY_INVALID" });
      }
      if (!audienceMatches(claims.aud, configuration.audience)) {
        return res.status(401).json({ error: "ALPHA_AUDIENCE_INVALID" });
      }
      if (claims.iss !== configuration.issuer) {
        return res.status(401).json({ error: "ALPHA_ISSUER_INVALID" });
      }
      if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
        return res.status(401).json({ error: "ALPHA_SESSION_EXPIRED" });
      }
      if (!auth.userId || !/^user_[A-Za-z0-9_-]+$/.test(auth.userId) || !auth.sessionId) {
        return res.status(401).json({ error: "ALPHA_SESSION_INVALID" });
      }
      if (!hasSecondFactorVerification(claims.fva)) {
        return res.status(401).json({ error: "ALPHA_MFA_REQUIRED" });
      }

      req.alphaMemberIdentity = Object.freeze({
        authProvider: "clerk",
        authSubject: auth.userId,
        sessionId: auth.sessionId,
      });
      return next();
    } catch (_) {
      return res.status(401).json({ error: "ALPHA_AUTHENTICATION_REQUIRED" });
    }
  };
}

module.exports = {
  alphaAuthConfigurationIsComplete,
  audienceMatches,
  createAlphaMemberAuthenticator,
  createAlphaOriginGuard,
  hasSecondFactorVerification,
  loadAlphaAuthConfiguration,
  parseExactAlphaOrigins,
};
