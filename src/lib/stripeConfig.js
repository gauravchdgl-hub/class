const db = require('../db');

// Stripe keys can be set either in Settings → Payments (stored in
// site_settings) OR in .env — Settings takes priority if both are set, so
// an admin can configure/rotate keys from the browser without a redeploy.
// Whichever is used, the secret key is NEVER sent back to the browser —
// only a masked "last 4 chars" + configured/not-configured status.

function dbValue(key) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  return row && row.value ? row.value : '';
}

function getStripeKeys() {
  const secretKey = dbValue('stripe_secret_key') || process.env.STRIPE_SECRET_KEY || '';
  const publishableKey = dbValue('stripe_publishable_key') || process.env.STRIPE_PUBLISHABLE_KEY || '';
  const webhookSecret = dbValue('stripe_webhook_secret') || process.env.STRIPE_WEBHOOK_SECRET || '';
  return { secretKey, publishableKey, webhookSecret };
}

function getStripeClient() {
  const { secretKey } = getStripeKeys();
  if (!secretKey) return null;
  // eslint-disable-next-line global-require
  return require('stripe')(secretKey);
}

module.exports = { getStripeKeys, getStripeClient };
