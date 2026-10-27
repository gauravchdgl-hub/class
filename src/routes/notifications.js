const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

router.get('/', (req, res) => {
  const uid = req.session.user.id;
  const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(uid);
  const base = req.session.user.role === 'student' ? '/student/dashboard' : '/admin/dashboard';
  res.render('shared/notifications', { notifications, base });
});

router.post('/:id/read', (req, res) => {
  const uid = req.session.user.id;
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, uid);
  if (req.body.link) return res.redirect(req.body.link);
  res.redirect('/notifications');
});

router.post('/mark-all-read', (req, res) => {
  const uid = req.session.user.id;
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(uid);
  res.redirect(req.get('Referer') || '/notifications');
});

module.exports = router;
