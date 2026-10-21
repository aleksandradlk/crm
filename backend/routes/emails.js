const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

// Posteingang: Admin sieht alle Kundenantworten, Vertriebler nur die zu ihren
// eigenen Leads – nie Mails von Leads anderer Kollegen.
function inboxScope(user) {
  if (user.role === 'admin') return { where: '1=1', params: [] };
  return { where: 'l.assigned_to = ?', params: [user.id] };
}

// ── GET /api/emails/inbox?filter=unread|all ─────────────────
router.get('/inbox', auth, async (req, res) => {
  const { where, params } = inboxScope(req.user);
  const unreadOnly = req.query.filter === 'unread';
  try {
    const [rows] = await db.query(
      `SELECT le.id, le.lead_id, le.from_address, le.from_name, le.subject,
              LEFT(le.body_text, 400) AS preview, le.received_at, le.created_at, le.is_read,
              l.company, l.ceo, l.status, l.assigned_to, u.full_name AS assigned_name
       FROM lead_emails le
       JOIN leads l ON l.id = le.lead_id AND l.archived_at IS NULL
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE le.direction = 'inbound' AND ${where} ${unreadOnly ? 'AND le.is_read = 0' : ''}
       ORDER BY COALESCE(le.received_at, le.created_at) DESC
       LIMIT 300`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error('Inbox error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/emails/unread-count — für das Badge in der Navigation ──
router.get('/unread-count', auth, async (req, res) => {
  const { where, params } = inboxScope(req.user);
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS unread, MAX(le.id) AS latest_id
       FROM lead_emails le
       JOIN leads l ON l.id = le.lead_id AND l.archived_at IS NULL
       WHERE le.direction = 'inbound' AND le.is_read = 0 AND ${where}`,
      params
    );
    res.json({ unread: Number(row.unread) || 0, latest_id: row.latest_id || 0 });
  } catch (e) {
    console.error('Unread count error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

async function canAccessLead(user, leadId) {
  if (user.role === 'admin') return true;
  const [[lead]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [leadId]);
  return !!lead && lead.assigned_to === user.id;
}

// ── POST /api/emails/lead/:leadId/read — alle Mails eines Leads als gelesen ──
router.post('/lead/:leadId/read', auth, async (req, res) => {
  const leadId = parseInt(req.params.leadId);
  try {
    if (!(await canAccessLead(req.user, leadId)))
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Lead' });
    await db.query(
      "UPDATE lead_emails SET is_read=1 WHERE lead_id=? AND direction='inbound' AND is_read=0", [leadId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Mark read error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/emails/:id/unread — einzelne Mail wieder als ungelesen markieren ──
router.post('/:id/unread', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [[mail]] = await db.query("SELECT lead_id FROM lead_emails WHERE id=? AND direction='inbound'", [id]);
    if (!mail) return res.status(404).json({ error: 'E-Mail nicht gefunden' });
    if (!(await canAccessLead(req.user, mail.lead_id)))
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Lead' });
    await db.query('UPDATE lead_emails SET is_read=0 WHERE id=?', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Mark unread error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/emails/status — Status des Mail-Abrufs (Admin) ──
router.get('/status', auth, adminOnly, async (req, res) => {
  try {
    const [[row]] = await db.query("SELECT value FROM app_settings WHERE key_name='imap_status'");
    let status = null;
    try { status = row ? JSON.parse(row.value) : null; } catch (_) {}
    res.json({
      configured: !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS),
      mailbox: process.env.IMAP_USER || null,
      status,
    });
  } catch (e) {
    console.error('Email status error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/emails/poll — Abruf sofort anstoßen (Admin) ──
router.post('/poll', auth, adminOnly, async (req, res) => {
  const { pollIncomingEmails } = require('../cron/emailPoller');
  await pollIncomingEmails();
  const [[row]] = await db.query("SELECT value FROM app_settings WHERE key_name='imap_status'").catch(() => [[null]]);
  let status = null;
  try { status = row ? JSON.parse(row.value) : null; } catch (_) {}
  res.json({ ok: true, status });
});

module.exports = router;
