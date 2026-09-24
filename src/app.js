require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const flash = require('connect-flash');

require('./db/seed');
const db = require('./db');

const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/student');
const adminRoutes = require('./routes/admin');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'aus-academy-secret',
  resave: false,
  saveUninitialized: false,
}));
app.use(flash());

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  const logo = db.prepare("SELECT value FROM site_settings WHERE key = 'logo_url'").get();
  res.locals.siteLogo = logo ? logo.value : '';
  next();
});

app.use('/', publicRoutes);
app.use('/', authRoutes);
app.use('/student', studentRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).render('public/404');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AUS Academy running on http://localhost:${PORT}`));

module.exports = app;
