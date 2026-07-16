async function fakeGoalsCoachResponder(input) {
  const hasConcern = /pain|hurt|sharp/i.test(input.content);
  const requiresFollowUp = /follow[ -]?up/i.test(input.content);
  return {
    content: hasConcern
      ? "Please stop that exercise for now. I want one of our coaches to review this with you."
      : "I understand. This test response confirms the coaching conversation was stored.",
    structuredResponse: {
      acknowledgement: hasConcern
        ? "That deserves a careful look."
        : "I understand.",
      education: null,
      recommendation: hasConcern ? "Stop the exercise for now." : null,
      instruction: null,
      safetyAction: hasConcern ? "stop_and_staff_review" : "none",
      nextQuestion: null,
      staffReview: hasConcern
        ? { required: true, priority: "priority", memberWording: "one of our coaches" }
        : { required: false, priority: null, memberWording: null },
    },
    concern: hasConcern
      ? {
          category: "pain",
          safetyLevel: "priority",
          concerningSignals: /sharp/i.test(input.content) ? ["sharp_pain"] : [],
          stopExercise: true,
          memberFollowUpRequired: requiresFollowUp,
          recommendation: { action: "stop_exercise", permanentPlanChange: false },
        }
      : null,
  };
}

module.exports = { fakeGoalsCoachResponder };
