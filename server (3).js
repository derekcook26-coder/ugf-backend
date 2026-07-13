const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: function (origin, callback) {
      const allowed = [
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

const GYMMASTER_BASE = "https://ugf.gymmasteronline.com/gatekeeper_api/v2";
const GYMMASTER_API_KEY = process.env.GYMMASTER_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });

function gymHeaders() {
  const site = process.env.GYMMASTER_SITE || "ugf";
  const token = Buffer.from(site + ":" + GYMMASTER_API_KEY).toString("base64");
  return {
    Accept: "application/json",
    Authorization: "Basic " + token,
  };
}

function isMemberActive(member) {
  if (member.stopatgate) return false;
  const memberships = member.membership || member.memberships || [];
  if (Array.isArray(memberships) && memberships.length > 0) {
    return memberships.some(function (m) { return m.expired === false; });
  }
  return false;
}

app.get("/health", function (_req, res) {
  res.json({ ok: true });
});

app.get("/test-gymmaster", async function (_req, res) {
  const site = process.env.GYMMASTER_SITE || "ugf";
  const keyLen = GYMMASTER_API_KEY ? GYMMASTER_API_KEY.length : 0;
  const keyPreview = GYMMASTER_API_KEY ? GYMMASTER_API_KEY.slice(0, 4) + "***" : "NOT SET";
  try {
    const response = await fetch(GYMMASTER_BASE + "/members", { headers: gymHeaders() });
    const data = await response.json();
    const list = data.members || data.data || (Array.isArray(data) ? data : []);
    const sample = list[0] ? Object.keys(list[0]) : [];
    const memberSample = list[0] || null;
    return res.json({
      site: site,
      keyLen: keyLen,
      keyPreview: keyPreview,
      status: response.status,
      totalMembers: list.length,
      fields: sample,
      firstMember: memberSample,
    });
  } catch (err) {
    return res.json({ site: site, keyLen: keyLen, keyPreview: keyPreview, error: err.message });
  }
});

app.post("/verify-member", async function (req, res) {
  const firstName = req.body.firstName;
  const lastName = req.body.lastName;
  const memberId = req.body.memberId;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "firstName and lastName are required" });
  }

  try {
    const response = await fetch(GYMMASTER_BASE + "/members", { headers: gymHeaders() });

    if (!response.ok) {
      var bodyText = "";
      try { bodyText = await response.text(); } catch (e) {}
      console.error("GymMaster responded with", response.status, bodyText.slice(0, 300));
      return res.status(502).json({ error: "Membership system unavailable" });
    }

    const data = await response.json();
    const list = data.members || data.data || (Array.isArray(data) ? data : []);

    const match = list.find(function (m) {
      const parts = (m.name || "").split(",").map(function (s) { return s.trim(); });
      const apiLastInitial = (parts[0] || "").toLowerCase();
      const apiFirstName = (parts[1] || "").toLowerCase();
      const enteredLastInitial = lastName.trim().slice(0, 1).toLowerCase();
      const enteredFirst = firstName.trim().toLowerCase();
      return apiFirstName === enteredFirst && apiLastInitial === enteredLastInitial;
    });

    if (!match) {
      return res.json({ found: false, active: false });
    }

    if (memberId) {
      const gymId = String(match.id || match.member_id || "").trim();
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
  const memberId = req.body.memberId;

  if (!memberId) {
    return res.status(400).json({ error: "memberId is required" });
  }

  try {
    const response = await fetch(
      GYMMASTER_BASE + "/members?id=" + encodeURIComponent(memberId),
      { headers: gymHeaders() }
    );

    if (response.status === 404) {
      return res.json({ found: false, active: false });
    }

    if (!response.ok) {
      console.error("GymMaster responded with", response.status);
      return res.status(502).json({ error: "Membership system unavailable" });
    }

    const data = await response.json();
    const list = data.members || data.data || (Array.isArray(data) ? data : []);
    const member = list[0];

    if (!member) {
      return res.json({ found: false, active: false });
    }

    return res.json({ found: true, active: isMemberActive(member) });
  } catch (err) {
    console.error("verify-member-by-id error:", err.message);
    return res.status(500).json({ error: "Verification service error" });
  }
});

app.post("/generate-workout", async function (req, res) {
  const assessment = req.body.assessment;

  if (!assessment) {
    return res.status(400).json({ error: "assessment is required" });
  }

  try {
    const completion = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
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
  const hasInjuries =
    a.injuries &&
    a.injuries.trim().toLowerCase() !== "none" &&
    a.injuries.trim() !== "";

  const injuryBlock = hasInjuries
    ? "CRITICAL SAFETY RULES: The member reported: \"" +
      a.injuries +
      "\". NEVER prescribe exercises that load the affected area. List every excluded exercise. Provide safe alternatives. If the injury involves the spine or back: AVOID bent-over rows, conventional deadlifts, good mornings, barbell squats, and forward flexion under load. Acknowledge the injury in your opening."
    : "The member has no reported injuries. You may prescribe a full range of exercises appropriate for their fitness level and goals.";

  return (
    "You are a certified personal trainer at Ultimate Goals Fitness, a 24/7 community gym in the Black Hills of South Dakota. " +
    "You are warm, encouraging, and direct. Member safety is your top priority.\n\n" +
    injuryBlock
  );
}

function buildPrompt(a) {
  const hasInjuries =
    a.injuries &&
    a.injuries.trim().toLowerCase() !== "none" &&
    a.injuries.trim() !== "";

  return (
    "Build a complete personalized workout plan.\n\n" +
    "MEMBER PROFILE:\n" +
    "- Name: " + a.name + "\n" +
    "- Age: " + (a.age || "Not provided") + "\n" +
    "- Location: " + a.location + "\n" +
    "- Fitness Level: " + a.fitnessLevel + "\n" +
    "- Goals: " + (Array.isArray(a.goals) ? a.goals.join(", ") : a.goals) + "\n" +
    "- Days Per Week: " + a.daysPerWeek + "\n" +
    "- Preferred Time: " + (a.preferredTime || "Flexible") + "\n" +
    "- Injuries: " + (a.injuries || "None") + "\n" +
    "- Outside Activity: " + (a.currentActivity || "Not specified") + "\n" +
    "- Notes: " + (a.additionalNotes || "None") + "\n\n" +
    "Include: weekly schedule, workout tables with sets/reps/trainer tips, weeks 3-4 progression, nutrition guide, and a motivating closing line." +
    (hasInjuries ? " Every exercise must be safe given the reported injury." : "")
  );
}

const COACH_SYSTEM_PROMPT =
  "You are the UGF AI Coach for Ultimate Goals Fitness, a welcoming 24/7 gym community in the Black Hills of South Dakota.\n\n" +
  "Conduct an adult fitness intake that feels like an attentive coaching conversation, not a form.\n\n" +
  "STYLE\n" +
  "- Warm, encouraging, direct, and practical.\n" +
  "- Use the member's first name occasionally, not in every message.\n" +
  "- Briefly reflect the answer before asking the next question.\n" +
  "- Ask one main question at a time.\n" +
  "- Ask follow-ups when an answer is vague, emotionally meaningful, contradictory, or medically relevant.\n" +
  "- Remember and reference earlier answers.\n" +
  "- Never repeat a question already answered.\n\n" +
  "LEARN\n" +
  "primary goal, desired result, timeline, motivation, barriers, realistic training days, session duration, experience, preferences, dislikes, activity outside the gym, sleep/stress when relevant, location/equipment, pain/injuries/surgeries/restrictions/relevant medications, confidence, and other useful context.\n\n" +
  "SAFETY\n" +
  "- Do not diagnose or claim medical clearance.\n" +
  "- Never advise training through sharp, severe, or worsening pain.\n" +
  "- For chest pain, fainting, unexplained severe shortness of breath, acute serious injury, or another urgent warning sign, set safetyStop=true and stop the assessment.\n" +
  "- For non-urgent concerns, clarify and recommend professional clearance when appropriate.\n" +
  "- Never guarantee outcomes.\n\n" +
  "COMPLETION\n" +
  "Before generation, provide a concise \"What I heard from you\" summary and ask for confirmation.\n\n" +
  "Return JSON only:\n" +
  "{\n" +
  "  \"reply\": \"string\",\n" +
  "  \"phase\": \"assessment\",\n" +
  "  \"profile\": {\n" +
  "    \"primaryGoal\": \"string\",\n" +
  "    \"desiredOutcome\": \"string\",\n" +
  "    \"timeline\": \"string\",\n" +
  "    \"motivation\": \"string\",\n" +
  "    \"barriers\": [],\n" +
  "    \"daysPerWeek\": \"string\",\n" +
  "    \"sessionLength\": \"string\",\n" +
  "    \"experience\": \"string\",\n" +
  "    \"preferences\": [],\n" +
  "    \"dislikes\": [],\n" +
  "    \"outsideActivity\": \"string\",\n" +
  "    \"sleep\": \"string\",\n" +
  "    \"stress\": \"string\",\n" +
  "    \"location\": \"string\",\n" +
  "    \"equipment\": [],\n" +
  "    \"limitations\": [],\n" +
  "    \"medicalNotes\": [],\n" +
  "    \"confidence\": \"string\",\n" +
  "    \"additionalContext\": \"string\"\n" +
  "  },\n" +
  "  \"readyToGenerate\": false,\n" +
  "  \"safetyStop\": false\n" +
  "}\n" +
  "Preserve known profile values. Use empty strings or arrays for unknown values.";

app.post("/coach-message", async function (req, res) {
  const member = req.body.member;
  const messages = req.body.messages;
  const profile = req.body.profile;

  if (!member || !member.firstName || !Array.isArray(messages)) {
    return res.status(400).json({ error: "member.firstName and messages are required" });
  }

  try {
    const systemMessages = [
      { role: "system", content: COACH_SYSTEM_PROMPT },
      {
        role: "system",
        content:
          "Verified member: " +
          member.firstName +
          " " +
          (member.lastName || "") +
          ".\nCurrent profile:\n" +
          JSON.stringify(profile || {}, null, 2),
      },
    ];

    const completion = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.55,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: systemMessages.concat(messages.slice(-30)),
    });

    const result = JSON.parse(completion.choices[0].message.content || "{}");
    return res.json({
      reply: result.reply || "Tell me a little more about that.",
      phase: result.phase || "assessment",
      profile: result.profile || profile || {},
      readyToGenerate: Boolean(result.readyToGenerate),
      safetyStop: Boolean(result.safetyStop),
    });
  } catch (err) {
    console.error("coach-message error:", err.message);
    return res.status(500).json({ error: "The coach is temporarily unavailable." });
  }
});

const PLAN_SYSTEM_PROMPT =
  "You are a certified fitness professional writing an educational workout plan for an adult Ultimate Goals Fitness member.\n\n" +
  "Write like a thoughtful UGF coach who listened carefully. Be specific, practical, encouraging, and conservative around limitations.\n\n" +
  "RULES\n" +
  "- Do not diagnose or claim medical clearance.\n" +
  "- Do not guarantee outcomes.\n" +
  "- Do not prescribe through sharp or worsening pain.\n" +
  "- Nutrition content must remain general education, not medical nutrition therapy.\n" +
  "- Include at least three explicit connections between the member's answers and program design.\n" +
  "- Match the available days and session length.\n" +
  "- Include substitutions, RPE or reps-in-reserve, and simple progression.\n" +
  "- Use Markdown.\n\n" +
  "STRUCTURE\n" +
  "# [First Name]'s UGF Game Plan\n" +
  "## What I Heard From You\n" +
  "## Why This Plan Fits You\n" +
  "## Your Weekly Schedule\n" +
  "## Warm-Up\n" +
  "## Workout Details\n" +
  "Use a table for each training day: | Exercise | Sets | Reps / Time | Rest | Effort | Coaching Cue |\n" +
  "## Progression for the First Four Weeks\n" +
  "## Cardio and Daily Movement\n" +
  "## Recovery\n" +
  "## General Nutrition Guidance\n" +
  "## When to Pause and Ask for Help\n" +
  "Close with a grounded UGF message.";

app.post("/generate-personalized-workout", async function (req, res) {
  const member = req.body.member;
  const profile = req.body.profile;
  const messages = req.body.messages;

  if (!member || !member.firstName || !profile) {
    return res.status(400).json({ error: "member and profile are required" });
  }

  try {
    const completion = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.45,
      max_tokens: 4096,
      messages: [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            "Create the plan.\n\nMEMBER\n" +
            JSON.stringify(member, null, 2) +
            "\n\nPROFILE\n" +
            JSON.stringify(profile, null, 2) +
            "\n\nCONVERSATION\n" +
            JSON.stringify((messages || []).slice(-30), null, 2),
        },
      ],
    });

    const plan = completion.choices[0].message.content;
    if (!plan) throw new Error("No plan returned");
    return res.json({ plan: plan });
  } catch (err) {
    console.error("generate-personalized-workout error:", err.message);
    return res.status(500).json({ error: "Plan generation failed" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, function () {
  console.log("UGF backend running on port " + PORT);
});
