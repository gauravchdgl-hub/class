const db = require('../db');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    // Gmail SMTP. For other providers, set SMTP_HOST/SMTP_PORT instead of "service".
    service: process.env.SMTP_HOST ? undefined : 'gmail',
    host: process.env.SMTP_HOST || undefined,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS, // Gmail: use a 16-character App Password, not your normal password
    },
  });
  return transporter;
}

const { typeForTemplate, SENSITIVE_TEMPLATES, nowSql, parseSql } = require('./emailMeta');

const REDACTED_BODY = '<p style="font-size:12px;color:#64748b;">This message contains a one-time code, a secure link or a temporary password, so its content is not stored.</p>';

function fromAddress() {
  if (process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER) return process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  const row = db.prepare("SELECT value FROM site_settings WHERE key = 'from_email'").get();
  return (row && row.value) || 'noreply@ausacademy.com';
}

function userIdForEmail(email) {
  const u = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
  return u ? u.id : null;
}

/**
 * transmit() — the ONE place a message actually leaves the app (SMTP via nodemailer).
 * Returns { status, error, plain } where status is the raw record status:
 * sent | failed | skipped_no_smtp | skipped_disabled. `force` bypasses the
 * Settings "template enabled" switch (used for a manual Resend by staff).
 */
async function transmit({ to, subject, html, template, force }) {
  const t = getTransporter();
  const plain = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  if (!force) {
    const enabledRow = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(`email_template_enabled_${template}`);
    if (enabledRow && enabledRow.value === '0') {
      return { status: 'skipped_disabled', error: 'This email template is disabled in Settings.', plain };
    }
  }
  if (!t) {
    // Demo mode (no SMTP configured): print the email so verification links / OTP codes
    // can still be read during development, and keep a preview for Admin > Email Logs.
    console.log(`\n[email:${template}] (SMTP not configured — demo mode)\nTo: ${to}\nSubject: ${subject}\nBody: ${plain}\n`);
    return { status: 'skipped_no_smtp', error: 'SMTP is not configured (demo mode) — the email was not delivered.', plain };
  }
  try {
    await t.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'AUS Academy'}" <${fromAddress()}>`,
      to, subject, html,
    });
    return { status: 'sent', error: null, plain };
  } catch (err) {
    console.error(`[email:${template}] FAILED to send to ${to}:`, err.message);
    return { status: 'failed', error: err.message, plain };
  }
}

/**
 * sendEmail({ to, subject, html, template, ...meta })
 * The single entry point for every email the portal sends. Each call writes ONE row
 * to email_logs (the central email/notification record) — sent / failed / skipped,
 * or 'scheduled' / 'draft' when scheduledAt / draft is passed.
 *
 * Optional meta (all backwards compatible — old call sites keep working):
 *   type          Assignment | Submission | Feedback | Reminder | Result | Payment | Account | System
 *                 (defaults from the template key)
 *   userId        recipient user id (looked up from the address when omitted)
 *   relatedType / relatedId   what the email is about, e.g. 'exam_assignment', 42
 *   createdBy     staff user id who triggered/composed it (drives Teacher visibility)
 *   scheduledAt   UTC 'YYYY-MM-DD HH:MM:SS' — store as Scheduled; the scheduler sends it
 *   draft         true — store as Draft, never send
 *   force         bypass the Settings "template enabled" switch
 * Returns { id, sent|skipped|scheduled|draft, error? }.
 */
async function sendEmail({ to, subject, html, template, type, userId, relatedType, relatedId, createdBy, scheduledAt, draft, force }) {
  const tpl = template || 'staff_message';
  const rec = {
    to, subject: subject || null, tpl,
    type: type || typeForTemplate(tpl),
    userId: userId || userIdForEmail(to),
    relatedType: relatedType || null, relatedId: relatedId || null, createdBy: createdBy || null,
    body: SENSITIVE_TEMPLATES.includes(tpl) ? REDACTED_BODY : html,
  };

  const insert = (status, error, extra = {}) => {
    const now = nowSql();
    const id = db.prepare(
      `INSERT INTO email_logs (recipient, template, status, error, subject, body_preview, recipient_user_id, sender, body, type,
         related_type, related_id, scheduled_at, sent_at, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      rec.to, rec.tpl, status, error, rec.subject, extra.preview || null, rec.userId, fromAddress(), rec.body, rec.type,
      rec.relatedType, rec.relatedId, extra.scheduledAt || null, extra.sentAt === undefined ? now : extra.sentAt,
      rec.createdBy, now, now
    ).lastInsertRowid;
    return Number(id);
  };

  if (draft) return { id: insert('draft', null, { sentAt: null }), draft: true };
  if (scheduledAt && parseSql(scheduledAt) > new Date()) {
    return { id: insert('scheduled', null, { sentAt: null, scheduledAt }), scheduled: true };
  }

  const r = await transmit({ to, subject, html, template: tpl, force });
  const id = insert(r.status, r.status === 'sent' ? null : r.error, {
    preview: r.status === 'skipped_no_smtp' ? r.plain.slice(0, 1000) : null,
  });
  return r.status === 'sent' ? { id, sent: true } : r.status === 'failed' ? { id, sent: false, error: r.error } : { id, skipped: true };
}

/**
 * deliverEmail(id) — (re)send an EXISTING record through the same transport: Resend,
 * sending a Draft, or sending a Scheduled email now. Updates the row in place.
 */
async function deliverEmail(id, { force = true } = {}) {
  const row = db.prepare('SELECT * FROM email_logs WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return { ok: false, error: 'Email not found.' };
  if (SENSITIVE_TEMPLATES.includes(row.template)) {
    return { ok: false, error: 'This email contains a one-time code, link or password, so it cannot be resent.' };
  }
  if (!row.body) return { ok: false, error: 'This email has no stored body to send.' };

  const r = await transmit({ to: row.recipient, subject: row.subject, html: row.body, template: row.template, force });
  const now = nowSql();
  db.prepare(
    `UPDATE email_logs SET status = ?, error = ?, sent_at = ?,
       body_preview = CASE WHEN ? = 'skipped_no_smtp' THEN ? ELSE body_preview END, updated_at = ? WHERE id = ?`
  ).run(r.status, r.status === 'sent' ? null : r.error, now, r.status, r.plain.slice(0, 1000), now, id);
  return { ok: r.status === 'sent', status: r.status, error: r.status === 'sent' ? null : r.error };
}

/** dispatchDueEmails() — sends every Scheduled email whose time has come. Called by the scheduler. */
async function dispatchDueEmails() {
  // A crash mid-send would leave a row in 'sending' forever; surface it as Failed instead.
  db.prepare(
    "UPDATE email_logs SET status = 'failed', error = 'Sending was interrupted — use Resend to try again.', sent_at = ?, updated_at = ? WHERE status = 'sending' AND updated_at < ?"
  ).run(nowSql(), nowSql(), new Date(Date.now() - 10 * 60000).toISOString().slice(0, 19).replace('T', ' '));
  const due = db.prepare(
    "SELECT id FROM email_logs WHERE status = 'scheduled' AND deleted_at IS NULL AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 50"
  ).all(nowSql());
  for (const row of due) {
    // Claim the row first so an overlapping tick can't send it twice.
    const claimed = db.prepare("UPDATE email_logs SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'scheduled'").run(nowSql(), row.id);
    if (!claimed.changes) continue;
    const r = await deliverEmail(row.id, { force: false });
    if (r.status === undefined) {
      db.prepare("UPDATE email_logs SET status = 'failed', error = ?, sent_at = ?, updated_at = ? WHERE id = ?").run(r.error, nowSql(), nowSql(), row.id);
    }
  }
  return due.length;
}

function baseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function sendVerificationEmail(req, user, token) {
  const link = `${baseUrl(req)}/verify-email?token=${token}`;
  return sendEmail({
    to: user.email,
    userId: user.id,
    subject: 'Verify your AUS Academy account',
    template: 'verification',
    html: `
      <p>Hi ${user.name},</p>
      <p>Thanks for signing up to AUS Academy. Please verify your email address to activate your account:</p>
      <p><a href="${link}" style="background:#2657ff;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block">Verify my email</a></p>
      <p>Or copy this link into your browser:<br>${link}</p>
      <p>This link expires in 24 hours. If you didn't create this account, you can ignore this email.</p>
    `,
  });
}

function sendPasswordResetEmail(req, user, token) {
  const link = `${baseUrl(req)}/reset-password?token=${token}`;
  return sendEmail({
    to: user.email,
    userId: user.id,
    subject: 'Reset your AUS Academy password',
    template: 'password_reset',
    html: `
      <p>Hi ${user.name},</p>
      <p>We received a request to reset your password. Click below to choose a new one:</p>
      <p><a href="${link}" style="background:#2657ff;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block">Reset my password</a></p>
      <p>Or copy this link into your browser:<br>${link}</p>
      <p>This link expires in 1 hour. If you didn't request this, you can ignore this email — your password will stay the same.</p>
    `,
  });
}

module.exports = { sendEmail, deliverEmail, dispatchDueEmails, sendVerificationEmail, sendPasswordResetEmail };
