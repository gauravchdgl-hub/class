const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { sendVerificationEmail, sendPasswordResetEmail, sendEmail } = require('../lib/mailer');
const { renderEmail } = require('../lib/emailTemplates');
const { logAction } = require('../lib/audit');
const { issueLoginOtp, verifyLoginOtp, OTP_TTL_MINUTES } = require('../lib/otp');

const router = express.Router();

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function issueToken(userId, purpose, hoursValid) {
  const token = makeToken();
  const expiresAt = new Date(Date.now() + hoursValid * 3600000).toISOString();
  // A fresh token invalidates any earlier unused one of the same purpose,
  // so an old email link can't be used after a newer one was requested.
  db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND purpose = ? AND used_at IS NULL')
    .run(userId, purpose);
  db.prepare('INSERT INTO email_verifications (user_id, token, purpose, expires_at) VALUES (?,?,?,?)')
    .run(userId, token, purpose, expiresAt);
  return token;
}

router.get('/login', (req, res) => res.render('public/login'));

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(String(email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    req.flash('error', 'Invalid email or password');
    return res.redirect('/login');
  }
  if (user.role === 'admin' || user.role === 'teacher') {
    req.flash('error', 'Please use the Staff Login page for Teacher/Admin accounts');
    return res.redirect('/staff-login');
  }
  if (!user.email_verified) {
    req.flash('error', 'Please verify your email before logging in. Check your inbox, or resend the verification email below.');
    return res.redirect(`/verify-pending?email=${encodeURIComponent(user.email)}`);
  }

  // Password is correct — but the session is NOT created yet. A one-time
  // code (email, and SMS too if a phone is on file) must be verified first.
  const otpResult = await issueLoginOtp(req, user);
  req.session.pendingLoginUserId = user.id;
  if (!otpResult.ok) {
    // A code was already sent recently — just send them to enter it.
    return res.redirect('/verify-login-otp');
  }
  res.redirect('/verify-login-otp');
});

router.get('/verify-login-otp', (req, res) => {
  if (!req.session.pendingLoginUserId) return res.redirect('/login');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.pendingLoginUserId);
  if (!user) return res.redirect('/login');
  const smsEnabledRow = db.prepare("SELECT value FROM site_settings WHERE key = 'sms_otp_enabled'").get();
  const smsSent = !!user.phone && smsEnabledRow && smsEnabledRow.value === '1';
  res.render('public/verify_otp', { maskedEmail: user.email.replace(/(.{2}).+(@.+)/, '$1***$2'), hasPhone: smsSent, ttl: OTP_TTL_MINUTES });
});

router.post('/verify-login-otp', (req, res) => {
  const userId = req.session.pendingLoginUserId;
  if (!userId) return res.redirect('/login');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.redirect('/login');

  const result = verifyLoginOtp(userId, String((req.body && req.body.code) || '').trim());
  if (!result.ok) {
    req.flash('error', result.error);
    return res.redirect('/verify-login-otp');
  }

  delete req.session.pendingLoginUserId;
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, email_verified: 1 };
  logAction(req, 'student_login', { recordType: 'user', recordId: user.id });

  if (user.role === 'admin' || user.role === 'teacher') return res.redirect('/admin/dashboard');
  res.redirect('/student/dashboard');
});

router.post('/verify-login-otp/resend', async (req, res) => {
  const userId = req.session.pendingLoginUserId;
  if (!userId) return res.redirect('/login');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.redirect('/login');

  const result = await issueLoginOtp(req, user);
  if (!result.ok) {
    req.flash('error', `Please wait ${result.waitSeconds}s before requesting another code.`);
  } else {
    req.flash('success', 'A new code has been sent.');
  }
  res.redirect('/verify-login-otp');
});

function findByIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) return null;
  if (raw.includes('@')) {
    return db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(raw.toLowerCase());
  }
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  return db.prepare("SELECT * FROM users WHERE phone IS NOT NULL AND substr(phone, -9) = substr(?, -9)").get(digits);
}

// Passwordless login: identifier (email or phone) -> OTP only, no password needed.
router.post('/login/otp/request', async (req, res) => {
  const user = findByIdentifier(req.body.identifier);
  if (!user || (user.role !== 'student')) {
    req.flash('error', 'No student account found with that email or phone.');
    return res.redirect('/login');
  }
  if (!user.email_verified) {
    req.flash('error', 'Please verify your email before logging in.');
    return res.redirect(`/verify-pending?email=${encodeURIComponent(user.email)}`);
  }
  const otpResult = await issueLoginOtp(req, user);
  req.session.pendingLoginUserId = user.id;
  if (!otpResult.ok) {
    req.flash('error', `A code was already sent recently — please wait ${otpResult.waitSeconds}s or check your inbox.`);
  }
  res.redirect('/verify-login-otp');
});

router.post('/staff-login/otp/request', async (req, res) => {
  const user = findByIdentifier(req.body.identifier);
  if (!user || (user.role !== 'admin' && user.role !== 'teacher')) {
    req.flash('error', 'No staff account found with that email or phone.');
    return res.redirect('/staff-login');
  }
  const otpResult = await issueLoginOtp(req, user);
  req.session.pendingLoginUserId = user.id;
  if (!otpResult.ok) {
    req.flash('error', `A code was already sent recently — please wait ${otpResult.waitSeconds}s or check your inbox.`);
  }
  res.redirect('/verify-login-otp');
});

router.get('/staff-login', (req, res) => res.render('public/staff_login'));

router.post('/staff-login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(String(email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    req.flash('error', 'Invalid email or password');
    return res.redirect('/staff-login');
  }
  if (user.role !== 'admin' && user.role !== 'teacher') {
    req.flash('error', 'Please use the Student Login page for student accounts');
    return res.redirect('/login');
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  logAction(req, 'staff_login', { recordType: 'user', recordId: user.id });
  res.redirect('/admin/dashboard');
});

router.get('/register', (req, res) => res.render('public/register'));

router.post('/register', (req, res) => {
  const { name, email, password, phone } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPhone = String(phone || '').replace(/\D/g, ''); // digits only, so "+61 400 111 222" and "0400111222" etc. are compared fairly

  if (!cleanPhone) {
    req.flash('error', 'Phone number is required');
    return res.redirect('/register');
  }

  const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail);
  if (existingEmail) {
    req.flash('error', 'An account with this email already exists, please login');
    return res.redirect('/login');
  }

  const existingPhone = db.prepare(
    "SELECT id FROM users WHERE phone IS NOT NULL AND substr(phone, -9) = substr(?, -9)"
  ).get(cleanPhone);
  if (existingPhone) {
    req.flash('error', 'An account with this phone number already exists, please login');
    return res.redirect('/login');
  }

  const hash = bcrypt.hashSync(password, 8);
  const id = db.prepare('INSERT INTO users (name, email, password, role, phone, email_verified) VALUES (?,?,?,?,?,0)')
    .run(name, cleanEmail, hash, 'student', cleanPhone).lastInsertRowid;

  const freePlan = db.prepare("SELECT * FROM mcq_plans WHERE name = 'Free Plan'").get();
  if (freePlan) {
    const expiresAt = new Date(Date.now() + freePlan.validity_days * 86400000).toISOString();
    db.prepare(
      `INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at)
       VALUES (?,?,NULL,NULL,?,?)`
    ).run(id, freePlan.id, freePlan.mcq_count, expiresAt);
  }

  // NOTE: the free 50 MCQs above are credited immediately so the student can
  // see their portal, but the actual MCQ purchase/practice/exam routes are all
  // gated by requireVerified — an unverified student cannot buy a plan,
  // practice, or start an assigned exam until they click the email link.
  const token = issueToken(id, 'verify', 24);
  sendVerificationEmail(req, { id, name, email: cleanEmail }, token);

  req.flash('success', `Account created! We've sent a verification link to ${cleanEmail} — please verify before purchasing or starting exams.`);
  res.redirect(`/verify-pending?email=${encodeURIComponent(cleanEmail)}`);
});

// ---------- Email verification ----------

router.get('/verify-pending', (req, res) => {
  res.render('public/verify_pending', { email: req.query.email || '' });
});

router.get('/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) {
    req.flash('error', 'Missing verification token');
    return res.redirect('/login');
  }
  const row = db.prepare("SELECT * FROM email_verifications WHERE token = ? AND purpose = 'verify'").get(token);
  if (!row) {
    req.flash('error', 'This verification link is invalid. Please request a new one.');
    return res.redirect('/verify-pending');
  }
  if (row.used_at) {
    req.flash('error', 'This verification link has already been used. Please login.');
    return res.redirect('/login');
  }
  if (new Date(row.expires_at) < new Date()) {
    req.flash('error', 'This verification link has expired. Please request a new one.');
    return res.redirect(`/verify-pending`);
  }

  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
  db.prepare('UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, email_verified: 1 };
  req.flash('success', 'Email verified! Your account is now fully active.');
  res.redirect('/student/dashboard');
});

router.post('/resend-verification', (req, res) => {
  const cleanEmail = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(cleanEmail);
  // Same response whether the account exists or not, so this can't be used to
  // check which emails are registered.
  if (user && !user.email_verified) {
    const token = issueToken(user.id, 'verify', 24);
    sendVerificationEmail(req, user, token);
  }
  req.flash('success', `If ${cleanEmail} needs verifying, a new link has been sent.`);
  res.redirect(`/verify-pending?email=${encodeURIComponent(cleanEmail)}`);
});

// ---------- Forgot / reset password ----------

router.get('/forgot-password', (req, res) => res.render('public/forgot_password'));

router.post('/forgot-password', (req, res) => {
  const cleanEmail = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(cleanEmail);
  if (user) {
    const token = issueToken(user.id, 'reset_password', 1);
    sendPasswordResetEmail(req, user, token);
  }
  req.flash('success', `If ${cleanEmail} is registered, a password reset link has been sent.`);
  res.redirect('/forgot-password');
});

router.get('/reset-password', (req, res) => {
  const { token } = req.query;
  const row = token
    ? db.prepare("SELECT * FROM email_verifications WHERE token = ? AND purpose = 'reset_password'").get(token)
    : null;
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    req.flash('error', 'This password reset link is invalid or has expired. Please request a new one.');
    return res.redirect('/forgot-password');
  }
  res.render('public/reset_password', { token });
});

router.post('/reset-password', (req, res) => {
  const { token, password } = req.body;
  const row = db.prepare("SELECT * FROM email_verifications WHERE token = ? AND purpose = 'reset_password'").get(token);
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    req.flash('error', 'This password reset link is invalid or has expired. Please request a new one.');
    return res.redirect('/forgot-password');
  }
  const hash = bcrypt.hashSync(password, 8);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  const resetUser = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(row.user_id);
  if (resetUser) {
    sendEmail({
      to: resetUser.email, userId: resetUser.id, subject: 'Your AUS Academy password was changed', template: 'password_changed',
      relatedType: 'user', relatedId: resetUser.id,
      html: renderEmail({ heading: 'Password Changed', name: resetUser.name, intro: 'Your password was just reset. If this was not you, please contact your teacher straight away.', cta: { label: 'Go to Login', link: '/login' }, note: 'For your security we never include your password in emails.' }),
    }).catch(() => {});
  }
  req.flash('success', 'Password updated! Please login with your new password.');
  res.redirect('/login');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
