const express = require('express');

const router = express.Router();

// This portal (class.eglit.in) is login-only, per spec — no public marketing
// site (no Home/About/Contact/Pricing). Full Exam Papers, Study Material and
// Tutorials are sold on the separate WooCommerce website (eglit.in); this
// app only ever shows /login, /staff-login, and the authenticated portals.
router.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'student' ? '/student/dashboard' : '/admin/dashboard');
  }
  res.redirect('/login');
});

module.exports = router;
