const db = require('../db');

/**
 * logAction(req, action, { recordType, recordId, oldValue, newValue })
 *
 * Call this after any sensitive action completes successfully. `req` is used
 * to snapshot who did it (id/name/email/role) so the log stays meaningful
 * even if that account is later renamed or deleted. old/new values are
 * JSON-stringified automatically if given as objects.
 */
function logAction(req, action, { recordType = null, recordId = null, oldValue = null, newValue = null } = {}) {
  const user = req.session && req.session.user;
  const userLabel = user ? `${user.name} <${user.email}> (${user.role})` : 'system';
  const stringify = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));

  try {
    db.prepare(
      `INSERT INTO audit_logs (user_id, user_label, action, record_type, record_id, old_value, new_value)
       VALUES (?,?,?,?,?,?,?)`
    ).run(user ? user.id : null, userLabel, action, recordType, recordId, stringify(oldValue), stringify(newValue));
  } catch (err) {
    // Audit logging must never break the actual request/action.
    console.error('[audit_log] failed to record action:', action, err.message);
  }
}

module.exports = { logAction };
