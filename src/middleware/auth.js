function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.flash('error', 'Please login first');
    return res.redirect('/login');
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      req.flash('error', 'Access denied');
      return res.redirect('/login');
    }
    next();
  };
}

function requireStaff(req, res, next) {
  if (!req.session.user || !['admin', 'teacher'].includes(req.session.user.role)) {
    req.flash('error', 'Access denied');
    return res.redirect('/login');
  }
  next();
}

// Blocks unverified students from paid/protected actions: buying an MCQ plan,
// practicing MCQs, and starting/submitting an assigned exam. Viewing the
// dashboard itself is still allowed so the student can see the "please
// verify" banner and resend the email.
function requireVerified(req, res, next) {
  if (req.session.user && req.session.user.role === 'student' && !req.session.user.email_verified) {
    req.flash('error', 'Please verify your email first. Check your inbox for the verification link, or resend it from your dashboard.');
    return res.redirect('/student/dashboard');
  }
  next();
}

module.exports = { requireLogin, requireRole, requireStaff, requireVerified };
