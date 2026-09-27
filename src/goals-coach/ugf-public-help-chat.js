"use strict";

const HELP_CHAT_FLAG = "UGF_PUBLIC_HELP_CHAT_ENABLED";
const MAX_QUESTION_LENGTH = 500;

const INTENTS = Object.freeze([
  Object.freeze({
    id: "access_hours",
    terms: Object.freeze(["hours", "open", "staff", "onsite", "appointment", "24/7", "365"]),
    answer: "Members have 24/7 access, 365 days a year. Staff is onsite Monday–Friday from 9 AM–2 PM and 3 PM–6 PM, with appointments available at other convenient times.",
    linkKey: "contactUrl",
    linkLabel: "Request staff follow-up",
  }),
  Object.freeze({
    id: "membership_purchase",
    terms: Object.freeze(["membership", "join", "sign up", "signup", "purchase", "buy", "price", "cost"]),
    answer: "You can review membership options and continue to UGF's secure GymMaster signup page. Payment and enrollment are completed there, not in this chat.",
    linkKey: "membershipUrl",
    linkLabel: "View memberships",
  }),
  Object.freeze({
    id: "class_schedule",
    terms: Object.freeze(["class", "schedule", "yoga", "time", "calendar"]),
    answer: "You can view the current UGF class schedule on the website.",
    linkKey: "scheduleUrl",
    linkLabel: "View class schedule",
  }),
  Object.freeze({
    id: "workout_plan",
    terms: Object.freeze(["workout", "plan", "coach ai", "goals coach", "exercise"]),
    answer: "Workout plans are available through Goals Coach. Sign in before viewing any member-specific plan.",
    linkKey: "workoutUrl",
    linkLabel: "Open Goals Coach",
  }),
  Object.freeze({
    id: "account_access",
    terms: Object.freeze(["account", "login", "log in", "password", "locked", "portal", "email", "username"]),
    answer: "For privacy, this chat cannot view or change an account, password, email address, billing record, or membership. Use the secure Member Portal, or contact UGF if you still cannot sign in.",
    linkKey: "portalUrl",
    linkLabel: "Open Member Portal",
  }),
  Object.freeze({
    id: "billing_support",
    terms: Object.freeze(["billing", "charged", "charge", "refund", "cancel", "cancellation", "payment", "card", "invoice"]),
    answer: "Billing, refunds, cancellations, and payment-method changes require UGF staff assistance. Do not enter card or bank information in this chat.",
    linkKey: "contactUrl",
    linkLabel: "Contact UGF",
  }),
]);

function enabled(value) {
  return value === "true";
}

function exactAllowedUrl(value, allowed) {
  if (typeof value !== "string" || !value) return null;
  let parsed;
  try { parsed = new URL(value); } catch (_) { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return null;
  return allowed.some(({ hostname, pathPrefix }) => (
    parsed.hostname === hostname && parsed.pathname.startsWith(pathPrefix)
  )) ? parsed.toString() : null;
}

function normalizeQuestion(value) {
  if (typeof value !== "string") return null;
  const question = value.trim().replace(/\s+/g, " ");
  if (!question || question.length > MAX_QUESTION_LENGTH) return null;
  return question;
}

function matchIntent(question) {
  const normalized = question.toLocaleLowerCase("en-US");
  let best = null;
  for (const intent of INTENTS) {
    const score = intent.terms.reduce((total, term) => total + (normalized.includes(term) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { intent, score };
  }
  return best ? best.intent : null;
}

function createPublicHelpChat(options = {}) {
  const links = options.links;
  if (!links || Object.values(links).some((value) => typeof value !== "string" || !value)) {
    throw new Error("Public help chat requires approved links");
  }
  return Object.freeze({
    answer(req, res) {
      const question = normalizeQuestion(req && req.body ? req.body.question : undefined);
      if (!question || Object.keys(req.body || {}).some((key) => key !== "question")) {
        return res.status(400).json({ error: "Enter one question of 500 characters or fewer." });
      }
      const intent = matchIntent(question);
      const response = intent ? {
        category: intent.id,
        answer: intent.answer,
        link: Object.freeze({ label: intent.linkLabel, url: links[intent.linkKey] }),
        needsStaff: intent.id === "billing_support",
      } : {
        category: "staff_help",
        answer: "I do not have an approved answer for that question. Please contact UGF so a staff member can help.",
        link: Object.freeze({ label: "Contact UGF", url: links.contactUrl }),
        needsStaff: true,
      };
      res.set("Cache-Control", "no-store");
      return res.status(200).json(response);
    },
  });
}

module.exports = {
  HELP_CHAT_FLAG,
  INTENTS,
  MAX_QUESTION_LENGTH,
  createPublicHelpChat,
  enabled,
  exactAllowedUrl,
  matchIntent,
  normalizeQuestion,
};
