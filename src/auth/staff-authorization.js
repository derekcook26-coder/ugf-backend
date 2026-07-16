function createStaffAuthorization(options) {
  const db = options.db;

  async function loadActiveStaff(req, res, next) {
    try {
      const result = await db.query(
        `SELECT id, display_name, role, active
         FROM staff_users
         WHERE auth_provider = $1 AND auth_subject = $2
         LIMIT 1`,
        [req.staffIdentity.authProvider, req.staffIdentity.authSubject]
      );
      if (!result.rows.length || !result.rows[0].active) {
        return res.status(403).json({ error: "STAFF_ACCESS_DISABLED" });
      }
      req.staffUser = Object.freeze({
        id: String(result.rows[0].id),
        displayName: result.rows[0].display_name,
        role: result.rows[0].role,
      });
      return next();
    } catch (error) {
      return next(error);
    }
  }

  function requireAdmin(req, res, next) {
    if (req.staffUser.role !== "admin") {
      return res.status(403).json({ error: "ADMIN_ACCESS_REQUIRED" });
    }
    return next();
  }

  return { loadActiveStaff, requireAdmin };
}

module.exports = { createStaffAuthorization };
