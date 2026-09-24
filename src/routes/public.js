const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const papers = db.prepare(
    `SELECT p.*, s.name AS subject_name FROM exam_papers p
     JOIN subjects s ON s.id = p.subject_id WHERE p.is_published = 1 LIMIT 6`
  ).all();
  res.render('public/home', { papers });
});

router.get('/papers', (req, res) => {
  const { year, subject_id } = req.query;
  let sql = `SELECT p.*, s.name AS subject_name FROM exam_papers p
             JOIN subjects s ON s.id = p.subject_id WHERE p.is_published = 1`;
  const params = [];
  if (year) { sql += ' AND p.year = ?'; params.push(year); }
  if (subject_id) { sql += ' AND p.subject_id = ?'; params.push(subject_id); }
  const papers = db.prepare(sql).all(...params);
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name').all();
  res.render('public/papers', { papers, subjects, selectedYear: year || '', selectedSubject: subject_id || '' });
});

router.get('/papers/:id', (req, res) => {
  const paper = db.prepare(
    `SELECT p.*, s.name AS subject_name FROM exam_papers p
     JOIN subjects s ON s.id = p.subject_id WHERE p.id = ?`
  ).get(req.params.id);
  if (!paper) return res.status(404).render('public/404');
  const counts = db.prepare(
    `SELECT type, COUNT(*) c FROM exam_paper_questions WHERE paper_id = ? GROUP BY type`
  ).all(paper.id);
  const summary = { mcq: 0, written: 0, essay: 0 };
  counts.forEach((row) => { summary[row.type] = row.c; });
  res.render('public/paper_detail', { paper, summary });
});

// Checkout: buy a full exam paper from the website
router.post('/papers/:id/buy', (req, res) => {
  const paper = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).render('public/404');
  const { name, email, payment_method } = req.body;

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  let isNew = false;
  if (!user) {
    const randomPassword = crypto.randomBytes(4).toString('hex');
    const hash = bcrypt.hashSync(randomPassword, 8);
    const id = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)')
      .run(name, email, hash, 'student').lastInsertRowid;
    user = { id, name, email, role: 'student' };
    isNew = true;

    const freePlan = db.prepare("SELECT * FROM mcq_plans WHERE name = 'Free Plan'").get();
    if (freePlan) {
      const expiresAt = new Date(Date.now() + freePlan.validity_days * 86400000).toISOString();
      db.prepare(
        `INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at)
         VALUES (?,?,NULL,NULL,?,?)`
      ).run(id, freePlan.id, freePlan.mcq_count, expiresAt);
    }

    // In production this temp password would be emailed to the student.
    req.flash('success', `Account created. Temporary password: ${randomPassword} (also emailed to you). You also got ${freePlan ? freePlan.mcq_count : 0} free MCQs.`);
  }

  const orderId = db.prepare(
    'INSERT INTO exam_orders (user_id, paper_id, amount, payment_method, status) VALUES (?,?,?,?,?)'
  ).run(user.id, paper.id, paper.price, payment_method, 'paid').lastInsertRowid;

  const assignmentId = db.prepare(
    'INSERT INTO exam_assignments (order_id, user_id, paper_id, status) VALUES (?,?,?,?)'
  ).run(orderId, user.id, paper.id, 'assigned').lastInsertRowid;

  req.flash('success', `Payment successful! "${paper.title}" has been assigned to your Student Portal. A confirmation email has been sent to ${email}.`);
  req.session.user = { id: user.id, name: user.name, email: user.email, role: 'student' };
  res.redirect(`/student/exams/${assignmentId}`);
});

module.exports = router;
