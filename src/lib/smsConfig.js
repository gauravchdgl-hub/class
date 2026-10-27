const db = require('../db');

// SMS/WhatsApp provider credentials can be set either in Settings → Security
// (stored in site_settings) OR in .env — Settings takes priority if both are
// set, so an admin can configure/rotate keys from the browser without a
// redeploy or SSH access. Whichever is used, secrets are NEVER sent back to
// the browser — only a masked "last 4 chars" + configured/not-configured status.

function dbValue(key) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  return row && row.value ? row.value : '';
}

const FIELDS = {
  twilio: ['twilio_account_sid', 'twilio_auth_token', 'twilio_from_number'],
  twilio_whatsapp: ['twilio_account_sid', 'twilio_auth_token', 'twilio_whatsapp_from'],
  msg91: ['msg91_auth_key', 'msg91_sender_id'],
  whatsapp_business: ['meta_whatsapp_token', 'meta_whatsapp_phone_id', 'meta_whatsapp_template_name'],
};
const ENV_MAP = {
  twilio_account_sid: 'TWILIO_ACCOUNT_SID', twilio_auth_token: 'TWILIO_AUTH_TOKEN', twilio_from_number: 'TWILIO_FROM_NUMBER',
  twilio_whatsapp_from: 'TWILIO_WHATSAPP_FROM', msg91_auth_key: 'MSG91_AUTH_KEY', msg91_sender_id: 'MSG91_SENDER_ID',
  meta_whatsapp_token: 'META_WHATSAPP_TOKEN', meta_whatsapp_phone_id: 'META_WHATSAPP_PHONE_ID', meta_whatsapp_template_name: 'META_WHATSAPP_TEMPLATE_NAME',
};

// The active provider: whichever is chosen in Settings → Security, falling back to
// SMS_PROVIDER in .env. "not_decided" (the default once OTP is toggled on but no
// provider picked yet) counts the same as "none" — demo mode.
function getActiveProvider() {
  const choice = dbValue('sms_provider_choice');
  if (choice && choice !== 'not_decided') return choice.toLowerCase();
  return (process.env.SMS_PROVIDER || 'none').toLowerCase();
}

// Reads one field for a provider: Settings (site_settings) first, then .env.
function getField(key) {
  return dbValue(`sms_${key}`) || process.env[ENV_MAP[key]] || '';
}

// Full set of credential values for a given provider (or the active one if omitted).
function getProviderConfig(provider) {
  const p = (provider || getActiveProvider());
  const fields = FIELDS[p] || [];
  const values = {};
  fields.forEach((key) => { values[key] = getField(key); });
  return values;
}

// Is the active provider fully configured (every required field present)?
function isConfigured() {
  const p = getActiveProvider();
  if (p === 'none' || !FIELDS[p]) return false;
  const values = getProviderConfig(p);
  // template_name has a sane default, so it doesn't count as "missing"
  return FIELDS[p].every((key) => key === 'meta_whatsapp_template_name' || values[key]);
}

// Whether the active provider's config is coming from Settings (the database) or from
// .env — just for the little "source" badge in the UI, not used for any logic decision.
function getSource() {
  const p = getActiveProvider();
  const fields = FIELDS[p] || [];
  const fromDb = fields.some((key) => !!dbValue(`sms_${key}`));
  if (fromDb) return 'settings';
  const fromEnv = fields.some((key) => !!process.env[ENV_MAP[key]]);
  return fromEnv ? 'env' : 'none';
}

// Secret fields never get their real value sent back to the browser — their inputs
// render blank (type="password") like Stripe's. Non-secret fields (sender IDs, phone
// IDs, template names) aren't sensitive and render with their real value pre-filled.
const SECRET_FIELDS = new Set(['twilio_auth_token', 'msg91_auth_key', 'meta_whatsapp_token']);

// Per-field display info for the Settings form: for secrets, whether one is set and
// its last 4 characters (for a "(ending •••1234)" label); for plain fields, the value
// itself to pre-fill. Never includes a usable secret value.
function getFieldStatus(provider) {
  const values = getProviderConfig(provider);
  const status = {};
  Object.entries(values).forEach(([key, val]) => {
    if (SECRET_FIELDS.has(key)) status[key] = { secret: true, set: !!val, last4: val ? val.slice(-4) : '' };
    else status[key] = { secret: false, value: val || '' };
  });
  return status;
}

module.exports = { getActiveProvider, getField, getProviderConfig, getFieldStatus, getSource, isConfigured, FIELDS, ENV_MAP, SECRET_FIELDS };
