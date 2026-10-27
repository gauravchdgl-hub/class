const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sendEmail } = require('./mailer');
const { sendSMS } = require('./sms');

const OTP_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 45;

function hashCode(code) {
  // A short numeric code doesn't need bcrypt's expensive cost factor — a
  // fast, salted hash is enough since it's also rate-limited and expires.
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * issueLoginOtp(user) — generates a fresh 6-digit code, invalidates any
 * still-usable earlier one for this user, and emails it (and texts it too,
 * if a phone number is on file — via the pluggable SMS layer). Returns
 * { ok: true } or { ok: false, waitSeconds } if a resend was requested too
 * soon (cooldown).
 */
async function issueLoginOtp(req, user) {
  const latest = db.prepare(
    "SELECT * FROM login_otps WHERE user_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1"
  ).get(user.id);

  if (latest) {
    const secondsSince = (Date.now() - new Date(latest.created_at).getTime()) / 1000;
    if (secondsSince < RESEND_COOLDOWN_SECONDS) {
      return { ok: false, waitSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSince) };
    }
  }

  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60000).toISOString();

  // Invalidate any earlier unused code for this user first — only the
  // newest code is ever valid.
  db.prepare('UPDATE login_otps SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(user.id);

  db.prepare(
    'INSERT INTO login_otps (user_id, channel, destination, code_hash, expires_at) VALUES (?,?,?,?,?)'
  ).run(user.id, 'email', user.email, hashCode(code), expiresAt);

  await sendEmail({
    to: user.email,
    subject: 'Your AUS Academy login code',
    template: 'login_otp',
    userId: user.id,
    html: `<p>Hi ${user.name},</p><p>Your login verification code is:</p>
           <p style="font-size:28px;font-weight:900;letter-spacing:4px;">${code}</p>
           <p>This code expires in ${OTP_TTL_MINUTES} minutes. If you didn't try to log in, you can ignore this.</p>`,
  });

  if (user.phone) {
    const smsEnabledRow = db.prepare("SELECT value FROM site_settings WHERE key = 'sms_otp_enabled'").get();
    const smsEnabled = smsEnabledRow && smsEnabledRow.value === '1';
    if (smsEnabled) {
      db.prepare(
        'INSERT INTO login_otps (user_id, channel, destination, code_hash, expires_at) VALUES (?,?,?,?,?)'
      ).run(user.id, 'sms', user.phone, hashCode(code), expiresAt);
      await sendSMS({ to: user.phone, message: `Your AUS Academy login code is ${code}. Valid for ${OTP_TTL_MINUTES} minutes.`, template: 'login_otp' });
    }
  }

  return { ok: true, smsSent: !!(user.phone && db.prepare("SELECT value FROM site_settings WHERE key = 'sms_otp_enabled'").get()?.value === '1') };
}

/**
 * verifyLoginOtp(userId, code) — checks the code against the newest
 * unused, unexpired OTP row(s) for this user (email and/or sms share the
 * same code, issued together). Enforces max attempts as a brute-force
 * lockout. Returns { ok, error }.
 */
function verifyLoginOtp(userId, code) {
  const rows = db.prepare(
    "SELECT * FROM login_otps WHERE user_id = ? AND used_at IS NULL ORDER BY id DESC"
  ).all(userId);
  if (!rows.length) return { ok: false, error: 'No active code — please request a new one.' };

  const latestBatch = rows.filter((r) => r.created_at === rows[0].created_at);
  const anyOverAttempts = latestBatch.some((r) => r.attempts >= r.max_attempts);
  if (anyOverAttempts) return { ok: false, error: 'Too many incorrect attempts. Please request a new code.' };

  const expired = new Date(latestBatch[0].expires_at) < new Date();
  if (expired) return { ok: false, error: 'This code has expired. Please request a new one.' };

  const codeHash = hashCode(code);
  const match = latestBatch.find((r) => r.code_hash === codeHash);

  if (!match) {
    db.prepare('UPDATE login_otps SET attempts = attempts + 1 WHERE id IN (' + latestBatch.map(() => '?').join(',') + ')')
      .run(...latestBatch.map((r) => r.id));
    return { ok: false, error: 'Incorrect code. Please try again.' };
  }

  db.prepare('UPDATE login_otps SET used_at = CURRENT_TIMESTAMP WHERE id IN (' + latestBatch.map(() => '?').join(',') + ')')
    .run(...latestBatch.map((r) => r.id));
  return { ok: true };
}

module.exports = { issueLoginOtp, verifyLoginOtp, OTP_TTL_MINUTES, RESEND_COOLDOWN_SECONDS };
