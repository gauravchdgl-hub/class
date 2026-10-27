const express = require('express');
const db = require('../db');
const { logAction } = require('../lib/audit');
const { notify } = require('../lib/notify');
const { sendEmail } = require('../lib/mailer');
const { getStripeClient, getStripeKeys } = require('../lib/stripeConfig');

const router = express.Router();

function grantPlan(userId, plan, subjectId, year, stripeSessionId, amountPaid) {
  const expiresAt = new Date(Date.now() + plan.validity_days * 86400000).toISOString();
  return db.prepare(
    `INSERT INTO student_mcq_plans (user_id, plan_id, subject_id, year, remaining_mcqs, expires_at, stripe_session_id, amount_paid)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(userId, plan.id, subjectId || null, year || null, plan.mcq_count, expiresAt, stripeSessionId || null, amountPaid || 0).lastInsertRowid;
}

// Belt-and-braces alongside the success_url redirect flow in student.js —
// if the browser never makes it back to success_url (closed tab, network
// drop, etc.) this webhook still grants the plan reliably.
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripeClient();
  const { webhookSecret } = getStripeKeys();
  if (!stripe) return res.status(500).send('Stripe not configured');

  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret)
      : JSON.parse(req.body.toString());
  } catch (err) {
    console.error('[stripe webhook] signature/parsing error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status === 'paid' && session.metadata && session.metadata.plan_id) {
      const already = db.prepare('SELECT id FROM student_mcq_plans WHERE stripe_session_id = ?').get(session.id);
      if (!already) {
        const plan = db.prepare('SELECT * FROM mcq_plans WHERE id = ?').get(session.metadata.plan_id);
        if (plan) {
          const grantedId = grantPlan(session.metadata.user_id, plan, session.metadata.subject_id, session.metadata.year, session.id, plan.price);
          logAction({ session: {} }, 'payment_confirmed_webhook', {
            recordType: 'student_mcq_plan', recordId: session.metadata.user_id,
            newValue: { source: 'stripe_webhook', plan: plan.name, amount: plan.price, stripe_session_id: session.id },
          });
          notify(session.metadata.user_id, 'purchase', 'MCQ plan activated', `"${plan.name}" is now active on your account.`, '/student/mcq/my', { email: false }); // order email is sent just below
          const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(session.metadata.user_id);
          if (buyer) {
            sendEmail({
              to: buyer.email,
              subject: `Order confirmed — ${plan.name}`,
              template: 'purchase_paper_assigned',
              userId: buyer.id, relatedType: 'student_mcq_plan', relatedId: Number(grantedId),
              html: `<p>Hi ${buyer.name},</p><p>Your payment for <b>${plan.name}</b> (${plan.mcq_count} MCQs) was successful.</p><p>Order ID: <b>${session.id}</b><br>Amount: <b>AU$${plan.price}</b></p><p>Log in to your Student Portal to start practicing.</p>`,
            });
          }
        }
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
