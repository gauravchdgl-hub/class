const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/dashboard', (req, res) => {
  const stats = {
    students: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student'").get().c,
    papers: db.prepare('SELECT COUNT(*) c FROM exam_papers').get().c,
    plans: db.prepare('SELECT COUNT(*) c FROM mcq_plans').get().c,
    pending: db.prepare("SELECT COUNT(*) c FROM exam_submissions WHERE status='pending_review'").get().c,
  };
  res.render('admin/dashboard', { stats });
});

// ---------- Subjects ----------
router.get('/subjects', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('admin/subjects', { subjects });
});
router.post('/subjects', (req, res) => {
  const { name, year } = req.body;
  db.prepare('INSERT INTO subjects (name, year) VALUES (?,?)').run(name, year);
  req.flash('success', 'Subject added');
  res.redirect('/admin/subjects');
});

// ---------- MCQ Plans ----------
router.get('/mcq-plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM mcq_plans').all();
  res.render('admin/mcq_plans', { plans });
});
router.post('/mcq-plans', (req, res) => {
  const { name, mcq_count, price, validity_days } = req.body;
  db.prepare('INSERT INTO mcq_plans (name, mcq_count, price, validity_days) VALUES (?,?,?,?)')
    .run(name, mcq_count, price, validity_days);
  req.flash('success', 'MCQ plan created (any MCQ count allowed)');
  res.redirect('/admin/mcq-plans');
});

// ---------- MCQ bank ----------
router.get('/mcqs', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  const mcqs = db.prepare(
    `SELECT m.*, s.name AS subject_name FROM mcqs m JOIN subjects s ON s.id = m.subject_id ORDER BY m.id DESC LIMIT 50`
  ).all();
  res.render('admin/mcqs', { subjects, mcqs });
});
router.post('/mcqs', (req, res) => {
  const { subject_id, year, topic, question, option_a, option_b, option_c, option_d, correct_option } = req.body;
  db.prepare(
    `INSERT INTO mcqs (subject_id, year, topic, question, option_a, option_b, option_c, option_d, correct_option)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(subject_id, year, topic, question, option_a, option_b, option_c, option_d, correct_option);
  req.flash('success', 'MCQ added to bank (add as many as you like)');
  res.redirect('/admin/mcqs');
});

// ---------- Full Exam Papers ----------
router.get('/papers', (req, res) => {
  const papers = db.prepare(
    `SELECT p.*, s.name AS subject_name FROM exam_papers p JOIN subjects s ON s.id = p.subject_id ORDER BY p.id DESC`
  ).all();
  res.render('admin/papers', { papers });
});

router.get('/papers/new', (req, res) => {
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('admin/paper_new', { subjects });
});

router.post('/papers/new', (req, res) => {
  const { title, year, subject_id, price, duration_minutes } = req.body;
  const paperId = db.prepare(
    'INSERT INTO exam_papers (title, year, subject_id, price, duration_minutes) VALUES (?,?,?,?,?)'
  ).run(title, year, subject_id, price, duration_minutes || 120).lastInsertRowid;
  req.flash('success', 'Paper created. Now add MCQ / written / essay questions (any number you like).');
  res.redirect(`/admin/papers/${paperId}`);
});

router.get('/papers/:id', (req, res) => {
  const paper = db.prepare(
    `SELECT p.*, s.name AS subject_name FROM exam_papers p JOIN subjects s ON s.id = p.subject_id WHERE p.id = ?`
  ).get(req.params.id);
  if (!paper) return res.redirect('/admin/papers');
  const questions = db.prepare('SELECT * FROM exam_paper_questions WHERE paper_id = ? ORDER BY order_no').all(paper.id);
  res.render('admin/paper_detail', { paper, questions });
});

router.post('/papers/:id/questions', (req, res) => {
  const paperId = req.params.id;
  const { type, question, option_a, option_b, option_c, option_d, correct_option, marks, word_limit } = req.body;
  const maxOrder = db.prepare('SELECT MAX(order_no) m FROM exam_paper_questions WHERE paper_id = ?').get(paperId).m || 0;
  db.prepare(
    `INSERT INTO exam_paper_questions
     (paper_id, type, question, option_a, option_b, option_c, option_d, correct_option, marks, word_limit, order_no)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    paperId, type, question,
    type === 'mcq' ? option_a : null, type === 'mcq' ? option_b : null,
    type === 'mcq' ? option_c : null, type === 'mcq' ? option_d : null,
    type === 'mcq' ? correct_option : null,
    marks || 1, word_limit || null, maxOrder + 1
  );
  req.flash('success', `${type.toUpperCase()} question added (you can add as many written/essay/MCQ questions as needed)`);
  res.redirect(`/admin/papers/${paperId}`);
});

router.post('/papers/:paperId/questions/:qId/delete', (req, res) => {
  db.prepare('DELETE FROM exam_paper_questions WHERE id = ? AND paper_id = ?').run(req.params.qId, req.params.paperId);
  res.redirect(`/admin/papers/${req.params.paperId}`);
});

router.post('/papers/:id/publish', (req, res) => {
  db.prepare('UPDATE exam_papers SET is_published = 1 WHERE id = ?').run(req.params.id);
  req.flash('success', 'Paper published on website');
  res.redirect(`/admin/papers/${req.params.id}`);
});

// ---------- Submissions review ----------
router.get('/submissions', (req, res) => {
  const submissions = db.prepare(
    `SELECT s.*, a.id AS assignment_id, p.title, u.name AS student_name, u.email
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     JOIN users u ON u.id = a.user_id
     ORDER BY s.submitted_at DESC`
  ).all();
  res.render('admin/submissions', { submissions });
});

router.get('/submissions/:id/review', (req, res) => {
  const submission = db.prepare(
    `SELECT s.*, a.id AS assignment_id, a.paper_id, p.title, u.name AS student_name, u.email
     FROM exam_submissions s
     JOIN exam_assignments a ON a.id = s.assignment_id
     JOIN exam_papers p ON p.id = a.paper_id
     JOIN users u ON u.id = a.user_id
     WHERE s.id = ?`
  ).get(req.params.id);
  if (!submission) return res.redirect('/admin/submissions');

  const answers = db.prepare(
    `SELECT ans.*, q.type, q.question, q.marks, q.word_limit, q.order_no
     FROM exam_answers ans JOIN exam_paper_questions q ON q.id = ans.question_id
     WHERE ans.submission_id = ? ORDER BY q.order_no`
  ).all(submission.id);

  res.render('admin/review', {
    submission,
    written: answers.filter((a) => a.type === 'written'),
    essays: answers.filter((a) => a.type === 'essay'),
    mcqCount: answers.filter((a) => a.type === 'mcq').length,
  });
});

router.post('/submissions/:id/review', (req, res) => {
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE id = ?').get(req.params.id);
  if (!submission) return res.redirect('/admin/submissions');

  const answers = db.prepare(
    `SELECT ans.id, q.type, q.marks FROM exam_answers ans
     JOIN exam_paper_questions q ON q.id = ans.question_id WHERE ans.submission_id = ?`
  ).all(submission.id);

  const updAns = db.prepare('UPDATE exam_answers SET marks_awarded = ?, feedback = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?');
  let writtenScore = 0, essayScore = 0;

  answers.forEach((a) => {
    if (a.type === 'mcq') return;
    const marksField = req.body[`marks_${a.id}`];
    const feedbackField = req.body[`feedback_${a.id}`] || '';
    const marks = marksField !== undefined ? Math.min(parseFloat(marksField) || 0, a.marks) : 0;
    updAns.run(marks, feedbackField, a.id);
    if (a.type === 'written') writtenScore += marks;
    if (a.type === 'essay') essayScore += marks;
  });

  const totalScore = submission.mcq_score + writtenScore + essayScore;
  const totalMarks = submission.mcq_total + submission.written_total + submission.essay_total;

  db.prepare(
    `UPDATE exam_submissions SET written_score = ?, essay_score = ?, total_score = ?, total_marks = ?, status = 'published'
     WHERE id = ?`
  ).run(writtenScore, essayScore, totalScore, totalMarks, submission.id);
  db.prepare('UPDATE exam_assignments SET status = ? WHERE id = ?').run('reviewed', submission.assignment_id);

  req.flash('success', 'Result published. Student can now view feedback.');
  res.redirect('/admin/submissions');
});

module.exports = router;
