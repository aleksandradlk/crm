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
const datumText = sql => new Date(String(sql).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
// „Anruf bis“: heute = spontan anrufen
const anrufBisText = sql => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return String(sql).slice(0, 10) === `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` ? 'Heute anrufen (spontan)' : `Anruf bis ${datumText(sql)}`;
};
const terminText = sql => {
  const d = new Date(String(sql).replace(' ', 'T').slice(0, 19) + 'Z');
  return d.toLocaleString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' Uhr';
};

const SELECT = `
  SELECT a.*, DATE_FORMAT(a.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
         DATE_FORMAT(a.counter_at, '%Y-%m-%d %H:%i:%s') AS counter_at,
         l.company, l.ceo, l.phone, l.email, l.source, l.assigned_to, l.website, l.instagram_url, l.industry,
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
  // „Anruf bis“: Erinnerung morgens am letzten Tag (mit Mail), sonst die 15-Min.-Erinnerung des Termins
  const bis = a.art === 'anruf_bis';
  await db.query(
    "INSERT INTO reminders (lead_id, user_id, remind_at, note, kind, sent, appointment_id) VALUES (?,?,?,?, 'termin', ?, ?)",
    [a.lead_id, a.closer_id, a.starts_at, (bis ? `Anruf bis heute${a.topic ? ': ' + a.topic : ''}` : `Termin${a.topic ? ': ' + a.topic : ''}`).slice(0, 500), bis ? 0 : 1, a.id]);
  await db.query("UPDATE leads SET status='kontaktiert' WHERE id=? AND status IN ('neu','nicht_erreicht')", [a.lead_id]);
  await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
    [a.lead_id, userId, `📅 ${bis ? 'Anruf bis ' + datumText(a.starts_at) : 'Termin am ' + terminText(a.starts_at)}${a.topic ? ' – ' + a.topic : ''} (${a.closer_name || 'Closer'})`]);
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
      `${SELECT} WHERE a.closer_id=? AND a.status='angenommen' AND a.art='termin'
         AND a.starts_at BETWEEN NOW() - INTERVAL 5 MINUTE AND NOW() + INTERVAL 15 MINUTE`, [req.user.id]);
    const [[{ heute }]] = await db.query(
      "SELECT COUNT(*) AS heute FROM appointments WHERE closer_id=? AND status='angenommen' AND DATE(starts_at)=CURDATE() AND starts_at >= NOW() - INTERVAL 1 HOUR",
      [req.user.id]);
    res.json({ offen, heute, bald });
  } catch (e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── POST /api/termine — Termin anlegen bzw. einem Closer übergeben ──
// lead_id ODER lead { company, ceo, phone, email, website, instagram, industry, source } (neuer Lead)
// Übergabe (Admin → anderer Closer): Thema + Painpoints Pflicht, bekannte Pflichtfragen
// landen in der Bedarfsanalyse, der Lead gehört sofort dem Closer.
// art: 'termin' (Datum + Uhrzeit) oder 'anruf_bis' (nur Datum)
router.post('/', auth, async (req, res) => {
  const b = req.body || {};
  const art = b.art === 'anruf_bis' || (b.anruf_bis && !b.starts_at) ? 'anruf_bis' : 'termin';
  const starts = art === 'anruf_bis'
    ? (/^\d{4}-\d{2}-\d{2}$/.test(String(b.anruf_bis || '')) ? `${b.anruf_bis} 09:00:00` : null)
    : zeit(b.starts_at);
  if (!starts) return res.status(400).json({ error: art === 'anruf_bis' ? 'Bitte angeben, bis wann angerufen werden soll.' : 'Bitte Datum und Uhrzeit angeben.' });
  const grenze = art === 'anruf_bis' ? new Date(starts.slice(0, 10) + 'T23:59:59') : new Date(starts.replace(' ', 'T'));
  if (grenze.getTime() < Date.now() - 5 * 60000)
    return res.status(400).json({ error: 'Der Termin liegt in der Vergangenheit.' });
  const closerId = istAdmin(req.user) ? (parseInt(b.closer_id) || req.user.id) : req.user.id;
  const uebergabe = closerId !== req.user.id;
  const dauer = Math.min(Math.max(parseInt(b.duration_min) || 30, 5), 480);
  const topic = String(b.topic || '').trim().slice(0, 200) || null;
  const notes = String(b.notes || '').trim().slice(0, 4000) || null;
  const painpoints = String(b.painpoints || '').trim().slice(0, 3000) || null;
  const versprochen = String(b.versprochen || '').trim().slice(0, 2000) || null;
  const l = b.lead || {};
  const txt = (v, n = 255) => String(v || '').trim().slice(0, n) || null;
  try {
    const [[closer]] = await db.query('SELECT id, full_name, is_active FROM users WHERE id=?', [closerId]);
    if (!closer || !closer.is_active) return res.status(400).json({ error: 'Diesen Closer gibt es nicht (mehr).' });

    let leadId = parseInt(b.lead_id) || null, lead = null;
    if (leadId) {
      [[lead]] = await db.query('SELECT * FROM leads WHERE id=? AND archived_at IS NULL', [leadId]);
      if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
      if (!sicht.darfSehen(req.user, lead)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Lead' });
    }
    // Pflichtfelder der Übergabe (Handbuch S. 4: „mit Thema, Painpoints und Webseite“)
    if (uebergabe) {
      const fehlt = [];
      if (!leadId && !txt(l.company)) fehlt.push('Betrieb');
      if (!txt(l.ceo) && !lead?.ceo) fehlt.push('Ansprechpartner');
      if (!txt(l.phone) && !lead?.phone) fehlt.push('Telefon');
      if (!txt(l.industry) && !lead?.industry) fehlt.push('Branche');
      if (!leadId && !txt(l.source)) fehlt.push('Quelle');
      if (!topic) fehlt.push('Thema');
      if (!painpoints) fehlt.push('Painpoints');
      if (fehlt.length) return res.status(400).json({ error: `Bitte noch ausfüllen: ${fehlt.join(', ')}` });
    }

    if (!leadId) {
      if (!istAdmin(req.user)) return res.status(400).json({ error: 'Bitte zuerst den Lead öffnen.' });
      if (!txt(l.company)) return res.status(400).json({ error: 'Firma oder Name des Kunden fehlt.' });
      if (!b.force) {
        const dups = await findDuplicates({ phone: l.phone, email: l.email, website: l.website });
        if (dups.length) return res.status(409).json({ error: `Gibt es schon: ${dups[0].company}`, duplicates: dups });
      }
      const quelle = QUELLEN.find(q => q.toLowerCase() === String(l.source || '').toLowerCase()) || txt(l.source, 50) || 'Termin';
      const [r] = await db.query(
        `INSERT INTO leads (company, ceo, email, phone, website, instagram_url, industry, notes, status, assigned_to, created_by, source, confidence)
         VALUES (?,?,?,?,?,?,?,?, 'neu', NULL, ?, ?, 90)`,
        [txt(l.company), txt(l.ceo), txt(l.email), txt(l.phone, 50), txt(l.website), txt(l.instagram), txt(l.industry, 100),
         txt(l.notes, 4000), req.user.id, quelle]);
      leadId = r.insertId;
      await refreshNorm(leadId);
      await log(req.user.id, 'lead_create_manual', 'lead', leadId, { company: l.company, via: 'termin' }, req.ip);
      [[lead]] = await db.query('SELECT * FROM leads WHERE id=?', [leadId]);
    } else if (uebergabe) {
      // Vorhandenen Lead nur ergänzen, nie überschreiben
      const sets = [], p = [];
      for (const [col, val, n] of [['ceo', l.ceo], ['phone', l.phone, 50], ['email', l.email], ['website', l.website], ['instagram_url', l.instagram], ['industry', l.industry, 100]])
        if (txt(val, n) && !lead[col]) { sets.push(`${col}=?`); p.push(txt(val, n)); }
      if (sets.length) { await db.query(`UPDATE leads SET ${sets.join(', ')} WHERE id=?`, [...p, leadId]); await refreshNorm(leadId); }
    }

    // Übergabe: Lead gehört sofort dem Closer (Ablehnen setzt das zurück)
    const vorher = lead.assigned_to;
    if (uebergabe && lead.assigned_to !== closerId) {
      await db.query('UPDATE leads SET assigned_to=? WHERE id=?', [closerId, leadId]);
      await sicht.uebergeben(leadId, lead.assigned_to, closerId);
      await log(req.user.id, 'lead_assign', 'lead', leadId, { assigned_to: closerId, via: 'uebergabe' }, req.ip);
    }
    // Bekannte Pflichtfragen in die Bedarfsanalyse, der Rest = „Noch klären“
    let offen = null;
    if (uebergabe || b.fragen) {
      const pr = await require('./bedarf').vorbefuellen(leadId, b.fragen || {}, req.user.id);
      offen = pr ? pr.fragen.filter(f => !f.ok).map(f => f.nr).join(',') : null;
    }
    // Deal mit Herkunft „warme Übergabe“ in „Termin vereinbart“
    if (uebergabe) {
      const [[od]] = await db.query("SELECT id, herkunft FROM deals WHERE lead_id=? AND status='open' ORDER BY id DESC LIMIT 1", [leadId]);
      if (od) await db.query("UPDATE deals SET herkunft=COALESCE(herkunft, 'uebergabe_warm'), owner_id=? WHERE id=?", [closerId, od.id]);
      else {
        const [[st]] = await db.query(`SELECT id FROM deal_stages WHERE is_active=1 AND name REGEXP ? ORDER BY sort_order LIMIT 1`, [art === 'termin' ? 'termin' : 'qualifiz']);
        const id = await require('./deals').createDeal({ leadId, userId: req.user.id, title: lead.company, value: 0, stageId: st?.id, ownerId: closerId });
        await db.query("UPDATE deals SET herkunft='uebergabe_warm' WHERE id=?", [id]);
      }
    }

    const sofort = !uebergabe;
    const [r] = await db.query(
      `INSERT INTO appointments (lead_id, closer_id, proposed_by, starts_at, duration_min, topic, notes, status, responded_at,
         art, painpoints, versprochen, offene_fragen, uebergabe, vorher_zugewiesen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [leadId, closerId, req.user.id, starts, dauer, topic, notes, sofort ? 'angenommen' : 'vorgeschlagen', sofort ? new Date() : null,
       art, painpoints, versprochen, offen, uebergabe ? 1 : 0, uebergabe ? vorher : null]);
    const a = await laden(r.insertId);
    if (sofort) await bestaetigen(a, req.user.id, req.ip);
    else {
      const wann = art === 'anruf_bis' ? anrufBisText(starts) : terminText(starts);
      await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
        [leadId, req.user.id, `📅 Übergabe an ${closer.full_name}: ${wann}${topic ? ' – ' + topic : ''}`]);
      const offenTitel = await require('./bedarf').offeneFragen(leadId);
      if (b.notify_mail !== false) await mailAn(closerId, `📅 Neue Übergabe für dich: ${a.company}`, [
        `${req.user.full_name || 'Der Admin'} übergibt dir einen warmen Lead:`,
        `<b>${wann}</b>${art === 'termin' ? ` · ${dauer} Min.` : ''}`,
        `<b>Kunde:</b> ${a.company}${a.ceo ? ' (' + a.ceo + ')' : ''}${a.phone ? ' · ' + a.phone : ''}`,
        topic ? `<b>Thema:</b> ${topic}` : '',
        painpoints ? `<b>Painpoints:</b> ${painpoints}` : '',
        a.website ? `<b>Webseite:</b> ${a.website}` : '',
        offenTitel.length ? `<b>Noch klären:</b> ${offenTitel.map(f => f.titel).join(', ')}` : '',
        versprochen ? `<b>Bereits versprochen:</b> ${versprochen}` : '',
        notes ? `<b>Notizen:</b> ${notes}` : '',
        'Bitte im CRM unter „Termine“ annehmen, ablehnen oder eine andere Zeit vorschlagen.',
      ]);
    }
    await log(req.user.id, uebergabe ? 'termin_uebergabe' : 'termin_create', 'lead', leadId, { appointment_id: a.id, closer_id: closerId, starts_at: starts, art }, req.ip);
    res.status(201).json({ ok: true, id: a.id, lead_id: leadId, status: a.status });
  } catch (e) { console.error('Termin POST:', e); res.status(500).json({ error: 'Termin konnte nicht gespeichert werden.' }); }
});

// ── GET /api/termine/uebergabe/:leadId — letzte Übergabe zum Lead („Lead“-Tab, Panel) ──
router.get('/uebergabe/:leadId', auth, async (req, res) => {
  try {
    const leadId = parseInt(req.params.leadId);
    const [[lead]] = await db.query('SELECT id, assigned_to, website, instagram_url FROM leads WHERE id=?', [leadId]);
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (!istAdmin(req.user) && !sicht.darfSehen(req.user, lead)) return res.status(403).json({ error: 'Kein Zugriff' });
    const [[a]] = await db.query(`${SELECT} WHERE a.lead_id=? AND a.uebergabe=1 AND a.status NOT IN ('abgesagt') ORDER BY a.id DESC LIMIT 1`, [leadId]);
    if (!a) return res.json(null);
    res.json({ id: a.id, art: a.art, starts_at: a.starts_at, status: a.status, topic: a.topic, painpoints: a.painpoints, versprochen: a.versprochen,
      notes: a.notes, proposed_name: a.proposed_name, website: lead.website, instagram: lead.instagram_url,
      noch_klaeren: await require('./bedarf').offeneFragen(leadId) });
  } catch (e) { console.error('Übergabe GET:', e); res.status(500).json({ error: 'Fehler' }); }
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
      // Übergabe abgelehnt: Lead geht zurück, bis der Admin ihn neu vergibt
      if (a.uebergabe && a.assigned_to === a.closer_id && a.vorher_zugewiesen !== a.closer_id) {
        await db.query('UPDATE leads SET assigned_to=? WHERE id=?', [a.vorher_zugewiesen || null, a.lead_id]);
        if (a.vorher_zugewiesen) await sicht.uebergeben(a.lead_id, a.closer_id, a.vorher_zugewiesen);
      }
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
    const art = b.anruf_bis ? 'anruf_bis' : b.starts_at !== undefined ? 'termin' : a.art;
    const starts = b.anruf_bis ? (/^\d{4}-\d{2}-\d{2}$/.test(b.anruf_bis) ? `${b.anruf_bis} 09:00:00` : null)
      : b.starts_at !== undefined ? zeit(b.starts_at) : a.starts_at;
    const painpoints = b.painpoints !== undefined ? String(b.painpoints || '').trim().slice(0, 3000) || null : a.painpoints;
    const versprochen = b.versprochen !== undefined ? String(b.versprochen || '').trim().slice(0, 2000) || null : a.versprochen;
    if (!starts) return res.status(400).json({ error: 'Bitte Datum und Uhrzeit angeben.' });
    const closerId = admin && b.closer_id !== undefined ? (parseInt(b.closer_id) || a.closer_id) : a.closer_id;
    const topic = b.topic !== undefined ? String(b.topic || '').trim().slice(0, 200) || null : a.topic;
    const notes = b.notes !== undefined ? String(b.notes || '').trim().slice(0, 4000) || null : a.notes;
    const dauer = b.duration_min !== undefined ? Math.min(Math.max(parseInt(b.duration_min) || 30, 5), 480) : a.duration_min;
    // Eigener Termin des Admins geht an einen Closer → wird zur warmen Übergabe (Thema + Painpoints Pflicht)
    const wirdUebergabe = admin && !a.uebergabe && closerId !== a.closer_id && closerId !== req.user.id;
    if (wirdUebergabe) {
      const fehlt = [!topic && 'Thema', !painpoints && 'Painpoints'].filter(Boolean);
      if (fehlt.length) return res.status(400).json({ error: `Bitte noch ausfüllen: ${fehlt.join(', ')}` });
      const [[cl]] = await db.query('SELECT is_active FROM users WHERE id=?', [closerId]);
      if (!cl || !cl.is_active) return res.status(400).json({ error: 'Diesen Closer gibt es nicht (mehr).' });
    }
    // Neuer Closer oder neue Zeit für einen anderen → wieder als Vorschlag
    const neuVorschlag = closerId !== req.user.id
      && (closerId !== a.closer_id || starts !== a.starts_at || ['abgelehnt', 'gegenvorschlag'].includes(a.status));
    const status = neuVorschlag ? 'vorgeschlagen' : (closerId === req.user.id ? 'angenommen' : a.status);
    await db.query(
      `UPDATE appointments SET erinnert=IF(starts_at=?, erinnert, 0), starts_at=?, closer_id=?, topic=?, notes=?,
         duration_min=?, status=?, counter_at=IF(?, NULL, counter_at), response_note=IF(?, NULL, response_note)
         , art=?, painpoints=?, versprochen=?
       WHERE id=?`,
      [starts, starts, closerId, topic, notes, dauer, status, neuVorschlag, neuVorschlag, art, painpoints, versprochen, a.id]);
    // Übergabe an einen anderen Closer: der Lead wandert sofort mit
    if ((a.uebergabe || wirdUebergabe) && closerId !== a.closer_id) {
      const [[ld]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [a.lead_id]);
      if (wirdUebergabe) {
        await db.query('UPDATE appointments SET uebergabe=1, vorher_zugewiesen=? WHERE id=?', [ld ? ld.assigned_to : null, a.id]);
        await db.query("UPDATE deals SET herkunft=COALESCE(herkunft, 'uebergabe_warm') WHERE lead_id=? AND status='open'", [a.lead_id]);
      }
      if (ld && ld.assigned_to !== closerId) {
        await db.query('UPDATE leads SET assigned_to=? WHERE id=?', [closerId, a.lead_id]);
        await sicht.uebergeben(a.lead_id, ld.assigned_to, closerId);
        await db.query("UPDATE deals SET owner_id=? WHERE lead_id=? AND status='open'", [closerId, a.lead_id]);
        await log(req.user.id, 'lead_assign', 'lead', a.lead_id, { assigned_to: closerId, via: 'uebergabe' }, req.ip);
      }
    }
    const neu = await laden(a.id);
    if (status === 'angenommen') await bestaetigen(neu, req.user.id, req.ip);
    else await db.query('UPDATE reminders SET done_at=NOW() WHERE appointment_id=? AND done_at IS NULL', [a.id]);
    if (neuVorschlag) {
      const wann = art === 'anruf_bis' ? anrufBisText(starts) : `${terminText(starts)} · ${dauer} Min.`;
      if (closerId !== a.closer_id) await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
        [a.lead_id, req.user.id, `📅 Übergabe an ${neu.closer_name || 'Closer'}: ${wann}${topic ? ' – ' + topic : ''}`]);
      if (b.notify_mail !== false) await mailAn(closerId, `📅 ${closerId !== a.closer_id ? 'Neue Übergabe' : 'Termin'} für dich: ${neu.company}`, [
        `${req.user.full_name || 'Der Admin'} ${closerId !== a.closer_id ? 'übergibt dir einen warmen Lead' : 'schlägt dir einen Termin vor'}:`,
        `<b>${wann}</b>`,
        `<b>Kunde:</b> ${neu.company}${neu.ceo ? ' (' + neu.ceo + ')' : ''}${neu.phone ? ' · ' + neu.phone : ''}`,
        topic ? `<b>Thema:</b> ${topic}` : '', painpoints ? `<b>Painpoints:</b> ${painpoints}` : '',
        neu.website ? `<b>Webseite:</b> ${neu.website}` : '', notes ? `<b>Notizen:</b> ${notes}` : '',
        'Bitte im CRM unter „Termine“ annehmen, ablehnen oder eine andere Zeit vorschlagen.']);
    }
    await log(req.user.id, 'termin_update', 'lead', a.lead_id, { appointment_id: a.id, status }, req.ip);
    res.json({ ok: true, status });
  } catch (e) { console.error('Termin PATCH:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── Erinnerung 15 Minuten vor dem Termin (per Mail; im CRM über /badge) ──
async function erinnern() {
  try {
    const [rows] = await db.query(
      `${SELECT} WHERE a.status='angenommen' AND a.erinnert=0 AND a.art='termin'
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
