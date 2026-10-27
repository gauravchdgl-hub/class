const db = require('../db');

// Template key -> UI "Type" category. Unknown templates fall back to 'System'.
const TYPE_BY_TEMPLATE = {
  student_welcome: 'Account', verification: 'Account', password_reset: 'Account',
  password_reset_by_staff: 'Account', password_changed: 'Account', login_otp: 'Account',
  parent_notification: 'Account',
  purchase_account_created: 'Payment', purchase_paper_assigned: 'Payment', purchase: 'Payment',
  mcq_assignment: 'Assignment', paper_assignment: 'Assignment', content_assignment: 'Assignment',
  submission_received: 'Submission', feedback_published: 'Feedback', comment_reply: 'Feedback',
  exam_reminder: 'Reminder', result_published: 'Result',
};

// Types a Teacher may see. Admin sees everything.
const TYPES = ['Assignment', 'Submission', 'Feedback', 'Reminder', 'Result', 'Payment', 'Account', 'System'];
const TEACHER_HIDDEN_TYPES = ['Payment', 'System'];

// These carry one-time codes, verification/reset links or temporary passwords.
// Their body is never stored in the central record and only Admin can see the row.
const SENSITIVE_TEMPLATES = ['login_otp', 'verification', 'password_reset', 'password_reset_by_staff', 'purchase_account_created'];

const typeForTemplate = (t) => TYPE_BY_TEMPLATE[t] || 'System';

// ---------- time helpers ----------
// Every timestamp this feature writes is UTC in SQLite's 'YYYY-MM-DD HH:MM:SS' format,
// so string comparison == chronological comparison.
const toSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const nowSql = () => toSql(new Date());
const parseSql = (s) => {
  if (!s) return null;
  const str = String(s);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : `${str.replace(' ', 'T')}Z`);
};

function academyTz() {
  const row = db.prepare("SELECT value FROM site_settings WHERE key = 'timezone'").get();
  return (row && row.value) || 'Australia/Sydney';
}

function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// 'YYYY-MM-DD HH:MM[:SS]' (or with 'T') entered in the academy's local time -> UTC sql string.
function localToUtcSql(local, tz = academyTz()) {
  if (!local) return null;
  const m = String(local).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  let ts = naive - tzOffsetMs(naive, tz);
  ts = naive - tzOffsetMs(ts, tz); // second pass handles DST boundaries
  return toSql(new Date(ts));
}

function formatParts(sqlUtc, tz = academyTz()) {
  const d = parseSql(sqlUtc);
  if (!d || Number.isNaN(d.getTime())) return { date: '—', time: '', full: '—' };
  const date = new Intl.DateTimeFormat('en-AU', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(d).toUpperCase();
  return { date, time, full: `${date}, ${time}` };
}

module.exports = {
  TYPES, TEACHER_HIDDEN_TYPES, SENSITIVE_TEMPLATES, TYPE_BY_TEMPLATE, typeForTemplate,
  toSql, nowSql, parseSql, academyTz, localToUtcSql, formatParts,
};
