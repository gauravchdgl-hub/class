# AUS Academy — Year 11-12 Online Exam Platform

Two products in one Node.js/Express app:

1. **MCQ Plans** (inside Student Portal) — student buys a plan with any MCQ count set by admin, picks subject/year, practices, gets instant auto-checked results.
2. **Full Exam Papers** (public website) — visitor buys a paper (any number of MCQ / written / essay questions, set by admin per paper), account is created/linked automatically, paper is assigned to the Student Portal. Student completes Section A (MCQ, auto-checked), Section B (Written) and Section C (Essay) — written & essay go to the Admin/Teacher panel for manual marking + feedback, then result is published.

## Stack
Express + EJS + better-sqlite3 (file DB, zero setup) + express-session + bcryptjs.

## Run
```
npm install
npm start
```
Server: http://localhost:3000

Demo admin login: `admin@ausacademy.com` / `admin123`

## Structure
- `src/db/schema.sql` — full DB schema (users, subjects, mcq_plans, mcqs, student_mcq_plans, mcq_attempts, exam_papers, exam_paper_questions, exam_orders, exam_assignments, exam_submissions, exam_answers)
- `src/db/seed.js` — seeds admin user, subjects, sample MCQ plans, a sample exam paper (20 MCQ + 4 written + 1 essay) and MCQ bank
- `src/routes/` — public (website), auth, student (portal), admin (teacher panel)
- `src/views/` — EJS templates per section

Both MCQ count (per plan) and written/essay question count (per paper) are fully flexible — admin sets them per plan/paper, no hardcoded limits.
