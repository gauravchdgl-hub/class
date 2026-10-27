const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireStaff } = require('../middleware/auth');
const { sendEmail } = require('../lib/mailer');
const { logAction } = require('../lib/audit');

// Slug helper: converts a paper title to a URL-safe slug, then finds the paper
// by id embedded in the slug (format: paper-title-slug--<id>). This means URLs
// are readable ("/admin/papers/year-12-maths-paper--7") but lookups stay O(1).
function paperSlug(paper) {
  const base = (paper.title || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base + '--' + paper.id;
}
function paperIdFromSlug(slug) {
  const m = String(slug).match(/--(\d+)$/);
  return m ? parseInt(m[1], 10) : parseInt(slug, 10); // fallback: plain numeric id still works
}

// Parses the dynamic rubric rows (rubric_text[] / rubric_marks[]) from an Add/Edit Question
// form into a compact JSON array, e.g. [{"text":"Explains militarism","marks":2}, ...].
// Rows with no text are skipped. Returns null when there are no usable rows (plain model
// answer only, no structured rubric for this question).
function parseRubricFromBody(body) {
  const texts = [].concat(body.rubric_text || []);
  const marksArr = [].concat(body.rubric_marks || []);
  const rows = [];
  texts.forEach((t, i) => {
    const text = String(t || '').trim();
    if (!text) return;
    const marks = Math.max(0, parseInt(marksArr[i], 10) || 0);
    rows.push({ text, marks });
  });
  return rows.length ? JSON.stringify(rows) : null;
}


const { notify } = require('../lib/notify');
const { recomputeExamSubmission } = require('../lib/scoring');
const { processWooLineItem } = require('./webhook');
const wooApi = require('../services/wooApi');

const router = express.Router();
router.use(requireStaff);

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../public/uploads'),
    filename: (req, file, cb) => cb(null, `logo${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
});

// Student profile photo uploads (Add/Edit Student forms)
const studentPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../public/uploads'),
    filename: (req, file, cb) => cb(null, `student-${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
});

// Tutorial thumbnail uploads (public) + tutorial video uploads (private, streamed) — one
// multer instance routes each field to the right destination by fieldname.
const tutorialUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === 'video_file'
      ? path.join(__dirname, '../private/materials')
      : path.join(__dirname, '../public/uploads')),
    filename: (req, file, cb) => cb(null, `${file.fieldname === 'video_file' ? 'tut' : 'tutorial-thumb'}-${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// Subject icon uploads (Add/Edit Subject forms)
const subjectIconUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../public/uploads'),
    filename: (req, file, cb) => cb(null, `subject-${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
});

// "My Profile" for admin/teacher lives on the Settings page (name/password).
router.get('/profile', (req, res) => res.redirect('/admin/settings'));

router.get('/help', (req, res) => {
  const { renderDocumentation } = require('../lib/docs');
  res.render('admin/help', { docHtml: renderDocumentation() });
});

router.get('/dashboard', (req, res) => {
  const stats = {
    students: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student'").get().c,
    teachers: db.prepare("SELECT COUNT(*) c FROM users WHERE role='teacher'").get().c,
    subjects: db.prepare('SELECT COUNT(*) c FROM subjects').get().c,
    papers: db.prepare('SELECT COUNT(*) c FROM exam_papers').get().c,
    plans: db.prepare('SELECT COUNT(*) c FROM mcq_plans').get().c,
    pending: db.prepare("SELECT COUNT(*) c FROM exam_submissions WHERE status='pending_review'").get().c,
    pendingVerification: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student' AND email_verified=0").get().c,
    totalOrders: db.prepare('SELECT COUNT(*) c FROM exam_orders').get().c + db.prepare('SELECT COUNT(*) c FROM student_mcq_plans').get().c,
    totalRevenue: (db.prepare('SELECT COALESCE(SUM(amount),0) t FROM exam_orders').get().t) + (db.prepare('SELECT COALESCE(SUM(amount_paid),0) t FROM student_mcq_plans').get().t),
    activeStudents: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student' AND email_verified=1").get().c,
    pendingExams: db.prepare("SELECT COUNT(*) c FROM exam_assignments WHERE status='assigned'").get().c,
    completedExams: db.prepare("SELECT COUNT(*) c FROM exam_submissions WHERE status IN ('pending_review','published')").get().c,
    pendingPayments: db.prepare("SELECT COUNT(*) c FROM exam_orders WHERE status != 'paid'").get().c,
    completedPayments: db.prepare("SELECT COUNT(*) c FROM exam_orders WHERE status = 'paid'").get().c,
  };

  // Subject-wise average score (for the donut + legend)
  const subjectPerformance = db.prepare(
    `SELECT s.name, AVG(CASE WHEN sub.total_marks > 0 THEN sub.total_score * 100.0 / sub.total_marks ELSE NULL END) AS avg_score
     FROM exam_submissions sub
     JOIN exam_assignments a ON a.id = sub.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     JOIN subjects s ON s.id = p.subject_id
     WHERE sub.status = 'published'
     GROUP BY s.id ORDER BY avg_score DESC LIMIT 6`
  ).all().map((r) => ({ name: r.name, score: r.avg_score ? Math.round(r.avg_score) : 0 }));
  const donutColors = ['#1f6fe3', '#eea029', '#e64e82', '#12a36a', '#7358d8', '#46b6c6'];
  subjectPerformance.forEach((s, i) => { s.color = donutColors[i % donutColors.length]; });
  let cum = 0;
  const donutStops = subjectPerformance.map((s) => {
    const start = cum;
    cum += s.score;
    return `${s.color} ${start}% ${cum}%`;
  }).join(',');
  const overallAvgForDonut = subjectPerformance.length
    ? Math.round(subjectPerformance.reduce((sum, s) => sum + s.score, 0) / subjectPerformance.length)
    : 0;

  // Upcoming Exams — assigned/in-progress papers with a due date, soonest first.
  const upcomingExams = db.prepare(
    `SELECT p.title, p.duration_minutes, a.due_at, a.status
     FROM exam_assignments a JOIN exam_papers p ON p.id = a.paper_id
     WHERE a.status IN ('assigned', 'in_progress')
     ORDER BY (a.due_at IS NULL), a.due_at ASC LIMIT 4`
  ).all();

  // Last 6 months student signups, for the growth bar chart.
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const label = d.toLocaleDateString('en-US', { month: 'short' });
    const monthKey = d.toISOString().slice(0, 7); // YYYY-MM
    const count = db.prepare(
      "SELECT COUNT(*) c FROM users WHERE role='student' AND strftime('%Y-%m', created_at) = ?"
    ).get(monthKey).c;
    months.push({ label, count });
  }
  const maxSignups = Math.max(1, ...months.map((m) => m.count));

  const avgRow = db.prepare(
    `SELECT AVG(CASE WHEN total_marks > 0 THEN (total_score * 100.0 / total_marks) ELSE NULL END) a
     FROM exam_submissions WHERE status = 'published'`
  ).get();
  const avgScore = avgRow.a ? Math.round(avgRow.a) : 0;

  const recentActivity = db.prepare(
    `SELECT action, user_label, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 5`
  ).all();

  // ---- Recent Orders (both website full-paper orders and portal MCQ plan purchases) ----
  const recentPaperOrders = db.prepare(
    `SELECT o.id, u.name AS student, p.title AS item, o.amount, o.created_at, 'Paid' AS status
     FROM exam_orders o JOIN users u ON u.id = o.user_id JOIN exam_papers p ON p.id = o.paper_id`
  ).all();
  const recentPlanOrders = db.prepare(
    `SELECT sp.id, u.name AS student, mp.name AS item, sp.amount_paid AS amount, sp.purchased_at AS created_at, 'Paid' AS status
     FROM student_mcq_plans sp JOIN users u ON u.id = sp.user_id JOIN mcq_plans mp ON mp.id = sp.plan_id`
  ).all();
  const recentOrders = [...recentPaperOrders, ...recentPlanOrders]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);

  // ---- Upcoming Submissions (exams currently in progress or awaiting review, with a due date) ----
  const upcomingSubmissions = db.prepare(
    `SELECT u.name AS student, p.title AS paper, a.due_at, s.status
     FROM exam_assignments a
     JOIN users u ON u.id = a.user_id
     JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN exam_submissions s ON s.assignment_id = a.id
     WHERE a.status IN ('assigned', 'in_progress', 'submitted')
     ORDER BY (a.due_at IS NULL), a.due_at ASC LIMIT 5`
  ).all();

  // ---- Results Overview (most recent published results) ----
  const resultsOverview = db.prepare(
    `SELECT u.name AS student, p.title AS subject,
            CASE WHEN s.total_marks > 0 THEN ROUND(s.total_score * 100.0 / s.total_marks) ELSE 0 END AS score
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN users u ON u.id = a.user_id
     JOIN exam_papers p ON p.id = a.paper_id
     WHERE s.status = 'published'
     ORDER BY s.submitted_at DESC LIMIT 5`
  ).all().map((r) => ({ ...r, grade: r.score >= 85 ? 'A' : r.score >= 70 ? 'B' : r.score >= 50 ? 'C' : 'D' }));

  // ---- Teachers Overview ----
  const teachersOverview = db.prepare(
    `SELECT id, name, email FROM users WHERE role = 'teacher' ORDER BY created_at DESC LIMIT 5`
  ).all();

  // ---- Revenue Overview (last 6 months, papers + plans combined) ----
  const revenue = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const label = d.toLocaleDateString('en-US', { month: 'short' });
    const monthKey = d.toISOString().slice(0, 7);
    const paperRev = db.prepare(
      "SELECT COALESCE(SUM(amount),0) t FROM exam_orders WHERE strftime('%Y-%m', created_at) = ?"
    ).get(monthKey).t;
    const planRev = db.prepare(
      "SELECT COALESCE(SUM(amount_paid),0) t FROM student_mcq_plans WHERE strftime('%Y-%m', purchased_at) = ?"
    ).get(monthKey).t;
    revenue.push({ label, amount: paperRev + planRev });
  }
  const maxRevenue = Math.max(1, ...revenue.map((r) => r.amount));

  // ---- Exam Performance trend (avg score % + pass % per month, last 6 months) ----
  const examPerformance = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const label = d.toLocaleDateString('en-US', { month: 'short' });
    const monthKey = d.toISOString().slice(0, 7);
    const rows = db.prepare(
      `SELECT total_score, total_marks FROM exam_submissions
       WHERE status = 'published' AND strftime('%Y-%m', submitted_at) = ?`
    ).all(monthKey);
    const scored = rows.filter((r) => r.total_marks > 0);
    const avg = scored.length ? Math.round(scored.reduce((s, r) => s + (r.total_score / r.total_marks) * 100, 0) / scored.length) : 0;
    const pass = scored.length ? Math.round((scored.filter((r) => (r.total_score / r.total_marks) * 100 >= 50).length / scored.length) * 100) : 0;
    examPerformance.push({ label, avg, pass });
  }

  // ---- Top Performing Students (by average % across their published results) ----
  const topStudents = db.prepare(
    `SELECT u.id, u.name, u.class_year,
            AVG(CASE WHEN s.total_marks > 0 THEN s.total_score * 100.0 / s.total_marks ELSE NULL END) AS avg_score
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN users u ON u.id = a.user_id
     WHERE s.status = 'published'
     GROUP BY u.id HAVING avg_score IS NOT NULL
     ORDER BY avg_score DESC LIMIT 5`
  ).all().map((r) => ({ ...r, avg_score: Math.round(r.avg_score) }));

  // ---- Performance by Subject + Year (not a school "class" — you're one tutor selling
  // content by subject/year, so this groups by that instead of a fake 12A/12B section) ----
  const classPerformance = db.prepare(
    `SELECT s.name || ' ' || p.year AS label,
            AVG(CASE WHEN sub.total_marks > 0 THEN sub.total_score * 100.0 / sub.total_marks ELSE NULL END) AS avg_score
     FROM exam_submissions sub
     JOIN exam_assignments a ON a.id = sub.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     JOIN subjects s ON s.id = p.subject_id
     WHERE sub.status = 'published'
     GROUP BY s.id, p.year ORDER BY label LIMIT 6`
  ).all().map((r) => ({ label: r.label, score: r.avg_score ? Math.round(r.avg_score) : 0 }));
  const maxClassScore = Math.max(1, ...classPerformance.map((c) => c.score), 100);

  // ---- Pending Submissions (grouped by paper) ----
  const pendingSubmissionsList = db.prepare(
    `SELECT p.title, p.year, COUNT(*) AS cnt
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     WHERE s.status = 'pending_review'
     GROUP BY p.id ORDER BY cnt DESC LIMIT 4`
  ).all();

  // ---- Teacher Activity (audit log, most recent) ----
  const teacherActivity = db.prepare(
    `SELECT user_label, action, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 5`
  ).all();

  res.render('admin/dashboard', {
    stats, isAdmin: req.session.user.role === 'admin', months, maxSignups, avgScore, recentActivity,
    recentOrders, upcomingSubmissions, resultsOverview, teachersOverview, revenue, maxRevenue,
    subjectPerformance, donutStops, overallAvgForDonut, upcomingExams,
    examPerformance, topStudents, classPerformance, maxClassScore, pendingSubmissionsList, teacherActivity,
  });
});

// ---------- Students (list + per-module access toggle) ----------
router.get('/students', (req, res) => {
  const { q, year, class_section, status, page: pageParam } = req.query;
  const page = Math.max(1, parseInt(pageParam, 10) || 1);
  const PAGE_SIZE = 10;

  let where = "WHERE u.role = 'student'";
  const params = [];
  if (q) { where += ' AND (u.name LIKE ? OR u.email LIKE ? OR u.class_section LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (year) { where += ' AND u.class_year = ?'; params.push(year); }
  if (class_section) { where += ' AND u.class_section = ?'; params.push(class_section); }
  if (status === 'active') where += " AND u.account_status = 'active'";
  if (status === 'inactive') where += " AND u.account_status != 'active'";

  const total = db.prepare(`SELECT COUNT(*) c FROM users u ${where}`).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const offset = (page - 1) * PAGE_SIZE;

  const students = db.prepare(
    `SELECT u.id, u.name, u.email, u.phone, u.created_at, u.enrolled_at, u.email_verified, u.account_status,
       u.class_year, u.class_section, u.profile_image, u.student_code,
       (SELECT COALESCE(SUM(remaining_mcqs),0) FROM student_mcq_plans WHERE user_id = u.id) AS mcq_remaining,
       (SELECT COUNT(*) FROM exam_assignments WHERE user_id = u.id) AS papers_assigned,
       (SELECT AVG(CASE WHEN s.total_marks > 0 THEN s.total_score * 100.0 / s.total_marks ELSE NULL END)
          FROM exam_submissions s JOIN exam_assignments a ON a.id = s.assignment_id
          WHERE a.user_id = u.id AND s.status = 'published') AS avg_score
     FROM users u ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, PAGE_SIZE, offset);
  students.forEach((s) => { s.avg_score = s.avg_score ? Math.round(s.avg_score) : null; });

  const stats = {
    total: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student'").get().c,
    active: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student' AND account_status='active'").get().c,
    inactive: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student' AND account_status!='active'").get().c,
    newThisMonth: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").get().c,
  };

  const classOptions = db.prepare(
    "SELECT DISTINCT class_section FROM users WHERE role='student' AND class_section IS NOT NULL AND class_section != '' ORDER BY class_section"
  ).all().map((r) => r.class_section);

  res.render('admin/students', {
    students, stats, page, totalPages, total, pageSize: PAGE_SIZE, classOptions,
    filters: { q: q || '', year: year || '', class_section: class_section || '', status: status || '' },
  });
});

router.get('/students/new', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('admin/student_new', { subjects, student: null });
});

// Shared field-extraction helper for create + edit so both stay in sync.
function readStudentFields(body) {
  const cleanEmail = String(body.email || '').trim().toLowerCase();
  const cleanPhone = String(body.phone || '').replace(/\D/g, '');
  const parentPhone = String(body.parentPhone || '').replace(/\D/g, '');
  return {
    name: `${(body.firstName || '').trim()} ${(body.lastName || '').trim()}`.trim() || body.name || '',
    email: cleanEmail,
    phone: cleanPhone || null,
    dob: body.dob || null,
    gender: body.gender || null,
    nationality: body.nationality || null,
    student_code: body.studentId || null,
    address: body.address || null,
    city: body.city || null,
    state: body.state || null,
    postal_code: body.postcode || null,
    country: body.country || 'Australia',
    class_year: body.yearLevel ? `Year ${body.yearLevel}` : (body.class_year || null),
    class_section: body.class || null,
    interested_subject_id: body.subjects || null,
    enrolled_at: body.enrollmentDate || null,
    username: body.username || null,
    account_status: body.accountStatus || 'active',
    bio: body.bio || null,
    medical_info: body.medicalInfo || null,
    preferred_language: body.preferredLanguage || 'English',
    student_timezone: body.timezone || '(GMT+10:00) Australia/Sydney',
    notif_student: body.notifStudent ? 1 : 0,
    notif_parent: body.notifParent ? 1 : 0,
    allow_download: body.allowDownload ? 1 : 0,
    allow_exams: body.allowExams ? 1 : 0,
    father_name: body.parentName || null,
    father_phone: parentPhone || null,
    parent_email: body.parentEmail || null,
    parent_relationship: body.parentRelationship || null,
  };
}

router.post('/students/new', studentPhotoUpload.single('profilePhoto'), (req, res) => {
  const f = readStudentFields(req.body);
  if (!f.name || !f.email) {
    req.flash('error', 'First name, last name and email are required.');
    return res.redirect('/admin/students/new');
  }

  const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(f.email);
  if (existingEmail) {
    req.flash('error', 'A student with this email already exists.');
    return res.redirect('/admin/students/new');
  }

  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(req.body.password || Math.random().toString(36).slice(2, 10), 8);
  const profileImage = req.file ? `/uploads/${req.file.filename}` : null;

  const id = db.prepare(
    `INSERT INTO users (
      name, email, phone, password, role, email_verified, dob, gender, nationality, student_code,
      address, city, state, postal_code, country, class_year, class_section, interested_subject_id,
      enrolled_at, username, account_status, bio, medical_info, preferred_language, student_timezone,
      notif_student, notif_parent, allow_download, allow_exams, father_name, father_phone, parent_email,
      parent_relationship, profile_image
    ) VALUES (?,?,?,?,'student',1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    f.name, f.email, f.phone, hash, f.dob, f.gender, f.nationality, f.student_code,
    f.address, f.city, f.state, f.postal_code, f.country, f.class_year, f.class_section, f.interested_subject_id || null,
    f.enrolled_at, f.username, f.account_status, f.bio, f.medical_info, f.preferred_language, f.student_timezone,
    f.notif_student, f.notif_parent, f.allow_download, f.allow_exams, f.father_name, f.father_phone, f.parent_email,
    f.parent_relationship, profileImage
  ).lastInsertRowid;

  const freePlan = db.prepare("SELECT * FROM mcq_plans WHERE name = 'Free Plan'").get();
  if (freePlan) {
    const expiresAt = new Date(Date.now() + freePlan.validity_days * 86400000).toISOString();
    db.prepare(
      `INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at) VALUES (?,?,NULL,NULL,?,?)`
    ).run(id, freePlan.id, freePlan.mcq_count, expiresAt);
  }

  logAction(req, 'student_created_by_staff', { recordType: 'user', recordId: id, newValue: { name: f.name, email: f.email } });

  if (req.body.sendWelcomeEmail) {
    sendEmail({
      to: f.email,
      subject: 'Welcome to AUS Academy — your account is ready',
      template: 'student_welcome',
      userId: id, createdBy: req.session.user.id, relatedType: 'user', relatedId: id,
      html: `<p>Hi ${f.name},</p><p>Your student account has been created by your teacher/admin.</p><p><b>Login email:</b> ${f.email}<br><b>Password:</b> ${req.body.password ? '(the one your teacher set)' : 'a temporary password — ask your teacher for it'}</p><p>Log in at the Student Portal to get started.</p>`,
    });
  }
  if (req.body.sendParentNotification && f.parent_email) {
    sendEmail({
      to: f.parent_email,
      subject: `${f.name}'s AUS Academy account has been created`,
      template: 'parent_notification',
      createdBy: req.session.user.id, relatedType: 'user', relatedId: id,
      html: `<p>Hello,</p><p>A student account for <b>${f.name}</b> has been created on AUS Academy.</p>`,
    });
  }
  notify(id, 'account_created', 'Your account is ready', 'Welcome to AUS Academy — start practicing today.', '/student/dashboard', { email: false }); // welcome email is sent above

  req.flash('success', `Student account created for ${f.name}.`);
  res.redirect('/admin/students');
});

// ---------- Student Profile (detail view for Admin/Teacher) ----------
router.get('/students/:id', (req, res) => {
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
  if (!student) { req.flash('error', 'Student not found'); return res.redirect('/admin/students'); }

  const plans = db.prepare(
    `SELECT sp.*, mp.name AS plan_name FROM student_mcq_plans sp JOIN mcq_plans mp ON mp.id = sp.plan_id WHERE sp.user_id = ?`
  ).all(student.id);

  const assignments = db.prepare(
    `SELECT a.*, p.title, s.status AS sub_status, s.total_score, s.total_marks
     FROM exam_assignments a JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN exam_submissions s ON s.assignment_id = a.id
     WHERE a.user_id = ? ORDER BY a.assigned_at DESC`
  ).all(student.id);

  const orders = db.prepare(
    `SELECT o.amount, o.created_at, p.title AS item FROM exam_orders o JOIN exam_papers p ON p.id = o.paper_id WHERE o.user_id = ?`
  ).all(student.id);

  const accessRow = db.prepare("SELECT module, unlocked FROM student_module_access WHERE user_id = ?").all(student.id);
  const access = { subjects: false, tutorials: false, material: false };
  accessRow.forEach((r) => { access[r.module] = !!r.unlocked; });

  const avgRow = db.prepare(
    `SELECT AVG(CASE WHEN s.total_marks > 0 THEN s.total_score * 100.0 / s.total_marks ELSE NULL END) a
     FROM exam_submissions s JOIN exam_assignments a ON a.id = s.assignment_id
     WHERE a.user_id = ? AND s.status = 'published'`
  ).get(student.id);

  // Assigned Tutorials tab — real rows from content_assignments (manual or webhook)
  const assignedTutorials = db.prepare(
    `SELECT ca.id AS assignment_id, ca.status AS ca_status, ca.assigned_at, t.id AS tutorial_id, t.title, s.name AS subject_name
     FROM content_assignments ca JOIN tutorials t ON t.id = ca.content_id
     LEFT JOIN subjects s ON s.id = t.subject_id
     WHERE ca.user_id = ? AND ca.content_type = 'tutorial' ORDER BY ca.assigned_at DESC`
  ).all(student.id);

  // Assigned Study Material tab
  const assignedMaterial = db.prepare(
    `SELECT ca.id AS assignment_id, ca.status AS ca_status, ca.assigned_at, m.id AS material_id, m.title, s.name AS subject_name
     FROM content_assignments ca JOIN study_materials m ON m.id = ca.content_id
     LEFT JOIN subjects s ON s.id = m.subject_id
     WHERE ca.user_id = ? AND ca.content_type = 'study_material' ORDER BY ca.assigned_at DESC`
  ).all(student.id);

  // Assigned MCQs tab — from the quota/assignment engine
  const mcqAssignments = db.prepare(
    `SELECT ma.*, s.name AS subject_name,
       (SELECT COUNT(*) FROM mcq_assignment_questions WHERE assignment_id = ma.id) AS total_q,
       (SELECT COUNT(*) FROM mcq_assignment_questions WHERE assignment_id = ma.id AND answered_at IS NOT NULL) AS answered_q,
       (SELECT COUNT(*) FROM mcq_assignment_questions WHERE assignment_id = ma.id AND is_correct = 1) AS correct_q
     FROM mcq_assignments ma LEFT JOIN subjects s ON s.id = ma.subject_id
     WHERE ma.user_id = ? ORDER BY ma.created_at DESC`
  ).all(student.id);

  const allTutorials = db.prepare('SELECT id, title FROM tutorials WHERE is_published = 1 ORDER BY title').all();
  const allMaterial = db.prepare('SELECT id, title FROM study_materials WHERE is_published = 1 ORDER BY title').all();
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();

  const metrics = {
    tutorialsTotal: assignedTutorials.length,
    tutorialsDone: assignedTutorials.filter((t) => t.ca_status === 'assigned').length,
    materialTotal: assignedMaterial.length,
    mcqTotal: mcqAssignments.reduce((s, m) => s + (m.total_q || 0), 0),
    mcqDone: mcqAssignments.reduce((s, m) => s + (m.answered_q || 0), 0),
    papersTotal: assignments.length,
    papersDone: assignments.filter((a) => a.sub_status === 'published').length,
  };

  res.render('admin/student_detail', {
    student, plans, assignments, orders, access, subjects,
    assignedTutorials, assignedMaterial, mcqAssignments, allTutorials, allMaterial, metrics,
    avgScore: avgRow.a ? Math.round(avgRow.a) : null,
  });
});

// ---------- Edit Student ----------
router.get('/students/:id/edit', (req, res) => {
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
  if (!student) { req.flash('error', 'Student not found'); return res.redirect('/admin/students'); }
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('admin/student_new', { subjects, student });
});

router.post('/students/:id/edit', studentPhotoUpload.single('profilePhoto'), (req, res) => {
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
  if (!student) { req.flash('error', 'Student not found'); return res.redirect('/admin/students'); }

  const f = readStudentFields(req.body);
  if (!f.name || !f.email) {
    req.flash('error', 'First name, last name and email are required.');
    return res.redirect(`/admin/students/${student.id}`);
  }
  const emailClash = db.prepare('SELECT id FROM users WHERE LOWER(email) = ? AND id != ?').get(f.email, student.id);
  if (emailClash) {
    req.flash('error', 'Another account already uses that email.');
    return res.redirect(`/admin/students/${student.id}`);
  }

  const profileImage = req.file ? `/uploads/${req.file.filename}` : student.profile_image;

  db.prepare(
    `UPDATE users SET name=?, email=?, phone=?, dob=?, gender=?, nationality=?, student_code=?,
      address=?, city=?, state=?, postal_code=?, country=?, class_year=?, class_section=?, interested_subject_id=?,
      enrolled_at=?, username=?, account_status=?, bio=?, medical_info=?, preferred_language=?, student_timezone=?,
      notif_student=?, notif_parent=?, allow_download=?, allow_exams=?, father_name=?, father_phone=?, parent_email=?,
      parent_relationship=?, profile_image=?, email_verified=?
     WHERE id = ?`
  ).run(
    f.name, f.email, f.phone, f.dob, f.gender, f.nationality, f.student_code,
    f.address, f.city, f.state, f.postal_code, f.country, f.class_year, f.class_section, f.interested_subject_id || null,
    f.enrolled_at, f.username, f.account_status, f.bio, f.medical_info, f.preferred_language, f.student_timezone,
    f.notif_student, f.notif_parent, f.allow_download, f.allow_exams, f.father_name, f.father_phone, f.parent_email,
    f.parent_relationship, profileImage, f.account_status === 'active' ? 1 : 0,
    student.id
  );

  logAction(req, 'student_updated_by_staff', { recordType: 'user', recordId: student.id, oldValue: { name: student.name, email: student.email }, newValue: { name: f.name, email: f.email } });
  req.flash('success', `${f.name}'s profile was updated.`);
  res.redirect(`/admin/students/${student.id}`);
});

// ---------- Reset Student Password ----------
router.post('/students/:id/reset-password', (req, res) => {
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
  if (!student) { req.flash('error', 'Student not found'); return res.redirect('/admin/students'); }

  const bcrypt = require('bcryptjs');
  const newPassword = Math.random().toString(36).slice(2, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 8), student.id);

  sendEmail({
    to: student.email,
    subject: 'Your AUS Academy password has been reset',
    template: 'password_reset_by_staff',
    userId: student.id, createdBy: req.session.user.id, relatedType: 'user', relatedId: student.id,
    html: `<p>Hi ${student.name},</p><p>Your password was reset by your teacher/admin.</p><p><b>New temporary password:</b> ${newPassword}</p><p>Please log in and change it from your Profile &amp; Settings page.</p>`,
  });
  logAction(req, 'student_password_reset_by_staff', { recordType: 'user', recordId: student.id });
  req.flash('success', `Password reset for ${student.name}. A temporary password was emailed to them.`);
  res.redirect(`/admin/students/${student.id}`);
});

// ---------- Manually assign a Tutorial / Study Material to one student ----------
router.post('/students/:id/assign-tutorial', (req, res) => {
  const { tutorial_id } = req.body;
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
  if (!student || !tutorial_id) { req.flash('error', 'Select a tutorial to assign.'); return res.redirect(`/admin/students/${req.params.id}`); }
  const existing = db.prepare("SELECT id FROM content_assignments WHERE user_id=? AND content_type='tutorial' AND content_id=?").get(student.id, tutorial_id);
  if (existing) {
    db.prepare("UPDATE content_assignments SET status='assigned', assigned_by=? WHERE id=?").run(req.session.user.id, existing.id);
  } else {
    db.prepare(
      "INSERT INTO content_assignments (user_id, content_type, content_id, amount, payment_method, assigned_by, status) VALUES (?, 'tutorial', ?, 0, 'manual', ?, 'assigned')"
    ).run(student.id, tutorial_id, req.session.user.id);
  }
  const tutorial = db.prepare('SELECT title FROM tutorials WHERE id = ?').get(tutorial_id);
  notify(student.id, 'content_assignment', 'New tutorial assigned', tutorial ? `"${tutorial.title}" has been assigned to you.` : '', '/student/tutorials', { relatedType: 'tutorial', relatedId: Number(tutorial_id), itemTitle: tutorial && tutorial.title, itemLabel: 'Tutorial', createdBy: req.session.user.id });
  logAction(req, 'tutorial_assigned', { recordType: 'user', recordId: student.id, newValue: { tutorial_id } });
  req.flash('success', 'Tutorial assigned to student.');
  res.redirect(`/admin/students/${student.id}#tutorials`);
});

router.post('/students/:id/assign-material', (req, res) => {
  const { material_id } = req.body;
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
  if (!student || !material_id) { req.flash('error', 'Select a study material to assign.'); return res.redirect(`/admin/students/${req.params.id}`); }
  const existing = db.prepare("SELECT id FROM content_assignments WHERE user_id=? AND content_type='study_material' AND content_id=?").get(student.id, material_id);
  if (existing) {
    db.prepare("UPDATE content_assignments SET status='assigned', assigned_by=? WHERE id=?").run(req.session.user.id, existing.id);
  } else {
    db.prepare(
      "INSERT INTO content_assignments (user_id, content_type, content_id, amount, payment_method, assigned_by, status) VALUES (?, 'study_material', ?, 0, 'manual', ?, 'assigned')"
    ).run(student.id, material_id, req.session.user.id);
  }
  const material = db.prepare('SELECT title FROM study_materials WHERE id = ?').get(material_id);
  notify(student.id, 'content_assignment', 'New study material assigned', material ? `"${material.title}" has been assigned to you.` : '', '/student/material', { relatedType: 'study_material', relatedId: Number(material_id), itemTitle: material && material.title, itemLabel: 'Study Material', createdBy: req.session.user.id });
  logAction(req, 'material_assigned', { recordType: 'user', recordId: student.id, newValue: { material_id } });
  req.flash('success', 'Study material assigned to student.');
  res.redirect(`/admin/students/${student.id}#material`);
});

// Toggle one module (Subjects / Tutorials / Study Material) on/off for one student
router.post('/students/:id/access/:module', (req, res) => {
  const { id, module } = req.params;
  if (!['subjects', 'tutorials', 'material'].includes(module)) {
    req.flash('error', 'Unknown module');
    return res.redirect(`/admin/students/${id}`);
  }
  const existing = db.prepare('SELECT * FROM student_module_access WHERE user_id = ? AND module = ?').get(id, module);
  const newValue = existing ? (existing.unlocked ? 0 : 1) : 1;
  if (existing) {
    db.prepare('UPDATE student_module_access SET unlocked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newValue, existing.id);
  } else {
    db.prepare('INSERT INTO student_module_access (user_id, module, unlocked) VALUES (?,?,?)').run(id, module, newValue);
  }
  req.flash('success', `${module} access ${newValue ? 'unlocked' : 'locked'} for this student`);
  res.redirect(req.get('Referer') || `/admin/students/${id}`);
});

// ---------- Tutorials ----------
router.get('/tutorials', (req, res) => {
  const { q, subject_id, year, status, sort } = req.query;
  let sql = `SELECT t.*, s.name AS subject_name FROM tutorials t LEFT JOIN subjects s ON s.id = t.subject_id WHERE 1=1`;
  const params = [];
  if (q) { sql += ' AND (t.title LIKE ? OR s.name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (subject_id) { sql += ' AND t.subject_id = ?'; params.push(subject_id); }
  if (year) { sql += ' AND t.year = ?'; params.push(year); }
  if (status === 'published') sql += ' AND t.is_published = 1';
  if (status === 'draft') sql += ' AND t.is_published = 0';
  if (sort === 'oldest') sql += ' ORDER BY t.created_at ASC';
  else if (sort === 'title') sql += ' ORDER BY t.title ASC';
  else if (sort === 'views') sql += ' ORDER BY t.views DESC';
  else sql += ' ORDER BY t.created_at DESC';
  const tutorials = db.prepare(sql).all(...params);

  const allTutorials = db.prepare('SELECT is_published, views FROM tutorials').all();
  const stats = {
    total: allTutorials.length,
    published: allTutorials.filter((t) => t.is_published).length,
    draft: allTutorials.filter((t) => !t.is_published).length,
    totalViews: allTutorials.reduce((sum, t) => sum + (t.views || 0), 0),
  };
  const featured = db.prepare(
    `SELECT t.*, s.name AS subject_name FROM tutorials t LEFT JOIN subjects s ON s.id = t.subject_id
     WHERE t.is_featured = 1 AND t.is_published = 1 ORDER BY t.created_at DESC LIMIT 5`
  ).all();
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('admin/tutorials', {
    tutorials, subjects, stats, featured,
    filters: { q: q || '', subject_id: subject_id || '', year: year || '', status: status || '', sort: sort || 'newest' },
  });
});

router.get('/tutorials/new', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const students = db.prepare("SELECT id, name, email FROM users WHERE role = 'student' ORDER BY name").all();
  res.render('admin/tutorial_new', { subjects, students, tutorial: null });
});

router.get('/tutorials/:id/edit', (req, res) => {
  const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(req.params.id);
  if (!tutorial) { req.flash('error', 'Tutorial not found'); return res.redirect('/admin/tutorials'); }
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const students = db.prepare("SELECT id, name, email FROM users WHERE role = 'student' ORDER BY name").all();
  res.render('admin/tutorial_new', { subjects, students, tutorial });
});

function readTutorialFields(body) {
  return {
    title: (body.title || '').trim(),
    subject_id: body.subject_id || null,
    year: body.year || null,
    level: body.level || 'Beginner',
    duration_minutes: parseInt(body.duration_minutes, 10) || 0,
    description: body.description || '',
    module: body.module || '',
    lesson: body.lesson || '',
    video_url: body.video_url || null,
    is_published: body.status === 'draft' ? 0 : 1,
    allow_comments: body.allow_comments ? 1 : 0,
    allow_download: body.allow_download ? 1 : 0,
    is_featured: body.is_featured ? 1 : 0,
    tags: body.tags || '',
  };
}

router.post('/tutorials/new', tutorialUpload.fields([{ name: 'thumbnail', maxCount: 1 }, { name: 'video_file', maxCount: 1 }]), (req, res) => {
  const f = readTutorialFields(req.body);
  if (!f.title) { req.flash('error', 'Title is required.'); return res.redirect('/admin/tutorials/new'); }
  const thumbFile = req.files && req.files.thumbnail && req.files.thumbnail[0];
  const videoFile = req.files && req.files.video_file && req.files.video_file[0];
  const thumbnail_url = thumbFile ? `/uploads/${thumbFile.filename}` : null;
  const video_path = videoFile ? videoFile.filename : null;
  const id = db.prepare(
    `INSERT INTO tutorials (title, subject_id, year, video_url, video_path, description, duration_minutes, is_published,
       thumbnail_url, level, module, lesson, allow_comments, allow_download, is_featured, tags, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    f.title, f.subject_id, f.year, f.video_url, video_path, f.description, f.duration_minutes, f.is_published,
    thumbnail_url, f.level, f.module, f.lesson, f.allow_comments, f.allow_download, f.is_featured, f.tags, req.session.user.id
  ).lastInsertRowid;

  // Assign To: none (all students with module access) | specific students
  if (req.body.assignto === 'students' && req.body.student_ids) {
    const ids = Array.isArray(req.body.student_ids) ? req.body.student_ids : [req.body.student_ids];
    ids.forEach((uid) => {
      db.prepare(
        "INSERT OR IGNORE INTO content_assignments (user_id, content_type, content_id, amount, payment_method, assigned_by, status, due_date, instructions) VALUES (?, 'tutorial', ?, 0, 'manual', ?, 'assigned', ?, ?)"
      ).run(uid, id, req.session.user.id, req.body.due_date || null, req.body.instructions || null);
      notify(uid, 'content_assignment', 'New Tutorial Assigned', `"${f.title}" has been assigned to you.`, '/student/tutorials', { relatedType: 'tutorial', relatedId: Number(id), itemTitle: f.title, itemLabel: 'Tutorial', dueDate: req.body.due_date, instructions: req.body.instructions, createdBy: req.session.user.id });
    });
  }

  req.flash('success', 'Tutorial created.');
  res.redirect('/admin/tutorials');
});

router.post('/tutorials/:id/edit', tutorialUpload.fields([{ name: 'thumbnail', maxCount: 1 }, { name: 'video_file', maxCount: 1 }]), (req, res) => {
  const existing = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(req.params.id);
  if (!existing) { req.flash('error', 'Tutorial not found'); return res.redirect('/admin/tutorials'); }
  const f = readTutorialFields(req.body);
  const thumbFile = req.files && req.files.thumbnail && req.files.thumbnail[0];
  const videoFile = req.files && req.files.video_file && req.files.video_file[0];
  const thumbnail_url = thumbFile ? `/uploads/${thumbFile.filename}` : existing.thumbnail_url;
  const video_path = videoFile ? videoFile.filename : existing.video_path;
  db.prepare(
    `UPDATE tutorials SET title=?, subject_id=?, year=?, video_url=?, video_path=?, description=?, duration_minutes=?, is_published=?,
       thumbnail_url=?, level=?, module=?, lesson=?, allow_comments=?, allow_download=?, is_featured=?, tags=? WHERE id=?`
  ).run(
    f.title, f.subject_id, f.year, f.video_url, video_path, f.description, f.duration_minutes, f.is_published,
    thumbnail_url, f.level, f.module, f.lesson, f.allow_comments, f.allow_download, f.is_featured, f.tags, req.params.id
  );
  req.flash('success', 'Tutorial updated.');
  res.redirect('/admin/tutorials');
});

router.post('/tutorials/:id/woo-link', (req, res) => {
  db.prepare('UPDATE tutorials SET woo_product_id = ? WHERE id = ?').run(req.body.woo_product_id || null, req.params.id);
  req.flash('success', 'WooCommerce link updated.');
  res.redirect('/admin/tutorials');
});

router.post('/tutorials/:id/toggle', (req, res) => {
  const t = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE tutorials SET is_published = ? WHERE id = ?').run(t.is_published ? 0 : 1, req.params.id);
  res.redirect('/admin/tutorials');
});

router.post('/tutorials/:id/delete', (req, res) => {
  db.prepare('DELETE FROM tutorials WHERE id = ?').run(req.params.id);
  db.prepare("DELETE FROM content_assignments WHERE content_type='tutorial' AND content_id=?").run(req.params.id);
  db.prepare('DELETE FROM tutorial_progress WHERE tutorial_id = ?').run(req.params.id);
  db.prepare('DELETE FROM tutorial_comments WHERE tutorial_id = ?').run(req.params.id);
  req.flash('success', 'Tutorial deleted');
  res.redirect('/admin/tutorials');
});

// ---------- Assign Tutorial to Students ----------
router.get('/tutorials/:id/assign', (req, res) => {
  const tutorial = db.prepare(
    `SELECT t.*, s.name AS subject_name FROM tutorials t LEFT JOIN subjects s ON s.id = t.subject_id WHERE t.id = ?`
  ).get(req.params.id);
  if (!tutorial) { req.flash('error', 'Tutorial not found'); return res.redirect('/admin/tutorials'); }
  const students = db.prepare("SELECT id, name, email, class_section, class_year FROM users WHERE role = 'student' ORDER BY name").all();
  const assignedIds = db.prepare(
    "SELECT content_id FROM content_assignments WHERE content_type='tutorial' AND status='assigned'"
  ).all();
  const alreadyAssigned = new Set(
    db.prepare("SELECT user_id FROM content_assignments WHERE content_type='tutorial' AND content_id=? AND status='assigned'")
      .all(req.params.id).map((r) => r.user_id)
  );
  res.render('admin/tutorial_assign', { tutorial, students, alreadyAssigned });
});

router.post('/tutorials/:id/assign', (req, res) => {
  const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(req.params.id);
  if (!tutorial) { req.flash('error', 'Tutorial not found'); return res.redirect('/admin/tutorials'); }
  const ids = Array.isArray(req.body.student_ids) ? req.body.student_ids : (req.body.student_ids ? [req.body.student_ids] : []);
  if (!ids.length) { req.flash('error', 'Please select at least one student.'); return res.redirect(`/admin/tutorials/${req.params.id}/assign`); }

  const dueDate = req.body.due_date || null;
  const accessType = req.body.access_type === 'lifetime' ? 'lifetime' : 'until_due';
  const allowDownload = req.body.allow_download === 'yes' ? 1 : 0;
  const instructions = req.body.custom_message || null;
  const notifyStudents = req.body.notify !== 'no';

  ids.forEach((uid) => {
    const existing = db.prepare("SELECT id FROM content_assignments WHERE user_id=? AND content_type='tutorial' AND content_id=?").get(uid, tutorial.id);
    if (existing) {
      db.prepare(
        "UPDATE content_assignments SET status='assigned', assigned_by=?, due_date=?, access_type=?, allow_download=?, instructions=? WHERE id=?"
      ).run(req.session.user.id, dueDate, accessType, allowDownload, instructions, existing.id);
    } else {
      db.prepare(
        `INSERT INTO content_assignments (user_id, content_type, content_id, amount, payment_method, assigned_by, status, due_date, access_type, allow_download, instructions)
         VALUES (?, 'tutorial', ?, 0, 'manual', ?, 'assigned', ?, ?, ?, ?)`
      ).run(uid, tutorial.id, req.session.user.id, dueDate, accessType, allowDownload, instructions);
    }
    if (notifyStudents) {
      notify(uid, 'content_assignment', 'New Tutorial Assigned', `"${tutorial.title}" has been assigned to you.`, '/student/tutorials', { relatedType: 'tutorial', relatedId: tutorial.id, itemTitle: tutorial.title, itemLabel: 'Tutorial', dueDate, instructions, createdBy: req.session.user.id });
    }
  });

  req.flash('success', `Tutorial assigned to ${ids.length} student${ids.length > 1 ? 's' : ''}.`);
  res.redirect('/admin/tutorials');
});

// ---------- Tutorial comments (teacher side: view + reply) ----------
router.get('/tutorials/:id/comments', (req, res) => {
  const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(req.params.id);
  if (!tutorial) { req.flash('error', 'Tutorial not found'); return res.redirect('/admin/tutorials'); }
  const comments = db.prepare(
    `SELECT c.*, u.name AS user_name, u.role AS user_role FROM tutorial_comments c
     JOIN users u ON u.id = c.user_id WHERE c.tutorial_id = ? ORDER BY c.created_at ASC`
  ).all(req.params.id);
  res.render('admin/tutorial_comments', { tutorial, comments });
});

router.post('/tutorials/:id/comments/:commentId/reply', (req, res) => {
  const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(req.params.id);
  const parent = db.prepare('SELECT * FROM tutorial_comments WHERE id = ?').get(req.params.commentId);
  if (!tutorial || !parent || !req.body.body) { return res.redirect(`/admin/tutorials/${req.params.id}/comments`); }
  db.prepare('INSERT INTO tutorial_comments (tutorial_id, user_id, parent_id, body) VALUES (?,?,?,?)')
    .run(tutorial.id, req.session.user.id, parent.id, req.body.body);
  notify(parent.user_id, 'tutorial_comment_reply', 'Your question was answered', `Your teacher replied to your question on "${tutorial.title}".`, `/student/tutorials/${tutorial.id}`, { relatedType: 'tutorial', relatedId: tutorial.id, itemTitle: tutorial.title, createdBy: req.session.user.id });
  req.flash('success', 'Reply posted.');
  res.redirect(`/admin/tutorials/${req.params.id}/comments`);
});

// ---------- Study Material: Modules + Lessons (video/PDF/Doc/PPT/ZIP, securely stored) ----------
const privateUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../private/materials'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB, generous for lesson videos
});

function materialFileMeta(m) {
  // File-size/type badge shown across All Study Materials, Assign, and the
  // student list/single-view pages — computed once here from whichever of
  // the private files is actually set, real bytes off disk, no dummy sizes.
  const dir = path.join(__dirname, '../private/materials');
  let filename = null;
  let badge = (m.content_type || 'pdf').toUpperCase();
  if (m.content_type === 'video' && m.video_path) filename = m.video_path;
  else if (m.file_path) filename = m.file_path;
  else if (m.pdf_path) filename = m.pdf_path;
  else if (m.video_path) filename = m.video_path;
  if (m.content_type === 'link') badge = 'Link';
  else if (['doc', 'docx'].includes((m.content_type || '').toLowerCase())) badge = 'Doc';
  else if (m.content_type === 'ppt') badge = 'PPT';
  else if (m.content_type === 'zip') badge = 'ZIP';
  else if (m.content_type === 'video') badge = 'Video';
  else badge = 'PDF';
  let sizeBytes = m.file_size_bytes || null;
  if (!sizeBytes && filename) {
    try { sizeBytes = fs.statSync(path.join(dir, filename)).size; } catch (e) { sizeBytes = null; }
  }
  const sizeLabel = sizeBytes ? (sizeBytes > 1024 * 1024 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(sizeBytes / 1024)} KB`) : '—';
  return { badge, sizeLabel, filename };
}

router.get('/material', (req, res) => {
  const { q, subject, year, module: moduleFilter, status, sort } = req.query;
  let rows = db.prepare(
    `SELECT m.*, s.name AS subject_name, cm.title AS module_title FROM study_materials m
     LEFT JOIN subjects s ON s.id = m.subject_id
     LEFT JOIN course_modules cm ON cm.id = m.module_id
     ORDER BY m.created_at DESC`
  ).all();

  rows = rows.map((m) => {
    const fileMeta = materialFileMeta(m);
    const assignedCount = db.prepare("SELECT COUNT(*) c FROM content_assignments WHERE content_type='study_material' AND content_id=? AND status='assigned'").get(m.id).c;
    const computedStatus = !m.is_published ? 'Inactive' : (m.available_from && new Date(m.available_from) > new Date() ? 'Scheduled' : 'Active');
    return { ...m, fileMeta, assignedCount, computedStatus };
  });

  if (q) rows = rows.filter((m) => m.title.toLowerCase().includes(q.toLowerCase()) || (m.subject_name || '').toLowerCase().includes(q.toLowerCase()));
  if (subject) rows = rows.filter((m) => m.subject_name === subject);
  if (year) rows = rows.filter((m) => m.year === year);
  if (moduleFilter) rows = rows.filter((m) => m.module_title === moduleFilter);
  if (status) rows = rows.filter((m) => m.computedStatus === status);
  if (sort === 'title_asc') rows.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'title_desc') rows.sort((a, b) => b.title.localeCompare(a.title));

  const perPage = parseInt(req.query.per_page, 10) || 10;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const pageRows = rows.slice((page - 1) * perPage, page * perPage);

  const allRows = db.prepare('SELECT is_published, available_from FROM study_materials').all();
  const stats = {
    total: allRows.length,
    active: allRows.filter((m) => m.is_published && !(m.available_from && new Date(m.available_from) > new Date())).length,
    scheduled: allRows.filter((m) => m.is_published && m.available_from && new Date(m.available_from) > new Date()).length,
    inactive: allRows.filter((m) => !m.is_published).length,
  };

  // This page's Subject filter matches by name only (Year is its own separate filter right
  // next to it), so the dropdown lists each distinct subject name once rather than once per
  // Year 11/Year 12 row.
  const subjects = [...new Map(db.prepare('SELECT * FROM subjects ORDER BY name').all().map((s) => [s.name, s])).values()];
  const modules = db.prepare(
    `SELECT cm.*, s.name AS subject_name FROM course_modules cm
     JOIN subjects s ON s.id = cm.subject_id ORDER BY s.name, cm.order_no, cm.id`
  ).all();
  const years = [...new Set(db.prepare('SELECT DISTINCT year FROM study_materials WHERE year IS NOT NULL').all().map((r) => r.year))];

  res.render('admin/material', {
    materials: pageRows, allCount: rows.length, stats, page, perPage, totalPages,
    subjects, modules, years,
    filters: { q: q || '', subject: subject || '', year: year || '', module: moduleFilter || '', status: status || '', sort: sort || '' },
  });
});

// ---------- Add Class Module/Topic/Year (extends course_modules) ----------
router.get('/material/module/new', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const allModules = db.prepare(
    `SELECT cm.*, s.name AS subject_name FROM course_modules cm
     JOIN subjects s ON s.id = cm.subject_id ORDER BY s.name, cm.order_no, cm.id`
  ).all();
  res.render('admin/material_module_new', { subjects, item: null, allModules });
});

router.get('/material/module/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM course_modules WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Not found'); return res.redirect('/admin/material'); }
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('admin/material_module_new', { subjects, item });
});

router.post('/material/module', (req, res) => {
  const { subject_id, class_name, year_level, title, description, order_no } = req.body;
  if (!subject_id || !title || !title.trim()) {
    req.flash('error', 'Subject and Module/Topic are required.');
    return res.redirect('/admin/material/module/new');
  }
  db.prepare(
    'INSERT INTO course_modules (subject_id, title, order_no, class_name, year_level, description, is_active) VALUES (?,?,?,?,?,?,?)'
  ).run(subject_id, title.trim(), order_no || 0, class_name || null, year_level || null, description || null, req.body.is_active ? 1 : 0);
  req.flash('success', 'Class Module / Topic / Year saved successfully.');
  res.redirect('/admin/material');
});

router.post('/material/module/:id/edit', (req, res) => {
  const { subject_id, class_name, year_level, title, description, order_no } = req.body;
  db.prepare(
    'UPDATE course_modules SET subject_id=?, title=?, order_no=?, class_name=?, year_level=?, description=?, is_active=? WHERE id=?'
  ).run(subject_id, (title || '').trim(), order_no || 0, class_name || null, year_level || null, description || null, req.body.is_active ? 1 : 0, req.params.id);
  req.flash('success', 'Class Module / Topic / Year updated.');
  res.redirect('/admin/material');
});

router.post('/material/module/:id/delete', (req, res) => {
  db.prepare('UPDATE study_materials SET module_id = NULL WHERE module_id = ?').run(req.params.id);
  db.prepare('DELETE FROM course_modules WHERE id = ?').run(req.params.id);
  req.flash('success', 'Module deleted (its lessons are now unassigned, not deleted).');
  res.redirect('/admin/material');
});

// ---------- Add / Edit Study Material ----------
function readMaterialFields(body) {
  const contentType = (body.content_type || 'pdf').toLowerCase();
  return {
    title: (body.title || '').trim(),
    subject_id: body.subject_id || null,
    module_id: body.module_id || null,
    year: body.year || null,
    content_type: contentType,
    file_url: contentType === 'link' ? (body.file_url || null) : null,
    notes: body.description || body.notes || '',
    order_no: parseInt(body.order_no, 10) || 0,
    is_published: body.status === 'draft' ? 0 : 1,
    allow_download: body.allow_download ? 1 : 0,
    allow_print: body.allow_print ? 1 : 0,
    allow_comments: body.allow_comments ? 1 : 0,
    is_featured: body.is_featured ? 1 : 0,
    tags: body.tags || '',
    access_type: body.accesstype || 'immediate',
    available_from: body.accesstype === 'scheduled' ? (body.available_date && body.available_time ? `${body.available_date} ${body.available_time}` : (body.available_date || null)) : null,
    due_date: body.due_date || null,
  };
}

router.get('/material/new', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const students = db.prepare("SELECT id, name, email, class_section, class_year FROM users WHERE role='student' ORDER BY name").all();
  res.render('admin/material_new', { subjects, students, material: null });
});

router.post('/material/new', privateUpload.fields([{ name: 'video_file', maxCount: 1 }, { name: 'pdf_file', maxCount: 1 }, { name: 'file', maxCount: 1 }]), (req, res) => {
  const f = readMaterialFields(req.body);
  if (!f.title) { req.flash('error', 'Title is required.'); return res.redirect('/admin/material/new'); }
  const videoFile = req.files && req.files.video_file && req.files.video_file[0];
  const pdfFile = req.files && req.files.pdf_file && req.files.pdf_file[0];
  const genericFile = req.files && req.files.file && req.files.file[0];
  const anyFile = videoFile || pdfFile || genericFile;

  const id = db.prepare(
    `INSERT INTO study_materials
     (title, subject_id, module_id, year, file_type, file_url, notes, order_no, content_type, video_path, pdf_path, file_path, file_size_bytes,
      is_published, allow_download, allow_print, allow_comments, is_featured, tags, access_type, available_from, due_date, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    f.title, f.subject_id, f.module_id, f.year, f.content_type, f.file_url, f.notes, f.order_no, f.content_type,
    videoFile ? videoFile.filename : null, pdfFile ? pdfFile.filename : null, genericFile ? genericFile.filename : null,
    anyFile ? anyFile.size : null,
    f.is_published, f.allow_download, f.allow_print, f.allow_comments, f.is_featured, f.tags, f.access_type, f.available_from, f.due_date,
    req.session.user.id
  ).lastInsertRowid;

  // Assign To: All Students | Specific Classes | Specific Students (expanded into
  // individual content_assignments rows, reusing the exact same table/columns
  // Tutorial assignment already uses — no duplicate assignment mechanism).
  const assignTo = req.body.assignto || 'none';
  let studentIds = [];
  let assignedSummary = null;
  if (assignTo === 'all') {
    studentIds = db.prepare("SELECT id FROM users WHERE role='student'").all().map((r) => r.id);
    assignedSummary = 'All Students';
  } else if (assignTo === 'classes' && req.body.class_names) {
    const classes = Array.isArray(req.body.class_names) ? req.body.class_names : [req.body.class_names];
    studentIds = db.prepare(`SELECT id FROM users WHERE role='student' AND class_section IN (${classes.map(() => '?').join(',')})`).all(...classes).map((r) => r.id);
    assignedSummary = classes.join(', ');
  } else if (assignTo === 'students' && req.body.student_ids) {
    studentIds = Array.isArray(req.body.student_ids) ? req.body.student_ids : [req.body.student_ids];
    const names = db.prepare(`SELECT name FROM users WHERE id IN (${studentIds.map(() => '?').join(',')})`).all(...studentIds).map((r) => r.name);
    assignedSummary = names.join(', ');
  }
  if (studentIds.length) {
    db.prepare('UPDATE study_materials SET assigned_summary = ? WHERE id = ?').run(assignedSummary, id);
    studentIds.forEach((uid) => {
      db.prepare(
        "INSERT OR IGNORE INTO content_assignments (user_id, content_type, content_id, amount, payment_method, assigned_by, status, due_date, instructions, access_type, allow_download) VALUES (?, 'study_material', ?, 0, 'manual', ?, 'assigned', ?, ?, ?, ?)"
      ).run(uid, id, req.session.user.id, f.due_date, req.body.custom_message || null, f.access_type, f.allow_download);
      if (req.body.notify !== 'no') {
        notify(uid, 'content_assignment', 'New Study Material Assigned', `"${f.title}" has been assigned to you.`, '/student/material', { relatedType: 'study_material', relatedId: Number(id), itemTitle: f.title, itemLabel: 'Study Material', dueDate: f.due_date, instructions: req.body.custom_message, createdBy: req.session.user.id });
      }
    });
  }

  logAction(req, 'study_material_created', { recordType: 'study_material', recordId: id, newValue: { title: f.title, content_type: f.content_type } });
  req.flash('success', 'Study material saved.');
  res.redirect('/admin/material');
});

router.get('/material/:id/edit', (req, res) => {
  const material = db.prepare('SELECT * FROM study_materials WHERE id = ?').get(req.params.id);
  if (!material) { req.flash('error', 'Study material not found'); return res.redirect('/admin/material'); }
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const students = db.prepare("SELECT id, name, email, class_section, class_year FROM users WHERE role='student' ORDER BY name").all();
  res.render('admin/material_new', { subjects, students, material });
});

router.post('/material/:id/edit', privateUpload.fields([{ name: 'video_file', maxCount: 1 }, { name: 'pdf_file', maxCount: 1 }, { name: 'file', maxCount: 1 }]), (req, res) => {
  const existing = db.prepare('SELECT * FROM study_materials WHERE id = ?').get(req.params.id);
  if (!existing) { req.flash('error', 'Study material not found'); return res.redirect('/admin/material'); }
  const f = readMaterialFields(req.body);
  const videoFile = req.files && req.files.video_file && req.files.video_file[0];
  const pdfFile = req.files && req.files.pdf_file && req.files.pdf_file[0];
  const genericFile = req.files && req.files.file && req.files.file[0];

  db.prepare(
    `UPDATE study_materials SET title=?, subject_id=?, module_id=?, year=?, content_type=?, file_type=?, file_url=?, notes=?, order_no=?,
       video_path=?, pdf_path=?, file_path=?, is_published=?, allow_download=?, allow_print=?, allow_comments=?, is_featured=?, tags=?,
       access_type=?, available_from=?, due_date=? WHERE id=?`
  ).run(
    f.title, f.subject_id, f.module_id, f.year, f.content_type, f.content_type, f.file_url, f.notes, f.order_no,
    videoFile ? videoFile.filename : existing.video_path, pdfFile ? pdfFile.filename : existing.pdf_path, genericFile ? genericFile.filename : existing.file_path,
    f.is_published, f.allow_download, f.allow_print, f.allow_comments, f.is_featured, f.tags,
    f.access_type, f.available_from, f.due_date, req.params.id
  );
  req.flash('success', 'Study material updated.');
  res.redirect('/admin/material');
});

router.post('/material/:id/woo-link', (req, res) => {
  db.prepare('UPDATE study_materials SET woo_product_id = ? WHERE id = ?').run(req.body.woo_product_id || null, req.params.id);
  req.flash('success', 'WooCommerce link updated.');
  res.redirect('/admin/material');
});

router.post('/material/:id/toggle', (req, res) => {
  const m = db.prepare('SELECT * FROM study_materials WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE study_materials SET is_published = ? WHERE id = ?').run(m.is_published ? 0 : 1, req.params.id);
  res.redirect('/admin/material');
});

router.post('/material/:id/delete', (req, res) => {
  const m = db.prepare('SELECT * FROM study_materials WHERE id = ?').get(req.params.id);
  if (m) {
    // Remove the actual files from private storage too, not just the DB row.
    [m.video_path, m.pdf_path, m.file_path].forEach((p) => {
      if (p) { try { fs.unlinkSync(path.join(__dirname, '../private/materials', p)); } catch (e) { /* already gone */ } }
    });
  }
  db.prepare('DELETE FROM study_materials WHERE id = ?').run(req.params.id);
  db.prepare("DELETE FROM content_assignments WHERE content_type='study_material' AND content_id=?").run(req.params.id);
  db.prepare('DELETE FROM study_material_comments WHERE material_id = ?').run(req.params.id);
  req.flash('success', 'Study material deleted');
  res.redirect('/admin/material');
});

// ---------- Assign Study Material to Students ----------
router.get('/material/:id/assign', (req, res) => {
  const material = db.prepare(
    `SELECT m.*, s.name AS subject_name, cm.title AS module_title FROM study_materials m
     LEFT JOIN subjects s ON s.id = m.subject_id LEFT JOIN course_modules cm ON cm.id = m.module_id WHERE m.id = ?`
  ).get(req.params.id);
  if (!material) { req.flash('error', 'Study material not found'); return res.redirect('/admin/material'); }
  material.fileMeta = materialFileMeta(material);
  const students = db.prepare("SELECT id, name, email, class_section, class_year FROM users WHERE role = 'student' ORDER BY name").all();
  const classes = [...new Set(students.map((s) => s.class_section).filter(Boolean))];
  const alreadyAssigned = new Set(
    db.prepare("SELECT user_id FROM content_assignments WHERE content_type='study_material' AND content_id=? AND status='assigned'")
      .all(req.params.id).map((r) => r.user_id)
  );
  res.render('admin/material_assign', { material, students, classes, alreadyAssigned });
});

router.post('/material/:id/assign', (req, res) => {
  const material = db.prepare('SELECT * FROM study_materials WHERE id = ?').get(req.params.id);
  if (!material) { req.flash('error', 'Study material not found'); return res.redirect('/admin/material'); }

  const assignTo = req.body.assignto || 'students';
  let studentIds = [];
  let assignedSummary = null;
  if (assignTo === 'all') {
    studentIds = db.prepare("SELECT id FROM users WHERE role='student'").all().map((r) => r.id);
    assignedSummary = 'All Students';
  } else if (assignTo === 'classes' && req.body.class_names) {
    const classes = Array.isArray(req.body.class_names) ? req.body.class_names : [req.body.class_names];
    studentIds = db.prepare(`SELECT id FROM users WHERE role='student' AND class_section IN (${classes.map(() => '?').join(',')})`).all(...classes).map((r) => r.id);
    assignedSummary = classes.join(', ');
  } else if (req.body.student_ids) {
    studentIds = Array.isArray(req.body.student_ids) ? req.body.student_ids : [req.body.student_ids];
    const names = db.prepare(`SELECT name FROM users WHERE id IN (${studentIds.map(() => '?').join(',')})`).all(...studentIds).map((r) => r.name);
    assignedSummary = names.join(', ');
  }
  if (!studentIds.length) { req.flash('error', 'Select at least one student, class or "All Students".'); return res.redirect(`/admin/material/${req.params.id}/assign`); }

  const accessType = req.body.accesstype || 'immediate';
  const dueDate = req.body.due_date || null;
  const allowDownload = req.body.allow_download ? 1 : (req.body.allow_download === undefined ? material.allow_download : 0);

  db.prepare('UPDATE study_materials SET assigned_summary = ? WHERE id = ?').run(assignedSummary, req.params.id);
  studentIds.forEach((uid) => {
    const existingRow = db.prepare("SELECT id FROM content_assignments WHERE user_id=? AND content_type='study_material' AND content_id=?").get(uid, req.params.id);
    if (existingRow) {
      db.prepare("UPDATE content_assignments SET status='assigned', assigned_by=?, due_date=?, instructions=?, access_type=?, allow_download=? WHERE id=?")
        .run(req.session.user.id, dueDate, req.body.custom_message || null, accessType, allowDownload, existingRow.id);
    } else {
      db.prepare(
        "INSERT INTO content_assignments (user_id, content_type, content_id, amount, payment_method, assigned_by, status, due_date, instructions, access_type, allow_download) VALUES (?, 'study_material', ?, 0, 'manual', ?, 'assigned', ?, ?, ?, ?)"
      ).run(uid, req.params.id, req.session.user.id, dueDate, req.body.custom_message || null, accessType, allowDownload);
    }
    if (req.body.notify !== 'no') {
      notify(uid, 'content_assignment', 'New Study Material Assigned', `"${material.title}" has been assigned to you.`, '/student/material', { relatedType: 'study_material', relatedId: material.id, itemTitle: material.title, itemLabel: 'Study Material', dueDate, instructions: req.body.custom_message, createdBy: req.session.user.id });
    }
  });

  req.flash('success', `Study material assigned to ${studentIds.length} student(s).`);
  res.redirect('/admin/material');
});

// ---------- Study Material comments (teacher side: view + reply) ----------
router.get('/material/:id/comments', (req, res) => {
  const material = db.prepare('SELECT * FROM study_materials WHERE id = ?').get(req.params.id);
  if (!material) { req.flash('error', 'Study material not found'); return res.redirect('/admin/material'); }
  const comments = db.prepare(
    `SELECT c.*, u.name AS user_name, u.role AS user_role FROM study_material_comments c
     JOIN users u ON u.id = c.user_id WHERE c.material_id = ? ORDER BY c.created_at`
  ).all(req.params.id);
  res.render('admin/material_comments', { material, comments });
});

router.post('/material/:id/comments/:commentId/reply', (req, res) => {
  const material = db.prepare('SELECT * FROM study_materials WHERE id = ?').get(req.params.id);
  const parent = db.prepare('SELECT * FROM study_material_comments WHERE id = ?').get(req.params.commentId);
  if (!material || !parent || !req.body.body) { return res.redirect(`/admin/material/${req.params.id}/comments`); }
  db.prepare('INSERT INTO study_material_comments (material_id, user_id, parent_id, body) VALUES (?,?,?,?)')
    .run(material.id, req.session.user.id, parent.id, req.body.body);
  notify(parent.user_id, 'material_comment_reply', 'Your question was answered', `Your teacher replied to your question on "${material.title}".`, `/student/material/${material.id}`, { relatedType: 'study_material', relatedId: material.id, itemTitle: material.title, createdBy: req.session.user.id });
  req.flash('success', 'Reply posted.');
  res.redirect(`/admin/material/${req.params.id}/comments`);
});

// ---------- Results Dashboard (published/graded results only) ----------
function buildResultsQuery(req) {
  const { subject_id, year, class_name, paper_id, student_id, date_from, date_to, q } = req.query;
  let sql = `SELECT s.*, a.id AS assignment_id, p.title, p.subject_id, p.year, p.class_name, p.passing_marks,
       sub.name AS subject_name, u.id AS student_id, u.name AS student_name, u.email
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN subjects sub ON sub.id = p.subject_id
     JOIN users u ON u.id = a.user_id
     WHERE s.status = 'published'`;
  const params = [];
  if (subject_id) { sql += ' AND p.subject_id = ?'; params.push(subject_id); }
  if (year) { sql += ' AND p.year = ?'; params.push(year); }
  if (class_name) { sql += ' AND p.class_name = ?'; params.push(class_name); }
  if (paper_id) { sql += ' AND p.id = ?'; params.push(paper_id); }
  if (student_id) { sql += ' AND u.id = ?'; params.push(student_id); }
  if (date_from) { sql += ' AND date(s.submitted_at) >= date(?)'; params.push(date_from); }
  if (date_to) { sql += ' AND date(s.submitted_at) <= date(?)'; params.push(date_to); }
  if (q) {
    sql += ' AND (u.name LIKE ? OR p.title LIKE ? OR sub.name LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY s.submitted_at DESC';
  return { sql, params };
}

function sendResultsCsv(req, res) {
  const { sql, params } = buildResultsQuery(req);
  const rows = db.prepare(sql).all(...params);
  const header = ['Student', 'Email', 'Exam Paper', 'Subject', 'Year', 'Class', 'MCQ', 'Written', 'Essay', 'Total', 'Max Marks', 'Percentage', 'Result', 'Submitted On'];
  const csvEscape = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [header.map(csvEscape).join(',')];
  rows.forEach((r) => {
    const pct = r.total_marks > 0 ? Math.round((r.total_score * 100) / r.total_marks) : 0;
    const passCutoff = r.passing_marks != null ? r.passing_marks : Math.round((r.total_marks || 0) * 0.4);
    const result = r.total_score >= passCutoff ? 'Pass' : 'Fail';
    lines.push([
      r.student_name, r.email, r.title, r.subject_name || '', r.year || '', r.class_name || '',
      `${r.mcq_score}/${r.mcq_total}`, `${r.written_score}/${r.written_total}`, `${r.essay_score}/${r.essay_total}`,
      r.total_score, r.total_marks, `${pct}%`, result, r.submitted_at,
    ].map(csvEscape).join(','));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
  res.send(lines.join('\n'));
}

router.get('/results/export', sendResultsCsv);

router.get('/results', (req, res) => {
  if (req.query.export === 'csv') return sendResultsCsv(req, res);

  const { sql, params } = buildResultsQuery(req);
  const allFiltered = db.prepare(sql).all(...params);

  // Derive percentage + pass/fail per row
  allFiltered.forEach((r) => {
    r.percentage = r.total_marks > 0 ? Math.round((r.total_score * 100) / r.total_marks) : 0;
    const passCutoff = r.passing_marks != null ? r.passing_marks : Math.round((r.total_marks || 0) * 0.4);
    r.passed = r.total_score >= passCutoff;
  });

  // ---- KPI cards (respect current filters) ----
  const totalSubmissions = allFiltered.length;
  const distinctStudentIds = new Set(allFiltered.map((r) => r.student_id));
  const totalStudents = distinctStudentIds.size;
  const avgScore = totalSubmissions ? Math.round(allFiltered.reduce((sum, r) => sum + r.percentage, 0) / totalSubmissions) : 0;
  let highest = null, lowest = null;
  allFiltered.forEach((r) => {
    if (!highest || r.percentage > highest.percentage) highest = r;
    if (!lowest || r.percentage < lowest.percentage) lowest = r;
  });
  const passedCount = allFiltered.filter((r) => r.passed).length;
  const passRate = totalSubmissions ? Math.round((passedCount * 100) / totalSubmissions) : 0;

  // ---- Overall performance by month (real submitted_at dates) ----
  const monthlyMap = {};
  allFiltered.forEach((r) => {
    if (!r.submitted_at) return;
    const key = String(r.submitted_at).slice(0, 7); // YYYY-MM
    if (!monthlyMap[key]) monthlyMap[key] = { sum: 0, count: 0 };
    monthlyMap[key].sum += r.percentage;
    monthlyMap[key].count += 1;
  });
  const monthKeys = Object.keys(monthlyMap).sort();
  const monthLabels = monthKeys.map((k) => {
    const [y, m] = k.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
  });
  const monthAverages = monthKeys.map((k) => Math.round(monthlyMap[k].sum / monthlyMap[k].count));

  // ---- Section-wise performance ----
  function sectionAvg(scoreKey, totalKey) {
    let scoreSum = 0, totalSum = 0;
    allFiltered.forEach((r) => { scoreSum += (r[scoreKey] || 0); totalSum += (r[totalKey] || 0); });
    return totalSum > 0 ? Math.round((scoreSum * 100) / totalSum) : 0;
  }
  const sectionA = { pct: sectionAvg('mcq_score', 'mcq_total'), score: allFiltered.reduce((s, r) => s + (r.mcq_score || 0), 0), total: allFiltered.reduce((s, r) => s + (r.mcq_total || 0), 0) };
  const sectionB = { pct: sectionAvg('written_score', 'written_total'), score: allFiltered.reduce((s, r) => s + (r.written_score || 0), 0), total: allFiltered.reduce((s, r) => s + (r.written_total || 0), 0) };
  const sectionC = { pct: sectionAvg('essay_score', 'essay_total'), score: allFiltered.reduce((s, r) => s + (r.essay_score || 0), 0), total: allFiltered.reduce((s, r) => s + (r.essay_total || 0), 0) };

  // ---- Score distribution buckets ----
  const buckets = [0, 0, 0, 0, 0]; // 0-20,21-40,41-60,61-80,81-100
  allFiltered.forEach((r) => {
    const p = r.percentage;
    const idx = p <= 20 ? 0 : p <= 40 ? 1 : p <= 60 ? 2 : p <= 80 ? 3 : 4;
    buckets[idx] += 1;
  });

  // ---- Subject-wise average ----
  const subjectMap = {};
  allFiltered.forEach((r) => {
    const name = r.subject_name || 'Unknown';
    if (!subjectMap[name]) subjectMap[name] = { sum: 0, count: 0 };
    subjectMap[name].sum += r.percentage;
    subjectMap[name].count += 1;
  });
  const subjectAverages = Object.keys(subjectMap).map((name) => ({ name, avg: Math.round(subjectMap[name].sum / subjectMap[name].count) })).sort((a, b) => b.avg - a.avg);

  // ---- Top performers ----
  const topPerformers = [...allFiltered].sort((a, b) => b.percentage - a.percentage).slice(0, 5);

  // ---- Tab filtering ----
  const tab = req.query.tab || 'all';
  let tableRows = allFiltered;
  let tabCounts = {
    all: allFiltered.length,
    sectionA: allFiltered.filter((r) => (r.mcq_total || 0) > 0).length,
    sectionB: allFiltered.filter((r) => (r.written_total || 0) > 0).length,
    sectionC: allFiltered.filter((r) => (r.essay_total || 0) > 0).length,
  };
  if (tab === 'sectionA') tableRows = allFiltered.filter((r) => (r.mcq_total || 0) > 0);
  else if (tab === 'sectionB') tableRows = allFiltered.filter((r) => (r.written_total || 0) > 0);
  else if (tab === 'sectionC') tableRows = allFiltered.filter((r) => (r.essay_total || 0) > 0);

  // "By Subject" / "By Class" grouping done in the view via a groupBy flag
  const groupBy = (tab === 'bySubject') ? 'subject' : (tab === 'byClass') ? 'class' : null;

  // ---- Pagination ----
  const pageSize = 20;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalRows = tableRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const pageSafe = Math.min(page, totalPages);
  const pagedRows = groupBy ? tableRows : tableRows.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

  // ---- Dropdown data ----
  const subjects = db.prepare('SELECT id, name, year FROM subjects ORDER BY name').all();
  const papers = db.prepare('SELECT id, title FROM exam_papers ORDER BY title').all();
  const students = db.prepare(
    `SELECT DISTINCT u.id, u.name FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN users u ON u.id = a.user_id
     WHERE s.status = 'published' ORDER BY u.name`
  ).all();

  res.render('admin/results', {
    filters: req.query,
    tab, groupBy,
    kpi: { totalStudents, totalSubmissions, avgScore, highest, lowest, passedCount, passRate },
    chart: { monthLabels, monthAverages },
    sectionA, sectionB, sectionC,
    buckets,
    subjectAverages,
    topPerformers,
    tabCounts,
    tableRows: pagedRows,
    allGroupedRows: tableRows,
    pagination: { page: pageSafe, totalPages, totalRows, pageSize },
    subjects, papers, students,
  });
});

// ---------- Reports & Analytics ----------

// Date-range presets used by the page's date selector. Resolves to a real
// [dateFrom, dateTo] window (inclusive, YYYY-MM-DD) applied to every
// date-driven query below, or [null, null] for "All Time".
function buildReportsRange(req) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  let range = req.query.range || 'this_month';
  let dateFrom = null, dateTo = null, label = 'This Month';
  if (range === 'this_month') {
    dateFrom = iso(new Date(now.getFullYear(), now.getMonth(), 1));
    dateTo = iso(now);
  } else if (range === 'last_month') {
    dateFrom = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    dateTo = iso(new Date(now.getFullYear(), now.getMonth(), 0));
    label = 'Last Month';
  } else if (range === 'last_3_months') {
    dateFrom = iso(new Date(now.getFullYear(), now.getMonth() - 2, 1));
    dateTo = iso(now);
    label = 'Last 3 Months';
  } else if (range === 'this_year') {
    dateFrom = iso(new Date(now.getFullYear(), 0, 1));
    dateTo = iso(now);
    label = 'This Year';
  } else {
    range = 'all_time';
    label = 'All Time';
  }
  return { range, dateFrom, dateTo, label };
}

function reportsDateClause(col, dateFrom, dateTo) {
  let c = '';
  const p = [];
  if (dateFrom) { c += ` AND date(${col}) >= date(?)`; p.push(dateFrom); }
  if (dateTo) { c += ` AND date(${col}) <= date(?)`; p.push(dateTo); }
  return { c, p };
}

function sendReportsCsv(req, res) {
  const { dateFrom, dateTo } = buildReportsRange(req);
  const df = reportsDateClause('s.submitted_at', dateFrom, dateTo);
  const rows = db.prepare(
    `SELECT u.name AS student_name, u.email, p.title, sub.name AS subject_name,
        s.total_score, s.total_marks, s.submitted_at
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN subjects sub ON sub.id = p.subject_id
     JOIN users u ON u.id = a.user_id
     WHERE s.status = 'published'${df.c}
     ORDER BY s.submitted_at DESC`
  ).all(...df.p);
  const header = ['Student', 'Email', 'Exam Paper', 'Subject', 'Score', 'Max Marks', 'Percentage', 'Submitted On'];
  const csvEscape = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [header.map(csvEscape).join(',')];
  rows.forEach((r) => {
    const pct = r.total_marks > 0 ? Math.round((r.total_score * 100) / r.total_marks) : 0;
    lines.push([
      r.student_name, r.email, r.title, r.subject_name || '', r.total_score, r.total_marks, `${pct}%`, r.submitted_at,
    ].map(csvEscape).join(','));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="reports-analytics.csv"');
  res.send(lines.join('\n'));
}

router.get('/reports/export', sendReportsCsv);

router.get('/reports', (req, res) => {
  if (req.query.export === 'csv') return sendReportsCsv(req, res);

  const { range, dateFrom, dateTo, label } = buildReportsRange(req);

  // Helper: % change, or null when there's no real "previous" baseline to compare to
  // (the mockup's "vs last month" deltas are only shown when we can compute them for real).
  const pctDelta = (cur, prev) => {
    if (!prev) return null;
    return Math.round(((cur - prev) / prev) * 100);
  };
  const now = new Date();
  const isoD = (d) => d.toISOString().slice(0, 10);
  const thisMonthStart = isoD(new Date(now.getFullYear(), now.getMonth(), 1));
  const lastMonthStart = isoD(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastMonthEnd = isoD(new Date(now.getFullYear(), now.getMonth(), 0));

  // ================= Exam submissions in range (real, adapted from buildResultsQuery) =================
  const subDF = reportsDateClause('s.submitted_at', dateFrom, dateTo);
  const examRows = db.prepare(
    `SELECT s.id, s.total_score, s.total_marks, s.submitted_at,
        p.id AS paper_id, p.title AS paper_title, p.passing_marks,
        sub.id AS subject_id, sub.name AS subject_name,
        u.id AS student_id, u.name AS student_name, u.class_year, u.class_section
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN subjects sub ON sub.id = p.subject_id
     JOIN users u ON u.id = a.user_id
     WHERE s.status = 'published'${subDF.c}
     ORDER BY s.submitted_at DESC`
  ).all(...subDF.p);
  examRows.forEach((r) => {
    r.percentage = r.total_marks > 0 ? Math.round((r.total_score * 100) / r.total_marks) : 0;
    const passCutoff = r.passing_marks != null ? r.passing_marks : Math.round((r.total_marks || 0) * 0.4);
    r.passed = r.total_score >= passCutoff;
  });

  // ================= MCQ activity in range (real: mcq_assignment_questions is the only
  // populated attempt log — the legacy mcq_attempts table is unused everywhere else in
  // this app, so it is intentionally left out here too) =================
  const mcqDF = reportsDateClause('aq.answered_at', dateFrom, dateTo);
  const mcqRows = db.prepare(
    `SELECT aq.id, aq.is_correct, aq.answered_at, m.subject_id, sub.name AS subject_name, ma.user_id AS student_id
     FROM mcq_assignment_questions aq
     JOIN mcq_assignments ma ON ma.id = aq.assignment_id
     JOIN mcqs m ON m.id = aq.mcq_id
     LEFT JOIN subjects sub ON sub.id = m.subject_id
     WHERE aq.answered_at IS NOT NULL${mcqDF.c}`
  ).all(...mcqDF.p);

  // ================= KPI 1: Total Students (+ real MoM registration growth) =================
  const totalStudents = db.prepare("SELECT COUNT(*) c FROM users WHERE role='student'").get().c;
  const studentsThisMonth = db.prepare("SELECT COUNT(*) c FROM users WHERE role='student' AND date(created_at) >= date(?)").get(thisMonthStart).c;
  const studentsLastMonth = db.prepare("SELECT COUNT(*) c FROM users WHERE role='student' AND date(created_at) >= date(?) AND date(created_at) <= date(?)").get(lastMonthStart, lastMonthEnd).c;
  const studentsDelta = pctDelta(studentsThisMonth, studentsLastMonth);

  // ================= KPI 2: Active Students — distinct students with any real activity
  // (exam submission, MCQ answer, or a content assignment) in the last 30 days =================
  const activeStudentsRow = db.prepare(
    `SELECT COUNT(*) c FROM (
       SELECT a.user_id AS uid FROM exam_submissions s JOIN exam_assignments a ON a.id = s.assignment_id
         WHERE s.submitted_at IS NOT NULL AND date(s.submitted_at) >= date('now', '-30 days')
       UNION
       SELECT ma.user_id AS uid FROM mcq_assignment_questions aq JOIN mcq_assignments ma ON ma.id = aq.assignment_id
         WHERE aq.answered_at IS NOT NULL AND date(aq.answered_at) >= date('now', '-30 days')
       UNION
       SELECT ca.user_id AS uid FROM content_assignments ca
         WHERE date(ca.assigned_at) >= date('now', '-30 days')
     )`
  ).get();
  const activeStudentsPrevRow = db.prepare(
    `SELECT COUNT(*) c FROM (
       SELECT a.user_id AS uid FROM exam_submissions s JOIN exam_assignments a ON a.id = s.assignment_id
         WHERE s.submitted_at IS NOT NULL AND date(s.submitted_at) >= date('now', '-60 days') AND date(s.submitted_at) < date('now', '-30 days')
       UNION
       SELECT ma.user_id AS uid FROM mcq_assignment_questions aq JOIN mcq_assignments ma ON ma.id = aq.assignment_id
         WHERE aq.answered_at IS NOT NULL AND date(aq.answered_at) >= date('now', '-60 days') AND date(aq.answered_at) < date('now', '-30 days')
       UNION
       SELECT ca.user_id AS uid FROM content_assignments ca
         WHERE date(ca.assigned_at) >= date('now', '-60 days') AND date(ca.assigned_at) < date('now', '-30 days')
     )`
  ).get();
  const activeStudents = activeStudentsRow.c;
  const activeStudentsDelta = pctDelta(activeStudents, activeStudentsPrevRow.c);

  // ================= KPI 3: Total MCQs Attempted (range-filtered) + real MoM delta =================
  const mcqAttemptedTotal = mcqRows.length;
  const mcqThisMonth = db.prepare("SELECT COUNT(*) c FROM mcq_assignment_questions WHERE answered_at IS NOT NULL AND date(answered_at) >= date(?)").get(thisMonthStart).c;
  const mcqLastMonth = db.prepare("SELECT COUNT(*) c FROM mcq_assignment_questions WHERE answered_at IS NOT NULL AND date(answered_at) >= date(?) AND date(answered_at) <= date(?)").get(lastMonthStart, lastMonthEnd).c;
  const mcqDelta = pctDelta(mcqThisMonth, mcqLastMonth);

  // ================= KPI 4: Average Score (range-filtered, same calc style as /admin/results) =================
  const avgScore = examRows.length ? Math.round(examRows.reduce((sum, r) => sum + r.percentage, 0) / examRows.length) : 0;
  const avgThisMonthRow = db.prepare(
    `SELECT AVG(CASE WHEN s.total_marks > 0 THEN (s.total_score * 100.0 / s.total_marks) ELSE NULL END) a
     FROM exam_submissions s WHERE s.status='published' AND date(s.submitted_at) >= date(?)`
  ).get(thisMonthStart);
  const avgLastMonthRow = db.prepare(
    `SELECT AVG(CASE WHEN s.total_marks > 0 THEN (s.total_score * 100.0 / s.total_marks) ELSE NULL END) a
     FROM exam_submissions s WHERE s.status='published' AND date(s.submitted_at) >= date(?) AND date(s.submitted_at) <= date(?)`
  ).get(lastMonthStart, lastMonthEnd);
  const avgScoreDelta = (avgThisMonthRow.a != null && avgLastMonthRow.a != null)
    ? Math.round(avgThisMonthRow.a) - Math.round(avgLastMonthRow.a) : null;

  // ================= KPI 5: Assignments Completed (range-filtered: completed MCQ
  // assignments + reviewed exam assignments) =================
  const mcqDF2 = reportsDateClause('completed_at', dateFrom, dateTo);
  const mcqCompleted = db.prepare(`SELECT COUNT(*) c FROM mcq_assignments WHERE status='completed'${mcqDF2.c}`).get(...mcqDF2.p).c;
  const examDF2 = reportsDateClause('s.submitted_at', dateFrom, dateTo);
  const examReviewed = db.prepare(
    `SELECT COUNT(*) c FROM exam_assignments a JOIN exam_submissions s ON s.assignment_id = a.id
     WHERE a.status='reviewed'${examDF2.c}`
  ).get(...examDF2.p).c;
  const assignmentsCompleted = mcqCompleted + examReviewed;
  const mcqCompletedLastMonth = db.prepare("SELECT COUNT(*) c FROM mcq_assignments WHERE status='completed' AND date(completed_at) >= date(?) AND date(completed_at) <= date(?)").get(lastMonthStart, lastMonthEnd).c;
  const mcqCompletedThisMonth = db.prepare("SELECT COUNT(*) c FROM mcq_assignments WHERE status='completed' AND date(completed_at) >= date(?)").get(thisMonthStart).c;
  const assignmentsDelta = pctDelta(mcqCompletedThisMonth, mcqCompletedLastMonth);

  // ================= KPI 6: Full Exam Submissions (range-filtered count, real submitted rows) =================
  const fullExamSubmissions = examRows.length;
  const examThisMonth = db.prepare("SELECT COUNT(*) c FROM exam_submissions WHERE status='published' AND date(submitted_at) >= date(?)").get(thisMonthStart).c;
  const examLastMonth = db.prepare("SELECT COUNT(*) c FROM exam_submissions WHERE status='published' AND date(submitted_at) >= date(?) AND date(submitted_at) <= date(?)").get(lastMonthStart, lastMonthEnd).c;
  const examDelta = pctDelta(examThisMonth, examLastMonth);

  const kpi = {
    totalStudents, studentsDelta,
    activeStudents, activeStudentsDelta,
    mcqAttemptedTotal, mcqDelta,
    avgScore, avgScoreDelta,
    assignmentsCompleted, assignmentsDelta,
    fullExamSubmissions, examDelta,
  };

  // ================= Performance Overview: monthly avg score + attempted MCQs (real dates) =================
  const monthlyScore = {};
  examRows.forEach((r) => {
    if (!r.submitted_at) return;
    const key = String(r.submitted_at).slice(0, 7);
    if (!monthlyScore[key]) monthlyScore[key] = { sum: 0, count: 0 };
    monthlyScore[key].sum += r.percentage;
    monthlyScore[key].count += 1;
  });
  const monthlyMcq = {};
  mcqRows.forEach((r) => {
    if (!r.answered_at) return;
    const key = String(r.answered_at).slice(0, 7);
    monthlyMcq[key] = (monthlyMcq[key] || 0) + 1;
  });
  const monthKeySet = new Set([...Object.keys(monthlyScore), ...Object.keys(monthlyMcq)]);
  const monthKeys = [...monthKeySet].sort();
  const monthLabels = monthKeys.map((k) => {
    const [y, m] = k.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-AU', { month: 'short' });
  });
  const monthAvgScores = monthKeys.map((k) => (monthlyScore[k] ? Math.round(monthlyScore[k].sum / monthlyScore[k].count) : 0));
  const monthMcqCounts = monthKeys.map((k) => monthlyMcq[k] || 0);

  // ================= Subject-wise Performance: avg score + attempted MCQs per subject =================
  const subjectScoreMap = {};
  examRows.forEach((r) => {
    const name = r.subject_name || 'Unknown';
    if (!subjectScoreMap[name]) subjectScoreMap[name] = { sum: 0, count: 0 };
    subjectScoreMap[name].sum += r.percentage;
    subjectScoreMap[name].count += 1;
  });
  const subjectMcqMap = {};
  mcqRows.forEach((r) => {
    const name = r.subject_name || 'Unknown';
    subjectMcqMap[name] = (subjectMcqMap[name] || 0) + 1;
  });
  const subjectNameSet = new Set([...Object.keys(subjectScoreMap), ...Object.keys(subjectMcqMap)]);
  const subjectAverages = [...subjectNameSet].map((name) => ({
    name,
    avg: subjectScoreMap[name] ? Math.round(subjectScoreMap[name].sum / subjectScoreMap[name].count) : 0,
    mcqCount: subjectMcqMap[name] || 0,
  })).sort((a, b) => b.avg - a.avg);

  // ================= Score Distribution buckets (real substitute for "Question Type
  // Performance" — the mcqs/exam_paper_questions schema has no question-type breakdown
  // the app actually captures per-attempt, so we reuse /admin/results' real buckets logic
  // in the same donut-chart visual slot) =================
  const buckets = [0, 0, 0, 0, 0]; // 0-20,21-40,41-60,61-80,81-100
  examRows.forEach((r) => {
    const p = r.percentage;
    const idx = p <= 20 ? 0 : p <= 40 ? 1 : p <= 60 ? 2 : p <= 80 ? 3 : 4;
    buckets[idx] += 1;
  });
  const bucketLabels = ['0-20%', '21-40%', '41-60%', '61-80%', '81-100%'];

  // ================= Top Performing Students (real top-5 by avg score in range) =================
  const studentAgg = {};
  examRows.forEach((r) => {
    if (!studentAgg[r.student_id]) {
      studentAgg[r.student_id] = { id: r.student_id, name: r.student_name, class_year: r.class_year, class_section: r.class_section, sum: 0, count: 0 };
    }
    studentAgg[r.student_id].sum += r.percentage;
    studentAgg[r.student_id].count += 1;
  });
  const mcqCountByStudent = {};
  mcqRows.forEach((r) => { mcqCountByStudent[r.student_id] = (mcqCountByStudent[r.student_id] || 0) + 1; });
  const topPerformers = Object.values(studentAgg)
    .map((s) => ({
      id: s.id, name: s.name,
      classLabel: [s.class_year, s.class_section].filter(Boolean).join(' ') || '—',
      avg: Math.round(s.sum / s.count),
      mcqCount: mcqCountByStudent[s.id] || 0,
    }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);

  // ================= Performance by Year Level (real GROUP BY on users.class_year) =================
  const yearAgg = {};
  examRows.forEach((r) => {
    const yr = r.class_year || 'Unspecified';
    if (!yearAgg[yr]) yearAgg[yr] = { sum: 0, count: 0, students: new Set() };
    yearAgg[yr].sum += r.percentage;
    yearAgg[yr].count += 1;
    yearAgg[yr].students.add(r.student_id);
  });
  const byYearLevel = Object.keys(yearAgg).sort().map((yr) => ({
    year: yr,
    studentCount: yearAgg[yr].students.size,
    avg: Math.round(yearAgg[yr].sum / yearAgg[yr].count),
  }));

  // ================= Content Usage (real access counts) =================
  // MCQ Practice: real attempts + distinct students from mcq_assignment_questions (range-filtered).
  const mcqPracticeUnique = new Set(mcqRows.map((r) => r.student_id)).size;
  // Tutorial Videos: tutorials.views is a real per-view counter (incremented in student.js);
  // Unique Students proxied by distinct students with a tutorial content_assignment (no per-view user log exists).
  const tutorialViews = db.prepare('SELECT COALESCE(SUM(views),0) c FROM tutorials').get().c;
  const tutorialUnique = db.prepare("SELECT COUNT(DISTINCT user_id) c FROM content_assignments WHERE content_type='tutorial'").get().c;
  // Study Materials: same pattern — study_materials.views is a real counter.
  const materialViews = db.prepare('SELECT COALESCE(SUM(views),0) c FROM study_materials').get().c;
  const materialUnique = db.prepare("SELECT COUNT(DISTINCT user_id) c FROM content_assignments WHERE content_type='study_material'").get().c;
  // Full Exam Papers: real order + assignment counts.
  const paperOrders = db.prepare('SELECT COUNT(*) c FROM exam_orders').get().c;
  const paperUnique = db.prepare('SELECT COUNT(DISTINCT user_id) c FROM exam_orders').get().c;
  const contentUsage = [
    { type: 'MCQ Practice', icon: 'fa-regular fa-file-lines', color: 'text-blue-600', totalAccess: mcqAttemptedTotal, uniqueStudents: mcqPracticeUnique },
    { type: 'Tutorial Videos', icon: 'fa-regular fa-circle-play', color: 'text-rose-500', totalAccess: tutorialViews, uniqueStudents: tutorialUnique },
    { type: 'Study Materials', icon: 'fa-regular fa-folder-open', color: 'text-emerald-600', totalAccess: materialViews, uniqueStudents: materialUnique },
    { type: 'Full Exam Papers', icon: 'fa-solid fa-file-signature', color: 'text-purple-600', totalAccess: paperOrders, uniqueStudents: paperUnique },
  ];

  // ================= Recent Results (real latest rows: MCQ assignment completions + exam submissions) =================
  const recentExam = examRows.slice(0, 10).map((r) => ({
    student: r.student_name, type: 'Exam', subject: r.subject_name || '—', score: r.percentage, date: r.submitted_at,
  }));
  const recentMcqRows = db.prepare(
    `SELECT ma.completed_at, u.name AS student_name, sub.name AS subject_name,
        (SELECT COUNT(*) FROM mcq_assignment_questions WHERE assignment_id = ma.id) AS total_q,
        (SELECT COUNT(*) FROM mcq_assignment_questions WHERE assignment_id = ma.id AND is_correct = 1) AS correct_q
     FROM mcq_assignments ma
     JOIN users u ON u.id = ma.user_id
     LEFT JOIN subjects sub ON sub.id = ma.subject_id
     WHERE ma.status = 'completed'
     ORDER BY ma.completed_at DESC LIMIT 10`
  ).all();
  const recentMcq = recentMcqRows.map((r) => ({
    student: r.student_name, type: 'MCQ', subject: r.subject_name || '—',
    score: r.total_q > 0 ? Math.round((r.correct_q * 100) / r.total_q) : 0,
    date: r.completed_at,
  }));
  const recentResults = [...recentExam, ...recentMcq]
    .filter((r) => r.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10);

  // ================= Exam Paper Performance (real per-paper aggregation, range-filtered) =================
  const paperAgg = {};
  examRows.forEach((r) => {
    if (!paperAgg[r.paper_id]) paperAgg[r.paper_id] = { title: r.paper_title, count: 0, sum: 0, passed: 0 };
    paperAgg[r.paper_id].count += 1;
    paperAgg[r.paper_id].sum += r.percentage;
    if (r.passed) paperAgg[r.paper_id].passed += 1;
  });
  const paperPerformance = Object.values(paperAgg).map((p) => ({
    title: p.title,
    submissions: p.count,
    avgScore: Math.round(p.sum / p.count),
    passRate: Math.round((p.passed * 100) / p.count),
  })).sort((a, b) => b.submissions - a.submissions).slice(0, 6);

  // ================= Quick Insights (only real, computable ones — nothing invented) =================
  const insights = [];
  if (kpi.mcqDelta != null) {
    insights.push({ color: 'blue', icon: 'fa-chart-line', value: `${kpi.mcqDelta >= 0 ? '+' : ''}${kpi.mcqDelta}%`, text: 'Change in MCQ attempts vs last month' });
  }
  insights.push({ color: 'rose', icon: 'fa-bullseye', value: `${avgScore}%`, text: 'Overall average score across all subjects in range' });
  if (subjectAverages.length) {
    const best = subjectAverages[0];
    insights.push({ color: 'amber', icon: 'fa-trophy', value: best.name, text: `Highest performing subject (${best.avg}% average score)` });
  }
  if (subjectAverages.length > 1) {
    const worst = subjectAverages[subjectAverages.length - 1];
    insights.push({ color: 'purple', icon: 'fa-arrow-trend-up', value: worst.name, text: `Needs attention (${worst.avg}% average score)` });
  }

  res.render('admin/reports', {
    range, dateFrom, dateTo, rangeLabel: label,
    kpi,
    chart: { monthLabels, monthAvgScores, monthMcqCounts },
    subjectAverages,
    buckets, bucketLabels,
    topPerformers,
    byYearLevel,
    contentUsage,
    recentResults,
    paperPerformance,
    insights,
  });
});

// ---------- Subjects ----------
const SUBJECT_ICONS = {
  economics: '📊', mathematics: '➗', maths: '➗', biology: '🧬', chemistry: '🧪',
  physics: '⚛️', english: '📖', history: '🏛️', geography: '🌍', 'visual arts': '🎨',
  art: '🎨', 'information technology': '💻', it: '💻',
};
function subjectIcon(name) {
  return SUBJECT_ICONS[name.toLowerCase()] || '📚';
}

// Subjects are stored one row per (name, year) — e.g. "Economics"/"Year 11"
// and "Economics"/"Year 12" are two separate rows, because papers/MCQs/
// tutorials/study material each link to one specific subject_id. All the
// "subject-level" fields below (description, icon, curriculum, active,
// featured, comments, order, tags, content-type toggles) are duplicated
// across those rows so every year-row carries the same values — the pages
// group them back together by NAME so "Economics" shows as ONE row
// spanning Y11–Y12, with totals summed across both underlying rows.
function groupSubjects(rows) {
  const groups = {};
  rows.forEach((r) => {
    if (!groups[r.name]) {
      groups[r.name] = {
        name: r.name, ids: [], years: [], description: r.description || '', is_active: 0,
        icon_url: r.icon_url || '', curriculum: r.curriculum || 'au-11-12', is_featured: 0,
        allow_comments: 0, order_no: r.order_no || 1, tags: r.tags || '',
        enable_mcq: 0, enable_tutorials: 0, enable_material: 0, enable_exams: 0,
      };
    }
    const g = groups[r.name];
    g.ids.push(r.id);
    g.years.push(r.year);
    if (r.description) g.description = r.description;
    if (r.icon_url) g.icon_url = r.icon_url;
    if (r.is_active) g.is_active = 1;
    if (r.is_featured) g.is_featured = 1;
    if (r.allow_comments) g.allow_comments = 1;
    if (r.enable_mcq) g.enable_mcq = 1;
    if (r.enable_tutorials) g.enable_tutorials = 1;
    if (r.enable_material) g.enable_material = 1;
    if (r.enable_exams) g.enable_exams = 1;
  });
  return Object.values(groups);
}

router.get('/subjects', (req, res) => {
  const { q, year, status, sort } = req.query;

  let rows = db.prepare('SELECT * FROM subjects ORDER BY name, year').all();

  let subjects = groupSubjects(rows).map((g) => {
    const idList = g.ids.join(',');
    const tutorials = db.prepare(`SELECT COUNT(*) c FROM tutorials WHERE subject_id IN (${idList})`).get().c;
    const materials = db.prepare(`SELECT COUNT(*) c FROM study_materials WHERE subject_id IN (${idList})`).get().c;
    const mcqs = db.prepare(`SELECT COUNT(*) c FROM mcqs WHERE subject_id IN (${idList})`).get().c;
    const papers = db.prepare(`SELECT COUNT(*) c FROM exam_papers WHERE subject_id IN (${idList})`).get().c;
    const yearsSorted = [...new Set(g.years)].sort();
    const yearLabel = yearsSorted.length > 1 ? `${yearsSorted[0].replace('Year ', 'Y')} – ${yearsSorted[yearsSorted.length - 1].replace('Year ', 'Y')}` : yearsSorted[0];
    return { ...g, tutorials, materials, mcqs, papers, total: tutorials + materials + mcqs, yearLabel, icon: subjectIcon(g.name) };
  });

  if (q) subjects = subjects.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()) || (s.description || '').toLowerCase().includes(q.toLowerCase()) || s.yearLabel.toLowerCase().includes(q.toLowerCase()));
  if (year) subjects = subjects.filter((s) => s.years.includes(year));
  if (status === 'active') subjects = subjects.filter((s) => s.is_active);
  if (status === 'inactive') subjects = subjects.filter((s) => !s.is_active);
  if (sort === 'name_desc') subjects.sort((a, b) => b.name.localeCompare(a.name));
  else if (sort === 'newest') subjects.sort((a, b) => Math.max(...b.ids) - Math.max(...a.ids));
  else if (sort === 'content') subjects.sort((a, b) => b.total - a.total);
  else if (sort === 'order') subjects.sort((a, b) => a.order_no - b.order_no);
  else subjects.sort((a, b) => a.name.localeCompare(b.name));

  const allGrouped = groupSubjects(db.prepare('SELECT * FROM subjects').all());
  const stats = {
    total: allGrouped.length,
    active: allGrouped.filter((s) => s.is_active).length,
    inactive: allGrouped.filter((s) => !s.is_active).length,
    totalContent: allGrouped.reduce((sum, g) => {
      const idList = g.ids.join(',');
      const t = db.prepare(`SELECT COUNT(*) c FROM tutorials WHERE subject_id IN (${idList})`).get().c;
      const m = db.prepare(`SELECT COUNT(*) c FROM study_materials WHERE subject_id IN (${idList})`).get().c;
      const mq = db.prepare(`SELECT COUNT(*) c FROM mcqs WHERE subject_id IN (${idList})`).get().c;
      return sum + t + m + mq;
    }, 0),
  };

  // Pagination (matches the uploaded "All Subjects" mockup: Show N per page)
  const perPage = parseInt(req.query.per_page, 10) || 10;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(subjects.length / perPage));
  const pageSubjects = subjects.slice((page - 1) * perPage, page * perPage);

  res.render('admin/subjects', {
    subjects: pageSubjects, allCount: subjects.length, stats, page, perPage, totalPages,
    filters: { q: q || '', year: year || '', status: status || '', sort: sort || 'name' },
  });
});

function readSubjectFields(body) {
  return {
    description: body.description || '',
    icon_url: null, // set separately when a file is uploaded
    curriculum: body.curriculum || '',
    is_active: body.is_active ? 1 : 0,
    is_featured: body.is_featured ? 1 : 0,
    allow_comments: body.allow_comments ? 1 : 0,
    order_no: parseInt(body.order_no, 10) || 1,
    tags: body.tags || '',
    enable_mcq: body.enable_mcq ? 1 : 0,
    enable_tutorials: body.enable_tutorials ? 1 : 0,
    enable_material: body.enable_material ? 1 : 0,
    enable_exams: body.enable_exams ? 1 : 0,
  };
}

// Resolves the checked Class & Year Level checkboxes (from the dynamic
// /admin/class-year-levels table) into { years, curriculum } for a subject.
// Each class_year_levels row can itself hold several comma-separated years
// (e.g. "Year 11, Year 12"), so those are split out into individual year rows.
function resolveClassYearSelection(body) {
  const ids = Array.isArray(body.class_year_ids) ? body.class_year_ids : (body.class_year_ids ? [body.class_year_ids] : []);
  const rows = ids.map((id) => db.prepare('SELECT * FROM class_year_levels WHERE id = ?').get(id)).filter(Boolean);
  if (!rows.length) return { years: ['Year 11', 'Year 12'], curriculum: '' };
  const curriculum = [...new Set(rows.map((r) => r.curriculum))].join(', ');
  const years = [...new Set(rows.flatMap((r) => r.year_level.split(',').map((y) => y.trim()).filter(Boolean)))];
  return { years: years.length ? years : ['Year 11', 'Year 12'], curriculum };
}

router.get('/subjects/new', (req, res) => {
  const classYearLevels = db.prepare("SELECT * FROM class_year_levels WHERE status = 'Active' ORDER BY id").all();
  res.render('admin/subject_new', { subject: null, classYearLevels });
});

router.post('/subjects/new', subjectIconUpload.single('icon'), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) { req.flash('error', 'Subject name is required.'); return res.redirect('/admin/subjects/new'); }
  const f = readSubjectFields(req.body);
  if (req.file) f.icon_url = `/uploads/${req.file.filename}`;
  const { years, curriculum } = resolveClassYearSelection(req.body);
  f.curriculum = curriculum;

  years.forEach((year) => {
    db.prepare(
      `INSERT INTO subjects (name, year, description, icon_url, curriculum, is_active, is_featured, allow_comments, order_no, tags, enable_mcq, enable_tutorials, enable_material, enable_exams)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(name.trim(), year, f.description, f.icon_url, f.curriculum, f.is_active, f.is_featured, f.allow_comments, f.order_no, f.tags, f.enable_mcq, f.enable_tutorials, f.enable_material, f.enable_exams);
  });

  req.flash('success', `Subject "${name}" created for ${years.join(' and ')}.`);
  res.redirect('/admin/subjects');
});

router.get('/subjects/:name/edit', (req, res) => {
  const rows = db.prepare('SELECT * FROM subjects WHERE name = ? ORDER BY year').all(req.params.name);
  if (!rows.length) { req.flash('error', 'Subject not found'); return res.redirect('/admin/subjects'); }
  const g = groupSubjects(rows)[0];
  const idList = g.ids.join(',');
  g.tutorials = db.prepare(`SELECT COUNT(*) c FROM tutorials WHERE subject_id IN (${idList})`).get().c;
  g.materials = db.prepare(`SELECT COUNT(*) c FROM study_materials WHERE subject_id IN (${idList})`).get().c;
  g.mcqs = db.prepare(`SELECT COUNT(*) c FROM mcqs WHERE subject_id IN (${idList})`).get().c;
  g.papers = db.prepare(`SELECT COUNT(*) c FROM exam_papers WHERE subject_id IN (${idList})`).get().c;
  const classYearLevels = db.prepare("SELECT * FROM class_year_levels WHERE status = 'Active' ORDER BY id").all();
  res.render('admin/subject_new', { subject: g, classYearLevels });
});

router.post('/subjects/:name/edit', subjectIconUpload.single('icon'), (req, res) => {
  const oldName = req.params.name;
  const newName = (req.body.name || oldName).trim();
  const f = readSubjectFields(req.body);
  const { years, curriculum } = resolveClassYearSelection(req.body);
  f.curriculum = curriculum;

  const existingRows = db.prepare('SELECT * FROM subjects WHERE name = ?').all(oldName);
  if (!existingRows.length) { req.flash('error', 'Subject not found'); return res.redirect('/admin/subjects'); }
  const iconUrl = req.file ? `/uploads/${req.file.filename}` : (f.icon_url || existingRows[0].icon_url || null);

  years.forEach((year) => {
    const row = existingRows.find((r) => r.year === year);
    if (row) {
      db.prepare(
        `UPDATE subjects SET name=?, description=?, icon_url=?, curriculum=?, is_active=?, is_featured=?, allow_comments=?, order_no=?, tags=?, enable_mcq=?, enable_tutorials=?, enable_material=?, enable_exams=? WHERE id=?`
      ).run(newName, f.description, iconUrl, f.curriculum, f.is_active, f.is_featured, f.allow_comments, f.order_no, f.tags, f.enable_mcq, f.enable_tutorials, f.enable_material, f.enable_exams, row.id);
    } else {
      // Year level was newly checked — add a row for it (no data loss on existing years).
      db.prepare(
        `INSERT INTO subjects (name, year, description, icon_url, curriculum, is_active, is_featured, allow_comments, order_no, tags, enable_mcq, enable_tutorials, enable_material, enable_exams)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(newName, year, f.description, iconUrl, f.curriculum, f.is_active, f.is_featured, f.allow_comments, f.order_no, f.tags, f.enable_mcq, f.enable_tutorials, f.enable_material, f.enable_exams);
    }
  });
  // A year that was unchecked is left in place (never delete content-linked rows implicitly);
  // it just won't show as selected in the Year Level checkboxes next time this is edited.

  req.flash('success', `Subject "${newName}" updated.`);
  res.redirect('/admin/subjects');
});

router.get('/subjects/:name/view', (req, res) => {
  res.redirect(`/admin/subjects/${encodeURIComponent(req.params.name)}/edit`);
});

router.post('/subjects/:name/delete', (req, res) => {
  const rows = db.prepare('SELECT * FROM subjects WHERE name = ?').all(req.params.name);
  const ids = rows.map((r) => r.id);
  const inUse = ids.some((id) => (
    db.prepare('SELECT COUNT(*) c FROM tutorials WHERE subject_id = ?').get(id).c
    || db.prepare('SELECT COUNT(*) c FROM study_materials WHERE subject_id = ?').get(id).c
    || db.prepare('SELECT COUNT(*) c FROM mcqs WHERE subject_id = ?').get(id).c
    || db.prepare('SELECT COUNT(*) c FROM exam_papers WHERE subject_id = ?').get(id).c
  ));
  if (inUse) {
    req.flash('error', `Cannot delete "${req.params.name}" — it still has tutorials, study material, MCQs or exam papers. Mark it Inactive instead.`);
    return res.redirect('/admin/subjects');
  }
  db.prepare('DELETE FROM subjects WHERE name = ?').run(req.params.name);
  req.flash('success', `Subject "${req.params.name}" deleted.`);
  res.redirect('/admin/subjects');
});

// ---------- Class & Year Level (dynamic curricula, feeds Add Subject checkboxes) ----------
router.get('/class-year-levels', (req, res) => {
  const items = db.prepare('SELECT * FROM class_year_levels ORDER BY id').all();
  res.render('admin/class_year_levels', { items });
});

router.post('/class-year-levels/new', (req, res) => {
  const curriculum = (req.body.curriculum || '').trim();
  const yearLevel = (req.body.year_level || '').trim();
  if (!curriculum || !yearLevel) {
    req.flash('error', 'Please fill in both the Class/Curriculum and Year Level fields.');
    return res.redirect('/admin/class-year-levels');
  }
  db.prepare('INSERT INTO class_year_levels (curriculum, year_level, status) VALUES (?,?,?)').run(curriculum, yearLevel, 'Active');
  req.flash('success', 'Class & Year Level added and synced — it now appears in Add Subject.');
  res.redirect('/admin/class-year-levels');
});

router.post('/class-year-levels/:id/edit', (req, res) => {
  const curriculum = (req.body.curriculum || '').trim();
  const yearLevel = (req.body.year_level || '').trim();
  if (!curriculum || !yearLevel) {
    req.flash('error', 'Please fill in both the Class/Curriculum and Year Level fields.');
    return res.redirect('/admin/class-year-levels');
  }
  db.prepare('UPDATE class_year_levels SET curriculum = ?, year_level = ? WHERE id = ?').run(curriculum, yearLevel, req.params.id);
  req.flash('success', 'Class & Year Level updated.');
  res.redirect('/admin/class-year-levels');
});

router.post('/class-year-levels/:id/toggle', (req, res) => {
  const item = db.prepare('SELECT * FROM class_year_levels WHERE id = ?').get(req.params.id);
  if (item) db.prepare('UPDATE class_year_levels SET status = ? WHERE id = ?').run(item.status === 'Active' ? 'Inactive' : 'Active', req.params.id);
  res.redirect('/admin/class-year-levels');
});

router.post('/class-year-levels/:id/delete', (req, res) => {
  db.prepare('DELETE FROM class_year_levels WHERE id = ?').run(req.params.id);
  req.flash('success', 'Class & Year Level deleted.');
  res.redirect('/admin/class-year-levels');
});

// ---------- MCQ Plans ----------
router.get('/mcq-plans', (req, res) => {
  const { subject_id, class_name, year_level, status } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (subject_id) { where += ' AND p.subject_id = ?'; params.push(subject_id); }
  if (class_name) { where += ' AND p.class_name = ?'; params.push(class_name); }
  if (year_level) { where += ' AND p.year_level = ?'; params.push(year_level); }
  if (status === 'active') where += ' AND p.is_active = 1';
  if (status === 'inactive') where += ' AND p.is_active = 0';

  const plans = db.prepare(
    `SELECT p.*, s.name AS subject_name,
       (SELECT COUNT(*) FROM mcq_plan_questions WHERE plan_id = p.id) AS curated_count
     FROM mcq_plans p LEFT JOIN subjects s ON s.id = p.subject_id
     ${where} ORDER BY p.id DESC`
  ).all(...params);

  const allPlans = db.prepare('SELECT * FROM mcq_plans').all();
  const kpis = {
    total: allPlans.length,
    active: allPlans.filter((p) => p.is_active).length,
    inactive: allPlans.filter((p) => !p.is_active).length,
    withMcqs: db.prepare('SELECT COUNT(DISTINCT plan_id) c FROM mcq_plan_questions').get().c,
  };

  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const classYearLevels = db.prepare("SELECT * FROM class_year_levels WHERE status = 'Active' ORDER BY id").all();
  const classNames = [...new Set(classYearLevels.map((c) => c.curriculum).filter(Boolean))];
  const yearLevels = [...new Set(classYearLevels.map((c) => c.year_level).filter(Boolean))];

  res.render('admin/mcq_plans', {
    plans, kpis, subjects, classNames, yearLevels,
    filters: { subject_id: subject_id || '', class_name: class_name || '', year_level: year_level || '', status: status || '' },
  });
});

// ---------- MCQ Plan: curated question selection (paginated, multi-select) ----------
// Shared by the standalone "Assign MCQs to Plan" page and the embedded
// picker on the Add/Edit Plan form, so both stay in sync with one query.
const PLAN_QUESTIONS_PAGE_SIZE = 25;
function getPlanQuestionsPage(query, planId) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const { subject_id, year, q } = query;
  let where = 'WHERE 1=1';
  const params = [];
  if (subject_id) { where += ' AND m.subject_id = ?'; params.push(subject_id); }
  if (year) { where += ' AND m.year = ?'; params.push(year); }
  if (q) { where += ' AND m.question LIKE ?'; params.push(`%${q}%`); }

  const total = db.prepare(`SELECT COUNT(*) c FROM mcqs m ${where}`).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(total / PLAN_QUESTIONS_PAGE_SIZE));
  const offset = (page - 1) * PLAN_QUESTIONS_PAGE_SIZE;

  const questions = db.prepare(
    `SELECT m.*, s.name AS subject_name FROM mcqs m JOIN subjects s ON s.id = m.subject_id
     ${where} ORDER BY m.id LIMIT ? OFFSET ?`
  ).all(...params, PLAN_QUESTIONS_PAGE_SIZE, offset);

  const selectedIds = new Set(
    planId ? db.prepare('SELECT mcq_id FROM mcq_plan_questions WHERE plan_id = ?').all(planId).map((r) => r.mcq_id) : []
  );

  const topicSummary = planId ? db.prepare(
    `SELECT COALESCE(m.topic, 'Uncategorised') AS topic, COUNT(*) AS count
     FROM mcq_plan_questions pq JOIN mcqs m ON m.id = pq.mcq_id
     WHERE pq.plan_id = ? GROUP BY COALESCE(m.topic, 'Uncategorised') ORDER BY count DESC`
  ).all(planId) : [];

  return {
    page, totalPages, total, questions, selectedIds, topicSummary,
    filters: { subject_id: subject_id || '', year: year || '', q: q || '' },
  };
}

// Applies the same page_mcq_ids/mcq_ids merge logic used by the standalone
// questions page, so create/edit/assign all share one insert/remove pattern.
function applyPlanQuestionSelection(planId, body) {
  const pageMcqIds = (Array.isArray(body.page_mcq_ids) ? body.page_mcq_ids : [body.page_mcq_ids]).filter(Boolean).map(Number);
  const checkedIds = (Array.isArray(body.mcq_ids) ? body.mcq_ids : [body.mcq_ids]).filter(Boolean).map(Number);
  if (!pageMcqIds.length) return 0;

  const insert = db.prepare('INSERT OR IGNORE INTO mcq_plan_questions (plan_id, mcq_id, order_no) VALUES (?,?,0)');
  const remove = db.prepare('DELETE FROM mcq_plan_questions WHERE plan_id = ? AND mcq_id = ?');
  pageMcqIds.forEach((mcqId) => {
    if (checkedIds.includes(mcqId)) insert.run(planId, mcqId);
    else remove.run(planId, mcqId);
  });
  return checkedIds.length;
}

router.get('/mcq-plans/new', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const classYearLevels = db.prepare("SELECT * FROM class_year_levels WHERE status = 'Active' ORDER BY id").all();
  const picker = getPlanQuestionsPage(req.query, null);
  res.render('admin/mcq_plan_new', { item: null, subjects, classYearLevels, ...picker });
});

router.post('/mcq-plans', (req, res) => {
  const { name, mcq_count, price, validity_days, validity_months, subject_id, class_name, year_level, description, discount_price, is_active } = req.body;
  const validityDays = validity_months ? Number(validity_months) * 30 : (validity_days || 30);
  const info = db.prepare(
    `INSERT INTO mcq_plans (name, mcq_count, price, validity_days, subject_id, class_name, year_level, description, discount_price, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`
  ).run(
    name, mcq_count || 0, price, validityDays,
    subject_id || null, class_name || null, year_level || null, description || null,
    discount_price ? Number(discount_price) : null, is_active ? 1 : 0
  );
  const newPlanId = info.lastInsertRowid;

  // The Add Plan form now embeds the MCQ picker (mirrors the new mockup),
  // so if MCQs were ticked on the current picker page, save them in the
  // same request using the same merge logic as the standalone page.
  const checkedCount = applyPlanQuestionSelection(newPlanId, req.body);

  if (checkedCount > 0) {
    req.flash('success', `MCQ plan created with ${checkedCount} MCQ(s) assigned. You can add more anytime via Assign MCQs.`);
  } else {
    req.flash('success', 'MCQ plan created. Now assign the exact MCQs for this plan.');
  }
  res.redirect(`/admin/mcq-plans/${newPlanId}/questions`);
});

router.get('/mcq-plans/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM mcq_plans WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect('/admin/mcq-plans');
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const classYearLevels = db.prepare("SELECT * FROM class_year_levels WHERE status = 'Active' ORDER BY id").all();
  const picker = getPlanQuestionsPage(req.query, item.id);
  res.render('admin/mcq_plan_new', { item, subjects, classYearLevels, ...picker });
});

router.post('/mcq-plans/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM mcq_plans WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect('/admin/mcq-plans');
  const { name, mcq_count, price, validity_days, validity_months, subject_id, class_name, year_level, description, discount_price, is_active } = req.body;
  const validityDays = validity_months ? Number(validity_months) * 30 : (validity_days || item.validity_days);
  db.prepare(
    `UPDATE mcq_plans SET name=?, mcq_count=?, price=?, validity_days=?, subject_id=?, class_name=?, year_level=?, description=?, discount_price=?, is_active=? WHERE id=?`
  ).run(
    name, mcq_count || 0, price, validityDays,
    subject_id || null, class_name || null, year_level || null, description || null,
    discount_price ? Number(discount_price) : null, is_active ? 1 : 0, item.id
  );

  // Same embedded picker on Edit — merge whatever was ticked on the
  // currently-shown page into the plan's questions.
  applyPlanQuestionSelection(item.id, req.body);

  req.flash('success', 'MCQ plan updated.');
  res.redirect('/admin/mcq-plans');
});

router.post('/mcq-plans/:id/duplicate', (req, res) => {
  const plan = db.prepare('SELECT * FROM mcq_plans WHERE id = ?').get(req.params.id);
  if (!plan) { req.flash('error', 'Plan not found'); return res.redirect('/admin/mcq-plans'); }

  const newId = db.prepare(
    `INSERT INTO mcq_plans (name, mcq_count, price, validity_days, subject_id, class_name, year_level, description, discount_price, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,datetime('now'))`
  ).run(
    `${plan.name} (Copy)`, plan.mcq_count, plan.price, plan.validity_days,
    plan.subject_id, plan.class_name, plan.year_level, plan.description, plan.discount_price
  ).lastInsertRowid;

  const questions = db.prepare('SELECT mcq_id, order_no FROM mcq_plan_questions WHERE plan_id = ?').all(plan.id);
  const insQ = db.prepare('INSERT INTO mcq_plan_questions (plan_id, mcq_id, order_no) VALUES (?,?,?)');
  questions.forEach((q) => insQ.run(newId, q.mcq_id, q.order_no));

  req.flash('success', `Plan duplicated as "${plan.name} (Copy)" (saved inactive — review and activate it).`);
  res.redirect('/admin/mcq-plans');
});

router.get('/mcq-plans/:id/questions', (req, res) => {
  const plan = db.prepare('SELECT * FROM mcq_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.redirect('/admin/mcq-plans');
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const picker = getPlanQuestionsPage(req.query, plan.id);
  res.render('admin/mcq_plan_questions', { plan, subjects, ...picker });
});

router.post('/mcq-plans/:id/questions', (req, res) => {
  const plan = db.prepare('SELECT * FROM mcq_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.redirect('/admin/mcq-plans');
  const checkedCount = applyPlanQuestionSelection(plan.id, req.body);
  logAction(req, 'mcq_plan_questions_updated', { recordType: 'mcq_plan', recordId: plan.id, newValue: { checked: checkedCount } });
  req.flash('success', 'Selection saved for this page.');
  res.redirect(`/admin/mcq-plans/${plan.id}/questions?page=${req.query.page || 1}`);
});

// ---------- MCQ bank ----------
router.get('/mcqs', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const { year, status, q, subject_id, module_id, topic, difficulty } = req.query;
  let sql = `SELECT m.*, s.name AS subject_name, cm.title AS module_title, ms.title AS set_title
             FROM mcqs m JOIN subjects s ON s.id = m.subject_id
             LEFT JOIN course_modules cm ON cm.id = m.module_id
             LEFT JOIN mcq_sets ms ON ms.id = m.set_id WHERE 1=1`;
  const params = [];
  if (year) { sql += ' AND m.year = ?'; params.push(year); }
  if (status) { sql += ' AND m.status = ?'; params.push(status); }
  if (q) { sql += ' AND m.question LIKE ?'; params.push(`%${q}%`); }
  if (subject_id) { sql += ' AND m.subject_id = ?'; params.push(subject_id); }
  if (module_id) { sql += ' AND m.module_id = ?'; params.push(module_id); }
  if (topic) { sql += ' AND m.topic = ?'; params.push(topic); }
  if (difficulty) { sql += ' AND m.difficulty = ?'; params.push(difficulty); }
  sql += ' ORDER BY m.id DESC LIMIT 200';
  const mcqs = db.prepare(sql).all(...params);

  const stats = {
    total: db.prepare('SELECT COUNT(*) c FROM mcqs').get().c,
    published: db.prepare("SELECT COUNT(*) c FROM mcqs WHERE status='published'").get().c,
    needsReview: db.prepare("SELECT COUNT(*) c FROM mcqs WHERE status='needs_review'").get().c,
    topics: db.prepare("SELECT COUNT(DISTINCT topic) c FROM mcqs WHERE topic IS NOT NULL AND topic != ''").get().c,
  };

  const subjectCounts = db.prepare(
    `SELECT s.id, s.name, s.year, COUNT(m.id) c FROM subjects s LEFT JOIN mcqs m ON m.subject_id = s.id GROUP BY s.id ORDER BY s.name`
  ).all();

  const modules = db.prepare('SELECT id, title, subject_id FROM course_modules ORDER BY title').all();
  const topics = db.prepare("SELECT DISTINCT topic FROM mcqs WHERE topic IS NOT NULL AND topic != '' ORDER BY topic").all().map((r) => r.topic);

  res.render('admin/mcqs', {
    subjects, mcqs, stats, subjectCounts, modules, topics,
    filters: { year: year || '', status: status || '', q: q || '', subject_id: subject_id || '', module_id: module_id || '', topic: topic || '', difficulty: difficulty || '' },
  });
});
router.post('/mcqs', (req, res) => {
  const { subject_id, year, topic, question, option_a, option_b, option_c, option_d, correct_option, difficulty, status } = req.body;
  const id = db.prepare(
    `INSERT INTO mcqs (subject_id, year, topic, question, option_a, option_b, option_c, option_d, correct_option, difficulty, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
  ).run(subject_id, year, topic, question, option_a, option_b, option_c, option_d, correct_option, difficulty || 'medium', status || 'published').lastInsertRowid;
  logAction(req, 'mcq_created', { recordType: 'mcq', recordId: id, newValue: { question, correct_option } });
  req.flash('success', 'MCQ added to bank (add as many as you like)');
  res.redirect('/admin/mcqs');
});

router.get('/mcqs/:id/edit', (req, res) => {
  const mcq = db.prepare('SELECT * FROM mcqs WHERE id = ?').get(req.params.id);
  if (!mcq) return res.redirect('/admin/mcqs');
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('admin/mcq_edit', { mcq, subjects });
});

router.post('/mcqs/:id/edit', (req, res) => {
  const { subject_id, year, topic, question, option_a, option_b, option_c, option_d, correct_option, difficulty, status } = req.body;
  const before = db.prepare('SELECT * FROM mcqs WHERE id = ?').get(req.params.id);
  db.prepare(
    `UPDATE mcqs SET subject_id=?, year=?, topic=?, question=?, option_a=?, option_b=?, option_c=?, option_d=?, correct_option=?, difficulty=?, status=? WHERE id=?`
  ).run(subject_id, year, topic, question, option_a, option_b, option_c, option_d, correct_option, difficulty, status, req.params.id);
  logAction(req, 'mcq_edited', {
    recordType: 'mcq', recordId: req.params.id,
    oldValue: { question: before.question, correct_option: before.correct_option, status: before.status },
    newValue: { question, correct_option, status },
  });
  req.flash('success', 'MCQ updated.');
  res.redirect('/admin/mcqs');
});

router.post('/mcqs/:id/delete', (req, res) => {
  const mcq = db.prepare('SELECT * FROM mcqs WHERE id = ?').get(req.params.id);
  if (!mcq) { req.flash('error', 'MCQ not found'); return res.redirect('/admin/mcqs'); }
  const usedInAssignment = db.prepare('SELECT id FROM mcq_assignment_questions WHERE mcq_id = ? LIMIT 1').get(req.params.id);
  if (usedInAssignment) {
    req.flash('error', 'This question has already been assigned to a student and cannot be deleted.');
    return res.redirect('/admin/mcqs');
  }
  db.prepare('DELETE FROM mcqs WHERE id = ?').run(req.params.id);
  logAction(req, 'mcq_deleted', { recordType: 'mcq', recordId: req.params.id });
  req.flash('success', 'MCQ deleted.');
  res.redirect('/admin/mcqs');
});

// ---------- MCQ Sets ("Add Multiple MCQs" / "Assign MCQ Set") ----------
// A set is a titled bundle of mcqs rows (mcqs.set_id) — the assignment engine
// underneath is the exact same mcq_assignments / mcq_assignment_questions /
// student_mcq_plans machinery used by the single-question "Assign" flow above.
router.get('/mcq-sets/new', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const courseModules = db.prepare(
    `SELECT cm.id, cm.title, cm.subject_id, cm.year_level, s.name AS subject_name
     FROM course_modules cm JOIN subjects s ON s.id = cm.subject_id
     WHERE cm.is_active = 1 ORDER BY s.name, cm.title`
  ).all();
  res.render('admin/mcq_set_new', { subjects, courseModules, item: null, questions: [] });
});

router.get('/mcq-sets/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM mcq_sets WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'MCQ set not found'); return res.redirect('/admin/mcqs'); }
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const courseModules = db.prepare(
    `SELECT cm.id, cm.title, cm.subject_id, cm.year_level, s.name AS subject_name
     FROM course_modules cm JOIN subjects s ON s.id = cm.subject_id
     WHERE cm.is_active = 1 ORDER BY s.name, cm.title`
  ).all();
  const questions = db.prepare('SELECT * FROM mcqs WHERE set_id = ? ORDER BY id').all(req.params.id);
  res.render('admin/mcq_set_new', { subjects, courseModules, item, questions });
});

function saveMcqSet(req, res, existingId) {
  const {
    title, subject_id, module_id, year, description,
    default_marks, negative_marks, difficulty, action,
  } = req.body;

  if (!title || !subject_id) {
    req.flash('error', 'Title and Subject are required.');
    return res.redirect(existingId ? `/admin/mcq-sets/${existingId}/edit` : '/admin/mcq-sets/new');
  }

  // Parse the repeated indexed question fields: questions[N][question] etc.
  // express.urlencoded({ extended: true }) (qs) parses bracket-notation keys
  // into a real nested array/object at req.body.questions — handle that as
  // the primary shape, with a flat-key fallback for safety.
  let questionRows = [];
  if (req.body.questions && typeof req.body.questions === 'object') {
    questionRows = Object.values(req.body.questions);
  } else {
    const qMap = {};
    Object.keys(req.body).forEach((key) => {
      const m = key.match(/^questions\[(\d+)\]\[(\w+)\]$/);
      if (!m) return;
      const idx = m[1];
      qMap[idx] = qMap[idx] || {};
      qMap[idx][m[2]] = req.body[key];
    });
    questionRows = Object.values(qMap);
  }
  questionRows = questionRows.filter((q) => q && q.question && q.option_a && q.option_b && q.option_c && q.option_d && q.correct_option);

  if (!questionRows.length) {
    req.flash('error', 'Add at least one complete question (question text, 4 options and a correct answer).');
    return res.redirect(existingId ? `/admin/mcq-sets/${existingId}/edit` : '/admin/mcq-sets/new');
  }

  let moduleTitle = null;
  if (module_id) {
    const mod = db.prepare('SELECT title FROM course_modules WHERE id = ?').get(module_id);
    moduleTitle = mod ? mod.title : null;
  }

  const status = action === 'publish' ? 'published' : 'draft';

  let setId = existingId;
  if (existingId) {
    // Block a destructive re-insert if any of this set's existing questions
    // have already been handed to a student via mcq_assignment_questions.
    const used = db.prepare(
      `SELECT COUNT(*) c FROM mcq_assignment_questions aq JOIN mcqs m ON m.id = aq.mcq_id WHERE m.set_id = ?`
    ).get(existingId).c;
    if (used > 0) {
      req.flash('error', 'This set has already been assigned to students — its questions cannot be edited. Create a new set instead.');
      return res.redirect('/admin/mcqs');
    }
    db.prepare(
      `UPDATE mcq_sets SET title=?, subject_id=?, module_id=?, year=?, description=?, total_questions=?, default_marks=?, negative_marks=?, status=? WHERE id=?`
    ).run(title, subject_id, module_id || null, year || null, description || null, questionRows.length, default_marks || 1, negative_marks || 0, status, existingId);
    db.prepare('DELETE FROM mcqs WHERE set_id = ?').run(existingId);
  } else {
    setId = db.prepare(
      `INSERT INTO mcq_sets (title, subject_id, module_id, year, description, total_questions, default_marks, negative_marks, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(title, subject_id, module_id || null, year || null, description || null, questionRows.length, default_marks || 1, negative_marks || 0, status, req.session.user.id).lastInsertRowid;
  }

  const insertQ = db.prepare(
    `INSERT INTO mcqs (subject_id, year, topic, question, option_a, option_b, option_c, option_d, correct_option, difficulty, status, set_id, module_id, marks, explanation, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
  );
  questionRows.forEach((q) => {
    insertQ.run(
      subject_id, year || 'Year 11', moduleTitle, q.question, q.option_a, q.option_b, q.option_c, q.option_d,
      (q.correct_option || 'A').toUpperCase(), q.difficulty || difficulty || 'medium', status, setId, module_id || null,
      q.marks || default_marks || 1, q.explanation || null
    );
  });

  logAction(req, existingId ? 'mcq_set_updated' : 'mcq_set_created', { recordType: 'mcq_set', recordId: setId, newValue: { title, count: questionRows.length, status } });
  req.flash('success', `MCQ set "${title}" saved with ${questionRows.length} question(s).`);

  if (action === 'publish') return res.redirect(`/admin/mcq-sets/${setId}/assign`);
  res.redirect('/admin/mcqs');
}

router.post('/mcq-sets/new', (req, res) => saveMcqSet(req, res, null));
router.post('/mcq-sets/:id/edit', (req, res) => saveMcqSet(req, res, Number(req.params.id)));

router.get('/mcq-sets/:id/assign', (req, res) => {
  const set = db.prepare(
    `SELECT ms.*, s.name AS subject_name, cm.title AS module_title FROM mcq_sets ms
     LEFT JOIN subjects s ON s.id = ms.subject_id LEFT JOIN course_modules cm ON cm.id = ms.module_id WHERE ms.id = ?`
  ).get(req.params.id);
  if (!set) { req.flash('error', 'MCQ set not found'); return res.redirect('/admin/mcqs'); }
  const questions = db.prepare('SELECT * FROM mcqs WHERE set_id = ? ORDER BY id').all(set.id);
  const students = db.prepare("SELECT id, name, email, class_section, class_year FROM users WHERE role = 'student' ORDER BY name").all();
  const classes = [...new Set(students.map((s) => s.class_section).filter(Boolean))];
  const yearLevels = [...new Set(students.map((s) => s.class_year).filter(Boolean))];
  res.render('admin/mcq_set_assign', { set, questions, students, classes, yearLevels });
});

router.post('/mcq-sets/:id/assign', (req, res) => {
  const set = db.prepare('SELECT * FROM mcq_sets WHERE id = ?').get(req.params.id);
  if (!set) { req.flash('error', 'MCQ set not found'); return res.redirect('/admin/mcqs'); }

  const setQuestionIds = db.prepare('SELECT id FROM mcqs WHERE set_id = ? ORDER BY id').all(set.id).map((r) => r.id);
  if (!setQuestionIds.length) { req.flash('error', 'This set has no questions.'); return res.redirect('/admin/mcqs'); }
  const count = setQuestionIds.length;

  const assignTo = req.body.assignto || 'students';
  let studentIds = [];
  if (assignTo === 'all') {
    studentIds = db.prepare("SELECT id FROM users WHERE role='student'").all().map((r) => r.id);
  } else if (assignTo === 'classes' && req.body.class_names) {
    const classes = Array.isArray(req.body.class_names) ? req.body.class_names : [req.body.class_names];
    studentIds = db.prepare(`SELECT id FROM users WHERE role='student' AND class_section IN (${classes.map(() => '?').join(',')})`).all(...classes).map((r) => r.id);
  } else if (req.body.student_ids) {
    studentIds = Array.isArray(req.body.student_ids) ? req.body.student_ids : [req.body.student_ids];
  }
  if (!studentIds.length) { req.flash('error', 'Select at least one student, class or "All Students".'); return res.redirect(`/admin/mcq-sets/${set.id}/assign`); }

  let dueDate = null;
  if (req.body.schedule === 'until' && req.body.due_date) dueDate = req.body.due_date;
  if (req.body.schedule === 'later' && req.body.schedule_date) dueDate = req.body.schedule_date;

  const freePlan = db.prepare("SELECT * FROM mcq_plans WHERE name = 'Free Plan'").get();
  const insertAssignment = db.prepare(
    `INSERT INTO mcq_assignments (student_plan_id, user_id, subject_id, year, topic, mcq_count, due_date, teacher_note, assigned_by, set_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const insertQ = db.prepare('INSERT INTO mcq_assignment_questions (assignment_id, mcq_id) VALUES (?,?)');
  const sendNotification = req.body.notify !== 'no';

  let assignedCount = 0;
  studentIds.forEach((uid) => {
    // Find-or-create this student's Free Plan row, exactly like registration does.
    let plan = db.prepare("SELECT sp.* FROM student_mcq_plans sp JOIN mcq_plans mp ON mp.id = sp.plan_id WHERE sp.user_id = ? AND mp.name = 'Free Plan'").get(uid);
    if (!plan && freePlan) {
      const expiresAt = new Date(Date.now() + freePlan.validity_days * 86400000).toISOString();
      const planId = db.prepare(
        'INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at) VALUES (?,?,NULL,NULL,?,?)'
      ).run(uid, freePlan.id, freePlan.mcq_count, expiresAt).lastInsertRowid;
      plan = db.prepare('SELECT * FROM student_mcq_plans WHERE id = ?').get(planId);
    }
    if (!plan) return; // no plan config on this instance — skip gracefully

    // Top up quota if this direct-assign would exceed what's left; never
    // reduce remaining_mcqs, only ever raise it to cover the shortfall.
    if (plan.remaining_mcqs < count) {
      const shortfall = count - plan.remaining_mcqs;
      db.prepare('UPDATE student_mcq_plans SET remaining_mcqs = remaining_mcqs + ? WHERE id = ?').run(shortfall, plan.id);
    }

    const assignmentId = insertAssignment.run(
      plan.id, uid, set.subject_id, set.year, set.title, count, dueDate, req.body.message || null, req.session.user.id, set.id
    ).lastInsertRowid;
    setQuestionIds.forEach((mcqId) => insertQ.run(assignmentId, mcqId));
    db.prepare('UPDATE student_mcq_plans SET remaining_mcqs = remaining_mcqs - ?, assigned_mcqs = assigned_mcqs + ? WHERE id = ?')
      .run(count, count, plan.id);
    assignedCount += 1;

    if (sendNotification) {
      notify(uid, 'mcq_assignment', `New MCQ set assigned: ${set.title}`, `${count} questions`, '/student/mcq/my', { email: false }); // email sent just below
      const student = db.prepare('SELECT email, name FROM users WHERE id = ?').get(uid);
      if (student) {
        sendEmail({
          to: student.email,
          subject: `New MCQ set assigned: ${set.title}`,
          template: 'mcq_assignment',
          userId: uid, createdBy: req.session.user.id, relatedType: 'mcq_set', relatedId: set.id,
          html: `<p>Hi ${student.name},</p><p>Your teacher has assigned you the MCQ set "<b>${set.title}</b>" (${count} questions). Log in to your Student Portal to start practicing.</p>`,
        });
      }
    }
  });

  db.prepare("UPDATE mcq_sets SET status = 'published' WHERE id = ?").run(set.id);
  logAction(req, 'mcq_set_assigned', { recordType: 'mcq_set', recordId: set.id, newValue: { students: assignedCount, count } });
  req.flash('success', `MCQ set "${set.title}" assigned to ${assignedCount} student(s).`);
  res.redirect('/admin/mcqs');
});

// ---------- Full Exam Papers ----------
router.get('/papers', (req, res) => {
  const { subject_id, year, class_name, exam_type_id, q } = req.query;
  let sql = `SELECT p.*, s.name AS subject_name, et.name AS exam_type_name, cm.title AS module_title,
                    (SELECT COUNT(*) FROM exam_paper_questions q WHERE q.paper_id = p.id) AS question_count,
                    (SELECT COALESCE(SUM(marks),0) FROM exam_paper_questions q WHERE q.paper_id = p.id) AS total_marks
             FROM exam_papers p
             JOIN subjects s ON s.id = p.subject_id
             LEFT JOIN exam_types et ON et.id = p.exam_type_id
             LEFT JOIN course_modules cm ON cm.id = p.module_id
             WHERE 1=1`;
  const params = [];
  if (subject_id) { sql += ' AND p.subject_id = ?'; params.push(subject_id); }
  if (year) { sql += ' AND p.year = ?'; params.push(year); }
  if (class_name) { sql += ' AND p.class_name = ?'; params.push(class_name); }
  if (exam_type_id) { sql += ' AND p.exam_type_id = ?'; params.push(exam_type_id); }
  if (q) { sql += ' AND p.title LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY p.id DESC';
  const papers = db.prepare(sql).all(...params).map((p) => ({ ...p, slug: paperSlug(p) }));

  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const examTypes = db.prepare('SELECT * FROM exam_types ORDER BY name').all();
  const modules = db.prepare(
    `SELECT cm.*, s.name AS subject_name FROM course_modules cm JOIN subjects s ON s.id = cm.subject_id ORDER BY s.name, cm.order_no, cm.id`
  ).all();
  const topics = db.prepare(
    `SELECT et.*, cm.title AS module_title FROM exam_topics et JOIN course_modules cm ON cm.id = et.module_id ORDER BY cm.title, et.name`
  ).all();

  res.render('admin/papers', { papers, subjects, examTypes, modules, topics, filters: { subject_id, year, class_name, exam_type_id, q } });
});

router.get('/papers/new', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const examTypes = db.prepare('SELECT * FROM exam_types WHERE is_active = 1 ORDER BY name').all();
  const modules = db.prepare('SELECT * FROM course_modules WHERE is_active = 1 ORDER BY title').all();
  const topics = db.prepare('SELECT * FROM exam_topics WHERE is_active = 1 ORDER BY name').all();
  res.render('admin/paper_new', { subjects, examTypes, modules, topics, paper: null, questions: [], paperSlug: null, editingQuestion: null });
});

function readPaperFields(body) {
  return {
    title: (body.title || '').trim(),
    subject_id: body.subject_id || null,
    year: body.year || null,
    exam_type_id: body.exam_type_id || null,
    module_id: body.module_id || null,
    topic_id: body.topic_id || null,
    class_name: body.class_name || null,
    duration_minutes: parseInt(body.duration_minutes, 10) || 120,
    price: parseFloat(body.price) || 0,
    description: body.description || null,
    cover_image_url: body.cover_image_url || null,
    passing_marks: body.passing_marks ? parseInt(body.passing_marks, 10) : null,
    show_model_answers: body.show_model_answers ? 1 : 0,
    allow_calculator: body.allow_calculator ? 1 : 0,
    shuffle_mcq_options: body.shuffle_mcq_options ? 1 : 0,
    available_from: body.available_from || null,
    available_until: body.available_until || null,
    woo_product_id: body.woo_product_id || null,
  };
}

router.post('/papers/new', (req, res) => {
  const f = readPaperFields(req.body);
  if (!f.title || !f.subject_id) {
    req.flash('error', 'Title and Subject are required.');
    return res.redirect('/admin/papers/new');
  }
  const paperId = db.prepare(
    `INSERT INTO exam_papers
     (title, year, subject_id, price, duration_minutes, woo_product_id, exam_type_id, module_id, topic_id, class_name,
      description, cover_image_url, passing_marks, show_model_answers, allow_calculator, shuffle_mcq_options,
      available_from, available_until, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
  ).run(
    f.title, f.year, f.subject_id, f.price, f.duration_minutes, f.woo_product_id, f.exam_type_id, f.module_id, f.topic_id,
    f.class_name, f.description, f.cover_image_url, f.passing_marks, f.show_model_answers, f.allow_calculator,
    f.shuffle_mcq_options, f.available_from, f.available_until
  ).lastInsertRowid;
  req.flash('success', 'Exam paper created. Now add questions (any number of MCQ / short answer / long answer).');
  const _newPaper = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(paperId);
  res.redirect('/admin/papers/' + (_newPaper ? paperSlug(_newPaper) : paperId));
});

router.get('/papers/:slug', (req, res) => {
  const resolvedId = paperIdFromSlug(req.params.slug);
  const paper = db.prepare(
    'SELECT p.*, s.name AS subject_name FROM exam_papers p LEFT JOIN subjects s ON s.id = p.subject_id WHERE p.id = ?'
  ).get(resolvedId);
  if (!paper) return res.redirect('/admin/papers');
  // Canonical redirect: if they came in on a plain id or old slug, send them to the pretty URL.
  // req.path is relative to this router's mount point (/admin), so compare against the
  // unprefixed form — comparing against the /admin-prefixed canonical here would never match
  // and caused an infinite redirect loop.
  const canonicalRelative = '/papers/' + paperSlug(paper);
  if (req.path !== canonicalRelative) {
    return res.redirect(301, '/admin' + canonicalRelative);
  }
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const examTypes = db.prepare('SELECT * FROM exam_types WHERE is_active = 1 ORDER BY name').all();
  const modules = db.prepare('SELECT * FROM course_modules WHERE is_active = 1 ORDER BY title').all();
  const topics = db.prepare('SELECT * FROM exam_topics WHERE is_active = 1 ORDER BY name').all();
  const questions = db.prepare('SELECT * FROM exam_paper_questions WHERE paper_id = ? ORDER BY order_no').all(paper.id);

  // ?edit_q=<id> reloads this same page with the Add Question form pre-filled for editing
  // that question instead of adding a new one (see the pencil icon in Questions Added).
  let editingQuestion = null;
  if (req.query.edit_q) {
    editingQuestion = db.prepare('SELECT * FROM exam_paper_questions WHERE id = ? AND paper_id = ?').get(req.query.edit_q, paper.id) || null;
    if (editingQuestion && editingQuestion.rubric) {
      try { editingQuestion.rubricParsed = JSON.parse(editingQuestion.rubric); } catch { editingQuestion.rubricParsed = []; }
    }
  }
  res.render('admin/paper_new', { subjects, examTypes, modules, topics, paper, questions, paperSlug: paper ? paperSlug(paper) : null, editingQuestion });
});

router.post('/papers/:slug/edit', (req, res) => {

  const resolvedId = paperIdFromSlug(req.params.slug || req.params.paperSlug);
  const f = readPaperFields(req.body);
  db.prepare(
    `UPDATE exam_papers SET title=?, year=?, subject_id=?, price=?, duration_minutes=?, woo_product_id=?, exam_type_id=?,
     module_id=?, topic_id=?, class_name=?, description=?, cover_image_url=?, passing_marks=?, show_model_answers=?,
     allow_calculator=?, shuffle_mcq_options=?, available_from=?, available_until=? WHERE id = ?`
  ).run(
    f.title, f.year, f.subject_id, f.price, f.duration_minutes, f.woo_product_id, f.exam_type_id, f.module_id, f.topic_id,
    f.class_name, f.description, f.cover_image_url, f.passing_marks, f.show_model_answers, f.allow_calculator,
    f.shuffle_mcq_options, f.available_from, f.available_until, resolvedId
  );
  req.flash('success', 'Exam paper updated.');
  const _p = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(resolvedId);
  res.redirect('/admin/papers/' + (_p ? paperSlug(_p) : resolvedId));
});

router.post('/papers/:slug/duplicate', (req, res) => {

  const resolvedId = paperIdFromSlug(req.params.slug || req.params.paperSlug);
  const paper = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(resolvedId);
  if (!paper) { req.flash('error', 'Paper not found'); return res.redirect('/admin/papers'); }
  const newId = db.prepare(
    `INSERT INTO exam_papers
     (title, year, subject_id, price, duration_minutes, woo_product_id, exam_type_id, module_id, topic_id, class_name,
      description, cover_image_url, passing_marks, show_model_answers, allow_calculator, shuffle_mcq_options,
      available_from, available_until, is_published, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'))`
  ).run(
    `${paper.title} (Copy)`, paper.year, paper.subject_id, paper.price, paper.duration_minutes, null,
    paper.exam_type_id, paper.module_id, paper.topic_id, paper.class_name, paper.description, paper.cover_image_url,
    paper.passing_marks, paper.show_model_answers, paper.allow_calculator, paper.shuffle_mcq_options,
    paper.available_from, paper.available_until
  ).lastInsertRowid;

  const questions = db.prepare('SELECT * FROM exam_paper_questions WHERE paper_id = ? ORDER BY order_no').all(paper.id);
  const insQ = db.prepare(
    `INSERT INTO exam_paper_questions
     (paper_id, type, question, option_a, option_b, option_c, option_d, correct_option, marks, word_limit, order_no, explanation, model_answer, rubric)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  questions.forEach((q) => insQ.run(newId, q.type, q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.marks, q.word_limit, q.order_no, q.explanation, q.model_answer, q.rubric));

  req.flash('success', `Paper duplicated as "${paper.title} (Copy)".`);
  res.redirect('/admin/papers');
});

router.post('/papers/:slug/delete', (req, res) => {

  const resolvedId = paperIdFromSlug(req.params.slug || req.params.paperSlug);
  const inUse = db.prepare('SELECT id FROM exam_assignments WHERE paper_id = ? LIMIT 1').get(resolvedId);
  if (inUse) {
    req.flash('error', 'This paper has already been assigned to students and cannot be deleted.');
    return res.redirect('/admin/papers');
  }
  db.prepare('DELETE FROM exam_paper_questions WHERE paper_id = ?').run(resolvedId);
  db.prepare('DELETE FROM exam_papers WHERE id = ?').run(resolvedId);
  req.flash('success', 'Exam paper deleted.');
  res.redirect('/admin/papers');
});

router.post('/papers/:slug/questions', (req, res) => {

  const resolvedId = paperIdFromSlug(req.params.slug || req.params.paperSlug);
  const paperId = resolvedId;
  const { type, question, option_a, option_b, option_c, option_d, correct_option, marks, word_limit, explanation, model_answer } = req.body;
  const rubric = type !== 'mcq' ? parseRubricFromBody(req.body) : null;
  const maxOrder = db.prepare('SELECT MAX(order_no) m FROM exam_paper_questions WHERE paper_id = ?').get(paperId).m || 0;
  db.prepare(
    `INSERT INTO exam_paper_questions
     (paper_id, type, question, option_a, option_b, option_c, option_d, correct_option, marks, word_limit, order_no, explanation, model_answer, rubric)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    paperId, type, question,
    type === 'mcq' ? option_a : null, type === 'mcq' ? option_b : null,
    type === 'mcq' ? option_c : null, type === 'mcq' ? option_d : null,
    type === 'mcq' ? correct_option : null,
    marks || 1, word_limit || null, maxOrder + 1, type === 'mcq' ? (explanation || null) : null,
    type !== 'mcq' ? (model_answer || null) : null, rubric
  );
  req.flash('success', `${type.toUpperCase()} question added (you can add as many written/essay/MCQ questions as needed)`);
  const _qp = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(paperId);
  res.redirect('/admin/papers/' + (_qp ? paperSlug(_qp) : paperId));
});

// Edit an existing question in place — reached via the pencil icon in the Questions Added
// list, which reloads the paper page with ?edit_q=<id> so the Add Question form is
// pre-filled and repurposed into an edit form (see paper_new.ejs).
router.post('/papers/:slug/questions/:qId/edit', (req, res) => {
  const paperId = paperIdFromSlug(req.params.slug);
  const existing = db.prepare('SELECT * FROM exam_paper_questions WHERE id = ? AND paper_id = ?').get(req.params.qId, paperId);
  if (!existing) { req.flash('error', 'Question not found.'); return res.redirect('/admin/papers'); }

  const { type, question, option_a, option_b, option_c, option_d, correct_option, marks, word_limit, explanation, model_answer } = req.body;
  const rubric = type !== 'mcq' ? parseRubricFromBody(req.body) : null;
  db.prepare(
    `UPDATE exam_paper_questions SET
       type = ?, question = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct_option = ?,
       marks = ?, word_limit = ?, explanation = ?, model_answer = ?, rubric = ?
     WHERE id = ?`
  ).run(
    type, question,
    type === 'mcq' ? option_a : null, type === 'mcq' ? option_b : null,
    type === 'mcq' ? option_c : null, type === 'mcq' ? option_d : null,
    type === 'mcq' ? correct_option : null,
    marks || 1, word_limit || null, type === 'mcq' ? (explanation || null) : null,
    type !== 'mcq' ? (model_answer || null) : null, rubric,
    existing.id
  );
  req.flash('success', 'Question updated.');
  const _qp = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(paperId);
  res.redirect('/admin/papers/' + (_qp ? paperSlug(_qp) : paperId));
});

// ---------- Manage Exam Types ----------
router.post('/exam-types/new', (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) { req.flash('error', 'Exam type name is required.'); return res.redirect('/admin/papers#exam-types'); }
  db.prepare('INSERT INTO exam_types (name, description, is_active) VALUES (?,?,1)').run(name.trim(), description || null);
  req.flash('success', 'Exam type added.');
  res.redirect('/admin/papers#exam-types');
});

router.post('/exam-types/:id/edit', (req, res) => {
  const { name, description } = req.body;
  db.prepare('UPDATE exam_types SET name=?, description=?, is_active=? WHERE id=?')
    .run((name || '').trim(), description || null, req.body.is_active ? 1 : 0, resolvedId);
  req.flash('success', 'Exam type updated.');
  res.redirect('/admin/papers#exam-types');
});

router.post('/exam-types/:id/delete', (req, res) => {
  const inUse = db.prepare('SELECT id FROM exam_papers WHERE exam_type_id = ? LIMIT 1').get(req.params.id);
  if (inUse) {
    req.flash('error', 'This exam type is used by one or more papers and cannot be deleted.');
    return res.redirect('/admin/papers#exam-types');
  }
  db.prepare('DELETE FROM exam_types WHERE id = ?').run(req.params.id);
  req.flash('success', 'Exam type deleted.');
  res.redirect('/admin/papers#exam-types');
});

// ---------- Manage Topics (scoped to a Module) ----------
router.post('/exam-topics/new', (req, res) => {
  const { module_id, name } = req.body;
  if (!module_id || !name || !name.trim()) { req.flash('error', 'Module and Topic name are required.'); return res.redirect('/admin/papers#topics'); }
  db.prepare('INSERT INTO exam_topics (module_id, name, is_active) VALUES (?,?,1)').run(module_id, name.trim());
  req.flash('success', 'Topic added.');
  res.redirect('/admin/papers#topics');
});

router.post('/exam-topics/:id/edit', (req, res) => {
  const { module_id, name } = req.body;
  db.prepare('UPDATE exam_topics SET module_id=?, name=?, is_active=? WHERE id=?')
    .run(module_id, (name || '').trim(), req.body.is_active ? 1 : 0, req.params.id);
  req.flash('success', 'Topic updated.');
  res.redirect('/admin/papers#topics');
});

router.post('/exam-topics/:id/delete', (req, res) => {
  const inUse = db.prepare('SELECT id FROM exam_papers WHERE topic_id = ? LIMIT 1').get(req.params.id);
  if (inUse) {
    req.flash('error', 'This topic is used by one or more papers and cannot be deleted.');
    return res.redirect('/admin/papers#topics');
  }
  db.prepare('DELETE FROM exam_topics WHERE id = ?').run(req.params.id);
  req.flash('success', 'Topic deleted.');
  res.redirect('/admin/papers#topics');
});

// ---------- Manage Modules (Exam Papers panel — reuses course_modules exactly
// like Study Material's "Add Class Module/Topic/Year", just posted from this page) ----------
router.post('/exam-modules/new', (req, res) => {
  const { subject_id, class_name, year_level, title, description } = req.body;
  if (!subject_id || !title || !title.trim()) { req.flash('error', 'Subject and Module name are required.'); return res.redirect('/admin/papers#modules'); }
  db.prepare(
    'INSERT INTO course_modules (subject_id, title, order_no, class_name, year_level, description, is_active) VALUES (?,?,0,?,?,?,1)'
  ).run(subject_id, title.trim(), class_name || null, year_level || null, description || null);
  req.flash('success', 'Module added.');
  res.redirect('/admin/papers#modules');
});

router.post('/exam-modules/:id/edit', (req, res) => {
  const { subject_id, class_name, year_level, title, description } = req.body;
  db.prepare(
    'UPDATE course_modules SET subject_id=?, title=?, class_name=?, year_level=?, description=?, is_active=? WHERE id=?'
  ).run(subject_id, (title || '').trim(), class_name || null, year_level || null, description || null, req.body.is_active ? 1 : 0, req.params.id);
  req.flash('success', 'Module updated.');
  res.redirect('/admin/papers#modules');
});

router.post('/exam-modules/:id/delete', (req, res) => {
  const inUse = db.prepare('SELECT id FROM exam_papers WHERE module_id = ? LIMIT 1').get(req.params.id);
  if (inUse) {
    req.flash('error', 'This module is used by one or more exam papers and cannot be deleted.');
    return res.redirect('/admin/papers#modules');
  }
  db.prepare('DELETE FROM exam_topics WHERE module_id = ?').run(req.params.id);
  db.prepare('DELETE FROM course_modules WHERE id = ?').run(req.params.id);
  req.flash('success', 'Module deleted.');
  res.redirect('/admin/papers#modules');
});

router.post('/papers/:paperSlug/questions/:qId/delete', (req, res) => {

  const resolvedId = paperIdFromSlug(req.params.slug || req.params.paperSlug);
  db.prepare('DELETE FROM exam_paper_questions WHERE id = ? AND paper_id = ?').run(req.params.qId, resolvedId);
  const _p = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(resolvedId);
  res.redirect('/admin/papers/' + (_p ? paperSlug(_p) : resolvedId));
});

// Set/update the WooCommerce product ID this paper is linked to (used by the webhook)
router.post('/papers/:slug/woo-link', (req, res) => {

  const resolvedId = paperIdFromSlug(req.params.slug || req.params.paperSlug);
  const { woo_product_id } = req.body;
  db.prepare('UPDATE exam_papers SET woo_product_id = ? WHERE id = ?').run(woo_product_id || null, resolvedId);
  req.flash('success', 'WooCommerce product link updated');
  const _p = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(resolvedId);
  res.redirect('/admin/papers/' + (_p ? paperSlug(_p) : resolvedId));
});

router.post('/papers/:slug/publish', (req, res) => {

  const resolvedId = paperIdFromSlug(req.params.slug || req.params.paperSlug);
  db.prepare('UPDATE exam_papers SET is_published = 1 WHERE id = ?').run(resolvedId);
  req.flash('success', 'Paper published on website');
  const _pp = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(resolvedId);
  res.redirect('/admin/papers/' + (_pp ? paperSlug(_pp) : resolvedId));
});

// ---------- Submissions review ----------
router.get('/submissions', (req, res) => {
  const { subject_id, year, class_name, paper_id, status, date_from, date_to } = req.query;
  let sql = `SELECT s.*, a.id AS assignment_id, p.title, p.subject_id, p.year, p.class_name, u.name AS student_name, u.email
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     JOIN users u ON u.id = a.user_id
     WHERE 1=1`;
  const params = [];
  if (subject_id) { sql += ' AND p.subject_id = ?'; params.push(subject_id); }
  if (year) { sql += ' AND p.year = ?'; params.push(year); }
  if (class_name) { sql += ' AND p.class_name = ?'; params.push(class_name); }
  if (paper_id) { sql += ' AND p.id = ?'; params.push(paper_id); }
  if (status) { sql += ' AND s.status = ?'; params.push(status); }
  if (date_from) { sql += ' AND date(s.submitted_at) >= date(?)'; params.push(date_from); }
  if (date_to) { sql += ' AND date(s.submitted_at) <= date(?)'; params.push(date_to); }
  sql += ' ORDER BY s.submitted_at DESC';
  const submissions = db.prepare(sql).all(...params);

  // Derive a per-row display status + overall counts. "In Review" means the
  // teacher has started grading (some written/essay answers have marks_awarded
  // set) but hasn't published yet; "Pending" means grading hasn't started.
  const gradingProgress = db.prepare(
    `SELECT ans.submission_id,
            SUM(CASE WHEN q.type != 'mcq' THEN 1 ELSE 0 END) AS gradable,
            SUM(CASE WHEN q.type != 'mcq' AND ans.reviewed_at IS NOT NULL THEN 1 ELSE 0 END) AS graded
     FROM exam_answers ans JOIN exam_paper_questions q ON q.id = ans.question_id
     GROUP BY ans.submission_id`
  ).all();
  const progressBySubmission = {};
  gradingProgress.forEach((r) => { progressBySubmission[r.submission_id] = r; });

  submissions.forEach((s) => {
    if (s.status === 'published') {
      s.derivedStatus = 'Graded';
    } else {
      const prog = progressBySubmission[s.id];
      s.derivedStatus = (prog && prog.gradable > 0 && prog.graded > 0) ? 'In Review' : 'Pending';
    }
  });

  const counts = {
    total: submissions.length,
    pending: submissions.filter((s) => s.derivedStatus === 'Pending').length,
    inReview: submissions.filter((s) => s.derivedStatus === 'In Review').length,
    graded: submissions.filter((s) => s.derivedStatus === 'Graded').length,
  };

  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const papers = db.prepare('SELECT id, title FROM exam_papers ORDER BY title').all();
  res.render('admin/submissions', { submissions, subjects, papers, counts, filters: { subject_id, year, class_name, paper_id, status, date_from, date_to } });
});

router.get('/submissions/:id/review', (req, res) => {
  const submission = db.prepare(
    `SELECT s.*, a.id AS assignment_id, a.paper_id, p.title, p.subject_id, p.year, p.class_name, p.duration_minutes,
            p.exam_type_id, p.module_id, p.topic_id, p.description, p.show_model_answers,
            sub.name AS subject_name, u.name AS student_name, u.email
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN subjects sub ON sub.id = p.subject_id
     JOIN users u ON u.id = a.user_id
     WHERE s.id = ?`
  ).get(req.params.id);
  if (!submission) return res.redirect('/admin/submissions');

  const answers = db.prepare(
    `SELECT ans.*, q.type, q.question, q.marks, q.word_limit, q.order_no, q.model_answer, q.rubric
     FROM exam_answers ans JOIN exam_paper_questions q ON q.id = ans.question_id
     WHERE ans.submission_id = ? ORDER BY q.order_no`
  ).all(submission.id).map((a) => {
    let rubricParsed = null;
    let rubricChecked = [];
    if (a.rubric) { try { rubricParsed = JSON.parse(a.rubric); } catch { rubricParsed = null; } }
    if (a.rubric_checked) { try { rubricChecked = JSON.parse(a.rubric_checked); } catch { rubricChecked = []; } }
    return { ...a, rubricParsed, rubricChecked };
  });

  // Previous / Next student navigation, ordered by submitted_at DESC (same
  // default order as the submissions list) across all submissions.
  const order = db.prepare('SELECT id FROM exam_submissions ORDER BY submitted_at DESC, id DESC').all().map((r) => r.id);
  const idx = order.indexOf(submission.id);
  const prevId = idx > 0 ? order[idx - 1] : null;
  const nextId = (idx >= 0 && idx < order.length - 1) ? order[idx + 1] : null;

  res.render('admin/review', {
    submission,
    written: answers.filter((a) => a.type === 'written'),
    essays: answers.filter((a) => a.type === 'essay'),
    mcqCount: answers.filter((a) => a.type === 'mcq').length,
    prevId,
    nextId,
  });
});

router.post('/submissions/:id/review', (req, res) => {
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE id = ?').get(req.params.id);
  if (!submission) return res.redirect('/admin/submissions');

  const answers = db.prepare(
    `SELECT ans.id, q.type, q.marks FROM exam_answers ans
     JOIN exam_paper_questions q ON q.id = ans.question_id WHERE ans.submission_id = ?`
  ).all(submission.id);

  const updAns = db.prepare('UPDATE exam_answers SET marks_awarded = ?, feedback = ?, rubric_checked = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?');
  let writtenScore = 0, essayScore = 0;

  answers.forEach((a) => {
    if (a.type === 'mcq') return;
    const marksField = req.body[`marks_${a.id}`];
    const feedbackField = req.body[`feedback_${a.id}`] || '';
    const marks = marksField !== undefined ? Math.min(parseFloat(marksField) || 0, a.marks) : 0;
    const checkedIndices = [].concat(req.body[`rubric_checked_${a.id}`] || []).map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n));
    updAns.run(marks, feedbackField, checkedIndices.length ? JSON.stringify(checkedIndices) : null, a.id);
    if (a.type === 'written') writtenScore += marks;
    if (a.type === 'essay') essayScore += marks;
  });

  const totalScore = submission.mcq_score + writtenScore + essayScore;
  const totalMarks = submission.mcq_total + submission.written_total + submission.essay_total;
  const action = req.body.action === 'draft' ? 'draft' : 'submit';
  const newStatus = action === 'draft' ? 'pending_review' : 'published';

  db.prepare(
    `UPDATE exam_submissions SET written_score = ?, essay_score = ?, total_score = ?, total_marks = ?, status = ?
     WHERE id = ?`
  ).run(writtenScore, essayScore, totalScore, totalMarks, newStatus, submission.id);

  if (action === 'submit') {
    db.prepare('UPDATE exam_assignments SET status = ? WHERE id = ?').run('reviewed', submission.assignment_id);

    logAction(req, 'result_published', {
      recordType: 'exam_submission',
      recordId: submission.id,
      oldValue: { status: submission.status, total_score: submission.total_score },
      newValue: { status: 'published', writtenScore, essayScore, totalScore, totalMarks },
    });
    const assignment = db.prepare('SELECT user_id FROM exam_assignments WHERE id = ?').get(submission.assignment_id);
    if (assignment) {
      const paperRow = db.prepare('SELECT p.title, s.name AS subject_name FROM exam_assignments a JOIN exam_papers p ON p.id = a.paper_id LEFT JOIN subjects s ON s.id = p.subject_id WHERE a.id = ?').get(submission.assignment_id);
      const emailMeta = { relatedType: 'exam_submission', relatedId: submission.id, itemTitle: paperRow && paperRow.title, subjectName: paperRow && paperRow.subject_name, createdBy: req.session.user.id };
      notify(assignment.user_id, 'result_ready', 'Your result has been published', `Score: ${totalScore}/${totalMarks}`, '/student/results', { ...emailMeta, score: `${totalScore}/${totalMarks}` });
      const hasFeedback = db.prepare("SELECT 1 FROM exam_answers WHERE submission_id = ? AND TRIM(COALESCE(feedback,'')) != '' LIMIT 1").get(submission.id);
      if (hasFeedback) {
        notify(assignment.user_id, 'feedback_published', 'Feedback published', `Your teacher has published feedback on "${paperRow ? paperRow.title : 'your exam'}".`, '/student/results', emailMeta);
      }
    }

    req.flash('success', 'Result published. Student can now view feedback.');
    return res.redirect('/admin/submissions');
  }

  req.flash('success', 'Draft saved. Marks and feedback kept, not yet published to the student.');
  res.redirect(`/admin/submissions/${submission.id}/review`);
});

// ---------- Assign / Activate: give a paper to a student directly, no purchase needed ----------
router.get('/assign', (req, res) => {
  const students = db.prepare("SELECT id, name, email FROM users WHERE role = 'student' ORDER BY name").all();
  const papers = db.prepare(
    `SELECT p.*, s.name AS subject_name FROM exam_papers p JOIN subjects s ON s.id = p.subject_id ORDER BY p.id DESC`
  ).all();
  const subjectsForAssign = db.prepare('SELECT * FROM subjects ORDER BY name').all();

  // Recently Assigned panel — groups bulk assignments (same paper + same
  // minute) into one card with a student count, like the design's mockup.
  const recentRaw = db.prepare(
    `SELECT a.paper_id, p.title, p.year, a.assigned_at, a.status, COUNT(*) AS student_count
     FROM exam_assignments a JOIN exam_papers p ON p.id = a.paper_id
     GROUP BY a.paper_id, a.assigned_at, a.status
     ORDER BY a.assigned_at DESC LIMIT 6`
  ).all();

  // Plans that still have unassigned quota — this is what the MCQ-assignment
  // form picks from. remaining_mcqs here means "purchased but not yet
  // assigned by a teacher", not "not yet practiced".
  const plansWithQuota = db.prepare(
    `SELECT sp.id AS plan_row_id, sp.remaining_mcqs, sp.assigned_mcqs, mp.name AS plan_name, mp.mcq_count,
            u.id AS user_id, u.name AS student_name
     FROM student_mcq_plans sp
     JOIN mcq_plans mp ON mp.id = sp.plan_id
     JOIN users u ON u.id = sp.user_id
     WHERE sp.remaining_mcqs > 0
     ORDER BY u.name`
  ).all();

  const subjects = subjectsForAssign;
  const topics = db.prepare("SELECT DISTINCT topic FROM mcqs WHERE topic IS NOT NULL AND topic != ''").all().map(r => r.topic);

  const tutorialsForAssign = db.prepare(
    `SELECT t.*, s.name AS subject_name FROM tutorials t LEFT JOIN subjects s ON s.id = t.subject_id ORDER BY t.title`
  ).all();
  const materialsForAssign = db.prepare(
    `SELECT m.*, s.name AS subject_name FROM study_materials m LEFT JOIN subjects s ON s.id = m.subject_id ORDER BY m.title`
  ).all();
  const recentContent = db.prepare(
    `SELECT ca.*, u.name AS student_name,
       CASE WHEN ca.content_type='tutorial' THEN (SELECT title FROM tutorials WHERE id = ca.content_id)
            ELSE (SELECT title FROM study_materials WHERE id = ca.content_id) END AS content_title
     FROM content_assignments ca JOIN users u ON u.id = ca.user_id
     ORDER BY ca.assigned_at DESC LIMIT 6`
  ).all();

  res.render('admin/assign', { students, papers, plansWithQuota, subjects, topics, recentRaw, tutorialsForAssign, materialsForAssign, recentContent });
});

// ---------- Assign Tutorial / Study Material to a student (Assignments page) ----------
router.post('/assign-tutorial', (req, res) => {
  const { user_id, tutorial_id, due_date, instructions } = req.body;
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(user_id);
  const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tutorial_id);
  if (!student || !tutorial) { req.flash('error', 'Please choose a valid student and tutorial'); return res.redirect('/admin/assign'); }
  const existing = db.prepare("SELECT id FROM content_assignments WHERE user_id=? AND content_type='tutorial' AND content_id=?").get(student.id, tutorial.id);
  if (existing) {
    db.prepare("UPDATE content_assignments SET status='assigned', assigned_by=? WHERE id=?").run(req.session.user.id, existing.id);
  } else {
    db.prepare(
      "INSERT INTO content_assignments (user_id, content_type, content_id, amount, payment_method, assigned_by, status) VALUES (?, 'tutorial', ?, 0, 'manual', ?, 'assigned')"
    ).run(student.id, tutorial.id, req.session.user.id);
  }
  notify(student.id, 'content_assignment', 'New Tutorial Assigned', `"${tutorial.title}" has been assigned to you.`, '/student/tutorials', { relatedType: 'tutorial', relatedId: tutorial.id, itemTitle: tutorial.title, itemLabel: 'Tutorial', dueDate: due_date, instructions, createdBy: req.session.user.id });
  req.flash('success', `Tutorial "${tutorial.title}" assigned to ${student.name}.`);
  res.redirect('/admin/assign');
});

router.post('/assign-material', (req, res) => {
  const { user_id, material_id, due_date, instructions } = req.body;
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(user_id);
  const material = db.prepare('SELECT * FROM study_materials WHERE id = ?').get(material_id);
  if (!student || !material) { req.flash('error', 'Please choose a valid student and study material'); return res.redirect('/admin/assign'); }
  const existing = db.prepare("SELECT id FROM content_assignments WHERE user_id=? AND content_type='study_material' AND content_id=?").get(student.id, material.id);
  if (existing) {
    db.prepare("UPDATE content_assignments SET status='assigned', assigned_by=? WHERE id=?").run(req.session.user.id, existing.id);
  } else {
    db.prepare(
      "INSERT INTO content_assignments (user_id, content_type, content_id, amount, payment_method, assigned_by, status) VALUES (?, 'study_material', ?, 0, 'manual', ?, 'assigned')"
    ).run(student.id, material.id, req.session.user.id);
  }
  notify(student.id, 'content_assignment', 'New Study Material Assigned', `"${material.title}" has been assigned to you.`, '/student/material', { relatedType: 'study_material', relatedId: material.id, itemTitle: material.title, itemLabel: 'Study Material', dueDate: due_date, instructions, createdBy: req.session.user.id });
  req.flash('success', `Study material "${material.title}" assigned to ${student.name}.`);
  res.redirect('/admin/assign');
});

router.post('/assign', (req, res) => {
  const { paper_id, target_type, user_id, subject_id, year, start_date, start_time, due_date, instructions } = req.body;
  const paper = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(paper_id);
  if (!paper) {
    req.flash('error', 'Please choose a valid paper');
    return res.redirect('/admin/assign');
  }

  // Who gets it: one specific student, or every verified student (optionally
  // narrowed by subject/year) — the "class / group" option from the design.
  let targets = [];
  if (target_type === 'all') {
    let sql = "SELECT DISTINCT u.* FROM users u WHERE u.role = 'student' AND u.email_verified = 1";
    const params = [];
    if (subject_id) {
      sql += ` AND u.id IN (SELECT user_id FROM student_mcq_plans WHERE subject_id = ?)`;
      params.push(subject_id);
    }
    if (year) {
      sql += ' AND u.class_year = ?';
      params.push(year);
    }
    targets = db.prepare(sql).all(...params);
    if (!targets.length) {
      req.flash('error', 'No matching verified students found for that group.');
      return res.redirect('/admin/assign');
    }
  } else {
    const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(user_id);
    if (!student) {
      req.flash('error', 'Please choose a valid student');
      return res.redirect('/admin/assign');
    }
    targets = [student];
  }

  const assignedAt = start_date ? `${start_date} ${start_time || '00:00'}:00` : null;
  const dueAt = due_date ? `${due_date} 23:59:00` : null;
  const insertOrder = db.prepare('INSERT INTO exam_orders (user_id, paper_id, amount, payment_method, status) VALUES (?,?,?,?,?)');
  const insertAssignment = db.prepare(
    'INSERT INTO exam_assignments (order_id, user_id, paper_id, status, assigned_at, due_at, instructions) VALUES (?,?,?,?,?,?,?)'
  );

  targets.forEach((student) => {
    const orderId = insertOrder.run(student.id, paper.id, 0, 'assigned_by_staff', 'paid').lastInsertRowid;
    const assignmentId = insertAssignment.run(orderId, student.id, paper.id, 'assigned', assignedAt || new Date().toISOString(), dueAt, instructions || null).lastInsertRowid;
    const subj = db.prepare('SELECT name FROM subjects WHERE id = ?').get(paper.subject_id);
    notify(student.id, 'paper_assignment', 'New exam paper assigned', `"${paper.title}" has been assigned to you.`, `/student/exams/${assignmentId}`,
      { relatedType: 'exam_assignment', relatedId: Number(assignmentId), itemTitle: paper.title, subjectName: subj && subj.name, dueDate: dueAt, instructions, createdBy: req.session.user.id });
  });

  logAction(req, 'paper_assigned', {
    recordType: 'exam_assignment', recordId: paper.id,
    newValue: { paper: paper.title, students: targets.length, due_at: dueAt },
  });
  req.flash('success', `"${paper.title}" assigned to ${targets.length} student(s). Email/notification sent.`);
  res.redirect('/admin/assign');
});

// ---------- MCQ Assignment (quota-based — see Phase 2) ----------
// Teacher picks a student's PLAN (which has unassigned quota remaining),
// a subject/year/topic filter, and how many MCQs to assign. The system then
// selects that many matching questions from the bank and locks them to this
// one assignment — the student can only ever see/answer these exact
// question IDs, never the wider bank.
router.post('/mcq-assign', (req, res) => {
  const { student_plan_id, subject_id, year, topic, mcq_count, due_date, teacher_note } = req.body;
  const count = parseInt(mcq_count, 10);

  const plan = db.prepare('SELECT * FROM student_mcq_plans WHERE id = ?').get(student_plan_id);
  if (!plan) {
    req.flash('error', 'Please choose a valid student plan');
    return res.redirect('/admin/assign');
  }
  if (!count || count < 1) {
    req.flash('error', 'Enter how many MCQs to assign');
    return res.redirect('/admin/assign');
  }
  // Backend MUST prevent assigning more than the remaining (unassigned) quota.
  if (count > plan.remaining_mcqs) {
    req.flash('error', `Cannot assign ${count} MCQs — only ${plan.remaining_mcqs} remaining on this plan.`);
    return res.redirect('/admin/assign');
  }

  // Build the question pool: if the plan has a teacher-curated question set
  // (via MCQ Plans → Select Questions), use ONLY that exact list, in order,
  // excluding ones already assigned to this student before. Otherwise fall
  // back to the old subject/year/topic random-filter pool.
  const curated = db.prepare(
    `SELECT pq.mcq_id AS id FROM mcq_plan_questions pq
     WHERE pq.plan_id = ? AND pq.mcq_id NOT IN (
       SELECT mcq_id FROM mcq_assignment_questions aq
       JOIN mcq_assignments a ON a.id = aq.assignment_id
       WHERE a.user_id = ?
     )
     ORDER BY pq.order_no, pq.id`
  ).all(plan.plan_id, plan.user_id);

  let pool;
  if (curated.length) {
    pool = curated;
  } else {
    let sql = `SELECT id FROM mcqs WHERE id NOT IN (
                 SELECT mcq_id FROM mcq_assignment_questions aq
                 JOIN mcq_assignments a ON a.id = aq.assignment_id
                 WHERE a.user_id = ?
               )`;
    const params = [plan.user_id];
    if (subject_id) { sql += ' AND subject_id = ?'; params.push(subject_id); }
    if (year) { sql += ' AND year = ?'; params.push(year); }
    if (topic) { sql += ' AND topic = ?'; params.push(topic); }
    pool = db.prepare(sql).all(...params);
  }

  if (pool.length < count) {
    req.flash('error', `Only ${pool.length} unused matching MCQs available (need ${count}). ${curated.length ? 'Add more questions to this plan\'s curated set.' : 'Add more questions or widen the filter.'}`);
    return res.redirect('/admin/assign');
  }

  // If curated, take them in the teacher's chosen order; otherwise shuffle.
  const shuffled = curated.length ? pool.slice(0, count) : pool.sort(() => Math.random() - 0.5).slice(0, count);

  const assignmentId = db.prepare(
    `INSERT INTO mcq_assignments (student_plan_id, user_id, subject_id, year, topic, mcq_count, due_date, teacher_note, assigned_by)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(plan.id, plan.user_id, subject_id || null, year || null, topic || null, count, due_date || null, teacher_note || null, req.session.user.id).lastInsertRowid;

  const insertQ = db.prepare('INSERT INTO mcq_assignment_questions (assignment_id, mcq_id) VALUES (?,?)');
  shuffled.forEach((row) => insertQ.run(assignmentId, row.id));

  // Deduct from the plan's unassigned quota. purchased (mcq_count) stays
  // fixed; remaining_mcqs is what's left to assign; assigned_mcqs is a
  // running total for reporting.
  db.prepare('UPDATE student_mcq_plans SET remaining_mcqs = remaining_mcqs - ?, assigned_mcqs = assigned_mcqs + ? WHERE id = ?')
    .run(count, count, plan.id);

  const student = db.prepare('SELECT * FROM users WHERE id = ?').get(plan.user_id);
  sendEmail({
    to: student.email,
    subject: `${count} new MCQs assigned to you`,
    template: 'mcq_assignment',
    userId: student.id, createdBy: req.session.user.id, relatedType: 'mcq_assignment', relatedId: Number(assignmentId),
    html: `<p>Hi ${student.name},</p><p>Your teacher has assigned you ${count} new MCQs${topic ? ` on <b>${topic}</b>` : ''}. Log in to your Student Portal to start practicing.</p>`,
  });

  logAction(req, 'mcq_assignment_created', {
    recordType: 'mcq_assignment', recordId: assignmentId,
    newValue: { student: student.email, count, subject_id, year, topic },
  });
  notify(student.id, 'mcq_assignment', `${count} new MCQs assigned`, topic ? `Topic: ${topic}` : '', '/student/mcq/my', { email: false }); // email sent above

  req.flash('success', `${count} MCQs assigned to ${student.name}.`);
  res.redirect('/admin/assign');
});

// ---------- Unified "Assign Content to Students" page ----------
// Bulk, multi-student × multi-content-type assignment UI built ON TOP of the
// four existing per-content-type mechanisms above (exam_orders/exam_assignments,
// student_mcq_plans, mcq_assignments/mcq_assignment_questions, content_assignments).
// This does not replace any of them and does not create a fifth storage system.
router.get('/assign-content', (req, res) => {
  const students = db.prepare(
    "SELECT id, name, email, class_year, class_section FROM users WHERE role = 'student' ORDER BY name LIMIT 200"
  ).all();
  const yearLevels = [...new Set(students.map((s) => s.class_year).filter(Boolean))].sort();
  const classSections = [...new Set(students.map((s) => s.class_section).filter(Boolean))].sort();

  const mcqPlans = db.prepare(
    `SELECT p.*, s.name AS subject_name FROM mcq_plans p LEFT JOIN subjects s ON s.id = p.subject_id ORDER BY p.name`
  ).all();

  const mcqs = db.prepare(
    `SELECT m.id, m.question, m.topic, m.year, m.difficulty, s.name AS subject_name, s.id AS subject_id
     FROM mcqs m LEFT JOIN subjects s ON s.id = m.subject_id ORDER BY m.id DESC LIMIT 200`
  ).all();

  const tutorials = db.prepare(
    `SELECT t.id, t.title, t.year, t.duration_minutes, s.name AS subject_name FROM tutorials t LEFT JOIN subjects s ON s.id = t.subject_id WHERE t.is_published = 1 ORDER BY t.title`
  ).all();

  const studyMaterials = db.prepare(
    `SELECT m.id, m.title, m.year, m.file_type, s.name AS subject_name FROM study_materials m LEFT JOIN subjects s ON s.id = m.subject_id WHERE m.is_published = 1 ORDER BY m.title`
  ).all();

  const examPapers = db.prepare(
    `SELECT p.id, p.title, p.year, p.price, p.duration_minutes, s.name AS subject_name FROM exam_papers p JOIN subjects s ON s.id = p.subject_id WHERE p.is_published = 1 ORDER BY p.id DESC`
  ).all();

  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();

  res.render('admin/assign_content', {
    students, yearLevels, classSections, mcqPlans, mcqs, tutorials, studyMaterials, examPapers, subjects,
  });
});

router.post('/assign-content', (req, res) => {
  const { content_type, title, start_date, end_date, instructions } = req.body;
  const notifyOn = req.body.notify === 'on';
  const showDashboard = req.body.show_dashboard === 'on' ? 1 : 0;
  const compulsory = req.body.compulsory === 'on' ? 1 : 0;

  const studentIds = (Array.isArray(req.body.student_ids) ? req.body.student_ids : (req.body.student_ids ? [req.body.student_ids] : []))
    .map((v) => parseInt(v, 10)).filter(Boolean);
  const contentIds = (Array.isArray(req.body.content_ids) ? req.body.content_ids : (req.body.content_ids ? [req.body.content_ids] : []))
    .map((v) => parseInt(v, 10)).filter(Boolean);

  const VALID_TYPES = ['mcq-plans', 'individual-mcqs', 'tutorials', 'study-material', 'exam-papers'];

  if (!studentIds.length) { req.flash('error', 'Select at least one student.'); return res.redirect('/admin/assign-content'); }
  if (!contentIds.length) { req.flash('error', 'Select at least one content item to assign.'); return res.redirect('/admin/assign-content'); }
  if (!title || !title.trim()) { req.flash('error', 'Assignment title is required.'); return res.redirect('/admin/assign-content'); }
  if (!VALID_TYPES.includes(content_type)) { req.flash('error', 'Please choose a valid content type.'); return res.redirect('/admin/assign-content'); }

  const students = db.prepare(`SELECT * FROM users WHERE role='student' AND id IN (${studentIds.map(() => '?').join(',')})`).all(...studentIds);
  if (!students.length) { req.flash('error', 'None of the selected students could be found.'); return res.redirect('/admin/assign-content'); }

  let assigned = 0;
  let skipped = 0;
  const dueAt = end_date ? `${end_date} 23:59:00` : null;

  if (content_type === 'exam-papers') {
    // Reuses exam_orders + exam_assignments exactly as POST /admin/assign does,
    // looping over an explicit multi-student list instead of "all"/"one".
    const papers = db.prepare(`SELECT * FROM exam_papers WHERE id IN (${contentIds.map(() => '?').join(',')})`).all(...contentIds);
    const insertOrder = db.prepare('INSERT INTO exam_orders (user_id, paper_id, amount, payment_method, status) VALUES (?,?,?,?,?)');
    const insertAssignment = db.prepare(
      `INSERT INTO exam_assignments (order_id, user_id, paper_id, status, assigned_at, due_at, instructions, title, is_compulsory, show_in_dashboard)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    papers.forEach((paper) => {
      students.forEach((student) => {
        // Dedupe: skip a student+paper pair that already has an exam_assignments row for that paper.
        const existing = db.prepare(
          `SELECT ea.id FROM exam_assignments ea JOIN exam_orders eo ON eo.id = ea.order_id WHERE eo.user_id = ? AND ea.paper_id = ?`
        ).get(student.id, paper.id);
        if (existing) { skipped += 1; return; }
        const orderId = insertOrder.run(student.id, paper.id, 0, 'assigned_by_staff', 'paid').lastInsertRowid;
        const newAssignmentId = insertAssignment.run(orderId, student.id, paper.id, 'assigned', start_date ? `${start_date} 00:00:00` : new Date().toISOString(), dueAt, instructions || null, title.trim(), compulsory, showDashboard).lastInsertRowid;
        assigned += 1;
        if (notifyOn) {
          const subj = db.prepare('SELECT name FROM subjects WHERE id = ?').get(paper.subject_id);
          notify(student.id, 'paper_assignment', title.trim(), `"${paper.title}" has been assigned to you.`, `/student/exams/${newAssignmentId}`,
            { relatedType: 'exam_assignment', relatedId: Number(newAssignmentId), itemTitle: paper.title, subjectName: subj && subj.name, dueDate: dueAt, instructions, createdBy: req.session.user.id });
        }
      });
    });
  } else if (content_type === 'mcq-plans') {
    // Reuses student_mcq_plans exactly as the webhook/mcq-sets flows do for a
    // free/staff-granted plan (stripe_session_id NULL), for an explicit list of students.
    const plans = db.prepare(`SELECT * FROM mcq_plans WHERE id IN (${contentIds.map(() => '?').join(',')})`).all(...contentIds);
    const insertPlan = db.prepare(
      'INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at, stripe_session_id) VALUES (?,?,?,?,?,?,NULL)'
    );
    plans.forEach((plan) => {
      students.forEach((student) => {
        // Dedupe: skip a student who already has a non-expired grant of this exact plan.
        const existing = db.prepare(
          `SELECT id FROM student_mcq_plans WHERE user_id = ? AND plan_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`
        ).get(student.id, plan.id);
        if (existing) { skipped += 1; return; }
        const expiresAt = new Date(Date.now() + plan.validity_days * 86400000).toISOString();
        const grantId = insertPlan.run(student.id, plan.id, plan.subject_id || null, plan.year_level || null, plan.mcq_count, expiresAt).lastInsertRowid;
        assigned += 1;
        if (notifyOn) notify(student.id, 'mcq_assignment', title.trim(), `The MCQ plan "${plan.name}" has been assigned to you.`, '/student/mcq/plans',
          { relatedType: 'student_mcq_plan', relatedId: Number(grantId), itemTitle: plan.name, itemLabel: 'MCQ Plan', instructions, createdBy: req.session.user.id });
      });
    });
  } else if (content_type === 'individual-mcqs') {
    // Reuses mcq_assignments + mcq_assignment_questions and the Free-Plan-quota
    // find-or-create pattern from POST /admin/mcq-sets/:id/assign, but with an
    // explicit list of mcq_ids picked directly instead of expanding a set_id.
    const freePlan = db.prepare("SELECT * FROM mcq_plans WHERE name = 'Free Plan'").get();
    const insertAssignment = db.prepare(
      `INSERT INTO mcq_assignments (student_plan_id, user_id, subject_id, year, topic, mcq_count, due_date, teacher_note, assigned_by, title, instructions, is_compulsory, show_in_dashboard)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insertQ = db.prepare('INSERT INTO mcq_assignment_questions (assignment_id, mcq_id) VALUES (?,?)');

    students.forEach((student) => {
      // Which of the selected mcq_ids does this student already have assigned (any status)?
      const already = new Set(
        db.prepare(
          `SELECT DISTINCT aq.mcq_id FROM mcq_assignment_questions aq JOIN mcq_assignments a ON a.id = aq.assignment_id
           WHERE a.user_id = ? AND aq.mcq_id IN (${contentIds.map(() => '?').join(',')})`
        ).all(student.id, ...contentIds).map((r) => r.mcq_id)
      );
      const newIds = contentIds.filter((id) => !already.has(id));
      skipped += already.size;
      if (!newIds.length) return;

      let plan = db.prepare("SELECT sp.* FROM student_mcq_plans sp JOIN mcq_plans mp ON mp.id = sp.plan_id WHERE sp.user_id = ? AND mp.name = 'Free Plan'").get(student.id);
      if (!plan && freePlan) {
        const expiresAt = new Date(Date.now() + freePlan.validity_days * 86400000).toISOString();
        const planId = db.prepare(
          'INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at) VALUES (?,?,NULL,NULL,?,?)'
        ).run(student.id, freePlan.id, freePlan.mcq_count, expiresAt).lastInsertRowid;
        plan = db.prepare('SELECT * FROM student_mcq_plans WHERE id = ?').get(planId);
      }
      if (!plan) return; // no plan config on this instance — skip gracefully

      const count = newIds.length;
      if (plan.remaining_mcqs < count) {
        const shortfall = count - plan.remaining_mcqs;
        db.prepare('UPDATE student_mcq_plans SET remaining_mcqs = remaining_mcqs + ? WHERE id = ?').run(shortfall, plan.id);
      }
      const assignmentId = insertAssignment.run(
        plan.id, student.id, null, null, null, count, end_date || null, instructions || null, req.session.user.id,
        title.trim(), instructions || null, compulsory, showDashboard
      ).lastInsertRowid;
      newIds.forEach((mcqId) => insertQ.run(assignmentId, mcqId));
      db.prepare('UPDATE student_mcq_plans SET remaining_mcqs = remaining_mcqs - ?, assigned_mcqs = assigned_mcqs + ? WHERE id = ?')
        .run(count, count, plan.id);
      assigned += count;
      if (notifyOn) notify(student.id, 'mcq_assignment', title.trim(), `${count} question(s) assigned to you.`, '/student/mcq/my',
        { relatedType: 'mcq_assignment', relatedId: Number(assignmentId), itemTitle: title.trim(), itemLabel: 'MCQ Set', dueDate: end_date, instructions, createdBy: req.session.user.id });
    });
  } else {
    // tutorials | study-material — reuses content_assignments exactly like
    // POST /admin/assign-tutorial and /admin/assign-material, looping over an
    // explicit multi-student × multi-content list. The table's own
    // UNIQUE(user_id, content_type, content_id) constraint is the dedupe guard.
    const ctype = content_type === 'tutorials' ? 'tutorial' : 'study_material';
    const insert = db.prepare(
      `INSERT INTO content_assignments (user_id, content_type, content_id, amount, payment_method, assigned_by, status, due_date, instructions, title, is_compulsory, show_in_dashboard)
       VALUES (?,?,?,0,'manual',?,'assigned',?,?,?,?,?)`
    );
    const table = ctype === 'tutorial' ? 'tutorials' : 'study_materials';
    contentIds.forEach((contentId) => {
      const item = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(contentId);
      if (!item) return;
      students.forEach((student) => {
        try {
          insert.run(student.id, ctype, contentId, req.session.user.id, end_date || null, instructions || null, title.trim(), compulsory, showDashboard);
          assigned += 1;
          if (notifyOn) notify(student.id, 'content_assignment', title.trim(), `"${item.title}" has been assigned to you.`, ctype === 'tutorial' ? '/student/tutorials' : '/student/material',
            { relatedType: ctype, relatedId: contentId, itemTitle: item.title, itemLabel: ctype === 'tutorial' ? 'Tutorial' : 'Study Material', dueDate: end_date, instructions, createdBy: req.session.user.id });
        } catch (e) {
          // UNIQUE(user_id, content_type, content_id) already exists — skip, don't fail the batch.
          skipped += 1;
        }
      });
    });
  }

  logAction(req, 'bulk_content_assigned', {
    recordType: 'assign_content', recordId: null,
    newValue: { content_type, students: students.length, content_ids: contentIds, assigned, skipped, title: title.trim() },
  });

  if (assigned === 0 && skipped > 0) {
    req.flash('error', `Nothing new to assign — all ${skipped} student/content combination(s) already had access.`);
  } else if (skipped > 0) {
    req.flash('success', `Assigned to ${assigned} student/content combination(s) — ${skipped} already had access and were skipped.`);
  } else {
    req.flash('success', `Assigned "${title.trim()}" to ${students.length} student(s) successfully.`);
  }
  res.redirect('/admin/assign-content');
});

// ---------- Orders & Payments (two tabs on ONE page: Portal MCQ orders vs
// website/WooCommerce orders — split from the old single combined list) ----------

function csvEscapeOrders(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

// ---- Tab 1: MCQ Portal Orders & Payments (student_mcq_plans only — MCQ
// Plans are ONLY ever sold inside the portal, per webhook.js) ----
function buildMcqOrdersQuery(req) {
  const { search, plan_id, payment_status, date_from, date_to } = req.query;
  let sql = `
    SELECT sp.id, sp.user_id, sp.plan_id, sp.subject_id, sp.amount_paid AS amount,
           sp.stripe_session_id, sp.purchased_at AS created_at, sp.expires_at, sp.remaining_mcqs,
           mp.name AS plan_name, mp.mcq_count,
           u.name AS student_name, u.email,
           s.name AS subject_name
    FROM student_mcq_plans sp
    JOIN mcq_plans mp ON mp.id = sp.plan_id
    JOIN users u ON u.id = sp.user_id
    LEFT JOIN subjects s ON s.id = sp.subject_id
    WHERE 1=1`;
  const params = [];
  if (search) {
    sql += ' AND (u.name LIKE ? OR mp.name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (plan_id) { sql += ' AND sp.plan_id = ?'; params.push(plan_id); }
  if (date_from) { sql += ' AND date(sp.purchased_at) >= date(?)'; params.push(date_from); }
  if (date_to) { sql += ' AND date(sp.purchased_at) <= date(?)'; params.push(date_to); }
  sql += ' ORDER BY sp.purchased_at DESC';

  let rows = db.prepare(sql).all(...params);
  rows = rows.map((r) => ({
    ...r,
    payment_method: r.stripe_session_id ? 'stripe' : 'free/demo',
    // Every student_mcq_plans row represents a completed portal purchase —
    // there is no real pending/refunded state tracked for MCQ plans today
    // (see webhook.js comment: MCQ plans are portal-only and always paid).
    payment_status: 'paid',
    // "Active" = access hasn't time-expired yet. We deliberately do NOT use
    // remaining_mcqs here — running out of quota isn't the same as the
    // purchase itself expiring — and there is no revoke/is_active flag on
    // student_mcq_plans, so "Revoked" is never shown (nothing can produce it).
    access_status: (!r.expires_at || new Date(r.expires_at) > new Date()) ? 'Active' : 'Expired',
  }));
  if (payment_status && payment_status !== 'All') {
    rows = rows.filter((r) => r.payment_status === payment_status.toLowerCase());
  }
  return rows;
}

router.get('/orders/export', (req, res) => {
  const source = req.query.source === 'woocommerce' ? 'woocommerce' : 'mcq';
  const lines = [];
  if (source === 'mcq') {
    const rows = buildMcqOrdersQuery(req);
    lines.push(['Student', 'Email', 'Plan', 'MCQ Count', 'Subject', 'Amount', 'Payment Status', 'Order Date', 'Access Status'].map(csvEscapeOrders).join(','));
    rows.forEach((r) => {
      lines.push([
        r.student_name, r.email, r.plan_name, r.mcq_count, r.subject_name || 'All Subjects',
        r.amount, r.payment_status, r.created_at, r.access_status,
      ].map(csvEscapeOrders).join(','));
    });
    res.setHeader('Content-Disposition', 'attachment; filename="mcq-orders.csv"');
  } else {
    const rows = buildWooOrdersQuery(req);
    lines.push(['Order ID', 'Customer', 'Email', 'Product', 'Product Type', 'Total', 'Payment Method', 'Payment Status', 'Order Status', 'Order Date'].map(csvEscapeOrders).join(','));
    rows.forEach((r) => {
      lines.push([
        r.woo_order_id || r.id, r.student_name, r.email, r.item, r.product_type,
        r.amount, r.payment_method, r.status, r.order_status, r.created_at,
      ].map(csvEscapeOrders).join(','));
    });
    res.setHeader('Content-Disposition', 'attachment; filename="woocommerce-orders.csv"');
  }
  res.setHeader('Content-Type', 'text/csv');
  res.send(lines.join('\n'));
});

// ---- Tab 2: WooCommerce Orders & Payments (exam_orders + content_assignments —
// everything from the website/WooCommerce or manually assigned by staff,
// EXCLUDING MCQ plans) ----
function buildWooOrdersQuery(req) {
  const { search, order_status, product_type, payment_method } = req.query;

  const paperOrders = db.prepare(
    `SELECT o.id, o.user_id, o.amount, o.payment_method, o.status, o.order_status, o.created_at, o.woo_order_id,
            p.title AS item, u.name AS student_name, u.email, 'exam_paper' AS product_type
     FROM exam_orders o
     JOIN exam_papers p ON p.id = o.paper_id
     JOIN users u ON u.id = o.user_id`
  ).all();

  const contentOrders = db.prepare(
    `SELECT ca.id, ca.user_id, ca.amount, ca.payment_method, ca.status, ca.order_status, ca.assigned_at AS created_at,
            ca.woo_order_id, ca.content_type, ca.content_id, u.name AS student_name, u.email
     FROM content_assignments ca JOIN users u ON u.id = ca.user_id`
  ).all().map((r) => {
    const table = r.content_type === 'tutorial' ? 'tutorials' : 'study_materials';
    const item = db.prepare(`SELECT title FROM ${table} WHERE id = ?`).get(r.content_id);
    return {
      ...r,
      item: item ? item.title : `(deleted ${r.content_type.replace('_', ' ')})`,
      product_type: r.content_type,
    };
  });

  let rows = [...paperOrders, ...contentOrders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => (
      String(r.woo_order_id || r.id).toLowerCase().includes(q)
      || (r.student_name || '').toLowerCase().includes(q)
      || (r.email || '').toLowerCase().includes(q)
      || (r.item || '').toLowerCase().includes(q)
    ));
  }
  if (order_status && order_status !== 'All') rows = rows.filter((r) => r.order_status === order_status.toLowerCase());
  if (product_type && product_type !== 'All') rows = rows.filter((r) => r.product_type === product_type);
  if (payment_method && payment_method !== 'All') rows = rows.filter((r) => r.payment_method === payment_method);

  return rows;
}

const PRODUCT_TYPE_LABELS = { exam_paper: 'Full Exam Paper', study_material: 'Study Material', tutorial: 'Tutorial' };
const ORDER_STATUS_LABELS = { completed: 'Completed', processing: 'Processing', 'on-hold': 'On Hold', refunded: 'Refunded', cancelled: 'Cancelled' };

router.get('/orders', (req, res) => {
  const source = req.query.source === 'woocommerce' ? 'woocommerce' : (req.query.source === 'mcq' ? 'mcq' : 'woocommerce');
  const pageSize = 10;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  if (source === 'mcq') {
    const allRows = buildMcqOrdersQuery(req);
    const totalRows = allRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pageSafe = Math.min(page, totalPages);
    const rows = allRows.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

    const kpi = {
      totalOrders: allRows.length,
      totalRevenue: allRows.reduce((s, r) => s + Number(r.amount || 0), 0),
      activePlans: allRows.filter((r) => r.access_status === 'Active').length,
      // Real 0s: no distinct pending or refunded state exists for MCQ portal
      // purchases (every row is created already "paid" — see webhook.js).
      pendingOrders: allRows.filter((r) => r.payment_status === 'pending').length,
      refundedOrders: allRows.filter((r) => r.payment_status === 'refunded').length,
    };
    const statusCounts = {
      all: allRows.length,
      paid: allRows.filter((r) => r.payment_status === 'paid').length,
      pending: allRows.filter((r) => r.payment_status === 'pending').length,
      refunded: allRows.filter((r) => r.payment_status === 'refunded').length,
      failed: allRows.filter((r) => r.payment_status === 'failed').length,
    };
    const plans = db.prepare('SELECT id, name, mcq_count FROM mcq_plans ORDER BY name').all();

    return res.render('admin/orders', {
      source, filters: req.query,
      mcq: { kpi, statusCounts, rows, plans, pagination: { page: pageSafe, totalPages, totalRows, pageSize } },
    });
  }

  const allRows = buildWooOrdersQuery(req);
  const totalRows = allRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const pageSafe = Math.min(page, totalPages);
  const rows = allRows.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

  const totalOrders = allRows.length;
  const totalRevenue = allRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const completed = allRows.filter((r) => r.order_status === 'completed').length;
  const processing = allRows.filter((r) => r.order_status === 'processing').length;
  const refunded = allRows.filter((r) => r.order_status === 'refunded').length;
  const onHold = allRows.filter((r) => r.order_status === 'on-hold').length;

  // Real previous-calendar-month comparison for Total Orders/Revenue, computed
  // from actual created_at timestamps — "—" (null delta) when there isn't at
  // least one full prior calendar month of real data to compare against,
  // rather than fabricating a percentage.
  const now = new Date();
  const curMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const curRows = allRows.filter((r) => new Date(r.created_at) >= curMonthStart);
  const prevRows = allRows.filter((r) => new Date(r.created_at) >= prevMonthStart && new Date(r.created_at) < curMonthStart);
  const pctDelta = (curVal, prevVal) => {
    if (!prevRows.length || !prevVal) return null; // no real prior-month data to compare — show "—"
    return Math.round(((curVal - prevVal) / prevVal) * 100);
  };
  const ordersDelta = pctDelta(curRows.length, prevRows.length);
  const revenueDelta = pctDelta(
    curRows.reduce((s, r) => s + Number(r.amount || 0), 0),
    prevRows.reduce((s, r) => s + Number(r.amount || 0), 0),
  );

  const kpi = {
    totalOrders, totalRevenue, completed, processing, refunded, onHold,
    ordersDelta, revenueDelta,
    completedPct: totalOrders ? Math.round((completed * 100) / totalOrders) : null,
    processingPct: totalOrders ? Math.round((processing * 100) / totalOrders) : null,
    refundedPct: totalOrders ? Math.round((refunded * 100) / totalOrders) : null,
    onHoldPct: totalOrders ? Math.round((onHold * 100) / totalOrders) : null,
  };
  const statusCounts = {
    All: allRows.length,
    completed: kpi.completed,
    processing: kpi.processing,
    'on-hold': kpi.onHold,
    refunded: kpi.refunded,
    cancelled: allRows.filter((r) => r.order_status === 'cancelled').length,
  };
  const paymentMethods = db.prepare(
    `SELECT DISTINCT payment_method FROM (
       SELECT payment_method FROM exam_orders WHERE payment_method IS NOT NULL
       UNION
       SELECT payment_method FROM content_assignments WHERE payment_method IS NOT NULL
     ) ORDER BY payment_method`
  ).all().map((r) => r.payment_method);

  res.render('admin/orders', {
    source, filters: req.query,
    woo: {
      kpi, statusCounts, rows, paymentMethods,
      productTypeLabels: PRODUCT_TYPE_LABELS, orderStatusLabels: ORDER_STATUS_LABELS,
      pagination: { page: pageSafe, totalPages, totalRows, pageSize },
    },
  });
});

// WooCommerce order_status -> our ALLOWED_ORDER_STATUSES. 'pending' and
// 'failed' (and anything unrecognized, e.g. 'trash') are intentionally NOT
// mapped: WooCommerce itself hasn't confirmed payment for these, so Sync Now
// never creates an exam_orders/content_assignments row (and therefore never
// grants portal access) for them — they are reported back as "skipped",
// matching the real webhook's behaviour of only ever firing once an order
// is actually completed.
const WOO_STATUS_MAP = { completed: 'completed', processing: 'processing', 'on-hold': 'on-hold', refunded: 'refunded', cancelled: 'cancelled' };

// Finds which of exam_papers / tutorials / study_materials a WooCommerce
// line item's product_id maps to, returning the product_type string
// processWooLineItem() expects, or null if nothing matches (same lookup
// processWooLineItem already does internally — done here only to report
// an accurate "skipped (unmatched product)" count without double-querying
// inside the shared function for every status branch).
function resolveWooProductType(wooProductId, title) {
  if (wooProductId) {
    if (db.prepare('SELECT id FROM exam_papers WHERE woo_product_id = ?').get(String(wooProductId))) return 'exam_paper';
    if (db.prepare('SELECT id FROM tutorials WHERE woo_product_id = ?').get(String(wooProductId))) return 'tutorial';
    if (db.prepare('SELECT id FROM study_materials WHERE woo_product_id = ?').get(String(wooProductId))) return 'study_material';
  }
  if (title) {
    if (db.prepare('SELECT id FROM exam_papers WHERE title = ?').get(title)) return 'exam_paper';
    if (db.prepare('SELECT id FROM tutorials WHERE title = ?').get(title)) return 'tutorial';
    if (db.prepare('SELECT id FROM study_materials WHERE title = ?').get(title)) return 'study_material';
  }
  return null;
}

// ---------- Sync Now: real WooCommerce REST API pull ----------
// Reuses processWooLineItem() from webhook.js for every single line item —
// the exact same student-lookup / product-match / upsert-by-woo_order_id /
// access-grant logic the inbound webhook already uses. This route does NOT
// re-implement any of that; it only fetches orders and loops line items.
router.post('/orders/sync', requireAdminOnly, async (req, res) => {
  let wooOrders;
  try {
    wooOrders = await wooApi.fetchRecentOrders();
  } catch (err) {
    logAction(req, 'woo_sync_failed', { recordType: 'site_settings', newValue: { error: err.message } });
    req.flash('error', `WooCommerce sync failed: ${err.message}`);
    return res.redirect('/admin/orders?source=woocommerce');
  }

  let created = 0; let updated = 0; let duplicate = 0; let skippedStatus = 0; let skippedProduct = 0; let failed = 0;

  wooOrders.forEach((order) => {
    const statusKey = WOO_STATUS_MAP[String(order.status || '').toLowerCase()];
    const billing = order.billing || {};
    const email = billing.email || order.billing_email;
    const name = [billing.first_name, billing.last_name].filter(Boolean).join(' ') || billing.company || email;
    const paymentMethod = order.payment_method_title || order.payment_method || 'woocommerce';
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

    if (!statusKey) { skippedStatus += lineItems.length || 1; return; }
    if (!email || !name) { skippedStatus += lineItems.length || 1; return; }

    lineItems.forEach((li) => {
      const productType = resolveWooProductType(li.product_id, li.name);
      if (!productType) { skippedProduct += 1; return; }

      const result = processWooLineItem(req, {
        order_id: order.id,
        email, name,
        amount: Number(li.total) || 0,
        payment_method: paymentMethod,
        woo_product_id: li.product_id,
        product_type: productType,
        product_title: li.name,
        order_status: statusKey,
        send_email: false, // bulk sync shouldn't spam purchase emails for historical orders
      });

      if (!result.ok) { failed += 1; return; }
      if (result.action === 'created') created += 1;
      else if (result.action === 'updated') updated += 1;
      else duplicate += 1;
    });
  });

  logAction(req, 'woo_sync_completed', {
    recordType: 'site_settings',
    newValue: { fetched: wooOrders.length, created, updated, duplicate, skippedStatus, skippedProduct, failed },
  });

  const parts = [`${created} created`, `${updated} updated`];
  if (duplicate) parts.push(`${duplicate} unchanged`);
  if (skippedProduct) parts.push(`${skippedProduct} skipped (unmatched product)`);
  if (skippedStatus) parts.push(`${skippedStatus} skipped (pending/failed/unmapped status)`);
  if (failed) parts.push(`${failed} failed`);
  req.flash('success', `WooCommerce sync complete — ${parts.join(', ')}.`);
  res.redirect('/admin/orders?source=woocommerce');
});

// ---------- Real "View Order" detail (JSON, fetched by the modal) ----------
router.get('/orders/:id/detail', (req, res) => {
  const { id } = req.params;
  const type = req.query.type === 'content_assignment' ? 'content_assignment' : 'exam_paper';

  let row;
  if (type === 'exam_paper') {
    row = db.prepare(
      `SELECT o.*, p.title AS item, p.price AS list_price, u.name AS student_name, u.email, u.phone,
              'exam_paper' AS product_type
       FROM exam_orders o JOIN exam_papers p ON p.id = o.paper_id JOIN users u ON u.id = o.user_id
       WHERE o.id = ?`
    ).get(id);
  } else {
    row = db.prepare(
      `SELECT ca.*, u.name AS student_name, u.email, u.phone
       FROM content_assignments ca JOIN users u ON u.id = ca.user_id WHERE ca.id = ?`
    ).get(id);
    if (row) {
      const table = row.content_type === 'tutorial' ? 'tutorials' : 'study_materials';
      const item = db.prepare(`SELECT title FROM ${table} WHERE id = ?`).get(row.content_id);
      row.item = item ? item.title : `(deleted ${row.content_type.replace('_', ' ')})`;
      row.product_type = row.content_type;
      row.created_at = row.assigned_at;
    }
  }

  if (!row) return res.status(404).json({ ok: false, error: 'Order not found' });

  const history = row.woo_order_id
    ? db.prepare(
        `SELECT status, error, received_at, processed_at FROM payment_webhook_events
         WHERE event_id LIKE ? ORDER BY received_at DESC LIMIT 10`
      ).all(`${row.woo_order_id}:%`)
    : [];

  res.json({
    ok: true,
    order: {
      id: row.id, woo_order_id: row.woo_order_id, order_display: row.woo_order_id ? `#${row.woo_order_id}` : `#${String(row.id).padStart(4, '0')}`,
      student_name: row.student_name, email: row.email, phone: row.phone || null,
      item: row.item, product_type: row.product_type,
      amount: Number(row.amount || 0), payment_method: row.payment_method,
      status: row.status, order_status: row.order_status,
      order_status_label: ORDER_STATUS_LABELS[row.order_status] || row.order_status,
      created_at: row.created_at,
      product_type_label: PRODUCT_TYPE_LABELS[row.product_type] || row.product_type,
    },
    history,
  });
});

// ---------- "More options" — manual order-status update (gated by same staff auth as the rest of admin.js) ----------
router.post('/orders/:id/status', (req, res) => {
  const { id } = req.params;
  const { type, order_status } = req.body || {};
  const table = type === 'content_assignment' ? 'content_assignments' : 'exam_orders';
  if (!ORDER_STATUS_LABELS[order_status]) {
    return res.status(400).json({ ok: false, error: `Invalid order_status "${order_status}"` });
  }
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'Order not found' });

  db.prepare(`UPDATE ${table} SET order_status = ? WHERE id = ?`).run(order_status, id);
  logAction(req, 'order_status_updated', { recordType: table, recordId: Number(id), newValue: { order_status } });
  res.json({ ok: true, order_status, order_status_label: ORDER_STATUS_LABELS[order_status] });
});

// ---------- Webhook Logs (Phase 3: security & idempotency visibility) ----------
router.get('/webhook-logs', (req, res) => {
  const events = db.prepare('SELECT * FROM payment_webhook_events ORDER BY received_at DESC LIMIT 200').all();
  res.render('admin/webhook_logs', { events });
});

// ---------- Email Logs (see what was actually sent — crucial in demo mode, since
// this is the only place to read a verification link or OTP code without real SMTP) ----------
router.get('/email-logs', (req, res) => {
  const logs = db.prepare("SELECT * FROM email_logs WHERE status NOT IN ('scheduled','draft') ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 200").all();
  res.render('admin/email_logs', { logs });
});

// Email Notifications (list / preview / reply / forward / resend / unread / delete) lives in
// routes/emailNotifications.js, mounted at /admin/email-notifications in app.js.

// ---------- Audit Log (Phase 3: who did what, when) ----------
router.get('/audit-logs', (req, res) => {
  const filters = {};
  ['search', 'action'].forEach((k) => { if (typeof req.query[k] === 'string' && req.query[k].trim()) filters[k] = req.query[k].trim(); });

  const actions = db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all().map((r) => r.action);

  const where = [];
  const params = [];
  if (filters.search) {
    const like = `%${filters.search}%`;
    where.push('(user_label LIKE ? OR action LIKE ? OR record_type LIKE ?)');
    params.push(like, like, like);
  }
  if (filters.action) { where.push('action = ?'); params.push(filters.action); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalCount = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT 300`).all(...params);
  res.render('admin/audit_logs', { rows, filters, actions, totalCount });
});

// ---------- Question Issues (student-reported problems) ----------
router.get('/question-issues', (req, res) => {
  const issues = db.prepare(
    `SELECT qi.*, u.name AS reporter_name, u.email AS reporter_email
     FROM question_issues qi
     LEFT JOIN users u ON u.id = qi.reported_by
     ORDER BY qi.status ASC, qi.created_at DESC`
  ).all().map((issue) => {
    if (issue.question_type === 'mcq') {
      issue.questionText = db.prepare('SELECT question, correct_option FROM mcqs WHERE id = ?').get(issue.question_id);
    } else {
      issue.questionText = db.prepare('SELECT question, correct_option FROM exam_paper_questions WHERE id = ?').get(issue.question_id);
    }
    return issue;
  });
  res.render('admin/question_issues', { issues });
});

router.post('/question-issues/:id/resolve', (req, res) => {
  const issue = db.prepare('SELECT * FROM question_issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.redirect('/admin/question-issues');
  const { resolution_action, new_correct_option } = req.body;

  if (issue.question_type === 'mcq') {
    const mcq = db.prepare('SELECT * FROM mcqs WHERE id = ?').get(issue.question_id);
    if (resolution_action === 'correct_answer_key' && new_correct_option) {
      db.prepare('UPDATE mcqs SET correct_option = ? WHERE id = ?').run(new_correct_option, mcq.id);
      // Recompute correctness for every already-answered instance of this
      // question across all students' MCQ assignments.
      db.prepare(
        `UPDATE mcq_assignment_questions SET is_correct = (selected_option = ?)
         WHERE mcq_id = ? AND answered_at IS NOT NULL`
      ).run(new_correct_option, mcq.id);
      logAction(req, 'answer_key_corrected', { recordType: 'mcq', recordId: mcq.id, oldValue: { correct_option: mcq.correct_option }, newValue: { correct_option: new_correct_option } });
    } else if (resolution_action === 'give_full_marks' || resolution_action === 'exclude_from_scoring') {
      // For MCQs, both mean "don't penalize the student" — mark every
      // already-answered instance as correct.
      db.prepare(
        `UPDATE mcq_assignment_questions SET is_correct = 1 WHERE mcq_id = ? AND answered_at IS NOT NULL`
      ).run(mcq.id);
      logAction(req, resolution_action, { recordType: 'mcq', recordId: mcq.id, newValue: { forced_correct: true } });
    }
  } else {
    const q = db.prepare('SELECT * FROM exam_paper_questions WHERE id = ?').get(issue.question_id);
    const affectedSubmissionIds = db.prepare(
      'SELECT DISTINCT submission_id FROM exam_answers WHERE question_id = ?'
    ).all(q.id).map((r) => r.submission_id);

    if (resolution_action === 'correct_answer_key' && new_correct_option) {
      db.prepare('UPDATE exam_paper_questions SET correct_option = ? WHERE id = ?').run(new_correct_option, q.id);
      db.prepare(
        `UPDATE exam_answers SET is_correct = (selected_option = ?), marks_awarded = (CASE WHEN selected_option = ? THEN ? ELSE 0 END)
         WHERE question_id = ?`
      ).run(new_correct_option, new_correct_option, q.marks, q.id);
      logAction(req, 'answer_key_corrected', { recordType: 'exam_paper_question', recordId: q.id, oldValue: { correct_option: q.correct_option }, newValue: { correct_option: new_correct_option } });
    } else if (resolution_action === 'give_full_marks') {
      db.prepare('UPDATE exam_answers SET marks_awarded = ?, is_correct = 1 WHERE question_id = ?').run(q.marks, q.id);
      logAction(req, 'give_full_marks', { recordType: 'exam_paper_question', recordId: q.id, newValue: { marks: q.marks } });
    } else if (resolution_action === 'exclude_from_scoring') {
      db.prepare('UPDATE exam_paper_questions SET excluded_from_scoring = 1 WHERE id = ?').run(q.id);
      logAction(req, 'exclude_from_scoring', { recordType: 'exam_paper_question', recordId: q.id });
    }

    // Historical results are never silently left stale — every affected
    // submission's totals are recalculated right away.
    affectedSubmissionIds.forEach((sid) => recomputeExamSubmission(sid));
  }

  db.prepare(
    `UPDATE question_issues SET status = 'resolved', resolution_action = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(resolution_action, req.session.user.id, issue.id);

  req.flash('success', 'Issue resolved and affected results updated.');
  res.redirect('/admin/question-issues');
});

// ---------- Teachers (admin only) ----------
function requireAdminOnly(req, res, next) {
  if (req.session.user.role !== 'admin') {
    req.flash('error', 'Only admin can do this');
    return res.redirect('/admin/dashboard');
  }
  next();
}

router.get('/teachers', requireAdminOnly, (req, res) => {
  const teachers = db.prepare("SELECT * FROM users WHERE role = 'teacher' ORDER BY id DESC").all();
  res.render('admin/teachers', { teachers });
});

router.post('/teachers', requireAdminOnly, (req, res) => {
  const { name, email, password } = req.body;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    req.flash('error', 'An account with this email already exists');
    return res.redirect('/admin/teachers');
  }
  const hash = bcrypt.hashSync(password, 8);
  db.prepare('INSERT INTO users (name, email, password, role, email_verified) VALUES (?,?,?,?,1)').run(name, email, hash, 'teacher');
  req.flash('success', 'Teacher account created');
  res.redirect('/admin/teachers');
});

router.post('/teachers/:id/delete', requireAdminOnly, (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'teacher'").run(req.params.id);
  req.flash('success', 'Teacher account removed');
  res.redirect('/admin/teachers');
});

// ---------- Announcements (Notice Board) ----------
router.get('/announcements', (req, res) => {
  const announcements = db.prepare(
    `SELECT a.*, u.name AS author_name FROM announcements a LEFT JOIN users u ON u.id = a.created_by
     ORDER BY a.pinned DESC, a.created_at DESC`
  ).all();
  res.render('admin/announcements', { announcements });
});

router.post('/announcements', (req, res) => {
  const title = (req.body.title || '').trim();
  const body = (req.body.body || '').trim();
  const audience = ['all', 'Year 11', 'Year 12'].includes(req.body.audience) ? req.body.audience : 'all';
  if (!title || !body) { req.flash('error', 'Title and message are required.'); return res.redirect('/admin/announcements'); }
  db.prepare('INSERT INTO announcements (title, body, audience, pinned, created_by) VALUES (?,?,?,?,?)')
    .run(title, body, audience, req.body.pinned ? 1 : 0, req.session.user.id);
  logAction(req, 'announcement_posted', { recordType: 'announcement', newValue: { title, audience } });
  req.flash('success', 'Announcement posted — students will see it on their dashboard.');
  res.redirect('/admin/announcements');
});

router.post('/announcements/:id/pin', (req, res) => {
  const row = db.prepare('SELECT pinned FROM announcements WHERE id = ?').get(req.params.id);
  if (row) db.prepare('UPDATE announcements SET pinned = ? WHERE id = ?').run(row.pinned ? 0 : 1, req.params.id);
  res.redirect('/admin/announcements');
});

router.post('/announcements/:id/delete', (req, res) => {
  const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  if (row) logAction(req, 'announcement_deleted', { recordType: 'announcement', oldValue: { title: row.title } });
  req.flash('success', 'Announcement removed.');
  res.redirect('/admin/announcements');
});

// ---------- Leaderboard (ranks students by average exam score) ----------
router.get('/leaderboard', (req, res) => {
  const year = ['Year 11', 'Year 12'].includes(req.query.year) ? req.query.year : '';
  const subjectId = req.query.subject_id ? parseInt(req.query.subject_id, 10) : null;

  let sql = `
    SELECT u.id AS user_id, u.name, u.profile_image,
           ROUND(AVG(100.0 * s.total_score / NULLIF(s.total_marks, 0)), 1) AS avg_pct,
           COUNT(DISTINCT s.id) AS exams_taken
    FROM exam_submissions s
    JOIN exam_assignments a ON a.id = s.assignment_id
    JOIN exam_papers p ON p.id = a.paper_id
    JOIN users u ON u.id = a.user_id
    WHERE s.status = 'published' AND s.total_marks > 0`;
  const params = [];
  if (year) { sql += ' AND p.year = ?'; params.push(year); }
  if (subjectId) { sql += ' AND p.subject_id = ?'; params.push(subjectId); }
  sql += ' GROUP BY u.id HAVING exams_taken > 0 ORDER BY avg_pct DESC, exams_taken DESC LIMIT 50';

  const leaders = db.prepare(sql).all(...params);
  const subjects = db.prepare('SELECT id, name, year FROM subjects ORDER BY name').all();
  res.render('admin/leaderboard', { leaders, subjects, filters: { year, subject_id: subjectId } });
});

// ---------- Settings (logo = admin only, password = any staff) ----------
const EMAIL_TEMPLATES = [
  { key: 'verification', label: 'Email Verification' },
  { key: 'password_reset', label: 'Password Reset' },
  { key: 'mcq_assignment', label: 'MCQ Assignment' },
  { key: 'purchase_account_created', label: 'Paper Purchase — New Account' },
  { key: 'purchase_paper_assigned', label: 'Paper Purchase — Existing Account' },
];

router.get('/settings', (req, res) => {
  const logo = db.prepare("SELECT value FROM site_settings WHERE key = 'logo_url'").get();
  const heroImg = db.prepare("SELECT value FROM site_settings WHERE key = 'hero_image_url'").get();
  const fontRow = db.prepare("SELECT value FROM site_settings WHERE key = 'theme_font_family'").get();
  const colorRow = db.prepare("SELECT value FROM site_settings WHERE key = 'theme_primary_color'").get();

  const generalKeys = ['platform_name', 'contact_email', 'website_url', 'timezone', 'portal_description'];
  const general = {};
  generalKeys.forEach((k) => {
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(k);
    general[k] = row ? row.value : '';
  });

  const teacherCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='teacher'").get().c;
  const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;

  const smsEnabledRow = db.prepare("SELECT value FROM site_settings WHERE key = 'sms_otp_enabled'").get();
  const smsProviderChoiceRow = db.prepare("SELECT value FROM site_settings WHERE key = 'sms_provider_choice'").get();
  const smsCfg = require('../lib/smsConfig');
  const otpStatus = {
    smsEnabled: smsEnabledRow ? smsEnabledRow.value === '1' : false,
    providerChoice: smsProviderChoiceRow ? smsProviderChoiceRow.value : 'not_decided',
    providerConfigured: smsCfg.isConfigured(),
    envProvider: process.env.SMS_PROVIDER || 'none',
    source: smsCfg.getSource(), // 'settings' | 'env' | 'none' — where the active credentials came from
    fields: smsCfg.FIELDS, // { twilio: [...], msg91: [...], ... } — which inputs to render per provider
    fieldStatus: {
      twilio: smsCfg.getFieldStatus('twilio'),
      twilio_whatsapp: smsCfg.getFieldStatus('twilio_whatsapp'),
      msg91: smsCfg.getFieldStatus('msg91'),
      whatsapp_business: smsCfg.getFieldStatus('whatsapp_business'),
    },
  };

  const templateStates = EMAIL_TEMPLATES.map((t) => {
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(`email_template_enabled_${t.key}`);
    return { ...t, enabled: !row || row.value !== '0' }; // default ON if never toggled
  });

  // Payment status now reflects Settings-stored Stripe keys (with .env fallback).
  const { getStripeKeys } = require('../lib/stripeConfig');
  const liveStripeKeys = getStripeKeys();
  const paymentStatus = {
    stripeConfigured: !!liveStripeKeys.secretKey,
    stripeMode: liveStripeKeys.secretKey
      ? (liveStripeKeys.secretKey.startsWith('sk_live_') ? 'Live' : 'Test')
      : 'Not configured (plans activate instantly in demo mode)',
    currency: 'AUD',
    webhookSecretConfigured: !!process.env.WOO_WEBHOOK_SECRET,
  };
  const stripeKeys = {
    publishableKey: liveStripeKeys.publishableKey,
    secretKeySet: !!liveStripeKeys.secretKey,
    secretKeyMasked: liveStripeKeys.secretKey ? liveStripeKeys.secretKey.slice(-4) : '',
    webhookSecretSet: !!liveStripeKeys.webhookSecret,
    webhookUrl: `${req.protocol}://${req.get('host')}/webhook/stripe`,
  };
  const smtpStatus = {
    configured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
    fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '—',
  };

  const loginTextKeys = [
    'brand_name', 'brand_tagline',
    'login_student_tag', 'login_student_hero_title', 'login_student_hero_text',
    'login_student_bullet1', 'login_student_bullet2', 'login_student_bullet3',
    'login_student_title', 'login_student_subtitle',
    'login_staff_tag', 'login_staff_hero_title', 'login_staff_hero_text',
    'login_staff_bullet1', 'login_staff_bullet2', 'login_staff_bullet3',
    'login_staff_title', 'login_staff_subtitle',
  ];
  const loginText = {};
  loginTextKeys.forEach((k) => {
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(k);
    loginText[k] = row ? row.value : '';
  });

  const extraKeys = [
    'display_language', 'google_sso_enabled', 'microsoft_sso_enabled', 'remember_me_enabled',
    'maintenance_mode', 'debug_logging', 'from_name', 'from_email', 'email_footer',
    'notify_on_submission', 'notify_on_grade_published', 'currency', 'gst_rate', 'order_prefix',
    'invoice_notes', 'payment_notify_on_failed', 'password_min_length', 'password_expiry_days',
    'require_special_chars', 'enforce_2fa', 'session_timeout_minutes', 'ip_whitelist', 'brand_tagline',
  ];
  const extra = {};
  extraKeys.forEach((k) => {
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(k);
    extra[k] = row ? row.value : '';
  });

  const teacherProfile = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const studentCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='student'").get().c;

  const wooCreds = wooApi.getWooCredentials();
  const wooSettings = {
    storeUrl: wooCreds.storeUrl,
    consumerKeySet: !!wooCreds.consumerKey,
    consumerKeyMasked: wooCreds.consumerKey ? wooCreds.consumerKey.slice(-4) : '',
    consumerSecretSet: !!wooCreds.consumerSecret,
    configured: wooApi.isConfigured(),
  };

  res.render('admin/settings', { logoUrl: logo ? logo.value : '', heroImageUrl: heroImg ? heroImg.value : '', templateStates, paymentStatus, stripeKeys, smtpStatus, currentFont: fontRow ? fontRow.value : 'Inter', currentColor: colorRow ? colorRow.value : '#566dfb', general, teacherCount, adminCount, studentCount, otpStatus, loginTextForm: loginText, extra, teacherProfile, wooSettings });
});

router.post('/settings/woocommerce', requireAdminOnly, (req, res) => {
  const { woo_store_url, woo_consumer_key, woo_consumer_secret } = req.body;
  const setKV = (key, value) => {
    const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
    if (existing) db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(value, key);
    else db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run(key, value);
  };
  if (woo_store_url !== undefined) setKV('woo_store_url', (woo_store_url || '').trim().replace(/\/+$/, ''));
  if (woo_consumer_key && woo_consumer_key.trim()) setKV('woo_consumer_key', woo_consumer_key.trim());
  if (woo_consumer_secret && woo_consumer_secret.trim()) setKV('woo_consumer_secret', woo_consumer_secret.trim());
  logAction(req, 'woo_api_settings_updated', { recordType: 'site_settings' });
  req.flash('success', 'WooCommerce API connection saved.');
  res.redirect('/admin/settings');
});

// Generic key/value settings saver used by the tabbed Settings page (General/Email/
// Payments/Security). Only whitelisted keys can be written this way.
const SETTINGS_KV_WHITELIST = new Set([
  'display_language', 'google_sso_enabled', 'microsoft_sso_enabled', 'remember_me_enabled',
  'maintenance_mode', 'debug_logging', 'from_name', 'from_email', 'email_footer',
  'notify_on_submission', 'notify_on_grade_published', 'currency', 'gst_rate', 'order_prefix',
  'invoice_notes', 'payment_notify_on_failed', 'password_min_length', 'password_expiry_days',
  'require_special_chars', 'enforce_2fa', 'session_timeout_minutes', 'ip_whitelist', 'brand_tagline',
]);
router.post('/settings/kv', requireAdminOnly, (req, res) => {
  const setKV = (key, value) => {
    const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
    if (existing) db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(value, key);
    else db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run(key, value);
  };
  Object.keys(req.body).forEach((k) => {
    if (SETTINGS_KV_WHITELIST.has(k)) setKV(k, String(req.body[k]).trim());
  });
  logAction(req, 'settings_updated', { recordType: 'site_settings' });
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

// Teacher/Admin's own profile — personal + address info (mirrors Student Profile & Settings).
router.post('/settings/profile', (req, res) => {
  const b = req.body;
  const cleanPhone = String(b.phone || '').replace(/\D/g, '');
  db.prepare(
    `UPDATE users SET name = ?, phone = ?, bio = ?, department = ?,
     address = ?, address_line2 = ?, city = ?, state = ?, postal_code = ?, country = ?
     WHERE id = ?`
  ).run(
    b.name || req.session.user.name, cleanPhone || null, b.bio || null, b.department || null,
    b.address || null, b.address_line2 || null, b.city || null, b.state || null, b.postal_code || null, b.country || 'Australia',
    req.session.user.id
  );
  req.session.user.name = b.name || req.session.user.name;
  logAction(req, 'profile_updated', { recordType: 'user', recordId: req.session.user.id });
  req.flash('success', 'Profile updated.');
  res.redirect('/admin/settings');
});

router.post('/settings/general', requireAdminOnly, (req, res) => {  const { platform_name, contact_email, website_url, timezone, portal_description } = req.body;
  const setKV = (key, value) => {
    const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
    if (existing) db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(value, key);
    else db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run(key, value);
  };
  setKV('platform_name', platform_name || 'AUS Academy');
  setKV('contact_email', contact_email || '');
  setKV('website_url', website_url || '');
  setKV('timezone', timezone || 'Australia/Sydney');
  setKV('portal_description', portal_description || '');
  logAction(req, 'general_settings_updated', { recordType: 'site_settings' });
  req.flash('success', 'General settings saved.');
  res.redirect('/admin/settings');
});

router.post('/settings/stripe', requireAdminOnly, (req, res) => {
  const { stripe_publishable_key, stripe_secret_key, stripe_webhook_secret } = req.body;
  const setKV = (key, value) => {
    const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
    if (existing) db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(value, key);
    else db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run(key, value);
  };
  if (stripe_publishable_key !== undefined) setKV('stripe_publishable_key', (stripe_publishable_key || '').trim());
  if (stripe_secret_key && stripe_secret_key.trim()) setKV('stripe_secret_key', stripe_secret_key.trim());
  if (stripe_webhook_secret && stripe_webhook_secret.trim()) setKV('stripe_webhook_secret', stripe_webhook_secret.trim());
  logAction(req, 'stripe_settings_updated', { recordType: 'site_settings' });
  req.flash('success', 'Stripe settings saved.');
  res.redirect('/admin/settings');
});

router.post('/settings/login-text', requireAdminOnly, (req, res) => {
  const b = req.body;
  const setKV = (key, value) => {
    const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
    if (existing) db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(value, key);
    else db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run(key, value);
  };
  [
    'brand_name', 'brand_tagline',
    'login_student_tag', 'login_student_hero_title', 'login_student_hero_text',
    'login_student_bullet1', 'login_student_bullet2', 'login_student_bullet3',
    'login_student_title', 'login_student_subtitle',
    'login_staff_tag', 'login_staff_hero_title', 'login_staff_hero_text',
    'login_staff_bullet1', 'login_staff_bullet2', 'login_staff_bullet3',
    'login_staff_title', 'login_staff_subtitle',
  ].forEach((key) => setKV(key, (b[key] || '').trim()));
  logAction(req, 'login_text_updated', { recordType: 'site_settings' });
  req.flash('success', 'Login page text updated.');
  res.redirect('/admin/settings');
});

router.post('/settings/otp', requireAdminOnly, (req, res) => {
  const smsCfg = require('../lib/smsConfig');
  const { sms_otp_enabled, sms_provider_choice } = req.body;
  const setKV = (key, value) => {
    const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
    if (existing) db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(value, key);
    else db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run(key, value);
  };
  const enabled = sms_otp_enabled ? '1' : '0';
  setKV('sms_otp_enabled', enabled);
  setKV('sms_provider_choice', sms_provider_choice || 'not_decided');

  // Save that provider's credential fields, right here in Settings — no .env or server
  // access needed. Secret fields (auth tokens / API keys) use blank-to-keep-current,
  // same as the Stripe keys above: an empty submission never wipes a saved secret.
  const chosenFields = smsCfg.FIELDS[sms_provider_choice] || [];
  chosenFields.forEach((key) => {
    const submitted = (req.body[key] || '').trim();
    if (!submitted) return; // blank = leave whatever is already saved (secret or not) untouched
    setKV(`sms_${key}`, submitted);
  });

  logAction(req, 'sms_otp_settings_updated', { recordType: 'site_settings', newValue: { enabled, provider_choice: sms_provider_choice, fields_updated: chosenFields.filter((k) => (req.body[k] || '').trim()) } });

  if (enabled === '1' && !smsCfg.isConfigured()) {
    req.flash('success', 'SMS OTP toggled ON. Note: this provider still needs its credentials filled in below (or set in .env) — codes will log to the console + SMS Logs until then.');
  } else {
    req.flash('success', 'OTP settings saved.');
  }
  res.redirect('/admin/settings');
});

// Sends a one-off test message through whichever provider is currently active, straight
// from Settings, so an admin can confirm newly-entered credentials actually work before
// any real student hits the login OTP flow.
router.post('/settings/sms-test', requireAdminOnly, async (req, res) => {
  const { sendSMS } = require('../lib/sms');
  const smsCfg = require('../lib/smsConfig');
  const to = (req.body.test_phone || '').trim();
  if (!to) { req.flash('error', 'Enter a phone number to send the test message to.'); return res.redirect('/admin/settings'); }
  if (!smsCfg.isConfigured()) { req.flash('error', 'This provider is not fully configured yet — fill in its credentials and save first.'); return res.redirect('/admin/settings'); }

  const result = await sendSMS({ to, message: `AUS Academy test message — your SMS/WhatsApp OTP setup is working. (${smsCfg.getActiveProvider()})`, template: 'settings_test' });
  logAction(req, 'sms_test_sent', { recordType: 'site_settings', newValue: { to, provider: smsCfg.getActiveProvider(), result: result.sent ? 'sent' : 'failed' } });
  if (result.sent) req.flash('success', `Test message sent to ${to}. Check SMS Logs to confirm delivery, or the phone itself.`);
  else req.flash('error', `Test message failed: ${result.error || 'unknown error'}. Double-check the credentials below.`);
  res.redirect('/admin/settings');
});

router.post('/settings/theme', requireAdminOnly, (req, res) => {
  const { font_family, primary_color } = req.body;
  const setKV = (key, value) => {
    const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
    if (existing) db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(value, key);
    else db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run(key, value);
  };
  setKV('theme_font_family', font_family || 'Inter');
  setKV('theme_primary_color', primary_color || '#566dfb');
  logAction(req, 'theme_updated', { recordType: 'site_settings', newValue: { font_family, primary_color } });
  req.flash('success', 'Theme updated — applies across Admin, Teacher and Student portals.');
  res.redirect('/admin/settings');
});

router.post('/settings/email-templates', (req, res) => {
  EMAIL_TEMPLATES.forEach((t) => {
    const enabled = req.body[`enabled_${t.key}`] ? '1' : '0';
    const key = `email_template_enabled_${t.key}`;
    const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
    if (existing) {
      db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(enabled, key);
    } else {
      db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run(key, enabled);
    }
  });
  logAction(req, 'email_templates_updated', { recordType: 'site_settings' });
  req.flash('success', 'Email template settings saved');
  res.redirect('/admin/settings');
});

router.post('/settings/logo', requireAdminOnly, upload.single('logo'), (req, res) => {
  if (req.file) {
    db.prepare("UPDATE site_settings SET value = ? WHERE key = 'logo_url'").run(`/uploads/${req.file.filename}`);
    req.flash('success', 'Logo updated');
  }
  res.redirect('/admin/settings');
});

const heroUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../public/uploads'),
    filename: (req, file, cb) => cb(null, `hero-${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
});

router.post('/settings/hero-image', requireAdminOnly, heroUpload.single('hero_image'), (req, res) => {
  if (req.file) {
    const key = 'hero_image_url';
    const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
    const value = `/uploads/${req.file.filename}`;
    if (existing) db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(value, key);
    else db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run(key, value);
    req.flash('success', 'Homepage image updated.');
  }
  res.redirect('/admin/settings');
});

router.post('/settings/password', (req, res) => {
  const { current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(current_password, user.password)) {
    req.flash('error', 'Current password is incorrect');
    return res.redirect('/admin/settings');
  }
  const hash = bcrypt.hashSync(new_password, 8);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
  req.flash('success', 'Password changed successfully');
  res.redirect('/admin/settings');
});

module.exports = router;
