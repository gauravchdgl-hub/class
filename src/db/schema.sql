-- Users (students + teachers + admin)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student', -- student | teacher | admin
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Site-wide settings (logo, etc.) as simple key/value pairs
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  year TEXT NOT NULL -- 'Year 11' | 'Year 12'
);

-- MCQ Plans (flexible mcq_count per plan, admin can create as many as needed)
CREATE TABLE IF NOT EXISTS mcq_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mcq_count INTEGER NOT NULL,
  price REAL NOT NULL,
  validity_days INTEGER NOT NULL DEFAULT 30
);

-- Optional curated question set for a plan. When a plan has rows here, MCQ
-- assignment for that plan draws ONLY from this exact, teacher-picked list
-- (in the given order) instead of a random filtered pool — this is what
-- lets a teacher say "these exact 40 of our 1,000 questions are Plan A".
-- A plan with no rows here falls back to the old subject/year/topic filter.
CREATE TABLE IF NOT EXISTS mcq_plan_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  mcq_id INTEGER NOT NULL,
  order_no INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (plan_id) REFERENCES mcq_plans(id),
  FOREIGN KEY (mcq_id) REFERENCES mcqs(id),
  UNIQUE(plan_id, mcq_id)
);

-- MCQs bank (used for practice via plans)
CREATE TABLE IF NOT EXISTS mcqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  year TEXT NOT NULL,
  topic TEXT,
  question TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL, -- A/B/C/D
  FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

-- Student purchased MCQ plans
CREATE TABLE IF NOT EXISTS student_mcq_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  subject_id INTEGER,
  year TEXT,
  remaining_mcqs INTEGER NOT NULL,
  purchased_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  stripe_session_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (plan_id) REFERENCES mcq_plans(id)
);

CREATE TABLE IF NOT EXISTS mcq_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_plan_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  mcq_id INTEGER NOT NULL,
  selected_option TEXT,
  is_correct INTEGER,
  attempted_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_plan_id) REFERENCES student_mcq_plans(id),
  FOREIGN KEY (mcq_id) REFERENCES mcqs(id)
);

-- ===================== Phase 2: MCQ Quota + Assignment Engine =====================
-- A purchased plan only reserves a QUOTA. Teacher/Admin must explicitly
-- assign a batch of specific MCQs (by subject/year/topic/count) before a
-- student can practice anything — the student never sees the raw question
-- bank, only the exact questions assigned to them.

CREATE TABLE IF NOT EXISTS mcq_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_plan_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  subject_id INTEGER,
  year TEXT,
  topic TEXT,
  mcq_count INTEGER NOT NULL,
  due_date TEXT,
  teacher_note TEXT,
  status TEXT NOT NULL DEFAULT 'assigned', -- assigned | in_progress | completed
  assigned_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (student_plan_id) REFERENCES student_mcq_plans(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

CREATE TABLE IF NOT EXISTS mcq_assignment_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  mcq_id INTEGER NOT NULL,
  selected_option TEXT,
  is_correct INTEGER,
  answered_at TEXT,
  FOREIGN KEY (assignment_id) REFERENCES mcq_assignments(id),
  FOREIGN KEY (mcq_id) REFERENCES mcqs(id)
);

-- ===================== Question Issue System =====================
-- Students (or teachers) can flag a problem with a specific question. Admin
-- resolves it with one of several actions; every resolution is also written
-- to audit_logs so historical results are never silently changed.
CREATE TABLE IF NOT EXISTS question_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_type TEXT NOT NULL, -- exam_paper_question | mcq
  question_id INTEGER NOT NULL,
  reported_by INTEGER,
  submission_id INTEGER, -- optional: which exam attempt this was raised from
  issue_type TEXT NOT NULL, -- wrong_question | wrong_answer_key | typo | ambiguous | other
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved
  resolution_action TEXT, -- correct_answer_key | exclude_from_scoring | give_full_marks | edit_question
  resolved_by INTEGER,
  resolved_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reported_by) REFERENCES users(id)
);

-- Generic per-student assignment record for Study Material and Tutorials
-- purchased on the website (WooCommerce). This mirrors exam_assignments'
-- role for papers: a purchase alone grants nothing — a row here (created
-- either by the webhook after a matched purchase, or manually by staff) is
-- what actually gives one specific student access to one specific item.
CREATE TABLE IF NOT EXISTS content_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content_type TEXT NOT NULL, -- study_material | tutorial
  content_id INTEGER NOT NULL,
  amount REAL DEFAULT 0,
  payment_method TEXT,
  woo_order_id TEXT,
  assigned_by INTEGER, -- NULL when created automatically by the webhook
  status TEXT NOT NULL DEFAULT 'assigned', -- assigned | revoked
  assigned_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, content_type, content_id)
);

-- ===================== Phase 3: Webhook Security + Audit Log =====================

-- Every WooCommerce webhook call is logged here, keyed by its unique event_id
-- (order_id + product_id combo). A duplicate event_id is detected and
-- rejected before any purchase/access is created, so retried/duplicate
-- webhook deliveries can never double-charge or double-assign.
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'woocommerce',
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'received', -- received | processed | duplicate | failed
  error TEXT,
  received_at TEXT DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);

-- Records every sensitive action for accountability: who did what, to which
-- record, and what changed. Historical results are never silently altered —
-- any correction shows up here with old/new values.
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  user_label TEXT, -- snapshot of name/email/role at the time, survives user deletion
  action TEXT NOT NULL,
  record_type TEXT,
  record_id INTEGER,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Full exam papers (website product). mcq_count/written_count/essay_count are flexible, set by admin.
CREATE TABLE IF NOT EXISTS exam_papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  year TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  price REAL NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 120,
  is_published INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

-- Questions belonging to a paper. type: mcq | written | essay. Admin can add as many of each as they like.
CREATE TABLE IF NOT EXISTS exam_paper_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL,
  type TEXT NOT NULL, -- mcq | written | essay
  question TEXT NOT NULL,
  option_a TEXT,
  option_b TEXT,
  option_c TEXT,
  option_d TEXT,
  correct_option TEXT, -- for mcq only
  marks INTEGER NOT NULL DEFAULT 1,
  word_limit INTEGER,
  order_no INTEGER NOT NULL DEFAULT 0,
  excluded_from_scoring INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (paper_id) REFERENCES exam_papers(id)
);

-- Orders placed from the public website for a full exam paper
CREATE TABLE IF NOT EXISTS exam_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  paper_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'paid', -- paid
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (paper_id) REFERENCES exam_papers(id)
);

-- Assignment of a purchased paper to the student's portal
CREATE TABLE IF NOT EXISTS exam_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  paper_id INTEGER NOT NULL,
  assigned_at TEXT DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'assigned', -- assigned | in_progress | submitted | reviewed
  FOREIGN KEY (order_id) REFERENCES exam_orders(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (paper_id) REFERENCES exam_papers(id)
);

CREATE TABLE IF NOT EXISTS exam_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL UNIQUE,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  submitted_at TEXT,
  is_late INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | pending_review | published
  mcq_score REAL DEFAULT 0,
  mcq_total REAL DEFAULT 0,
  written_score REAL DEFAULT 0,
  written_total REAL DEFAULT 0,
  essay_score REAL DEFAULT 0,
  essay_total REAL DEFAULT 0,
  total_score REAL DEFAULT 0,
  total_marks REAL DEFAULT 0,
  FOREIGN KEY (assignment_id) REFERENCES exam_assignments(id)
);

CREATE TABLE IF NOT EXISTS exam_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  selected_option TEXT,
  answer_text TEXT,
  is_correct INTEGER,
  marks_awarded REAL,
  feedback TEXT,
  reviewed_at TEXT,
  FOREIGN KEY (submission_id) REFERENCES exam_submissions(id),
  FOREIGN KEY (question_id) REFERENCES exam_paper_questions(id)
);

-- ===================== New in v3: Tutorials, Study Material, Module Access =====================

CREATE TABLE IF NOT EXISTS tutorials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subject_id INTEGER,
  year TEXT,
  video_url TEXT,
  description TEXT,
  duration_minutes INTEGER DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 1,
  woo_product_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

-- A module groups lessons under a subject, e.g. "Module 1: Introduction".
CREATE TABLE IF NOT EXISTS course_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  order_no INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

CREATE TABLE IF NOT EXISTS study_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subject_id INTEGER,
  module_id INTEGER,
  year TEXT,
  file_type TEXT DEFAULT 'pdf', -- pdf | doc | link | note
  file_url TEXT,
  notes TEXT,
  order_no INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'pdf', -- video | pdf | both | link
  video_path TEXT,   -- private on-disk path (never served directly/publicly)
  pdf_path TEXT,     -- private on-disk path (never served directly/publicly)
  duration_minutes INTEGER DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 1,
  woo_product_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (module_id) REFERENCES course_modules(id)
);

-- Per-student module unlocks. A student only sees Subjects / Tutorials / Study
-- Material once Admin/Teacher explicitly turns it on for them. MCQ and
-- Purchased Papers stay driven by actual plan/paper purchases (unaffected by this table).
CREATE TABLE IF NOT EXISTS student_module_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  module TEXT NOT NULL, -- subjects | tutorials | material
  unlocked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, module)
);

-- ===================== Phase 1: Real Auth + Email Verification =====================

CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT 'verify', -- verify | reset_password
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- One-time-passwords for login verification (email and/or phone/SMS). A row
-- is consumed (used_at set) on successful verification and cannot be reused.
-- attempts/max_attempts implements brute-force lockout; resend cooldown is
-- enforced in application code by checking created_at of the latest row.
CREATE TABLE IF NOT EXISTS login_otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL, -- email | sms
  destination TEXT NOT NULL, -- the email or phone number it was sent to
  code_hash TEXT NOT NULL, -- OTP is never stored in plain text
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS email_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  status TEXT NOT NULL, -- sent | failed | skipped_no_smtp
  error TEXT,
  sent_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- SMS send attempts (OTP, etc). Same "log everything, never break the
-- request" pattern as email_logs — see lib/sms.js.
CREATE TABLE IF NOT EXISTS sms_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  status TEXT NOT NULL, -- sent | failed | skipped_no_provider
  error TEXT,
  sent_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== Notifications =====================
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL, -- purchase | mcq_assignment | paper_assignment | submission_received | review_pending | result_ready | verification_pending
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ===================== Announcements (Notice Board) =====================
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all', -- all | Year 11 | Year 12
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
