const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

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
  res.render('student/dashboard', { plans, assignments });
});

// ---------- MCQ PLANS ----------
router.get('/mcq/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM mcq_plans').all();
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('student/mcq_plans', { plans, subjects });
});

router.post('/mcq/plans/:id/buy', (req, res) => {
  const plan = db.prepare('SELECT * FROM mcq_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.redirect('/student/mcq/plans');
  const { subject_id, year } = req.body;
  const expiresAt = new Date(Date.now() + plan.validity_days * 86400000).toISOString();
  db.prepare(
    `INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at)
     VALUES (?,?,?,?,?,?)`
  ).run(req.session.user.id, plan.id, subject_id, year, plan.mcq_count, expiresAt);
  req.flash('success', `Plan activated! You now have access to ${plan.mcq_count} MCQs.`);
  res.redirect('/student/mcq/my');
});

router.get('/mcq/my', (req, res) => {
  const uid = req.session.user.id;
  const plans = db.prepare(
    `SELECT sp.*, p.name AS plan_name, p.mcq_count, sub.name AS subject_name
     FROM student_mcq_plans sp
     JOIN mcq_plans p ON p.id = sp.plan_id
     LEFT JOIN subjects sub ON sub.id = sp.subject_id
     WHERE sp.user_id = ?`
  ).all(uid);
  res.render('student/mcq_my', { plans });
});

router.get('/mcq/practice/:planId', (req, res) => {
  const uid = req.session.user.id;
  const plan = db.prepare('SELECT * FROM student_mcq_plans WHERE id = ? AND user_id = ?').get(req.params.planId, uid);
  if (!plan) return res.redirect('/student/mcq/my');
  if (plan.remaining_mcqs <= 0) return res.redirect(`/student/mcq/result/${plan.id}`);

  const answeredIds = db.prepare('SELECT mcq_id FROM mcq_attempts WHERE student_plan_id = ?').all(plan.id).map((r) => r.mcq_id);
  let sql = 'SELECT * FROM mcqs WHERE subject_id = ? AND year = ?';
  const params = [plan.subject_id, plan.year];
  if (answeredIds.length) {
    sql += ` AND id NOT IN (${answeredIds.map(() => '?').join(',')})`;
    params.push(...answeredIds);
  }
  sql += ' ORDER BY id LIMIT 1';
  const mcq = db.prepare(sql).get(...params);
  if (!mcq) return res.redirect(`/student/mcq/result/${plan.id}`);

  const totalAttempted = answeredIds.length;
  const totalAllowed = db.prepare('SELECT p.mcq_count c FROM mcq_plans p WHERE p.id = ?').get(plan.plan_id).c;
  res.render('student/mcq_practice', { plan, mcq, totalAttempted, totalAllowed });
});

router.post('/mcq/practice/:planId/answer', (req, res) => {
  const uid = req.session.user.id;
  const plan = db.prepare('SELECT * FROM student_mcq_plans WHERE id = ? AND user_id = ?').get(req.params.planId, uid);
  if (!plan) return res.redirect('/student/mcq/my');
  const { mcq_id, selected_option } = req.body;
  const mcq = db.prepare('SELECT * FROM mcqs WHERE id = ?').get(mcq_id);
  const isCorrect = mcq && selected_option === mcq.correct_option ? 1 : 0;

  db.prepare(
    'INSERT INTO mcq_attempts (student_plan_id, user_id, mcq_id, selected_option, is_correct) VALUES (?,?,?,?,?)'
  ).run(plan.id, uid, mcq_id, selected_option, isCorrect);

  db.prepare('UPDATE student_mcq_plans SET remaining_mcqs = remaining_mcqs - 1 WHERE id = ?').run(plan.id);

  const updated = db.prepare('SELECT * FROM student_mcq_plans WHERE id = ?').get(plan.id);
  if (updated.remaining_mcqs <= 0) return res.redirect(`/student/mcq/result/${plan.id}`);
  res.redirect(`/student/mcq/practice/${plan.id}`);
});

router.get('/mcq/result/:planId', (req, res) => {
  const uid = req.session.user.id;
  const plan = db.prepare(
    `SELECT sp.*, p.mcq_count FROM student_mcq_plans sp JOIN mcq_plans p ON p.id = sp.plan_id
     WHERE sp.id = ? AND sp.user_id = ?`
  ).get(req.params.planId, uid);
  if (!plan) return res.redirect('/student/mcq/my');
  const stats = db.prepare(
    `SELECT COUNT(*) total, SUM(is_correct) correct FROM mcq_attempts WHERE student_plan_id = ?`
  ).get(plan.id);
  const total = stats.total || 0;
  const correct = stats.correct || 0;
  const score = total ? Math.round((correct / total) * 100) : 0;
  res.render('student/mcq_result', { plan, total, correct, wrong: total - correct, score });
});

// ---------- FULL EXAM PAPERS ----------
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

router.post('/exams/:assignmentId/start', (req, res) => {
  const uid = req.session.user.id;
  const a = db.prepare('SELECT * FROM exam_assignments WHERE id = ? AND user_id = ?').get(req.params.assignmentId, uid);
  if (!a) return res.redirect('/student/dashboard');
  let submission = db.prepare('SELECT * FROM exam_submissions WHERE assignment_id = ?').get(a.id);
  if (!submission) {
    const id = db.prepare('INSERT INTO exam_submissions (assignment_id, status) VALUES (?,?)').run(a.id, 'in_progress').lastInsertRowid;
    db.prepare('UPDATE exam_assignments SET status = ? WHERE id = ?').run('in_progress', a.id);
    submission = { id };
  }
  res.redirect(`/student/exams/${a.id}/take`);
});

router.get('/exams/:assignmentId/take', (req, res) => {
  const uid = req.session.user.id;
  const a = db.prepare(
    `SELECT a.*, p.title, p.duration_minutes FROM exam_assignments a
     JOIN exam_papers p ON p.id = a.paper_id WHERE a.id = ? AND a.user_id = ?`
  ).get(req.params.assignmentId, uid);
  if (!a) return res.redirect('/student/dashboard');
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE assignment_id = ?').get(a.id);
  if (!submission || submission.status !== 'in_progress') return res.redirect(`/student/exams/${a.id}`);

  const questions = db.prepare('SELECT * FROM exam_paper_questions WHERE paper_id = ? ORDER BY order_no').all(a.paper_id);
  const mcqs = questions.filter((q) => q.type === 'mcq');
  const written = questions.filter((q) => q.type === 'written');
  const essays = questions.filter((q) => q.type === 'essay');
  res.render('student/exam_take', { assignment: a, mcqs, written, essays });
});

router.post('/exams/:assignmentId/submit', (req, res) => {
  const uid = req.session.user.id;
  const a = db.prepare('SELECT * FROM exam_assignments WHERE id = ? AND user_id = ?').get(req.params.assignmentId, uid);
  if (!a) return res.redirect('/student/dashboard');
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE assignment_id = ?').get(a.id);
  if (!submission || submission.status !== 'in_progress') return res.redirect(`/student/exams/${a.id}`);

  const questions = db.prepare('SELECT * FROM exam_paper_questions WHERE paper_id = ?').all(a.paper_id);
  let mcqScore = 0, mcqTotal = 0, writtenTotal = 0, essayTotal = 0;

  const insAns = db.prepare(
    'INSERT INTO exam_answers (submission_id, question_id, selected_option, answer_text, is_correct, marks_awarded) VALUES (?,?,?,?,?,?)'
  );

  questions.forEach((q) => {
    if (q.type === 'mcq') {
      mcqTotal += q.marks;
      const selected = req.body[`mcq_${q.id}`] || null;
      const isCorrect = selected === q.correct_option ? 1 : 0;
      if (isCorrect) mcqScore += q.marks;
      insAns.run(submission.id, q.id, selected, null, isCorrect, isCorrect ? q.marks : 0);
    } else if (q.type === 'written') {
      writtenTotal += q.marks;
      const text = req.body[`written_${q.id}`] || '';
      insAns.run(submission.id, q.id, null, text, null, null);
    } else {
      essayTotal += q.marks;
      const text = req.body[`essay_${q.id}`] || '';
      insAns.run(submission.id, q.id, null, text, null, null);
    }
  });

  db.prepare(
    `UPDATE exam_submissions SET status = 'pending_review', submitted_at = CURRENT_TIMESTAMP,
     mcq_score = ?, mcq_total = ?, written_total = ?, essay_total = ? WHERE id = ?`
  ).run(mcqScore, mcqTotal, writtenTotal, essayTotal, submission.id);
  db.prepare('UPDATE exam_assignments SET status = ? WHERE id = ?').run('submitted', a.id);

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

module.exports = router;
