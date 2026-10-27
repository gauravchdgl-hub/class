const db = require('../db');
const { sendEmail, dispatchDueEmails } = require('./mailer');
const { renderEmail } = require('./emailTemplates');
const { nowSql, toSql, parseSql, localToUtcSql } = require('./emailMeta');

const REMINDER_LEAD_HOURS = 24;

/**
 * Exam reminders: every assigned/in-progress exam with a due date gets ONE Reminder
 * email, scheduled REMINDER_LEAD_HOURS before it is due (so it shows up under the
 * "Scheduled" tab until it goes out). Deleting a scheduled reminder cancels it —
 * the NOT EXISTS check also counts soft-deleted rows, so it is never recreated.
 */
function ensureExamReminders() {
  const rows = db.prepare(
    `SELECT a.id, a.user_id, a.due_at, p.title, s.name AS subject_name, u.name, u.email, u.notif_student
     FROM exam_assignments a
     JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN subjects s ON s.id = p.subject_id
     JOIN users u ON u.id = a.user_id
     WHERE a.due_at IS NOT NULL AND a.status IN ('assigned','in_progress')
       AND NOT EXISTS (SELECT 1 FROM email_logs e WHERE e.related_type = 'exam_assignment' AND e.related_id = a.id AND e.type = 'Reminder')`
  ).all();

  const now = new Date();
  rows.forEach((a) => {
    if (!a.email || a.notif_student === 0) return;
    const dueUtc = localToUtcSql(a.due_at);
    if (!dueUtc) return;
    const due = parseSql(dueUtc);
    if (due <= now) return; // already past due — a reminder would be pointless
    const sendAt = new Date(due.getTime() - REMINDER_LEAD_HOURS * 3600000);
    const html = renderEmail({
      heading: 'Exam Reminder',
      name: a.name,
      intro: 'This is a reminder that you have an assignment due soon.',
      details: [
        { label: 'Subject', value: a.subject_name },
        { label: 'Assignment', value: a.title },
        { label: 'Due Date', value: new Date(a.due_at.replace(' ', 'T')).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) },
      ],
      cta: { label: 'Open Assignment', link: `/student/exams/${a.id}` },
    });
    sendEmail({
      to: a.email, userId: a.user_id, subject: `Exam Reminder: ${a.title}`, html, template: 'exam_reminder',
      relatedType: 'exam_assignment', relatedId: a.id,
      scheduledAt: sendAt > now ? toSql(sendAt) : undefined, // due within the lead window -> send right away
    }).catch((err) => console.error('[reminders] failed:', err.message));
  });
}

// A scheduled reminder is dropped if the student already submitted.
function cancelStaleReminders() {
  db.prepare(
    `UPDATE email_logs SET deleted_at = ?, updated_at = ?
     WHERE status = 'scheduled' AND deleted_at IS NULL AND type = 'Reminder' AND related_type = 'exam_assignment'
       AND related_id IN (SELECT id FROM exam_assignments WHERE status NOT IN ('assigned','in_progress'))`
  ).run(nowSql(), nowSql());
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    ensureExamReminders();
    cancelStaleReminders();
    await dispatchDueEmails();
  } catch (err) {
    console.error('[email scheduler]', err.message);
  } finally {
    running = false;
  }
}

function startEmailScheduler() {
  setTimeout(tick, 5000).unref();
  setInterval(tick, 60 * 1000).unref();
}

module.exports = { startEmailScheduler, tick, ensureExamReminders };
