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

module.exports = { requireLogin, requireRole, requireStaff };
