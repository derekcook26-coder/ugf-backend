"use strict";

const { APPROVED_ALPHA_CONSENT_VERSION } = require("./alpha-config");

const REQUIRED_DISABLED_FLAGS = Object.freeze([
  "GOALS_COACH_ALPHA_ENABLED",
  "GOALS_COACH_AI_ENABLED",
  "GOALS_COACH_VOICE_INPUT_ENABLED",
  "GOALS_COACH_TRANSCRIPTION_ENABLED",
  "GOALS_COACH_SPEECH_OUTPUT_ENABLED",
  "GOALS_COACH_PHASE1D_SAFETY_ENABLED",
]);

const REQUIRED_OWNER_INPUTS = Object.freeze([
  "approvedAlphaOrigin",
  "approvedOwnerSubject",
  "approvedMonthlyBudgetUsd",
  "approvedDailyWarningUsd",
  "protectedReviewDestination",
  "backupReviewDestination",
]);

function exactFalse(value) {
  return String(value === undefined ? "false" : value).trim().toLowerCase() === "false";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function exactHttpsOrigin(value) {
  if (!nonEmptyString(value) || value.includes("*") || value.endsWith("/")) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value;
  } catch (_) {
    return false;
  }
}

function positiveUsdAmount(value) {
  if (!nonEmptyString(value) || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function createPhase1eReadinessReport(options = {}) {
  const environment = options.environment || process.env;
  const ownerInputs = options.ownerInputs || {};
  const blockers = [];

  for (const name of REQUIRED_DISABLED_FLAGS) {
    if (!exactFalse(environment[name])) blockers.push(`feature_flag_must_remain_disabled:${name}`);
  }

  if (String(environment.GOALS_COACH_ALPHA_CONSENT_VERSION || "").trim() !== APPROVED_ALPHA_CONSENT_VERSION) {
    blockers.push("approved_alpha_consent_version_required");
  }

  for (const name of REQUIRED_OWNER_INPUTS) {
    if (!nonEmptyString(ownerInputs[name])) blockers.push(`owner_input_required:${name}`);
  }

  if (nonEmptyString(ownerInputs.approvedAlphaOrigin) && !exactHttpsOrigin(ownerInputs.approvedAlphaOrigin)) {
    blockers.push("approved_alpha_origin_must_be_one_exact_https_origin");
  }

  const monthlyBudget = positiveUsdAmount(ownerInputs.approvedMonthlyBudgetUsd);
  const dailyWarning = positiveUsdAmount(ownerInputs.approvedDailyWarningUsd);
  if (ownerInputs.approvedMonthlyBudgetUsd !== undefined && monthlyBudget === null) {
    blockers.push("approved_monthly_budget_must_be_positive_usd");
  }
  if (ownerInputs.approvedDailyWarningUsd !== undefined && dailyWarning === null) {
    blockers.push("approved_daily_warning_must_be_positive_usd");
  }
  if (monthlyBudget !== null && dailyWarning !== null && dailyWarning >= monthlyBudget) {
    blockers.push("daily_warning_must_be_lower_than_monthly_budget");
  }

  return Object.freeze({
    status: blockers.length === 0 ? "ready_for_configuration_review" : "not_ready",
    blockers: Object.freeze(blockers),
    activationPermitted: false,
    externalCallsPermitted: false,
  });
}

module.exports = {
  REQUIRED_DISABLED_FLAGS,
  REQUIRED_OWNER_INPUTS,
  createPhase1eReadinessReport,
  exactHttpsOrigin,
  exactFalse,
  positiveUsdAmount,
};
