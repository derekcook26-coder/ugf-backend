function goalsCoachErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (
    !(req.path === "/staff" || req.path.startsWith("/staff/"))
    && !(req.path === "/goals-coach" || req.path.startsWith("/goals-coach/"))
    && !(req.path === "/alpha/goals-coach" || req.path.startsWith("/alpha/goals-coach/"))
  ) {
    return next(error);
  }

  if (error && error.code === "23503") {
    return res.status(409).json({ error: "OWNERSHIP_CONSTRAINT_FAILED" });
  }
  if (error && error.code === "23505") {
    return res.status(409).json({ error: "CONFLICT" });
  }
  if (error && error.code === "23514") {
    if (error.constraint === "goals_coach_alpha_consent_events_append_only") {
      return res.status(409).json({ error: "ALPHA_CONSENT_HISTORY_IMMUTABLE" });
    }
    if (error.constraint === "member_coach_assignments_open_review_guard") {
      return res.status(409).json({ error: "REVIEW_REASSIGNMENT_REQUIRED" });
    }
    if (error.constraint === "member_coach_assignments_history_immutable") {
      return res.status(409).json({ error: "ASSIGNMENT_HISTORY_IMMUTABLE" });
    }
    return res.status(409).json({ error: "CONSTRAINT_VIOLATION" });
  }

  const statusCode = error && error.statusCode ? error.statusCode : 500;
  const code = error && error.code && !/^23/.test(error.code)
    ? error.code
    : "GOALS_COACH_ERROR";
  if (statusCode >= 500) console.error("[UGF] Goals Coach route error");
  return res.status(statusCode).json({ error: code, message: statusCode < 500 ? error.message : undefined });
}

module.exports = { goalsCoachErrorHandler };
