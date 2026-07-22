"use strict";

const express = require("express");
const { validGymMasterIdentity } = require("./gymmaster-member-authorization");

function ownerMemberId(value) {
  const normalized = String(value || "").trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

function createGymMasterOwnerAuthorizer(options = {}) {
  const memberId = ownerMemberId(options.memberId);
  if (!memberId) throw new Error("Owner-only GymMaster access requires a positive owner member ID");
  const expectedSubject = `gymmaster:${memberId}`;

  return Object.freeze({
    authorizeOwner(identity) {
      return validGymMasterIdentity(identity) && identity.authSubject === expectedSubject;
    },
  });
}

function createGymMasterOwnerOnlyRouter(options = {}) {
  const loginHandler = options.loginHandler;
  const authenticateSession = options.authenticateSession;
  const authorizeOwner = options.authorizeOwner;
  if (typeof loginHandler !== "function") {
    throw new Error("Owner-only GymMaster access requires a login handler");
  }
  if (typeof authenticateSession !== "function") {
    throw new Error("Owner-only GymMaster access requires session authentication");
  }
  if (typeof authorizeOwner !== "function") {
    throw new Error("Owner-only GymMaster access requires owner authorization");
  }

  const router = express.Router();
  router.post("/login", loginHandler);
  router.get("/session", authenticateSession, (req, res) => {
    if (authorizeOwner(req.alphaMemberIdentity) !== true) {
      return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
    }
    return res.status(200).json({
      access: "owner_only",
      coaching: "not_available",
      activationPermitted: false,
      externalCallsPermitted: false,
    });
  });
  return router;
}

module.exports = {
  createGymMasterOwnerAuthorizer,
  createGymMasterOwnerOnlyRouter,
  ownerMemberId,
};
