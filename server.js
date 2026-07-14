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

app.get("/health", function (_req, res) {
  res.json({ ok: true });
});

app.get("/test-gymmaster", async function (_req, res) {
  var site = process.env.GYMMASTER_SITE || "ugf";
  var key = process.env.GYMMASTER_API_KEY;
  var keyLen = key ? key.length : 0;
  var keyPreview = key ? key.slice(0, 4) + "***" : "NOT SET";
  try {
    var response = await fetch(GYMMASTER_BASE + "/members", { headers: gymHeaders() });
    var data = await response.json();
    var list = data.members || data.data || (Array.isArray(data) ? data : []);
    var sample = list[0] ? Object.keys(list[0]) : [];
    return res.json({
      site: site,
      keyLen: keyLen,
      keyPreview: keyPreview,
      status: response.status,
      totalMembers: list.length,
      fields: sample,
      firstMember: list[0] || null,
    });
  } catch (err) {
    return res.json({ site: site, keyLen: keyLen, keyPreview: keyPreview, error: err.message });
  }
});

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

    if (response.status === 404) {
      return res.json({ found: false, active: false });
    }

    if (!response.ok) {
      console.error("GymMaster responded with", response.status);
      return res.status(502).json({ error: "Membership system unavailable" });
    }

    var data = await response.json();
    var list = data.members || data.data || (Array.isArray(data) ? data : []);
    var member = list[0];

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
  var assessment = req.body.assessment;

  if (!assessment) {
    return res.status(400).json({ error: "assessment is required" });
  }

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
    (hasInjuries ? " Every exercise must be safe given the reported injury." : "");
}

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

var PLAN_SYSTEM =
  "You are a certified fitness professional writing a workout plan for an Ultimate Goals Fitness member.\n\n" +
  "Write like a UGF coach who listened carefully. Be specific, practical, encouraging, and conservative around limitations.\n\n" +
  "RULES\n" +
  "- Do not diagnose or claim medical clearance.\n" +
  "- Do not guarantee outcomes.\n" +
  "- Do not prescribe through sharp or worsening pain.\n" +
  "- Nutrition content is general education only, not medical nutrition therapy.\n" +
  "- Include at least three explicit connections between the member's answers and program design.\n" +
  "- Match the available days and session length.\n" +
  "- Include substitutions, effort guidance, and simple progression.\n" +
  "- Use Markdown.\n\n" +
  "STRUCTURE\n" +
  "# [First Name]'s UGF Game Plan\n" +
  "## What I Heard From You\n" +
  "## Why This Plan Fits You\n" +
  "## Your Weekly Schedule\n" +
  "## Warm-Up\n" +
  "## Workout Details\n" +
  "Table per day: | Exercise | Sets | Reps / Time | Rest | Effort | Coaching Cue |\n" +
  "## Progression for the First Four Weeks\n" +
  "## Cardio and Daily Movement\n" +
  "## Recovery\n" +
  "## General Nutrition Guidance\n" +
  "## When to Pause and Ask for Help\n" +
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
          content: "Create the plan.\n\nMEMBER\n" +
            JSON.stringify(member, null, 2) +
            "\n\nPROFILE\n" +
            JSON.stringify(profile, null, 2) +
            "\n\nCONVERSATION\n" +
            JSON.stringify((messages || []).slice(-30), null, 2),
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

var PORT = process.env.PORT || 3001;
app.listen(PORT, function () {
  console.log("UGF backend running on port " + PORT);
});
