const cron          = require('node-cron');
const db            = require('../db');
const { sendReminder } = require('../helpers/mailer');

let _running = false;

// Läuft jede Minute — prüft fällige Reminder
function startReminderCron() {
  cron.schedule('* * * * *', async () => {
    if (_running) return;
    _running = true;
    try {
      const [due] = await db.query(
        `SELECT r.id, r.note, r.remind_at,
                l.company,
                u.email, u.full_name, u.notify_email
         FROM reminders r
         JOIN leads l ON l.id = r.lead_id
         JOIN users u ON u.id = r.user_id
         WHERE r.sent = 0 AND r.done_at IS NULL AND r.remind_at <= NOW()`
      );

      for (const r of due) {
        if (!r.email || !r.notify_email) {
          await db.query('UPDATE reminders SET sent = 1 WHERE id = ?', [r.id]);
          console.log(`Reminder (id=${r.id}) als in-App zugestellt markiert — keine E-Mail-Adresse oder E-Mail-Benachrichtigung aus`);
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
