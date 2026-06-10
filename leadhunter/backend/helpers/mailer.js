const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendReminder({ to, toName, leadCompany, note, remindAt }) {
  const dateStr = new Date(remindAt).toLocaleString('de-DE');
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: `⏰ Reminder: ${leadCompany}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:8px">
        <h2 style="color:#4f8ef7;margin-bottom:8px">LeadHunter Pro — Erinnerung</h2>
        <p style="color:#333;margin-bottom:16px">Hallo ${toName},</p>
        <div style="background:#fff;border-left:4px solid #4f8ef7;padding:16px;border-radius:4px;margin-bottom:16px">
          <strong>Lead:</strong> ${leadCompany}<br>
          <strong>Fällig:</strong> ${dateStr}<br>
          ${note ? `<strong>Notiz:</strong> ${note}` : ''}
        </div>
        <p style="color:#888;font-size:12px">LeadHunter Pro · info@novaflowservices.de</p>
      </div>
    `,
  });
}

module.exports = { sendReminder };
