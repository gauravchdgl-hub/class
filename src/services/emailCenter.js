const db = require('../db');
const {
  TYPES, TEACHER_HIDDEN_TYPES, SENSITIVE_TEMPLATES, nowSql, localToUtcSql, academyTz,
} = require('../lib/emailMeta');

// ---------- status buckets (raw email_logs.status -> UI status) ----------
// sent                         -> Sent
// scheduled                    -> Scheduled
// draft                        -> Draft
// failed | skipped_* | sending -> Failed   (not delivered; the reason is shown in the preview)
const TAB_SQL = {
  sent: "e.status = 'sent'",
  scheduled: "e.status = 'scheduled'",
  failed: "e.status IN ('failed','skipped_no_smtp','skipped_disabled','sending')",
  drafts: "e.status = 'draft'",
};
const STATUS_FILTER_SQL = { Sent: TAB_SQL.sent, Scheduled: TAB_SQL.scheduled, Failed: TAB_SQL.failed, Draft: TAB_SQL.drafts };

function uiStatus(raw) {
  if (raw === 'sent') return 'Sent';
  if (raw === 'scheduled') return 'Scheduled';
  if (raw === 'draft') return 'Draft';
  return 'Failed';
}

// ---------- permissions ----------
// Admin: every record. Teacher: only student-facing emails — never Payment/System types,
// never anything holding a one-time code / secure link / temporary password, and Drafts
// only if they wrote them. Anything addressed to the teacher or composed by them is theirs.
function scope(user) {
  if (user.role === 'admin') return { sql: 'e.deleted_at IS NULL', params: [] };
  const hiddenTypes = TEACHER_HIDDEN_TYPES.map(() => '?').join(',');
  const sensitive = SENSITIVE_TEMPLATES.map(() => '?').join(',');
  return {
    sql: `e.deleted_at IS NULL AND (
            e.created_by = ? OR e.recipient_user_id = ?
            OR (COALESCE(e.type,'System') NOT IN (${hiddenTypes}) AND e.template NOT IN (${sensitive}) AND e.status != 'draft')
          )`,
    params: [user.id, user.id, ...TEACHER_HIDDEN_TYPES, ...SENSITIVE_TEMPLATES],
  };
}

// A teacher may modify (delete) only what they created or received; Admin can modify anything.
function canModify(user, row) {
  return user.role === 'admin' || row.created_by === user.id || row.recipient_user_id === user.id;
}

const visibleTypes = (user) => (user.role === 'admin' ? TYPES : TYPES.filter((t) => !TEACHER_HIDDEN_TYPES.includes(t)));

// ---------- queries ----------
const SELECT = `e.id, e.recipient AS recipient_email, e.recipient_user_id, e.sender, e.subject, e.body, e.type, e.template,
  e.status AS raw_status, e.related_type, e.related_id, e.scheduled_at, e.sent_at, e.read_at,
  e.error AS error_message, e.created_by, e.created_at, e.updated_at,
  COALESCE(e.sent_at, e.scheduled_at, e.created_at) AS effective_at,
  u.name AS recipient_name, u.profile_image AS recipient_image`;

function relatedTitle(r) {
  // "Related content/title" shown under the subject. Resolved live from the portal modules.
  if (!r.related_type || !r.related_id) return null;
  const q = {
    exam_assignment: 'SELECT p.title FROM exam_assignments a JOIN exam_papers p ON p.id = a.paper_id WHERE a.id = ?',
    exam_submission: 'SELECT p.title FROM exam_submissions s JOIN exam_assignments a ON a.id = s.assignment_id JOIN exam_papers p ON p.id = a.paper_id WHERE s.id = ?',
    mcq_assignment: "SELECT COALESCE(NULLIF(title,''), topic, 'MCQ assignment') AS title FROM mcq_assignments WHERE id = ?",
    mcq_set: 'SELECT title FROM mcq_sets WHERE id = ?',
    tutorial: 'SELECT title FROM tutorials WHERE id = ?',
    study_material: 'SELECT title FROM study_materials WHERE id = ?',
    student_mcq_plan: 'SELECT mp.name AS title FROM student_mcq_plans sp JOIN mcq_plans mp ON mp.id = sp.plan_id WHERE sp.id = ?',
    exam_order: 'SELECT p.title FROM exam_orders o JOIN exam_papers p ON p.id = o.paper_id WHERE o.id = ?',
  }[r.related_type];
  if (!q) return null;
  const row = db.prepare(q).get(r.related_id);
  return row ? row.title : null;
}

function buildWhere(user, f) {
  const sc = scope(user);
  const where = [sc.sql];
  const params = [...sc.params];

  if (f.search) {
    const like = `%${f.search}%`;
    where.push('(e.subject LIKE ? OR e.recipient LIKE ? OR u.name LIKE ?)');
    params.push(like, like, like);
  }
  if (f.type && visibleTypes(user).includes(f.type)) { where.push('e.type = ?'); params.push(f.type); }
  if (f.date_from) {
    const from = localToUtcSql(`${f.date_from} 00:00:00`);
    if (from) { where.push('COALESCE(e.sent_at, e.scheduled_at, e.created_at) >= ?'); params.push(from); }
  }
  if (f.date_to) {
    const to = localToUtcSql(`${f.date_to} 23:59:59`);
    if (to) { where.push('COALESCE(e.sent_at, e.scheduled_at, e.created_at) <= ?'); params.push(to); }
  }
  return { sql: where.join(' AND '), params };
}

// Dashboard cards + tab counts: always whole-scope totals (not narrowed by search/filters).
function counts(user) {
  const sc = scope(user);
  const c = db.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN ${TAB_SQL.sent} THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN ${TAB_SQL.scheduled} THEN 1 ELSE 0 END) AS scheduled,
       SUM(CASE WHEN ${TAB_SQL.failed} THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN ${TAB_SQL.drafts} THEN 1 ELSE 0 END) AS drafts
     FROM email_logs e WHERE ${sc.sql}`
  ).get(...sc.params);
  const out = { total: c.total || 0, sent: c.sent || 0, scheduled: c.scheduled || 0, failed: c.failed || 0, drafts: c.drafts || 0 };

  // "from last month" trend on the Total card: this calendar month vs the previous one (academy timezone).
  const tz = academyTz();
  const ym = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);
  const now = new Date();
  const thisM = ym(now);
  const prevM = ym(new Date(now.getFullYear(), now.getMonth() - 1, 15));
  const monthRows = db.prepare(`SELECT COALESCE(e.sent_at, e.scheduled_at, e.created_at) AS d FROM email_logs e WHERE ${sc.sql}`).all(...sc.params);
  const bucket = (s) => ym(new Date(`${String(s).replace(' ', 'T')}Z`));
  out.thisMonth = monthRows.filter((r) => r.d && bucket(r.d) === thisM).length;
  out.lastMonth = monthRows.filter((r) => r.d && bucket(r.d) === prevM).length;
  out.trendPct = out.lastMonth > 0 ? Math.round(((out.thisMonth - out.lastMonth) / out.lastMonth) * 100) : null;
  return out;
}

function list(user, f, page, pageSize) {
  const w = buildWhere(user, f);
  const tab = Object.keys(TAB_SQL).includes(f.tab) ? f.tab : 'all';
  let tabSql = '';
  if (tab !== 'all') tabSql = ` AND ${TAB_SQL[tab]}`;
  else if (f.status && STATUS_FILTER_SQL[f.status]) tabSql = ` AND ${STATUS_FILTER_SQL[f.status]}`;

  const from = 'FROM email_logs e LEFT JOIN users u ON u.id = e.recipient_user_id';
  const totalRows = db.prepare(`SELECT COUNT(*) AS c ${from} WHERE ${w.sql}${tabSql}`).get(...w.params).c;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const pageSafe = Math.min(Math.max(1, page), totalPages);
  const rows = db.prepare(
    `SELECT ${SELECT} ${from} WHERE ${w.sql}${tabSql}
     ORDER BY COALESCE(e.sent_at, e.scheduled_at, e.created_at) DESC, e.id DESC LIMIT ? OFFSET ?`
  ).all(...w.params, pageSize, (pageSafe - 1) * pageSize).map(decorate);
  return { rows, tab, pagination: { page: pageSafe, totalPages, totalRows, pageSize } };
}

function decorate(r) {
  return {
    ...r,
    status: uiStatus(r.raw_status),
    related_title: relatedTitle(r),
    unread: !r.read_at,
    sensitive: SENSITIVE_TEMPLATES.includes(r.template),
    recipient_name: r.recipient_name || r.recipient_email,
  };
}

function find(user, id) {
  const sc = scope(user);
  const row = db.prepare(
    `SELECT ${SELECT} FROM email_logs e LEFT JOIN users u ON u.id = e.recipient_user_id WHERE e.id = ? AND ${sc.sql}`
  ).get(id, ...sc.params);
  return row ? decorate(row) : null;
}

// ---------- mutations ----------
function ids(user, wanted) {
  // Only ids this user may see (and, for destructive actions, modify).
  return (wanted || []).map(Number).filter(Number.isInteger).map((id) => find(user, id)).filter(Boolean);
}

const markRead = (id) => db.prepare('UPDATE email_logs SET read_at = ?, updated_at = ? WHERE id = ? AND read_at IS NULL').run(nowSql(), nowSql(), id);
const markUnread = (id) => db.prepare('UPDATE email_logs SET read_at = NULL, updated_at = ? WHERE id = ?').run(nowSql(), id);
const softDelete = (id) => db.prepare('UPDATE email_logs SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(nowSql(), nowSql(), id);

module.exports = {
  TYPES, visibleTypes, counts, list, find, ids, canModify, uiStatus, markRead, markUnread, softDelete,
};
