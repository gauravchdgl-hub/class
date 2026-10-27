const db = require('../db');
const { renderEmail } = require('./emailTemplates');

// Notification type -> the email it should also produce. Anything not listed here
// stays an in-app (bell) notification only. This is what makes existing portal
// actions create central email records automatically.
const EMAIL_RULES = {
  paper_assignment:       { template: 'paper_assignment',  heading: 'New Assignment Assigned', cta: 'View Assignment', itemLabel: 'Assignment' },
  mcq_assignment:         { template: 'mcq_assignment',    heading: 'New MCQs Assigned',        cta: 'Start Practising', itemLabel: 'MCQ Set' },
  content_assignment:     { template: 'content_assignment', heading: 'New Learning Content Assigned', cta: 'Open Content', itemLabel: 'Content' },
  submission_confirmed:   { template: 'submission_received', heading: 'Submission Received',   cta: 'View Submission', itemLabel: 'Assignment' },
  feedback_published:     { template: 'feedback_published', heading: 'Feedback Published',     cta: 'View Feedback', itemLabel: 'Assignment' },
  result_ready:           { template: 'result_published',  heading: 'Your Result Has Been Published', cta: 'View Result', itemLabel: 'Assignment', setting: 'notify_on_grade_published' },
  purchase:               { template: 'purchase',          heading: 'Payment Confirmed',        cta: 'Open Student Portal', itemLabel: 'Item' },
  tutorial_comment_reply: { template: 'comment_reply',     heading: 'Your Question Was Answered', cta: 'View Answer', itemLabel: 'Tutorial' },
  material_comment_reply: { template: 'comment_reply',     heading: 'Your Question Was Answered', cta: 'View Answer', itemLabel: 'Study Material' },
};

const fmtDue = (v) => {
  if (!v) return '';
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
};

function emailForNotification(userId, type, title, body, link, meta) {
  const rule = EMAIL_RULES[type];
  if (!rule || meta.email === false) return;
  if (rule.setting) {
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(rule.setting);
    if (row && row.value === '0') return; // switched off in Settings > Email
  }
  const user = db.prepare('SELECT id, name, email, role, notif_student FROM users WHERE id = ?').get(userId);
  if (!user || !user.email) return;
  if (user.role === 'student' && user.notif_student === 0) return; // student turned off email notifications

  const { sendEmail } = require('./mailer'); // lazy: mailer is the single email service
  const html = renderEmail({
    heading: title || rule.heading,
    name: user.name,
    intro: body || '',
    details: [
      { label: 'Subject', value: meta.subjectName },
      { label: meta.itemLabel || rule.itemLabel, value: meta.itemTitle },
      { label: 'Due Date', value: fmtDue(meta.dueDate) },
      { label: 'Score', value: meta.score },
    ],
    instructions: meta.instructions,
    cta: link ? { label: meta.cta || rule.cta, link } : null,
  });
  sendEmail({
    to: user.email, userId: user.id, subject: title || rule.heading, html, template: rule.template,
    relatedType: meta.relatedType, relatedId: meta.relatedId, createdBy: meta.createdBy,
  }).catch((err) => console.error('[notify] email failed:', err.message));
}

/**
 * notify(userId, type, title, body, link, meta?)
 * Creates the persisted in-app notification (bell icon) AND, for the types in
 * EMAIL_RULES, a matching email through lib/mailer (one central record).
 *
 * meta (optional): { email:false to skip the email, relatedType, relatedId, createdBy,
 *   subjectName, itemTitle, itemLabel, dueDate, instructions, score, cta }
 * Call sites that already call sendEmail() themselves pass { email:false } so
 * nobody is emailed twice.
 */
function notify(userId, type, title, body, link, meta = {}) {
  try {
    db.prepare(
      'INSERT INTO notifications (user_id, type, title, body, link) VALUES (?,?,?,?,?)'
    ).run(userId, type, title, body || null, link || null);
  } catch (err) {
    console.error('[notify] failed to create notification:', err.message);
  }
  try {
    emailForNotification(userId, type, title, body, link, meta || {});
  } catch (err) {
    console.error('[notify] failed to queue email:', err.message);
  }
}

module.exports = { notify, EMAIL_RULES };
