const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
const summaryEnding =
  "Let me know if I missed anything or if there’s something you’d like to add.";

function sourceBetween(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return serverSource.slice(start, end);
}

function evaluateAssignment(variableName, endMarker, context = {}) {
  const source = sourceBetween(`var ${variableName} =`, endMarker);
  const expression = source.slice(source.indexOf("=") + 1).trim().replace(/;$/, "");
  return vm.runInNewContext(expression, context);
}

const helperSource = sourceBetween(
  "var GOALS_COACH_OPENINGS =",
  "var COACH_SYSTEM ="
);
const helperContext = {};
vm.runInNewContext(helperSource, helperContext);

const openings = helperContext.GOALS_COACH_OPENINGS;
const coachPrompt = evaluateAssignment("COACH_SYSTEM", '\n\napp.post("/coach-message"', {
  GOALS_COACH_SUMMARY_ENDING: summaryEnding,
});
const coachRoute = sourceBetween(
  'app.post("/coach-message"',
  "// ─── POST /generate-personalized-workout"
);
const planPrompt = evaluateAssignment(
  "PLAN_SYSTEM",
  '\n\napp.post("/generate-personalized-workout"'
);

test("1.0 openings are concise, natural, and ask one question", () => {
  assert.equal(openings.length, 5);

  for (const opening of openings) {
    assert.ok(opening.split(/\s+/).length <= 22, opening);
    assert.equal((opening.match(/\?/g) || []).length, 1, opening);
    assert.doesNotMatch(
      opening,
      /glad you're here|take our time|right or wrong answers|your story|test to pass|thanks for/i
    );
  }
});

test("1.0 prompt uses a five-answer target without creating a safety cap", () => {
  assert.match(coachPrompt, /about five member answers is the normal target/i);
  assert.match(coachPrompt, /not a hard safety cap/i);
  assert.match(coachPrompt, /automatically present the summary/i);
  assert.match(coachPrompt, /Do not ask permission to present it/i);

  assert.equal(
    helperContext.countGoalsCoachMemberAnswers([
      { role: "assistant", content: "Question" },
      { role: "user", content: "Answer one" },
      { role: "assistant", content: "Question" },
      { role: "user", content: "Answer two" },
    ]),
    2
  );
  assert.match(coachRoute, /Assessment progress: the member has provided/);
});

test("1.0 follow-ups are limited to material programming decisions", () => {
  for (const decision of [
    "safety",
    "exercise selection",
    "workout schedule or duration",
    "available equipment",
    "adherence design",
  ]) {
    assert.match(coachPrompt, new RegExp(decision, "i"));
  }

  assert.match(coachPrompt, /Ask no more than ONE natural question/);
  assert.match(coachPrompt, /Do not ask compound or two-part questions/);
  assert.match(coachPrompt, /Do not automatically praise, thank, reassure, validate, or paraphrase/);
  assert.match(coachPrompt, /Do not use therapy-style reflection/);
  assert.doesNotMatch(coachPrompt, /every normal coaching response must/i);
});

test("1.0 requires explicit safety-screen completion before summary or plan readiness", () => {
  assert.match(
    coachPrompt,
    /Before any normal summary or\s+readyToGenerate=true, you MUST establish from the member's own words the presence or absence/i
  );

  for (const concern of [
    "pain or concerning symptoms",
    "an injury",
    "a recent surgery",
    "a medical or exercise restriction",
    "another safety concern that could affect training",
  ]) {
    assert.match(coachPrompt, new RegExp(concern, "i"));
  }

  assert.match(coachPrompt, /The member may provide this information voluntarily/);
  assert.match(coachPrompt, /do not\s+ask them to repeat any category already established/i);
  assert.match(coachPrompt, /If any category remains unresolved, ask\s+ONE concise safety-screening question/i);
  assert.match(coachPrompt, /Silence is not safety clearance/);
  assert.match(coachPrompt, /five-answer target\s+never overrides unresolved safety screening/i);
  assert.match(coachPrompt, /does not require the long movement questionnaire/i);
  assert.match(
    coachPrompt,
    /Do not enter the normal summary phase or set readyToGenerate=true until the required pre-summary\s+safety screen is complete/i
  );

  assert.match(coachRoute, /Required safety screening must be established from the member's own words/);
  assert.match(coachRoute, /silence and empty or default profile fields are not safety clearance/);
  assert.match(coachRoute, /five-answer target cannot override unresolved safety screening/);
});

test("1.0 safety stop overrides contradictory summary output", () => {
  const safetyReply =
    "Call 911 now for urgent medical attention. Here's what I heard from you:";
  const response = helperContext.finalizeGoalsCoachResponse(
    {
      reply: safetyReply,
      phase: "summary",
      readyToGenerate: true,
      safetyStop: true,
    },
    {}
  );

  assert.equal(response.reply, safetyReply);
  assert.equal(response.reply.includes(summaryEnding), false);
  assert.equal(response.readyToGenerate, false);
  assert.equal(response.safetyStop, true);
  assert.match(helperSource, /isSummaryMessage = !safetyStop && phase === "summary"/);
});

test("1.0 normal and corrected summaries keep the approved ending", () => {
  assert.equal(helperContext.GOALS_COACH_SUMMARY_ENDING, summaryEnding);
  assert.equal(
    helperContext.ensureGoalsCoachSummaryEnding("You want two short workouts each week."),
    `You want two short workouts each week.\n\n${summaryEnding}`
  );
  assert.equal(
    helperContext.ensureGoalsCoachSummaryEnding(`Summary.\n\n${summaryEnding}`),
    `Summary.\n\n${summaryEnding}`
  );

  const normalSummary = helperContext.finalizeGoalsCoachResponse(
    {
      reply: "You want two short workouts each week.",
      phase: "summary",
      readyToGenerate: true,
      safetyStop: false,
    },
    {}
  );
  assert.equal(normalSummary.reply.endsWith(summaryEnding), true);
  assert.equal(normalSummary.readyToGenerate, false);

  const correctedSummary = helperContext.finalizeGoalsCoachResponse(
    {
      reply: "Correction: you can train two days each week.",
      phase: "summary",
      profile: { daysPerWeek: "2" },
      readyToGenerate: false,
      safetyStop: false,
    },
    {}
  );
  assert.equal(correctedSummary.profile.daysPerWeek, "2");
  assert.equal(correctedSummary.reply.endsWith(summaryEnding), true);
  assert.equal(correctedSummary.reply.split(summaryEnding).length - 1, 1);

  assert.match(coachPrompt, /Set phase to summary and end exactly with/);
  assert.match(coachPrompt, /If the member corrects the summary, update the profile/);
  assert.match(coachRoute, /finalizeGoalsCoachResponse\(result, profile\)/);
  assert.doesNotMatch(coachRoute, /reply\.toLowerCase\(\)\.includes/);
});

test("1.0 keeps unknown facts unknown in both assessment and plan prompts", () => {
  assert.match(coachPrompt, /Preserve unasked or unanswered\s+information as unknown/);
  assert.match(coachPrompt, /Never infer a detail from silence/);
  assert.match(coachPrompt, /using only facts the member actually provided/);
  assert.match(planPrompt, /Use only facts explicitly supported by the member's profile or conversation/);
  assert.match(planPrompt, /missing, empty, ambiguous, or conflicting information as unknown or not assessed/);
  assert.match(planPrompt, /Never invent personal, movement, schedule, limitation, equipment, or preference details/);
  assert.doesNotMatch(planPrompt, /at least four explicit connections/i);
});

test("1.0 safety instructions and response JSON contract remain in place", () => {
  const safetyRules = [
    "- Do not diagnose medical conditions or claim medical clearance.",
    "- Do not recommend working through sharp, severe, unusual, or worsening pain.",
    "- Treat numbness, tingling, radiating pain, recent significant injury, recent surgery, unexplained weakness, or repeated falls as staff-review or medical-review concerns.",
    "- If the member reports chest pain, fainting, unexplained severe shortness of breath, stroke-like symptoms, or another urgent warning sign, stop the assessment, advise appropriate urgent medical attention, and set safetyStop=true.",
    "- If a concern is not urgent but warrants professional review, explain that clearly without alarming the member.",
  ];

  for (const rule of safetyRules) assert.ok(coachPrompt.includes(rule), rule);
  const response = helperContext.finalizeGoalsCoachResponse(
    { reply: "Ready.", phase: "confirmed", readyToGenerate: true },
    {}
  );
  assert.deepEqual(Object.keys(response).sort(), [
    "phase",
    "profile",
    "readyToGenerate",
    "reply",
    "safetyStop",
  ]);
});
