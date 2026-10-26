// ── Termine: Übergabe an Closer und Terminübersicht ─────────────────────────
// Der Admin vereinbart einen Termin (z. B. über Instagram/LinkedIn) und schlägt
// ihn einem Closer vor. Der Closer nimmt an, lehnt ab oder schlägt eine andere
// Zeit vor. Bei Annahme gehört der Lead dem Closer und der Termin steht in
// „Termine“. Eigene Termine (z. B. aus dem Anrufmodus) gelten sofort.
const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const { refreshNorm, findDuplicates } = require('../helpers/dedupe');
const sicht = require('../helpers/sichtbarkeit');
const { sendInfoMail } = require('../helpers/mailer');

const STATUS = ['vorgeschlagen', 'gegenvorschlag', 'angenommen', 'abgelehnt', 'abgesagt', 'erledigt'];
const QUELLEN = ['Instagram', 'LinkedIn', 'Facebook', 'Empfehlung', 'Website', 'Telefon', 'Sonstiges'];

const istAdmin = u => u.role === 'admin';
const zeit = v => {
  if (!v) return null;
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : String(v).replace('T', ' ').slice(0, 16) + ':00';
};
// Zeiten stehen als Ortszeit in der Datenbank – ohne Zeitzonen-Umrechnung ausgeben
const terminText = sql => {
  const d = new Date(String(sql).replace(' ', 'T').slice(0, 19) + 'Z');
  return d.toLocaleString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' Uhr';
};

const SELECT = `
  SELECT a.*, DATE_FORMAT(a.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
         DATE_FORMAT(a.counter_at, '%Y-%m-%d %H:%i:%s') AS counter_at,
         l.company, l.ceo, l.phone, l.email, l.source, l.assigned_to,
         c.full_name AS closer_name, p.full_name AS proposed_name
  FROM appointments a
  JOIN leads l ON l.id = a.lead_id
  LEFT JOIN users c ON c.id = a.closer_id
  LEFT JOIN users p ON p.id = a.proposed_by`;

async function laden(id) {
  const [[a]] = await db.query(SELECT + ' WHERE a.id=?', [id]);
  return a;
}

// Benachrichtigung per Mail (nur wenn der Empfänger eine Adresse hat und Mails möchte)
async function mailAn(userId, subject, zeilen) {
  try {
    const [[u]] = await db.query('SELECT email, full_name, notify_email FROM users WHERE id=?', [userId]);
    if (!u?.email || !u.notify_email) return false;
    await sendInfoMail({ to: u.email, toName: u.full_name, subject, zeilen });
    return true;
  } catch (e) { console.error('Termin-Mail:', e.message); return false; }
}

// Termin steht: Lead gehört dem Closer, Wiedervorlage zum Termin (ohne extra Mail,
// die Erinnerung kommt vom Termin selbst), Eintrag im Verlauf
async function bestaetigen(a, userId, ip) {
  const [[lead]] = await db.query('SELECT id, assigned_to FROM leads WHERE id=?', [a.lead_id]);
  if (lead.assigned_to !== a.closer_id) {
    await db.query('UPDATE leads SET assigned_to=? WHERE id=?', [a.closer_id, a.lead_id]);
    await sicht.uebergeben(a.lead_id, lead.assigned_to, a.closer_id);
    await log(userId, 'lead_assign', 'lead', a.lead_id, { assigned_to: a.closer_id, via: 'termin' }, ip);
  }
  await db.query("UPDATE reminders SET done_at=NOW() WHERE appointment_id=? AND done_at IS NULL", [a.id]);
  await db.query(
    "INSERT INTO reminders (lead_id, user_id, remind_at, note, kind, sent, appointment_id) VALUES (?,?,?,?, 'termin', 1, ?)",
    [a.lead_id, a.closer_id, a.starts_at, `Termin${a.topic ? ': ' + a.topic : ''}`.slice(0, 500), a.id]);
  await db.query("UPDATE leads SET status='kontaktiert' WHERE id=? AND status IN ('neu','nicht_erreicht')", [a.lead_id]);
  await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
    [a.lead_id, userId, `📅 Termin am ${terminText(a.starts_at)}${a.topic ? ' – ' + a.topic : ''} (${a.closer_name || 'Closer'})`]);
}

// ── GET /api/termine — eigene Termine (Admin: alle, ?closer=<id> filtert) ──
router.get('/', auth, async (req, res) => {
  try {
    const where = ["(a.status IN ('vorgeschlagen','gegenvorschlag','abgelehnt') OR a.starts_at >= CURDATE() - INTERVAL 14 DAY)"];
    const params = [];
    if (!istAdmin(req.user)) { where.push('a.closer_id = ?'); params.push(req.user.id); where.push("a.status <> 'abgelehnt'"); }
    else if (parseInt(req.query.closer)) { where.push('a.closer_id = ?'); params.push(parseInt(req.query.closer)); }
    const [rows] = await db.query(`${SELECT} WHERE ${where.join(' AND ')} AND l.archived_at IS NULL ORDER BY a.starts_at ASC LIMIT 500`, params);
    res.json(rows);
  } catch (e) { console.error('Termine GET:', e); res.status(500).json({ error: 'Termine konnten nicht geladen werden.' }); }
});

// ── GET /api/termine/badge — offene Anfragen und Termine in den nächsten 15 Minuten ──
router.get('/badge', auth, async (req, res) => {
  try {
    const [[{ offen }]] = istAdmin(req.user)
      ? await db.query("SELECT COUNT(*) AS offen FROM appointments WHERE status IN ('gegenvorschlag','abgelehnt')")
      : await db.query("SELECT COUNT(*) AS offen FROM appointments WHERE status='vorgeschlagen' AND closer_id=?", [req.user.id]);
    const [bald] = await db.query(
      `${SELECT} WHERE a.closer_id=? AND a.status='angenommen'
         AND a.starts_at BETWEEN NOW() - INTERVAL 5 MINUTE AND NOW() + INTERVAL 15 MINUTE`, [req.user.id]);
    const [[{ heute }]] = await db.query(
      "SELECT COUNT(*) AS heute FROM appointments WHERE closer_id=? AND status='angenommen' AND DATE(starts_at)=CURDATE() AND starts_at >= NOW() - INTERVAL 1 HOUR",
      [req.user.id]);
    res.json({ offen, heute, bald });
  } catch (e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── POST /api/termine — Termin anlegen bzw. einem Closer vorschlagen ──
// lead_id ODER lead { company, ceo, phone, email, source, notes } (neuer Lead)
router.post('/', auth, async (req, res) => {
  const b = req.body || {};
  const starts = zeit(b.starts_at);
  if (!starts) return res.status(400).json({ error: 'Bitte Datum und Uhrzeit angeben.' });
  if (new Date(starts.replace(' ', 'T')).getTime() < Date.now() - 5 * 60000)
    return res.status(400).json({ error: 'Der Termin liegt in der Vergangenheit.' });
  const closerId = istAdmin(req.user) ? (parseInt(b.closer_id) || req.user.id) : req.user.id;
  const dauer = Math.min(Math.max(parseInt(b.duration_min) || 30, 5), 480);
  const topic = String(b.topic || '').trim().slice(0, 200) || null;
  const notes = String(b.notes || '').trim().slice(0, 4000) || null;
  try {
    const [[closer]] = await db.query('SELECT id, full_name, is_active FROM users WHERE id=?', [closerId]);
    if (!closer || !closer.is_active) return res.status(400).json({ error: 'Diesen Closer gibt es nicht (mehr).' });

    let leadId = parseInt(b.lead_id) || null;
    if (leadId) {
      const [[lead]] = await db.query('SELECT id, assigned_to FROM leads WHERE id=? AND archived_at IS NULL', [leadId]);
      if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
      if (!sicht.darfSehen(req.user, lead)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Lead' });
    } else {
      if (!istAdmin(req.user)) return res.status(400).json({ error: 'Bitte zuerst den Lead öffnen.' });
      const l = b.lead || {};
      if (!String(l.company || '').trim()) return res.status(400).json({ error: 'Firma oder Name des Kunden fehlt.' });
      if (!b.force) {
        const dups = await findDuplicates({ phone: l.phone, email: l.email, website: l.website });
        if (dups.length) return res.status(409).json({ error: `Gibt es schon: ${dups[0].company}`, duplicates: dups });
      }
      const quelle = QUELLEN.find(q => q.toLowerCase() === String(l.source || '').toLowerCase()) || String(l.source || '').trim().slice(0, 50) || 'Termin';
      const [r] = await db.query(
        `INSERT INTO leads (company, ceo, email, phone, notes, status, assigned_to, created_by, source, confidence)
         VALUES (?,?,?,?,?, 'neu', NULL, ?, ?, 90)`,
        [String(l.company).trim().slice(0, 255), l.ceo || null, l.email || null, l.phone || null,
         l.notes || null, req.user.id, quelle]);
      leadId = r.insertId;
      await refreshNorm(leadId);
      await log(req.user.id, 'lead_create_manual', 'lead', leadId, { company: l.company, via: 'termin' }, req.ip);
    }

    const sofort = closerId === req.user.id;
    const [r] = await db.query(
      `INSERT INTO appointments (lead_id, closer_id, proposed_by, starts_at, duration_min, topic, notes, status, responded_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [leadId, closerId, req.user.id, starts, dauer, topic, notes, sofort ? 'angenommen' : 'vorgeschlagen', sofort ? new Date() : null]);
    const a = await laden(r.insertId);
    if (sofort) await bestaetigen(a, req.user.id, req.ip);
    else {
      await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
        [leadId, req.user.id, `📅 Termin vorgeschlagen an ${closer.full_name}: ${terminText(starts)}${topic ? ' – ' + topic : ''}`]);
      if (b.notify_mail !== false) await mailAn(closerId, `📅 Neuer Termin für dich: ${a.company}`, [
        `${req.user.full_name || 'Der Admin'} hat einen Termin für dich vereinbart:`,
        `<b>${terminText(starts)}</b> · ${dauer} Min.`,
        `<b>Kunde:</b> ${a.company}${a.ceo ? ' (' + a.ceo + ')' : ''}`,
        topic ? `<b>Thema:</b> ${topic}` : '',
        notes ? `<b>Notizen:</b> ${notes}` : '',
        'Bitte im CRM unter „Termine“ annehmen, ablehnen oder eine andere Zeit vorschlagen.',
      ]);
    }
    await log(req.user.id, 'termin_create', 'lead', leadId, { appointment_id: a.id, closer_id: closerId, starts_at: starts }, req.ip);
    res.status(201).json({ ok: true, id: a.id, lead_id: leadId, status: a.status });
  } catch (e) { console.error('Termin POST:', e); res.status(500).json({ error: 'Termin konnte nicht gespeichert werden.' }); }
});

// ── POST /api/termine/:id/antwort — annehmen | ablehnen | gegenvorschlag ──
// Der Closer antwortet auf einen Vorschlag; der Admin kann einen Gegenvorschlag annehmen.
router.post('/:id/antwort', auth, async (req, res) => {
  const { aktion } = req.body || {};
  const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
  try {
    const a = await laden(parseInt(req.params.id));
    if (!a) return res.status(404).json({ error: 'Termin nicht gefunden' });
    const alsCloser = a.closer_id === req.user.id && a.status === 'vorgeschlagen';
    const alsAdmin = istAdmin(req.user) && a.status === 'gegenvorschlag' && aktion === 'annehmen';
    if (a.closer_id !== req.user.id && !istAdmin(req.user)) return res.status(403).json({ error: 'Dieser Termin ist nicht für dich.' });
    if (!alsCloser && !alsAdmin) return res.status(409).json({ error: 'Auf diesen Termin wurde schon geantwortet.' });

    if (aktion === 'annehmen') {
      if (alsAdmin) a.starts_at = a.counter_at;
      await db.query("UPDATE appointments SET status='angenommen', starts_at=?, response_note=COALESCE(?, response_note), responded_at=NOW() WHERE id=?",
        [a.starts_at, note, a.id]);
      a.status = 'angenommen';
      await bestaetigen(a, req.user.id, req.ip);
      if (alsCloser) await mailAn(a.proposed_by, `✅ ${a.closer_name} übernimmt den Termin: ${a.company}`,
        [`${a.closer_name} hat den Termin am <b>${terminText(a.starts_at)}</b> mit ${a.company} angenommen.`, note ? `Notiz: ${note}` : '']);
      else await mailAn(a.closer_id, `✅ Dein Zeitvorschlag passt: ${a.company}`,
        [`Der Termin mit ${a.company} steht am <b>${terminText(a.starts_at)}</b>.`]);
    } else if (aktion === 'ablehnen') {
      await db.query("UPDATE appointments SET status='abgelehnt', response_note=?, responded_at=NOW() WHERE id=?", [note, a.id]);
      await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
        [a.lead_id, req.user.id, `📅 Termin abgelehnt von ${a.closer_name}${note ? ': ' + note : ''}`]);
      await mailAn(a.proposed_by, `❌ ${a.closer_name} kann den Termin nicht: ${a.company}`,
        [`${a.closer_name} hat den Termin am ${terminText(a.starts_at)} abgelehnt.`, note ? `Grund: ${note}` : '', 'Unter „Termine“ kannst du ihn einem anderen Closer geben.']);
    } else if (aktion === 'gegenvorschlag') {
      const counter = zeit(req.body.starts_at);
      if (!counter || new Date(counter.replace(' ', 'T')).getTime() < Date.now()) return res.status(400).json({ error: 'Bitte eine Zeit in der Zukunft vorschlagen.' });
      await db.query("UPDATE appointments SET status='gegenvorschlag', counter_at=?, response_note=?, responded_at=NOW() WHERE id=?", [counter, note, a.id]);
      await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
        [a.lead_id, req.user.id, `📅 ${a.closer_name} schlägt stattdessen ${terminText(counter)} vor${note ? ': ' + note : ''}`]);
      await mailAn(a.proposed_by, `🔁 Anderer Zeitvorschlag für ${a.company}`,
        [`${a.closer_name} kann am ${terminText(a.starts_at)} nicht und schlägt <b>${terminText(counter)}</b> vor.`, note ? `Notiz: ${note}` : '', 'Unter „Termine“ mit einem Klick annehmen.']);
    } else return res.status(400).json({ error: 'Unbekannte Antwort' });

    await log(req.user.id, 'termin_' + aktion, 'lead', a.lead_id, { appointment_id: a.id }, req.ip);
    res.json({ ok: true });
  } catch (e) { console.error('Termin Antwort:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── PATCH /api/termine/:id — ändern, neu vergeben, absagen, erledigt ──
router.patch('/:id', auth, async (req, res) => {
  const b = req.body || {};
  try {
    const a = await laden(parseInt(req.params.id));
    if (!a) return res.status(404).json({ error: 'Termin nicht gefunden' });
    const admin = istAdmin(req.user);
    if (!admin && a.closer_id !== req.user.id) return res.status(403).json({ error: 'Nicht dein Termin' });
    if (!admin && a.status !== 'angenommen') return res.status(409).json({ error: 'Bitte zuerst annehmen oder ablehnen.' });

    // Nur Status: absagen oder erledigt
    if (b.status === 'abgesagt' || b.status === 'erledigt') {
      await db.query('UPDATE appointments SET status=? WHERE id=?', [b.status, a.id]);
      await db.query('UPDATE reminders SET done_at=NOW() WHERE appointment_id=? AND done_at IS NULL', [a.id]);
      if (b.status === 'abgesagt') {
        await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
          [a.lead_id, req.user.id, `📅 Termin am ${terminText(a.starts_at)} abgesagt`]);
        if (a.closer_id !== req.user.id && a.status === 'angenommen')
          await mailAn(a.closer_id, `Termin abgesagt: ${a.company}`, [`Der Termin am ${terminText(a.starts_at)} mit ${a.company} fällt aus.`]);
      }
      await log(req.user.id, 'termin_' + b.status, 'lead', a.lead_id, { appointment_id: a.id }, req.ip);
      return res.json({ ok: true });
    }

    // Inhalt ändern
    const starts = b.starts_at !== undefined ? zeit(b.starts_at) : a.starts_at;
    if (!starts) return res.status(400).json({ error: 'Bitte Datum und Uhrzeit angeben.' });
    const closerId = admin && b.closer_id !== undefined ? (parseInt(b.closer_id) || a.closer_id) : a.closer_id;
    const topic = b.topic !== undefined ? String(b.topic || '').trim().slice(0, 200) || null : a.topic;
    const notes = b.notes !== undefined ? String(b.notes || '').trim().slice(0, 4000) || null : a.notes;
    const dauer = b.duration_min !== undefined ? Math.min(Math.max(parseInt(b.duration_min) || 30, 5), 480) : a.duration_min;
    // Neuer Closer oder neue Zeit für einen anderen → wieder als Vorschlag
    const neuVorschlag = closerId !== req.user.id
      && (closerId !== a.closer_id || starts !== a.starts_at || ['abgelehnt', 'gegenvorschlag'].includes(a.status));
    const status = neuVorschlag ? 'vorgeschlagen' : (closerId === req.user.id ? 'angenommen' : a.status);
    await db.query(
      `UPDATE appointments SET erinnert=IF(starts_at=?, erinnert, 0), starts_at=?, closer_id=?, topic=?, notes=?,
         duration_min=?, status=?, counter_at=IF(?, NULL, counter_at), response_note=IF(?, NULL, response_note)
       WHERE id=?`,
      [starts, starts, closerId, topic, notes, dauer, status, neuVorschlag, neuVorschlag, a.id]);
    const neu = await laden(a.id);
    if (status === 'angenommen') await bestaetigen(neu, req.user.id, req.ip);
    else await db.query('UPDATE reminders SET done_at=NOW() WHERE appointment_id=? AND done_at IS NULL', [a.id]);
    if (neuVorschlag) await mailAn(closerId, `📅 Termin für dich: ${neu.company}`, [
      `${req.user.full_name || 'Der Admin'} schlägt dir einen Termin vor:`,
      `<b>${terminText(starts)}</b> · ${dauer} Min.`, `<b>Kunde:</b> ${neu.company}`,
      topic ? `<b>Thema:</b> ${topic}` : '', 'Bitte im CRM unter „Termine“ antworten.']);
    await log(req.user.id, 'termin_update', 'lead', a.lead_id, { appointment_id: a.id, status }, req.ip);
    res.json({ ok: true, status });
  } catch (e) { console.error('Termin PATCH:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── Erinnerung 15 Minuten vor dem Termin (per Mail; im CRM über /badge) ──
async function erinnern() {
  try {
    const [rows] = await db.query(
      `${SELECT} WHERE a.status='angenommen' AND a.erinnert=0
         AND a.starts_at BETWEEN NOW() - INTERVAL 5 MINUTE AND NOW() + INTERVAL 15 MINUTE`);
    for (const a of rows) {
      await db.query('UPDATE appointments SET erinnert=1 WHERE id=?', [a.id]);
      await mailAn(a.closer_id, `⏰ Gleich: Termin mit ${a.company} um ${a.starts_at.slice(11, 16)} Uhr`, [
        `In Kürze steht dein Termin an: <b>${terminText(a.starts_at)}</b>`,
        `<b>Kunde:</b> ${a.company}${a.ceo ? ' (' + a.ceo + ')' : ''}${a.phone ? ' · ' + a.phone : ''}`,
        a.topic ? `<b>Thema:</b> ${a.topic}` : '', a.notes ? `<b>Notizen:</b> ${a.notes}` : '',
      ]);
    }
  } catch (e) { if (!/appointments/.test(e.message)) console.error('Termin-Erinnerung:', e.message); }
}

module.exports = router;
module.exports.erinnern = erinnern;
module.exports.bestaetigen = bestaetigen;
module.exports.laden = laden;
