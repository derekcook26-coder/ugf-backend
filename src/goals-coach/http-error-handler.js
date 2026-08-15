function goalsCoachErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const normalizedPath = req.path.toLowerCase();
  if (
    !(normalizedPath === "/staff" || normalizedPath.startsWith("/staff/"))
    && !(normalizedPath === "/goals-coach" || normalizedPath.startsWith("/goals-coach/"))
    && !(normalizedPath === "/alpha/goals-coach" || normalizedPath.startsWith("/alpha/goals-coach/"))
    && !(normalizedPath === "/goalscoach" || normalizedPath.startsWith("/goalscoach/"))
  ) {
    return next(error);
  }

  if (req.path === "/goalscoach/member/safety-intake") {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (error && error.type === "entity.too.large") {
      return res.status(413).json({
        error: "SAFETY_INTAKE_BODY_TOO_LARGE",
        message: "The safety intake request is too large.",
      });
    }
    if (
      error
      && [
        "encoding.unsupported",
        "entity.parse.failed",
        "request.aborted",
        "request.size.invalid",
      ].includes(error.type)
    ) {
      return res.status(error.type === "encoding.unsupported" ? 415 : 400).json({
        error: error.type === "encoding.unsupported"
          ? "SAFETY_INTAKE_MEDIA_TYPE_UNSUPPORTED"
          : "SAFETY_INTAKE_INVALID",
        message: error.type === "encoding.unsupported"
          ? "Safety intake requires uncompressed application/json."
          : "Invalid safety intake request.",
      });
    }
  }

  if (req.path === "/goalscoach/member/coaching-consent") {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (error && error.type === "entity.too.large") return res.status(413).json({ error: "COACHING_CONSENT_BODY_TOO_LARGE", message: "The coaching consent request is too large." });
    if (error && ["encoding.unsupported", "entity.parse.failed", "request.aborted", "request.size.invalid"].includes(error.type)) {
      return res.status(error.type === "encoding.unsupported" ? 415 : 400).json({ error: error.type === "encoding.unsupported" ? "COACHING_CONSENT_MEDIA_TYPE_UNSUPPORTED" : "COACHING_CONSENT_INVALID", message: error.type === "encoding.unsupported" ? "Coaching consent requires uncompressed application/json." : "Invalid coaching consent request." });
    }
  }

  if (normalizedPath === "/goalscoach/member/today" || normalizedPath === "/goalscoach/member/today/") {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (error && error.type === "entity.too.large") return res.status(413).json({ error: "MEMBER_TODAY_INVALID" });
    if (error && ["encoding.unsupported", "entity.parse.failed", "request.aborted", "request.size.invalid"].includes(error.type)) return res.status(400).json({ error: "MEMBER_TODAY_INVALID" });
  }

  if (req.path === "/goalscoach/member/private-screen/login") {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (
      error
      && [
        "entity.too.large",
        "entity.parse.failed",
        "request.aborted",
        "request.size.invalid",
      ].includes(error.type)
    ) {
      return res.status(401).json({ error: "MEMBER_LOGIN_FAILED" });
    }
  }

  if (req.path === "/staff/member-pending-enrollments") {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (error && error.type === "entity.too.large") {
      return res.status(413).json({
        error: "MEMBER_PENDING_ENROLLMENT_BODY_TOO_LARGE",
        message: "The member pending-enrollment request is too large.",
      });
    }
    if (
      error
      && [
        "encoding.unsupported",
        "entity.parse.failed",
        "request.aborted",
        "request.size.invalid",
      ].includes(error.type)
    ) {
      return res.status(error.type === "encoding.unsupported" ? 415 : 400).json({
        error: error.type === "encoding.unsupported"
          ? "MEMBER_PENDING_ENROLLMENT_MEDIA_TYPE_UNSUPPORTED"
          : "MEMBER_PENDING_ENROLLMENT_INVALID",
        message: error.type === "encoding.unsupported"
          ? "Member pending enrollment requires uncompressed application/json."
          : "Invalid member pending-enrollment request.",
      });
    }
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
  const code = error && error.statusCode && error.code && !/^23/.test(error.code)
    ? error.code
    : "GOALS_COACH_ERROR";
  if (statusCode >= 500) console.error("[UGF] Goals Coach route error");
  const body = {
    error: code,
    message: statusCode < 500 || (error && error.exposeMessage) ? error.message : undefined,
  };
  if (error && error.publicDetails && typeof error.publicDetails === "object") {
    Object.assign(body, error.publicDetails);
  }
  return res.status(statusCode).json(body);
}

module.exports = { goalsCoachErrorHandler };
