const express = require('express');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(requireStaff);

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../public/uploads'),
    filename: (req, file, cb) => cb(null, `logo${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
});

router.get('/dashboard', (req, res) => {
  const stats = {
    students: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student'").get().c,
    papers: db.prepare('SELECT COUNT(*) c FROM exam_papers').get().c,
    plans: db.prepare('SELECT COUNT(*) c FROM mcq_plans').get().c,
    pending: db.prepare("SELECT COUNT(*) c FROM exam_submissions WHERE status='pending_review'").get().c,
  };
  res.render('admin/dashboard', { stats, isAdmin: req.session.user.role === 'admin' });
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

// ---------- Assign / Activate: give a paper to a student directly, no purchase needed ----------
router.get('/assign', (req, res) => {
  const students = db.prepare("SELECT id, name, email FROM users WHERE role = 'student' ORDER BY name").all();
  const papers = db.prepare(
    `SELECT p.*, s.name AS subject_name FROM exam_papers p JOIN subjects s ON s.id = p.subject_id ORDER BY p.id DESC`
  ).all();
  res.render('admin/assign', { students, papers });
});

router.post('/assign', (req, res) => {
  const { user_id, paper_id, message } = req.body;
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(user_id);
  const paper = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(paper_id);
  if (!student || !paper) {
    req.flash('error', 'Please choose a valid student and paper');
    return res.redirect('/admin/assign');
  }

  const orderId = db.prepare(
    'INSERT INTO exam_orders (user_id, paper_id, amount, payment_method, status) VALUES (?,?,?,?,?)'
  ).run(student.id, paper.id, 0, 'assigned_by_staff', 'paid').lastInsertRowid;

  db.prepare(
    'INSERT INTO exam_assignments (order_id, user_id, paper_id, status) VALUES (?,?,?,?)'
  ).run(orderId, student.id, paper.id, 'assigned');

  req.flash('success', `"${paper.title}" assigned to ${student.name}. Email notification sent (demo mode)${message ? ': ' + message : ''}.`);
  res.redirect('/admin/assign');
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
  db.prepare('INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)').run(name, email, hash, 'teacher');
  req.flash('success', 'Teacher account created');
  res.redirect('/admin/teachers');
});

router.post('/teachers/:id/delete', requireAdminOnly, (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'teacher'").run(req.params.id);
  req.flash('success', 'Teacher account removed');
  res.redirect('/admin/teachers');
});

// ---------- Settings (logo = admin only, password = any staff) ----------
router.get('/settings', (req, res) => {
  const logo = db.prepare("SELECT value FROM site_settings WHERE key = 'logo_url'").get();
  res.render('admin/settings', { logoUrl: logo ? logo.value : '' });
});

router.post('/settings/logo', requireAdminOnly, upload.single('logo'), (req, res) => {
  if (req.file) {
    db.prepare("UPDATE site_settings SET value = ? WHERE key = 'logo_url'").run(`/uploads/${req.file.filename}`);
    req.flash('success', 'Logo updated');
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
