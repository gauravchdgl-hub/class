const db = require('../db');
const { getActiveProvider, getField } = require('./smsConfig');

/**
 * sendSMS({ to, message, template })
 *
 * The ONE place a real SMS/WhatsApp gateway is wired in. Nothing else in the
 * app calls a provider SDK/API directly — everything goes through this
 * function, so switching providers only ever means a config change, never a
 * code change.
 *
 * Configure from Admin → Settings → Security (saved to the database — no
 * server access needed), or via .env (SMS_PROVIDER + that provider's keys)
 * if you prefer that instead. Settings takes priority when both are set. See
 * DOCUMENTATION.md section "SMS / WhatsApp OTP Providers" for exact steps.
 *
 * With no provider configured (the default), this runs in demo mode: the
 * message is logged to the console + sms_logs table instead of actually
 * being sent, so the OTP flow keeps working end-to-end without any gateway.
 */
async function sendSMS({ to, message, template }) {
  const provider = getActiveProvider();

  if (provider === 'none') {
    console.log(`[sms:${template}] (no SMS provider configured) To: ${to} — ${message}`);
    db.prepare('INSERT INTO sms_logs (recipient, template, status, error) VALUES (?,?,?,?)')
      .run(to, template, 'skipped_no_provider', null);
    return { skipped: true };
  }

  try {
    if (provider === 'twilio') {
      await sendViaTwilioSMS(to, message);
    } else if (provider === 'twilio_whatsapp') {
      await sendViaTwilioWhatsApp(to, message);
    } else if (provider === 'msg91') {
      await sendViaMsg91(to, message);
    } else if (provider === 'whatsapp_business') {
      await sendViaWhatsAppCloud(to, message);
    } else {
      throw new Error(`SMS provider "${provider}" is not recognised. Use none | twilio | twilio_whatsapp | msg91 | whatsapp_business`);
    }
    db.prepare('INSERT INTO sms_logs (recipient, template, status, error) VALUES (?,?,?,?)')
      .run(to, template, 'sent', null);
    return { sent: true };
  } catch (err) {
    console.error(`[sms:${template}] FAILED to send to ${to}:`, err.message);
    db.prepare('INSERT INTO sms_logs (recipient, template, status, error) VALUES (?,?,?,?)')
      .run(to, template, 'failed', err.message);
    return { sent: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Twilio — plain SMS. Needs: Account SID, Auth Token, From Number
// ---------------------------------------------------------------------------
async function sendViaTwilioSMS(to, message) {
  const sid = getField('twilio_account_sid');
  const token = getField('twilio_auth_token');
  const from = getField('twilio_from_number');
  if (!sid || !token || !from) {
    throw new Error('Twilio is not fully configured — set Account SID, Auth Token and From Number in Settings → Security (or .env)');
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams({ To: to, From: from, Body: message });
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Twilio SMS failed (${res.status}): ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Twilio WhatsApp — same account, "whatsapp:" prefix on both numbers.
// Needs: Account SID, Auth Token, WhatsApp From (e.g. "whatsapp:+14155238886")
// ---------------------------------------------------------------------------
async function sendViaTwilioWhatsApp(to, message) {
  const sid = getField('twilio_account_sid');
  const token = getField('twilio_auth_token');
  const from = getField('twilio_whatsapp_from');
  if (!sid || !token || !from) {
    throw new Error('Twilio WhatsApp is not fully configured — set Account SID, Auth Token and WhatsApp From in Settings → Security (or .env)');
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const toWa = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const body = new URLSearchParams({ To: toWa, From: from, Body: message });
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Twilio WhatsApp failed (${res.status}): ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// MSG91 — plain SMS (India). Needs: Auth Key, Sender ID
// Uses MSG91's v5 flow "send SMS" call — swap the endpoint if your MSG91
// account is set up for the dedicated OTP route instead.
// ---------------------------------------------------------------------------
async function sendViaMsg91(to, message) {
  const authKey = getField('msg91_auth_key');
  const senderId = getField('msg91_sender_id');
  if (!authKey || !senderId) {
    throw new Error('MSG91 is not fully configured — set Auth Key and Sender ID in Settings → Security (or .env)');
  }
  const digits = String(to).replace(/\D/g, '');
  const url = 'https://control.msg91.com/api/v5/flow/';
  const res = await fetch(url, {
    method: 'POST',
    headers: { authkey: authKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: senderId,
      short_url: '0',
      mobiles: digits,
      route: '4',
      sms: [{ message }],
    }),
  });
  if (!res.ok) throw new Error(`MSG91 send failed (${res.status}): ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// WhatsApp Business API (Meta Cloud API). Needs: Token, Phone Number ID, and
// an approved message template (Template Name, default "otp_code") — Meta
// requires an approved template for any first-contact / outside-24h-window
// message.
// ---------------------------------------------------------------------------
async function sendViaWhatsAppCloud(to, message) {
  const token = getField('meta_whatsapp_token');
  const phoneId = getField('meta_whatsapp_phone_id');
  const templateName = getField('meta_whatsapp_template_name') || 'otp_code';
  if (!token || !phoneId) {
    throw new Error('WhatsApp Business (Meta) is not fully configured — set Token and Phone Number ID in Settings → Security (or .env)');
  }
  const digits = String(to).replace(/\D/g, '');
  const codeMatch = message.match(/\d{6}/);
  const code = codeMatch ? codeMatch[0] : message;
  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: digits,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`WhatsApp Cloud API failed (${res.status}): ${await res.text()}`);
}

module.exports = { sendSMS };
