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
  submitted_at TEXT,
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
