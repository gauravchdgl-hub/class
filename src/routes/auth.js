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
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  if (user.role === 'admin') return res.redirect('/admin/dashboard');
  res.redirect('/student/dashboard');
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
  req.session.user = { id, name, email, role: 'student' };
  req.flash('success', 'Account created successfully');
  res.redirect('/student/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
