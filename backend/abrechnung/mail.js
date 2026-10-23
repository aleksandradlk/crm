'use strict';
// ── E-Mail-Versand über SMTP ──────────────────────────────────
// Zugangsdaten kommen ausschließlich aus der Umgebung (in Hostinger gesetzt),
// nicht aus dem Tool. Für ein Hostinger-Postfach:
//   SMTP_HOST=smtp.hostinger.com  SMTP_PORT=465  SMTP_USER=hallo@novaflowservices.de
//   SMTP_PASS=<Postfach-Passwort>  SMTP_FROM="NovaFlow Services <hallo@novaflowservices.de>"
const path = require('path');
const nodemailer = require('nodemailer');
const TYPEN = { '.pdf': 'application/pdf', '.json': 'application/json', '.zip': 'application/zip', '.csv': 'text/csv' };

function konfiguration() {
  const host = process.env.SMTP_HOST || '';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE !== 'false' : port === 465;
  // Im CRM ist SMTP_FROM der CRM-Absender – Angebote & Rechnungen gehen als NovaFlow raus
  const von = process.env.ABRECHNUNG_SMTP_FROM || (user ? `NovaFlow Services <${user}>` : '');
  return { host, user, pass, port, secure, von, konfiguriert: !!(host && user && pass) };
}

let transport = null;
function transporter() {
  const k = konfiguration();
  if (!k.konfiguriert) throw new Error('E-Mail-Versand ist nicht eingerichtet. Bitte SMTP_HOST, SMTP_PORT, SMTP_USER und SMTP_PASS als Umgebungsvariablen setzen.');
  if (!transport) {
    transport = nodemailer.createTransport({ host: k.host, port: k.port, secure: k.secure, auth: { user: k.user, pass: k.pass } });
  }
  return transport;
}

// Reine Adresse aus „Name <adresse>“ oder „adresse“ ziehen
function nurAdresse(s) {
  const m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim();
}
function gueltigeAdresse(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nurAdresse(s));
}

// anhaenge: [{ filename, content: Buffer }]
async function sende({ an, betreff, text, anhaenge = [], antwortAn, kopie }) {
  const k = konfiguration();
  const empfaenger = String(an || '').split(/[;,]/).map(nurAdresse).filter(Boolean);
  if (!empfaenger.length || !empfaenger.every(gueltigeAdresse)) throw new Error('Bitte eine gültige Empfängeradresse angeben.');
  if (!String(betreff || '').trim()) throw new Error('Betreff fehlt.');
  const info = await transporter().sendMail({
    from: k.von,
    to: empfaenger.join(', '),
    bcc: kopie ? k.von : undefined,
    replyTo: antwortAn || undefined,
    subject: betreff,
    text: text || '',
    attachments: anhaenge.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType || TYPEN[path.extname(a.filename).toLowerCase()] || 'application/octet-stream' }))
  });
  return { an: empfaenger, messageId: info.messageId };
}

module.exports = { konfiguration, sende, gueltigeAdresse, nurAdresse };
