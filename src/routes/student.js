const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin, requireVerified } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { notify } = require('../lib/notify');
const { sendEmail } = require('../lib/mailer');
const { renderEmail } = require('../lib/emailTemplates');
const { getStripeClient } = require('../lib/stripeConfig');

const router = express.Router();
router.use(requireLogin);

const uploadPhoto = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../public/uploads'),
    filename: (req, file, cb) => cb(null, `student-${req.session.user.id}-${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Load this student's module-unlock flags (Subjects / Tutorials / Study Material)
// on every /student/* request, so the sidebar can show locked/unlocked state.
router.use((req, res, next) => {
  const rows = db.prepare('SELECT module, unlocked FROM student_module_access WHERE user_id = ?').all(req.session.user.id);
  const access = { subjects: false, tutorials: false, material: false };
  rows.forEach((r) => { access[r.module] = !!r.unlocked; });
  res.locals.moduleAccess = access;

  const profileImg = db.prepare('SELECT profile_image FROM users WHERE id = ?').get(req.session.user.id);
  res.locals.currentUser.profile_image = profileImg ? profileImg.profile_image : null;
  next();
});

function grantPlan(userId, plan, subjectId, year, stripeSessionId, amountPaid) {
  const expiresAt = new Date(Date.now() + plan.validity_days * 86400000).toISOString();
  return db.prepare(
    `INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at, stripe_session_id, amount_paid)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(userId, plan.id, subjectId || null, year || null, plan.mcq_count, expiresAt, stripeSessionId || null, amountPaid || 0).lastInsertRowid;
}

router.get('/dashboard', (req, res) => {
  const uid = req.session.user.id;
  const plans = db.prepare(
    `SELECT sp.*, p.name AS plan_name FROM student_mcq_plans sp
     JOIN mcq_plans p ON p.id = sp.plan_id WHERE sp.user_id = ?`
  ).all(uid);
  const assignments = db.prepare(
    `SELECT a.*, ex.title, s.status AS sub_status FROM exam_assignments a
     JOIN exam_papers ex ON ex.id = a.paper_id
     LEFT JOIN exam_submissions s ON s.assignment_id = a.id
     WHERE a.user_id = ? ORDER BY a.assigned_at DESC`
  ).all(uid);
  const mcqAssignments = db.prepare(
    `SELECT * FROM mcq_assignments WHERE user_id = ? ORDER BY created_at DESC`
  ).all(uid);

  // Quick analytics for the dashboard cards + mini chart.
  const publishedResults = db.prepare(
    `SELECT s.total_score, s.total_marks FROM exam_assignments a
     JOIN exam_submissions s ON s.assignment_id = a.id
     WHERE a.user_id = ? AND s.status = 'published'`
  ).all(uid);
  const avgScore = publishedResults.length
    ? Math.round(publishedResults.reduce((sum, r) => sum + (r.total_marks ? (r.total_score / r.total_marks) * 100 : 0), 0) / publishedResults.length)
    : 0;
  const completedExams = db.prepare(
    `SELECT COUNT(*) c FROM exam_assignments a JOIN exam_submissions s ON s.assignment_id = a.id
     WHERE a.user_id = ? AND s.status IN ('pending_review','published')`
  ).get(uid).c;
  const pendingExamsCount = db.prepare(
    "SELECT COUNT(*) c FROM exam_assignments WHERE user_id = ? AND status = 'assigned'"
  ).get(uid).c;
  const completedMcqBatches = mcqAssignments.filter((a) => a.status === 'completed').length;

  // Exact figures the spec asks for: Total / Completed / Remaining MCQs.
  const totalMcqsAssignedToStudent = db.prepare(
    `SELECT COUNT(*) c FROM mcq_assignment_questions aq
     JOIN mcq_assignments a ON a.id = aq.assignment_id WHERE a.user_id = ?`
  ).get(uid).c;
  const completedMcqsCount = db.prepare(
    `SELECT COUNT(*) c FROM mcq_assignment_questions aq
     JOIN mcq_assignments a ON a.id = aq.assignment_id WHERE a.user_id = ? AND aq.answered_at IS NOT NULL`
  ).get(uid).c;
  const remainingMcqsCount = totalMcqsAssignedToStudent - completedMcqsCount;

  const studentRow = db.prepare('SELECT class_year FROM users WHERE id = ?').get(uid);

  const announcements = db.prepare(
    `SELECT * FROM announcements WHERE audience = 'all' OR audience = ?
     ORDER BY pinned DESC, created_at DESC LIMIT 5`
  ).all(studentRow ? studentRow.class_year || '' : '');

  // Recent published results (both full exam papers and completed MCQ batches), newest first.
  const recentExamResults = db.prepare(
    `SELECT p.title AS name, s2.name AS subject,
            CASE WHEN sub.total_marks > 0 THEN ROUND(sub.total_score * 100.0 / sub.total_marks) ELSE 0 END AS score,
            sub.submitted_at AS date
     FROM exam_submissions sub
     JOIN exam_assignments a ON a.id = sub.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN subjects s2 ON s2.id = p.subject_id
     WHERE a.user_id = ? AND sub.status = 'published'
     ORDER BY sub.submitted_at DESC LIMIT 5`
  ).all(uid);
  const recentMcqResults = db.prepare(
    `SELECT ('MCQ Batch - ' || COALESCE(a.topic,'General')) AS name, s2.name AS subject,
            ROUND(100.0 * SUM(CASE WHEN aq.is_correct = 1 THEN 1 ELSE 0 END) / COUNT(*)) AS score,
            a.completed_at AS date
     FROM mcq_assignments a
     JOIN mcq_assignment_questions aq ON aq.assignment_id = a.id
     LEFT JOIN subjects s2 ON s2.id = a.subject_id
     WHERE a.user_id = ? AND a.status = 'completed'
     GROUP BY a.id ORDER BY a.completed_at DESC LIMIT 5`
  ).all(uid);
  const recentResults = [...recentExamResults, ...recentMcqResults]
    .filter((r) => r.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);

  // Score progress over time (published exam results + completed MCQ batches combined, chronological)
  const scoreProgress = [...recentExamResults, ...recentMcqResults]
    .filter((r) => r.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-8);

  // Upcoming assignments: exam papers + MCQ batches still due, soonest first.
  const upcomingExamAssignments = db.prepare(
    `SELECT p.title AS name, s2.name AS subject, a.due_at AS due
     FROM exam_assignments a JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN subjects s2 ON s2.id = p.subject_id
     WHERE a.user_id = ? AND a.status = 'assigned' AND a.due_at IS NOT NULL
     ORDER BY a.due_at ASC LIMIT 4`
  ).all(uid);
  const upcomingMcqAssignments = db.prepare(
    `SELECT ('MCQ Batch - ' || COALESCE(a.topic,'General')) AS name, s2.name AS subject, a.due_date AS due
     FROM mcq_assignments a LEFT JOIN subjects s2 ON s2.id = a.subject_id
     WHERE a.user_id = ? AND a.status != 'completed' AND a.due_date IS NOT NULL
     ORDER BY a.due_date ASC LIMIT 4`
  ).all(uid);
  const upcomingAssignments = [...upcomingExamAssignments, ...upcomingMcqAssignments]
    .sort((a, b) => new Date(a.due) - new Date(b.due)).slice(0, 4);

  // Subject-wise MCQ activity split (used in place of untracked "time spent"), from assigned MCQ counts.
  const subjectActivity = db.prepare(
    `SELECT s2.name, COUNT(*) c FROM mcq_assignment_questions aq
     JOIN mcq_assignments a ON a.id = aq.assignment_id
     LEFT JOIN subjects s2 ON s2.id = a.subject_id
     WHERE a.user_id = ? GROUP BY s2.id ORDER BY c DESC LIMIT 6`
  ).all(uid).map((r) => ({ name: r.name || 'General', count: r.c }));
  const activityColors = ['#2563eb', '#38bdf8', '#f59e0b', '#10b981', '#a855f7', '#14b8a6'];
  const subjectActivityTotal = Math.max(1, subjectActivity.reduce((s, r) => s + r.count, 0));
  subjectActivity.forEach((r, i) => { r.pct = Math.round((r.count / subjectActivityTotal) * 100); r.color = activityColors[i % activityColors.length]; });

  // Study activity by weekday, last 7 days (MCQ answers + exam submissions combined count).
  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const studyActivity = weekdayLabels.map((label) => ({ label, count: 0 }));
  const last7 = db.prepare(
    `SELECT answered_at AS ts FROM mcq_assignment_questions aq JOIN mcq_assignments a ON a.id = aq.assignment_id
     WHERE a.user_id = ? AND answered_at IS NOT NULL AND answered_at >= date('now','-7 days')
     UNION ALL
     SELECT s.submitted_at AS ts FROM exam_submissions s JOIN exam_assignments a ON a.id = s.assignment_id
     WHERE a.user_id = ? AND s.submitted_at IS NOT NULL AND s.submitted_at >= date('now','-7 days')`
  ).all(uid, uid);
  last7.forEach((r) => { const d = new Date(r.ts); if (!isNaN(d)) studyActivity[d.getDay()].count += 1; });

  res.render('student/dashboard', {
    plans, assignments, mcqAssignments, avgScore, completedExams, pendingExamsCount, completedMcqBatches,
    totalMcqsAssignedToStudent, completedMcqsCount, remainingMcqsCount, studentRow,
    recentResults, scoreProgress, upcomingAssignments, subjectActivity, studyActivity, announcements,
  });
});

// ---------- MCQ PLANS ----------
router.get('/mcq/plans', (req, res) => {
  const { subject_id } = req.query;
  let where = "WHERE p.name != 'Free Plan' AND p.is_active = 1";
  const params = [];
  if (subject_id) { where += ' AND p.subject_id = ?'; params.push(subject_id); }
  const plans = db.prepare(
    `SELECT p.*, s.name AS subject_name,
       (SELECT COUNT(*) FROM student_mcq_plans WHERE plan_id = p.id) AS purchase_count
     FROM mcq_plans p LEFT JOIN subjects s ON s.id = p.subject_id
     ${where} ORDER BY p.id`
  ).all(...params);
  // "Popular" is only shown on a plan when there's a real purchase signal to
  // back it — the most-purchased plan, and only if it actually has sales.
  const mostPurchased = plans.reduce((best, p) => (p.purchase_count > (best ? best.purchase_count : 0) ? p : best), null);
  const popularPlanId = mostPurchased && mostPurchased.purchase_count > 0 ? mostPurchased.id : null;
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('student/mcq_plans', { plans, subjects, popularPlanId, filters: { subject_id: subject_id || '' } });
});

// Buy an MCQ plan — pays via Stripe Checkout (test mode) when configured,
// otherwise activates instantly (demo mode, no Stripe keys set).
router.post('/mcq/plans/:id/buy', requireVerified, async (req, res) => {
  const plan = db.prepare('SELECT * FROM mcq_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.redirect('/student/mcq/plans');
  const { subject_id, year } = req.body;

  if (plan.price <= 0) {
    grantPlan(req.session.user.id, plan, subject_id, year, null, plan.price);
    req.flash('success', `Plan activated! ${plan.mcq_count} MCQs added to your quota — your teacher will assign a batch for you to practice.`);
    return res.redirect('/student/mcq/my');
  }

  const stripe = getStripeClient();
  if (!stripe) {
    grantPlan(req.session.user.id, plan, subject_id, year, null, 0);
    req.flash('success', `Plan activated (demo mode — Stripe not configured). ${plan.mcq_count} MCQs added to your quota — your teacher will assign a batch for you to practice.`);
    return res.redirect('/student/mcq/my');
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'aud',
        unit_amount: Math.round(plan.price * 100),
        product_data: { name: `${plan.name} — ${plan.mcq_count} MCQs` },
      },
      quantity: 1,
    }],
    metadata: {
      plan_id: String(plan.id),
      user_id: String(req.session.user.id),
      subject_id: subject_id || '',
      year: year || '',
    },
    success_url: `${baseUrl}/student/mcq/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/student/mcq/plans`,
  });
  res.redirect(session.url);
});

router.get('/mcq/checkout/success', async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) return res.redirect('/student/mcq/plans');
  const { session_id } = req.query;

  const already = db.prepare('SELECT * FROM student_mcq_plans WHERE stripe_session_id = ?').get(session_id);
  if (already) {
    const plan = db.prepare('SELECT * FROM mcq_plans WHERE id = ?').get(already.plan_id);
    return renderOrderSuccess(res, req, { plan, record: already, sessionId: session_id });
  }

  const session = await stripe.checkout.sessions.retrieve(session_id);
  if (session.payment_status !== 'paid') {
    req.flash('error', 'Payment not completed');
    return res.redirect('/student/mcq/plans');
  }
  const plan = db.prepare('SELECT * FROM mcq_plans WHERE id = ?').get(session.metadata.plan_id);
  if (!plan) return res.redirect('/student/mcq/plans');
  const recordId = grantPlan(session.metadata.user_id, plan, session.metadata.subject_id, session.metadata.year, session_id, plan.price);
  logAction(req, 'payment_confirmed', {
    recordType: 'student_mcq_plan', recordId: session.metadata.user_id,
    newValue: { source: 'portal_stripe', plan: plan.name, amount: plan.price, stripe_session_id: session_id },
  });
  notify(session.metadata.user_id, 'purchase', 'MCQ plan activated', `"${plan.name}" is now active on your account.`, '/student/mcq/my', { email: false }); // order email is sent just below
  const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(session.metadata.user_id);
  if (buyer) {
    sendEmail({
      to: buyer.email,
      subject: `Order confirmed — ${plan.name}`,
      template: 'purchase_paper_assigned',
      userId: buyer.id, relatedType: 'student_mcq_plan', relatedId: Number(recordId),
      html: `<p>Hi ${buyer.name},</p><p>Your payment for <b>${plan.name}</b> (${plan.mcq_count} MCQs) was successful.</p><p>Order ID: <b>${session_id}</b><br>Amount: <b>AU$${plan.price}</b><br>Date: ${new Date().toLocaleString('en-AU')}</p><p>Log in to your Student Portal to start practicing.</p>`,
    });
  }
  const record = db.prepare('SELECT * FROM student_mcq_plans WHERE id = ?').get(recordId);
  renderOrderSuccess(res, req, { plan, record, sessionId: session_id, buyer });
});

function renderOrderSuccess(res, req, { plan, record, sessionId, buyer }) {
  const student = buyer || req.session.user;
  res.render('student/order_success', {
    order: {
      orderId: sessionId,
      product: `${plan.name} — MCQ Plan`,
      planName: plan.name,
      amount: plan.price,
      paymentStatus: 'Paid',
      orderStatus: 'Completed',
      purchaseDate: record && record.purchased_at ? record.purchased_at : new Date().toISOString(),
      studentName: student.name,
      studentEmail: student.email,
    },
  });
}


router.get('/mcq/my', (req, res) => {
  const uid = req.session.user.id;
  const plans = db.prepare(
    `SELECT sp.*, p.name AS plan_name, p.mcq_count, sub.name AS subject_name
     FROM student_mcq_plans sp
     JOIN mcq_plans p ON p.id = sp.plan_id
     LEFT JOIN subjects sub ON sub.id = sp.subject_id
     WHERE sp.user_id = ?`
  ).all(uid);

  // Assignments — the actual practicable batches a teacher has handed out.
  // A purchased plan alone grants nothing to practice; this list is what
  // decides what the student can actually do.
  const assignments = db.prepare(
    `SELECT a.*, sub.name AS subject_name, t.name AS teacher_name,
       (SELECT COUNT(*) FROM mcq_assignment_questions WHERE assignment_id = a.id) AS total_questions,
       (SELECT COUNT(*) FROM mcq_assignment_questions WHERE assignment_id = a.id AND answered_at IS NOT NULL) AS answered_questions
     FROM mcq_assignments a
     LEFT JOIN subjects sub ON sub.id = a.subject_id
     LEFT JOIN users t ON t.id = a.assigned_by
     WHERE a.user_id = ?
     ORDER BY a.created_at DESC`
  ).all(uid);

  res.render('student/mcq_my', { plans, assignments });
});

// ---------- MCQ Assignment practice (the only way to actually answer MCQs) ----------
router.get('/mcq/assignment/:id', requireVerified, (req, res) => {
  const uid = req.session.user.id;
  const assignment = db.prepare(
    `SELECT a.*, sub.name AS subject_name FROM mcq_assignments a
     LEFT JOIN subjects sub ON sub.id = a.subject_id WHERE a.id = ? AND a.user_id = ?`
  ).get(req.params.id, uid);
  if (!assignment) return res.redirect('/student/mcq/my');

  const total = db.prepare('SELECT COUNT(*) c FROM mcq_assignment_questions WHERE assignment_id = ?').get(assignment.id).c;
  const answered = db.prepare('SELECT COUNT(*) c FROM mcq_assignment_questions WHERE assignment_id = ? AND answered_at IS NOT NULL').get(assignment.id).c;

  if (answered >= total) return res.redirect(`/student/mcq/assignment/${assignment.id}/result`);

  if (assignment.status === 'assigned') {
    db.prepare("UPDATE mcq_assignments SET status = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE id = ?").run(assignment.id);
  }

  const next = db.prepare(
    `SELECT aq.id AS aq_id, m.* FROM mcq_assignment_questions aq
     JOIN mcqs m ON m.id = aq.mcq_id
     WHERE aq.assignment_id = ? AND aq.answered_at IS NULL
     ORDER BY aq.id LIMIT 1`
  ).get(assignment.id);

  res.render('student/mcq_assignment_practice', { assignment, mcq: next, answered, total });
});

router.post('/mcq/assignment/:id/answer', requireVerified, (req, res) => {
  const uid = req.session.user.id;
  const assignment = db.prepare('SELECT * FROM mcq_assignments WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!assignment) return res.redirect('/student/mcq/my');

  const { aq_id, selected_option } = req.body;
  if (!aq_id || !selected_option) return res.redirect(`/student/mcq/assignment/${assignment.id}`);
  const aq = db.prepare(
    `SELECT aq.*, m.correct_option FROM mcq_assignment_questions aq
     JOIN mcqs m ON m.id = aq.mcq_id WHERE aq.id = ? AND aq.assignment_id = ?`
  ).get(aq_id, assignment.id);
  if (!aq) return res.redirect(`/student/mcq/assignment/${assignment.id}`);

  const isCorrect = selected_option === aq.correct_option ? 1 : 0;
  db.prepare('UPDATE mcq_assignment_questions SET selected_option = ?, is_correct = ?, answered_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(selected_option, isCorrect, aq.id);

  const total = db.prepare('SELECT COUNT(*) c FROM mcq_assignment_questions WHERE assignment_id = ?').get(assignment.id).c;
  const answered = db.prepare('SELECT COUNT(*) c FROM mcq_assignment_questions WHERE assignment_id = ? AND answered_at IS NOT NULL').get(assignment.id).c;

  if (answered >= total) {
    db.prepare("UPDATE mcq_assignments SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(assignment.id);
    return res.redirect(`/student/mcq/assignment/${assignment.id}/result`);
  }
  res.redirect(`/student/mcq/assignment/${assignment.id}`);
});

router.get('/mcq/assignment/:id/result', (req, res) => {
  const uid = req.session.user.id;
  const assignment = db.prepare(
    `SELECT a.*, sub.name AS subject_name FROM mcq_assignments a
     LEFT JOIN subjects sub ON sub.id = a.subject_id WHERE a.id = ? AND a.user_id = ?`
  ).get(req.params.id, uid);
  if (!assignment) return res.redirect('/student/mcq/my');

  const stats = db.prepare(
    `SELECT COUNT(*) total, SUM(is_correct) correct FROM mcq_assignment_questions WHERE assignment_id = ?`
  ).get(assignment.id);
  const total = stats.total || 0;
  const correct = stats.correct || 0;
  const score = total ? Math.round((correct / total) * 100) : 0;
  res.render('student/mcq_assignment_result', { assignment, total, correct, wrong: total - correct, score });
});

// ---------- FULL EXAM PAPERS ----------
// "My Exam Papers" list — every exam paper assigned to this student, real data
// from exam_assignments joined to exam_papers/subjects/exam_submissions.
router.get('/exams', (req, res) => {
  const uid = req.session.user.id;
  const { subject_id, year, status } = req.query;
  let sql = `SELECT a.id AS assignment_id, a.assigned_at, a.status AS assignment_status,
                    p.id AS paper_id, p.title, p.year, p.class_name, p.duration_minutes, p.description, p.cover_image_url,
                    s.id AS subject_id, s.name AS subject_name,
                    (SELECT COUNT(*) FROM exam_paper_questions q WHERE q.paper_id = p.id) AS question_count,
                    sub.id AS submission_id, sub.status AS submission_status
             FROM exam_assignments a
             JOIN exam_papers p ON p.id = a.paper_id
             JOIN subjects s ON s.id = p.subject_id
             LEFT JOIN exam_submissions sub ON sub.assignment_id = a.id
             WHERE a.user_id = ?`;
  const params = [uid];
  if (subject_id) { sql += ' AND s.id = ?'; params.push(subject_id); }
  if (year) { sql += ' AND p.year = ?'; params.push(year); }
  sql += ' ORDER BY a.assigned_at DESC';
  let papers = db.prepare(sql).all(...params);

  papers = papers.map((p) => ({
    ...p,
    display_status: p.submission_id ? (p.submission_status === 'published' ? 'Completed' : (p.submission_status === 'pending_review' ? 'Submitted' : 'In Progress')) : 'Assigned',
  }));
  if (status) papers = papers.filter((p) => p.display_status.toLowerCase() === status.toLowerCase());

  const metrics = {
    total: papers.length,
    year11: papers.filter((p) => p.year === 'Year 11').length,
    year12: papers.filter((p) => p.year === 'Year 12').length,
    assignedCount: papers.length,
  };
  const subjects = db.prepare('SELECT DISTINCT s.* FROM subjects s JOIN exam_papers p ON p.subject_id = s.id JOIN exam_assignments a ON a.paper_id = p.id WHERE a.user_id = ? ORDER BY s.name').all(uid);

  res.render('student/exams_my', { papers, metrics, subjects, filters: { subject_id, year, status } });
});

router.get('/exams/:assignmentId', (req, res) => {
  const uid = req.session.user.id;
  const a = db.prepare(
    `SELECT a.*, p.title, p.duration_minutes FROM exam_assignments a
     JOIN exam_papers p ON p.id = a.paper_id WHERE a.id = ? AND a.user_id = ?`
  ).get(req.params.assignmentId, uid);
  if (!a) return res.redirect('/student/dashboard');
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE assignment_id = ?').get(a.id);
  res.render('student/exam_intro', { assignment: a, submission });
});

router.post('/exams/:assignmentId/start', requireVerified, (req, res) => {
  const uid = req.session.user.id;
  const a = db.prepare(
    `SELECT ea.*, p.duration_minutes FROM exam_assignments ea
     JOIN exam_papers p ON p.id = ea.paper_id WHERE ea.id = ? AND ea.user_id = ?`
  ).get(req.params.assignmentId, uid);
  if (!a) return res.redirect('/student/dashboard');
  let submission = db.prepare('SELECT * FROM exam_submissions WHERE assignment_id = ?').get(a.id);
  if (!submission) {
    // Timer starts HERE, server-side, the moment Start Exam is clicked — never
    // at purchase/assignment/dashboard time. expires_at is computed once and
    // stored; the client never gets to set or extend it.
    const expiresAt = new Date(Date.now() + a.duration_minutes * 60000).toISOString();
    const id = db.prepare('INSERT INTO exam_submissions (assignment_id, status, expires_at) VALUES (?,?,?)')
      .run(a.id, 'in_progress', expiresAt).lastInsertRowid;
    db.prepare('UPDATE exam_assignments SET status = ? WHERE id = ?').run('in_progress', a.id);
    submission = { id, expires_at: expiresAt };
  }
  res.redirect(`/student/exams/${a.id}/take`);
});

// Shared finalize logic used both by the normal Submit button AND by the
// server-side timeout backstop below — so a late/expired attempt is scored
// exactly the same way as a manual submit.
function finalizeSubmission(a, submission, body, lateOverride) {
  const questions = db.prepare('SELECT * FROM exam_paper_questions WHERE paper_id = ?').all(a.paper_id);
  let mcqScore = 0, mcqTotal = 0, writtenTotal = 0, essayTotal = 0;

  const insAns = db.prepare(
    'INSERT INTO exam_answers (submission_id, question_id, selected_option, answer_text, is_correct, marks_awarded) VALUES (?,?,?,?,?,?)'
  );

  questions.forEach((q) => {
    if (q.type === 'mcq') {
      mcqTotal += q.marks;
      const selected = body[`mcq_${q.id}`] || null;
      const isCorrect = selected === q.correct_option ? 1 : 0;
      if (isCorrect) mcqScore += q.marks;
      insAns.run(submission.id, q.id, selected, null, isCorrect, isCorrect ? q.marks : 0);
    } else if (q.type === 'written') {
      writtenTotal += q.marks;
      const text = body[`written_${q.id}`] || '';
      insAns.run(submission.id, q.id, null, text, null, null);
    } else {
      essayTotal += q.marks;
      const text = body[`essay_${q.id}`] || '';
      insAns.run(submission.id, q.id, null, text, null, null);
    }
  });

  const isLate = lateOverride || (submission.expires_at && new Date() > new Date(submission.expires_at)) ? 1 : 0;

  db.prepare(
    `UPDATE exam_submissions SET status = 'pending_review', submitted_at = CURRENT_TIMESTAMP, is_late = ?,
     mcq_score = ?, mcq_total = ?, written_total = ?, essay_total = ? WHERE id = ?`
  ).run(isLate, mcqScore, mcqTotal, writtenTotal, essayTotal, submission.id);
  db.prepare('UPDATE exam_assignments SET status = ? WHERE id = ?').run('submitted', a.id);
}

router.get('/exams/:assignmentId/take', requireVerified, (req, res) => {
  const uid = req.session.user.id;
  const a = db.prepare(
    `SELECT a.*, p.title, p.duration_minutes FROM exam_assignments a
     JOIN exam_papers p ON p.id = a.paper_id WHERE a.id = ? AND a.user_id = ?`
  ).get(req.params.assignmentId, uid);
  if (!a) return res.redirect('/student/dashboard');
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE assignment_id = ?').get(a.id);
  if (!submission || submission.status !== 'in_progress') return res.redirect(`/student/exams/${a.id}`);

  // Server-side timeout backstop: never trust the browser's clock/JS alone.
  // If the stored expiry has already passed (client closed the tab, JS
  // failed, whatever), auto-submit right now with whatever was in the last
  // saved answers (none, if they never submitted) instead of letting an
  // expired exam stay open indefinitely.
  if (submission.expires_at && new Date() > new Date(submission.expires_at)) {
    finalizeSubmission(a, submission, {}, true);
    const timedOutPaper = db.prepare('SELECT title FROM exam_papers WHERE id = ?').get(a.paper_id);
    notifySubmissionReceived(uid, a, submission, timedOutPaper ? timedOutPaper.title : 'your exam');
    req.flash('error', 'Time was already up — your exam was auto-submitted with whatever was answered.');
    return res.redirect(`/student/exams/${a.id}`);
  }

  const questions = db.prepare('SELECT * FROM exam_paper_questions WHERE paper_id = ? ORDER BY order_no').all(a.paper_id);
  const mcqs = questions.filter((q) => q.type === 'mcq');
  const written = questions.filter((q) => q.type === 'written');
  const essays = questions.filter((q) => q.type === 'essay');
  res.render('student/exam_take', { assignment: a, mcqs, written, essays, expiresAt: submission.expires_at });
});

// Student-facing "Submission Received" confirmation (one central email record, type Submission).
function notifySubmissionReceived(uid, a, submission, paperTitle) {
  const subj = db.prepare('SELECT s.name FROM exam_papers p LEFT JOIN subjects s ON s.id = p.subject_id WHERE p.id = ?').get(a.paper_id);
  notify(uid, 'submission_confirmed', 'Submission Received', `We have received your submission for "${paperTitle}". Your teacher will review it and you will be notified when your result is published.`, `/student/exams/${a.id}`,
    { relatedType: 'exam_submission', relatedId: submission.id, itemTitle: paperTitle, subjectName: subj && subj.name });
}

router.post('/exams/:assignmentId/submit', requireVerified, (req, res) => {
  const uid = req.session.user.id;
  const a = db.prepare('SELECT * FROM exam_assignments WHERE id = ? AND user_id = ?').get(req.params.assignmentId, uid);
  if (!a) return res.redirect('/student/dashboard');
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE assignment_id = ?').get(a.id);
  if (!submission || submission.status !== 'in_progress') return res.redirect(`/student/exams/${a.id}`);

  finalizeSubmission(a, submission, req.body, false);

  const staff = db.prepare("SELECT id FROM users WHERE role IN ('admin','teacher')").all();
  const paper = db.prepare('SELECT title FROM exam_papers WHERE id = ?').get(a.paper_id);
  staff.forEach((s) => notify(s.id, 'submission_received', 'New exam submission to review', `${req.session.user.name} submitted "${paper.title}"`, '/admin/submissions'));
  notifySubmissionReceived(uid, a, submission, paper.title);

  req.flash('success', 'Exam submitted! MCQs auto-checked. Written & essay answers are pending teacher review.');
  res.redirect(`/student/exams/${a.id}`);
});

router.get('/results', (req, res) => {
  const uid = req.session.user.id;
  const results = db.prepare(
    `SELECT a.id AS assignment_id, p.title, s.status, s.mcq_score, s.mcq_total, s.written_score, s.written_total,
            s.essay_score, s.essay_total, s.total_score, s.total_marks
     FROM exam_assignments a
     JOIN exam_papers p ON p.id = a.paper_id
     JOIN exam_submissions s ON s.assignment_id = a.id
     WHERE a.user_id = ?`
  ).all(uid);
  res.render('student/results', { results });
});

// ---------- My Submissions (list) ----------
router.get('/submissions', (req, res) => {
  const uid = req.session.user.id;
  const { subject_id, year, status, date_from, date_to } = req.query;
  let sql = `SELECT s.*, a.id AS assignment_id, p.title, p.subject_id, p.year, sub.name AS subject_name
     FROM exam_assignments a
     JOIN exam_submissions s ON s.assignment_id = a.id
     JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN subjects sub ON sub.id = p.subject_id
     WHERE a.user_id = ?`;
  const params = [uid];
  if (subject_id) { sql += ' AND p.subject_id = ?'; params.push(subject_id); }
  if (year) { sql += ' AND p.year = ?'; params.push(year); }
  if (status === 'published') { sql += " AND s.status = 'published'"; }
  else if (status === 'pending') { sql += " AND s.status != 'published'"; }
  if (date_from) { sql += ' AND date(s.submitted_at) >= date(?)'; params.push(date_from); }
  if (date_to) { sql += ' AND date(s.submitted_at) <= date(?)'; params.push(date_to); }
  sql += ' ORDER BY s.submitted_at DESC';
  const submissions = db.prepare(sql).all(...params);

  submissions.forEach((s) => {
    if (s.started_at && s.submitted_at) {
      const ms = new Date(s.submitted_at) - new Date(s.started_at);
      if (ms > 0) {
        const mins = Math.round(ms / 60000);
        s.timeTaken = `${Math.floor(mins / 60)}h ${mins % 60}m`;
      }
    }
  });

  const reviewed = submissions.filter((s) => s.status === 'published');
  const counts = {
    total: submissions.length,
    reviewed: reviewed.length,
    pending: submissions.length - reviewed.length,
    avgScore: reviewed.length
      ? Math.round(reviewed.reduce((sum, s) => sum + (s.total_marks ? (s.total_score / s.total_marks) * 100 : 0), 0) / reviewed.length)
      : null,
  };

  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('student/submissions', { submissions, subjects, counts, filters: { subject_id, year, status, date_from, date_to } });
});

// ---------- My Submissions (single detail) ----------
router.get('/submissions/:id', (req, res) => {
  const uid = req.session.user.id;
  const submission = db.prepare(
    `SELECT s.*, a.id AS assignment_id, a.user_id, p.title, p.subject_id, p.year, p.class_name, p.duration_minutes,
            p.show_model_answers, sub.name AS subject_name
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     LEFT JOIN subjects sub ON sub.id = p.subject_id
     WHERE s.id = ?`
  ).get(req.params.id);

  if (!submission || submission.user_id !== uid) {
    req.flash('error', 'Submission not found.');
    return res.redirect('/student/submissions');
  }

  if (submission.started_at && submission.submitted_at) {
    const ms = new Date(submission.submitted_at) - new Date(submission.started_at);
    if (ms > 0) {
      const mins = Math.round(ms / 60000);
      submission.timeTaken = `${Math.floor(mins / 60)}h ${mins % 60}m`;
    }
  }

  if (submission.status !== 'published') {
    return res.render('student/submission_review', { submission, pending: true, mcqs: [], written: [], essays: [] });
  }

  const answers = db.prepare(
    `SELECT ans.*, q.type, q.question, q.marks, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.order_no,
            CASE WHEN ? THEN q.model_answer ELSE NULL END AS model_answer
     FROM exam_answers ans JOIN exam_paper_questions q ON q.id = ans.question_id
     WHERE ans.submission_id = ? ORDER BY q.order_no`
  ).all(submission.show_model_answers ? 1 : 0, submission.id);

  res.render('student/submission_review', {
    submission,
    pending: false,
    mcqs: answers.filter((a) => a.type === 'mcq'),
    written: answers.filter((a) => a.type === 'written'),
    essays: answers.filter((a) => a.type === 'essay'),
  });
});

// ---------- Subjects (locked until Admin/Teacher unlocks it) ----------
function requireModule(mod) {
  return (req, res, next) => {
    if (!res.locals.moduleAccess[mod]) {
      req.flash('error', 'This module is not assigned yet by your Admin / Teacher.');
      return res.redirect('/student/dashboard');
    }
    next();
  };
}

router.get('/subjects', requireModule('subjects'), (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY year, name').all();
  res.render('student/subjects', { subjects });
});

// ---------- Tutorials (unlocked module = see all; otherwise only individually-purchased/assigned ones) ----------
router.get('/tutorials', (req, res) => {
  const uid = req.session.user.id;
  const { subject_id, year, q } = req.query;
  const moduleUnlocked = res.locals.moduleAccess.tutorials;

  let sql = `SELECT t.*, s.name AS subject_name,
               ca.due_date, ca.instructions, ca.assigned_by,
               tp.progress_percent, tp.completed, tp.completed_at
             FROM tutorials t
             LEFT JOIN subjects s ON s.id = t.subject_id
             LEFT JOIN content_assignments ca ON ca.content_type='tutorial' AND ca.content_id=t.id AND ca.user_id=? AND ca.status='assigned'
             LEFT JOIN tutorial_progress tp ON tp.tutorial_id = t.id AND tp.user_id = ?
             WHERE t.is_published = 1`;
  const params = [uid, uid];
  if (!moduleUnlocked) {
    sql += ` AND t.id IN (SELECT content_id FROM content_assignments WHERE user_id = ? AND content_type = 'tutorial' AND status = 'assigned')`;
    params.push(uid);
  }
  if (subject_id) { sql += ' AND t.subject_id = ?'; params.push(subject_id); }
  if (year) { sql += ' AND t.year = ?'; params.push(year); }
  if (q) { sql += ' AND (t.title LIKE ? OR s.name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY t.created_at DESC';
  const tutorials = db.prepare(sql).all(...params);

  const assignedByName = {};
  tutorials.forEach((t) => {
    if (t.assigned_by && !assignedByName[t.assigned_by]) {
      const teacher = db.prepare('SELECT name FROM users WHERE id = ?').get(t.assigned_by);
      assignedByName[t.assigned_by] = teacher ? teacher.name : 'Teacher';
    }
    t.assigned_by_name = t.assigned_by ? assignedByName[t.assigned_by] : null;
  });

  const stats = {
    total: tutorials.length,
    completed: tutorials.filter((t) => t.completed).length,
    inProgress: tutorials.filter((t) => !t.completed && (t.progress_percent || 0) > 0).length,
    notStarted: tutorials.filter((t) => !t.completed && !(t.progress_percent > 0)).length,
  };
  const bySubject = {};
  tutorials.forEach((t) => { if (t.subject_name) bySubject[t.subject_name] = (bySubject[t.subject_name] || 0) + 1; });

  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('student/tutorials', { tutorials, subjects, stats, bySubject, selectedSubject: subject_id || '', selectedYear: year || '', q: q || '', moduleUnlocked });
});

// ---------- Single Tutorial view: video, progress, mark complete, comments ----------
router.get('/tutorials/:id', (req, res) => {
  const uid = req.session.user.id;
  const tutorial = db.prepare(
    `SELECT t.*, s.name AS subject_name FROM tutorials t LEFT JOIN subjects s ON s.id = t.subject_id WHERE t.id = ? AND t.is_published = 1`
  ).get(req.params.id);
  if (!tutorial) { req.flash('error', 'Tutorial not found.'); return res.redirect('/student/tutorials'); }

  const assignment = db.prepare(
    "SELECT * FROM content_assignments WHERE user_id=? AND content_type='tutorial' AND content_id=? AND status='assigned'"
  ).get(uid, tutorial.id);
  if (!res.locals.moduleAccess.tutorials && !assignment) {
    req.flash('error', 'This tutorial is not assigned to your account yet.');
    return res.redirect('/student/tutorials');
  }

  db.prepare('UPDATE tutorials SET views = views + 1 WHERE id = ?').run(tutorial.id);

  let progress = db.prepare('SELECT * FROM tutorial_progress WHERE user_id = ? AND tutorial_id = ?').get(uid, tutorial.id);
  if (!progress) {
    db.prepare('INSERT INTO tutorial_progress (user_id, tutorial_id, progress_percent) VALUES (?,?,0)').run(uid, tutorial.id);
    progress = db.prepare('SELECT * FROM tutorial_progress WHERE user_id = ? AND tutorial_id = ?').get(uid, tutorial.id);
  }

  const assignedBy = assignment && assignment.assigned_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(assignment.assigned_by) : null;

  const comments = db.prepare(
    `SELECT c.*, u.name AS user_name, u.role AS user_role FROM tutorial_comments c
     JOIN users u ON u.id = c.user_id WHERE c.tutorial_id = ? ORDER BY c.created_at ASC`
  ).all(tutorial.id);

  const otherTutorials = db.prepare(
    `SELECT * FROM tutorials WHERE subject_id = ? AND id != ? AND is_published = 1 ORDER BY created_at ASC LIMIT 8`
  ).all(tutorial.subject_id, tutorial.id);

  res.render('student/tutorial_view', { tutorial, progress, assignment, assignedBy, comments, otherTutorials });
});

router.post('/tutorials/:id/complete', (req, res) => {
  const uid = req.session.user.id;
  const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(req.params.id);
  if (!tutorial) return res.redirect('/student/tutorials');
  const existing = db.prepare('SELECT * FROM tutorial_progress WHERE user_id = ? AND tutorial_id = ?').get(uid, tutorial.id);
  if (existing) {
    db.prepare("UPDATE tutorial_progress SET progress_percent=100, completed=1, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(existing.id);
  } else {
    db.prepare("INSERT INTO tutorial_progress (user_id, tutorial_id, progress_percent, completed, completed_at) VALUES (?,?,100,1,CURRENT_TIMESTAMP)").run(uid, tutorial.id);
  }
  req.flash('success', 'Marked as completed!');
  res.redirect(`/student/tutorials/${tutorial.id}`);
});

router.post('/tutorials/:id/comment', (req, res) => {
  const uid = req.session.user.id;
  const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(req.params.id);
  if (!tutorial || !tutorial.allow_comments || !req.body.body || !req.body.body.trim()) {
    return res.redirect(`/student/tutorials/${req.params.id}`);
  }
  db.prepare('INSERT INTO tutorial_comments (tutorial_id, user_id, parent_id, body) VALUES (?,?,NULL,?)')
    .run(tutorial.id, uid, req.body.body.trim());

  // Notify the teacher who assigned/created this tutorial (fall back to any admin/teacher)
  const teacher = tutorial.created_by ? db.prepare('SELECT id FROM users WHERE id = ?').get(tutorial.created_by)
    : db.prepare("SELECT id FROM users WHERE role IN ('admin','teacher') LIMIT 1").get();
  if (teacher) {
    notify(teacher.id, 'tutorial_comment', 'New Question on Tutorial', `${req.session.user.name} asked a question on "${tutorial.title}".`, `/admin/tutorials/${tutorial.id}/comments`);
  }
  res.redirect(`/student/tutorials/${tutorial.id}`);
});

// ---------- Secure tutorial video delivery (uploaded files only; external video_url is used directly) ----------
router.get('/tutorials/:id/video', requireVerified, (req, res) => {
  const uid = req.session.user.id;
  const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ? AND is_published = 1').get(req.params.id);
  if (!tutorial || !tutorial.video_path) return res.status(404).send('Not found');
  const assigned = db.prepare("SELECT 1 FROM content_assignments WHERE user_id=? AND content_type='tutorial' AND content_id=? AND status='assigned'").get(uid, tutorial.id);
  if (!res.locals.moduleAccess.tutorials && !assigned) return res.status(403).send('This content is not assigned to your account yet.');
  const filePath = path.join(__dirname, '../private/materials', tutorial.video_path);
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing');

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  res.setHeader('Cache-Control', 'private, no-store');
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4' });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ---------- Study Material (unlocked module = see all; otherwise only assigned) ----------
function materialFileMetaStudent(m) {
  const dir = path.join(__dirname, '../private/materials');
  let filename = null;
  if (m.content_type === 'video' && m.video_path) filename = m.video_path;
  else if (m.file_path) filename = m.file_path;
  else if (m.pdf_path) filename = m.pdf_path;
  let sizeBytes = m.file_size_bytes || null;
  if (!sizeBytes && filename) {
    try { sizeBytes = fs.statSync(path.join(dir, filename)).size; } catch (e) { sizeBytes = null; }
  }
  const sizeLabel = sizeBytes ? (sizeBytes > 1024 * 1024 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(sizeBytes / 1024)} KB`) : '—';
  const badgeMap = { video: 'Video', link: 'Link', ppt: 'PPT', zip: 'ZIP', doc: 'Doc', docx: 'Doc' };
  const badge = badgeMap[(m.content_type || '').toLowerCase()] || 'PDF';
  return { badge, sizeLabel };
}

router.get('/material', (req, res) => {
  const uid = req.session.user.id;
  const { subject_id, type, q } = req.query;
  const moduleUnlocked = res.locals.moduleAccess.material;

  let sql = `SELECT m.*, s.name AS subject_name, ca.assigned_by
             FROM study_materials m
             LEFT JOIN subjects s ON s.id = m.subject_id
             LEFT JOIN content_assignments ca ON ca.content_type='study_material' AND ca.content_id=m.id AND ca.user_id=? AND ca.status='assigned'
             WHERE m.is_published = 1`;
  const params = [uid];
  if (!moduleUnlocked) {
    sql += ` AND m.id IN (SELECT content_id FROM content_assignments WHERE user_id = ? AND content_type = 'study_material' AND status = 'assigned')`;
    params.push(uid);
  }
  if (subject_id) { sql += ' AND m.subject_id = ?'; params.push(subject_id); }
  if (q) { sql += ' AND (m.title LIKE ? OR s.name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY m.created_at DESC';
  let materials = db.prepare(sql).all(...params);

  const assignedByName = {};
  materials = materials.map((m) => {
    if (m.assigned_by && !assignedByName[m.assigned_by]) {
      const teacher = db.prepare('SELECT name FROM users WHERE id = ?').get(m.assigned_by);
      assignedByName[m.assigned_by] = teacher ? teacher.name : 'Teacher';
    }
    return { ...m, assigned_by_name: m.assigned_by ? assignedByName[m.assigned_by] : null, fileMeta: materialFileMetaStudent(m) };
  });

  if (type) materials = materials.filter((m) => m.fileMeta.badge === type);

  const stats = {
    total: materials.length,
    notes: materials.filter((m) => ['PDF', 'Doc'].includes(m.fileMeta.badge)).length,
    videos: materials.filter((m) => m.fileMeta.badge === 'Video').length,
    links: materials.filter((m) => m.fileMeta.badge === 'Link').length,
    others: materials.filter((m) => ['PPT', 'ZIP'].includes(m.fileMeta.badge)).length,
  };
  const bySubject = {};
  materials.forEach((m) => { if (m.subject_name) bySubject[m.subject_name] = (bySubject[m.subject_name] || 0) + 1; });

  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('student/material', { materials, subjects, stats, bySubject, selectedSubject: subject_id || '', selectedType: type || '', q: q || '', moduleUnlocked });
});

// ---------- Single Study Material view: preview, download, comments ----------
router.get('/material/:id', (req, res) => {
  const uid = req.session.user.id;
  const material = db.prepare(
    `SELECT m.*, s.name AS subject_name FROM study_materials m LEFT JOIN subjects s ON s.id = m.subject_id WHERE m.id = ? AND m.is_published = 1`
  ).get(req.params.id);
  if (!material) { req.flash('error', 'Study material not found.'); return res.redirect('/student/material'); }

  const assignment = db.prepare(
    "SELECT * FROM content_assignments WHERE user_id=? AND content_type='study_material' AND content_id=? AND status='assigned'"
  ).get(uid, material.id);
  if (!res.locals.moduleAccess.material && !assignment) {
    req.flash('error', 'This study material is not assigned to your account yet.');
    return res.redirect('/student/material');
  }

  db.prepare('UPDATE study_materials SET views = views + 1 WHERE id = ?').run(material.id);

  let assignedBy = null;
  if (assignment && assignment.assigned_by) {
    assignedBy = db.prepare('SELECT name FROM users WHERE id = ?').get(assignment.assigned_by);
  }

  const comments = db.prepare(
    `SELECT c.*, u.name AS user_name, u.role AS user_role FROM study_material_comments c
     JOIN users u ON u.id = c.user_id WHERE c.material_id = ? ORDER BY c.created_at`
  ).all(material.id);

  const otherMaterials = db.prepare(
    `SELECT id, title FROM study_materials WHERE subject_id = ? AND id != ? AND is_published = 1 ORDER BY created_at DESC LIMIT 8`
  ).all(material.subject_id, material.id);

  res.render('student/material_view', {
    material: { ...material, fileMeta: materialFileMetaStudent(material) },
    assignment, assignedBy, comments, otherMaterials,
  });
});

router.post('/material/:id/comment', (req, res) => {
  const uid = req.session.user.id;
  const material = db.prepare('SELECT * FROM study_materials WHERE id = ?').get(req.params.id);
  if (!material || !material.allow_comments || !req.body.body || !req.body.body.trim()) {
    return res.redirect(`/student/material/${req.params.id}`);
  }
  db.prepare('INSERT INTO study_material_comments (material_id, user_id, parent_id, body) VALUES (?,?,NULL,?)')
    .run(material.id, uid, req.body.body.trim());
  const teacher = material.created_by
    ? db.prepare('SELECT id FROM users WHERE id = ?').get(material.created_by)
    : db.prepare("SELECT id FROM users WHERE role IN ('admin','teacher') LIMIT 1").get();
  if (teacher) {
    const student = db.prepare('SELECT name FROM users WHERE id = ?').get(uid);
    notify(teacher.id, 'material_comment', 'New Question on Study Material', `${student.name} asked a question on "${material.title}".`, `/admin/material/${material.id}/comments`);
  }
  res.redirect(`/student/material/${req.params.id}`);
});

// ---------- Secure study material file delivery (PDF/Doc/PPT/ZIP/Video) ----------
router.get('/material/:id/file', requireVerified, (req, res) => {
  const uid = req.session.user.id;
  const material = db.prepare('SELECT * FROM study_materials WHERE id = ? AND is_published = 1').get(req.params.id);
  if (!material) return res.status(404).send('Not found');
  const individuallyAssigned = db.prepare(
    "SELECT 1 FROM content_assignments WHERE user_id = ? AND content_type = 'study_material' AND content_id = ? AND status = 'assigned'"
  ).get(uid, material.id);
  if (!res.locals.moduleAccess.material && !individuallyAssigned) {
    return res.status(403).send('This content is not assigned to your account yet.');
  }
  if (!material.allow_download && req.query.dl === '1') {
    return res.status(403).send('Downloading this file is not allowed.');
  }
  const filename = material.content_type === 'video' ? material.video_path : (material.file_path || material.pdf_path);
  if (!filename) return res.status(404).send('Not found');
  const filePath = path.join(__dirname, '../private/materials', filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing');

  if (material.content_type === 'video') {
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    res.setHeader('Cache-Control', 'private, no-store');
    if (!range) {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
      return fs.createReadStream(filePath).pipe(res);
    }
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4' });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.query.dl === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${material.title.replace(/[^a-z0-9 .-]/gi, '')}${path.extname(filename)}"`);
  } else {
    res.setHeader('Content-Disposition', 'inline');
  }
  fs.createReadStream(filePath).pipe(res);
});

// The course player for one subject — sidebar of modules/lessons + main viewer.
router.get('/material/course/:subjectId', (req, res) => {
  const uid = req.session.user.id;
  const moduleUnlocked = res.locals.moduleAccess.material;
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(req.params.subjectId);
  if (!subject) return res.redirect('/student/material');

  const modules = db.prepare(
    'SELECT * FROM course_modules WHERE subject_id = ? ORDER BY order_no, id'
  ).all(subject.id);
  let lessons = db.prepare(
    'SELECT * FROM study_materials WHERE subject_id = ? AND is_published = 1 ORDER BY module_id, order_no, id'
  ).all(subject.id);

  if (!moduleUnlocked) {
    const assignedIds = new Set(
      db.prepare("SELECT content_id FROM content_assignments WHERE user_id = ? AND content_type = 'study_material' AND status = 'assigned'").all(uid).map((r) => r.content_id)
    );
    lessons = lessons.filter((l) => assignedIds.has(l.id));
  }

  const lessonId = req.query.lesson ? Number(req.query.lesson) : (lessons[0] ? lessons[0].id : null);
  const activeLesson = lessons.find((l) => l.id === lessonId) || lessons[0] || null;

  res.render('student/material_course', { subject, modules, lessons, activeLesson });
});

// ---------- Secure lesson delivery: authenticated, session-gated, never a public URL ----------
// PDFs and videos live outside /public entirely, so the ONLY way to reach the
// bytes is through these routes — which require an active, verified, module-
// unlocked student session. The URL exposes only a numeric lesson id, never
// a filename or filesystem path.
function loadLessonFile(req, res, kind) {
  const lesson = db.prepare('SELECT * FROM study_materials WHERE id = ? AND is_published = 1').get(req.params.id);
  if (!lesson) return res.status(404).send('Not found');

  const uid = req.session.user.id;
  const individuallyAssigned = db.prepare(
    "SELECT 1 FROM content_assignments WHERE user_id = ? AND content_type = 'study_material' AND content_id = ? AND status = 'assigned'"
  ).get(uid, lesson.id);
  if (!res.locals.moduleAccess.material && !individuallyAssigned) {
    return res.status(403).send('This content is not assigned to your account yet.');
  }
  const filename = kind === 'video' ? lesson.video_path : lesson.pdf_path;
  if (!filename) return res.status(404).send('Not found');
  return path.join(__dirname, '../private/materials', filename);
}

router.get('/material/lesson/:id/pdf', requireVerified, (req, res) => {
  const filePath = loadLessonFile(req, res, 'pdf');
  if (!filePath || res.headersSent) return;
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="material.pdf"');
  // No-cache + no direct save prompt — keeps this tied to the authenticated view.
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(filePath).pipe(res);
});

router.get('/material/lesson/:id/video', requireVerified, (req, res) => {
  const filePath = loadLessonFile(req, res, 'video');
  if (!filePath || res.headersSent) return;
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing');

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  res.setHeader('Cache-Control', 'private, no-store');

  if (!range) {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
    return fs.createReadStream(filePath).pipe(res);
  }
  // Range support is required for the <video> seek bar to work at all.
  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4',
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

// ---------- Progress & Analytics ----------
router.get('/progress', (req, res) => {
  const uid = req.session.user.id;
  const plans = db.prepare(
    `SELECT sp.*, p.name AS plan_name, p.mcq_count FROM student_mcq_plans sp
     JOIN mcq_plans p ON p.id = sp.plan_id WHERE sp.user_id = ?`
  ).all(uid);
  const totalMcqAllowed = plans.reduce((s, p) => s + p.mcq_count, 0);
  const totalMcqAssigned = plans.reduce((s, p) => s + p.assigned_mcqs, 0);
  const totalMcqRemaining = plans.reduce((s, p) => s + p.remaining_mcqs, 0); // purchased but not yet assigned by a teacher

  const usedRow = db.prepare(
    `SELECT COUNT(*) c FROM mcq_assignment_questions aq
     JOIN mcq_assignments a ON a.id = aq.assignment_id
     WHERE a.user_id = ? AND aq.answered_at IS NOT NULL`
  ).get(uid);
  const totalMcqUsed = usedRow.c; // actually answered so far, across all assignments

  const examResults = db.prepare(
    `SELECT p.title, s.status, s.total_score, s.total_marks, s.submitted_at
     FROM exam_assignments a
     JOIN exam_papers p ON p.id = a.paper_id
     JOIN exam_submissions s ON s.assignment_id = a.id
     WHERE a.user_id = ? AND s.status = 'published'
     ORDER BY s.submitted_at ASC`
  ).all(uid);

  const avgScore = examResults.length
    ? Math.round(examResults.reduce((sum, r) => sum + (r.total_marks ? (r.total_score / r.total_marks) * 100 : 0), 0) / examResults.length)
    : 0;

  res.render('student/progress', { plans, totalMcqAllowed, totalMcqAssigned, totalMcqUsed, totalMcqRemaining, examResults, avgScore });
});

// ---------- Student Profile ----------
router.get('/profile', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const uid = req.session.user.id;

  // Order details — full-paper purchases + MCQ plan purchases, newest first.
  const paperOrders = db.prepare(
    `SELECT o.id, p.title AS name, 'Full Exam Paper' AS kind, o.amount, o.created_at, o.status
     FROM exam_orders o JOIN exam_papers p ON p.id = o.paper_id WHERE o.user_id = ?`
  ).all(uid);
  const planOrders = db.prepare(
    `SELECT sp.id, mp.name AS name, 'MCQ Plan' AS kind, sp.amount_paid AS amount, sp.purchased_at AS created_at, 'paid' AS status
     FROM student_mcq_plans sp JOIN mcq_plans mp ON mp.id = sp.plan_id WHERE sp.user_id = ?`
  ).all(uid);
  const orders = [...paperOrders, ...planOrders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.render('student/profile', { student: user, orders });
});

router.post('/profile', (req, res) => {
  const b = req.body;
  const cleanPhone = String(b.phone || '').replace(/\D/g, '');
  if (cleanPhone) {
    const existingPhone = db.prepare(
      "SELECT id FROM users WHERE id != ? AND phone IS NOT NULL AND substr(phone, -9) = substr(?, -9)"
    ).get(req.session.user.id, cleanPhone);
    if (existingPhone) {
      req.flash('error', 'That phone number is already used by another account.');
      return res.redirect('/student/profile');
    }
  }
  db.prepare(
    `UPDATE users SET name = ?, phone = ?, father_name = ?, address = ?, class_year = ?,
     dob = ?, gender = ?, father_phone = ?, alt_phone = ?,
     address_line2 = ?, city = ?, state = ?, postal_code = ?, country = ?,
     school_name = ?, emergency_name = ?, emergency_relation = ?, emergency_phone = ?, medical_info = ?
     WHERE id = ?`
  ).run(
    b.name, cleanPhone || null, b.father_name || null, b.address || null, b.class_year || null,
    b.dob || null, b.gender || null, String(b.father_phone || '').replace(/\D/g, '') || null, String(b.alt_phone || '').replace(/\D/g, '') || null,
    b.address_line2 || null, b.city || null, b.state || null, b.postal_code || null, b.country || 'Australia',
    b.school_name || null, b.emergency_name || null, b.emergency_relation || null, String(b.emergency_phone || '').replace(/\D/g, '') || null, b.medical_info || null,
    req.session.user.id
  );

  req.session.user.name = b.name; // keep topbar/session in sync immediately
  logAction(req, 'profile_updated', { recordType: 'user', recordId: req.session.user.id });
  req.flash('success', 'Profile updated successfully.');
  res.redirect('/student/profile');
});

router.post('/profile/photo', uploadPhoto.single('photo'), (req, res) => {
  if (req.file) {
    db.prepare('UPDATE users SET profile_image = ? WHERE id = ?')
      .run(`/uploads/${req.file.filename}`, req.session.user.id);
    req.flash('success', 'Profile photo updated.');
  } else {
    req.flash('error', 'Please choose an image file (max 2MB).');
  }
  res.redirect('/student/profile');
});

router.post('/profile/password', (req, res) => {
  const { current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(current_password, user.password)) {
    req.flash('error', 'Current password is incorrect');
    return res.redirect('/student/profile');
  }
  const hash = bcrypt.hashSync(new_password, 8);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
  sendEmail({
    to: user.email, userId: user.id, subject: 'Your AUS Academy password was changed', template: 'password_changed',
    relatedType: 'user', relatedId: user.id,
    html: renderEmail({ heading: 'Password Changed', name: user.name, intro: 'Your account password was just changed. If this was not you, please reset your password straight away or contact your teacher.', cta: { label: 'Go to Login', link: '/login' }, note: 'For your security we never include your password in emails.' }),
  }).catch(() => {});
  req.flash('success', 'Password changed successfully');
  res.redirect('/student/profile');
});

// ---------- Question Issue reporting (student can flag a problem) ----------
router.get('/report-issue', (req, res) => {
  const { type, id } = req.query;
  if (!['mcq', 'exam_paper_question'].includes(type) || !id) return res.redirect('/student/dashboard');
  res.render('student/report_issue', { type, id });
});

router.post('/report-issue', (req, res) => {
  const { question_type, question_id, issue_type, description } = req.body;
  if (!['mcq', 'exam_paper_question'].includes(question_type) || !question_id || !issue_type) {
    req.flash('error', 'Please fill in the issue details');
    return res.redirect(req.get('Referer') || '/student/dashboard');
  }
  db.prepare(
    `INSERT INTO question_issues (question_type, question_id, reported_by, issue_type, description)
     VALUES (?,?,?,?,?)`
  ).run(question_type, question_id, req.session.user.id, issue_type, description || null);

  const staff = db.prepare("SELECT id FROM users WHERE role IN ('admin','teacher')").all();
  staff.forEach((s) => notify(s.id, 'question_issue', 'A student flagged a question', `${req.session.user.name} reported: ${issue_type}`, '/admin/question-issues'));

  req.flash('success', 'Thanks — your teacher has been notified and will review this question.');
  res.redirect('/student/dashboard');
});

// ---------- Help / Documentation ----------
router.get('/help', (req, res) => {
  const { renderDocumentation } = require('../lib/docs');
  res.render('student/help', { docHtml: renderDocumentation() });
});

module.exports = router;
