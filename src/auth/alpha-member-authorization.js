function createAlphaMemberAuthorization(options) {
  const db = options.db;
  const applicationConfiguration = options.applicationConfiguration;

  async function loadActiveAlphaMember(req, res, next) {
    try {
      const result = await db.query(
        `SELECT mapping.id AS mapping_id,
                mapping.member_id,
                mapping.auth_provider,
                mapping.auth_subject,
                member.first_name,
                member.last_name
         FROM goals_coach_member_auth_mappings mapping
         JOIN coach_members member ON member.id = mapping.member_id
         WHERE mapping.auth_provider = $1
           AND mapping.auth_subject = $2
           AND mapping.active = TRUE
         LIMIT 1`,
        [req.alphaMemberIdentity.authProvider, req.alphaMemberIdentity.authSubject]
      );
      if (!result.rows.length) {
        return res.status(403).json({ error: "ALPHA_ACCESS_FORBIDDEN" });
      }
      const row = result.rows[0];
      req.alphaMember = Object.freeze({
        mappingId: String(row.mapping_id),
        memberId: String(row.member_id),
        authProvider: row.auth_provider,
        authSubject: row.auth_subject,
        firstName: row.first_name,
        lastName: row.last_name,
      });
      return next();
    } catch (error) {
      return next(error);
    }
  }

  async function requireCurrentAlphaConsent(req, res, next) {
    if (!applicationConfiguration || !applicationConfiguration.valid) {
      return res.status(503).json({ error: "ALPHA_APPLICATION_NOT_CONFIGURED" });
    }
    try {
      const result = await db.query(
        `SELECT id
         FROM goals_coach_alpha_consents
         WHERE member_id = $1
           AND auth_mapping_id = $2
           AND consent_version = $3
           AND environment = $4
           AND status = 'accepted'
         LIMIT 1`,
        [
          req.alphaMember.memberId,
          req.alphaMember.mappingId,
          applicationConfiguration.consentVersion,
          applicationConfiguration.alphaEnvironment,
        ]
      );
      if (!result.rows.length) {
        return res.status(403).json({ error: "ALPHA_CONSENT_REQUIRED" });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  }

  return { loadActiveAlphaMember, requireCurrentAlphaConsent };
}

module.exports = { createAlphaMemberAuthorization };
