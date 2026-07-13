const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: [
      "https://ultimate-goals-fitness.sintra.site",
      "http://localhost:3000",
    ],
  })
);

const GYMMASTER_BASE = "https://ugf.gymmasteronline.com/gatekeeper_api/v2";
const GYMMASTER_API_KEY = process.env.GYMMASTER_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

// ─── Verify member by name + email ──────────────────────────────────────────

app.post("/verify-member", async (req, res) => {
  const { firstName, lastName, email } = req.body;

  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: "firstName, lastName and email are required" });
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

// ─── Generate AI workout plan ────────────────────────────────────────────────

app.post("/generate-workout", async (req, res) => {
  const { assessment } = req.body;

  if (!assessment) {
    return res.status(400).json({ error: "assessment is required" });
  }

  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4096,
      messages: [{ role: "user", content: buildPrompt(assessment) }],
    });

    return res.json({ plan: completion.choices[0].message.content });
  } catch (err) {
    console.error("generate-workout error:", err.message);
    return res.status(500).json({ error: "Plan generation failed" });
  }
});

// ─── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(a) {
  return `You are a certified personal trainer at Ultimate Goals Fitness — a 24/7 community gym in the Black Hills area of South Dakota with locations in Black Hawk and Rapid Valley. You are warm, encouraging, and no-nonsense. Your job is to build a genuinely useful, personalized workout plan for this member.

MEMBER PROFILE:
- Name: ${a.name}
- Age: ${a.age || "Not provided"}
- Home Location: ${a.location}
- Fitness Level: ${a.fitnessLevel}
- Primary Goals: ${a.goals}
- Days Per Week Available: ${a.daysPerWeek}
- Preferred Workout Time: ${a.preferredTime || "Flexible"}
- Injuries / Limitations: ${a.injuries || "None reported"}
- Current Activity Outside Gym: ${a.currentActivity || "Not specified"}
- Additional Notes: ${a.additionalNotes || "None"}

Build their complete workout plan using this exact structure:

---

**Hey [first name], here's your UGF plan!**
[2–3 sentences that feel personal — reference their goal, acknowledge their level, and hype them up. Sound like a real trainer, not a robot.]

---

## Your Weekly Schedule

[Show a clean day-by-day breakdown for the number of days they selected. Label each day clearly, e.g. "Day 1 — Upper Body Strength". Include at least one rest/recovery day with a brief note.]

---

## Workout Details

[For each training day, list:]

### Day X — [Focus]
| Exercise | Sets | Reps / Duration | Trainer Tip |
|---|---|---|---|
[4–6 exercises per day. Trainer Tip should be one short, practical coaching cue. Modify any exercises that conflict with their injuries.]

---

## Weeks 3–4 Progression

[2–3 bullet points on how to increase intensity — e.g. add weight, reduce rest, add a set. Keep it simple and actionable.]

---

## Nutrition Tip

[One focused, practical tip directly tied to their primary goal. No generic advice — make it specific.]

---

[Close with one punchy, motivating sentence in UGF's voice — energetic, community-feel, no gimmicks.]`;
}

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`UGF backend running on port ${PORT}`));
