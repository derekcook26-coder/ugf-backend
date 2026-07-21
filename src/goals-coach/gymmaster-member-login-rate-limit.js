"use strict";

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAXIMUM_ATTEMPTS = 5;

function positiveInteger(value, fallback, name) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected <= 0) throw new Error(`${name} must be a positive integer`);
  return selected;
}

function validClientAddress(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

function createGymMasterMemberLoginRateLimiter(options = {}) {
  const windowMs = positiveInteger(options.windowMs, DEFAULT_WINDOW_MS, "windowMs");
  const maximumAttempts = positiveInteger(options.maximumAttempts, DEFAULT_MAXIMUM_ATTEMPTS, "maximumAttempts");
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const attemptsByAddress = new Map();

  function prune(nowMs) {
    for (const [address, attempts] of attemptsByAddress) {
      const active = attempts.filter((attemptedAt) => attemptedAt > nowMs - windowMs);
      if (active.length) attemptsByAddress.set(address, active);
      else attemptsByAddress.delete(address);
    }
  }

  return Object.freeze({
    allow(clientAddress) {
      if (!validClientAddress(clientAddress)) return false;
      const nowMs = Number(now());
      if (!Number.isFinite(nowMs)) throw new Error("GymMaster member login rate-limit clock is invalid");
      prune(nowMs);
      const attempts = attemptsByAddress.get(clientAddress) || [];
      if (attempts.length >= maximumAttempts) return false;
      attemptsByAddress.set(clientAddress, [...attempts, nowMs]);
      return true;
    },
  });
}

module.exports = {
  DEFAULT_MAXIMUM_ATTEMPTS,
  DEFAULT_WINDOW_MS,
  createGymMasterMemberLoginRateLimiter,
};
