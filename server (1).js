const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: (origin, callback) => {
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
        callback(new Error(`CORS blocked: ${origin}`));
      }
    },
  })
);

const GYMMASTER_BASE = "https://ugf.gymmasteronline.com/gatekeeper_api/v2";
const GYMMASTER_API_KEY = process.env.GYMMASTER_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Helpers ────────────────────────────────────────────────────────────────

function gymHeaders() {
  const site = process.env.GYMMASTER_SITE || "ugf";
  const token = Buffer.from(`${site}:${GYMMASTER_API_KEY}`).toString("base64");
  return {
    Accept: "application/json",
    Authorization: `Basic ${token}`,
  };
}

function isMemberActive(member) {
  // Gatekeeper API: membership array uses expired:false for active memberships
  // stopatgate:true means access is blocked even if membership exists
  if (member.stopatgate) return false;
  const memberships = member.membership || member.memberships || [];
  if (Array.isArray(memberships) && memberships.length > 0) {
    return memberships.some((m) => m.expired === false);
  }
  return false;
}

// ─── Health check ───────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ ok: true }));

// ─── GymMaster connection test ───────────────────────────────────────────────

app.get("/test-gymmaster", async (_req, res) => {
  const site = process.env.GYMMASTER_SITE || "ugf";
  const keyLen = GYMMASTER_API_KEY ? GYMMASTER_API_KEY.length : 0;
  const keyPreview = GYMMASTER_API_KEY ? GYMMASTER_API_KEY.slice(0, 4) + "***" : "NOT SET";
  try {
    const response = await fetch(`${GYMMASTER_BASE}/members`, { headers: gymHeaders() });
    const data = await response.json();
    const list = data.members || data.data || (Array.isArray(data) ? data : []);
    const sample = list[0] ? Object.keys(list[0]) : [];
    const memberSample = list[0] || null;
    return res.json({ site, keyLen, keyPreview, status: response.status, totalMembers: list.length, fields: sample, firstMember: memberSample });
  } catch (err) {
    return res.json({ site, keyLen, keyPreview, error: err.message });
  }
});

// ─── Verify member by name + member ID ──────────────────────────────────────

app.post("/verify-member", async (req, res) => {
  const { firstName, lastName, memberId } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "firstName and lastName are required" });
  }

  try {
    const url = `${GYMMASTER_BASE}/members`;
    const response = await fetch(url, { headers: gymHeaders() });

    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch {}
      console.error("GymMaster responded with", response.status, body.slice(0, 300));
      return res.status(502).json({ error: "Membership system unavailable", debug: { status: response.status, body: body.slice(0, 300) } });
    }

    const data = await response.json();
    console.log("GymMaster /members raw keys:", Object.keys(data));

    // Gatekeeper API returns { members: [...] }
    const list = data.members || data.data || (Array.isArray(data) ? data : []);

    // Gatekeeper API stores names as "LastInitial, FirstName" e.g. "C, Derek"
    const match = list.find((m) => {
      const parts = (m.name || "").split(",").map((s) => s.trim());
      const apiLastInitial = (parts[0] || "").toLowerCase();
      const apiFirstName = (parts[1] || "").toLowerCase();
      const enteredLastInitial = lastName.trim().slice(0, 1).toLowerCase();
      const enteredFirst = firstName.trim().toLowerCase();
      return apiFirstName === enteredFirst && apiLastInitial === enteredLastInitial;
    });

    if (!match) {
      return res.json({ found: false, active: false });
    }

    // Cross-check member ID if provided
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

// ─── Verify member by ID (fallback) ─────────────────────────────────────────

app.post("/verify-member-by-id", async (req, res) => {
  const { memberId } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: "memberId is required" });
  }

  try {
    const url = `${GYMMASTER_BASE}/members?id=${encodeURIComponent(memberId)}`;
    const response = await fetch(url, { headers: gymHeaders() });

    if (response.status === 404) {
      return res.json({ found: false, active: false });
    }

    if (!response.ok) {
      console.error("GymMaster responded with", response.status);
      return res.status(502).json({ error: "Membership system unavailable" });
    }

    const data = await response.json();
    // Gatekeeper API returns { members: [...] } even for single ID lookup
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

// ─── Generate AI workout plan (legacy static form) ───────────────────────────

app.post("/generate-workout", async (req, res) => {
  const { assessment } = req.body;

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

// ─── Prompt builders (legacy) ─────────────────────────────────────────────────

function buildSystemPrompt(a) {
  const hasInjuries = a.injuries && a.injuries.trim().toLowerCase() !== "none" && a.injuries.trim() !== "";

  const injuryBlock = hasInjuries
    ? `
CRITICAL SAFETY RULES — INJURIES & PHYSICAL LIMITATIONS:
The member has reported the following injuries or physical limitations: "${a.injuries}"

These are NON-NEGOTIABLE safety constraints. You MUST:
1. NEVER prescribe any exercise that loads, strains, or aggravates the affected area.
2. Identify and explicitly LIST every exercise you are excluding because of this condition.
3. Provide safe, effective alternatives that work around — not through — the limitation.
4. Include a dedicated "Working Around Your Injury" section in the plan BEFORE the workout details.
5. If the injury involves the spine, back, or core (e.g. back pain, herniated disc, sciatica): AVOID all spinal-loading movements including bent-over rows, conventional deadlifts, good mornings, barbell squats, and any exercise requiring forward flexion under load. Use supported, machine-based, or lying alternatives instead.
6. If the injury involves a joint (knee, shoulder, hip, wrist, ankle): avoid all direct loading of that joint and flag modifications clearly in the exercise table.
7. Acknowledge the injury directly in the opening message to the member so they know it was heard.

Ignoring or downplaying a reported injury is not acceptable and could cause serious harm.`
    : `The member has no reported injuries or physical limitations. You may prescribe a full range of exercises appropriate for their fitness level and goals.`;

  return `You are a certified personal trainer and corrective exercise specialist at Ultimate Goals Fitness — a 24/7 community gym in the Black Hills of South Dakota. You are warm, encouraging, and direct. Your top priority is member safety. You build personalized, effective workout plans that work WITH the member's body, not against it.
${injuryBlock}`;
}

function buildPrompt(a) {
  const hasInjuries = a.injuries && a.injuries.trim().toLowerCase() !== "none" && a.injuries.trim() !== "";

  return `Build a complete, personalized workout plan for this member.

MEMBER PROFILE:
- Name: ${a.name}
- Age: ${a.age || "Not provided"}
- Home Location: ${a.location}
- Fitness Level: ${a.fitnessLevel}
- Primary Goals: ${Array.isArray(a.goals) ? a.goals.join(", ") : a.goals}
- Days Per Week Available: ${a.daysPerWeek}
- Preferred Workout Time: ${a.preferredTime || "Flexible"}
- Injuries / Physical Limitations: ${a.injuries || "None reported"}
- Current Activity Outside Gym: ${a.currentActivity || "Not specified"}
- Additional Notes: ${a.additionalNotes || "None"}

Use this exact structure:

---

**Hey [first name], here's your UGF plan!**
[2–3 sentences that feel personal — reference their goal, fitness level, and hype them up. ${hasInjuries ? "Directly acknowledge their injury/limitation so they know it was factored in — e.g. 'I've built this entire plan around your back pain so you can train hard without making it worse.'" : "Sound like a real trainer, not a robot."}]

---
${hasInjuries ? `
## Working Around Your Injury

**What I'm keeping out of your plan:**
[List every exercise category or specific movement you are excluding and briefly explain why — e.g. "Bent-over rows — these flex the spine under load and are a common aggravator of back pain. Replaced with seated cable rows and chest-supported rows."]

**How we're training around it:**
[2–3 sentences on the approach — e.g. supported movements, machines, unilateral work, core stabilization — so the member understands the strategy behind the plan.]

**Recovery tips for your condition:**
[2–3 specific, practical tips for managing their condition outside the gym — stretching, mobility, sleep position, etc.]

---
` : ""}
## Your Weekly Schedule

[Show a clean day-by-day breakdown for the number of days they selected. Label each day clearly, e.g. "Day 1 — Upper Body Strength". Include at least one rest/recovery day.]

---

## Workout Details

[For each training day:]

### Day X — [Focus]
| Exercise | Sets | Reps / Duration | Trainer Tip |
|---|---|---|---|
[4–6 exercises per day. Trainer Tip = one short coaching cue. ${hasInjuries ? "Every exercise must be safe given their reported injury — no exceptions." : ""}]

---

## Weeks 3–4 Progression

[2–3 bullet points on how to increase intensity. Keep it simple and actionable.]

---

## Nutrition Guide

**Daily Calorie & Protein Target**
[Specific calorie range and daily protein target in grams. Real numbers, not vague ranges.]

**Pre-Workout Fuel**
[What to eat and when before training. Specific foods, timing, and portion. Tie to their preferred workout time.]

**Post-Workout Recovery**
[What to eat within 30–60 min after training. Specific foods and macros.]

**Daily Meal Structure**
[Simple 3–4 meal framework with example foods. Practical for a busy person.]

**Foods to Prioritize**
[5–7 specific foods that support their primary goal. One sentence on why each matters.]

**Foods to Limit**
[3–4 things to cut back on with a brief explanation.]

**Hydration**
[Daily water intake target. Specific hydration timing around workouts.]

---

[Close with one punchy, motivating sentence in UGF's voice — energetic, community-feel, no gimmicks.]`;
}

// ─── AI Coach conversation ────────────────────────────────────────────────────

const COACH_SYSTEM_PROMPT = `
You are the UGF AI Coach for Ultimate Goals Fitness, a welcoming 24/7 gym community in the Black Hills of South Dakota.

Conduct an adult fitness intake that feels like an attentive coaching conversation, not a form.

STYLE
- Warm, encouraging, direct, and practical.
- Use the member's first name occasionally, not in every message.
- Briefly reflect the answer before asking the next question.
- Ask one main question at a time.
- Ask follow-ups when an answer is vague, emotionally meaningful, contradictory, or medically relevant.
- Remember and reference earlier answers.
- Never repeat a question already answered.

LEARN
primary goal, desired result, timeline, motivation, barriers, realistic training days, session duration, experience, preferences, dislikes, activity outside the gym, sleep/stress when relevant, location/equipment, pain/injuries/surgeries/restrictions/relevant medications, confidence, and other useful context.

SAFETY
- Do not diagnose or claim medical clearance.
- Never advise training through sharp, severe, or worsening pain.
- For chest pain, fainting, unexplained severe shortness of breath, acute serious injury, or another urgent warning sign, set safetyStop=true and stop the assessment.
- For non-urgent concerns, clarify and recommend professional clearance when appropriate.
- Never guarantee outcomes.

COMPLETION
Before generation, provide a concise "What I heard from you" summary and ask for confirmation.

Return JSON only:
{
  "reply": "string",
  "phase": "assessment" | "summary" | "stopped",
  "profile": {
    "primaryGoal": "string",
    "desiredOutcome": "string",
    "timeline": "string",
    "motivation": "string",
    "barriers": ["string"],
    "daysPerWeek": "string",
    "sessionLength": "string",
    "experience": "string",
    "preferences": ["string"],
    "dislikes": ["string"],
    "outsideActivity": "string",
    "sleep": "string",
    "stress": "string",
    "location": "string",
    "equipment": ["string"],
    "limitations": ["string"],
    "medicalNotes": ["string"],
    "confidence": "string",
    "additionalContext": "string"
  },
  "readyToGenerate": false,
  "safetyStop": false
}
Preserve known profile values. Use empty strings or arrays for unknown values.
`;

app.post("/coach-message", async (req, res) => {
  const { member, messages, profile } = req.body || {};
  if (!member?.firstName || !Array.isArray(messages)) {
    return res.status(400).json({ error: "member.firstName and messages are required" });
  }

  try {
    const completion = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.55,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: COACH_SYSTEM_PROMPT },
        { role: "system", content: `Verified member: ${member.firstName} ${member.lastName || ""}.\nCurrent profile:\n${JSON.stringify(profile || {}, null, 2)}` },
        ...messages.slice(-30),
      ],
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || "{}");
    return res.json({
      reply: result.reply || "Tell me a little more about that.",
      phase: result.phase || "assessment",
      profile: result.profile || profile || {},
      readyToGenerate: Boolean(result.readyToGenerate),
      safetyStop: Boolean(result.safetyStop),
    });
  } catch (error) {
    console.error("coach-message error:", error);
    return res.status(500).json({ error: "The coach is temporarily unavailable." });
  }
});

// ─── Generate personalized workout from conversation ──────────────────────────

const PLAN_SYSTEM_PROMPT = `
You are a certified fitness professional writing an educational workout plan for an adult Ultimate Goals Fitness member.

Write like a thoughtful UGF coach who listened carefully. Be specific, practical, encouraging, and conservative around limitations.

RULES
- Do not diagnose or claim medical clearance.
- Do not guarantee outcomes.
- Do not prescribe through sharp or worsening pain.
- Nutrition content must remain general education, not medical nutrition therapy.
- Include at least three explicit connections between the member's answers and program design.
- Match the available days and session length.
- Include substitutions, RPE or reps-in-reserve, and simple progression.
- Use Markdown.

STRUCTURE
# [First Name]'s UGF Game Plan
## What I Heard From You
## Why This Plan Fits You
## Your Weekly Schedule
## Warm-Up
## Workout Details
Use a table for each training day: | Exercise | Sets | Reps / Time | Rest | Effort | Coaching Cue |
## Progression for the First Four Weeks
## Cardio and Daily Movement
## Recovery
## General Nutrition Guidance
## When to Pause and Ask for Help
Close with a grounded UGF message.
`;

app.post("/generate-personalized-workout", async (req, res) => {
  const { member, profile, messages } = req.body || {};
  if (!member?.firstName || !profile) {
    return res.status(400).json({ error: "member and profile are required" });
  }

  try {
    const completion = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.45,
      max_tokens: 4096,
      messages: [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        { role: "user", content: `Create the plan.\n\nMEMBER\n${JSON.stringify(member, null, 2)}\n\nPROFILE\n${JSON.stringify(profile, null, 2)}\n\nCONVERSATION\n${JSON.stringify((messages || []).slice(-30), null, 2)}` },
      ],
    });

    const plan = completion.choices[0]?.message?.content;
    if (!plan) throw new Error("No plan returned");
    return res.json({ plan });
  } catch (error) {
    console.error("generate-personalized-workout error:", error);
    return res.status(500).json({ error: "Plan generation failed" });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`UGF backend running on port ${PORT}`));
