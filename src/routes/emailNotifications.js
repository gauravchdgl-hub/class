const express = require('express');
const db = require('../db');
const { requireStaff } = require('../middleware/auth');
const { deliverEmail, sendEmail } = require('../lib/mailer');
const { logAction } = require('../lib/audit');
const { textToHtml, esc } = require('../lib/emailTemplates');
const { localToUtcSql, parseSql, formatParts, SENSITIVE_TEMPLATES } = require('../lib/emailMeta');
const center = require('../services/emailCenter');

const router = express.Router();
router.use(requireStaff);

const PAGE_SIZE = 10;
const BASE = '/admin/email-notifications';
const FILTER_KEYS = ['search', 'type', 'status', 'date_from', 'date_to', 'tab', 'page', 'id'];

// Redirect back to the same filtered/paginated view the user was on.
function backUrl(req, { keepId = true } = {}) {
  const raw = String((req.body && req.body.back) || '');
  const p = new URLSearchParams(raw.replace(/^\?/, ''));
  const clean = new URLSearchParams();
  FILTER_KEYS.forEach((k) => { if (p.get(k)) clean.set(k, p.get(k)); });
  if (!keepId) clean.delete('id');
  const qs = clean.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---------- List + preview ----------
router.get('/', (req, res) => {
  const user = req.session.user;
  const filters = {};
  FILTER_KEYS.forEach((k) => { if (typeof req.query[k] === 'string' && req.query[k].trim()) filters[k] = req.query[k].trim(); });

  const page = parseInt(filters.page, 10) || 1;
  const { rows, tab, pagination } = center.list(user, filters, page, PAGE_SIZE);

  // Selected email: explicit ?id, otherwise the first row of the page.
  let selected = null;
  if (filters.id) {
    selected = center.find(user, filters.id);
    // Opening an email marks it read (unless it was just marked unread: ?u=1).
    if (selected && req.query.u !== '1') {
      center.markRead(selected.id);
      selected.read_at = selected.read_at || new Date().toISOString();
      selected.unread = false;
      const r = rows.find((x) => x.id === selected.id);
      if (r) r.unread = false;
    }
  }
  if (!selected && rows[0]) selected = rows[0];

  const platformName = (db.prepare("SELECT value FROM site_settings WHERE key = 'platform_name'").get() || {}).value || 'AUS Academy';
  const tagline = (db.prepare("SELECT value FROM site_settings WHERE key = 'brand_tagline'").get() || {}).value || 'Australia Year 11–12';

  res.render('admin/email_notifications', {
    filters: { ...filters, u: req.query.u === '1' ? '1' : undefined },
    activeTab: tab,
    types: center.visibleTypes(user),
    kpi: center.counts(user),
    rows: rows.map((r) => ({ ...r, when: formatParts(r.effective_at) })),
    selected: selected && { ...selected, when: formatParts(selected.effective_at), canModify: center.canModify(user, selected) },
    pagination,
    brand: { name: platformName, tagline },
    isAdmin: user.role === 'admin',
  });
});

// ---------- Resend (also: send a Draft / send a Scheduled email now) ----------
router.post('/resend', async (req, res) => {
  const user = req.session.user;
  const targets = center.ids(user, asArray(req.body.ids));
  if (!targets.length) { req.flash('error', 'Select an email first.'); return res.redirect(backUrl(req)); }

  let ok = 0; const problems = [];
  for (const row of targets) {
    if (row.sensitive) { problems.push(`"${row.subject || 'email'}" holds a one-time code or secure link and cannot be resent.`); continue; }
    const result = await deliverEmail(row.id, { force: true });
    if (result.ok) {
      ok += 1;
      logAction(req, 'email_resent', { recordType: 'email', recordId: row.id, newValue: { to: row.recipient_email, subject: row.subject } });
    } else {
      problems.push(`${row.recipient_email}: ${result.error}`);
    }
  }
  if (ok) req.flash('success', `${ok} email${ok > 1 ? 's' : ''} sent.`);
  if (problems.length) req.flash('error', problems[0] + (problems.length > 1 ? ` (+${problems.length - 1} more)` : ''));
  res.redirect(backUrl(req));
});

// ---------- Mark as Unread ----------
router.post('/mark-unread', (req, res) => {
  const targets = center.ids(req.session.user, asArray(req.body.ids));
  if (!targets.length) { req.flash('error', 'Select an email first.'); return res.redirect(backUrl(req)); }
  targets.forEach((t) => center.markUnread(t.id));
  req.flash('success', `${targets.length} email${targets.length > 1 ? 's' : ''} marked as unread.`);
  const url = backUrl(req);
  res.redirect(url.includes('id=') ? `${url}&u=1` : url); // u=1: don't re-mark it read when the page reloads
});

// ---------- Delete (soft delete; Admin can delete anything, Teacher only their own) ----------
router.post('/delete', (req, res) => {
  const user = req.session.user;
  const targets = center.ids(user, asArray(req.body.ids));
  if (!targets.length) { req.flash('error', 'Select an email first.'); return res.redirect(backUrl(req)); }
  const allowed = targets.filter((t) => center.canModify(user, t));
  allowed.forEach((t) => {
    center.softDelete(t.id);
    logAction(req, 'email_deleted', { recordType: 'email', recordId: t.id, oldValue: { to: t.recipient_email, subject: t.subject, status: t.raw_status } });
  });
  if (allowed.length) req.flash('success', `${allowed.length} email${allowed.length > 1 ? 's' : ''} deleted.`);
  if (allowed.length < targets.length) req.flash('error', 'You can only delete emails you sent or received. Ask an Admin to remove the others.');
  res.redirect(backUrl(req, { keepId: false }));
});

// ---------- Reply / Forward (send now, save as draft, or schedule) ----------
router.post('/compose', async (req, res) => {
  const user = req.session.user;
  const mode = req.body.mode === 'forward' ? 'forward' : 'reply';
  const original = center.find(user, req.body.source_id);
  if (!original) { req.flash('error', 'Email not found.'); return res.redirect(backUrl(req)); }
  if (original.sensitive) { req.flash('error', 'This email holds a one-time code or secure link and cannot be replied to or forwarded.'); return res.redirect(backUrl(req)); }

  const to = mode === 'reply' ? original.recipient_email : String(req.body.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { req.flash('error', 'Enter a valid recipient email address.'); return res.redirect(backUrl(req)); }

  const subject = String(req.body.subject || '').trim().slice(0, 200);
  const message = String(req.body.message || '').trim().slice(0, 10000);
  if (!subject || !message) { req.flash('error', 'Subject and message are required.'); return res.redirect(backUrl(req)); }

  // Forward quotes the original as plain text (never raw HTML).
  let html = textToHtml(message);
  if (mode === 'forward') {
    const quoted = String(original.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
    html += `<blockquote style="margin:12px 0 0;padding-left:12px;border-left:3px solid #e2e8f0;color:#64748b;font-size:11px;">
      <div style="margin-bottom:4px;">---------- Forwarded message ----------<br>From: ${esc(original.sender || '')}<br>To: ${esc(original.recipient_email)}<br>Subject: ${esc(original.subject || '')}</div>${esc(quoted)}</blockquote>`;
  }

  const action = ['draft', 'schedule'].includes(req.body.send_action) ? req.body.send_action : 'send';
  const meta = {
    to, subject, html, template: 'staff_message', type: original.type || 'System',
    relatedType: original.related_type, relatedId: original.related_id, createdBy: user.id, force: true,
  };

  if (action === 'draft') {
    meta.draft = true;
  } else if (action === 'schedule') {
    const at = localToUtcSql(String(req.body.scheduled_for || '').replace('T', ' '));
    if (!at || parseSql(at) <= new Date()) { req.flash('error', 'Pick a future date and time to schedule the email.'); return res.redirect(backUrl(req)); }
    meta.scheduledAt = at;
  }

  const result = await sendEmail(meta);
  logAction(req, `email_${mode}_${action}`, { recordType: 'email', recordId: result.id, newValue: { from_email_id: original.id, to, subject } });

  if (result.draft) req.flash('success', 'Saved to Drafts.');
  else if (result.scheduled) req.flash('success', `Scheduled for ${formatParts(meta.scheduledAt).full}.`);
  else if (result.sent) req.flash('success', `Email sent to ${to}.`);
  else req.flash('error', `Email was recorded but not delivered: ${result.error || 'SMTP is not configured (demo mode).'}`);

  const p = new URLSearchParams();
  p.set('tab', result.draft ? 'drafts' : result.scheduled ? 'scheduled' : '');
  if (!p.get('tab')) p.delete('tab');
  p.set('id', String(result.id));
  res.redirect(`${BASE}?${p.toString()}`);
});

module.exports = router;
