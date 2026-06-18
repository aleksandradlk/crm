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
        <img src="https://leads.novaflowservices.de/LogoKomplett-klein.PNG" alt="NovaFlow Services" style="height:40px;margin-top:12px;display:block">
      </div>
    `,
  });
}

async function sendLeadEmail({ to, subject, body, fromName }) {
  await transporter.sendMail({
    from: `"${fromName} · NovaFlow Services" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#141f34">
        ${body.includes('<') ? body : body.split('\n').map(l => l.trim() ? `<p style="margin:0 0 12px">${l}</p>` : '<br>').join('')}
        <hr style="border:none;border-top:1px solid #e2e7f0;margin:24px 0">
        <p style="color:#8e9ab5;font-size:12px">NovaFlow Services · info@novaflowservices.de</p>
        <img src="https://leads.novaflowservices.de/LogoKomplett-klein.PNG" alt="NovaFlow Services" style="height:40px;margin-top:12px;display:block">
      </div>
    `,
  });
}

module.exports = { sendReminder, sendLeadEmail };
