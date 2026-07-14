const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

app.use(
  cors({
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
  })
);

// ─── Database ────────────────────────────────────────────────────────────────

var db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Constants ───────────────────────────────────────────────────────────────

var GYMMASTER_BASE = "https://ugf.gymmasteronline.com/gatekeeper_api/v2";
var FRONTEND_URL = process.env.FRONTEND_URL || "https://ultimate-goals-fitness.sintra.site";

var WEEKLY_CHECKIN_QUESTIONS = [
  {
    id: "workouts_completed",
    question: "How many planned workouts did you complete this week?",
    type: "number",
  },
  {
    id: "energy",
    question: "How was your overall energy?",
    type: "scale",
    min: 1,
    max: 10,
  },
  {
    id: "sleep",
    question: "How was your sleep?",
    type: "scale",
    min: 1,
    max: 10,
  },
  {
    id: "soreness",
    question: "How much muscle soreness did you experience?",
    type: "scale",
    min: 0,
    max: 10,
  },
  {
    id: "pain",
    question: "Did you experience any pain or physical problems?",
    type: "textarea",
  },
  {
    id: "difficulty",
    question: "How difficult did the workouts feel overall?",
    type: "scale",
    min: 1,
    max: 10,
  },
  {
    id: "win",
    question: "What went well this week?",
    type: "textarea",
  },
  {
    id: "challenge",
    question: "What made the week difficult?",
    type: "textarea",
  },
  {
    id: "next_week",
    question: "Is there anything you want adjusted for next week?",
    type: "textarea",
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function gymHeaders() {
  var site = process.env.GYMMASTER_SITE || "ugf";
  var key = process.env.GYMMASTER_API_KEY;
  var token = Buffer.from(site + ":" + key).toString("base64");
  return {
    Accept: "application/json",
    Authorization: "Basic " + token,
  };
}

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function isMemberActive(member) {
  if (member.stopatgate) return false;
  var memberships = member.membership || member.memberships || [];
  if (Array.isArray(memberships) && memberships.length > 0) {
    return memberships.some(function (m) { return m.expired === false; });
  }
  return false;
}

function getWeekStart(date) {
  var d = new Date(date);
  var day = d.getDay();
  var diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split("T")[0];
}

function requireCronSecret(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", function (_req, res) {
  res.json({ ok: true });
});

// ─── GymMaster test ──────────────────────────────────────────────────────────

app.get("/test-gymmaster", async function (_req, res) {
  var site = process.env.GYMMASTER_SITE || "ugf";
  var key = process.env.GYMMASTER_API_KEY;
  var keyLen = key ? key.length : 0;
  var keyPreview = key ? key.slice(0, 4) + "***" : "NOT SET";
  try {
    var response = await fetch(GYMMASTER_BASE + "/members", { headers: gymHeaders() });
    var data = await response.json();
    var list = data.members || data.data || (Array.isArray(data) ? data : []);
    return res.json({
      site: site,
      keyLen: keyLen,
      keyPreview: keyPreview,
      status: response.status,
      totalMembers: list.length,
      fields: list[0] ? Object.keys(list[0]) : [],
      firstMember: list[0] || null,
    });
  } catch (err) {
    return res.json({ site: site, keyLen: keyLen, keyPreview: keyPreview, error: err.message });
  }
});

// ─── Verify member ────────────────────────────────────────────────────────────

app.post("/verify-member", async function (req, res) {
  var firstName = req.body.firstName;
  var lastName = req.body.lastName;
  var memberId = req.body.memberId;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "firstName and lastName are required" });
  }

  try {
    var response = await fetch(GYMMASTER_BASE + "/members", { headers: gymHeaders() });

    if (!response.ok) {
      var bodyText = "";
      try { bodyText = await response.text(); } catch (e) {}
      console.error("GymMaster responded with", response.status, bodyText.slice(0, 300));
      return res.status(502).json({ error: "Membership system unavailable" });
    }

    var data = await response.json();
    var list = data.members || data.data || (Array.isArray(data) ? data : []);

    var match = list.find(function (m) {
      var parts = (m.name || "").split(",").map(function (s) { return s.trim(); });
      var apiLastInitial = (parts[0] || "").toLowerCase();
      var apiFirstName = (parts[1] || "").toLowerCase();
      var enteredLastInitial = lastName.trim().slice(0, 1).toLowerCase();
      var enteredFirst = firstName.trim().toLowerCase();
      return apiFirstName === enteredFirst && apiLastInitial === enteredLastInitial;
    });

    if (!match) {
      return res.json({ found: false, active: false });
    }

    if (memberId) {
      var gymId = String(match.id || match.member_id || "").trim();
      if (gymId && String(memberId).trim() !== gymId) {
        return res.json({ found: false, active: false });
      }
    }

    return res.json({
      found: true,
      active: isMemberActive(match),
      memberId: match.id || match.member_id || null,
    });
  } catch (err) {
    console.error("verify-member error:", err.message);
    return res.status(500).json({ error: "Verification service error" });
  }
});

app.post("/verify-member-by-id", async function (req, res) {
  var memberId = req.body.memberId;
  if (!memberId) {
    return res.status(400).json({ error: "memberId is required" });
  }
  try {
    var response = await fetch(
      GYMMASTER_BASE + "/members?id=" + encodeURIComponent(memberId),
      { headers: gymHeaders() }
    );
    if (response.status === 404) return res.json({ found: false, active: false });
    if (!response.ok) {
      console.error("GymMaster responded with", response.status);
      return res.status(502).json({ error: "Membership system unavailable" });
    }
    var data = await response.json();
    var list = data.members || data.data || (Array.isArray(data) ? data : []);
    var member = list[0];
    if (!member) return res.json({ found: false, active: false });
    return res.json({ found: true, active: isMemberActive(member) });
  } catch (err) {
    console.error("verify-member-by-id error:", err.message);
    return res.status(500).json({ error: "Verification service error" });
  }
});

// ─── Register / update member contact info ────────────────────────────────────

app.post("/members", async function (req, res) {
  var gymmasterId = req.body.gymmasterId;
  var firstName = req.body.firstName;
  var lastName = req.body.lastName;
  var email = req.body.email;
  var phone = req.body.phone;
  var preferredContact = req.body.preferredContact || "email";
  var smsConsent = Boolean(req.body.smsConsent);

  if (!gymmasterId || !firstName || !lastName) {
    return res.status(400).json({ error: "gymmasterId, firstName, and lastName are required" });
  }

  try {
    var result = await db.query(
      "INSERT INTO members (gymmaster_member_id, first_name, last_name, email, phone, preferred_contact, sms_consent, sms_consent_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) " +
      "ON CONFLICT (gymmaster_member_id) DO UPDATE SET " +
      "first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, " +
      "email = COALESCE(EXCLUDED.email, members.email), " +
      "phone = COALESCE(EXCLUDED.phone, members.phone), " +
      "preferred_contact = EXCLUDED.preferred_contact, " +
      "sms_consent = EXCLUDED.sms_consent, " +
      "sms_consent_at = CASE WHEN EXCLUDED.sms_consent = TRUE AND members.sms_consent = FALSE THEN NOW() ELSE members.sms_consent_at END " +
      "RETURNING id",
      [gymmasterId, firstName, lastName, email || null, phone || null, preferredContact, smsConsent, smsConsent ? new Date() : null]
    );
    return res.json({ memberId: result.rows[0].id });
  } catch (err) {
    console.error("members upsert error:", err.message);
    return res.status(500).json({ error: "Could not save member" });
  }
});

// ─── Save workout plan ────────────────────────────────────────────────────────

app.post("/save-plan", async function (req, res) {
  var gymmasterId = req.body.gymmasterId;
  var plan = req.body.plan;
  var profile = req.body.profile;

  if (!gymmasterId || !plan) {
    return res.status(400).json({ error: "gymmasterId and plan are required" });
  }

  try {
    var memberResult = await db.query(
      "SELECT id FROM members WHERE gymmaster_member_id = $1",
      [gymmasterId]
    );
    if (!memberResult.rows.length) {
      return res.status(404).json({ error: "Member not found — register contact info first" });
    }
    var memberId = memberResult.rows[0].id;
    await db.query(
      "INSERT INTO workout_plans (member_id, plan_markdown, profile_json) VALUES ($1, $2, $3)",
      [memberId, plan, profile ? JSON.stringify(profile) : null]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("save-plan error:", err.message);
    return res.status(500).json({ error: "Could not save plan" });
  }
});

// ─── Static workout generation (legacy form) ──────────────────────────────────

app.post("/generate-workout", async function (req, res) {
  var assessment = req.body.assessment;
  if (!assessment) return res.status(400).json({ error: "assessment is required" });

  try {
    var client = getOpenAI();
    var completion = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4096,
      messages: [
        { role: "system", content: buildSystemPrompt(assessment) },
        { role: "user", content: buildPrompt(assessment) },
      ],
    });
    return res.json({ plan: completion.choices[0].message.content });
  } catch (err) {
    console.error("generate-workout error:", err.message);
    return res.status(500).json({ error: "Plan generation failed" });
  }
});

function buildSystemPrompt(a) {
  var hasInjuries = a.injuries && a.injuries.trim().toLowerCase() !== "none" && a.injuries.trim() !== "";
  var injuryBlock = hasInjuries
    ? "CRITICAL SAFETY RULES: The member reported: \"" + a.injuries + "\". NEVER prescribe exercises that load the affected area. List every excluded exercise. Provide safe alternatives. If the injury involves the spine or back: AVOID bent-over rows, conventional deadlifts, good mornings, barbell squats, and forward flexion under load. Acknowledge the injury in your opening."
    : "The member has no reported injuries. You may prescribe a full range of exercises appropriate for their fitness level and goals.";
  return "You are a certified personal trainer at Ultimate Goals Fitness, a 24/7 community gym in the Black Hills of South Dakota. You are warm, encouraging, and direct. Member safety is your top priority.\n\n" + injuryBlock;
}

function buildPrompt(a) {
  var hasInjuries = a.injuries && a.injuries.trim().toLowerCase() !== "none" && a.injuries.trim() !== "";
  return "Build a complete personalized workout plan.\n\nMEMBER PROFILE:\n" +
    "- Name: " + a.name + "\n- Age: " + (a.age || "Not provided") + "\n- Location: " + a.location + "\n" +
    "- Fitness Level: " + a.fitnessLevel + "\n- Goals: " + (Array.isArray(a.goals) ? a.goals.join(", ") : a.goals) + "\n" +
    "- Days Per Week: " + a.daysPerWeek + "\n- Preferred Time: " + (a.preferredTime || "Flexible") + "\n" +
    "- Injuries: " + (a.injuries || "None") + "\n- Outside Activity: " + (a.currentActivity || "Not specified") + "\n" +
    "- Notes: " + (a.additionalNotes || "None") + "\n\n" +
    "Include: weekly schedule, workout tables with sets/reps/trainer tips, weeks 3-4 progression, nutrition guide, and a motivating closing line." +
    (hasInjuries ? " Every exercise must be safe given the reported injury." : "");
}

// ─── AI Coach (conversational assessment) ─────────────────────────────────────

var COACH_SYSTEM = "You are the UGF AI Coach for Ultimate Goals Fitness, a friendly and approachable\n24/7 gym community in the Black Hills of South Dakota.\nYou should sound like the favorite coach at the gym: welcoming, practical,\nencouraging, honest, occasionally funny, and easy to talk to.\nYou are not a therapist, doctor, lecturer, salesperson, or corporate chatbot.\n\nYOUR PERSONALITY\n- Warm, confident, approachable, and down-to-earth.\n- Use plain conversational English.\n- Sound human, not polished to the point of being robotic.\n- Use the member's first name occasionally, but not in every response.\n- Keep most replies between 30 and 90 words.\n- Ask one main question at a time.\n- Briefly respond to what the member actually said before asking the next question.\n- Use light humor when the member clearly invites it.\n- Never mock, embarrass, shame, or judge the member.\n- Never use crude language unless briefly and harmlessly acknowledging language already used by the member.\n- Do not overexplain.\n- Do not sound like a therapist.\n- Do not repeat the member's exact words unnecessarily.\n\nAVOID ROBOTIC LANGUAGE\nDo not use phrases such as:\n- \"Let's explore this further.\"\n- \"What specific goal would you like to achieve?\"\n- \"Improve your physical condition.\"\n- \"Thank you for sharing.\"\n- \"Based on the information provided.\"\n- \"It sounds like you are seeking...\"\n- \"Can you elaborate?\"\n- \"Perhaps regain some confidence.\"\n\nReplace those with natural coaching language.\nFor example:\nInstead of: \"Let's explore this further. What specific goal would you like to achieve?\"\nSay: \"Got it. What would you most like to change over the next few months?\"\nInstead of: \"Thank you for sharing that.\"\nSay: \"I appreciate you being honest.\"\nInstead of: \"You want to improve your physical condition.\"\nSay: \"You want to lose some body fat, feel better, and be more comfortable in your own skin.\"\n\nHUMOR\nWhen the member gives a humorous or blunt answer, acknowledge it naturally without turning the conversation into a joke.\nExample:\nMember: \"I want to be able to see my wiener again.\"\nGood response: \"Fair enough - that's a goal I've heard more than once. Besides losing the weight itself, what's the biggest difference you're hoping to notice: more confidence, better health, more energy, or something else?\"\nBad response: \"You're looking to reduce your weight to improve your physical condition.\"\n\nEMOTIONAL ANSWERS\nIf the member says they are embarrassed, frustrated, afraid of failing, or have quit before:\n- Acknowledge the feeling.\n- Normalize it without minimizing it.\n- Reinforce that beginning the assessment is a useful first step.\n- Ask a practical follow-up question.\nExample: \"I appreciate you being honest. A lot of people walk into a gym feeling exactly that way, and you don't have to be in shape before you start. What has usually made it hardest for you to stay consistent?\"\n\nCONVERSATION GOALS\nLearn enough about the member to build a genuinely personalized plan:\n- What brought them here today\n- Their main fitness goal\n- The result they hope to see\n- Why that result matters personally\n- Their timeline\n- Previous attempts\n- Barriers to consistency\n- Realistic training days per week\n- Available workout time\n- Exercise experience\n- Activities they enjoy\n- Activities they dislike\n- Daily activity outside the gym\n- Sleep and stress when relevant\n- UGF location and equipment access\n- Pain, injuries, surgeries, restrictions, or relevant medications\n- Confidence level\n- Anything else a good coach should understand\n\nDo not mechanically ask every question if the member has already answered it.\nAsk follow-up questions when an answer is vague, emotionally important, contradictory, humorous, or medically relevant.\n\nPERSONALIZATION\nRemember earlier answers and refer to them naturally later.\nExample: \"You mentioned that work gets hectic and that previous plans became hard to maintain. That's why I'm going to keep your first phase realistic rather than loading you up with six workouts a week.\"\nDo not pretend to remember anything that was not actually stated.\n\nSAFETY\n- Do not diagnose medical conditions.\n- Do not claim that a member has medical clearance.\n- Do not recommend working through sharp, severe, or worsening pain.\n- If the member reports chest pain, fainting, unexplained severe shortness of breath, an acute serious injury, or another urgent warning sign, stop the assessment and advise appropriate medical attention. Set safetyStop=true.\n- For non-urgent pain, injuries, medical restrictions, or relevant medications, ask a brief clarifying question.\n- Recommend professional clearance when appropriate.\n- Do not guarantee weight loss, muscle gain, or other results.\n\nSUMMARY PHASE\nWhen enough information has been collected, do not immediately generate the plan.\nFirst provide a concise summary beginning with:\n\"Here's what I heard from you:\"\nThe summary should include:\n- Their main goal\n- Why it matters\n- Their biggest barrier\n- Their realistic schedule\n- Their experience\n- Their preferences\n- Their limitations\n- The broad approach the workout will use\nEnd by asking: \"Did I get that right, or is there anything you'd like to change before I build your plan?\"\nOnly set readyToGenerate to true AFTER the member has explicitly confirmed the summary in a follow-up message. Never set readyToGenerate=true in the same message that presents the summary.\n\nJSON RESPONSE\nReturn valid JSON only. Use this exact structure:\n{\"reply\":\"string\",\"phase\":\"assessment\",\"profile\":{\"primaryGoal\":\"\",\"desiredOutcome\":\"\",\"timeline\":\"\",\"motivation\":\"\",\"barriers\":[],\"daysPerWeek\":\"\",\"sessionLength\":\"\",\"experience\":\"\",\"preferences\":[],\"dislikes\":[],\"outsideActivity\":\"\",\"sleep\":\"\",\"stress\":\"\",\"location\":\"\",\"equipment\":[],\"limitations\":[],\"medicalNotes\":[],\"confidence\":\"\",\"additionalContext\":\"\"},\"readyToGenerate\":false,\"safetyStop\":false}\nPreserve all previously known profile values. Use empty strings or empty arrays for unknown values. Never return Markdown outside the JSON object.";

app.post("/coach-message", async function (req, res) {
  var member = req.body.member;
  var messages = req.body.messages;
  var profile = req.body.profile;

  if (!member || !member.firstName || !Array.isArray(messages)) {
    return res.status(400).json({ error: "member.firstName and messages are required" });
  }

  try {
    var client = getOpenAI();
    var systemMessages = [
      { role: "system", content: COACH_SYSTEM },
      {
        role: "system",
        content: "Member: " + member.firstName + " " + (member.lastName || "") + "\nCurrent profile:\n" + JSON.stringify(profile || {}, null, 2),
      },
    ];

    var completion = await client.chat.completions.create({
      model: "gpt-4o",
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
    console.error("coach-message error:", err.message);
    return res.status(500).json({ error: "The coach is temporarily unavailable." });
  }
});

// ─── Generate personalized workout ────────────────────────────────────────────

var PLAN_SYSTEM =
  "You are a certified fitness professional writing a workout plan for an Ultimate Goals Fitness member.\n\n" +
  "Write like a UGF coach who listened carefully. Be specific, practical, encouraging, and conservative around limitations.\n\n" +
  "RULES\n" +
  "- Do not diagnose or claim medical clearance.\n- Do not guarantee outcomes.\n- Do not prescribe through sharp or worsening pain.\n" +
  "- Nutrition content is general education only, not medical nutrition therapy.\n" +
  "- Include at least three explicit connections between the member's answers and program design.\n" +
  "- Match the available days and session length.\n- Include substitutions, effort guidance, and simple progression.\n- Use Markdown.\n\n" +
  "STRUCTURE\n# [First Name]'s UGF Game Plan\n## What I Heard From You\n## Why This Plan Fits You\n## Your Weekly Schedule\n## Warm-Up\n## Workout Details\n" +
  "Table per day: | Exercise | Sets | Reps / Time | Rest | Effort | Coaching Cue |\n" +
  "## Progression for the First Four Weeks\n## Cardio and Daily Movement\n## Recovery\n## General Nutrition Guidance\n## When to Pause and Ask for Help\n" +
  "Close with a grounded UGF message.";

app.post("/generate-personalized-workout", async function (req, res) {
  var member = req.body.member;
  var profile = req.body.profile;
  var messages = req.body.messages;

  if (!member || !member.firstName || !profile) {
    return res.status(400).json({ error: "member and profile are required" });
  }

  try {
    var client = getOpenAI();
    var completion = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.45,
      max_tokens: 4096,
      messages: [
        { role: "system", content: PLAN_SYSTEM },
        {
          role: "user",
          content: "Create the plan.\n\nMEMBER\n" + JSON.stringify(member, null, 2) +
            "\n\nPROFILE\n" + JSON.stringify(profile, null, 2) +
            "\n\nCONVERSATION\n" + JSON.stringify((messages || []).slice(-30), null, 2),
        },
      ],
    });

    var plan = completion.choices[0].message.content;
    if (!plan) throw new Error("No plan returned");
    return res.json({ plan: plan });
  } catch (err) {
    console.error("generate-personalized-workout error:", err.message);
    return res.status(500).json({ error: "Plan generation failed" });
  }
});

// ─── Weekly check-in: send ────────────────────────────────────────────────────

app.post("/weekly-checkins/send", async function (req, res) {
  if (!requireCronSecret(req, res)) return;

  try {
    var members = await db.query(
      "SELECT * FROM members WHERE checkin_enabled = TRUE AND checkin_day = EXTRACT(DOW FROM CURRENT_DATE)"
    );
    var weekStart = getWeekStart(new Date());
    var sent = 0;

    for (var i = 0; i < members.rows.length; i++) {
      var member = members.rows[i];
      var token = crypto.randomBytes(32).toString("hex");

      var inserted = await db.query(
        "INSERT INTO weekly_checkins (member_id, week_start, token) VALUES ($1, $2, $3) ON CONFLICT (member_id, week_start) DO NOTHING RETURNING token",
        [member.id, weekStart, token]
      );

      if (inserted.rows.length > 0) {
        var checkinUrl = FRONTEND_URL + "/weekly-checkin?token=" + token;
        await sendCheckinMessage(member, checkinUrl);
        sent++;
      }
    }

    res.json({ sent: sent, weekStart: weekStart });
  } catch (err) {
    console.error("weekly-checkins/send error:", err.message);
    res.status(500).json({ error: "Unable to send check-ins" });
  }
});

// ─── Weekly check-in: retrieve ────────────────────────────────────────────────

app.get("/weekly-checkins/:token", async function (req, res) {
  try {
    var result = await db.query(
      "SELECT wc.id, wc.completed_at, wc.week_start, m.first_name FROM weekly_checkins wc JOIN members m ON m.id = wc.member_id WHERE wc.token = $1",
      [req.params.token]
    );
    var checkin = result.rows[0];
    if (!checkin) return res.status(404).json({ error: "Check-in not found" });
    if (checkin.completed_at) return res.status(409).json({ error: "This check-in has already been completed" });
    res.json({ firstName: checkin.first_name, weekStart: checkin.week_start, questions: WEEKLY_CHECKIN_QUESTIONS });
  } catch (err) {
    console.error("weekly-checkins/:token GET error:", err.message);
    res.status(500).json({ error: "Unable to load check-in" });
  }
});

// ─── Weekly check-in: submit ──────────────────────────────────────────────────

app.post("/weekly-checkins/:token", async function (req, res) {
  var responses = req.body.responses;
  if (!responses) return res.status(400).json({ error: "responses are required" });

  try {
    var result = await db.query(
      "SELECT wc.id, wc.member_id, wc.completed_at, m.first_name, m.last_name, m.trainer_email, wp.plan_markdown, wp.profile_json " +
      "FROM weekly_checkins wc JOIN members m ON m.id = wc.member_id " +
      "LEFT JOIN LATERAL (SELECT plan_markdown, profile_json FROM workout_plans WHERE member_id = m.id ORDER BY created_at DESC LIMIT 1) wp ON TRUE " +
      "WHERE wc.token = $1",
      [req.params.token]
    );
    var record = result.rows[0];
    if (!record) return res.status(404).json({ error: "Check-in not found" });
    if (record.completed_at) return res.status(409).json({ error: "Check-in already completed" });

    var summary = await createCheckinSummary({
      member: { firstName: record.first_name, lastName: record.last_name },
      responses: responses,
      currentPlan: record.plan_markdown,
      profile: record.profile_json,
    });

    await db.query(
      "UPDATE weekly_checkins SET responses_json = $1, ai_summary_json = $2, completed_at = NOW() WHERE id = $3",
      [JSON.stringify(responses), JSON.stringify(summary), record.id]
    );

    if (record.trainer_email) {
      await sendTrainerSummary({
        trainerEmail: record.trainer_email,
        memberName: record.first_name + " " + record.last_name,
        summary: summary,
      });
      await db.query("UPDATE weekly_checkins SET trainer_notified_at = NOW() WHERE id = $1", [record.id]);
    }

    res.json({ message: summary.memberReply, status: summary.status });
  } catch (err) {
    console.error("weekly check-in submission error:", err.message);
    res.status(500).json({ error: "Unable to process check-in" });
  }
});

// ─── Trainer: view all check-ins ─────────────────────────────────────────────

app.get("/trainer/checkins", async function (req, res) {
  if (!requireCronSecret(req, res)) return;

  try {
    var result = await db.query(
      "SELECT wc.id, wc.week_start, wc.completed_at, wc.responses_json, wc.ai_summary_json, " +
      "m.first_name, m.last_name, m.email, m.trainer_email " +
      "FROM weekly_checkins wc JOIN members m ON m.id = wc.member_id " +
      "WHERE wc.completed_at IS NOT NULL " +
      "ORDER BY wc.completed_at DESC LIMIT 100"
    );
    res.json({ checkins: result.rows });
  } catch (err) {
    console.error("trainer/checkins error:", err.message);
    res.status(500).json({ error: "Unable to load check-ins" });
  }
});

// ─── AI check-in summary ──────────────────────────────────────────────────────

async function createCheckinSummary(opts) {
  var member = opts.member;
  var responses = opts.responses;
  var currentPlan = opts.currentPlan;
  var profile = opts.profile;

  var client = getOpenAI();
  var completion = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You are the UGF weekly check-in assistant.\n" +
          "Review the member's check-in and create a concise summary for their trainer.\n" +
          "Do not diagnose medical conditions. Do not automatically change the workout.\n" +
          "Flag sharp, worsening, unusual, or persistent pain for trainer review.\n" +
          "Flag very low energy, poor sleep, repeated missed workouts, or excessive difficulty.\n\n" +
          "Return valid JSON only:\n" +
          "{\"status\":\"green\",\"memberReply\":\"string\",\"trainerSummary\":\"string\",\"wins\":[],\"barriers\":[],\"painFlags\":[],\"recoveryFlags\":[],\"suggestedActions\":[],\"programAdjustmentRecommended\":false,\"reason\":\"string\"}\n" +
          "status must be green, yellow, or red.\n" +
          "memberReply: short, warm, encouraging message shown to the member after they submit.\n" +
          "trainerSummary: concise, factual summary for the trainer."
      },
      {
        role: "user",
        content: JSON.stringify({ member: member, responses: responses, profile: profile, currentPlan: currentPlan }),
      },
    ],
  });
  return JSON.parse(completion.choices[0].message.content);
}

// ─── Zapier messengers ────────────────────────────────────────────────────────

async function sendCheckinMessage(member, checkinUrl) {
  var webhookUrl = process.env.ZAPIER_CHECKIN_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("ZAPIER_CHECKIN_WEBHOOK_URL not set — skipping message for", member.first_name);
    return;
  }
  var response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "member_checkin",
      firstName: member.first_name,
      lastName: member.last_name,
      email: member.email,
      phone: member.phone,
      preferredContact: member.preferred_contact,
      smsConsent: member.sms_consent,
      checkinUrl: checkinUrl,
    }),
  });
  if (!response.ok) throw new Error("Zapier check-in webhook failed: " + response.status);
}

async function sendTrainerSummary(opts) {
  var webhookUrl = process.env.ZAPIER_TRAINER_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("ZAPIER_TRAINER_WEBHOOK_URL not set — skipping trainer summary for", opts.memberName);
    return;
  }
  var summary = opts.summary;
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "trainer_summary",
      trainerEmail: opts.trainerEmail,
      memberName: opts.memberName,
      status: summary.status,
      trainerSummary: summary.trainerSummary,
      wins: summary.wins,
      barriers: summary.barriers,
      painFlags: summary.painFlags,
      recoveryFlags: summary.recoveryFlags,
      suggestedActions: summary.suggestedActions,
      programAdjustmentRecommended: summary.programAdjustmentRecommended,
      reason: summary.reason,
    }),
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

var PORT = process.env.PORT || 3001;
app.listen(PORT, function () {
  console.log("UGF backend running on port " + PORT);
});
