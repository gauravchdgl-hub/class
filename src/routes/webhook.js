const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { sendEmail } = require('../lib/mailer');
const { logAction } = require('../lib/audit');
const { notify } = require('../lib/notify');

const router = express.Router();

// Shared secret that the WordPress site must send back on every request.
// Set WOO_WEBHOOK_SECRET in .env — use the same value in the WordPress plugin/snippet.
function checkSecret(req, res, next) {
  const provided = req.get('x-webhook-secret') || req.query.secret;
  const expected = process.env.WOO_WEBHOOK_SECRET;
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'WOO_WEBHOOK_SECRET is not configured on the server' });
  }
  if (provided !== expected) {
    try {
      const guessId = `invalid-secret:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
      db.prepare('INSERT INTO payment_webhook_events (event_id, source, payload, status, error) VALUES (?,?,?,?,?)')
        .run(guessId, 'woocommerce', JSON.stringify(req.body || {}), 'failed', 'Invalid or missing webhook secret');
    } catch (e) { /* never block the response over a logging failure */ }
    return res.status(401).json({ ok: false, error: 'Invalid or missing webhook secret' });
  }
  next();
}

/** Finds an existing student by email, or creates one (unverified, + free MCQs).
 *  Returns { user, tempPassword, verifyToken } — tempPassword/verifyToken are
 *  only set when a NEW account was just created. */
function findOrCreateStudent(email, name) {
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) return { user, tempPassword: null, verifyToken: null };

  const tempPassword = crypto.randomBytes(4).toString('hex');
  const hash = bcrypt.hashSync(tempPassword, 8);
  // Created via a website purchase, so email is NOT verified yet — the
  // student cannot access purchased content until they click the
  // verification link, even though it's assigned below.
  const id = db.prepare('INSERT INTO users (name, email, password, role, email_verified) VALUES (?,?,?,?,0)')
    .run(name, email, hash, 'student').lastInsertRowid;
  user = { id, name, email, role: 'student' };

  const freePlan = db.prepare("SELECT * FROM mcq_plans WHERE name = 'Free Plan'").get();
  if (freePlan) {
    const expiresAt = new Date(Date.now() + freePlan.validity_days * 86400000).toISOString();
    db.prepare(
      `INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at)
       VALUES (?,?,NULL,NULL,?,?)`
    ).run(id, freePlan.id, freePlan.mcq_count, expiresAt);
  }

  const verifyToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
  db.prepare('INSERT INTO email_verifications (user_id, token, purpose, expires_at) VALUES (?,?,?,?)')
    .run(id, verifyToken, 'verify', expiresAt);

  return { user, tempPassword, verifyToken };
}

function sendPurchaseEmail(req, { email, name, itemTitle, tempPassword, verifyToken }) {
  if (verifyToken) {
    const verifyLink = `${process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`}/verify-email?token=${verifyToken}`;
    return sendEmail({
      to: email,
      subject: `Your "${itemTitle}" is ready — verify your account to start`,
      template: 'purchase_account_created',
      html: `
        <p>Hi ${name},</p>
        <p>Thanks for purchasing <b>${itemTitle}</b>. A Student Portal account has been created for you.</p>
        <p><b>Temporary password:</b> ${tempPassword}</p>
        <p>Before you can access it, please verify your email:</p>
        <p><a href="${verifyLink}" style="background:#2657ff;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block">Verify my email</a></p>
        <p>Or copy this link into your browser:<br>${verifyLink}</p>
        <p>After verifying, log in with your email and the temporary password above (you can change it from your profile).</p>
      `,
    });
  }
  return sendEmail({
    to: email,
    subject: `Your "${itemTitle}" is ready in your Student Portal`,
    template: 'purchase_paper_assigned',
    html: `<p>Hi ${name},</p><p><b>${itemTitle}</b> has been assigned to your Student Portal account. Log in to access it.</p>`,
  });
}

const ALLOWED_ORDER_STATUSES = ['completed', 'processing', 'on-hold', 'refunded', 'cancelled'];

/**
 * processWooLineItem — the ONE shared order-processing implementation used
 * by both the inbound webhook (POST /api/woo/order-complete) below and the
 * admin "Sync Now" REST-API pull (admin.js POST /admin/orders/sync). Do not
 * duplicate this logic anywhere else.
 *
 * Does the same thing the webhook always did: find/create the student,
 * match the WooCommerce product to exam_papers/tutorials/study_materials,
 * upsert the order/assignment keyed by woo_order_id (INSERT on first sight,
 * UPDATE status/amount on every later sighting — e.g. a sync run that finds
 * the same order now marked "refunded"), and grant portal access exactly
 * once (on first processing).
 *
 * @param {object} req - the Express request (used for building links/logging/app base URL;
 *   a plain object with `protocol`/`get()` stand-ins is fine from a non-HTTP caller like sync).
 * @param {object} data - { order_id, email, name, amount, payment_method, woo_product_id,
 *   product_type, product_title, paper_title, order_status, send_email (default true) }
 * @returns {object} { ok, code, error?, action: 'created'|'updated'|'duplicate'|'skipped', ... }
 */
function processWooLineItem(req, data) {
  const { order_id, email, name, amount, payment_method, woo_product_id, product_type, product_title, paper_title, order_status } = data || {};
  const sendEmailOnCreate = data.send_email !== false;
  const type = (product_type || 'exam_paper').toLowerCase();
  const title = product_title || paper_title; // paper_title kept for backward compatibility
  const orderStatus = ALLOWED_ORDER_STATUSES.includes(String(order_status).toLowerCase())
    ? String(order_status).toLowerCase()
    : 'completed';

  if (!order_id) return { ok: false, code: 400, error: 'order_id is required for webhook idempotency' };
  if (!['exam_paper', 'study_material', 'tutorial'].includes(type)) {
    return { ok: false, code: 400, error: `Unknown product_type "${type}" — must be exam_paper, study_material, or tutorial.` };
  }
  if (!email || !name) return { ok: false, code: 400, error: 'email and name are required' };

  if (type === 'exam_paper') return handleExamPaper();
  return handleContentPurchase(type);

  // ---------------- Full Exam Paper ----------------
  function handleExamPaper() {
    let paper = null;
    if (woo_product_id) paper = db.prepare('SELECT * FROM exam_papers WHERE woo_product_id = ?').get(String(woo_product_id));
    if (!paper && title) paper = db.prepare('SELECT * FROM exam_papers WHERE title = ?').get(title);
    if (!paper) {
      return { ok: false, code: 404, action: 'skipped', error: 'No matching exam paper found for this WooCommerce product. Set the "Woo Product ID" on the paper in Admin → Full Exam Papers.' };
    }

    const existingOrder = db.prepare('SELECT * FROM exam_orders WHERE woo_order_id = ? AND paper_id = ?').get(String(order_id), paper.id);
    if (existingOrder) {
      // Sync re-visits: keep the stored order/payment status in sync with
      // WooCommerce's current state, without touching access (see the
      // access-rule note in processWooOrders in wooApi sync code).
      if (existingOrder.order_status !== orderStatus || Number(existingOrder.amount) !== Number(amount || paper.price)) {
        db.prepare('UPDATE exam_orders SET order_status = ?, amount = ? WHERE id = ?')
          .run(orderStatus, amount || paper.price, existingOrder.id);
        return { ok: true, action: 'updated', already_processed: true, paper: paper.title, order_id: existingOrder.id };
      }
      const assignment = db.prepare('SELECT * FROM exam_assignments WHERE order_id = ?').get(existingOrder.id);
      return { ok: true, action: 'duplicate', already_processed: true, paper: paper.title, assignment_id: assignment ? assignment.id : null };
    }

    const { user, tempPassword, verifyToken } = findOrCreateStudent(email, name);

    const orderId = db.prepare(
      'INSERT INTO exam_orders (user_id, paper_id, amount, payment_method, status, woo_order_id, order_status) VALUES (?,?,?,?,?,?,?)'
    ).run(user.id, paper.id, amount || paper.price, payment_method || 'woocommerce', 'paid', String(order_id), orderStatus).lastInsertRowid;

    const assignmentId = db.prepare(
      'INSERT INTO exam_assignments (order_id, user_id, paper_id, status) VALUES (?,?,?,?)'
    ).run(orderId, user.id, paper.id, 'assigned').lastInsertRowid;

    if (sendEmailOnCreate) sendPurchaseEmail(req, { email, name, itemTitle: paper.title, tempPassword, verifyToken });
    logAction(req, 'payment_confirmed', {
      recordType: 'exam_order', recordId: orderId,
      newValue: { source: 'woocommerce', product_type: 'exam_paper', email, item: paper.title, amount: amount || paper.price, order_id: String(order_id) },
    });
    notify(user.id, 'purchase', 'Exam paper assigned', `"${paper.title}" is ready in your Student Portal.`, '/student/dashboard', { email: false }); // purchase email handled by sendPurchaseEmail

    return {
      ok: true, action: 'created', already_processed: false, assignment_id: assignmentId, order_id: orderId,
      student_created: !!tempPassword, paper: paper.title,
    };
  }

  // ---------------- Study Material / Tutorial ----------------
  function handleContentPurchase(contentType) {
    const table = contentType === 'tutorial' ? 'tutorials' : 'study_materials';
    let item = null;
    if (woo_product_id) item = db.prepare(`SELECT * FROM ${table} WHERE woo_product_id = ?`).get(String(woo_product_id));
    if (!item && title) item = db.prepare(`SELECT * FROM ${table} WHERE title = ?`).get(title);
    if (!item) {
      return { ok: false, code: 404, action: 'skipped', error: `No matching ${contentType.replace('_', ' ')} found for this WooCommerce product. Set the "Woo Product ID" on it in Admin → ${contentType === 'tutorial' ? 'Tutorials' : 'Study Material'}.` };
    }

    const existing = db.prepare(
      `SELECT ca.* FROM content_assignments ca
       JOIN users u ON u.id = ca.user_id
       WHERE ca.woo_order_id = ? AND ca.content_type = ? AND ca.content_id = ?`
    ).get(String(order_id), contentType, item.id);
    if (existing) {
      if (existing.order_status !== orderStatus || Number(existing.amount) !== Number(amount || 0)) {
        db.prepare('UPDATE content_assignments SET order_status = ?, amount = ? WHERE id = ?')
          .run(orderStatus, amount || 0, existing.id);
        return { ok: true, action: 'updated', already_processed: true, item: item.title, assignment_id: existing.id };
      }
      return { ok: true, action: 'duplicate', already_processed: true, item: item.title, assignment_id: existing.id };
    }

    const { user, tempPassword, verifyToken } = findOrCreateStudent(email, name);

    let assignmentId;
    try {
      assignmentId = db.prepare(
        `INSERT INTO content_assignments (user_id, content_type, content_id, amount, payment_method, woo_order_id, status, order_status)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(user.id, contentType, item.id, amount || 0, payment_method || 'woocommerce', String(order_id), 'assigned', orderStatus).lastInsertRowid;
    } catch (e) {
      // UNIQUE(user_id, content_type, content_id) hit — this student already
      // has this exact item assigned (e.g. re-purchased, or a differently-
      // shaped retry). Treat as already processed rather than erroring.
      const already = db.prepare('SELECT id FROM content_assignments WHERE user_id = ? AND content_type = ? AND content_id = ?').get(user.id, contentType, item.id);
      return { ok: true, action: 'duplicate', already_processed: true, item: item.title, assignment_id: already ? already.id : null };
    }

    if (sendEmailOnCreate) sendPurchaseEmail(req, { email, name, itemTitle: item.title, tempPassword, verifyToken });
    logAction(req, 'payment_confirmed', {
      recordType: 'content_assignment', recordId: assignmentId,
      newValue: { source: 'woocommerce', product_type: contentType, email, item: item.title, amount: amount || 0, order_id: String(order_id) },
    });
    const dest = contentType === 'tutorial' ? '/student/tutorials' : '/student/material';
    notify(user.id, 'purchase', `${contentType === 'tutorial' ? 'Tutorial' : 'Study material'} assigned`, `"${item.title}" is ready in your Student Portal.`, dest, { email: false }); // purchase email handled by sendPurchaseEmail

    return {
      ok: true, action: 'created', already_processed: false, assignment_id: assignmentId,
      student_created: !!tempPassword, item: item.title,
    };
  }
}

/**
 * POST /api/woo/order-complete
 *
 * Called by WordPress/WooCommerce whenever an order for a Full Exam Paper,
 * Study Material, or Tutorial is completed/paid. MCQ Plans are the exact
 * opposite: ONLY ever sold inside the portal, never on the website — this
 * endpoint never touches MCQ plans.
 *
 * Expected JSON body:
 * {
 *   "order_id": "1234",
 *   "email": "student@example.com",
 *   "name": "Emily Clark",
 *   "amount": 12.00,
 *   "payment_method": "card",
 *   "woo_product_id": "587",
 *   "product_type": "exam_paper",   // exam_paper | study_material | tutorial (defaults to exam_paper)
 *   "product_title": "Year 12 Economics Practice Paper 1"  // fallback matcher by title
 * }
 *
 * One WooCommerce order can contain several different products (even mixed
 * types) — each line item calls this endpoint once with its own
 * woo_product_id + product_type, and each is processed and tracked
 * independently, exactly like separate papers already were.
 *
 * All the actual matching/upsert/access-grant logic lives in
 * processWooLineItem() above, shared with the admin "Sync Now" REST pull.
 */
router.post('/order-complete', checkSecret, (req, res) => {
  const { order_id, product_type, woo_product_id, product_title, paper_title } = req.body || {};
  const type = (product_type || 'exam_paper').toLowerCase();
  const title = product_title || paper_title;
  const eventId = `${order_id}:${type}:${woo_product_id || title || 'unknown'}`;

  // Duplicate-event guard — INSERT (not SELECT-then-INSERT) so two
  // near-simultaneous retries can't both slip through a race condition.
  let eventRowId;
  try {
    eventRowId = db.prepare(
      'INSERT INTO payment_webhook_events (event_id, source, payload, status) VALUES (?,?,?,?)'
    ).run(eventId, 'woocommerce', JSON.stringify(req.body || {}), 'received').lastInsertRowid;
  } catch (err) {
    // UNIQUE constraint failed => this exact event was already processed/seen.
    db.prepare("UPDATE payment_webhook_events SET status = 'duplicate' WHERE event_id = ? AND status != 'processed'").run(eventId);
    return res.json({ ok: true, already_processed: true, duplicate_event: true });
  }

  const result = processWooLineItem(req, req.body || {});

  if (!result.ok) {
    db.prepare("UPDATE payment_webhook_events SET status = 'failed', error = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(result.error, eventRowId);
    return res.status(result.code || 400).json({ ok: false, error: result.error });
  }

  db.prepare("UPDATE payment_webhook_events SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(result.action === 'created' ? 'processed' : 'duplicate', eventRowId);

  if (result.already_processed) {
    return res.json({ ok: true, already_processed: true, item: result.paper || result.item, assignment_id: result.assignment_id || null });
  }

  res.json({
    ok: true, already_processed: false, assignment_id: result.assignment_id, student_created: result.student_created,
    portal_login_url: `${req.protocol}://${req.get('host')}/login`,
  });
});

module.exports = router;
module.exports.processWooLineItem = processWooLineItem;
module.exports.findOrCreateStudent = findOrCreateStudent;
