var express = require("express");
var cors = require("cors");
var fetch = require("node-fetch");
var jwt = require("jsonwebtoken");
var rateLimit = require("express-rate-limit");
var { Pool } = require("pg");
var OpenAI = require("openai");
var {
  createStaffAuthenticator,
  createStaffOriginGuard,
  loadStaffAuthConfiguration,
} = require("./src/auth/clerk-staff-auth");
var {
  createAlphaMemberAuthenticator,
  createAlphaOriginGuard,
  loadAlphaAuthConfiguration,
} = require("./src/auth/clerk-alpha-member-auth");
var { createAlphaMemberAuthorization } = require("./src/auth/alpha-member-authorization");
var { createStaffAuthorization } = require("./src/auth/staff-authorization");
var { goalsCoachErrorHandler } = require("./src/goals-coach/http-error-handler");
var {
  createAlphaFeatureGate,
  loadAlphaApplicationConfiguration,
} = require("./src/goals-coach/alpha-config");
var { createAlphaGoalsCoachRouter } = require("./src/goals-coach/alpha-routes");
var { createApplicationJsonParser } = require("./src/goals-coach/transcription-route");
var { createPhase1bStartup } = require("./src/goals-coach/phase1b-startup");
var { createPhase1cStartup } = require("./src/goals-coach/phase1c-startup");
var { createGoalsCoachMemberRouter } = require("./src/goals-coach/member-routes");
var { createGoalsCoachStaffRouter } = require("./src/goals-coach/staff-routes");

var app = express();
// Railway routes public requests through one edge proxy. Trust that single hop
// so Express exposes the client address to express-rate-limit.
app.set("trust proxy", 1);
// Only the exact canonical transcription path (or exact missing-ID fallback)
// owns a bounded raw-body parser after its capability gate. Every other path
// retains the existing JSON parser.
app.use(createApplicationJsonParser());

// ─── CORS ─────────────────────────────────────────────────────────────────────

// Staff browser traffic uses a separate exact-origin policy. This guard is
// intentionally mounted before the existing member CORS middleware so the
// broader member policy never authorizes a staff route.
var staffAuthConfiguration = loadStaffAuthConfiguration();
app.use("/staff", createStaffOriginGuard(staffAuthConfiguration));

// The private owner alpha has its own exact-origin boundary. It does not inherit
// the public-member or staff allowlists.
var alphaAuthConfiguration = loadAlphaAuthConfiguration();
var alphaApplicationConfiguration = loadAlphaApplicationConfiguration();
// Phase 1B has no default live provider adapter. Configuration may be prepared,
// but coaching remains unavailable unless an approved provider is explicitly
// supplied to the startup composition in a separately authorized release.
var phase1bStartup = createPhase1bStartup();
// Phase 1C has no production transcription adapter or approved consent version.
// Startup remains healthy, but voice capability cannot become ready from
// environment values alone.
var phase1cStartup = createPhase1cStartup({ phase1bStartup: phase1bStartup });
app.use("/alpha/goals-coach", createAlphaOriginGuard(alphaAuthConfiguration));

var memberCors = cors({
  origin: function (origin, callback) {
    var allowed = [
      "https://ultimate-goals-fitness.sintra.site",
      "https://ultimategoalsfitness.com",
      "https://www.ultimategoalsfitness.com",
    ];
    if (
      !origin ||
      allowed.includes(origin) ||
      /^https?:\/\/([\w-]+\.)*sintra\.(ai|site)$/.test(origin) ||
      /^http:\/\/localhost(:\d+)?$/.test(origin)
    ) {
      callback(null, true);
    } else {
      callback(new Error("CORS blocked: " + origin));
    }
  },
});

app.use(function (req, res, next) {
  if (req.path === "/staff" || req.path.startsWith("/staff/")) return next();
  if (req.path === "/alpha/goals-coach" || req.path.startsWith("/alpha/goals-coach/")) return next();
  return memberCors(req, res, next);
});

// ─── Database ─────────────────────────────────────────────────────────────────

var db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Rate limiters ────────────────────────────────────────────────────────────

var verifyMemberLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many verification attempts. Please wait 15 minutes." },
});

// 60 requests per hour — enough for a full coaching conversation.
var coachMessageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many coaching requests. Please wait before trying again." },
});

var checkinSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many check-in session attempts. Please wait 15 minutes." },
});

var checkinSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions. Please try again later." },
});

// ─── Constants ────────────────────────────────────────────────────────────────

var GYMMASTER_BASE = "https://ugf.gymmasteronline.com/gatekeeper_api/v2";
var CHECKIN_SESSION_TTL = "2h";
var VERIFY_TOKEN_TTL = "2h";
var MAX_TRAINER_NOTIFICATION_ATTEMPTS = 5;

// ─── GymMaster Gatekeeper helpers ─────────────────────────────────────────────
//
// Uses GYMMASTER_API_KEY with the confirmed Gatekeeper API.
// Used for membership verification only.

function gymHeaders() {
  var site = process.env.GYMMASTER_SITE || "ugf";
  var key = process.env.GYMMASTER_API_KEY;
  var token = Buffer.from(site + ":" + key).toString("base64");
  return {
    Accept: "application/json",
    Authorization: "Basic " + token,
  };
}

function isMemberActive(member) {
  if (member.stopatgate) return false;
  var memberships = member.membership || member.memberships || [];
  if (Array.isArray(memberships) && memberships.length > 0) {
    return memberships.some(function (m) { return m.expired === false; });
  }
  return false;
}

// ─── GymMaster communication adapter — DISABLED ───────────────────────────────
//
// The GymMaster communication API endpoint for sending saved email templates
// has not been confirmed. This adapter is disabled until GymMaster provides:
//
//   1. API product or service name
//   2. API base URL (may differ from the Gatekeeper URL)
//   3. Authentication method and which credential is required
//   4. Exact endpoint path
//   5. HTTP method
//   6. Template identifier format (numeric ID, slug, etc.)
//   7. Member identifier format (numeric ID, email, etc.)
//   8. Complete request payload structure
//   9. Expected success response
//  10. Required account permissions
//
// IMPORTANT: GYMMASTER_MEMBER_PORTAL_API_KEY and GYMMASTER_API_KEY are treated
// as separate credentials. Do not make one fall back to the other.
//
// The feature flag GYMMASTER_WEEKLY_EMAIL_ENABLED must also be set to "true"
// in Railway after the adapter is updated and a single-member test succeeds.

async function sendGymMasterWeeklyCheckinEmail() {
  return {
    configured: false,
    error: "GymMaster communication endpoint has not been confirmed.",
  };
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

// Verification token — issued by /verify-member, consumed by /coach-message
// and /generate-personalized-workout. Signed with MEMBER_VERIFY_SECRET.
//
// Payload:
//   sub             — canonical GymMaster member ID (authoritative identity key)
//   firstName       — first name exactly as returned by the GymMaster record
//   lastInitial     — last initial exactly as returned by the GymMaster record
//   displayLastName — full last name entered by the member; first character
//                     confirmed against the GymMaster last initial, but the
//                     full name is not confirmed by GymMaster
//
// /coach-message and /generate-personalized-workout use:
//   sub             as the DB identity key
//   firstName       as the authoritative first name
//   displayLastName for display, plan context, and coach_members.last_name
// Browser-supplied names are never used for DB writes.
function signVerificationToken(gymmasterId, verifiedFirstName, verifiedLastInitial, displayLastName) {
  var secret = process.env.MEMBER_VERIFY_SECRET;
  if (!secret) throw new Error("MEMBER_VERIFY_SECRET is not configured");
  return jwt.sign(
    {
      sub: String(gymmasterId),
      firstName: verifiedFirstName,
      lastInitial: verifiedLastInitial,
      displayLastName: displayLastName,
    },
    secret,
    { expiresIn: VERIFY_TOKEN_TTL }
  );
}

function verifyVerificationToken(req, res) {
  var secret = process.env.MEMBER_VERIFY_SECRET;
  if (!secret) {
    res.status(500).json({ error: "Server configuration error" });
    return null;
  }
  var auth = (req.headers.authorization || "").trim();
  var token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Membership verification required" });
    return null;
  }
  try {
    return jwt.verify(token, secret);
  } catch (err) {
    res.status(401).json({ error: "Verification expired or invalid. Please verify your membership again." });
    return null;
  }
}

// Check-in session token — issued by /weekly-checkin/session.
// Signed with CHECKIN_SESSION_SECRET. Sub is the internal DB member ID.
function signCheckinSession(dbMemberId, gymmasterId, firstName) {
  var secret = process.env.CHECKIN_SESSION_SECRET;
  if (!secret) throw new Error("CHECKIN_SESSION_SECRET is not configured");
  return jwt.sign(
    { sub: String(dbMemberId), gm: String(gymmasterId), fn: firstName },
    secret,
    { expiresIn: CHECKIN_SESSION_TTL }
  );
}

function verifyCheckinToken(req, res) {
  var secret = process.env.CHECKIN_SESSION_SECRET;
  var auth = (req.headers.authorization || "").trim();
  var token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  try {
    return jwt.verify(token, secret);
  } catch (err) {
    res.status(401).json({ error: "Session expired or invalid. Please verify your membership again." });
    return null;
  }
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getModel() {
  return process.env.OPENAI_MODEL || "gpt-4o";
}

// ─── Week start (Monday, America/Denver) ──────────────────────────────────────
//
// Uses Mountain Time so Sunday-evening submissions are not assigned to next week.
// Intl.DateTimeFormat handles MDT/MST automatically.
// No additional dependencies — Node >= 18 ships full ICU data.

function getWeekStart(date) {
  var d = date instanceof Date ? date : new Date();
  var mtDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  // en-CA locale produces "YYYY-MM-DD"
  var parts = mtDateStr.split("-");
  var year  = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10) - 1; // 0-indexed
  var day   = parseInt(parts[2], 10);
  var mt = new Date(year, month, day);
  var dow = mt.getDay(); // 0 = Sunday, 1 = Monday, …, 6 = Saturday
  var diff = dow === 0 ? -6 : 1 - dow;
  mt.setDate(mt.getDate() + diff);
  return mt.getFullYear() + "-" +
    String(mt.getMonth() + 1).padStart(2, "0") + "-" +
    String(mt.getDate()).padStart(2, "0");
}

// ─── Cron secret guard ────────────────────────────────────────────────────────

function requireCronSecret(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── GymMaster email feature flag guard ──────────────────────────────────────

function requireGymMasterEmailEnabled(res) {
  if (process.env.GYMMASTER_WEEKLY_EMAIL_ENABLED !== "true") {
    res.status(503).json({
      configured: false,
      error:
        "GymMaster weekly email sending is disabled until the official communication endpoint is confirmed. " +
        "Set GYMMASTER_WEEKLY_EMAIL_ENABLED=true in Railway only after the adapter is updated and a single-member test succeeds.",
    });
    return false;
  }
  return true;
}

// ─── Trainer summary webhook ──────────────────────────────────────────────────

async function sendTrainerSummaryWebhook(payload) {
  var webhookUrl = process.env.ZAPIER_TRAINER_SUMMARY_WEBHOOK;
  if (!webhookUrl) {
    console.warn("[UGF] ZAPIER_TRAINER_SUMMARY_WEBHOOK not set — skipping trainer notification");
    return { skipped: true };
  }

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 10000);

  try {
    var response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.error("[UGF] Zapier trainer webhook returned " + response.status);
      return { error: "Webhook returned HTTP " + response.status };
    }
    return { ok: true };
  } catch (err) {
    clearTimeout(timeout);
    console.error("[UGF] Zapier trainer webhook failed:", err.message);
    return { error: err.message };
  }
}

// ─── Trainer notification DB helpers ─────────────────────────────────────────
//
// trainer_notification_attempts is incremented BEFORE each webhook attempt
// (at the call site). These helpers only update the outcome columns — they
// do NOT touch the attempt counter.

function markTrainerNotified(dbMemberId, weekStart) {
  db.query(
    "UPDATE weekly_checkins SET " +
    "trainer_notified_at = NOW(), " +
    "trainer_notification_status = 'sent', " +
    "trainer_notification_last_error = NULL, " +
    "trainer_notification_last_attempt_at = NOW() " +
    "WHERE member_id = $1 AND week_start = $2",
    [dbMemberId, weekStart]
  ).catch(function (e) { console.error("[UGF] markTrainerNotified failed:", e.message); });
}

function markTrainerNotificationFailed(dbMemberId, weekStart, errorMsg, isSkipped) {
  var newStatus = isSkipped ? "pending" : "failed";
  var safeError = String(errorMsg || "unknown").slice(0, 200);
  db.query(
    "UPDATE weekly_checkins SET " +
    "trainer_notification_status = $3, " +
    "trainer_notification_last_error = $4, " +
    "trainer_notification_last_attempt_at = NOW() " +
    "WHERE member_id = $1 AND week_start = $2",
    [dbMemberId, weekStart, newStatus, safeError]
  ).catch(function (e) { console.error("[UGF] markTrainerNotificationFailed failed:", e.message); });
}

// ─── AI check-in analysis ─────────────────────────────────────────────────────

var CHECKIN_ANALYSIS_SYSTEM =
  "You are the UGF Weekly Check-In Assistant for Ultimate Goals Fitness.\n" +
  "Review an adult member's current weekly check-in together with their original assessment,\n" +
  "current workout, goals, limitations, and recent check-in history.\n\n" +
  "Your job is to help a real UGF trainer quickly understand:\n" +
  "- adherence,\n- wins,\n- barriers,\n- recovery,\n- pain or safety concerns,\n" +
  "- meaningful trends,\n- and whether a program review is advisable.\n\n" +
  "Do not diagnose medical conditions.\n" +
  "Do not claim medical clearance.\n" +
  "Do not automatically rewrite or modify the member's workout.\n" +
  "Do not recommend training through sharp, severe, unusual, or worsening pain.\n" +
  "Do not guarantee outcomes.\n\n" +
  "Status rules:\n" +
  "GREEN: No meaningful safety concern. Recovery acceptable. Program difficulty appropriate. Adherence generally on track.\n" +
  "YELLOW: Staff review advisable. Examples: recurring discomfort, low recovery, repeated missed workouts, excessive difficulty, requested program change.\n" +
  "RED: Prompt human follow-up needed. Examples: chest pain, fainting, unexplained severe shortness of breath, severe or worsening pain, acute injury.\n" +
  "For RED status, the memberReply must tell the member not to continue the concerning activity and to seek appropriate urgent or professional medical guidance.\n\n" +
  "Return valid JSON only:\n" +
  "{\"status\":\"green\",\"memberReply\":\"string\",\"trainerSummary\":\"string\",\"wins\":[],\"barriers\":[]," +
  "\"adherence\":{\"completed\":0,\"planned\":0,\"summary\":\"string\"}," +
  "\"painFlags\":[],\"recoveryFlags\":[],\"trendNotes\":[],\"suggestedStaffActions\":[]," +
  "\"programReviewRecommended\":false,\"urgentFollowUpRecommended\":false,\"reason\":\"string\"}\n\n" +
  "memberReply: concise, supportive, under 130 words, uses member's first name naturally, " +
  "acknowledges a specific win or difficulty, states clearly when staff review is needed.\n" +
  "trainerSummary: concise factual summary distinguishing member-reported facts from AI suggestions.\n" +
  "The trainerSummary must include a disclaimer: 'AI-generated — requires staff review before any program changes.'";

async function analyzeCheckin(opts) {
  var member = opts.member;
  var responses = opts.responses;
  var latestPlan = opts.latestPlan;
  var profile = opts.profile;
  var recentCheckins = opts.recentCheckins;

  var client = getOpenAI();
  var completion = await client.chat.completions.create({
    model: getModel(),
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CHECKIN_ANALYSIS_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          member: { firstName: member.firstName, lastName: member.lastName },
          currentWeekResponses: responses,
          profile: profile || {},
          recentCheckins: (recentCheckins || []).slice(0, 6),
          currentPlanSummary: latestPlan
            ? latestPlan.slice(0, 2000) + (latestPlan.length > 2000 ? "\n[truncated]" : "")
            : null,
        }),
      },
    ],
  });

  return JSON.parse(completion.choices[0].message.content || "{}");
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", function (_req, res) {
  res.json({ ok: true });
});

// ─── POST /verify-member ──────────────────────────────────────────────────────
//
// Rate-limited: 10 attempts per 15 minutes per IP.
//
// Requires firstName, lastName, AND memberId — all three fields.
// Returns 400 if any field is missing.
//
// Lookup order:
//   1. Find the GymMaster member by exact Member ID.
//   2. Verify the provided firstName matches the GymMaster first name exactly.
//   3. Verify the provided lastName's first character matches the GymMaster last initial.
//   4. Confirm the member is active and not stop-at-gate.
//
// On success, issues a signed verification token (MEMBER_VERIFY_SECRET, 2h TTL)
// containing the canonical GymMaster member ID and the verified name values.
// /coach-message and /generate-personalized-workout both require this token.

app.post("/verify-member", verifyMemberLimiter, async function (req, res) {
  var firstName = (req.body.firstName || "").trim();
  var lastName  = (req.body.lastName  || "").trim();
  var memberId  = (req.body.memberId  || "").trim();

  if (!firstName || !lastName || !memberId) {
    return res.status(400).json({ error: "firstName, lastName, and memberId are required" });
  }

  try {
    var response = await fetch(
      GYMMASTER_BASE + "/members?memberid=" + encodeURIComponent(memberId),
      { headers: gymHeaders() }
    );
    if (!response.ok) {
      console.error("[UGF] GymMaster responded with", response.status);
      return res.status(502).json({ error: "Membership system unavailable" });
    }
    var data = await response.json();
    var list = data.members || data.data || (Array.isArray(data) ? data : []);

    // Step 1: find by exact Member ID — do not search by name.
    var match = list.find(function (m) {
      return String(m.memberid || m.id || m.member_id || "").trim() === memberId;
    });

    if (!match) {
      return res.json({ found: false, active: false });
    }

    // Step 2 & 3: verify name against GymMaster "LastInitial, FirstName" format.
    // Parse without lowercasing so the original GymMaster casing is preserved
    // for the token. Lowercase copies are used only for the comparison.
    var parts = String(match.name || "").split(",").map(function (value) { return value.trim(); });
    var verifiedLastInitial = parts[0] || "";
    var verifiedFirstName   = parts[1] || "";

    if (
      verifiedFirstName.toLowerCase() !== firstName.toLowerCase() ||
      verifiedLastInitial.toLowerCase() !== lastName.slice(0, 1).toLowerCase()
    ) {
      return res.json({ found: false, active: false });
    }

    // Step 4: confirm active, not stop-at-gate.
    if (!isMemberActive(match)) {
      return res.json({ found: true, active: false });
    }

    var canonicalId = String(match.memberid || match.id || match.member_id || "").trim();

    // Token carries GymMaster-confirmed values (firstName, lastInitial) plus the
    // member-entered full last name (displayLastName). The full last name is not
    // confirmed by GymMaster — only its first character was verified against
    // verifiedLastInitial. displayLastName is used for display and staff reports only.
    var verificationToken = signVerificationToken(canonicalId, verifiedFirstName, verifiedLastInitial, lastName);

    return res.json({
      found: true,
      active: true,
      memberId: canonicalId,
      verificationToken: verificationToken,
    });
  } catch (err) {
    console.error("[UGF] verify-member error:", err.message);
    return res.status(500).json({ error: "Verification service error" });
  }
});

// ─── Goals Coach (conversational assessment) ──────────────────────────────────
//
// Rate-limited: 60 requests per hour per IP.
// Requires a valid verification token (MEMBER_VERIFY_SECRET).
// Token supplies the authoritative member name used in the coaching system prompt.

var GOALS_COACH_OPENINGS = [
  "Welcome to Goals Coach. What would you most like your workouts to help you do or feel better?",
  "Let's build around what matters in your life. What result would make training feel worthwhile right now?",
  "We'll keep this practical and make the plan fit your week. What are you hoping to change first?",
  "Start wherever you are today. What would you like to feel more capable of doing?",
  "Your plan should fit your real life, not an ideal week. What would make the biggest difference for you?",
];

function chooseGoalsCoachOpening() {
  return GOALS_COACH_OPENINGS[Math.floor(Math.random() * GOALS_COACH_OPENINGS.length)];
}

var GOALS_COACH_SUMMARY_ENDING =
  "Let me know if I missed anything or if there’s something you’d like to add.";

var GOALS_COACH_SAFETY_REPLY =
  "Please stop any activity that causes the pain or concerning symptom. Before we continue or " +
  "build a workout, contact UGF staff and an appropriate healthcare professional for review. " +
  "If the symptom is severe, worsening, or urgent—or includes chest pain, fainting, severe " +
  "shortness of breath, or stroke-like symptoms—seek urgent medical attention now.";

function ensureGoalsCoachSummaryEnding(reply) {
  var trimmedReply = String(reply || "").trim();
  if (trimmedReply.endsWith(GOALS_COACH_SUMMARY_ENDING)) return trimmedReply;
  return trimmedReply
    ? trimmedReply + "\n\n" + GOALS_COACH_SUMMARY_ENDING
    : GOALS_COACH_SUMMARY_ENDING;
}

function countGoalsCoachMemberAnswers(messages) {
  return messages.reduce(function (count, message) {
    return count + (message && message.role === "user" ? 1 : 0);
  }, 0);
}

function normalizeGoalsCoachSafetyText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hasMeaningfulGoalsCoachSafetyValue(value) {
  if (Array.isArray(value)) {
    return value.some(hasMeaningfulGoalsCoachSafetyValue);
  }

  var text = normalizeGoalsCoachSafetyText(value);
  return Boolean(text) && !/^(?:0|none|no|unknown|not assessed|n\/a|clear to proceed|clear_to_proceed)$/.test(text);
}

function isHistoricalGoalsCoachSafetyText(text) {
  var hasHistoricalContext =
    /\b(?:old|past|previous|historical|history of|years? ago|fully healed|fully recovered)\b/.test(text);
  var hasCurrentConcern =
    /\b(?:current|currently|now|today|still|ongoing|sharp|stiff|stiffness|sore|swollen|numb|tingling|radiating|worsening|concerned|worried|restriction)\b/.test(text);
  return hasHistoricalContext && !hasCurrentConcern;
}

function applyGoalsCoachSafetyText(state, value) {
  var text = normalizeGoalsCoachSafetyText(value);
  if (!text) return;

  var clearsPain =
    /\b(?:no|without)\s+(?:current\s+|ongoing\s+|remaining\s+)?(?:sharp\s+)?(?:pain|pains|soreness)\b/.test(text) ||
    /\b(?:do not|don't)\s+(?:currently\s+)?(?:have|feel|experience)\s+(?:any\s+)?(?:sharp\s+)?(?:pain|pains|soreness)\b/.test(text) ||
    /\b(?:pain|pains|soreness)\b[^.!?]{0,60}\b(?:gone|resolved|cleared|no longer present)\b/.test(text);
  var clearsSymptoms =
    /\b(?:no|without)\s+(?:current\s+|ongoing\s+|concerning\s+)?(?:symptoms?|stiffness|swelling|numbness|tingling|weakness|dizziness)\b/.test(text) ||
    /\b(?:do not|don't)\s+(?:currently\s+)?(?:have|feel|experience)\s+(?:any\s+)?(?:concerning\s+)?(?:symptoms?|stiffness|swelling|numbness|tingling|weakness|dizziness)\b/.test(text) ||
    /\b(?:symptoms?|stiffness|swelling|numbness|tingling|weakness|dizziness)\b[^.!?]{0,60}\b(?:gone|resolved|cleared|no longer present)\b/.test(text);
  var clearsInjury =
    /\b(?:no|without)\s+(?:current\s+|active\s+|recent\s+)?injur(?:y|ies)\b/.test(text) ||
    /\b(?:do not|don't)\s+(?:currently\s+)?have\s+(?:an?\s+)?(?:current\s+|active\s+|recent\s+)?injur(?:y|ies)\b/.test(text) ||
    /\binjur(?:y|ies)\b[^.!?]{0,80}\b(?:fully healed|fully recovered|resolved|cleared)\b/.test(text) ||
    /\b(?:not|no longer) (?:concerned|worried) about[^.!?]{0,40}\binjur(?:y|ies)\b/.test(text);
  var clearsSurgery =
    /\b(?:no|without)\s+(?:current\s+|recent\s+)?surger(?:y|ies)\b/.test(text) ||
    /\b(?:have not|haven't) had\s+(?:a\s+)?(?:current\s+|recent\s+)?surger(?:y|ies)\b/.test(text);
  var clearsRestriction =
    /\b(?:no|without)\s+(?:current\s+)?(?:medical\s+|exercise\s+)?restrictions?\b/.test(text) ||
    /\b(?:do not|don't)\s+(?:currently\s+)?have\s+(?:any\s+)?(?:medical\s+|exercise\s+)?restrictions?\b/.test(text) ||
    /\brestrictions?\b[^.!?]{0,60}\b(?:lifted|resolved|cleared)\b/.test(text);
  var clearsOther =
    /\b(?:no|without)\s+(?:current\s+|other\s+)?safety concerns?\b/.test(text) ||
    /\b(?:do not|don't)\s+(?:currently\s+)?have\s+(?:any\s+)?(?:current\s+|other\s+)?safety concerns?\b/.test(text) ||
    /\b(?:not|no longer) (?:concerned|worried)\b[^.!?]{0,100}\b(?:training|exercise|workout|bending|lifting|injur(?:y|ies))\b/.test(text);

  if (clearsPain) state.pain = false;
  if (clearsSymptoms) state.symptoms = false;
  if (clearsInjury) state.injury = false;
  if (clearsSurgery) state.surgery = false;
  if (clearsRestriction) state.restriction = false;
  if (clearsOther) state.other = false;

  if (isHistoricalGoalsCoachSafetyText(text)) return;

  if (!clearsPain && /\b(?:pain|pains|painful|sharp|sore|soreness)\b/.test(text)) {
    state.pain = true;
  }
  if (!clearsSymptoms && /\b(?:stiff|stiffness|swelling|swollen|numb|numbness|tingling|radiating|weakness|dizzy|dizziness|fainting|shortness of breath|concerning symptoms?)\b/.test(text)) {
    state.symptoms = true;
  }
  if (!clearsInjury && (
    /\b(?:current|active|recent)\s+injur(?:y|ies)\b/.test(text) ||
    /\binjured\b/.test(text) ||
    /\b(?:concerned|worried)\b[^.!?]{0,80}\binjur(?:y|ies)\b/.test(text)
  )) {
    state.injury = true;
  }
  if (!clearsSurgery && (
    /\b(?:current|recent)\s+surger(?:y|ies)\b/.test(text) ||
    /\b(?:had|having|recovering from)\s+(?:a\s+)?surger(?:y|ies)\b/.test(text)
  )) {
    state.surgery = true;
  }
  if (!clearsRestriction && (
    /\b(?:medical|exercise)\s+restrictions?\b/.test(text) ||
    /\bnot\s+(?:medically\s+)?cleared\b/.test(text) ||
    /\bdoctor\b[^.!?]{0,80}\b(?:avoid|restrict|not exercise|not train)\b/.test(text)
  )) {
    state.restriction = true;
  }
  if (!clearsOther && (
    /\bsafety concerns?\b/.test(text) ||
    /\b(?:concerned|worried)\b[^.!?]{0,100}\b(?:training|exercise|workout|bending|lifting|injur(?:y|ies))\b/.test(text)
  )) {
    state.other = true;
  }
}

function getGoalsCoachSafetyState(messages, profile, explicitSafetyStop) {
  var state = {
    pain: false,
    symptoms: false,
    injury: false,
    surgery: false,
    restriction: false,
    other: Boolean(explicitSafetyStop),
  };
  var currentProfile = profile || {};

  if (hasMeaningfulGoalsCoachSafetyValue(currentProfile.painLocations) ||
      hasMeaningfulGoalsCoachSafetyValue(currentProfile.painSeverity)) {
    state.pain = true;
  }
  if (hasMeaningfulGoalsCoachSafetyValue(currentProfile.symptomFlags)) state.symptoms = true;
  applyGoalsCoachSafetyText(state, currentProfile.recentInjuryOrSurgery);
  if (hasMeaningfulGoalsCoachSafetyValue(currentProfile.medicalRestrictions)) state.restriction = true;
  if (hasMeaningfulGoalsCoachSafetyValue(currentProfile.limitations) ||
      hasMeaningfulGoalsCoachSafetyValue(currentProfile.medicalNotes) ||
      hasMeaningfulGoalsCoachSafetyValue(currentProfile.staffReviewReasons)) {
    state.other = true;
  }

  var reviewLevel = normalizeGoalsCoachSafetyText(currentProfile.movementReviewLevel);
  if (reviewLevel && reviewLevel !== "clear_to_proceed" && reviewLevel !== "clear to proceed") {
    state.other = true;
  }

  var movementPatterns = currentProfile.movementPatterns || {};
  Object.keys(movementPatterns).forEach(function (key) {
    var status = normalizeGoalsCoachSafetyText(movementPatterns[key] && movementPatterns[key].status);
    if (status === "painful") state.pain = true;
    if (status === "unsteady") state.other = true;
  });

  (Array.isArray(messages) ? messages : []).forEach(function (message) {
    if (message && message.role === "user") applyGoalsCoachSafetyText(state, message.content);
  });

  var reasons = [];
  if (state.pain) reasons.push("current pain");
  if (state.symptoms) reasons.push("concerning symptom");
  if (state.injury) reasons.push("current injury concern");
  if (state.surgery) reasons.push("recent surgery");
  if (state.restriction) reasons.push("medical or exercise restriction");
  if (state.other) reasons.push("unresolved safety concern");

  return { active: reasons.length > 0, reasons: reasons };
}

function finalizeGoalsCoachResponse(result, fallbackProfile, safetyOverride) {
  var reply = result.reply || "Tell me a little more about that.";
  var phase = result.phase || "assessment";
  var hasSafetyOverride = Boolean(safetyOverride && safetyOverride.active);
  var safetyStop = Boolean(result.safetyStop) || hasSafetyOverride;

  if (hasSafetyOverride) {
    reply = GOALS_COACH_SAFETY_REPLY;
    phase = "assessment";
  }

  var isSummaryMessage = !safetyStop && phase === "summary";

  if (isSummaryMessage) reply = ensureGoalsCoachSummaryEnding(reply);

  return {
    reply: reply,
    phase: phase,
    profile: result.profile || fallbackProfile || {},
    readyToGenerate: !safetyStop && !isSummaryMessage && Boolean(result.readyToGenerate),
    safetyStop: safetyStop,
  };
}

var COACH_SYSTEM =
  "You are Goals Coach, the digital coaching experience for Ultimate Goals Fitness,\n" +
  "a friendly and approachable 24/7 gym community in the Black Hills of South Dakota.\n" +
  "Help members move better, hurt less, stay capable for life, and pursue goals such\n" +
  "as fat loss, muscle gain, confidence, and endurance.\n\n" +
  "Sound like a practical gym coach: friendly, direct, observant, honest, occasionally\n" +
  "funny, and easy to talk to.\n" +
  "You are not a therapist, doctor, lecturer, salesperson, or corporate chatbot.\n\n" +
  "CONVERSATION STANDARD\n" +
  "This must never feel like a test, an intake form, a sales pitch, or a computer collecting fields.\n" +
  "Begin with the outcome the member wants, then collect only the missing facts needed for\n" +
  "safe, responsible programming. Adapt the order to what the member has already shared.\n" +
  "For an uncomplicated member, about five member answers is the normal target before\n" +
  "you automatically present the summary. This is a target, not a hard safety cap.\n" +
  "Continue past that point only when a missing answer could materially change safety,\n" +
  "exercise selection, workout schedule or duration, available equipment, or adherence design.\n" +
  "Do not keep interviewing to complete every profile field. Preserve unasked or unanswered\n" +
  "information as unknown, an empty value, or not assessed. Never infer a detail from silence.\n\n" +
  "HOW TO RESPOND\n" +
  "Keep most replies to one to three short sentences. Ask no more than ONE natural question.\n" +
  "A summary, confirmation, or safety response may contain no question.\n" +
  "Do not automatically praise, thank, reassure, validate, or paraphrase after every answer.\n" +
  "Acknowledge a detail only when it helps clarify the plan, shows useful continuity, or responds\n" +
  "to something significant. Keep it brief and specific when you do.\n" +
  "Do not use therapy-style reflection, emotional interpretation, or counseling language.\n" +
  "Ask a follow-up only when its answer could materially change safety, exercise selection,\n" +
  "workout schedule or duration, available equipment, or adherence design.\n" +
  "Do not ask compound or two-part questions. Do not present a questionnaire, checklist, or list of questions.\n" +
  "Do not repeat a question the member has already answered in the conversation or current profile.\n" +
  "Preserve what is already known, skip anything already answered, and ask only for the most useful missing detail.\n" +
  "Refer back to the member's own details when they affect the next question, summary, or plan.\n\n" +
  "YOUR PERSONALITY\n" +
  "- Friendly, calm, confident, practical, approachable, and down-to-earth.\n" +
  "- Use plain conversational English.\n" +
  "- Sound human, not polished to the point of being robotic.\n" +
  "- Use the member's first name occasionally, but not in every response.\n" +
  "- Do not call yourself AI or mention a bot, assistant, model, or algorithm.\n" +
  "- Use light humor when the member clearly invites it.\n" +
  "- Never mock, embarrass, shame, or judge the member.\n" +
  "- Do not overexplain, over-comfort, or sound like a therapist.\n" +
  "- Do not repeatedly begin with 'Thanks for sharing,' 'That makes sense,' 'Let's explore that,' or 'I appreciate your honesty.'\n" +
  "- Avoid robotic phrases such as 'Based on the information provided,' 'What specific goal would you like to achieve?' or 'Can you elaborate?'\n\n" +
  "COMMON ROADBLOCKS AND LIFE CONTEXT\n" +
  "Recognize and respond naturally when a member mentions lack of time, exhaustion,\n" +
  "gym intimidation, needing accountability, old injuries or fear of reinjury, pregnancy,\n" +
  "postpartum life, military transition, reduced mobility, or a disrupted routine.\n" +
  "Respond to the practical constraint without treating it as a lack of discipline or turning\n" +
  "the exchange into counseling. Ask about it only if the answer changes adherence design.\n" +
  "For pregnancy, postpartum life, old injuries, or reduced mobility, continue to follow all\n" +
  "pain-safety, staff-review, and medical-review rules below.\n\n" +
  "FOCUSED ASSESSMENT FLOW\n" +
  "Use the member's desired outcome to decide what is relevant. Before any normal summary or\n" +
  "readyToGenerate=true, you MUST establish from the member's own words the presence or absence\n" +
  "of each of these current concerns:\n" +
  "- pain or concerning symptoms\n" +
  "- an injury\n" +
  "- a recent surgery\n" +
  "- a medical or exercise restriction\n" +
  "- another safety concern that could affect training\n" +
  "The member may provide this information voluntarily. Use what they already supplied and do not\n" +
  "ask them to repeat any category already established. If any category remains unresolved, ask\n" +
  "ONE concise safety-screening question limited to the missing information. When none is known, ask:\n" +
  "'Before I wrap this up, is there any current pain, concerning symptom, injury, recent surgery,\n" +
  "medical or exercise restriction, or anything else that could affect your training?'\n" +
  "Do not treat silence, omission, empty or default profile values, unknown, not assessed, or the\n" +
  "lack of a reported problem as an answer. Silence is not safety clearance. The five-answer target\n" +
  "never overrides unresolved safety screening. Continue until it is resolved unless a safety stop\n" +
  "ends the assessment. This screen does not require the long movement questionnaire. Ask individual\n" +
  "movement-pattern questions only when they materially affect programming or safety.\n" +
  "Any disclosed current pain, sharp pain, concerning symptom, current injury concern, recent\n" +
  "surgery, medical or exercise restriction, or unresolved safety concern MUST set safetyStop=true.\n" +
  "Historical injury alone may be non-blocking when it is fully resolved and has no current symptom\n" +
  "or concern. A later answer about a different category, such as no recent surgery, does not erase\n" +
  "an earlier current-pain disclosure. Keep the safety stop active until that concern is explicitly resolved.\n" +
  "Use the established safety information to decide whether a safety stop, professional review,\n" +
  "exercise modification, or staff review is required.\n" +
  "Then collect the smallest useful set of schedule, duration, equipment, experience, preference,\n" +
  "and adherence facts. Do not assess every movement pattern when it will not change the plan.\n" +
  "If the member volunteers several useful facts at once, record them and skip those questions.\n\n" +
  "HOW TO ASK MOVEMENT QUESTIONS\n" +
  "Use ordinary language, not clinical jargon. Examples:\n" +
  "- Can you get down to the floor and back up without using furniture or feeling unsteady?\n" +
  "- When you sit into a chair or stand back up, does anything hurt, feel weak, or shift to one side?\n" +
  "- Can you reach both arms overhead comfortably without arching your back or shrugging?\n" +
  "- Does bending to pick something up feel natural, stiff, or painful?\n" +
  "- Can you stand on each leg for about ten seconds near a stable support?\n" +
  "- Does turning to look behind you feel about the same in both directions?\n" +
  "Never instruct a member to perform a movement that feels unsafe.\n\n" +
  "MOVEMENT CLASSIFICATION\n" +
  "Based only on the member's self-report, classify each area as:\n" +
  "- comfortable\n" +
  "- limited\n" +
  "- painful\n" +
  "- unsteady\n" +
  "- not assessed\n" +
  "These are coaching observations, not diagnoses.\n" +
  "Set movementReviewLevel to one of:\n" +
  "- clear_to_proceed\n" +
  "- modify_and_monitor\n" +
  "- staff_review_recommended\n" +
  "- medical_review_recommended\n\n" +
  "SAFETY\n" +
  "- Do not diagnose medical conditions or claim medical clearance.\n" +
  "- Do not recommend working through sharp, severe, unusual, or worsening pain.\n" +
  "- Treat numbness, tingling, radiating pain, recent significant injury, recent surgery, unexplained weakness, or repeated falls as staff-review or medical-review concerns.\n" +
  "- If the member reports chest pain, fainting, unexplained severe shortness of breath, stroke-like symptoms, or another urgent warning sign, stop the assessment, advise appropriate urgent medical attention, and set safetyStop=true.\n" +
  "- If a concern is not urgent but warrants professional review, explain that clearly without alarming the member.\n\n" +
  "CONVERSATION GOALS\n" +
  "Learn enough to build a safe, useful plan around the member's actual outcome, relevant\n" +
  "movement or health constraints, realistic training time, equipment, and adherence needs.\n" +
  "Other fields are optional unless they would materially change the program.\n\n" +
  "SUMMARY PHASE\n" +
  "Do not enter the normal summary phase or set readyToGenerate=true until the required pre-summary\n" +
  "safety screen is complete. Urgent safety-stop and professional-review rules take precedence.\n" +
  "When enough material information has been collected, automatically provide a concise summary.\n" +
  "Do not ask permission to present it and do not add another assessment question first.\n" +
  "Summarize the member's goal, relevant movement or safety information, realistic schedule,\n" +
  "equipment, and adherence needs using only facts the member actually provided.\n" +
  "Do not fill gaps or make a complete-looking story from assumptions. Preserve missing details\n" +
  "as unknown or not assessed, and mention an unknown only when it matters to safety or the plan.\n" +
  "Clearly mention any staff-review or medical-review recommendation.\n" +
  "Set phase to summary and end exactly with: \"" + GOALS_COACH_SUMMARY_ENDING + "\"\n" +
  "If the member corrects the summary, update the profile and automatically present the corrected\n" +
  "summary with the same exact ending. Do not defend the earlier summary or retain the old detail.\n" +
  "Only set readyToGenerate=true AFTER the member explicitly confirms the summary in a later message.\n\n" +
  "JSON RESPONSE\n" +
  "Return valid JSON only with this structure:\n" +
  "{\"reply\":\"string\",\"phase\":\"movement|goals|lifestyle|summary|confirmed\",\"profile\":{\"functionalGoal\":\"\",\"dailyFunctionChallenges\":[],\"painLocations\":[],\"painSeverity\":\"\",\"symptomFlags\":[],\"recentInjuryOrSurgery\":\"\",\"medicalRestrictions\":[],\"movementPatterns\":{\"floorTransfer\":{\"status\":\"not assessed\",\"notes\":\"\"},\"walkingAndStairs\":{\"status\":\"not assessed\",\"notes\":\"\"},\"squatToChair\":{\"status\":\"not assessed\",\"notes\":\"\"},\"hipHinge\":{\"status\":\"not assessed\",\"notes\":\"\"},\"overheadReach\":{\"status\":\"not assessed\",\"notes\":\"\"},\"torsoRotation\":{\"status\":\"not assessed\",\"notes\":\"\"},\"singleLegBalance\":{\"status\":\"not assessed\",\"notes\":\"\"},\"carrying\":{\"status\":\"not assessed\",\"notes\":\"\"}},\"movementPriorities\":[],\"movementReviewLevel\":\"clear_to_proceed\",\"staffReviewReasons\":[],\"primaryGoal\":\"\",\"desiredOutcome\":\"\",\"timeline\":\"\",\"motivation\":\"\",\"barriers\":[],\"daysPerWeek\":\"\",\"sessionLength\":\"\",\"experience\":\"\",\"preferences\":[],\"dislikes\":[],\"outsideActivity\":\"\",\"sleep\":\"\",\"stress\":\"\",\"location\":\"\",\"equipment\":[],\"limitations\":[],\"medicalNotes\":[],\"confidence\":\"\",\"additionalContext\":\"\"},\"readyToGenerate\":false,\"safetyStop\":false}\n" +
  "Preserve all previously known profile values. Use empty strings, empty arrays, or not assessed for unknown values. Never return Markdown outside the JSON object.";

app.post("/coach-message", coachMessageLimiter, async function (req, res) {
  // Requires a valid verification token. Token supplies the authoritative name
  // used in the coaching system prompt — browser-supplied member fields are not used.
  var verifyPayload = verifyVerificationToken(req, res);
  if (!verifyPayload) return;

  var tokenFirstName       = verifyPayload.firstName;
  var tokenDisplayLastName = verifyPayload.displayLastName || "";

  var messages = req.body.messages;
  var profile  = req.body.profile;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array is required" });
  }

  // A new coaching session receives one of several approved openings. This keeps
  // the welcome warm and natural without relying on uncontrolled AI variation.
  if (messages.length === 0) {
    return res.json({
      reply: chooseGoalsCoachOpening(),
      phase: "connection",
      profile: profile || {},
      readyToGenerate: false,
      safetyStop: false,
    });
  }

  var requestSafetyState = getGoalsCoachSafetyState(messages, profile, req.body.safetyStop);
  if (requestSafetyState.active) {
    return res.json(finalizeGoalsCoachResponse({
      reply: GOALS_COACH_SAFETY_REPLY,
      phase: "assessment",
      profile: profile || {},
      readyToGenerate: false,
      safetyStop: true,
    }, profile, requestSafetyState));
  }

  try {
    var client = getOpenAI();
    var memberAnswerCount = countGoalsCoachMemberAnswers(messages);
    var systemMessages = [
      { role: "system", content: COACH_SYSTEM },
      {
        role: "system",
        content: "Member: " + tokenFirstName + " " + tokenDisplayLastName +
          "\nCurrent profile:\n" + JSON.stringify(profile || {}, null, 2),
      },
      {
        role: "system",
        content: "Assessment progress: the member has provided " + memberAnswerCount +
          " answer(s). Around five answers is the normal uncomplicated-member target, not a hard cap. " +
          "Required safety screening must be established from the member's own words before summary " +
          "or plan readiness; silence and empty or default profile fields are not safety clearance, " +
          "and the five-answer target cannot override unresolved safety screening. If the safety " +
          "screen and material programming facts are sufficient, present the summary now. Otherwise " +
          "ask only the single most material missing question.",
      },
    ];

    var completion = await client.chat.completions.create({
      model: getModel(),
      temperature: 0.7,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: systemMessages.concat(messages.slice(-30)),
    });

    var result = JSON.parse(completion.choices[0].message.content || "{}");
    return res.json(finalizeGoalsCoachResponse(result, profile));
  } catch (err) {
    console.error("[UGF] coach-message error:", err.message);
    return res.status(500).json({ error: "The coach is temporarily unavailable." });
  }
});

// ─── POST /generate-personalized-workout ──────────────────────────────────────
//
// Requires a valid verification token (MEMBER_VERIFY_SECRET).
// Responds 401 for missing, expired, or invalid tokens.
//
// The GymMaster member ID and verified name come from the token — browser-supplied
// values are never used for DB writes or as plan context.
//
// The coach_members upsert and coach_plans insert run in a transaction before the
// response is sent. If the DB save fails, a 500 error is returned — the plan is
// not returned without a saved history record.

var PLAN_SYSTEM =
  "You are a certified fitness professional writing a movement-first workout plan for an Ultimate Goals Fitness member.\n\n" +
  "The primary purpose is to help the member move better, hurt less, remain capable for life, and safely pursue their fitness goals.\n" +
  "Write like a UGF coach who listened carefully. Be specific, practical, encouraging, and conservative around limitations.\n\n" +
  "RULES\n" +
  "- Do not diagnose, claim medical clearance, or present self-reported movement observations as a clinical assessment.\n" +
  "- Do not guarantee pain relief, fat loss, muscle gain, or other outcomes.\n" +
  "- Do not prescribe through sharp, severe, unusual, radiating, or worsening pain.\n" +
  "- If movementReviewLevel is medical_review_recommended, do not provide a normal training plan. Provide a conservative pause-and-referral plan with gentle general activity only when appropriate.\n" +
  "- If movementReviewLevel is staff_review_recommended, clearly label the plan as requiring UGF staff review before the member begins.\n" +
  "- Build exercise selection around reported movement comfort, limitations, balance, side-to-side differences, daily-function goals, and available equipment.\n" +
  "- Include regressions and substitutions for every movement marked limited, painful, or unsteady.\n" +
  "- Use only facts explicitly supported by the member's profile or conversation. Treat missing, empty, ambiguous, or conflicting information as unknown or not assessed.\n" +
  "- Never invent personal, movement, schedule, limitation, equipment, or preference details.\n" +
  "- Connect program choices to the member's answers only when the supporting fact is present. Do not force a numeric count of personalized connections.\n" +
  "- When available days or session length are known, match them. Otherwise label the schedule assumption as unknown and avoid false personalization.\n" +
  "- Nutrition content is general education only.\n" +
  "- Use Markdown.\n\n" +
  "PROGRAMMING PRIORITIES\n" +
  "1. Address the member's functional goal and highest-priority movement limitations.\n" +
  "2. Use a short movement-preparation block before strength or conditioning.\n" +
  "3. Train foundational patterns only within a comfortable, controlled range.\n" +
  "4. Progress control and confidence before load, speed, complexity, or range.\n" +
  "5. Include balance or stability work when relevant.\n" +
  "6. Keep the plan achievable enough to support consistency.\n\n" +
  "STRUCTURE\n" +
  "# [First Name]'s UGF Game Plan\n" +
  "## What I Heard From You\n" +
  "Lead with functional goals, movement comfort, limitations, and safety notes; then summarize fitness goals and schedule.\n" +
  "## Movement and Function Priorities\n" +
  "List the top 2-4 priorities and explain why they matter in plain language.\n" +
  "## Staff Review Status\n" +
  "State clear to proceed, modify and monitor, staff review recommended, or medical review recommended.\n" +
  "## Why This Plan Fits You\n" +
  "## Your Weekly Schedule\n" +
  "## Movement Preparation\n" +
  "Create a 5-10 minute preparation sequence tied directly to the member's needs.\n" +
  "## Workout Details\n" +
  "Use one table per day: | Exercise | Sets | Reps / Time | Rest | Effort | Coaching Cue | Modification |\n" +
  "## Daily Function Practice\n" +
  "Include 1-3 practical activities that support real-life capability.\n" +
  "## Progression for the First Four Weeks\n" +
  "Progress range, control, repetitions, duration, then resistance.\n" +
  "## Cardio and Daily Movement\n" +
  "## Recovery\n" +
  "## General Nutrition Guidance\n" +
  "## When to Pause and Ask for Help\n" +
  "Include clear stop rules and when to contact UGF staff or a healthcare professional.\n" +
  "## Reassessment\n" +
  "Recommend reassessing movement comfort and function in 4 weeks.\n" +
  "Close with a grounded UGF message.";

app.post("/generate-personalized-workout", async function (req, res) {
  var verifyPayload = verifyVerificationToken(req, res);
  if (!verifyPayload) return;

  // All identity values come from the token — not from the request body.
  var gymmasterId      = verifyPayload.sub;
  var verifiedFirstName  = verifyPayload.firstName;
  var verifiedLastInitial = verifyPayload.lastInitial || "";
  var displayLastName  = verifyPayload.displayLastName || "";

  var profile  = req.body.profile;
  var messages = req.body.messages;

  if (!profile) {
    return res.status(400).json({ error: "profile is required" });
  }

  var planSafetyState = getGoalsCoachSafetyState(messages, profile, req.body.safetyStop);
  if (planSafetyState.active) {
    return res.status(409).json({
      error: GOALS_COACH_SAFETY_REPLY,
      readyToGenerate: false,
      safetyStop: true,
    });
  }

  try {
    var client = getOpenAI();
    var completion = await client.chat.completions.create({
      model: getModel(),
      temperature: 0.45,
      max_tokens: 4096,
      messages: [
        { role: "system", content: PLAN_SYSTEM },
        {
          role: "user",
          content: "Create the plan.\n\nMEMBER\n" +
            JSON.stringify({ firstName: verifiedFirstName, lastName: displayLastName }, null, 2) +
            "\n\nPROFILE\n" + JSON.stringify(profile, null, 2) +
            "\n\nCONVERSATION\n" + JSON.stringify((messages || []).slice(-30), null, 2),
        },
      ],
    });

    var plan = completion.choices[0].message.content;
    if (!plan) throw new Error("No plan returned from OpenAI");

    // Save to DB before responding. Uses a transaction so that coach_members and
    // coach_plans are always written together. If the save fails, return an error
    // rather than returning a plan the member cannot later retrieve.
    var dbClient = await db.connect();
    try {
      await dbClient.query("BEGIN");

      var upsertResult = await dbClient.query(
        "INSERT INTO coach_members (gymmaster_member_id, first_name, last_name) " +
        "VALUES ($1, $2, $3) ON CONFLICT (gymmaster_member_id) DO UPDATE SET " +
        "first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, updated_at = NOW() RETURNING id",
        [gymmasterId, verifiedFirstName, displayLastName]
      );
      var dbMemberId = upsertResult.rows[0] && upsertResult.rows[0].id;
      if (!dbMemberId) throw new Error("coach_members upsert did not return an id");

      await dbClient.query(
        "INSERT INTO coach_plans (member_id, profile_json, assessment_messages, plan_markdown) VALUES ($1, $2, $3, $4)",
        [dbMemberId, JSON.stringify(profile), JSON.stringify((messages || []).slice(-60)), plan]
      );

      await dbClient.query("COMMIT");
    } catch (dbErr) {
      await dbClient.query("ROLLBACK").catch(function () {});
      console.error("[UGF] Failed to save plan:", dbErr.message);
      return res.status(500).json({
        error: "Your plan was generated but could not be saved. Please try again.",
      });
    } finally {
      dbClient.release();
    }

    return res.json({ plan: plan });
  } catch (err) {
    console.error("[UGF] generate-personalized-workout error:", err.message);
    return res.status(500).json({ error: "Plan generation failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY CHECK-IN SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /weekly-checkin/session ─────────────────────────────────────────────
// Verifies member via GymMaster Gatekeeper (by Member ID, then name check),
// upserts coach_members, issues JWT check-in session token.

app.post("/weekly-checkin/session", checkinSessionLimiter, async function (req, res) {
  var firstName = (req.body.firstName || "").trim();
  var lastName  = (req.body.lastName  || "").trim();
  var memberId  = (req.body.memberId  || "").trim();

  if (!firstName || !lastName || !memberId) {
    return res.status(400).json({ error: "firstName, lastName, and memberId are required" });
  }

  try {
    var gmRes = await fetch(GYMMASTER_BASE + "/members?memberid=" + encodeURIComponent(memberId), { headers: gymHeaders() });
    if (!gmRes.ok) {
      console.error("[UGF] GymMaster responded with", gmRes.status);
      return res.status(502).json({ error: "Membership system unavailable. Please try again shortly." });
    }
    var gmData = await gmRes.json();
    var list = gmData.members || gmData.data || (Array.isArray(gmData) ? gmData : []);

    // Find by exact Member ID first
    var match = list.find(function (m) {
      return String(m.memberid || m.id || m.member_id || "").trim() === memberId;
    });

    if (!match) return res.json({ found: false, active: false });

    // Verify name — GymMaster format "LastInitial, FirstName"
    var parts = (match.name || "").split(",").map(function (s) { return s.trim(); });
    var apiLastInitial = (parts[0] || "").toLowerCase();
    var apiFirstName   = (parts[1] || "").toLowerCase();

    if (
      apiFirstName !== firstName.toLowerCase() ||
      apiLastInitial !== lastName.slice(0, 1).toLowerCase()
    ) {
      return res.json({ found: false, active: false });
    }

    if (!isMemberActive(match)) {
      return res.json({ found: true, active: false });
    }

    // Upsert coach_members keyed by verified GymMaster ID
    var upsertResult = await db.query(
      "INSERT INTO coach_members (gymmaster_member_id, first_name, last_name) " +
      "VALUES ($1, $2, $3) ON CONFLICT (gymmaster_member_id) DO UPDATE SET " +
      "first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, updated_at = NOW() RETURNING id",
      [memberId, firstName, lastName]
    );
    var dbMemberId = upsertResult.rows[0].id;

    // Load latest plan for plannedDaysPerWeek
    var planResult = await db.query(
      "SELECT profile_json, created_at FROM coach_plans WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1",
      [dbMemberId]
    );
    var latestPlan = planResult.rows[0] || null;
    var plannedDaysPerWeek = null;
    if (latestPlan && latestPlan.profile_json) {
      var profile = typeof latestPlan.profile_json === "string"
        ? JSON.parse(latestPlan.profile_json)
        : latestPlan.profile_json;
      plannedDaysPerWeek = profile.daysPerWeek || null;
    }

    // Check for existing submission this week (Mountain Time boundary)
    var weekStart = getWeekStart(new Date());
    var existingCheckin = await db.query(
      "SELECT id FROM weekly_checkins WHERE member_id = $1 AND week_start = $2",
      [dbMemberId, weekStart]
    );

    var sessionToken = signCheckinSession(dbMemberId, memberId, firstName);

    return res.json({
      found: true,
      active: true,
      sessionToken: sessionToken,
      firstName: firstName,
      planDate: latestPlan ? latestPlan.created_at : null,
      plannedDaysPerWeek: plannedDaysPerWeek,
      alreadySubmitted: existingCheckin.rows.length > 0,
      weekStart: weekStart,
    });
  } catch (err) {
    console.error("[UGF] weekly-checkin/session error:", err.message);
    return res.status(500).json({ error: "Verification service error. Please try again." });
  }
});

// ─── GET /weekly-checkin/context ──────────────────────────────────────────────
// Returns latest plan and recent check-ins for the authenticated member.

app.get("/weekly-checkin/context", async function (req, res) {
  var payload = verifyCheckinToken(req, res);
  if (!payload) return;

  var dbMemberId = parseInt(payload.sub, 10);
  if (!dbMemberId) return res.status(400).json({ error: "Invalid session" });

  try {
    var planResult = await db.query(
      "SELECT profile_json, plan_markdown, created_at FROM coach_plans WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1",
      [dbMemberId]
    );
    var plan = planResult.rows[0] || null;

    var checkinResult = await db.query(
      "SELECT week_start, status, member_reply, responses_json, created_at " +
      "FROM weekly_checkins WHERE member_id = $1 ORDER BY week_start DESC LIMIT 6",
      [dbMemberId]
    );

    return res.json({
      hasPlan: !!plan,
      planDate: plan ? plan.created_at : null,
      profile: plan
        ? (typeof plan.profile_json === "string" ? JSON.parse(plan.profile_json) : plan.profile_json)
        : {},
      recentCheckins: checkinResult.rows,
    });
  } catch (err) {
    console.error("[UGF] weekly-checkin/context error:", err.message);
    return res.status(500).json({ error: "Could not load check-in context" });
  }
});

// ─── POST /weekly-checkin/submit ──────────────────────────────────────────────
// Validates responses, runs AI analysis, saves to DB (DB-first), fires Zapier
// non-blocking. A failed webhook never rolls back the check-in record.
// trainer_notification_attempts is incremented immediately before each webhook.

app.post("/weekly-checkin/submit", checkinSubmitLimiter, async function (req, res) {
  var payload = verifyCheckinToken(req, res);
  if (!payload) return;

  var dbMemberId   = parseInt(payload.sub, 10);
  var gymmasterId  = payload.gm;
  var firstName    = payload.fn;

  var responses = req.body.responses;
  if (!responses) return res.status(400).json({ error: "responses is required" });

  var workoutsCompleted = responses.workoutsCompleted;
  var difficulty        = responses.difficulty;
  var energy            = responses.energy;
  var sleep             = responses.sleep;
  var soreness          = responses.soreness;
  var physicalConcern   = responses.physicalConcern;
  var win               = (responses.win || "").trim();

  if (
    typeof workoutsCompleted !== "number" || workoutsCompleted < 0 ||
    typeof difficulty        !== "number" || difficulty < 1 || difficulty > 10 ||
    typeof energy            !== "number" || energy < 1    || energy > 10    ||
    typeof sleep             !== "number" || sleep < 1     || sleep > 10     ||
    typeof soreness          !== "number" || soreness < 0  || soreness > 10  ||
    typeof physicalConcern !== "boolean" ||
    !win
  ) {
    return res.status(400).json({ error: "All required fields must be completed" });
  }

  if (physicalConcern && !(responses.physicalConcernDetails || "").trim()) {
    return res.status(400).json({ error: "Please describe the physical concern" });
  }

  try {
    var weekStart = getWeekStart(new Date());

    // Prevent duplicate weekly submission
    var existing = await db.query(
      "SELECT id FROM weekly_checkins WHERE member_id = $1 AND week_start = $2",
      [dbMemberId, weekStart]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "You have already submitted a check-in for this week." });
    }

    var memberResult = await db.query(
      "SELECT first_name, last_name FROM coach_members WHERE id = $1",
      [dbMemberId]
    );
    var memberRow = memberResult.rows[0];
    if (!memberRow) return res.status(404).json({ error: "Member not found" });

    var planResult = await db.query(
      "SELECT profile_json, plan_markdown FROM coach_plans WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1",
      [dbMemberId]
    );
    var planRow = planResult.rows[0] || null;

    var recentResult = await db.query(
      "SELECT week_start, status, responses_json FROM weekly_checkins WHERE member_id = $1 ORDER BY week_start DESC LIMIT 6",
      [dbMemberId]
    );

    // Sanitize and cap all text inputs before storing
    var safeResponses = {
      workoutsCompleted: workoutsCompleted,
      difficulty: difficulty,
      energy: energy,
      sleep: sleep,
      soreness: soreness,
      physicalConcern: physicalConcern,
      physicalConcernDetails: physicalConcern
        ? (responses.physicalConcernDetails || "").slice(0, 1000)
        : null,
      win: win.slice(0, 2000),
      challenge: (responses.challenge || "").trim().slice(0, 2000) || null,
      requestedAdjustment: (responses.requestedAdjustment || "").trim().slice(0, 2000) || null,
    };

    var analysis = await analyzeCheckin({
      member: { firstName: memberRow.first_name, lastName: memberRow.last_name },
      responses: safeResponses,
      profile: planRow
        ? (typeof planRow.profile_json === "string"
            ? JSON.parse(planRow.profile_json)
            : planRow.profile_json)
        : {},
      latestPlan: planRow ? planRow.plan_markdown : null,
      recentCheckins: recentResult.rows,
    });

    var status         = ["green", "yellow", "red"].includes(analysis.status) ? analysis.status : "green";
    var memberReply    = analysis.memberReply || "Thanks for checking in — your trainer will review this shortly.";
    var trainerSummary = analysis.trainerSummary || "";

    // DB commit before responding. trainer_notification_status defaults to 'pending'.
    // A failed webhook never rolls back this record.
    await db.query(
      "INSERT INTO weekly_checkins " +
      "(member_id, week_start, responses_json, ai_analysis_json, member_reply, trainer_summary, status, trainer_notification_status) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')",
      [
        dbMemberId, weekStart,
        JSON.stringify(safeResponses),
        JSON.stringify(analysis),
        memberReply, trainerSummary, status,
      ]
    );

    // Respond to the member now — webhook fires non-blocking below.
    res.json({ status: status, memberReply: memberReply });

    // Pre-increment attempt count before the webhook fires, then update
    // status-only fields after the result is known.
    var webhookPayload = {
      type: "trainer_summary",
      trainerEmail: "staff@ugf.club",
      memberName: memberRow.first_name + " " + memberRow.last_name,
      memberId: gymmasterId,
      weekStart: weekStart,
      status: status,
      trainerSummary: trainerSummary,
      wins: analysis.wins || [],
      barriers: analysis.barriers || [],
      adherence: analysis.adherence || { completed: workoutsCompleted, planned: 0, summary: "" },
      painFlags: analysis.painFlags || [],
      recoveryFlags: analysis.recoveryFlags || [],
      trendNotes: analysis.trendNotes || [],
      suggestedStaffActions: analysis.suggestedStaffActions || [],
      programReviewRecommended: Boolean(analysis.programReviewRecommended),
      urgentFollowUpRecommended: Boolean(analysis.urgentFollowUpRecommended),
    };

    db.query(
      "UPDATE weekly_checkins SET " +
      "trainer_notification_attempts = trainer_notification_attempts + 1, " +
      "trainer_notification_last_attempt_at = NOW() " +
      "WHERE member_id = $1 AND week_start = $2",
      [dbMemberId, weekStart]
    ).then(function () {
      return sendTrainerSummaryWebhook(webhookPayload);
    }).then(function (result) {
      if (result && !result.error && !result.skipped) {
        markTrainerNotified(dbMemberId, weekStart);
      } else {
        markTrainerNotificationFailed(
          dbMemberId,
          weekStart,
          (result && result.error) ? result.error : "webhook_not_configured",
          !!(result && result.skipped)
        );
      }
    }).catch(function (err) {
      console.error("[UGF] trainer notification chain error:", err.message);
    });

  } catch (err) {
    console.error("[UGF] weekly-checkin/submit error:", err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Could not process your check-in. Please try again." });
    }
  }
});

// ─── POST /admin/send-weekly-checkins ─────────────────────────────────────────
// Protected by X-Cron-Secret and GYMMASTER_WEEKLY_EMAIL_ENABLED flag.
// Reverifies all members against GymMaster before sending — skips inactive,
// missing, blocked, or stop-at-gate members.

app.post("/admin/send-weekly-checkins", async function (req, res) {
  if (!requireCronSecret(req, res)) return;
  if (!requireGymMasterEmailEnabled(res)) return;

  var weekStart = getWeekStart(new Date());
  var attempted = 0, sent = 0, skipped = 0, failed = 0;

  try {
    // Fetch all GymMaster members once to avoid N individual API calls.
    var gmAllRes = await fetch(GYMMASTER_BASE + "/members", { headers: gymHeaders() });
    if (!gmAllRes.ok) {
      return res.status(502).json({
        error: "GymMaster unavailable — cannot reverify members before sending. No emails sent.",
        weekStart: weekStart,
      });
    }
    var gmAllData = await gmAllRes.json();
    var gmList = gmAllData.members || gmAllData.data || (Array.isArray(gmAllData) ? gmAllData : []);

    // Build a Set of active GymMaster member IDs for O(1) per-member lookup
    var activeGymMasterIds = new Set();
    for (var g = 0; g < gmList.length; g++) {
      if (isMemberActive(gmList[g])) {
        var gId = String(gmList[g].id || gmList[g].member_id || "").trim();
        if (gId) activeGymMasterIds.add(gId);
      }
    }

    var membersResult = await db.query(
      "SELECT cm.id, cm.gymmaster_member_id, cm.first_name, cm.last_name " +
      "FROM coach_members cm " +
      "WHERE EXISTS (SELECT 1 FROM coach_plans cp WHERE cp.member_id = cm.id)"
    );

    for (var i = 0; i < membersResult.rows.length; i++) {
      var member = membersResult.rows[i];
      attempted++;

      // Skip if not currently active in GymMaster
      if (!activeGymMasterIds.has(String(member.gymmaster_member_id).trim())) {
        skipped++;
        continue;
      }

      // Skip if already sent this week
      var alreadySent = await db.query(
        "SELECT id FROM checkin_email_log WHERE member_id = $1 AND week_start = $2",
        [member.id, weekStart]
      );
      if (alreadySent.rows.length > 0) {
        skipped++;
        continue;
      }

      var deliveryStatus = "failed";
      var providerResponse = null;

      try {
        var result = await sendGymMasterWeeklyCheckinEmail({
          memberId: member.gymmaster_member_id,
          templateId: process.env.GYMMASTER_WEEKLY_CHECKIN_TEMPLATE_ID,
        });

        if (result && result.configured === false) {
          deliveryStatus = "not_configured";
          providerResponse = { error: result.error };
          failed++;
        } else {
          deliveryStatus = "sent";
          providerResponse = {};
          sent++;
        }
      } catch (emailErr) {
        console.error("[UGF] check-in email failed for member " + member.id);
        providerResponse = { error: emailErr.message.slice(0, 200) };
        failed++;
      }

      await db.query(
        "INSERT INTO checkin_email_log (member_id, week_start, gymmaster_template_id, delivery_status, provider_response, sent_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (member_id, week_start) DO NOTHING",
        [
          member.id, weekStart,
          process.env.GYMMASTER_WEEKLY_CHECKIN_TEMPLATE_ID || null,
          deliveryStatus,
          JSON.stringify(providerResponse),
          deliveryStatus === "sent" ? new Date() : null,
        ]
      );
    }

    return res.json({ weekStart, attempted, sent, skipped, failed });
  } catch (err) {
    console.error("[UGF] admin/send-weekly-checkins error:", err.message);
    return res.status(500).json({ error: "Bulk send failed", weekStart, attempted, sent, skipped, failed });
  }
});

// ─── POST /admin/test-weekly-checkin-email ────────────────────────────────────
// Protected by X-Cron-Secret and GYMMASTER_WEEKLY_EMAIL_ENABLED flag.

app.post("/admin/test-weekly-checkin-email", async function (req, res) {
  if (!requireCronSecret(req, res)) return;
  if (!requireGymMasterEmailEnabled(res)) return;

  var memberId = (req.body.memberId || "").trim();
  if (!memberId) return res.status(400).json({ error: "memberId is required" });

  try {
    var result = await sendGymMasterWeeklyCheckinEmail({
      memberId: memberId,
      templateId: process.env.GYMMASTER_WEEKLY_CHECKIN_TEMPLATE_ID,
    });

    if (result && result.configured === false) {
      return res.status(503).json({ configured: false, error: result.error });
    }

    return res.json({ ok: true, memberId: memberId });
  } catch (err) {
    console.error("[UGF] admin/test-weekly-checkin-email error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /admin/retry-trainer-notifications ──────────────────────────────────
// Protected by X-Cron-Secret.
// Retries Zapier trainer webhooks for check-ins where notification has not
// succeeded and attempt count is below the maximum.
// Attempt count is incremented BEFORE each webhook call.

app.post("/admin/retry-trainer-notifications", async function (req, res) {
  if (!requireCronSecret(req, res)) return;

  var attempted = 0, sent = 0, failed = 0, skipped = 0;

  try {
    var pending = await db.query(
      "SELECT wc.id, wc.member_id, wc.week_start, wc.trainer_summary, wc.status, " +
      "wc.trainer_notification_attempts, wc.ai_analysis_json, " +
      "cm.gymmaster_member_id, cm.first_name, cm.last_name " +
      "FROM weekly_checkins wc " +
      "JOIN coach_members cm ON cm.id = wc.member_id " +
      "WHERE wc.trainer_notification_status IN ('pending', 'failed') " +
      "AND wc.trainer_notified_at IS NULL " +
      "AND wc.trainer_notification_attempts < $1 " +
      "ORDER BY wc.created_at ASC",
      [MAX_TRAINER_NOTIFICATION_ATTEMPTS]
    );

    for (var i = 0; i < pending.rows.length; i++) {
      var row = pending.rows[i];
      attempted++;

      var analysis = {};
      try {
        analysis = typeof row.ai_analysis_json === "string"
          ? JSON.parse(row.ai_analysis_json)
          : (row.ai_analysis_json || {});
      } catch (e) {}

      var payload = {
        type: "trainer_summary",
        trainerEmail: "staff@ugf.club",
        memberName: row.first_name + " " + row.last_name,
        memberId: row.gymmaster_member_id,
        weekStart: row.week_start,
        status: row.status,
        trainerSummary: row.trainer_summary || "",
        wins: analysis.wins || [],
        barriers: analysis.barriers || [],
        adherence: analysis.adherence || {},
        painFlags: analysis.painFlags || [],
        recoveryFlags: analysis.recoveryFlags || [],
        trendNotes: analysis.trendNotes || [],
        suggestedStaffActions: analysis.suggestedStaffActions || [],
        programReviewRecommended: Boolean(analysis.programReviewRecommended),
        urgentFollowUpRecommended: Boolean(analysis.urgentFollowUpRecommended),
      };

      // Increment attempt count BEFORE the webhook fires.
      await db.query(
        "UPDATE weekly_checkins SET " +
        "trainer_notification_attempts = trainer_notification_attempts + 1, " +
        "trainer_notification_last_attempt_at = NOW() " +
        "WHERE id = $1",
        [row.id]
      );

      var webhookResult = await sendTrainerSummaryWebhook(payload);

      if (webhookResult && !webhookResult.error && !webhookResult.skipped) {
        // Success: update status only (attempt already incremented above)
        await db.query(
          "UPDATE weekly_checkins SET " +
          "trainer_notified_at = NOW(), " +
          "trainer_notification_status = 'sent', " +
          "trainer_notification_last_error = NULL " +
          "WHERE id = $1",
          [row.id]
        );
        sent++;
      } else {
        var errMsg = (webhookResult && webhookResult.error)
          ? String(webhookResult.error).slice(0, 200)
          : (webhookResult && webhookResult.skipped ? "webhook_not_configured" : "unknown_error");
        var newStatus = (webhookResult && webhookResult.skipped) ? "pending" : "failed";
        // Failure: update status only (attempt already incremented above)
        await db.query(
          "UPDATE weekly_checkins SET " +
          "trainer_notification_status = $2, " +
          "trainer_notification_last_error = $3 " +
          "WHERE id = $1",
          [row.id, newStatus, errMsg]
        );
        failed++;
      }
    }

    // Count records that have exhausted max attempts
    var exhausted = await db.query(
      "SELECT COUNT(*) AS count FROM weekly_checkins " +
      "WHERE trainer_notification_status IN ('pending', 'failed') " +
      "AND trainer_notified_at IS NULL " +
      "AND trainer_notification_attempts >= $1",
      [MAX_TRAINER_NOTIFICATION_ATTEMPTS]
    );
    skipped = parseInt(exhausted.rows[0].count, 10) || 0;

    return res.json({ attempted, sent, failed, skipped });
  } catch (err) {
    console.error("[UGF] admin/retry-trainer-notifications error:", err.message);
    return res.status(500).json({ error: "Retry failed", attempted, sent, failed, skipped });
  }
});

// ─── Goals Coach Phase 2 storage and staff-review foundation ─────────────────

function requireGoalsCoachMember(req, res, next) {
  var claims = verifyVerificationToken(req, res);
  if (!claims) return;
  req.memberClaims = claims;
  return next();
}

var staffAuthorization = createStaffAuthorization({ db: db });
var alphaMemberAuthorization = createAlphaMemberAuthorization({
  db: db,
  applicationConfiguration: alphaApplicationConfiguration,
});

app.use(
  "/alpha/goals-coach",
  createAlphaFeatureGate(),
  createAlphaMemberAuthenticator({ configuration: alphaAuthConfiguration }),
  alphaMemberAuthorization.loadActiveAlphaMember,
  createAlphaGoalsCoachRouter({
    db: db,
    applicationConfiguration: alphaApplicationConfiguration,
    requireCurrentConsent: alphaMemberAuthorization.requireCurrentAlphaConsent,
    coachingEngine: phase1bStartup.engine,
    phase1bStartup: phase1bStartup,
    phase1cStartup: phase1cStartup,
  })
);

app.use(
  "/goals-coach",
  createGoalsCoachMemberRouter({
    db: db,
    requireMember: requireGoalsCoachMember,
  })
);

app.use(
  "/staff",
  createStaffAuthenticator({ configuration: staffAuthConfiguration }),
  staffAuthorization.loadActiveStaff,
  createGoalsCoachStaffRouter({
    db: db,
    requireAdmin: staffAuthorization.requireAdmin,
  })
);

app.use(goalsCoachErrorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────

var PORT = process.env.PORT || 3001;
app.listen(PORT, function () {
  console.log("UGF backend running on port " + PORT);
});
