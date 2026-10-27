const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(__dirname, 'data.sqlite');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// --- Lightweight migrations (safe to run every boot) ---
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('exam_papers', 'woo_product_id', 'woo_product_id TEXT');
ensureColumn('exam_orders', 'woo_order_id', 'woo_order_id TEXT');
ensureColumn('users', 'phone', 'phone TEXT');
ensureColumn('users', 'father_name', 'father_name TEXT');
ensureColumn('users', 'address', 'address TEXT');
ensureColumn('users', 'class_year', 'class_year TEXT');
ensureColumn('users', 'profile_image', 'profile_image TEXT');
ensureColumn('users', 'email_verified', 'email_verified INTEGER NOT NULL DEFAULT 0');
ensureColumn('student_mcq_plans', 'assigned_mcqs', 'assigned_mcqs INTEGER NOT NULL DEFAULT 0');
ensureColumn('student_mcq_plans', 'amount_paid', 'amount_paid REAL NOT NULL DEFAULT 0');
ensureColumn('exam_submissions', 'expires_at', 'expires_at TEXT');
ensureColumn('exam_submissions', 'is_late', 'is_late INTEGER NOT NULL DEFAULT 0');
ensureColumn('exam_paper_questions', 'excluded_from_scoring', 'excluded_from_scoring INTEGER NOT NULL DEFAULT 0');
ensureColumn('tutorials', 'woo_product_id', 'woo_product_id TEXT');
ensureColumn('study_materials', 'woo_product_id', 'woo_product_id TEXT');
ensureColumn('exam_assignments', 'due_at', 'due_at TEXT');
ensureColumn('exam_assignments', 'instructions', 'instructions TEXT');
ensureColumn('mcqs', 'difficulty', "difficulty TEXT NOT NULL DEFAULT 'medium'");
ensureColumn('mcqs', 'status', "status TEXT NOT NULL DEFAULT 'published'");
ensureColumn('study_materials', 'module_id', 'module_id INTEGER');
ensureColumn('study_materials', 'order_no', 'order_no INTEGER NOT NULL DEFAULT 0');
ensureColumn('study_materials', 'content_type', "content_type TEXT NOT NULL DEFAULT 'pdf'");
ensureColumn('study_materials', 'video_path', 'video_path TEXT');
ensureColumn('study_materials', 'pdf_path', 'pdf_path TEXT');
ensureColumn('study_materials', 'duration_minutes', 'duration_minutes INTEGER DEFAULT 0');
ensureColumn('email_logs', 'body_preview', 'body_preview TEXT');
// Nullable — sendEmail() only started passing subject through after this was
// added, so older rows fall back to a humanized template name in the UI.
ensureColumn('email_logs', 'subject', 'subject TEXT');
ensureColumn('subjects', 'description', "description TEXT DEFAULT ''");
ensureColumn('subjects', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1');
ensureColumn('subjects', 'icon_url', 'icon_url TEXT');
ensureColumn('subjects', 'curriculum', "curriculum TEXT DEFAULT 'au-11-12'");
ensureColumn('subjects', 'is_featured', 'is_featured INTEGER NOT NULL DEFAULT 0');
ensureColumn('subjects', 'allow_comments', 'allow_comments INTEGER NOT NULL DEFAULT 0');
ensureColumn('subjects', 'order_no', 'order_no INTEGER NOT NULL DEFAULT 1');
ensureColumn('subjects', 'tags', "tags TEXT DEFAULT ''");
ensureColumn('subjects', 'enable_mcq', 'enable_mcq INTEGER NOT NULL DEFAULT 1');
ensureColumn('subjects', 'enable_tutorials', 'enable_tutorials INTEGER NOT NULL DEFAULT 1');
ensureColumn('subjects', 'enable_material', 'enable_material INTEGER NOT NULL DEFAULT 1');
ensureColumn('subjects', 'enable_exams', 'enable_exams INTEGER NOT NULL DEFAULT 1');

// Tutorials — Add/Edit Tutorial + Assign Tutorial + Student view (new Tailwind design)
ensureColumn('tutorials', 'thumbnail_url', 'thumbnail_url TEXT');
ensureColumn('tutorials', 'video_path', 'video_path TEXT'); // uploaded video file (private, streamed like study material)
ensureColumn('tutorials', 'level', "level TEXT DEFAULT 'Beginner'");
ensureColumn('tutorials', 'module', 'module TEXT');
ensureColumn('tutorials', 'lesson', 'lesson TEXT');
ensureColumn('tutorials', 'allow_comments', 'allow_comments INTEGER NOT NULL DEFAULT 1');
ensureColumn('tutorials', 'allow_download', 'allow_download INTEGER NOT NULL DEFAULT 0');
ensureColumn('tutorials', 'is_featured', 'is_featured INTEGER NOT NULL DEFAULT 0');
ensureColumn('tutorials', 'tags', "tags TEXT DEFAULT ''");
ensureColumn('tutorials', 'views', 'views INTEGER NOT NULL DEFAULT 0');
ensureColumn('tutorials', 'created_by', 'created_by INTEGER');

// content_assignments — due date / instructions / access, shared by Tutorial + Study Material assignment
ensureColumn('content_assignments', 'due_date', 'due_date TEXT');
ensureColumn('content_assignments', 'instructions', 'instructions TEXT');
ensureColumn('content_assignments', 'access_type', "access_type TEXT DEFAULT 'until_due'"); // until_due | lifetime
ensureColumn('content_assignments', 'allow_download', 'allow_download INTEGER NOT NULL DEFAULT 0');
ensureColumn('content_assignments', 'notify_sent', 'notify_sent INTEGER NOT NULL DEFAULT 0');

// Real WooCommerce order-lifecycle status ('completed' | 'processing' | 'on-hold' |
// 'refunded' | 'cancelled'), distinct from `status`/access state (paid vs
// assigned/revoked). Added nullable (node:sqlite can't ADD COLUMN with a
// non-constant DEFAULT), then backfilled once below for existing rows —
// they were all created via the WooCommerce "order-complete" webhook, which
// only ever fires once WooCommerce itself considers the order completed.
ensureColumn('exam_orders', 'order_status', 'order_status TEXT');
db.prepare("UPDATE exam_orders SET order_status = 'completed' WHERE order_status IS NULL").run();
ensureColumn('content_assignments', 'order_status', 'order_status TEXT');
db.prepare("UPDATE content_assignments SET order_status = 'completed' WHERE order_status IS NULL AND status != 'revoked'").run();

db.exec(`CREATE TABLE IF NOT EXISTS tutorial_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tutorial_id INTEGER NOT NULL,
  progress_percent INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, tutorial_id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS tutorial_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tutorial_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  parent_id INTEGER,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

// Extended profile fields (Student "Profile & Settings" + Teacher/Admin "Settings" pages)
ensureColumn('users', 'bio', 'bio TEXT');
ensureColumn('users', 'dob', 'dob TEXT');
ensureColumn('users', 'gender', 'gender TEXT');
ensureColumn('users', 'address_line2', 'address_line2 TEXT');
ensureColumn('users', 'city', 'city TEXT');
ensureColumn('users', 'state', 'state TEXT');
ensureColumn('users', 'postal_code', 'postal_code TEXT');
ensureColumn('users', 'country', "country TEXT DEFAULT 'Australia'");
ensureColumn('users', 'father_phone', 'father_phone TEXT');
ensureColumn('users', 'alt_phone', 'alt_phone TEXT');
ensureColumn('users', 'school_name', 'school_name TEXT');
ensureColumn('users', 'emergency_name', 'emergency_name TEXT');
ensureColumn('users', 'emergency_relation', 'emergency_relation TEXT');
ensureColumn('users', 'emergency_phone', 'emergency_phone TEXT');
ensureColumn('users', 'medical_info', 'medical_info TEXT');
ensureColumn('users', 'department', 'department TEXT');

// Student Management fields (All Students / Add Student / Student Details pages)
ensureColumn('users', 'student_code', 'student_code TEXT');
ensureColumn('users', 'nationality', "nationality TEXT DEFAULT 'Australian'");
ensureColumn('users', 'class_section', 'class_section TEXT'); // e.g. 12A, 11B
ensureColumn('users', 'username', 'username TEXT');
ensureColumn('users', 'account_status', "account_status TEXT DEFAULT 'active'"); // active | inactive | pending
ensureColumn('users', 'preferred_language', "preferred_language TEXT DEFAULT 'English'");
ensureColumn('users', 'student_timezone', "student_timezone TEXT DEFAULT '(GMT+10:00) Australia/Sydney'");
ensureColumn('users', 'notif_student', 'notif_student INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'notif_parent', 'notif_parent INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'allow_download', 'allow_download INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'allow_exams', 'allow_exams INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'parent_email', 'parent_email TEXT');
ensureColumn('users', 'parent_relationship', 'parent_relationship TEXT');
ensureColumn('users', 'enrolled_at', 'enrolled_at TEXT');
ensureColumn('users', 'interested_subject_id', 'interested_subject_id INTEGER');
// Backfill enrollment date for existing rows so nothing shows blank.
db.exec("UPDATE users SET enrolled_at = created_at WHERE enrolled_at IS NULL");

// Theme defaults (font family + primary color) — editable from Admin Settings
const themeDefaults = {
  theme_font_family: 'Inter', theme_primary_color: '#566dfb',
  platform_name: 'AUS Academy', contact_email: 'admin@ausacademy.com',
  website_url: 'https://eglit.in', timezone: 'Australia/Sydney',
  portal_description: 'Australia Year 11-12 tutorials, practice questions and exam preparation.',
  sms_otp_enabled: '0', sms_provider_choice: 'not_decided',
  // General
  display_language: 'English (Australia)', google_sso_enabled: '0', microsoft_sso_enabled: '0',
  remember_me_enabled: '1', maintenance_mode: '0', debug_logging: '1',
  // Email
  from_name: 'AUS Academy', from_email: 'noreply@ausacademy.com',
  email_footer: '© 2026 AUS Academy. All rights reserved.',
  notify_on_submission: '1', notify_on_grade_published: '1',
  // Payments
  currency: 'AUD', gst_rate: '10', order_prefix: '#AUS-',
  invoice_notes: 'Thank you for studying with AUS Academy.',
  payment_notify_on_failed: '1',
  // Appearance (brand_tagline already covered by login-text settings)
  // Security
  password_min_length: '8', password_expiry_days: '90', require_special_chars: '1',
  enforce_2fa: '1', session_timeout_minutes: '60', ip_whitelist: '',
};
Object.entries(themeDefaults).forEach(([key, value]) => {
  const exists = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
  if (!exists) db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run(key, value);
});
// Existing admin/teacher/student accounts created before this update are
// grandfathered in as verified, so nobody gets locked out by this migration.
db.exec("UPDATE users SET email_verified = 1 WHERE role IN ('admin','teacher')");

// Class & Year Level — dynamic curricula/year-level combos that populate the
// Add Subject form's checkboxes (replaces the old fixed curriculum dropdown
// + Year 11/12-only checkboxes).
db.exec(`CREATE TABLE IF NOT EXISTS class_year_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  curriculum TEXT NOT NULL,
  year_level TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
if (db.prepare('SELECT COUNT(*) c FROM class_year_levels').get().c === 0) {
  // Seed one row that matches the curriculum/years already used by existing subjects,
  // so nothing already saved becomes unselectable in the Add Subject form.
  db.prepare('INSERT INTO class_year_levels (curriculum, year_level, status) VALUES (?,?,?)')
    .run('Australia Year 11–12', 'Year 11, Year 12', 'Active');
}

// Study Material — Add Class Module/Topic/Year extends the existing course_modules
// table (no duplicate table) with the Class/Year Level/Description/Active fields
// shown in that uploaded page. course_modules.title already IS the Module/Topic name.
ensureColumn('course_modules', 'year_level', 'year_level TEXT');
ensureColumn('course_modules', 'class_name', 'class_name TEXT');
ensureColumn('course_modules', 'description', 'description TEXT');
ensureColumn('course_modules', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1');

// Study Material — Add/Assign Study Material (new Tailwind design)
ensureColumn('study_materials', 'file_path', 'file_path TEXT'); // generic private upload: doc/ppt/zip
ensureColumn('study_materials', 'file_size_bytes', 'file_size_bytes INTEGER');
ensureColumn('study_materials', 'allow_download', 'allow_download INTEGER NOT NULL DEFAULT 1');
ensureColumn('study_materials', 'allow_print', 'allow_print INTEGER NOT NULL DEFAULT 1');
ensureColumn('study_materials', 'allow_comments', 'allow_comments INTEGER NOT NULL DEFAULT 1');
ensureColumn('study_materials', 'is_featured', 'is_featured INTEGER NOT NULL DEFAULT 0');
ensureColumn('study_materials', 'tags', "tags TEXT DEFAULT ''");
ensureColumn('study_materials', 'access_type', "access_type TEXT DEFAULT 'immediate'");
ensureColumn('study_materials', 'available_from', 'available_from TEXT');
ensureColumn('study_materials', 'due_date', 'due_date TEXT');
ensureColumn('study_materials', 'assigned_summary', 'assigned_summary TEXT');
ensureColumn('study_materials', 'created_by', 'created_by INTEGER');
ensureColumn('study_materials', 'views', 'views INTEGER NOT NULL DEFAULT 0');

db.exec(`CREATE TABLE IF NOT EXISTS study_material_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  parent_id INTEGER,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

// MCQ Question Bank — "Add Multiple MCQs" / "Assign MCQ Set" (new Tailwind design).
// A titled, multi-question set that lives on top of the existing mcqs table —
// each question row still has its own subject/year/topic/difficulty/status so
// every existing filter/list/assign query against `mcqs` keeps working untouched.
db.exec(`CREATE TABLE IF NOT EXISTS mcq_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subject_id INTEGER,
  module_id INTEGER,
  year TEXT,
  description TEXT,
  total_questions INTEGER NOT NULL DEFAULT 0,
  default_marks REAL NOT NULL DEFAULT 1,
  negative_marks REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
ensureColumn('mcqs', 'created_at', 'created_at TEXT');
db.exec("UPDATE mcqs SET created_at = COALESCE(created_at, datetime('now'))");
ensureColumn('mcqs', 'set_id', 'set_id INTEGER');
ensureColumn('mcqs', 'module_id', 'module_id INTEGER');
ensureColumn('mcqs', 'marks', 'marks REAL NOT NULL DEFAULT 1');
ensureColumn('mcqs', 'image_url', 'image_url TEXT');
ensureColumn('mcqs', 'explanation', 'explanation TEXT');
ensureColumn('mcq_assignments', 'set_id', 'set_id INTEGER');

// ---------- MCQ Plans: reskin schema extension ----------
ensureColumn('mcq_plans', 'subject_id', 'subject_id INTEGER');
ensureColumn('mcq_plans', 'class_name', 'class_name TEXT');
ensureColumn('mcq_plans', 'year_level', 'year_level TEXT');
ensureColumn('mcq_plans', 'description', 'description TEXT');
ensureColumn('mcq_plans', 'discount_price', 'discount_price REAL');
ensureColumn('mcq_plans', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1');
ensureColumn('mcq_plans', 'created_at', 'created_at TEXT');
db.exec("UPDATE mcq_plans SET created_at = COALESCE(created_at, datetime('now'))");

// ---------- Full Exam Papers reskin: Exam Types, Topics, and richer paper fields ----------
db.exec(`CREATE TABLE IF NOT EXISTS exam_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
)`);
if (db.prepare('SELECT COUNT(*) c FROM exam_types').get().c === 0) {
  const seedTypes = [
    ['Past Exam Paper', 'Previous years\' official exam papers'],
    ['Mock Exam', 'Full-length simulated exam under timed conditions'],
    ['Practice Paper', 'Practice questions covering the syllabus'],
    ['Term Test', 'End-of-term assessment paper'],
    ['Unit Test', 'Short assessment covering one unit/module'],
    ['Mid Term', 'Mid-semester assessment paper'],
  ];
  const insType = db.prepare('INSERT INTO exam_types (name, description, is_active) VALUES (?,?,1)');
  seedTypes.forEach(([name, description]) => insType.run(name, description));
}

db.exec(`CREATE TABLE IF NOT EXISTS exam_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (module_id) REFERENCES course_modules(id)
)`);

ensureColumn('exam_papers', 'exam_type_id', 'exam_type_id INTEGER');
ensureColumn('exam_papers', 'module_id', 'module_id INTEGER');
ensureColumn('exam_papers', 'topic_id', 'topic_id INTEGER');
ensureColumn('exam_papers', 'class_name', 'class_name TEXT');
ensureColumn('exam_papers', 'description', 'description TEXT');
ensureColumn('exam_papers', 'cover_image_url', 'cover_image_url TEXT');
ensureColumn('exam_papers', 'passing_marks', 'passing_marks INTEGER');
ensureColumn('exam_papers', 'show_model_answers', 'show_model_answers INTEGER NOT NULL DEFAULT 1');
ensureColumn('exam_papers', 'allow_calculator', 'allow_calculator INTEGER NOT NULL DEFAULT 0');
ensureColumn('exam_papers', 'shuffle_mcq_options', 'shuffle_mcq_options INTEGER NOT NULL DEFAULT 0');
ensureColumn('exam_papers', 'available_from', 'available_from TEXT');
ensureColumn('exam_papers', 'available_until', 'available_until TEXT');
// node:sqlite does not allow ALTER TABLE ... ADD COLUMN ... DEFAULT CURRENT_TIMESTAMP,
// so add nullable then backfill (see file header note on this known quirk).
ensureColumn('exam_papers', 'created_at', 'created_at TEXT');
db.exec("UPDATE exam_papers SET created_at = COALESCE(created_at, datetime('now'))");

ensureColumn('exam_paper_questions', 'explanation', 'explanation TEXT');
ensureColumn('exam_paper_questions', 'model_answer', 'model_answer TEXT'); // reference answer for written/essay questions, shown to the teacher while grading when the paper's "Show Model Answers" setting is on
ensureColumn('exam_paper_questions', 'rubric', 'rubric TEXT'); // JSON array [{text, marks}, ...] — an optional structured marking rubric for written/essay questions, checked off during grading
ensureColumn('exam_answers', 'rubric_checked', 'rubric_checked TEXT'); // JSON array of rubric-point indices the teacher checked off for this specific answer

// ---------- Unified "Assign Content to Students" page ----------
// Shared per-assignment-batch settings (title/instructions/compulsory/dashboard
// visibility) for the three real per-student assignment tables. student_mcq_plans
// (an MCQ Plans grant) intentionally does NOT get is_compulsory/show_in_dashboard —
// granting a whole plan isn't a single task with a due/compulsory state the way a
// specific assignment is; it already has no due_date/status concept at all.
ensureColumn('exam_assignments', 'title', 'title TEXT');
ensureColumn('exam_assignments', 'is_compulsory', 'is_compulsory INTEGER NOT NULL DEFAULT 0');
ensureColumn('exam_assignments', 'show_in_dashboard', 'show_in_dashboard INTEGER NOT NULL DEFAULT 1');
ensureColumn('mcq_assignments', 'title', 'title TEXT');
ensureColumn('mcq_assignments', 'instructions', 'instructions TEXT');
ensureColumn('mcq_assignments', 'is_compulsory', 'is_compulsory INTEGER NOT NULL DEFAULT 0');
ensureColumn('mcq_assignments', 'show_in_dashboard', 'show_in_dashboard INTEGER NOT NULL DEFAULT 1');
ensureColumn('content_assignments', 'title', 'title TEXT');
ensureColumn('content_assignments', 'is_compulsory', 'is_compulsory INTEGER NOT NULL DEFAULT 0');
ensureColumn('content_assignments', 'show_in_dashboard', 'show_in_dashboard INTEGER NOT NULL DEFAULT 1');

// ---------- Email Notifications: ONE central email/notification record system ----------
// email_logs (already written by lib/mailer.js on every send attempt) is extended
// into the central record table instead of creating a second one. Existing
// columns map to the spec: recipient = recipient_email, error = error_message,
// template = origin template key. Only the missing fields are added here.
ensureColumn('email_logs', 'recipient_user_id', 'recipient_user_id INTEGER');
ensureColumn('email_logs', 'sender', 'sender TEXT');
ensureColumn('email_logs', 'body', 'body TEXT');            // full HTML body (shown in the preview panel)
ensureColumn('email_logs', 'type', 'type TEXT');            // Assignment | Submission | Feedback | Reminder | Result | Payment | Account | System
ensureColumn('email_logs', 'related_type', 'related_type TEXT');
ensureColumn('email_logs', 'related_id', 'related_id INTEGER');
ensureColumn('email_logs', 'scheduled_at', 'scheduled_at TEXT');
ensureColumn('email_logs', 'read_at', 'read_at TEXT');
ensureColumn('email_logs', 'created_by', 'created_by INTEGER'); // staff user who triggered/composed it (NULL = system)
ensureColumn('email_logs', 'created_at', 'created_at TEXT');
ensureColumn('email_logs', 'updated_at', 'updated_at TEXT');
ensureColumn('email_logs', 'deleted_at', 'deleted_at TEXT'); // soft delete from the Email Notifications page
{
  const TEMPLATE_TYPES = {
    student_welcome: 'Account', verification: 'Account', password_reset: 'Account',
    password_reset_by_staff: 'Account', login_otp: 'Account', parent_notification: 'Account',
    purchase_account_created: 'Payment', purchase_paper_assigned: 'Payment', mcq_assignment: 'Assignment',
  };
  const fromEmail = (db.prepare("SELECT value FROM site_settings WHERE key = 'from_email'").get() || {}).value || 'noreply@ausacademy.com';
  const rows = db.prepare('SELECT id, recipient, template, sent_at, body_preview, type FROM email_logs WHERE created_at IS NULL OR type IS NULL').all();
  const upd = db.prepare(
    `UPDATE email_logs SET created_at = COALESCE(created_at, sent_at), updated_at = COALESCE(updated_at, sent_at),
       type = COALESCE(type, ?), body = COALESCE(body, body_preview), sender = COALESCE(sender, ?),
       recipient_user_id = COALESCE(recipient_user_id, (SELECT id FROM users WHERE LOWER(email) = LOWER(?)))
     WHERE id = ?`
  );
  rows.forEach((r) => upd.run(TEMPLATE_TYPES[r.template] || 'System', fromEmail, r.recipient, r.id));
}
db.exec('CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status, deleted_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_email_logs_scheduled ON email_logs(status, scheduled_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_email_logs_related ON email_logs(related_type, related_id, type)');
db.exec('CREATE INDEX IF NOT EXISTS idx_email_logs_user ON email_logs(recipient_user_id)');

module.exports = db;
