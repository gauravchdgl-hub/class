// Suppress Node's runtime deprecation warnings (e.g. util.isArray from older
// sub-dependencies) and dotenv's own "injected env" console log — these are
// harmless noise, not errors, but keep production logs clean.
process.noDeprecation = true;
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  // Silence Node's "ExperimentalWarning: SQLite is an experimental feature"
  // notice — we use node:sqlite intentionally and it's stable enough for our
  // use case; everything else still logs normally.
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.warn(warning);
});
require('dotenv').config({ quiet: true });
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const flash = require('connect-flash');

require('./db/seed');
const db = require('./db');

// Lightens a #rrggbb hex color by `percent` — used to derive a secondary
// gradient shade from the admin-configured theme primary color.
function lightenHex(hex, percent) {
  try {
    const num = parseInt(hex.replace('#', ''), 16);
    let r = (num >> 16) + Math.round(255 * (percent / 100));
    let g = ((num >> 8) & 0x00ff) + Math.round(255 * (percent / 100));
    let b = (num & 0x0000ff) + Math.round(255 * (percent / 100));
    r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
    return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
  } catch (e) {
    return hex;
  }
}

const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/student');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhook');
const stripeWebhookRoutes = require('./routes/stripeWebhook');
const notificationRoutes = require('./routes/notifications');
const emailNotificationRoutes = require('./routes/emailNotifications');
const { startEmailScheduler } = require('./lib/emailScheduler');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Express caches compiled EJS templates in memory by default when NODE_ENV=production.
// That means a page edit only takes effect after the Node process restarts — overwriting
// the .ejs files on the server is NOT enough on its own. Disabling this trades a tiny bit of
// per-request render speed for every file change always showing up immediately, which matters
// far more than the performance cost for a panel this size.
app.set('view cache', false);

// Stripe webhook needs the RAW body for signature verification, so it must
// be mounted before express.json() touches the request body.
app.use('/webhook', stripeWebhookRoutes);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new FileStore({ path: path.join(__dirname, 'db', 'sessions'), logFn: () => {} }),
  secret: process.env.SESSION_SECRET || 'aus-academy-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));
app.use(flash());

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  const logo = db.prepare("SELECT value FROM site_settings WHERE key = 'logo_url'").get();
  res.locals.siteLogo = logo ? logo.value : '';
  const heroImg = db.prepare("SELECT value FROM site_settings WHERE key = 'hero_image_url'").get();
  res.locals.heroImageUrl = heroImg && heroImg.value ? heroImg.value : 'https://images.unsplash.com/photo-1506973035872-a4ec16b8e8d9?w=1920&auto=format&fit=crop&q=80';
  const platformNameRow = db.prepare("SELECT value FROM site_settings WHERE key = 'platform_name'").get();
  res.locals.platformName = platformNameRow && platformNameRow.value ? platformNameRow.value : 'AUS Academy';
  const portalDescRow = db.prepare("SELECT value FROM site_settings WHERE key = 'portal_description'").get();
  res.locals.portalDescription = portalDescRow ? portalDescRow.value : '';
  const fontRow = db.prepare("SELECT value FROM site_settings WHERE key = 'theme_font_family'").get();
  const colorRow = db.prepare("SELECT value FROM site_settings WHERE key = 'theme_primary_color'").get();
  res.locals.themeFont = fontRow ? fontRow.value : 'Inter';
  res.locals.themeColor = colorRow ? colorRow.value : '#566dfb';
  res.locals.themeColor2 = lightenHex(res.locals.themeColor, 22);
  const loginTextKeys = [
    'brand_name', 'brand_tagline',
    'login_student_tag', 'login_student_hero_title', 'login_student_hero_text',
    'login_student_bullet1', 'login_student_bullet2', 'login_student_bullet3',
    'login_student_title', 'login_student_subtitle',
    'login_staff_tag', 'login_staff_hero_title', 'login_staff_hero_text',
    'login_staff_bullet1', 'login_staff_bullet2', 'login_staff_bullet3',
    'login_staff_title', 'login_staff_subtitle',
  ];
  const loginTextDefaults = {
    brand_name: 'AUS Academy',
    brand_tagline: 'Australia • Year 11–12',
    login_student_tag: 'SECURE PORTAL ACCESS',
    login_student_hero_title: 'One platform. Two clear journeys.',
    login_student_hero_text: 'Students practise and complete exams. Admin/Teacher manages content, assignments, marking and feedback.',
    login_student_bullet1: 'Student portal with MCQ plans and full papers',
    login_student_bullet2: 'Instant MCQ results + written/essay feedback',
    login_student_bullet3: '50 free MCQs on signup',
    login_student_title: 'Student Sign in',
    login_student_subtitle: 'Use your email and password to continue.',
    login_staff_tag: 'SECURE STAFF WORKSPACE',
    login_staff_hero_title: 'Manage students, courses, exams and results.',
    login_staff_hero_text: 'Admin and Teacher access, all from one secure workspace — content, assignments, marking and feedback.',
    login_staff_bullet1: 'Create papers, MCQs, and study material',
    login_staff_bullet2: 'Assign content and review submissions',
    login_staff_bullet3: 'Role-based access for Admin and Teacher',
    login_staff_title: 'Welcome back',
    login_staff_subtitle: 'Sign in to manage students, courses, exams and results.',
  };
  const loginText = {};
  loginTextKeys.forEach((k) => {
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(k);
    loginText[k] = row && row.value ? row.value : loginTextDefaults[k];
  });
  res.locals.loginText = loginText;
  if (req.session.user) {
    res.locals.unreadNotifications = db.prepare(
      'SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(req.session.user.id).c;
    res.locals.recentNotifications = db.prepare(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 6'
    ).all(req.session.user.id);
  } else {
    res.locals.unreadNotifications = 0;
    res.locals.recentNotifications = [];
  }
  next();
});

// WooCommerce (WordPress website) calls this to hand off a paid Full Exam
// Paper order into the portal. Mounted before session/flash since it is a
// server-to-server JSON API, not a browser page.
app.use('/api/woo', webhookRoutes);

app.use('/', publicRoutes);
app.use('/', authRoutes);
app.use('/notifications', notificationRoutes);
app.use('/student', studentRoutes);
app.use('/admin/email-notifications', emailNotificationRoutes); // must precede adminRoutes
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).render('public/404');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AUS Academy running on http://localhost:${PORT}`);
  startEmailScheduler(); // sends Scheduled emails + creates exam reminders
});

module.exports = app;
