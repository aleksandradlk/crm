// ── Deals (Verkaufschancen mit Wert) — angelehnt an Pipedrive ───────────────
// Ein Lead (Firma/Ansprechpartner) kann mehrere Deals haben. Ein Deal hat einen
// Wert, steht in einer Phase der Pipeline und endet als gewonnen oder verloren.
const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');

const LOST_REASONS = [
  'Kein Bedarf', 'Zu teuer', 'Kein Budget', 'Wettbewerber gewählt',
  'Nicht mehr erreichbar', 'Falscher Ansprechpartner', 'Zeitpunkt passt nicht', 'Sonstiges',
];

const fmtEur = v => Number(v || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

function seesAll(user) {
  return user.role === 'admin' || !!user.can_view_all_leads;
}
function canEdit(user, deal) {
  return user.role === 'admin' || deal.owner_id === user.id || deal.lead_assigned_to === user.id;
}
function parseValue(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return 0;
  // Zahlen oder deutsche Schreibweise: "2500", "2.500", "2.500,50", "2500,5"
  let str = String(v).trim().replace(/\s|€/g, '');
  if (str.includes(',')) str = str.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(str)) str = str.replace(/\./g, '');
  const n = typeof v === 'number' ? v : (/^\d+(\.\d+)?$/.test(str) ? parseFloat(str) : NaN);
  return Number.isFinite(n) && n >= 0 && n < 1e10 ? Math.round(n * 100) / 100 : NaN;
}
function parseDate(v) {
  if (v === undefined) return undefined;
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : NaN;
}

async function loadDeal(id) {
  const [[d]] = await db.query(
    `SELECT d.*, l.assigned_to AS lead_assigned_to, l.company
     FROM deals d JOIN leads l ON l.id = d.lead_id WHERE d.id = ?`, [id]);
  return d;
}
// Phase, in der der Closer dem Admin die Infos für ein Angebot übergibt
const istAngebotAnfrage = name => /anfordern|anfrage/i.test(String(name || ''));

async function note(leadId, userId, text) {
  await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)', [leadId, userId, text]);
}
async function firstStageId() {
  const [[s]] = await db.query('SELECT id FROM deal_stages WHERE is_active=1 ORDER BY sort_order, id LIMIT 1');
  return s?.id || null;
}
async function lastStageId() {
  const [[s]] = await db.query('SELECT id FROM deal_stages WHERE is_active=1 ORDER BY sort_order DESC, id DESC LIMIT 1');
  return s?.id || null;
}

// Wird auch vom Anrufmodus genutzt (POST /api/leads/:id/outcome)
async function createDeal({ leadId, userId, title, value, stageId, ownerId, expectedClose, status = 'open' }) {
  const [[lead]] = await db.query('SELECT company FROM leads WHERE id=?', [leadId]);
  const stage = stageId || (status === 'won' ? await lastStageId() : await firstStageId());
  const [r] = await db.query(
    `INSERT INTO deals (lead_id, title, value, stage_id, status, owner_id, expected_close_date,
                        won_at, stage_changed_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,NOW(),?)`,
    [leadId, (title || lead?.company || 'Deal').slice(0, 200), value || 0, stage, status,
     ownerId || userId, expectedClose || null, status === 'won' ? new Date() : null, userId]
  );
  await note(leadId, userId, status === 'won'
    ? `🏆 Deal gewonnen: ${title || lead?.company || 'Deal'} (${fmtEur(value)})`
    : `💼 Deal angelegt: ${title || lead?.company || 'Deal'} (${fmtEur(value)})`);
  if (status === 'won') await db.query("UPDATE leads SET status='kunde' WHERE id=?", [leadId]);
  return r.insertId;
}

async function markWon(deal, userId, value) {
  const v = value !== undefined && !Number.isNaN(value) ? value : deal.value;
  await db.query(
    "UPDATE deals SET status='won', won_at=NOW(), lost_at=NULL, lost_reason=NULL, value=? WHERE id=?",
    [v, deal.id]);
  await db.query("UPDATE leads SET status='kunde' WHERE id=?", [deal.lead_id]);
  await note(deal.lead_id, userId, `🏆 Deal gewonnen: ${deal.title} (${fmtEur(v)})`);
}

async function markLost(deal, userId, reason) {
  await db.query(
    "UPDATE deals SET status='lost', lost_at=NOW(), won_at=NULL, lost_reason=? WHERE id=?",
    [reason, deal.id]);
  await note(deal.lead_id, userId, `✖ Deal verloren: ${deal.title} – ${reason}`);
}

// ── Phasen ───────────────────────────────────────────────────
router.get('/stages', auth, async (req, res) => {
  const [rows] = await db.query(
    'SELECT id, name, probability, rot_days, sort_order FROM deal_stages WHERE is_active=1 ORDER BY sort_order, id');
  res.json({ stages: rows, lost_reasons: LOST_REASONS });
});

router.post('/stages', auth, adminOnly, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  const prob = Math.min(100, Math.max(0, parseInt(req.body.probability) || 0));
  const rot  = Math.min(365, Math.max(0, parseInt(req.body.rot_days) || 0));
  const [[{ maxSort }]] = await db.query('SELECT COALESCE(MAX(sort_order),0) AS maxSort FROM deal_stages WHERE is_active=1');
  const [r] = await db.query(
    'INSERT INTO deal_stages (name, probability, rot_days, sort_order) VALUES (?,?,?,?)',
    [name, prob, rot, maxSort + 1]);
  await log(req.user.id, 'deal_stage_create', 'system', r.insertId, { name }, req.ip);
  res.status(201).json({ ok: true, id: r.insertId });
});

// Reihenfolge speichern: { ids: [3,1,2] }
router.put('/stages/order', auth, adminOnly, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'Keine Phasen übergeben' });
  for (let i = 0; i < ids.length; i++) {
    await db.query('UPDATE deal_stages SET sort_order=? WHERE id=?', [i + 1, ids[i]]);
  }
  res.json({ ok: true });
});

router.patch('/stages/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  const updates = [], params = [];
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'Name fehlt' });
    updates.push('name=?'); params.push(name);
  }
  if (req.body.probability !== undefined) {
    updates.push('probability=?'); params.push(Math.min(100, Math.max(0, parseInt(req.body.probability) || 0)));
  }
  if (req.body.rot_days !== undefined) {
    updates.push('rot_days=?'); params.push(Math.min(365, Math.max(0, parseInt(req.body.rot_days) || 0)));
  }
  if (!updates.length) return res.status(400).json({ error: 'Nichts zu aktualisieren' });
  params.push(id);
  await db.query(`UPDATE deal_stages SET ${updates.join(',')} WHERE id=?`, params);
  res.json({ ok: true });
});

router.delete('/stages/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  const [[{ cnt }]] = await db.query("SELECT COUNT(*) AS cnt FROM deals WHERE stage_id=? AND status='open'", [id]);
  if (cnt > 0) return res.status(409).json({ error: `In dieser Phase liegen noch ${cnt} offene Deals. Bitte zuerst verschieben.` });
  const [[{ active }]] = await db.query('SELECT COUNT(*) AS active FROM deal_stages WHERE is_active=1');
  if (active <= 1) return res.status(409).json({ error: 'Die Pipeline braucht mindestens eine Phase.' });
  // Nur deaktivieren: abgeschlossene Deals behalten ihre letzte Phase
  await db.query('UPDATE deal_stages SET is_active=0 WHERE id=?', [id]);
  await log(req.user.id, 'deal_stage_delete', 'system', id, {}, req.ip);
  res.json({ ok: true });
});

// ── Liste ────────────────────────────────────────────────────
// ?status=open|won|lost|all  &owner=me|all|<userId>  &lead_id=
router.get('/', auth, async (req, res) => {
  const where = [], params = [];
  const status = ['open', 'won', 'lost'].includes(req.query.status) ? req.query.status
               : req.query.status === 'all' ? null : 'open';
  if (status) { where.push('d.status = ?'); params.push(status); }
  if (req.query.lead_id) { where.push('d.lead_id = ?'); params.push(parseInt(req.query.lead_id)); }

  const owner = req.query.owner || 'me';
  if (!seesAll(req.user) || owner === 'me') {
    where.push('(d.owner_id = ? OR l.assigned_to = ?)'); params.push(req.user.id, req.user.id);
  } else if (/^\d+$/.test(owner)) {
    where.push('d.owner_id = ?'); params.push(parseInt(owner));
  }
  where.push('l.archived_at IS NULL');

  const [rows] = await db.query(
    `SELECT d.id, d.lead_id, d.title, d.value, d.stage_id, d.status, d.owner_id,
            DATE_FORMAT(d.expected_close_date, '%Y-%m-%d') AS expected_close_date,
            d.won_at, d.lost_at, d.lost_reason, d.notes,
            d.stage_changed_at, d.created_at, d.updated_at,
            l.company, l.ceo, l.phone, l.assigned_to AS lead_assigned_to,
            u.full_name AS owner_name, s.name AS stage_name, s.probability,
            DATEDIFF(NOW(), d.stage_changed_at) AS days_in_stage,
            (SELECT MIN(r.remind_at) FROM reminders r
              WHERE r.lead_id = d.lead_id AND r.done_at IS NULL) AS next_reminder_at
     FROM deals d
     JOIN leads l ON l.id = d.lead_id
     LEFT JOIN users u ON u.id = d.owner_id
     LEFT JOIN deal_stages s ON s.id = d.stage_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${status === 'open' ? 'd.stage_changed_at ASC' : 'COALESCE(d.won_at, d.lost_at, d.updated_at) DESC'}
     LIMIT 2000`, params);
  res.json(rows);
});

// ── Kennzahlen ───────────────────────────────────────────────
router.get('/summary', auth, async (req, res) => {
  const owner = req.query.owner || 'me';
  let scope = '1=1';
  const p = [];
  if (!seesAll(req.user) || owner === 'me') { scope = '(d.owner_id = ? OR l.assigned_to = ?)'; p.push(req.user.id, req.user.id); }
  else if (/^\d+$/.test(owner)) { scope = 'd.owner_id = ?'; p.push(parseInt(owner)); }
  const base = `FROM deals d JOIN leads l ON l.id = d.lead_id LEFT JOIN deal_stages s ON s.id = d.stage_id
                WHERE l.archived_at IS NULL AND ${scope}`;
  const monthStart = "DATE_FORMAT(NOW(), '%Y-%m-01')";
  const [[open]] = await db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(d.value),0) AS value,
            COALESCE(SUM(d.value * COALESCE(s.probability,0) / 100),0) AS weighted
     ${base} AND d.status='open'`, p);
  const [[won]] = await db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(d.value),0) AS value ${base} AND d.status='won' AND d.won_at >= ${monthStart}`, p);
  const [[lost]] = await db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(d.value),0) AS value ${base} AND d.status='lost' AND d.lost_at >= ${monthStart}`, p);
  const [[closing]] = await db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(d.value),0) AS value ${base} AND d.status='open'
       AND d.expected_close_date IS NOT NULL AND d.expected_close_date <= LAST_DAY(NOW())`, p);
  let perOwner = [];
  if (seesAll(req.user)) {
    [perOwner] = await db.query(
      `SELECT u.id, u.full_name,
              COALESCE(SUM(CASE WHEN d.status='won' AND d.won_at >= ${monthStart} THEN d.value END),0) AS won_value,
              COUNT(CASE WHEN d.status='won' AND d.won_at >= ${monthStart} THEN 1 END) AS won_count,
              COALESCE(SUM(CASE WHEN d.status='open' THEN d.value END),0) AS open_value,
              COUNT(CASE WHEN d.status='open' THEN 1 END) AS open_count
       FROM users u
       LEFT JOIN (SELECT d.* FROM deals d JOIN leads l ON l.id = d.lead_id WHERE l.archived_at IS NULL) d
              ON d.owner_id = u.id
       WHERE u.is_active = 1
       GROUP BY u.id, u.full_name
       HAVING won_count > 0 OR open_count > 0
       ORDER BY won_value DESC, open_value DESC`);
  }
  const num = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v) || 0]));
  res.json({ open: num(open), won_month: num(won), lost_month: num(lost), closing_month: num(closing),
             per_owner: perOwner.map(r => ({ ...num(r), full_name: r.full_name })) });
});

// ── Anlegen ──────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const leadId = parseInt(req.body.lead_id);
  const value  = parseValue(req.body.value);
  const close  = parseDate(req.body.expected_close_date);
  if (!leadId) return res.status(400).json({ error: 'Bitte einen Lead auswählen' });
  if (Number.isNaN(value)) return res.status(400).json({ error: 'Ungültiger Wert' });
  if (Number.isNaN(close)) return res.status(400).json({ error: 'Ungültiges Datum' });
  try {
    const [[lead]] = await db.query('SELECT id, assigned_to, company FROM leads WHERE id=? AND archived_at IS NULL', [leadId]);
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (req.user.role !== 'admin' && lead.assigned_to !== req.user.id)
      return res.status(403).json({ error: 'Deals nur für eigene Leads' });
    let stageId = parseInt(req.body.stage_id) || null;
    if (stageId) {
      const [[s]] = await db.query('SELECT id FROM deal_stages WHERE id=? AND is_active=1', [stageId]);
      if (!s) stageId = null;
    }
    const ownerId = req.user.role === 'admin' && parseInt(req.body.owner_id)
      ? parseInt(req.body.owner_id) : (lead.assigned_to || req.user.id);
    const id = await createDeal({
      leadId, userId: req.user.id, title: String(req.body.title || '').trim() || lead.company,
      value: value || 0, stageId, ownerId, expectedClose: close || null,
    });
    if (req.body.notes) await db.query('UPDATE deals SET notes=? WHERE id=?', [String(req.body.notes).slice(0, 5000), id]);
    await log(req.user.id, 'deal_create', 'lead', leadId, { deal_id: id, value }, req.ip);
    res.status(201).json({ ok: true, id });
  } catch (e) {
    console.error('Deal create error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── Bearbeiten (inkl. Phase verschieben) ─────────────────────
router.patch('/:id', auth, async (req, res) => {
  const deal = await loadDeal(parseInt(req.params.id));
  if (!deal) return res.status(404).json({ error: 'Deal nicht gefunden' });
  if (!canEdit(req.user, deal)) return res.status(403).json({ error: 'Kein Zugriff' });

  const updates = [], params = [];
  if (req.body.title !== undefined) {
    const t = String(req.body.title).trim().slice(0, 200);
    if (!t) return res.status(400).json({ error: 'Titel fehlt' });
    updates.push('title=?'); params.push(t);
  }
  const value = parseValue(req.body.value);
  if (Number.isNaN(value)) return res.status(400).json({ error: 'Ungültiger Wert' });
  if (value !== undefined) { updates.push('value=?'); params.push(value); }
  const close = parseDate(req.body.expected_close_date);
  if (Number.isNaN(close)) return res.status(400).json({ error: 'Ungültiges Datum' });
  if (close !== undefined) { updates.push('expected_close_date=?'); params.push(close); }
  if (req.body.notes !== undefined) { updates.push('notes=?'); params.push(String(req.body.notes || '').slice(0, 5000) || null); }
  if (req.body.owner_id !== undefined && req.user.role === 'admin') {
    updates.push('owner_id=?'); params.push(parseInt(req.body.owner_id) || null);
  }
  let newStage = null;
  if (req.body.stage_id !== undefined && parseInt(req.body.stage_id) !== deal.stage_id) {
    const [[s]] = await db.query('SELECT id, name FROM deal_stages WHERE id=? AND is_active=1', [parseInt(req.body.stage_id)]);
    if (!s) return res.status(400).json({ error: 'Ungültige Phase' });
    newStage = s;
    updates.push('stage_id=?', 'stage_changed_at=NOW()'); params.push(s.id);
  }
  if (!updates.length) return res.json({ ok: true });
  params.push(deal.id);
  await db.query(`UPDATE deals SET ${updates.join(',')} WHERE id=?`, params);
  if (newStage) await note(deal.lead_id, req.user.id, `➜ ${deal.title}: Phase „${newStage.name}“`);
  if (newStage && istAngebotAnfrage(newStage.name)) {
    const infos = String(req.body.angebot_infos || '').trim().slice(0, 3000);
    await note(deal.lead_id, req.user.id, `📝 Angebot angefordert${infos ? `: ${infos}` : ''}`);
    // Admins sehen die Anfrage in „Heute“ und bekommen den Reminder-Hinweis
    if (req.user.role !== 'admin') {
      const [admins] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1");
      for (const a of admins) {
        await db.query("INSERT INTO reminders (lead_id, user_id, remind_at, note, kind) VALUES (?, ?, NOW(), ?, 'angebot')",
          [deal.lead_id, a.id, `Angebot anfordern: ${deal.title} (${req.user.full_name})${infos ? ` – ${infos.slice(0, 200)}` : ''}`]);
      }
    }
  }
  await log(req.user.id, newStage ? 'deal_stage_change' : 'deal_update', 'lead', deal.lead_id,
    { deal_id: deal.id, ...(newStage ? { stage: newStage.name } : {}) }, req.ip);
  res.json({ ok: true });
});

router.post('/:id/won', auth, async (req, res) => {
  const deal = await loadDeal(parseInt(req.params.id));
  if (!deal) return res.status(404).json({ error: 'Deal nicht gefunden' });
  if (!canEdit(req.user, deal)) return res.status(403).json({ error: 'Kein Zugriff' });
  const value = parseValue(req.body?.value);
  if (Number.isNaN(value)) return res.status(400).json({ error: 'Ungültiger Wert' });
  await markWon(deal, req.user.id, value);
  await log(req.user.id, 'deal_won', 'lead', deal.lead_id, { deal_id: deal.id, value: value ?? deal.value }, req.ip);
  res.json({ ok: true });
});

router.post('/:id/lost', auth, async (req, res) => {
  const deal = await loadDeal(parseInt(req.params.id));
  if (!deal) return res.status(404).json({ error: 'Deal nicht gefunden' });
  if (!canEdit(req.user, deal)) return res.status(403).json({ error: 'Kein Zugriff' });
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: 'Bitte einen Verlustgrund angeben' });
  await markLost(deal, req.user.id, reason);
  await log(req.user.id, 'deal_lost', 'lead', deal.lead_id, { deal_id: deal.id, reason }, req.ip);
  res.json({ ok: true });
});

router.post('/:id/reopen', auth, async (req, res) => {
  const deal = await loadDeal(parseInt(req.params.id));
  if (!deal) return res.status(404).json({ error: 'Deal nicht gefunden' });
  if (!canEdit(req.user, deal)) return res.status(403).json({ error: 'Kein Zugriff' });
  // Phase inzwischen gelöscht? Dann in die erste Phase zurück
  const [[s]] = await db.query('SELECT id FROM deal_stages WHERE id=? AND is_active=1', [deal.stage_id]);
  const stageId = s ? deal.stage_id : await firstStageId();
  await db.query(
    "UPDATE deals SET status='open', won_at=NULL, lost_at=NULL, lost_reason=NULL, stage_id=?, stage_changed_at=NOW() WHERE id=?",
    [stageId, deal.id]);
  await note(deal.lead_id, req.user.id, `↺ Deal wieder geöffnet: ${deal.title}`);
  await log(req.user.id, 'deal_reopen', 'lead', deal.lead_id, { deal_id: deal.id }, req.ip);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  const deal = await loadDeal(parseInt(req.params.id));
  if (!deal) return res.status(404).json({ error: 'Deal nicht gefunden' });
  await db.query('DELETE FROM deals WHERE id=?', [deal.id]);
  await log(req.user.id, 'deal_delete', 'lead', deal.lead_id, { deal_id: deal.id, title: deal.title }, req.ip);
  res.json({ ok: true });
});

module.exports = router;
module.exports.createDeal = createDeal;
module.exports.markWon = markWon;
module.exports.markLost = markLost;
module.exports.parseValue = parseValue;
module.exports.istAngebotAnfrage = istAngebotAnfrage;
