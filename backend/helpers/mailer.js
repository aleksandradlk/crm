const nodemailer = require('nodemailer');

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function stripHeaders(s) { return String(s||'').replace(/[\r\n]/g,' '); }
const path = require('path');
require('dotenv').config();

const LOGO_PATH = path.join(__dirname, '../public_html/LogoKomplett-klein.PNG');
const LOGO_CID  = 'novaflow-logo@crm';

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const LOGO_ATTACHMENT = {
  filename: 'LogoKomplett-klein.PNG',
  path: LOGO_PATH,
  cid: LOGO_CID,
};

async function sendReminder({ to, toName, leadCompany, note, remindAt }) {
  const dateStr = new Date(remindAt).toLocaleString('de-DE');
  await transporter.sendMail({
    from: `"NovaFlow Services" <${process.env.SMTP_USER}>`,
    to,
    subject: stripHeaders(`⏰ Reminder: ${leadCompany}`),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#f5f7fa;border-radius:8px">
        <img src="cid:${LOGO_CID}" alt="NovaFlow Services" width="160" style="display:block;margin-bottom:20px">
        <h2 style="color:#2c3a55;margin-bottom:8px">Erinnerung</h2>
        <p style="color:#333;margin-bottom:16px">Hallo ${esc(toName)},</p>
        <div style="background:#fff;border-left:4px solid #2c3a55;padding:16px;border-radius:4px;margin-bottom:16px">
          <strong>Lead:</strong> ${esc(leadCompany)}<br>
          <strong>Fällig:</strong> ${dateStr}<br>
          ${note ? `<strong>Notiz:</strong> ${esc(note)}` : ''}
        </div>
        <p style="color:#888;font-size:12px">NovaFlow Services · info@novaflowservices.de</p>
      </div>
    `,
    attachments: [LOGO_ATTACHMENT],
  });
}

// Sendet eine Lead-E-Mail und gibt die echte Message-ID zurück.
// Betrifft subject wird "[NF-{leadId}]" angehängt damit Antworten sicher zugeordnet werden können.
// inReplyTo/references: Message-IDs der bisherigen Konversation. Nur gesetzt, wenn
// vorhanden — dann hängt die Antwort im Mailprogramm des Kunden am richtigen Thread
// statt eine neue Konversation aufzumachen.
// Signatur unter Lead-Mails: Name, Rolle, Rückrufnummer (sipgate), Website
function leadSignatur({ senderName, rolle, telefon }) {
  // Vorwahl abtrennen, wo sie bekannt ist (Krefeld, Düsseldorf), sonst Nummer am Stück
  const n = telefon ? String(telefon).replace(/^\+49/, '0') : '';
  const vw = ['02151', '0211'].find(v => n.startsWith(v));
  const tel = vw ? `${vw} ${n.slice(vw.length)}` : n;
  return `<p style="margin:0;font-size:13px;line-height:1.5;color:#1a2330">${senderName ? `<b>${esc(senderName)}</b><br>` : ''}${esc(rolle || 'NovaFlow Services')}<br>`
    + `${rolle ? 'NovaFlow Services<br>' : ''}${tel ? `Telefon ${esc(tel)}<br>` : ''}<a href="https://www.novaflowservices.de" style="color:#2c3a55">www.novaflowservices.de</a></p>`;
}

async function sendLeadEmail({ to, subject, body, leadId, inReplyTo, references, senderName, rolle, telefon }) {
  const domain = (process.env.SMTP_USER || 'info@novaflowservices.de').split('@')[1] || 'novaflowservices.de';
  const msgId  = `<crm-lead-${leadId}-${Date.now()}@${domain}>`;
  const taggedSubject = subject.includes('[NF-') ? subject : `${subject} [NF-${leadId}]`;

  const refList = (Array.isArray(references) ? references : [references, inReplyTo])
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Absendername = Vertriebler, Adresse bleibt das gemeinsame Postfach,
  // damit Kundenantworten per IMAP wieder im CRM landen.
  const displayName = senderName
    ? `${stripHeaders(senderName).replace(/"/g, '')} | NovaFlow Services`
    : 'NovaFlow Services';
  const info = await transporter.sendMail({
    from:    `"${displayName}" <${process.env.SMTP_USER}>`,
    replyTo: process.env.IMAP_USER || process.env.SMTP_USER,
    to,
    subject: stripHeaders(taggedSubject),
    messageId: msgId,
    ...(inReplyTo   ? { inReplyTo }               : {}),
    ...(refList.length ? { references: refList }  : {}),
    headers: { 'X-CRM-Lead-ID': String(leadId) },
    html: `
      <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#1a2330">
        ${body.includes('<') ? body : body.split('\n').map(l => l.trim() ? `<p style="margin:0 0 12px">${l}</p>` : '<br>').join('')}
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
        ${leadSignatur({ senderName, rolle, telefon })}
        <img src="cid:${LOGO_CID}" alt="NovaFlow Services" width="160" style="display:block;margin:14px 0 0">
      </div>
    `,
    attachments: [LOGO_ATTACHMENT],
  });
  // Nodemailer gibt die tatsächlich verwendete Message-ID zurück
  return info.messageId || msgId;
}

// Kurze Hinweis-Mail an einen Benutzer (Termine u. Ä.); zeilen dürfen <b> enthalten,
// alles andere wird maskiert
async function sendInfoMail({ to, toName, subject, zeilen }) {
  const zeile = z => esc(z).replace(/&lt;(\/?)b&gt;/g, '<$1b>');
  await transporter.sendMail({
    from: `"NovaFlow CRM" <${process.env.SMTP_USER}>`,
    to,
    subject: stripHeaders(subject),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f5f7fa;border-radius:8px">
        <img src="cid:${LOGO_CID}" alt="NovaFlow Services" width="160" style="display:block;margin-bottom:20px">
        <p style="color:#333;margin:0 0 14px">Hallo ${esc(toName)},</p>
        <div style="background:#fff;border-left:4px solid #2c3a55;padding:16px;border-radius:4px;margin-bottom:16px;color:#1a2330;line-height:1.6">
          ${zeilen.filter(Boolean).map(z => `<div style="margin-bottom:6px">${zeile(z)}</div>`).join('')}
        </div>
        <p style="color:#888;font-size:12px">${esc(process.env.BASE_URL || 'NovaFlow CRM')}</p>
      </div>
    `,
    attachments: [LOGO_ATTACHMENT],
  });
}

// Interne Mail mit fertigem HTML (z. B. Angebots-Anfrage an den Admin)
async function sendHtmlMail({ to, subject, html }) {
  await transporter.sendMail({
    from: `"NovaFlow CRM" <${process.env.SMTP_USER}>`,
    to,
    subject: stripHeaders(subject),
    html,
  });
}

module.exports = { sendReminder, sendLeadEmail, sendInfoMail, sendHtmlMail };
