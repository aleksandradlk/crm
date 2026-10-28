// ── „Heute“: alles, was ein Vertriebler heute anpacken muss, an einem Ort ──
// Verpasste Anrufe, fällige Rückrufe, neue Kundenantworten, Deals ohne nächsten
// Schritt bzw. mit überfälligem Abschlussdatum, dazu Tagesziel und Wähllisten.
const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');
const { buildQueue } = require('../helpers/queue');
const { utcZuOrt } = require('../helpers/zeit');

router.get('/', auth, async (req, res) => {
  const uid = req.user.id;
  try {
    const [reminders] = await db.query(
      `SELECT r.id AS reminder_id, r.lead_id, r.remind_at, r.note, r.kind,
              l.company, l.ceo, l.phone, l.status
       FROM reminders r JOIN leads l ON l.id = r.lead_id
       WHERE r.user_id = ? AND r.done_at IS NULL AND l.archived_at IS NULL
         AND r.remind_at <= CONCAT(CURDATE(), ' 23:59:59')
       ORDER BY r.remind_at ASC LIMIT 200`, [uid]);

    const [replies] = await db.query(
      `SELECT le.id, le.lead_id, le.subject, le.from_name, le.from_address,
              LEFT(le.body_text, 160) AS preview, COALESCE(le.received_at, le.created_at) AS received_at,
              l.company, l.phone
       FROM lead_emails le JOIN leads l ON l.id = le.lead_id AND l.archived_at IS NULL
       WHERE le.direction = 'inbound' AND le.is_read = 0 AND l.assigned_to = ?
       ORDER BY received_at DESC LIMIT 50`, [uid]);

    const [deals] = await db.query(
      `SELECT d.id, d.lead_id, d.title, d.value, DATE_FORMAT(d.expected_close_date, '%Y-%m-%d') AS expected_close_date,
              s.name AS stage_name, s.rot_days, DATEDIFF(NOW(), d.stage_changed_at) AS days_in_stage,
              l.company, l.phone,
              (SELECT MIN(r.remind_at) FROM reminders r WHERE r.lead_id = d.lead_id AND r.done_at IS NULL) AS next_reminder_at
       FROM deals d JOIN leads l ON l.id = d.lead_id AND l.archived_at IS NULL
       LEFT JOIN deal_stages s ON s.id = d.stage_id
       WHERE d.status = 'open' AND (d.owner_id = ? OR l.assigned_to = ?)
       ORDER BY d.value DESC LIMIT 200`, [uid, uid]);
    const dealsAttention = deals.map(d => {
      const reasons = [];
      if (!d.next_reminder_at) reasons.push('kein nächster Schritt');
      if (d.expected_close_date && d.expected_close_date <= new Date().toISOString().slice(0, 10)) reasons.push('Abschlussdatum erreicht');
      if (d.rot_days > 0 && d.days_in_stage > d.rot_days) reasons.push(`${d.days_in_stage} Tage in „${d.stage_name}“`);
      return { ...d, reasons };
    }).filter(d => d.reasons.length).slice(0, 30);

    const [[{ calls_today }]] = await db.query(
      'SELECT COUNT(*) AS calls_today FROM call_logs WHERE user_id=? AND DATE(started_at)=CURDATE()', [uid]);
    const [[goalRow]] = await db.query("SELECT value FROM app_settings WHERE key_name='daily_call_goal'");
    const queue = await buildQueue(req.user, null);

    // Admin: Deals, für die ein Closer ein Angebot angefordert hat (Phase „Angebot anfordern“)
    let anfragen = [];
    if (req.user.role === 'admin') {
      [anfragen] = await db.query(
        `SELECT d.id, d.lead_id, d.title, d.value, s.name AS stage_name, DATEDIFF(NOW(), d.stage_changed_at) AS days_in_stage,
                TIMESTAMPDIFF(HOUR, COALESCE(d.angefordert_at, d.stage_changed_at), NOW()) AS std, d.admin_flag, d.paket,
                l.company, l.phone, u.full_name AS owner_name,
                (SELECT c.text FROM comments c WHERE c.lead_id = d.lead_id AND c.text LIKE '📝 Angebot angefordert%' ORDER BY c.id DESC LIMIT 1) AS infos
         FROM deals d JOIN leads l ON l.id = d.lead_id AND l.archived_at IS NULL
         JOIN deal_stages s ON s.id = d.stage_id
         LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.status = 'open' AND s.name REGEXP 'anforder|anfrage'
         ORDER BY d.stage_changed_at ASC LIMIT 50`);
      const warte = Number((await require('./bedarf').regeln()).anfrage_warte_std) || 24;
      anfragen = anfragen.map(a => ({ ...a, infos: a.infos ? a.infos.replace(/^📝 Angebot angefordert:?\s*/, '') : '', zu_lange: a.std >= warte }));
    }

    // Übergaben/Terminanfragen, die auf die Antwort des Closers warten
    const [terminAnfragen] = await db.query(
      `SELECT a.id, a.lead_id, a.art, DATE_FORMAT(a.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at, a.topic, a.painpoints,
              l.company, l.phone, p.full_name AS proposed_name
       FROM appointments a JOIN leads l ON l.id=a.lead_id LEFT JOIN users p ON p.id=a.proposed_by
       WHERE a.closer_id=? AND a.status='vorgeschlagen' ORDER BY a.starts_at LIMIT 20`, [uid]).catch(() => [[]]);

    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    res.json({
      calls_today,
      goal: parseInt(goalRow?.value) || 50,
      queue_count: queue.leads.length,
      missed_calls: reminders.filter(r => r.kind === 'missed_call'),
      followups: reminders.filter(r => r.kind !== 'missed_call' && r.kind !== 'angebot')
        .map(r => ({ ...r, overdue: new Date(r.remind_at) < startToday })),
      replies,
      deals: dealsAttention,
      angebot_anfragen: anfragen,
      termin_anfragen: terminAnfragen.map(a => ({ ...a, starts_at: utcZuOrt(a.starts_at) })),
    });
  } catch (e) {
    console.error('Today error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

module.exports = router;
