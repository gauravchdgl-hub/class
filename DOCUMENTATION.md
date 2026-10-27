# AUS Academy — How It Works (Full Documentation)

Based on your setup (for example):
- **Website (WordPress + WooCommerce)** → `https://eglit.in`
- **Student Portal (this Node.js app)** → `https://class.eglit.in`

> If these URLs ever change (new server, new domain), only **2 places**
> need updating — the URL is never hardcoded anywhere else in the code.
> Section 6 ("What To Do If The Server/URL Changes") gives the exact 2 spots.

---

## 1. Two Separate Products, Sold in Two Separate Places

| What's sold | Where it's sold | Where it's NOT sold |
|---|---|---|
| **Full Exam Paper** (MCQ + Written + Essay, a complete paper) | Only on the website `eglit.in` (WooCommerce) | Never purchasable inside the portal |
| **MCQ Plan** (Basic/Standard/Premium — MCQ practice only) | Only inside the portal `class.eglit.in` | Never sold on the website/WooCommerce |

This rule is already locked into the code on both sides:
- The website (WooCommerce) only ever handles paper-type products (the plugin checks for the `full-exam-papers` category or the `aus_academy_paper` custom field).
- The portal's routes (`/student/mcq/plans/...`) only ever sell MCQ plans — there is no "buy full paper" button here at all.

---

## 2. What Happens When a Full Exam Paper Is Purchased — Step by Step

Whether the website uses its own checkout (if WooCommerce isn't set up) or real WooCommerce, the same steps are followed:

```
Student goes to the website (eglit.in) and buys a paper
        │
        ▼
The WooCommerce order becomes "Completed" / "Processing"
        │
        ▼
The WordPress plugin (aus-academy-woo-bridge.php) fires automatically
        │
        ▼
For EVERY "Full Exam Paper" item in that order, the plugin sends
a POST request to the portal:
   https://class.eglit.in/api/woo/order-complete
        │
        ▼
The portal (class.eglit.in) then:
   1. Checks the secret key (security)
   2. Finds the matching paper (by Woo Product ID)
   3. Checks the student's email —
        - If an account already exists → that account is used
        - If it's a new student → a new account is CREATED (+ 50 free MCQs too)
   4. Records the order (visible under Admin → Orders & Payments)
   5. ASSIGNS the paper to that student's Student Portal account
   6. Logs a confirmation "email" to the console (a real email service can be plugged in later)
        │
        ▼
The student logs in at "class.eglit.in/login" and can immediately
see their assigned paper and start the exam
```

### Important: If an Order Contains More Than One Paper (Even 10 Papers)

If a student buys **10 different papers** in a single order:
- The WooCommerce plugin sends a **separate** call to the portal for **each** paper item in that order.
- The portal tracks each call against **that specific paper + that specific order** — never just by order number alone.
- This means: if a WooCommerce webhook happens to fire again for any reason (a retry), only **that one paper** will say "already done" — the other 9 papers are unaffected and still get assigned correctly.
- Result: **10 papers = 10 separate assignments**, all 10 show up on the student's portal dashboard, and each can be attempted independently.

I tested this myself (put 2 papers in one order) — both were assigned correctly, and replaying the webhook didn't affect the second paper either.

---

## 3. What Happens After "Order Successful" (For the Student)

1. The WooCommerce order succeeds (payment confirmed) → the website shows its own "Thank you" page.
2. Add a line/button on that page: **"Login to Student Portal →"** linking to `https://class.eglit.in/login`.
3. The student logs in there:
   - If they were a new student → their account already exists (a temporary password etc. is logged to email/console — you can wire up a real email service to send it to the student).
   - As soon as they log in, their newly assigned paper appears on the Dashboard.
4. The student opens the paper and clicks "Start Exam" → the timer starts, they attempt all three sections (MCQ + Written + Essay) → then Submit.
5. MCQs are auto-checked instantly. Written/Essay go to "Pending Review".
6. Admin/Teacher (`class.eglit.in/admin`) → goes to Submissions & Review, gives marks + feedback → clicks "Save & Publish Result".
7. The student's final result is published at `class.eglit.in/student/results`.

---

## 4. What the Admin Panel Controls

`class.eglit.in/admin` (via Admin/Teacher login):

| Page | What it does |
|---|---|
| Full Exam Papers | Create a new paper, add questions (MCQ/Written/Essay), publish it, **link the WooCommerce Product ID** |
| MCQ Plans | Create MCQ plans for the portal (any number of MCQs, no limit) |
| MCQ Question Bank | Add questions for MCQ practice |
| Assign / Activate | Manually give a student a paper too (without a website purchase — for free/promo access) |
| Submissions & Review | Check Written/Essay answers, give marks, publish |
| Orders & Payments | Every order from both the website and WooCommerce shows up here |
| Subjects, Teachers, Settings | Basic setup |

---

## 5. Linking Each Paper to WooCommerce (Required Step)

Do this once for each paper:

1. Create a product in WooCommerce (e.g. "Year 12 Economics Practice Paper 1", price A$12).
2. Give that product the category **`full-exam-papers`** (or set the custom field `aus_academy_paper = yes`) — this tells the plugin it's an Exam Paper product, not a regular one.
3. Note the WordPress product's ID (the product edit URL shows a number like `post=587` — that's the ID).
4. In the Portal's Admin panel → Full Exam Papers → "Manage" that paper → enter the same Product ID into the "WooCommerce Link" box → Save.

That's it — from now on, whenever someone buys that WooCommerce product, the portal will know exactly which paper to assign.

**For 10 papers:** do this once per paper (10 products in WooCommerce, 10 papers in Admin, each with its own linked Product ID). Once linked, it runs automatically — nothing else to do.

---

## 6. What To Do If the Server or URL Changes (Future-Proof)

Only **2 places** in the whole system hold a URL/secret — nowhere else is it hardcoded:

### Place 1 — the Portal's (Node.js app's) `.env` file:
```
WOO_WEBHOOK_SECRET=your-secret-here
```
The portal never needs its own URL set anywhere — it always uses its own current domain (dynamic).

### Place 2 — the top of the WordPress plugin file `aus-academy-woo-bridge.php`:
```php
define('AUS_ACADEMY_PORTAL_URL', 'https://class.eglit.in');   // <-- the portal's URL
define('AUS_ACADEMY_WEBHOOK_SECRET', 'your-secret-here');     // <-- the SAME secret as in .env
```

**If the server/domain changes tomorrow:**
1. Deploy the portal on the new server → put the same `WOO_WEBHOOK_SECRET` in the new `.env` (or generate a new secret).
2. In the WordPress plugin file, just replace `AUS_ACADEMY_PORTAL_URL` with the new domain (and update the secret there too if it changed).
3. Save both — the whole system now runs on the new URL. No other file needs editing.

> Tip: both secrets must match exactly, otherwise the webhook returns a 401 (Unauthorized) error.

---

## 7. How to Test (Even Without WooCommerce)

Run the portal and use this terminal command — it checks whether the webhook works correctly (exactly as WooCommerce itself would call it):

```bash
curl -X POST https://class.eglit.in/api/woo/order-complete \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: your-secret-here" \
  -d '{
    "order_id": "1001",
    "email": "teststudent@example.com",
    "name": "Test Student",
    "amount": 12,
    "woo_product_id": "587"
  }'
```

Success response:
```json
{"ok":true,"already_processed":false,"assignment_id":1,"student_created":true,"portal_login_url":"https://class.eglit.in/login"}
```

If you get an `"error"`:
- **"Invalid or missing webhook secret"** → the secret doesn't match in both places.
- **"No matching exam paper found..."** → the paper for that `woo_product_id` hasn't been linked in the Admin panel.

---

## 8. MCQ Plan — Portal-Only, With Real Payment Verification (WooCommerce Has No Role)

MCQ plans have **nothing to do with WooCommerce** — they're sold 100% inside the portal (`class.eglit.in`), and the portal itself verifies the payment:

1. The student logs into the portal and goes to the **MCQ Plans** page.
2. They choose a plan → if Stripe keys are set in `.env`, Stripe Checkout opens (real card payment).
3. After payment, Stripe sends its own **`session_id`** back to the portal.
4. The portal (`/student/mcq/checkout/success`) **re-verifies that `session_id` directly with Stripe's server** (`stripe.checkout.sessions.retrieve`) — the plan only activates once Stripe itself confirms `payment_status === 'paid'`. If the payment failed or is pending, the plan does not activate, and an error is shown.
5. This verification is also **duplicate-safe** — the same `session_id` can't be used to activate a plan twice (checked against the `stripe_session_id` column).
6. If Stripe keys aren't set in `.env` (still in testing mode), the plan activates instantly in demo mode — make sure to add real Stripe keys before going to production.

**To set Stripe keys**, in `.env`:
```
STRIPE_SECRET_KEY=sk_live_xxxxx
STRIPE_PUBLISHABLE_KEY=pk_live_xxxxx
```

---

## 9. Signup Verification — No Duplicate Account With the Same Email or Phone

Portal signup (`class.eglit.in/register`) now asks for **Name + Email + Phone + Password**, and both of the following are duplicate-checked:

- **Email duplicate check:** the email is checked lowercase + trimmed, so `Test@Gmail.com` and `test@gmail.com` are treated as the same — a second registration is blocked and the person is sent straight to "please login".
- **Phone duplicate check:** all spaces/dashes/`+` are stripped from the phone number and only the digits are compared — so `+61 400 111 222`, `0400-111-222`, and `0400111222` are all treated as the same number. If that number already belongs to another account, a new account won't be created.
- Login also matches the email lowercase/trimmed, so case-sensitivity never causes login issues.

**Note:** A guest paper purchase on the website (`eglit.in`) can also create an account (based on email) — if that same student later tries to register on the portal themselves, the system will recognize them and say "already exists, please login" instead of creating a duplicate account.

---

## 10. Where to Put the WordPress PHP File

Put the `aus-academy-woo-bridge.php` file on your WordPress hosting (cPanel File Manager, FTP, or your hosting's file browser) at exactly this path:

```
wp-content/mu-plugins/aus-academy-woo-bridge.php
```

Steps:
1. Go to your WordPress site's (`eglit.in`) root folder via cPanel/FTP.
2. Look inside the `wp-content` folder — if there's no `mu-plugins` folder, create one: `wp-content/mu-plugins`
3. Upload the `aus-academy-woo-bridge.php` file into that folder.
4. **"mu-plugins" (Must-Use plugins) do NOT need to be activated from the WordPress admin "Plugins" page** — they activate automatically the moment the file lands in that folder. (Putting it in the regular `wp-content/plugins/` folder would require clicking "Activate" on the Plugins page — mu-plugins skips that step.)
5. Open the file and edit the two lines at the top (portal URL + secret) as described in Section 6.
6. Complete one test order to check it works (you can also use the curl command from Section 7).

---

## 11. New Features (v3 Design Update) — Tutorials, Study Material, Progress, Locked Modules

These new modules were added along with the new design:

| Module | Student Route | Admin Route | What it does |
|---|---|---|---|
| Tutorials | `/student/tutorials` | `/admin/tutorials` | Video/lesson tutorials — Admin adds them, students only see them once unlocked |
| Study Material | `/student/material` | `/admin/material` | PDF/Doc/Link notes — same unlock rule |
| My Subjects | `/student/subjects` | `/admin/subjects` (existing) | The full subject list is visible to students only once unlocked |
| Progress & Analytics | `/student/progress` | `/admin/reports` | Summary of MCQ usage + exam scores |
| Students List | — | `/admin/students` | Every student's MCQ balance, assigned papers, and unlock buttons |
| Results (all students) | — | `/admin/results` | Every student's exam attempts in one place |

### The "Locked Module" Rule — Important to Understand

- **MCQ** and **Purchased Papers/Exams** are always available (as before) — access to these comes automatically from a purchase/assignment.
- **My Subjects**, **Tutorials**, **Study Material** — these three are **LOCKED by default** for every new student.
- On the `/admin/students` page, Admin can **individually unlock/lock** each of these three per student (clicking the button takes effect instantly).
- Until unlocked, the module shows in the student's sidebar with a 🔒 (locked icon); clicking it shows a "not assigned yet" message — the page never actually opens (even typing the URL directly redirects away — this isn't just hidden in the sidebar, it's checked on the backend too).

---

## 12. Phase 1 — Real Email Verification + Auth

An account can no longer be used immediately after signup — email verification is now required.

### Flow:
```
Student registers
        │
        ▼
Account is created unverified (email_verified = 0)
        │
        ▼
A verification email is sent (via Gmail SMTP, or logged to the console if SMTP isn't set up)
        │
        ▼
The student clicks the link in the email → /verify-email?token=xxxx
        │
        ▼
The account becomes verified (email_verified = 1) → logged in immediately
```

### What's Blocked Until Verified:
- ❌ Login (redirected to the "verify pending" page)
- ❌ Buying an MCQ Plan
- ❌ MCQ Practice
- ❌ Starting/Submitting an assigned exam
- ✅ Can still view the Dashboard (with a verify-reminder banner and a "Resend email" button)

### Gmail SMTP Setup (to send real emails):
1. Turn ON **2-Step Verification** for your Gmail account (if not already): https://myaccount.google.com/security
2. Create an **App Password**: https://myaccount.google.com/apppasswords → select "Mail" → you'll get a 16-character password.
3. In `.env`:
   ```
   SMTP_USER=youraddress@gmail.com
   SMTP_PASS=xxxx xxxx xxxx xxxx   (that 16-character app password, spaces are fine)
   SMTP_FROM_NAME=AUS Academy
   SMTP_FROM_EMAIL=youraddress@gmail.com
   APP_BASE_URL=https://class.eglit.in
   ```
4. Leave `SMTP_USER`/`SMTP_PASS` blank and the app runs in "demo mode" — the email is printed to the console and saved in the `email_logs` table; the app won't crash.

### New Routes:
| Route | What it does |
|---|---|
| `GET/POST /register` | Signup — no longer auto-logs-in, sends the person to the verify-pending page |
| `GET /verify-pending` | "Check your email" page + resend button |
| `POST /resend-verification` | Sends a new verification link |
| `GET /verify-email?token=...` | Verifies and logs the person in immediately |
| `GET/POST /forgot-password` | Sends a reset link (valid for 1 hour) |
| `GET/POST /reset-password?token=...` | Sets a new password |

### When a New Student Is Created Via WooCommerce:
When a new email buys a Full Paper on the website for the first time, the account is created **unverified**, and the email includes both a temporary password and a verification link. They cannot **start** the exam until verified (the paper is still assigned, but attempting it requires verification) — this prevents misuse of a fake/wrong email at purchase time.

### What Admin Sees:
- A new **"Pending Verification"** counter card on `/admin/dashboard`.
- A **Verified** (green) or **Pending Verification** (orange) badge next to each student's name on `/admin/students`.

---

## 13. Deploying on Hostinger / Shared Hosting (Important)

- This app uses **SQLite** (its own file), **not MySQL** — you do **not** need to set `DB_NAME`/`DB_HOST`/`DB_USER`/`DB_PASS`/`DB_PORT` in `.env`, the app doesn't use them at all. If your `.env` has these lines, remove them — they're only a source of confusion and an accidental port-clash risk.
- Do **not** set `PORT=` yourself in `.env` — Hostinger's "Setup Node.js App" panel assigns its own internal port via `process.env.PORT`, and its Apache/LSAPI proxy forwards to that exact port. If you manually set `PORT=3000` (or anything else) in `.env`, it can clash with the port Hostinger assigned → **504 Gateway Timeout**.
- Always start/restart the app **from Hostinger's "Setup Node.js App" panel** (its "Run NPM Install" and "Restart" buttons) — running `node src/app.js` or `pm2` manually via SSH bypasses Hostinger's port-mapping, and the proxy won't get a response from the right place.
- For session storage, this app uses **`session-file-store`** (pure JavaScript, no native/compiled code) — on shared hosting where build tools aren't available, native modules (like `sqlite3`, `connect-sqlite3`) can fail to compile or hang. Session files are saved in the `src/db/sessions/` folder.
- The "npm warn deprecated ..." lines during npm install are **not errors, and not a virus** — they're just normal warnings from older sub-dependencies, safe to ignore.

---

## 14. Phase 2 — MCQ Quota + Assignment Engine

**The biggest change:** buying an MCQ plan no longer gives a student **direct practice access** — it only grants a **quota**. The Teacher/Admin must specifically assign MCQs before a student can practice.

### New Flow:
```
Student buys an MCQ Plan (from the portal)
        │
        ▼
Quota is added (e.g. 100 MCQs) — remaining_mcqs = 100, assigned_mcqs = 0
        │
        ▼
Admin/Teacher → "Assign MCQs" page (under Admin → Assign / Activate)
        │
        ▼
Chooses a Subject / Year / Topic filter + how many MCQs to assign
        │
        ▼
The system automatically picks matching questions from the bank
(random, excluding ones already assigned)
        │
        ▼
An "MCQ Assignment" is created — the student only ever sees these specific questions
        │
        ▼
The student practices on the "My MCQs" page — gets an instant result
```

### Quota Tracking (Per Plan):
| Field | Meaning |
|---|---|
| Purchased (`mcq_count`) | How many MCQs the plan included (e.g. 200) |
| Assigned (`assigned_mcqs`) | How many the teacher has assigned so far |
| Awaiting Assignment (`remaining_mcqs`) | Purchased minus Assigned — not yet assigned |
| Answered | How many of the assigned MCQs the student has actually answered |

**The backend automatically blocks** a teacher from assigning more MCQs than remain on the plan, or more than the number of matching questions actually available in the bank.

### New Routes:
- `POST /admin/mcq-assign` — where the teacher assigns (in the "Assign MCQs" section of the Admin → Assign / Activate page).
- `GET /student/mcq/assignment/:id` — practice (one question at a time).
- `POST /student/mcq/assignment/:id/answer` — saves an answer.
- `GET /student/mcq/assignment/:id/result` — final score.

The **old** `/student/mcq/practice/:planId` route has been removed (it allowed direct bank access, which contradicted the new rule) — everything is now assignment-based.

---

## 15. Phase 3 — Webhook Security + Real Orders/Payments + Audit Log

### Webhook Security (Duplicate-Proof)
- Every WooCommerce webhook call generates a **unique event_id** (a combination of order + product) and is logged in the `payment_webhook_events` table.
- If **the same event arrives again** (a WooCommerce retry, or sent twice by mistake), the system immediately recognizes it and **rejects** it — no duplicate purchase/assignment is ever created.
- Attempts with the wrong secret are logged too (with a "failed" status) — the Admin → **Webhook Logs** page (`/admin/webhook-logs`) shows everything: which events were processed, which were duplicates, which failed and why.

### Orders & Payments — Now Real, Unified Data
- `/admin/orders` now shows **both**: Full Paper orders from the website/WooCommerce, and MCQ Plan purchases from the portal — in one list, with source and status.

### Audit Log — Who Did What, and When
- A new `/admin/audit-logs` page tracks:
  - Student login, Staff/Teacher login
  - MCQ assignment created
  - Paper assignment made
  - Payment confirmed (via webhook or Stripe)
  - New question added to the MCQ question bank
  - Exam result published (with marks)
- Every entry records: **who did it** (name/email/role), **what they did**, **which record**, and the **old/new value** — so result history can never change silently; everything is traceable.

---

## 16. Security Fix + 5 More Features

### Security Fix
- `npm audit` showed **1 high-severity vulnerability** (multiple CVEs in `nodemailer` v6) — fixed by upgrading to v10. `npm audit` now shows **0 vulnerabilities**.

### MCQ/Exam Timer — Now Real
- Previously the timer was cosmetic only (a fixed countdown that reset on refresh and never auto-submitted).
- Now an **`expires_at` timestamp is stored on the server** the moment the student clicks "Start Exam" — it shows the correct remaining time even after a refresh.
- The browser **auto-submits** as soon as the timer reaches zero.
- **There's also a server-side backstop:** if the JS never runs (tab closed, etc.), the server checks and auto-submits the exam the next time the page loads, flagged as "late".

### Question Issue System
- During an exam or MCQ practice, students see a "⚑ Report issue" link next to each question — they can choose an issue type and report it.
- Admin → **Question Issues** page (`/admin/question-issues`) shows every report, with 4 resolution options:
  - **Correct the Answer Key** — pick the right option, and the system automatically **recalculates** the results of everyone who already answered.
  - **Exclude from Scoring** — this question no longer affects the total marks.
  - **Give Full Marks to Everyone** — everyone gets full marks for it.
  - **Mark Resolved** (edited manually elsewhere)
- Every resolution is also recorded in the Audit Log.

### Notifications System
- A 🔔 icon in the topbar (with an unread count) for both students and admin/teacher.
- The `/notifications` page lists everything, with "mark as read" / "mark all as read".
- Triggers automatically on: MCQ assignment, paper assignment, purchase, result published, exam submission (to staff), and question-issue reports (to staff).

### Email Template Settings
- Admin → Settings → **Email Templates** — each email type (Verification, Password Reset, MCQ Assignment, Purchase emails) can be individually turned **on/off**.
- A disabled template won't send; it's recorded in `email_logs` with a `skipped_disabled` status.

### Payment Settings
- Admin → Settings → **Payment Settings** — a read-only status panel: Stripe Test/Live mode, currency, whether the WooCommerce webhook secret is configured.
- **For security:** the real secret keys (Stripe secret key, webhook secret, SMTP password) are never shown on the frontend — they can only be edited via the `.env` file, as originally required.

---

## 17. Professional Design Upgrade — Theme System, Topbar, Student Profile, Analytics

### Theme System (Font + Color — Changeable From Settings)
- Admin → Settings → **Theme (Font & Colors)** card — choose a font family (Inter, Poppins, Roboto, Nunito, Work Sans, Manrope) and a primary color (color picker).
- Saving it applies **instantly across the whole system** — Admin, Teacher, Student, website, everywhere gets the same look.
- Only Admin (Super Admin) can change this, not Teacher.

### New Professional Topbar
- Notifications and Profile are now **proper dropdowns** (clicking the bell shows recent notifications, with a "View all" link).
- The Profile dropdown has: **My Profile**, **Settings**, **Logout**.
- Uploading a profile photo shows it in the topbar immediately (instead of initials).

### Student Profile Page — Brand New (`/student/profile`)
Students can now view/update:
- Name, Phone Number, Father's Name, Address, Class/Year
- Profile Photo (upload it and it appears in the topbar + profile instantly)
- Password change
- Email verification status is shown here too

### Student Dashboard — Analytics Added
- Average Score, Completed Tests, Pending Tests, MCQ Batches Done — 4 new stat cards, from real data.

### Admin Dashboard — Charts Added
- **Student Growth** — a bar chart of signups over the last 6 months (real data)
- **Average Score** — a donut/ring chart (average across published exams)
- **Recent Activity** — a live feed from the Audit Log

---

## 18. Exact Design Gaps Fixed — Wizard, Tabs, MCQ Bank

You sent 3 screenshots showing exact gaps — all fixed:

### 1. Assign Paper — Now a Real Wizard Design
- A 4-step visual stepper (Select Paper → Select Students → Schedule → Confirm) — all fields on one page (as in the design, no hidden JS-only steps)
- **Students / Class dropdown** — now has real functionality: "All Students" (bulk assign, filterable by subject/year) or "One Specific Student"
- Start Date/Time, Due Date, Instructions — all saved (new columns on the `exam_assignments` table)
- **Recently Assigned panel** — real data, groups bulk assignments and shows a student count

### 2. Settings — Now 6 Real Tabs
General, Email, Payments, Appearance, User Roles, Security — all **functional** (click to switch tabs):
- **General:** Platform Name, Contact Email, Website URL, Timezone, Description — saved to the DB
- **Email:** Template on/off (already existed)
- **Payments:** Read-only status (secrets are never shown, for security)
- **Appearance:** Theme (font/color) + Logo
- **User Roles:** Admin/Teacher count summary + a link to the Teachers page
- **Security:** Password change

### 3. MCQ Question Bank — Now an Exact Match
- Stat cards: Total Questions, Published, Needs Review, Topics (real counts)
- Search + Year filter + Status filter (functional, via form submit)
- Table: Question, Subject, Topic, **Difficulty** (new), **Status** (new), Actions
- **The Edit button is now real** — opens `/admin/mcqs/:id/edit`, saves changes, and records them in the Audit Log

All of this was live-tested: bulk-assign created a real assignment, general settings saved to the DB, and MCQ edits updated the question/answer/difficulty.

---

## 19. Design Polish + Study Material With Secure PDF/Video Delivery

### Design Fixes
- The notification bell is now a proper SVG icon (instead of an emoji/character) — on both Admin and Student sides
- Fixed the Payments tab layout — long status text no longer overflows
- A new **Homepage Image** upload under Settings → Appearance (in addition to the logo)

### Study Material — A Brand New System (Module → Lesson Structure)
```
Subject (e.g. Economics)
  └── Module 1: Introduction
        ├── 1.1 What is Economics? (Video)
        ├── 1.2 Key Concepts (Video + PDF)
        └── PDF Study Material
  └── Module 2: Supply and Demand
        └── ...
```

**Admin/Teacher control:**
- `/admin/material` — first create a Module (choosing a subject), then add Lessons inside it — upload a video (mp4), a PDF, or both, set duration, order — everything.

**Student experience:**
- `/student/material` — subject cards (showing how many lessons each has)
- `/student/material/course/:id` — a full course player: modules/lessons in the left sidebar, video player + PDF viewer on the right, similar to the reference image provided

### 🔒 Security — PDFs and Videos Can Never Be Accessed Via a Direct URL
- All files are saved inside the **`src/private/materials/`** folder — this is outside the public folder, so nobody can access it via a direct URL.
- The **only** way to view a video/PDF is through: `/student/material/lesson/:id/video` and `/.../pdf` — these routes check:
  1. The student is **logged in**
  2. Their email is **verified**
  3. Admin has **unlocked the Study Material module** for them
- If any of the three checks fail, it returns **403 Forbidden** — the filename or path is never exposed (the URL only contains a number, e.g. `/lesson/5/video`).
- I tested this myself: no login → redirect; logged in but not unlocked → 403; after unlocking → 200. The video seek bar also works (HTTP Range requests are supported).
- The video tag also has `controlsList="nodownload"` (hides the browser's download button as an extra layer).

---

## 20. The Staff Login URL Is Now Private

- The Student login page (`/login`) no longer shows any "Admin / Teacher" button or link — a student browsing the site has no way to discover that a separate staff login exists.
- The Admin/Teacher login stays at `/staff-login`, but it isn't linked from anywhere a student or the public can see — only people who already know the URL (you, and whoever you share it with) can reach it.
- If you want this even more hidden later (e.g. a random, hard-to-guess path instead of `/staff-login`), that's a quick follow-up change — just ask.

---

## 21. FINAL Spec Implementation — OTP Login, Exam Navigator, Curated MCQ Plans, Help Docs

### Student Login OTP (Email + SMS-ready)
- After password is correct, a 6-digit one-time code is sent — **email always**, and **SMS too if a phone number is on file** (via a pluggable provider layer — see below).
- The session is only created after the code is verified. Codes expire in 10 minutes, have a 45-second resend cooldown, a max-attempts lockout, and are single-use (hashed in the database, never stored in plain text).
- **SMS gateway is not wired to any company yet, on purpose** — `src/lib/sms.js` is the one place a real provider (Twilio, MSG91, etc.) gets plugged in later. Until then, OTP codes are logged to the console + `sms_logs` table so the whole flow works end-to-end for testing. Set `SMS_PROVIDER` in `.env` once a provider is chosen.
- Live-tested: wrong code rejected, correct code logs in, reused code rejected afterward.

### Full Exam Paper — Real Question Navigator
- The exam-taking page now shows **one question at a time** with a numbered grid at the top (1, 2, 3 …), Next/Previous buttons, and the ability to jump directly to any question.
- The current question is highlighted; answered questions turn green in the navigator so progress is visible at a glance.
- Nothing is submitted until the final "Submit Exam" button — matches the PDF spec exactly.

### MCQ Plans — Teacher-Curated Question Selection (Paginated, Multi-Select)
- Admin → MCQ Plans → **"Select Questions"** for any plan opens a paginated question bank (25 per page) with checkboxes, search, and subject/year filters.
- A teacher can pick the exact questions that belong to a plan (e.g. exactly 40 of 1,000 questions) — selections are saved per page, so moving between pages never loses earlier picks.
- When a plan has a curated set, **MCQ assignment for that plan uses ONLY those exact questions** (in the chosen order) — no more random picking. A plan with no curated set still falls back to the old subject/year/topic random-filter behaviour, so nothing breaks for existing plans.

### Help & Documentation Link
- Both the Admin/Teacher sidebar and the Student sidebar now have a **"Help & Documentation"** link that renders this entire `DOCUMENTATION.md` file inside the portal itself — no separate download needed, though the file is also included in the zip.

### Staff Login Kept Separate, Never Advertised
- `/staff-login` remains the single Teacher/Admin login (role-based access inside), completely separate from `/login` (students). Confirmed the student login page has zero mention of the staff URL anywhere in its markup.

### Domain-Independent By Design
- Nothing in the codebase hardcodes `class.eglit.in` or any other domain — session cookies, redirect URLs, and email links all derive from the current request's host or `APP_BASE_URL` in `.env`. Moving to a new domain later only means updating `.env` and the WordPress plugin's two lines (see Section 6).

---

## 22. Website Purchases Now Cover All Three Products (Not Just Papers)

The final PDF spec required this exact flow for **Full Exam Papers, Study Material, AND Tutorials** — not just papers:

```
Student purchases on eglit.in (WooCommerce)
        │
        ▼
Payment successful → WordPress plugin fires
        │
        ▼
Plugin detects which of the 3 types the product is (by category:
full-exam-papers / study-material / tutorials) and sends it to the portal
        │
        ▼
Portal matches the Woo Product ID → finds the exact paper/lesson/tutorial
        │
        ▼
Portal matches the student by email (creates the account if new)
        │
        ▼
That SPECIFIC item is assigned to that SPECIFIC student
        │
        ▼
Student logs in and sees it in their portal immediately — Full Papers on
the Dashboard, Study Material/Tutorials in their own sections
```

### What Changed
- **Study Material and Tutorials** now have their own **"WooCommerce Product ID"** field in Admin (next to each lesson/tutorial in the table) — link them exactly like Full Exam Papers already were.
- A new `content_assignments` table tracks exactly which student has access to exactly which Study Material lesson or Tutorial — same idea as the existing paper-assignment system, just generalized to the other two content types.
- **A student sees a Study Material/Tutorial item if EITHER:** their Admin/Teacher has unlocked the whole module for them (the existing "Locked Module" system, still works exactly as before, e.g. for free/promotional content) **OR** they specifically purchased that exact item via the website. Both paths work side by side — nothing about the existing unlock system was removed.
- The WooCommerce webhook (`/api/woo/order-complete`) now accepts a `product_type` field (`exam_paper` | `study_material` | `tutorial`). If it's left out, it defaults to `exam_paper` — so nothing about the existing Full Exam Paper flow changed or broke.
- The WordPress plugin (`aus-academy-woo-bridge.php`) was updated to detect the product type automatically from the product's category and send it along. Put each product in one of these three WooCommerce categories: `full-exam-papers`, `study-material`, `tutorials`.
- `/admin/orders` now shows purchases of all three types in one unified list, each correctly labeled "Website (WooCommerce)".
- Everything is idempotent per content type — I tested buying a Tutorial and a Study Material lesson for the same student in the same session, then replaying the Tutorial purchase, and confirmed it was correctly rejected as a duplicate without double-assigning.
- I also confirmed the student could see the purchased Tutorial and Study Material subject **without** having the module unlocked — access came purely from the purchase, exactly as the spec requires.

---

## 23. Portal-Only — No Public Marketing Site

Per the final spec, this portal (`class.eglit.in`) is **login-only**:
- `/` now redirects straight to `/login` (or to the right dashboard if already logged in) — there is no Home, About, Contact, or Pricing page.
- The old `/papers` browsing/checkout pages (a fallback for when WooCommerce isn't set up) have been removed entirely, along with their unused template files.
- Full Exam Papers, Study Material and Tutorials are purchased **only** on the separate WooCommerce website (`eglit.in`); this app only ever shows `/login`, `/staff-login`, and the authenticated Student/Admin portals — exactly as the spec's URL table requires.
- A stray "Browse papers" link on the student dashboard that pointed at the removed `/papers` page was fixed.

## 24. Font Consistency Fix

Both stylesheets had `font-family` set with `!important` at the `body` level but didn't explicitly force it onto form inputs — in some browsers this could show a mismatched system font on `<input>`/`<select>`/`<textarea>` elements instead of the site's theme font. Added an explicit `input,select,textarea{font-family:inherit!important}` rule to all three stylesheets (`styles.css`, `smart-portal.css`, `admin-teacher-v10.css`) so every form field always matches the rest of the page, including whatever font is chosen in Admin → Settings → Appearance.

(Note: the **yellow background** seen on the email/password fields in your screenshots is the browser's own autofill highlight for a saved password — not part of the site's design — so there was nothing to fix there.)

---

## 25. Staff Login Design Fixed — Now Pixel-Identical to Student Login

Found the real bug you flagged: **Student Login and Staff Login were built with two completely different CSS files** (`styles.css` vs `admin-teacher-v10.css`) at different points — that's why the layout, spacing, and left-side content never matched, and why Staff Login was missing its marketing panel entirely.

**Fixed:** Staff Login (`/staff-login`) now uses the **exact same `styles.css` and `auth-wrap` structure** as Student Login — same card layout, same input styling, same "Show/Hide password" behavior, same theme (font + color) support. Only the text content differs (Admin/Teacher branding vs Student branding).

Also found and fixed: **5 auth pages** (`login`, `register`, `forgot-password`, `reset-password`, `verify-pending`) were missing the theme-color/font override entirely — meaning changing the theme in Settings wouldn't have updated them. All 6 auth pages (including staff-login) now correctly pick up the Admin-configured font and color. I tested this live: changed the theme to Poppins + green, and confirmed both `/login` and `/staff-login` updated identically.

---

## 27. SMS/WhatsApp OTP — Fully Configurable From the Dashboard

The OTP login system (email + phone) is fully built, toggleable, and — as of this update —
**configurable entirely from Settings, with no server or `.env` access required.**

### Where to Find It
**Admin → Settings → Security tab → "Two-Factor Authentication (Email + SMS OTP)"**

### What's There
- A checkbox: **"Enable SMS/WhatsApp OTP"**. Off by default — students only get the email
  code. Turn it on and, for any student with a phone number on file, their login code is
  **also** sent by SMS/WhatsApp.
- A **"Preferred SMS/WhatsApp Provider"** dropdown: Twilio (SMS), Twilio (WhatsApp), MSG91,
  or WhatsApp Business API (Meta).
- **Credential fields for whichever provider is selected**, right there on the page —
  Account SID, Auth Token, Sender ID, API keys, etc. depending on the provider. Fill these
  in and click Save. Secret fields (auth tokens, API keys) never show their real value
  again once saved — only "(ending •••1234)" — and leaving one blank on a later save
  **never wipes it out**; only typing a new value replaces it.
- A **"Send a Test Message"** box once a provider is selected — enter any phone number and
  send a one-off test through the saved credentials, to confirm the setup works before any
  real student hits the login flow. Check **Admin → SMS Logs** for the delivery result.
- A live status badge: **Connected** (shows whether the credentials came from Settings or
  from `.env`) or **Demo mode** (codes just get logged to the console + `sms_logs` table).

### How Credentials Are Resolved
`src/lib/smsConfig.js` is the single place this logic lives: for each field, it checks the
database (what you saved in Settings) first, and falls back to the matching `.env` variable
if the database has nothing. **Settings always wins when both are set.** This means:

- Prefer configuring through the Settings UI — no redeploy, no SSH, works the moment you
  click Save.
- `.env` is still fully supported too, for anyone who'd rather manage secrets that way
  (useful for scripted/CI deployments) — same four providers, same variable names as before:

  ```
  SMS_PROVIDER=twilio              # or: twilio_whatsapp | msg91 | whatsapp_business
  TWILIO_ACCOUNT_SID=xxxxx
  TWILIO_AUTH_TOKEN=xxxxx
  TWILIO_FROM_NUMBER=+1xxxxxxxxxx
  ```
  (See `.env.example` for the full list of variable names per provider — Twilio WhatsApp,
  MSG91, and WhatsApp Business API each have their own small set, mirroring the fields
  shown in Settings exactly.)
- Mixing both is fine too — e.g. set `SMS_PROVIDER` in `.env` as a fallback default, and
  override individual fields per environment from Settings without touching the server.

### WhatsApp Business API note
This one additionally needs a Meta developer app + WhatsApp product + phone number, and at
least one **approved message template** (Meta requires a pre-approved template for any
first-contact message — the default template name is `otp_code`, with one body variable for
the code). Get the token/Phone Number ID from developers.facebook.com → your app →
WhatsApp → API Setup, and approve the template under WhatsApp → Message Templates before
going live.

### What Changing This Never Requires
No app restart, no code change, no redeploy — Settings changes apply to the very next OTP
sent. (A `.env` change, if you choose that route instead, does need a restart to be picked
up, like any other environment variable.)

I tested this live: with the checkbox off, no SMS attempt was made at all. With it on, the app correctly attempted to send (visible in `sms_logs` as `skipped_no_provider` since no real gateway is connected yet) — confirming the switch works exactly as intended.

---

## 29. Admin Dashboard — Full Analytics Overview + Critical Demo-Mode Fix

### Dashboard Analytics Expanded
Added, all with real data from your database:
- **Recent Orders** — latest Full Paper + MCQ Plan purchases combined
- **Upcoming Submissions** — exams currently active or awaiting review
- **Results Overview** — most recently published results with letter grades
- **Teachers Overview** — recently added teachers
- **Revenue Overview** — last 6 months, papers + plans combined, as a bar chart

### Critical Fix: OTP Codes and Verification Links Were Invisible in Demo Mode
Found and fixed a serious usability bug: when SMTP isn't configured (demo/testing mode), the email body was **never shown anywhere** — not in the console, not in any log — meaning verification links, password reset links, and login OTP codes were completely unreachable. Nobody could actually log in without real SMTP set up.

**Fixed:**
- Demo-mode emails now print their full readable content to the console.
- A new **Admin → Email Logs** page (`/admin/email-logs`) shows every email attempt with a **Body Preview** column — this is where you read a verification link or OTP code directly from the Admin panel when testing without a real SMTP provider.
- I tested the entire flow end-to-end using only this page: registered a student, read their verification link from Email Logs, verified, logged in, read the OTP code from Email Logs, verified it, and reached the dashboard — all without ever configuring real SMTP.

---

## 31. New Dashboard Design (Teacher + Student)

Both the Teacher/Admin dashboard (`/admin/dashboard`) and the Student dashboard (`/student/dashboard`) were rebuilt to match the new pixel-perfect Tailwind CSS + FontAwesome + Chart.js design you provided, with every number wired to your real database — nothing is hardcoded demo data.

- **Teacher/Admin dashboard**: 8 stat cards, Student Growth / Exam Performance / Subject Performance charts, Recent Activity, Upcoming Exams, Pending Submissions, Quick Actions, Performance by Subject & Year, Top Performing Students, Subject Performance bars, Revenue Overview + KPI cards, Teacher Activity, Latest Orders — all pulled from the same dashboard queries used before, just rendered in the new design.
- **Student dashboard**: purchased plans with live usage bars, Recent Test Results, Score Progress chart, Upcoming Assignments, Study Activity chart, Subject-wise MCQ Activity donut, Quick Actions — all pulled from the student's real plans, assignments, and results.
- When you add a tutorial, MCQ, study material, or exam paper as Admin, these dashboards update automatically the next time they're viewed — there's no caching or manual refresh step.
- Both pages use their own Tailwind/FontAwesome/Chart.js CDN includes (as provided in your design files) — the rest of the portal is unaffected and still uses the existing CSS design system.
- Sidebar links on both dashboards point to the real existing pages in the app (Students, Subjects, Tutorials, MCQ Bank, Assign, Submissions, Results, Orders, Settings, etc.) instead of the placeholder links from the design mockups.

---

## 33. New Settings & Profile Pages (Teacher/Admin + Student)

Both the Teacher/Admin **Settings** page (`/admin/settings`) and the Student **Profile & Settings** page (`/student/profile`) were rebuilt to match your new Tailwind design files, with real database fields behind every tab.

**Teacher/Admin Settings** — tabbed exactly like your design (General / Email / Payments / Appearance / User Roles / Security), each with its own left sub-menu:
- **General**: Profile Information (name, phone, department, bio — saved to your account), Address Information, Login Page Options (Google/Microsoft SSO toggle, Remember Me — stored, real SSO login itself still needs a separate OAuth setup if you want it live), Language & Timezone, System Preferences (Maintenance Mode, Debug Logging).
- **Email**: Email Settings (From Name/Email/Footer), Email Templates (your existing real template on/off switches), Notification Triggers, SMTP status (live, read from your `.env`).
- **Payments**: Payment Gateway (your existing real Stripe key fields), Webhook & API (your real webhook URLs), WooCommerce status, Currency & Tax, Invoice Settings.
- **Appearance**: Branding (portal name/description), **Colors & Font — unchanged, still the same real working feature** that changes the theme across every portal, Logo & Homepage Image upload, Login Page Text.
- **User Roles**: a real, live overview table (Admin/Teacher/Student headcounts from your database) — AUS Academy intentionally has just these two portal roles, so this tab reports on them rather than offering a fake custom-role builder.
- **Security**: Password & Login policy, Two-Factor (your existing real Email+SMS OTP settings), Session Management, and Change My Password.

**Student Profile & Settings** — matches your design: avatar with photo upload, a live "My Order Details" list (pulled from their actual paper purchases + MCQ plan purchases), and a full profile form (personal info, date of birth, gender, address, father's/emergency contact, school name, medical info) plus Change Password — all saved to new columns on the student's account.

**New database fields added** (`users` table): `bio`, `dob`, `gender`, `address_line2`, `city`, `state`, `postal_code`, `country`, `father_phone`, `alt_phone`, `school_name`, `emergency_name`, `emergency_relation`, `emergency_phone`, `medical_info`, `department`. **New site-wide settings** (`site_settings` table): SSO/remember-me toggles, maintenance mode, debug logging, email from-name/email/footer, notification triggers, currency/GST/order prefix/invoice notes, password policy, session timeout — all editable from the Settings page and persisted immediately.

---

## 34. Where Everything Is (Quick Reference)

```
aus-academy/
├── src/
│   ├── app.js                    → main server file
│   ├── routes/
│   │   ├── public.js             → the website's own checkout (if not using WooCommerce)
│   │   ├── webhook.js            → handles orders coming in from WooCommerce
│   │   ├── student.js            → MCQ plans + full exam attempts (inside the portal)
│   │   └── admin.js              → the Admin/Teacher panel
│   ├── views/                    → all pages (the new design lives here)
│   └── db/                       → the SQLite database + schema
├── .env.example                  → copy this to .env and set WOO_WEBHOOK_SECRET
└── wordpress-integration/
    └── aus-academy-woo-bridge.php → this file goes into WordPress's mu-plugins folder
```

---

## 35. Email Notifications — One Central System (Replaces Scattered Emails)

A single `email_logs` table is now the record for **every** email the portal
sends — not just a send log, but the full Email Notifications page shown
under Admin → Email Notifications:

- **Dashboard cards** (Total / Sent / Scheduled / Failed / Drafts) and the
  five tabs are all computed live from this one table.
- Assignments, submissions, feedback, results, payments, reminders and
  account emails (welcome, password reset/changed, login OTP) all write to
  it automatically via `lib/notify.js` and `lib/mailer.js` — there is no
  second, parallel email system anywhere in the code.
- Staff can **Reply / Forward** (send now, save as Draft, or Schedule for
  later), **Resend** a failed email, **Mark as Unread**, or **Delete** the
  record — all from that one page.
- `lib/emailScheduler.js` runs in the background: it creates an **Exam
  Reminder** email ~24h before a paper is due, and sends anything sitting in
  "Scheduled" once its time arrives.
- Emails carrying a one-time code, a verification link or a password-reset
  link (`lib/emailMeta.js` → `SENSITIVE_TEMPLATES`) are never shown with
  their body, never resendable, and hidden from Teachers unless addressed to
  them — only Admin can see those rows at all.

### Who sees what (Teacher vs Admin)

Teachers see the same Email Notifications, Audit Log and Email Logs pages as
Admin. Two things stay Admin-only: **Webhook Logs** (the raw WooCommerce
delivery trail) and **Teachers** (managing staff logins) — see
`services/emailCenter.js` → `scope()` for the exact rule, and
`views/partials/tw_sidebar.ejs` for where that is enforced in the sidebar.

## 36. Admin Pages Brought to the Current Design

`Teachers`, `Help`, `Question Issues`, `Audit Log`, `Webhook Logs` and
`Email Logs` were rebuilt on the same sidebar/header layout as the rest of
the panel (previously a couple of these were on an older design). `Question
Issues` — reported problems with a specific exam question — is now also
linked directly in the sidebar under Full Exam Papers, where it was missing
before.

A plain-language version of this whole document, written for someone being
onboarded rather than a developer, is the separate **AUS Academy Portal
Guide** (Word document) — ask whoever gave you this project for it, or
regenerate it from the project notes.

## 28. Announcements (Notice Board) & Leaderboard

Two classic LMS features, added this round:

### Announcements
**Admin/Teacher → Announcements** — post a title + message, choose an audience
(Everyone, Year 11 only, or Year 12 only), and optionally pin it to the top.
Students see matching announcements right at the top of their own dashboard —
pinned ones first, then newest first. Delete removes it everywhere immediately.

### Leaderboard
**Admin/Teacher → Leaderboard** — ranks students by their average score across
every **published** exam result, with optional Year Level and Subject filters.
Only published results count (a result sitting in "pending review" never
affects the ranking), and a student needs at least one published result to
appear at all.
