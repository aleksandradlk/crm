const cron          = require('node-cron');
const db            = require('../db');
const { sendReminder } = require('../helpers/mailer');
const push          = require('../helpers/push');

let _running = false;

// Läuft jede Minute — prüft fällige Reminder
function startReminderCron() {
  cron.schedule('* * * * *', async () => {
    if (_running) return;
    _running = true;
    try {
      const [due] = await db.query(
        `SELECT r.id, r.note, r.remind_at, r.lead_id, r.user_id, r.pushed,
                l.company,
                u.email, u.full_name, u.role
         FROM reminders r
         JOIN leads l ON l.id = r.lead_id
         JOIN users u ON u.id = r.user_id
         WHERE r.sent = 0 AND r.remind_at <= NOW()`
      );

      for (const r of due) {
        // Zusätzlich einmalig als Push aufs Handy (falls Benachrichtigungen aktiviert sind) –
        // auch wenn der Mailversand fehlschlägt und der Reminder erneut versucht wird
        if (!r.pushed) {
          await db.query('UPDATE reminders SET pushed = 1 WHERE id = ?', [r.id]).catch(() => {});
          push.sendToUser(r.user_id, {
            title: `🔔 Erinnerung: ${r.company || 'Lead'}`,
            body: r.note || 'Fällige Erinnerung im CRM',
            url: `/${r.role === 'admin' ? 'admin' : 'closer'}.html?lead=${r.lead_id}`,
            tag: `reminder-${r.id}`,
          }).catch(e => console.error('Reminder push error:', e.message));
        }
        if (!r.email) {
          await db.query('UPDATE reminders SET sent = 1 WHERE id = ?', [r.id]);
          console.log(`Reminder (id=${r.id}) als in-App zugestellt markiert — User hat keine E-Mail-Adresse`);
          continue;
        }
        try {
          await sendReminder({
            to:          r.email,
            toName:      r.full_name,
            leadCompany: r.company,
            note:        r.note,
            remindAt:    r.remind_at,
          });
          await db.query('UPDATE reminders SET sent = 1 WHERE id = ?', [r.id]);
          console.log(`Reminder sent: ${r.company} → ${r.email}`);
        } catch (e) {
          console.error(`Reminder mail error (id=${r.id}):`, e.message);
        }
      }
    } catch (e) {
      console.error('Cron error:', e.message);
    } finally {
      _running = false;
    }
  });

  console.log('Reminder cron gestartet (jede Minute)');
}

module.exports = { startReminderCron };
