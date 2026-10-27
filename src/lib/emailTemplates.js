// HTML bodies for portal emails. Markup mirrors the preview card of the Email
// Notifications page (heading, greeting, details card, button, sign-off) using
// inline styles so it renders the same in the preview panel and in real inboxes.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function baseUrl() {
  return (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}
const absUrl = (link) => (!link ? null : /^https?:\/\//i.test(link) ? link : `${baseUrl()}${link}`);

/**
 * renderEmail({ heading, name, intro, details:[{label,value}], instructions, cta:{label,link}, note })
 * All dynamic values are HTML-escaped here, so callers pass plain text.
 */
function renderEmail({ heading, name, intro, details = [], instructions, cta, note }) {
  const rows = details.filter((d) => d && d.value !== undefined && d.value !== null && d.value !== '');
  const detailHtml = (rows.length || instructions) ? `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin:12px 0;font-size:12px;">
      ${rows.map((d) => `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:8px;"><span style="color:#64748b;font-weight:600;">${esc(d.label)}:</span><span style="color:#0f172a;font-weight:700;text-align:right;">${esc(d.value)}</span></div>`).join('')}
      ${instructions ? `<div style="border-top:1px solid #f1f5f9;padding-top:8px;"><div style="color:#64748b;font-weight:600;margin-bottom:4px;">Instructions:</div><div style="color:#334155;font-size:11px;line-height:1.5;">${esc(instructions)}</div></div>` : ''}
    </div>` : '';
  const url = cta && absUrl(cta.link);
  const button = url
    ? `<p style="margin:16px 0 8px;"><a href="${esc(url)}" style="display:block;text-align:center;background:#2563eb;color:#fff;font-weight:700;font-size:12px;padding:10px 16px;border-radius:12px;text-decoration:none;">${esc(cta.label || 'View')} &rarr;</a></p>`
    : '';
  return `
    <h4 style="margin:0 0 10px;font-size:14px;color:#091e42;">${esc(heading)}</h4>
    ${name ? `<p style="margin:0 0 6px;font-size:12px;color:#475569;line-height:1.6;">Hi ${esc(String(name).split(' ')[0])},</p>` : ''}
    ${intro ? `<p style="margin:0 0 6px;font-size:12px;color:#475569;line-height:1.6;">${esc(intro)}</p>` : ''}
    ${detailHtml}${button}
    <p style="margin:10px 0 0;font-size:11px;color:#64748b;">${esc(note || 'If you have any queries, please contact your teacher.')}</p>
    <p style="margin:12px 0 0;font-size:11px;color:#475569;">Best regards,<br><strong style="color:#1e293b;">AUS Academy Team</strong></p>`;
}

// Plain text typed in the Reply / Forward dialog -> safe HTML paragraphs.
function textToHtml(text) {
  return String(text || '').split(/\n{2,}/).map((para) =>
    `<p style="margin:0 0 8px;font-size:12px;color:#475569;line-height:1.6;">${esc(para).replace(/\n/g, '<br>')}</p>`).join('');
}

module.exports = { renderEmail, textToHtml, esc, absUrl };
