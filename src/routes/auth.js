const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

router.get('/login', (req, res) => res.render('public/login'));

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    req.flash('error', 'Invalid email or password');
    return res.redirect('/login');
  }
  if (user.role === 'admin' || user.role === 'teacher') {
    req.flash('error', 'Please use the Staff Login page for Teacher/Admin accounts');
    return res.redirect('/staff-login');
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.redirect('/student/dashboard');
});

router.get('/staff-login', (req, res) => res.render('public/staff_login'));

router.post('/staff-login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    req.flash('error', 'Invalid email or password');
    return res.redirect('/staff-login');
  }
  if (user.role !== 'admin' && user.role !== 'teacher') {
    req.flash('error', 'Please use the Student Login page for student accounts');
    return res.redirect('/login');
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.redirect('/admin/dashboard');
});

router.get('/register', (req, res) => res.render('public/register'));

router.post('/register', (req, res) => {
  const { name, email, password } = req.body;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    req.flash('error', 'Account already exists, please login');
    return res.redirect('/login');
  }
  const hash = bcrypt.hashSync(password, 8);
  const id = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)')
    .run(name, email, hash, 'student').lastInsertRowid;

  const freePlan = db.prepare("SELECT * FROM mcq_plans WHERE name = 'Free Plan'").get();
  if (freePlan) {
    const expiresAt = new Date(Date.now() + freePlan.validity_days * 86400000).toISOString();
    db.prepare(
      `INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at)
       VALUES (?,?,NULL,NULL,?,?)`
    ).run(id, freePlan.id, freePlan.mcq_count, expiresAt);
  }

  req.session.user = { id, name, email, role: 'student' };
  req.flash('success', `Account created! You got ${freePlan ? freePlan.mcq_count : 0} free MCQs to start practicing.`);
  res.redirect('/student/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
