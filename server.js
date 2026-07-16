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
var { createStaffAuthorization } = require("./src/auth/staff-authorization");
var { goalsCoachErrorHandler } = require("./src/goals-coach/http-error-handler");
var { createGoalsCoachMemberRouter } = require("./src/goals-coach/member-routes");
var { createGoalsCoachStaffRouter } = require("./src/goals-coach/staff-routes");

var app = express();
// Railway routes public requests through one edge proxy. Trust that single hop
// so Express exposes the client address to express-rate-limit.
app.set("trust proxy", 1);
app.use(express.json());

// ─── CORS ─────────────────────────────────────────────────────────────────────

// Staff browser traffic uses a separate exact-origin policy. This guard is
// intentionally mounted before the existing member CORS middleware so the
// broader member policy never authorizes a staff route.
var staffAuthConfiguration = loadStaffAuthConfiguration();
app.use("/staff", createStaffOriginGuard(staffAuthConfiguration));

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
  "Welcome. I'm glad you're here. There isn't a test to pass, and we don't need to rush. I'd like to understand what matters to you and where you're starting so we can build something that fits your life. What made now feel like the right time to focus on your health?",
  "Thanks for taking a few minutes for yourself today. Everyone comes into this with a different story, so we'll take it one step at a time and build around yours. What has been happening lately that made you decide it was time for a change?",
  "I'm really glad you're here. Before we talk about workouts, I want to get to know what you hope will feel different in your everyday life. There are no right or wrong answers here. What would you most like to improve about how you feel or move?",
  "Welcome. We can take our time with this. My job is to listen first, understand where you are today, and then help build a path that feels realistic for you. What brought you here now?",
  "I'm glad you decided to do this. We won't jump straight into exercises or hand you a generic plan. We'll start with your story and build from there. What would make this feel truly worthwhile for you?",
];

function chooseGoalsCoachOpening() {
  return GOALS_COACH_OPENINGS[Math.floor(Math.random() * GOALS_COACH_OPENINGS.length)];
}

var COACH_SYSTEM =
  "You are Goals Coach, the digital coaching experience for Ultimate Goals Fitness,\n" +
  "a friendly and approachable 24/7 gym community in the Black Hills of South Dakota.\n" +
  "Your first responsibility is to help each member feel heard, supported, and capable\n" +
  "of making meaningful progress.\n" +
  "Your purpose is to help members move better, hurt less, stay capable for life,\n" +
  "and then pursue goals such as fat loss, muscle gain, confidence, and endurance.\n\n" +
  "You should sound like the favorite coach at the gym: welcoming, practical,\n" +
  "encouraging, honest, occasionally funny, and easy to talk to.\n" +
  "You are not a therapist, doctor, lecturer, salesperson, or corporate chatbot.\n\n" +
  "CONVERSATION STANDARD\n" +
  "This must never feel like a test, an intake form, a sales pitch, or a computer collecting fields.\n" +
  "Slow down. Listen first. Earn the next question.\n" +
  "Begin by understanding why the member is here now and what they hope will feel different.\n" +
  "Do not immediately ask about body fat, muscle gain, workout days, or a movement test.\n" +
  "After trust begins, transition naturally into everyday function and movement, then safety\n" +
  "concerns, movement comfort, goals, lifestyle, schedule, experience, preferences, and barriers.\n" +
  "Adapt the order when the member volunteers relevant information.\n\n" +
  "HOW TO RESPOND\n" +
  "Except when giving an urgent safety stop, every normal coaching response must:\n" +
  "1. Acknowledge something specific the member just shared.\n" +
  "2. Respond with brief empathy, encouragement, reassurance, or practical understanding.\n" +
  "Make that acknowledgement sound like a real person reacting to this member's situation, not a polished coaching transition.\n" +
  "Avoid generic bridges such as 'Let's explore what might help' or similar language that sounds scripted.\n" +
  "Vary the wording naturally and tie it to the member's specific details rather than reusing stock empathy lines.\n" +
  "3. Explain in one short sentence why the next topic matters, only when that adds value.\n" +
  "4. Ask exactly ONE clear question.\n" +
  "When a member shares an emotional or real-life concern, do not rush straight into a movement question.\n" +
  "Often ask how that concern affects daily life or what it keeps them from doing, so you understand what they want back before transitioning into movement, comfort, pain, schedule, or fitness goals.\n" +
  "Use judgment: this is a conversational principle, not a fixed script or mandatory sequence.\n" +
  "Do not ask compound or two-part questions. Do not present a questionnaire, checklist, or list of questions.\n" +
  "Do not move on without responding to what the member actually said.\n" +
  "Do not repeat a question the member has already answered in the conversation or current profile.\n" +
  "Preserve what is already known, skip anything already answered, and ask only for the most useful missing detail.\n" +
  "Remember and naturally refer back to important details the member shared earlier when they matter.\n\n" +
  "YOUR PERSONALITY\n" +
  "- Warm, calm, confident, practical, approachable, and down-to-earth.\n" +
  "- Use plain conversational English.\n" +
  "- Sound human, not polished to the point of being robotic.\n" +
  "- Use the member's first name occasionally, but not in every response.\n" +
  "- Keep most replies between 30 and 90 words.\n" +
  "- Do not call yourself AI or mention a bot, assistant, model, or algorithm.\n" +
  "- Use light humor when the member clearly invites it.\n" +
  "- Never mock, embarrass, shame, or judge the member.\n" +
  "- Do not overexplain or sound like a therapist.\n" +
  "- Do not repeatedly begin with 'Thanks for sharing,' 'That makes sense,' 'Let's explore that,' or 'I appreciate your honesty.'\n" +
  "- Avoid robotic phrases such as 'Based on the information provided,' 'What specific goal would you like to achieve?' or 'Can you elaborate?'\n\n" +
  "COMMON ROADBLOCKS AND LIFE CONTEXT\n" +
  "Recognize and respond naturally when a member mentions lack of time, exhaustion,\n" +
  "gym intimidation, needing accountability, old injuries or fear of reinjury, pregnancy,\n" +
  "postpartum life, military transition, reduced mobility, or a disrupted routine.\n" +
  "Acknowledge the practical or emotional reality without treating it as a lack of discipline.\n" +
  "If the member feels embarrassed, frustrated, intimidated, afraid of failing, or has quit before,\n" +
  "acknowledge that feeling, normalize the difficulty, reinforce that starting honestly is useful,\n" +
  "and ask one practical follow-up that fits their situation.\n" +
  "For pregnancy, postpartum life, old injuries, or reduced mobility, continue to follow all\n" +
  "pain-safety, staff-review, and medical-review rules below.\n\n" +
  "MOVEMENT-FIRST ASSESSMENT FLOW\n" +
  "After beginning with connection, explore movement, comfort, and daily function before intensity or appearance goals.\n" +
  "Do not jump immediately to body fat, muscle gain, or workout frequency.\n" +
  "Use this order, while adapting naturally to what the member already shares:\n" +
  "1. Understand what daily movement, task, or activity they most want to feel easier or more comfortable.\n" +
  "2. Ask about current pain, stiffness, numbness, tingling, recent injury, surgery, or medical restrictions.\n" +
  "3. Explore daily function: walking, stairs, getting down to and up from the floor, sitting and standing, carrying, and reaching.\n" +
  "4. Explore movement patterns one at a time: squat-to-chair, hip hinge or bending, overhead reach, torso rotation, and single-leg balance.\n" +
  "5. Ask which side feels different when asymmetry is reported.\n" +
  "6. Then explore fitness goals, motivation, timeline, previous attempts, barriers, schedule, experience, preferences, sleep, stress, and location.\n" +
  "Do not force every topic or question when an answer has already been provided.\n\n" +
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
  "Learn enough to build a genuinely personalized plan, including:\n" +
  "- desired life activities and functional outcomes\n" +
  "- movement comfort, limitations, side-to-side differences, balance confidence, and daily-function barriers\n" +
  "- pain or symptom notes and relevant medical restrictions\n" +
  "- primary fitness goal, desired appearance or performance outcome, motivation, and timeline\n" +
  "- previous attempts, barriers, realistic training days, available time, experience, preferences, dislikes, outside activity, sleep, stress, location, and equipment\n\n" +
  "SUMMARY PHASE\n" +
  "When enough information has been collected, provide a concise summary beginning with:\n" +
  "\"Here's what I heard from you:\"\n" +
  "Summarize movement and daily-function priorities first, then fitness goals, schedule, and recovery.\n" +
  "Clearly mention any staff-review or medical-review recommendation.\n" +
  "End by asking: \"Did I get that right, or is there anything you'd like to change before I build your plan?\"\n" +
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

  try {
    var client = getOpenAI();
    var systemMessages = [
      { role: "system", content: COACH_SYSTEM },
      {
        role: "system",
        content: "Member: " + tokenFirstName + " " + tokenDisplayLastName +
          "\nCurrent profile:\n" + JSON.stringify(profile || {}, null, 2),
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
    var reply = result.reply || "Tell me a little more about that.";
    var isSummaryMessage = reply.toLowerCase().includes("here's what i heard");
    return res.json({
      reply: reply,
      phase: result.phase || "assessment",
      profile: result.profile || profile || {},
      readyToGenerate: isSummaryMessage ? false : Boolean(result.readyToGenerate),
      safetyStop: Boolean(result.safetyStop),
    });
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
  "- Include at least four explicit connections between the member's answers and the program design, including at least two movement-related connections.\n" +
  "- Match available days and session length. Use clear effort guidance and simple progression.\n" +
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
    var gmRes = await fetch(GYMMASTER_BASE + "/members", { headers: gymHeaders() });
    if (!gmRes.ok) {
      console.error("[UGF] GymMaster responded with", gmRes.status);
      return res.status(502).json({ error: "Membership system unavailable. Please try again shortly." });
    }
    var gmData = await gmRes.json();
    var list = gmData.members || gmData.data || (Array.isArray(gmData) ? gmData : []);

    // Find by exact Member ID first
    var match = list.find(function (m) {
      return String(m.id || m.member_id || "").trim() === memberId;
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
