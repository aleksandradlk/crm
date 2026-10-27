const router  = require('express').Router();
const db      = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const { sendLeadEmail } = require('../helpers/mailer');
const { createDeal, markWon, markLost, parseValue } = require('./deals');
const { refreshNorm, findDuplicates, normFields } = require('../helpers/dedupe');
const { buildQueue } = require('../helpers/queue');

const VALID_STATUSES = ['neu','kontaktiert','nicht_erreicht','kein_interesse','rueckruf','kunde','passt_nicht','keine_anrufe'];
const { grundPruefen } = require('../public_html/shared/bedarf-regeln');

// CSV mit Anführungszeichen ("Müller, Meier GmbH") und Zeilenumbrüchen in Feldern
function parseCsv(text, delim) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const sicht = require('../helpers/sichtbarkeit');
const canView = sicht.darfSehen;

// ── GET /api/leads ──────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const { status, search, assigned_to } = req.query;
  let q = `SELECT l.id, l.company, l.ceo, l.phone, l.email, l.location,
                  l.status, l.assigned_to, l.created_by,
                  l.created_at, l.updated_at, l.confidence,
                  u1.full_name AS assigned_name,
                  u2.full_name AS created_name,
                  (SELECT MAX(cl.started_at) FROM call_logs cl WHERE cl.lead_id = l.id) AS last_call_at,
                  (SELECT MIN(r.remind_at) FROM reminders r
                    WHERE r.lead_id = l.id AND r.done_at IS NULL) AS next_reminder_at
           FROM leads l
           LEFT JOIN users u1 ON u1.id = l.assigned_to
           LEFT JOIN users u2 ON u2.id = l.created_by`;
  const scope = sicht.leadFilter(req.user);
  const params = [...scope.params];
  const where  = ['l.archived_at IS NULL', scope.sql];

  if (status && VALID_STATUSES.includes(status)) {
    where.push('l.status = ?');
    params.push(status);
  }
  if (req.query.mine === '1') {
    where.push('l.assigned_to = ?');
    params.push(req.user.id);
  } else if (assigned_to === 'none') {
    where.push('l.assigned_to IS NULL');
  } else if (assigned_to && /^\d+$/.test(assigned_to)) {
    where.push('l.assigned_to = ?');
    params.push(parseInt(assigned_to));
  }
  if (search) {
    if (search.length >= 3) {
      const term = search.replace(/[+\-><()*~"@]/g, ' ').trim().split(/\s+/).filter(Boolean).map(w => w + '*').join(' ');
      where.push('MATCH(l.company, l.ceo, l.location) AGAINST (? IN BOOLEAN MODE)');
      params.push(term);
    } else {
      where.push('(l.company LIKE ? OR l.ceo LIKE ? OR l.location LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    }
  }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY l.created_at DESC';

  // Eigene Leads komplett laden (sonst fallen ältere Leads aus "Meine Leads" heraus)
  const maxLimit = req.query.mine === '1' ? 5000 : 500;
  const limit  = Math.min(parseInt(req.query.limit)  || 100, maxLimit);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  q += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [leads] = await db.query(q, params);
  res.json(leads);
});

// ── POST /api/leads — einzelnen Lead manuell anlegen ────
router.post('/', auth, async (req, res) => {
  const { company, ceo, email, phone, location, website, industry, notes, force } = req.body;
  if (!company?.trim()) return res.status(400).json({ error: 'Firmenname ist erforderlich' });
  try {
    // Dubletten-Check (Telefon, E-Mail, Website) – mit force=true trotzdem anlegen
    if (!force) {
      const duplicates = await findDuplicates({ phone, email, website });
      if (duplicates.length) {
        const d = duplicates[0];
        return res.status(409).json({
          error: `Mögliche Dublette: ${d.company}${d.assigned_name ? ' (betreut von ' + d.assigned_name + ')' : ' (nicht zugewiesen)'} – gleiche ${d.matched_on.replace(/,/g, ', ')}`,
          duplicates,
        });
      }
    }
    const [r] = await db.query(
      `INSERT INTO leads (company, ceo, email, phone, location, website, industry, notes,
        status, assigned_to, created_by, source, confidence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [company.trim(), ceo||null, email||null, phone||null, location||null,
       website||null, industry||null, notes||null,
       'neu', req.user.role === 'closer' ? req.user.id : null,
       req.user.id, 'manuell', 80]
    );
    await refreshNorm(r.insertId);
    await log(req.user.id, 'lead_create_manual', 'lead', r.insertId, { company }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch(e) {
    console.error('Lead create error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/leads/dashboard — Tages-Dashboard (Admin only) ──────────────────
router.get('/dashboard', auth, adminOnly, async (req, res) => {
  try {
    const [[{ callsToday }]] = await db.query(
      `SELECT COUNT(*) AS callsToday FROM call_logs WHERE DATE(started_at) = CURDATE()`
    );
    const [[{ winsThisWeek }]] = await db.query(
      `SELECT COUNT(*) AS winsThisWeek FROM leads WHERE status='kunde' AND YEARWEEK(updated_at, 1) = YEARWEEK(NOW(), 1)`
    );
    const [[{ leadsTotal }]] = await db.query(
      `SELECT COUNT(*) AS leadsTotal FROM leads WHERE archived_at IS NULL`
    );
    const [[{ leadsNew }]] = await db.query(
      `SELECT COUNT(*) AS leadsNew FROM leads WHERE status='neu' AND archived_at IS NULL`
    );
    const [perCloser] = await db.query(
      `SELECT u.full_name,
         COUNT(DISTINCT CASE WHEN DATE(cl.started_at) = CURDATE() THEN cl.id END) AS callsToday,
         COUNT(DISTINCT l.id) AS totalLeads
       FROM users u
       LEFT JOIN call_logs cl ON cl.user_id = u.id
       LEFT JOIN leads l ON l.assigned_to = u.id AND l.archived_at IS NULL
       WHERE u.role = 'closer' AND u.is_active = 1
       GROUP BY u.id, u.full_name
       ORDER BY callsToday DESC`
    );
    // Verteilung aktiver Leads: wem zugewiesen und welche Branche (Zielgruppe).
    // Branchen ohne Rücksicht auf Groß-/Kleinschreibung zusammengefasst, Anzeige in der häufigsten Schreibweise.
    const [vRows] = await db.query(
      `SELECT l.assigned_to AS id, u.full_name, TRIM(COALESCE(l.industry, '')) AS industry, COUNT(*) AS n
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.archived_at IS NULL
       GROUP BY l.assigned_to, u.full_name, TRIM(COALESCE(l.industry, ''))`
    );
    const schreibweise = {};
    vRows.forEach(r => {
      const k = r.industry.toLowerCase();
      (schreibweise[k] = schreibweise[k] || {})[r.industry] = (schreibweise[k][r.industry] || 0) + Number(r.n);
    });
    const branchenName = k => k ? Object.entries(schreibweise[k]).sort((a, b) => b[1] - a[1])[0][0] : null;
    const personen = {};
    vRows.forEach(r => {
      const key = r.id && r.full_name ? r.id : 0;
      const p = personen[key] = personen[key] || { id: key || null, full_name: key ? r.full_name : null, n: 0, branchen: {} };
      const b = branchenName(r.industry.toLowerCase());
      p.n += Number(r.n);
      p.branchen[b || ''] = (p.branchen[b || ''] || 0) + Number(r.n);
    });
    const verteilung = Object.values(personen).sort((a, b) => b.n - a.n)
      .map(p => ({ ...p, branchen: Object.entries(p.branchen).map(([name, n]) => ({ name: name || null, n })).sort((a, b) => b.n - a.n) }));
    res.json({ callsToday, winsThisWeek, leadsTotal, leadsNew, perCloser, verteilung });
  } catch(e) {
    console.error('Dashboard error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/leads/dashboard/closer — eigene Tagesstatistik (Closer) ──────────
router.get('/dashboard/closer', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const [[{ callsToday }]] = await db.query(
      'SELECT COUNT(*) as callsToday FROM call_logs WHERE user_id=? AND DATE(started_at)=CURDATE()', [uid]);
    const [[{ callsWeek }]] = await db.query(
      'SELECT COUNT(*) as callsWeek FROM call_logs WHERE user_id=? AND YEARWEEK(started_at,1)=YEARWEEK(NOW(),1)', [uid]);
    const [[{ winsTotal }]] = await db.query(
      "SELECT COUNT(*) as winsTotal FROM leads WHERE assigned_to=? AND status='kunde' AND archived_at IS NULL", [uid]);
    const [[{ myLeads }]] = await db.query(
      'SELECT COUNT(*) as myLeads FROM leads WHERE assigned_to=? AND archived_at IS NULL', [uid]);
    const [[{ avgCalls }]] = await db.query(
      `SELECT ROUND(AVG(daily_count),1) as avgCalls FROM (
        SELECT COUNT(*) as daily_count FROM call_logs
        WHERE user_id=? AND started_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY DATE(started_at)
      ) t`, [uid]);
    res.json({ callsToday, callsWeek, winsTotal, myLeads, avgCalls: avgCalls || 0 });
  } catch(e) { console.error('Dashboard closer error:', e); res.status(500).json({ error: 'Fehler' }); }
});

// ── GET /api/leads/next — nächster unbearbeiteter Lead des Closers (Feature 3) ──
router.get('/next', auth, async (req, res) => {
  const uid = req.user.id;
  const currentId = parseInt(req.query.current_id) || 0;
  try {
    let [[lead]] = await db.query(
      `SELECT id FROM leads WHERE assigned_to=? AND archived_at IS NULL
       AND status NOT IN ('kunde','kein_interesse') AND id > ?
       ORDER BY id ASC LIMIT 1`, [uid, currentId]
    );
    if (!lead) {
      [[lead]] = await db.query(
        `SELECT id FROM leads WHERE assigned_to=? AND archived_at IS NULL
         AND status NOT IN ('kunde','kein_interesse') ORDER BY id ASC LIMIT 1`, [uid]
      );
    }
    res.json({ id: lead?.id || null });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── GET /api/leads/duplicates/check — Live-Prüfung beim Anlegen/Bearbeiten ──
router.get('/duplicates/check', auth, async (req, res) => {
  const { phone, email, website } = req.query;
  res.json(await findDuplicates({ phone, email, website }, parseInt(req.query.exclude_id) || 0));
});

// ── GET /api/leads/duplicates — alle Dubletten-Gruppen (Admin) ──
router.get('/duplicates', auth, adminOnly, async (req, res) => {
  try {
    const [pairs] = await db.query(
      `SELECT 'Telefon' AS kind, GROUP_CONCAT(id ORDER BY id) AS ids FROM leads
         WHERE archived_at IS NULL AND phone_norm IS NOT NULL GROUP BY phone_norm HAVING COUNT(*) > 1
       UNION ALL
       SELECT 'E-Mail', GROUP_CONCAT(id ORDER BY id) FROM leads
         WHERE archived_at IS NULL AND email_norm IS NOT NULL GROUP BY email_norm HAVING COUNT(*) > 1
       UNION ALL
       SELECT 'Website', GROUP_CONCAT(id ORDER BY id) FROM leads
         WHERE archived_at IS NULL AND domain_norm IS NOT NULL GROUP BY domain_norm HAVING COUNT(*) > 1
       LIMIT 1000`);
    // Überlappende Treffer (gleiche Nummer UND gleiche Domain …) zu einer Gruppe zusammenfassen
    const parent = new Map();
    const find = x => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    const kinds = new Map();
    for (const p of pairs) {
      const ids = String(p.ids).split(',').map(Number);
      ids.forEach(id => { if (!parent.has(id)) parent.set(id, id); });
      ids.slice(1).forEach(id => parent.set(find(id), find(ids[0])));
      ids.forEach(id => kinds.set(id, new Set([...(kinds.get(id) || []), p.kind])));
    }
    const groups = new Map();
    for (const id of parent.keys()) {
      const root = find(id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(id);
    }
    const allIds = [...parent.keys()];
    if (!allIds.length) return res.json([]);
    const [leads] = await db.query(
      `SELECT l.id, l.company, l.ceo, l.phone, l.email, l.website, l.location, l.status, l.created_at,
              u.full_name AS assigned_name,
              (SELECT COUNT(*) FROM call_logs c WHERE c.lead_id = l.id) AS calls,
              (SELECT COUNT(*) FROM deals d WHERE d.lead_id = l.id) AS deals
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.id IN (?)`, [allIds]);
    const byId = new Map(leads.map(l => [l.id, l]));
    res.json([...groups.values()].slice(0, 200).map(ids => {
      const k = new Set(); ids.forEach(id => (kinds.get(id) || []).forEach(x => k.add(x)));
      return { matched_on: [...k], leads: ids.sort((a, b) => a - b).map(id => byId.get(id)).filter(Boolean) };
    }));
  } catch (e) {
    console.error('Duplicates error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/leads/:id/merge — Dublette in diesen Lead übernehmen ──
// Verlauf, Anrufe, Wiedervorlagen, Mails und Deals wandern zum Ziel-Lead, leere
// Felder werden ergänzt, die Dublette wird archiviert. Was bewegt und ergänzt wurde,
// steht in lead_merges – damit lässt sich die Zusammenführung rückgängig machen.
// Admins dürfen immer; Closer, wenn beide Leads ihnen gehören oder frei sind.
const MERGE_TABELLEN = ['comments', 'reminders', 'call_logs', 'lead_emails', 'deals', 'chat_rooms'];
const darfZusammenfuehren = (u, l) => u.role === 'admin' || !l.assigned_to || l.assigned_to === u.id;
router.post('/:id/merge', auth, async (req, res) => {
  const targetId = parseInt(req.params.id);
  const fromId = parseInt(req.body.from_id);
  if (!fromId || fromId === targetId) return res.status(400).json({ error: 'Ungültige Dublette' });
  try {
    const [[a]] = await db.query('SELECT * FROM leads WHERE id=? AND archived_at IS NULL', [targetId]);
    const [[b]] = await db.query('SELECT * FROM leads WHERE id=? AND archived_at IS NULL', [fromId]);
    if (!a || !b) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (!darfZusammenfuehren(req.user, a) || !darfZusammenfuehren(req.user, b))
      return res.status(403).json({ error: 'Zusammenführen geht nur mit eigenen oder freien Leads. Frag sonst einen Admin.' });
    const moved = {};
    for (const t of MERGE_TABELLEN) {
      const [rows] = await db.query(`SELECT id FROM ${t} WHERE lead_id=?`, [fromId]).catch(() => [[]]);
      moved[t] = rows.map(r => r.id);
      if (moved[t].length) await db.query(`UPDATE ${t} SET lead_id=? WHERE id IN (?)`, [targetId, moved[t]]);
    }
    const fill = {}, vorher = {};
    for (const f of ['ceo', 'email', 'phone', 'location', 'website', 'linkedin_url', 'industry', 'employees', 'revenue']) {
      if (!a[f] && b[f]) fill[f] = b[f];
    }
    if (b.notes && b.notes !== a.notes) fill.notes = [a.notes, b.notes].filter(Boolean).join('\n\n');
    if (!a.assigned_to && b.assigned_to) fill.assigned_to = b.assigned_to;
    if (a.status === 'neu' && b.status !== 'neu') fill.status = b.status;
    Object.keys(fill).forEach(k => { vorher[k] = { alt: a[k] ?? null, neu: fill[k] }; });
    if (Object.keys(fill).length) {
      await db.query(`UPDATE leads SET ${Object.keys(fill).map(k => k + '=?').join(',')} WHERE id=?`,
        [...Object.values(fill), targetId]);
    }
    await db.query('UPDATE leads SET archived_at=NOW(), archived_by=?, archive_reason=? WHERE id=?',
      [req.user.id, `Dublette – zusammengeführt mit #${targetId} ${a.company || ''}`.slice(0, 500), fromId]);
    const [m] = await db.query('INSERT INTO lead_merges (target_id, from_id, moved, filled, merged_by) VALUES (?,?,?,?,?)',
      [targetId, fromId, JSON.stringify(moved), JSON.stringify(vorher), req.user.id]);
    await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
      [targetId, req.user.id, `🔗 Dublette zusammengeführt: ${b.company || '#' + fromId}`]);
    await refreshNorm(targetId);
    await log(req.user.id, 'lead_merge', 'lead', targetId, { from_id: fromId, company: b.company, merge_id: m.insertId }, req.ip);
    res.json({ ok: true, merge_id: m.insertId });
  } catch (e) {
    console.error('Merge error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/leads/merges/:id/undo — Zusammenführung rückgängig machen ──
router.post('/merges/:id/undo', auth, async (req, res) => {
  try {
    const [[m]] = await db.query('SELECT * FROM lead_merges WHERE id=?', [parseInt(req.params.id)]);
    if (!m || m.undone_at) return res.status(404).json({ error: 'Nichts rückgängig zu machen' });
    if (req.user.role !== 'admin' && m.merged_by !== req.user.id)
      return res.status(403).json({ error: 'Rückgängig machen kann nur, wer zusammengeführt hat, oder ein Admin.' });
    const moved = JSON.parse(m.moved || '{}'), vorher = JSON.parse(m.filled || '{}');
    // Nur, was noch am Ziel-Lead hängt, wandert zurück (später Angelegtes bleibt)
    for (const t of MERGE_TABELLEN) {
      const ids = moved[t] || [];
      if (ids.length) await db.query(`UPDATE ${t} SET lead_id=? WHERE id IN (?) AND lead_id=?`, [m.from_id, ids, m.target_id]).catch(() => {});
    }
    // Ergänzte Felder zurücksetzen, sofern sie seitdem niemand geändert hat
    const [[ziel]] = await db.query('SELECT * FROM leads WHERE id=?', [m.target_id]);
    const sets = [], p = [];
    for (const [k, v] of Object.entries(vorher)) {
      if (ziel && String(ziel[k] ?? '') === String(v.neu ?? '')) { sets.push(`${k}=?`); p.push(v.alt); }
    }
    if (sets.length) await db.query(`UPDATE leads SET ${sets.join(', ')} WHERE id=?`, [...p, m.target_id]);
    await db.query('UPDATE leads SET archived_at=NULL, archived_by=NULL, archive_reason=NULL WHERE id=?', [m.from_id]);
    await db.query('UPDATE lead_merges SET undone_at=NOW(), undone_by=? WHERE id=?', [req.user.id, m.id]);
    const [[from]] = await db.query('SELECT company FROM leads WHERE id=?', [m.from_id]);
    await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
      [m.target_id, req.user.id, `↩️ Zusammenführung mit ${from?.company || '#' + m.from_id} rückgängig gemacht`]);
    await refreshNorm(m.target_id); await refreshNorm(m.from_id);
    await log(req.user.id, 'lead_merge_undo', 'lead', m.target_id, { from_id: m.from_id, merge_id: m.id }, req.ip);
    res.json({ ok: true, from_id: m.from_id });
  } catch (e) {
    console.error('Merge undo error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/leads/queue — Anrufmodus: wen rufe ich als Nächstes an? ──────────
// Reihenfolge siehe helpers/queue.js. ?list=<id> nutzt die Filter einer Wählliste.
router.get('/queue', auth, async (req, res) => {
  try {
    let filters = null;
    if (req.query.list) {
      const list = await require('./calllists').loadVisible(req.user, parseInt(req.query.list));
      if (!list) return res.status(404).json({ error: 'Wählliste nicht gefunden' });
      filters = list.filters;
    }
    res.json(await buildQueue(req.user, filters));
  } catch (e) {
    console.error('Queue error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/leads/:id/outcome — Anrufergebnis in einem Schritt ─────────────
// Dokumentiert den Anruf, setzt den Status, schreibt die Notiz in den Verlauf,
// schließt fällige Wiedervorlagen und legt (optional) die nächste an.
const OUTCOMES = {
  nicht_erreicht: { call: 'no-answer',    status: 'nicht_erreicht', label: 'Nicht erreicht' },
  besetzt:        { call: 'busy',         status: 'nicht_erreicht', label: 'Besetzt' },
  mailbox:        { call: 'no-answer',    status: 'nicht_erreicht', label: 'Mailbox' },
  rueckruf:       { call: 'reached',      status: 'rueckruf',       label: 'Rückruf vereinbart' },
  interesse:      { call: 'reached',      status: 'kontaktiert',    label: 'Interesse, nachfassen' },
  termin:         { call: 'reached',      status: 'kontaktiert',    label: 'Termin vereinbart' },
  kein_interesse: { call: 'reached',      status: 'kein_interesse', label: 'Kein Interesse' },
  kunde:          { call: 'reached',      status: 'kunde',          label: 'Abschluss' },
  falsche_nummer: { call: 'wrong_number', status: null,             label: 'Falsche Nummer' },
};

router.post('/:id/outcome', auth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { outcome, note, call_log_id, duration_seconds, follow_up_at, follow_up_note, deal } = req.body;
  const dealValue = deal ? parseValue(deal.value) : undefined;
  if (Number.isNaN(dealValue)) return res.status(400).json({ error: 'Ungültiger Deal-Wert' });
  const o = OUTCOMES[outcome];
  if (!o) return res.status(400).json({ error: 'Ungültiges Ergebnis' });
  const noteClean = typeof note === 'string' ? note.trim().slice(0, 2000) : '';
  if (follow_up_at && Number.isNaN(new Date(follow_up_at).getTime()))
    return res.status(400).json({ error: 'Ungültiger Termin für die Wiedervorlage' });

  try {
    const [[lead]] = await db.query('SELECT id, status, phone, assigned_to FROM leads WHERE id=? AND archived_at IS NULL', [leadId]);
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (lead.status === 'keine_anrufe') return res.status(409).json({ error: 'Bei diesem Lead gilt „Keine Anrufe mehr“.' });
    // Freier Lead (z.B. aus einer Wählliste): wer ihn anruft, übernimmt ihn
    if (lead.assigned_to === null && sicht.darfSehen(req.user, lead)) {
      const [r] = await db.query('UPDATE leads SET assigned_to=? WHERE id=? AND assigned_to IS NULL', [req.user.id, leadId]);
      if (r.affectedRows) {
        lead.assigned_to = req.user.id;
        await log(req.user.id, 'lead_assign', 'lead', leadId, { assigned_to: req.user.id, via: 'anrufmodus' }, req.ip);
      } else {
        const [[cur]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [leadId]);
        lead.assigned_to = cur?.assigned_to ?? null;
      }
    }
    if (req.user.role !== 'admin' && lead.assigned_to !== req.user.id)
      return res.status(403).json({ error: 'Dieser Lead wurde inzwischen von einem Kollegen übernommen' });

    // 1) Anruf dokumentieren (bestehenden Eintrag aus "Anrufen" ergänzen oder neu anlegen)
    const dur = Number.isFinite(parseInt(duration_seconds)) && parseInt(duration_seconds) >= 0
      ? parseInt(duration_seconds) : null;
    let callId = parseInt(call_log_id) || null;
    if (callId) {
      const [r] = await db.query(
        `UPDATE call_logs SET status=?, outcome=?, ended_at=COALESCE(ended_at, NOW()),
                duration_seconds=COALESCE(?, duration_seconds), note=?
         WHERE id=? AND lead_id=? AND user_id=?`,
        [o.call, outcome, dur, noteClean.slice(0, 1000) || null, callId, leadId, req.user.id]
      );
      if (!r.affectedRows) callId = null;
    }
    if (!callId) {
      const [r] = await db.query(
        `INSERT INTO call_logs (lead_id, user_id, phone_number, direction, started_at, ended_at, duration_seconds, status, outcome, note)
         VALUES (?, ?, ?, 'outbound', NOW(), NOW(), ?, ?, ?, ?)`,
        [leadId, req.user.id, lead.phone, dur, o.call, outcome, noteClean.slice(0, 1000) || null]
      );
      callId = r.insertId;
    }

    // 2) Status
    if (o.status && o.status !== lead.status) {
      await db.query('UPDATE leads SET status=? WHERE id=?', [o.status, leadId]);
      await log(req.user.id, 'status_change', 'lead', leadId, { from: lead.status, to: o.status }, req.ip);
    } else {
      await db.query('UPDATE leads SET updated_at=NOW() WHERE id=?', [leadId]);
    }

    // 3) Verlauf
    await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
      [leadId, req.user.id, `📞 ${o.label}${noteClean ? ' – ' + noteClean : ''}`]);
    // Erreicht: raus aus der Wählliste „nie erreicht“
    if (o.call === 'reached') await db.query('UPDATE leads SET nie_erreicht=0 WHERE id=?', [leadId]);

    // 4) Fällige Wiedervorlagen schließen, nächste anlegen
    await db.query(
      'UPDATE reminders SET done_at=NOW() WHERE lead_id=? AND user_id=? AND done_at IS NULL AND remind_at <= NOW()',
      [leadId, req.user.id]
    );
    let reminderId = null;
    if (follow_up_at) {
      const [r] = await db.query(
        'INSERT INTO reminders (lead_id, user_id, remind_at, note) VALUES (?,?,?,?)',
        [leadId, req.user.id, follow_up_at, (follow_up_note || o.label).toString().slice(0, 500)]
      );
      reminderId = r.insertId;
    }
    // Termin im Gespräch vereinbart: steht direkt unter „Termine“ (mit Erinnerung vorher)
    let appointmentId = null;
    if (outcome === 'termin' && follow_up_at) {
      const [r] = await db.query(
        `INSERT INTO appointments (lead_id, closer_id, proposed_by, starts_at, topic, notes, status, responded_at)
         VALUES (?,?,?,?,?,?, 'angenommen', NOW())`,
        [leadId, lead.assigned_to || req.user.id, req.user.id, follow_up_at,
         (follow_up_note && follow_up_note !== 'Termin' ? follow_up_note : 'Termin aus dem Telefonat').toString().slice(0, 200),
         noteClean || null]);
      appointmentId = r.insertId;
      await db.query("UPDATE reminders SET kind='termin', sent=1, appointment_id=? WHERE id=?", [appointmentId, reminderId]);
    }

    // 5) Deal: bei Interesse/Rückruf anlegen bzw. Wert aktualisieren, bei Abschluss
    //    gewinnen, bei "Kein Interesse" offene Deals als verloren schließen
    let dealId = null;
    const [[openDeal]] = await db.query(
      "SELECT * FROM deals WHERE lead_id=? AND status='open' ORDER BY id DESC LIMIT 1", [leadId]);
    if (outcome === 'kunde') {
      if (openDeal) { await markWon(openDeal, req.user.id, dealValue); dealId = openDeal.id; }
      else dealId = await createDeal({ leadId, userId: req.user.id, value: dealValue || 0,
                                       ownerId: lead.assigned_to || req.user.id, status: 'won' });
    } else if (outcome === 'kein_interesse' && openDeal) {
      await markLost(openDeal, req.user.id, 'Kein Bedarf');
      dealId = openDeal.id;
    } else if (deal && ['interesse', 'rueckruf', 'termin'].includes(outcome)) {
      if (openDeal) {
        if (dealValue !== undefined) await db.query('UPDATE deals SET value=? WHERE id=?', [dealValue, openDeal.id]);
        dealId = openDeal.id;
      } else if (deal.create) {
        dealId = await createDeal({ leadId, userId: req.user.id, title: deal.title, value: dealValue || 0,
                                   ownerId: lead.assigned_to || req.user.id });
      }
    }

    await log(req.user.id, 'call_logged', 'lead', leadId,
      { outcome, call_id: callId, follow_up_at: follow_up_at || null, deal_id: dealId }, req.ip);
    res.json({ ok: true, call_id: callId, status: o.status || lead.status, reminder_id: reminderId, deal_id: dealId, appointment_id: appointmentId });
  } catch (e) {
    console.error('Outcome error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/leads/activity-feed — letzte Aktivitäten (Admin, Feature 7) ──
router.get('/activity-feed', auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT a.id, a.action, a.target_type AS entity_type, a.target_id AS entity_id,
              a.detail AS details, a.created_at, u.full_name, l.company
       FROM activity_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN leads l ON l.id = a.target_id AND a.target_type = 'lead'
       ORDER BY a.created_at DESC, a.id DESC LIMIT 40`
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── POST /api/leads/import — CSV-Import (Admin, Feature 8) ──────────────────
const multerMem = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 5*1024*1024 } });
router.post('/import', auth, adminOnly, multerMem.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  const assignTo = parseInt(req.body.assigned_to ?? req.body.assign_to) || null;
  try {
    const text = req.file.buffer.toString('utf-8').replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const delim = firstLine.includes(';') ? ';' : ',';
    const rows = parseCsv(text, delim).filter(r => r.some(c => c.trim()));
    if (!rows.length) return res.status(400).json({ error: 'Leere CSV' });
    const headers = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z]/g,''));
    const idx = (names) => { for (const n of names) { const i = headers.indexOf(n); if (i>=0) return i; } return -1; };
    const iComp = idx(['firmenname','company','name','unternehmen']);
    const iIndu = idx(['branche','industry','kategorie']);
    const iLoc  = idx(['ort','location','standort','stadt']);
    const iPhone = idx(['telefonnummer','phone','telefon','tel']);
    const iMail = idx(['email','e-mail','mail']);
    const iWeb  = idx(['website','web','url','homepage']);
    if (iComp < 0) return res.status(400).json({ error: 'Spalte "Firmenname" nicht gefunden' });
    let imported = 0, skipped = 0, duplicates = 0;
    const seen = new Set();  // Dubletten innerhalb der Datei
    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i].map(c => c.trim());
      const company = iComp >= 0 ? cols[iComp] : '';
      if (!company) { skipped++; continue; }
      const phone = iPhone >= 0 ? cols[iPhone] : null;
      const email = iMail >= 0 ? cols[iMail] : null;
      const website = iWeb >= 0 ? cols[iWeb] : null;
      const n = normFields({ phone, email, website });
      const keys = [n.phone_norm && 'p:' + n.phone_norm, n.email_norm && 'e:' + n.email_norm, n.domain_norm && 'd:' + n.domain_norm].filter(Boolean);
      if (keys.some(k => seen.has(k)) || (await findDuplicates({ phone, email, website }, 0, 1)).length) {
        duplicates++; continue;
      }
      keys.forEach(k => seen.add(k));
      const id = await db.query(
        `INSERT INTO leads (company, industry, location, phone, email, website, status, assigned_to, created_by, source)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [company, iIndu>=0?cols[iIndu]||null:null, iLoc>=0?cols[iLoc]||null:null,
         phone||null, email||null, iWeb>=0?cols[iWeb]||null:null,
         'neu', assignTo, req.user.id, 'csv-import']
      ).then(([r]) => r.insertId, () => null);
      if (id) { await refreshNorm(id); imported++; } else skipped++;
    }
    await log(req.user.id, 'leads_csv_import', 'lead', null, { imported, skipped, duplicates }, req.ip);
    res.json({ ok: true, imported, skipped: skipped + duplicates, duplicates });
  } catch(e) { console.error('CSV import error:', e); res.status(500).json({ error: 'Importfehler: ' + e.message }); }
});

// ── POST /api/leads/bulk — mehrere Leads auf einmal speichern (Admin oder can_generate_leads) ──
router.post('/bulk', auth, async (req, res) => {
  if (req.user.role !== 'admin' && !req.user.can_generate_leads)
    return res.status(403).json({ error: 'Keine Berechtigung' });
  const { leads } = req.body;
  // Selbst generierte Leads gehören dem Vertriebler, der sie generiert hat
  const assigned_to = req.user.role === 'admin' ? (parseInt(req.body.assigned_to) || null) : req.user.id;
  if (!Array.isArray(leads) || !leads.length)
    return res.status(400).json({ error: 'Keine Leads übergeben' });

  try {
    const inserted = [];
    const skippedDuplicates = [];
    for (const l of leads) {
      if ((await findDuplicates(l, 0, 1)).length) { skippedDuplicates.push(l.company); continue; }
      const [r] = await db.query(
        `INSERT INTO leads
          (company, ceo, email, phone, location, website, linkedin_url,
           industry, employees, revenue, source, confidence, notes,
           status, assigned_to, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [l.company||null, l.ceo||null, l.email||null, l.phone||null,
         l.location||null, l.website||null, l.linkedin_url||null,
         l.industry||null, l.employees||null, l.revenue||null,
         l.source||'web', l.confidence||50, l.notes||null,
         'neu', assigned_to||null, req.user.id]
      );
      await refreshNorm(r.insertId);
      inserted.push(r.insertId);
    }
    await log(req.user.id, 'leads_bulk_create', 'lead', null,
      { count: inserted.length, assigned_to, duplicates: skippedDuplicates.length }, req.ip);
    res.status(201).json({ ok: true, ids: inserted, skipped_duplicates: skippedDuplicates });
  } catch(e) {
    console.error('Bulk insert error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/leads/reminders — eigene offene Reminder ────────
router.get('/reminders', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT r.id, r.note, r.remind_at, r.lead_id, l.company, l.status, l.phone
       FROM reminders r JOIN leads l ON l.id = r.lead_id
       WHERE r.user_id = ? AND r.done_at IS NULL AND l.archived_at IS NULL
       ORDER BY r.remind_at ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch(e) { console.error('Reminders error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── GET /api/leads/archived — archivierte Leads (Admin) ─────
router.get('/archived', auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT l.id, l.company, l.ceo, l.phone, l.email, l.location, l.status,
              l.archived_at, l.archive_reason,
              u1.full_name AS assigned_name,
              u2.full_name AS archived_by_name
       FROM leads l
       LEFT JOIN users u1 ON u1.id = l.assigned_to
       LEFT JOIN users u2 ON u2.id = l.archived_by
       WHERE l.archived_at IS NOT NULL
       ORDER BY l.archived_at DESC
       LIMIT 500`
    );
    res.json(rows);
  } catch(e) {
    console.error('Archived leads error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/leads/:id/restore — Lead wiederherstellen (Admin) ──
router.post('/:id/restore', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [[lead]] = await db.query('SELECT id FROM leads WHERE id=? AND archived_at IS NOT NULL', [id]);
    if (!lead) return res.status(404).json({ error: 'Archivierter Lead nicht gefunden' });
    await db.query('UPDATE leads SET archived_at=NULL, archived_by=NULL, archive_reason=NULL WHERE id=?', [id]);
    await log(req.user.id, 'lead_restore', 'lead', id, {}, req.ip);
    res.json({ ok: true });
  } catch(e) {
    console.error('Lead restore error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── DELETE /api/leads/:id/permanent — endgültig löschen (Admin) ─
router.delete('/:id/permanent', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [[lead]] = await db.query('SELECT id FROM leads WHERE id=? AND archived_at IS NOT NULL', [id]);
    if (!lead) return res.status(404).json({ error: 'Nur archivierte Leads können endgültig gelöscht werden' });
    await db.query('DELETE FROM reminders WHERE lead_id=?', [id]);
    await db.query('DELETE FROM comments  WHERE lead_id=?', [id]);
    await db.query('DELETE FROM call_logs WHERE lead_id=?', [id]).catch(() => {});
    await db.query('DELETE FROM leads     WHERE id=?', [id]);
    await log(req.user.id, 'lead_delete_permanent', 'lead', id, {}, req.ip);
    res.json({ ok: true });
  } catch(e) {
    console.error('Lead permanent delete error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/leads/:id ──────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const [[lead]] = await db.query(
    `SELECT l.*, u1.full_name AS assigned_name, u2.full_name AS created_name
     FROM leads l
     LEFT JOIN users u1 ON u1.id = l.assigned_to
     LEFT JOIN users u2 ON u2.id = l.created_by
     WHERE l.id = ? AND l.archived_at IS NULL`, [id]
  );
  if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!canView(req.user, lead)) return res.status(403).json({ error: 'Dieser Lead wird von einem Kollegen betreut.' });

  const [comments] = await db.query(
    `SELECT c.*, u.full_name, u.username FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.lead_id = ? ORDER BY c.created_at ASC`, [id]
  );
  const [reminders] = await db.query(
    `SELECT r.*, u.full_name FROM reminders r
     JOIN users u ON u.id = r.user_id
     WHERE r.lead_id = ? AND r.done_at IS NULL ORDER BY r.remind_at ASC`, [id]
  );
  const [call_logs] = await db.query(
    `SELECT cl.*, u.full_name FROM call_logs cl
     JOIN users u ON u.id = cl.user_id
     WHERE cl.lead_id = ? ORDER BY cl.started_at DESC`, [id]
  ).catch(() => [[]]);
  // Kundenmails sieht nur, wer den Lead betreut (und der Admin)
  const seesMail = req.user.role === 'admin' || lead.assigned_to === req.user.id;
  const [email_thread] = !seesMail ? [[]] : await db.query(
    `SELECT id, direction, from_address, from_name, to_address, subject, body_text, received_at, created_at, is_read
     FROM lead_emails WHERE lead_id = ? ORDER BY COALESCE(received_at, created_at) ASC`, [id]
  ).catch(() => [[]]);
  const [deals] = await db.query(
    `SELECT d.id, d.title, d.value, d.status, d.stage_id, d.owner_id,
            DATE_FORMAT(d.expected_close_date, '%Y-%m-%d') AS expected_close_date,
            d.won_at, d.lost_at, d.lost_reason, s.name AS stage_name, u.full_name AS owner_name
     FROM deals d
     LEFT JOIN deal_stages s ON s.id = d.stage_id
     LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.lead_id = ? ORDER BY d.status = 'open' DESC, d.created_at DESC`, [id]
  ).catch(() => [[]]);
  const duplicates = await findDuplicates(lead, lead.id).catch(() => []);
  const [merges] = await db.query(
    `SELECT m.id, m.from_id, m.merged_by, m.created_at, l.company AS from_company, u.full_name AS merged_by_name
     FROM lead_merges m LEFT JOIN leads l ON l.id = m.from_id LEFT JOIN users u ON u.id = m.merged_by
     WHERE m.target_id = ? AND m.undone_at IS NULL ORDER BY m.id DESC`, [id]).catch(() => [[]]);
  res.json({ ...lead, comments, reminders, call_logs, email_thread, deals, duplicates, merges });
});

// ── PATCH /api/leads/:id/status ──────────────────────────────
router.patch('/:id/status', auth, async (req, res) => {
  const id     = parseInt(req.params.id);
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status))
      return res.status(400).json({ error: 'Ungültiger Status' });

    const [[lead]] = await db.query('SELECT * FROM leads WHERE id = ?', [id]);
    if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!canView(req.user, lead))
      return res.status(403).json({ error: 'Kein Zugriff' });
    if (lead.status === status) return res.json({ ok: true });
    // „Keine Anrufe mehr“ kann nur der Admin wieder aufheben
    if (lead.status === 'keine_anrufe' && req.user.role !== 'admin')
      return res.status(403).json({ error: '„Keine Anrufe mehr“ kann nur Aleksandra wieder aufheben.' });
    // „Passt nicht“ nur mit Grund
    let grund = null;
    if (status === 'passt_nicht') {
      const g = grundPruefen(req.body.grund, req.body.grund_text);
      if (g.fehler) return res.status(400).json({ error: g.fehler, grund_noetig: true });
      grund = g.voll;
    }

    await db.query('UPDATE leads SET status = ?, status_grund = ? WHERE id = ?', [status, grund, id]);
    if (status === 'passt_nicht' || status === 'keine_anrufe') {
      await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
        [id, req.user.id, status === 'passt_nicht' ? `🚫 Passt nicht – ${grund}` : '⛔ Keine Anrufe mehr – aus allen Wähllisten genommen']);
      // Offene Wiedervorlagen erledigen, damit der Lead nirgends mehr auftaucht
      await db.query("UPDATE reminders SET done_at=NOW() WHERE lead_id=? AND done_at IS NULL", [id]);
    }
    await log(req.user.id, 'status_change', 'lead', id,
      { from: lead.status, to: status }, req.ip);
    res.json({ ok: true });
  } catch (e) { console.error('Status ändern:', e); res.status(500).json({ error: 'Status konnte nicht gespeichert werden.' }); }
});

// ── PATCH /api/leads/:id — Update ──────────────────────────
router.patch('/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const isAdmin = req.user.role === 'admin';
  const canEditContacts = req.user.can_edit_contacts;
  const canReassign = req.user.can_reassign_leads;

  if (!isAdmin && !canEditContacts && !canReassign)
    return res.status(403).json({ error: 'Kein Zugriff' });

  const [[lead]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [id]);
  if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!isAdmin && !canView(req.user, lead))
    return res.status(403).json({ error: 'Kein Zugriff' });

  const allowed = isAdmin
    ? ['company','ceo','email','phone','location','website','linkedin_url','industry','employees','revenue','notes','assigned_to','confidence']
    : [
        ...(canEditContacts ? ['email','phone'] : []),
        ...(canReassign     ? ['assigned_to']   : []),
      ];

  const updates = [];
  const params  = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { updates.push(`${k}=?`); params.push(req.body[k]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nichts zu aktualisieren' });
  params.push(id);
  await db.query(`UPDATE leads SET ${updates.join(',')} WHERE id=?`, params);
  if (allowed.includes('assigned_to') && req.body.assigned_to !== undefined)
    await sicht.uebergeben(id, lead.assigned_to, parseInt(req.body.assigned_to) || null);
  if (['phone', 'email', 'website'].some(k => req.body[k] !== undefined)) await refreshNorm(id);
  await log(req.user.id, 'lead_update', 'lead', id, req.body, req.ip);
  res.json({ ok: true });
});

// ── DELETE /api/leads/:id — Soft-Archivierung (kein physisches Löschen) ─────
router.delete('/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && !req.user.can_archive_leads)
    return res.status(403).json({ error: 'Keine Berechtigung' });

  const id = parseInt(req.params.id);
  const reason = req.body?.reason || null;
  try {
    const [[lead]] = await db.query('SELECT id FROM leads WHERE id = ? AND archived_at IS NULL', [id]);
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    await db.query(
      'UPDATE leads SET archived_at = NOW(), archived_by = ?, archive_reason = ? WHERE id = ?',
      [req.user.id, reason, id]
    );
    await log(req.user.id, 'lead_archive', 'lead', id, { reason }, req.ip);
    res.json({ ok: true });
  } catch(e) {
    console.error('Lead archive error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/leads/:id/comments ────────────────────────────
router.post('/:id/comments', auth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text fehlt' });

  const [[lead]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [leadId]);
  if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
  if (!canView(req.user, lead))
    return res.status(403).json({ error: 'Kein Zugriff' });

  const [r] = await db.query(
    'INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
    [leadId, req.user.id, text.trim()]
  );
  await log(req.user.id, 'comment_add', 'lead', leadId, { text: text.trim() }, req.ip);
  res.status(201).json({ ok: true, id: r.insertId });
});

// ── PATCH /api/leads/:id/comments/:cid — Kommentar bearbeiten ──
router.patch('/:id/comments/:cid', auth, async (req, res) => {
  const cid = parseInt(req.params.cid);
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text fehlt' });
  try {
    const [[c]] = await db.query('SELECT * FROM comments WHERE id=?', [cid]);
    if (!c) return res.status(404).json({ error: 'Kommentar nicht gefunden' });
    if (req.user.role !== 'admin' && c.user_id !== req.user.id)
      return res.status(403).json({ error: 'Nur eigene Kommentare bearbeitbar' });
    await db.query('UPDATE comments SET text=?, edited_at=NOW() WHERE id=?', [text.trim(), cid]);
    await log(req.user.id, 'comment_edit', 'lead', parseInt(req.params.id), { cid }, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('Comment edit error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── DELETE /api/leads/:id/comments/:cid — Kommentar löschen ──
router.delete('/:id/comments/:cid', auth, async (req, res) => {
  const cid = parseInt(req.params.cid);
  try {
    const [[c]] = await db.query('SELECT * FROM comments WHERE id=?', [cid]);
    if (!c) return res.status(404).json({ error: 'Kommentar nicht gefunden' });
    if (req.user.role !== 'admin' && c.user_id !== req.user.id)
      return res.status(403).json({ error: 'Nur eigene Kommentare löschbar' });
    await db.query('DELETE FROM comments WHERE id=?', [cid]);
    await log(req.user.id, 'comment_delete', 'lead', parseInt(req.params.id), { cid }, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('Comment delete error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── POST /api/leads/:id/reminders ───────────────────────────
router.post('/:id/reminders', auth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { remind_at, note } = req.body;
  if (!remind_at) return res.status(400).json({ error: 'remind_at fehlt' });

  const [[lead]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [leadId]);
  if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
  if (!canView(req.user, lead))
    return res.status(403).json({ error: 'Kein Zugriff' });

  const [r] = await db.query(
    'INSERT INTO reminders (lead_id, user_id, remind_at, note) VALUES (?,?,?,?)',
    [leadId, req.user.id, remind_at, note || null]
  );
  await log(req.user.id, 'reminder_set', 'lead', leadId, { remind_at, note }, req.ip);
  res.status(201).json({ ok: true, id: r.insertId });
});

// ── DELETE /api/leads/:id/reminders/:rid — Reminder erledigt ─
router.delete('/:id/reminders/:rid', auth, async (req, res) => {
  await db.query(
    'UPDATE reminders SET done_at=NOW() WHERE id=? AND user_id=? AND done_at IS NULL',
    [parseInt(req.params.rid), req.user.id]
  );
  res.json({ ok: true });
});

// ── PATCH /api/leads/:id/assign — Closer übernimmt Lead ─────
router.patch('/:id/assign', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [[lead]] = await db.query('SELECT id, assigned_to FROM leads WHERE id=?', [id]);
    if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });

    let neu = req.user.id;
    if (req.user.role !== 'admin') {
      if (!sicht.darfSehen(req.user, lead)) return res.status(403).json({ error: 'Freie Leads sind gerade nicht freigegeben.' });
      const [result] = await db.query(
        'UPDATE leads SET assigned_to=? WHERE id=? AND assigned_to IS NULL',
        [req.user.id, id]
      );
      if (result.affectedRows === 0)
        return res.status(409).json({ error: 'Dieser Lead wurde bereits übernommen.' });
    } else {
      // Admin: an die gewünschte Person (z. B. per Ziehen auf einen Vertriebler), sonst an sich selbst
      if (req.body.assigned_to !== undefined) neu = parseInt(req.body.assigned_to) || null;
      await db.query('UPDATE leads SET assigned_to=? WHERE id=?', [neu, id]);
      await sicht.uebergeben(id, lead.assigned_to, neu);
    }
    await log(req.user.id, 'lead_assign', 'lead', id, { assigned_to: neu }, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('Lead assign error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── POST /api/leads/:id/email — E-Mail an Lead senden ────────
router.post('/:id/email', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { to, subject, body } = req.body;
  if (!to || !subject || !body)
    return res.status(400).json({ error: 'to, subject und body sind erforderlich' });
  try {
    const [[lead]] = await db.query('SELECT * FROM leads WHERE id=?', [id]);
    if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!canView(req.user, lead))
      return res.status(403).json({ error: 'E-Mail nur bei eigenen oder unzugewiesenen Leads erlaubt' });

    const [[user]] = await db.query('SELECT full_name, role FROM users WHERE id=?', [req.user.id]);
    const telefon = await require('./sipgate').nummerFuer(req.user.id).catch(() => null);

    // Letzte eingegangene Nachricht dieses Leads suchen — daran hängt die Antwort,
    // damit der Kunde sie in seinem Mailprogramm im selben Thread sieht.
    const [[lastInbound]] = await db.query(
      `SELECT message_id FROM lead_emails
       WHERE lead_id=? AND direction='inbound' AND message_id IS NOT NULL AND message_id<>''
       ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1`, [id]
    ).catch(() => [[null]]);
    const [priorIds] = await db.query(
      `SELECT message_id FROM lead_emails
       WHERE lead_id=? AND message_id IS NOT NULL AND message_id<>''
       ORDER BY COALESCE(received_at, created_at) ASC LIMIT 20`, [id]
    ).catch(() => [[]]);

    // Adresse am Telefon erfragt: beim Lead nachtragen, wenn dort noch keine steht
    if (!lead.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to).trim())) {
      await db.query('UPDATE leads SET email=? WHERE id=? AND (email IS NULL OR email=\'\')', [String(to).trim(), id]);
      await refreshNorm(id).catch(() => {});
    }

    const realMessageId = await sendLeadEmail({
      to, subject, body, leadId: id, senderName: user?.full_name, telefon,
      rolle: user?.role === 'admin' ? 'Founder | AI & Automation Consultant' : 'Vertrieb',
      inReplyTo:  lastInbound?.message_id || undefined,
      references: (priorIds || []).map(r => r.message_id),
    });

    await db.query(
      'INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
      [id, req.user.id, `📧 E-Mail gesendet: ${subject}`]
    );
    // Gesendete E-Mail mit echter Message-ID speichern — wird für Antwort-Zuordnung benötigt
    await db.query(
      `INSERT IGNORE INTO lead_emails (lead_id, direction, from_address, from_name, to_address, subject, body_text, message_id, received_at, is_read, user_id)
       VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, NOW(), 1, ?)`,
      [id, process.env.SMTP_USER || 'info@novaflowservices.de', user?.full_name || null, to, subject,
       body.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '')
         .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
         .replace(/\n{3,}/g, '\n\n').trim().slice(0, 60000),
       realMessageId, req.user.id]
    ).catch(e => console.error('lead_emails insert error:', e.message));
    // Wer antwortet, hat die Kundenmail gelesen
    await db.query(
      "UPDATE lead_emails SET is_read=1 WHERE lead_id=? AND direction='inbound' AND is_read=0", [id]
    ).catch(() => {});
    await log(req.user.id, 'lead_email_sent', 'lead', id, { to, subject }, req.ip);
    res.json({ ok: true });
  } catch(e) {
    console.error('Email send error:', e);
    res.status(500).json({ error: 'E-Mail konnte nicht gesendet werden.' });
  }
});

// ── POST /api/leads/:id/nie-erreicht — in die Wählliste „nie erreicht“ verschieben ──
// Die Liste legt das CRM beim ersten Mal selbst an. Bis der Lead erreicht wird,
// taucht er nur noch dort auf, nicht mehr im normalen Anrufmodus.
router.post('/:id/nie-erreicht', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [[lead]] = await db.query('SELECT id, assigned_to FROM leads WHERE id=? AND archived_at IS NULL', [id]);
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (!canView(req.user, lead)) return res.status(403).json({ error: 'Kein Zugriff' });
    await db.query('UPDATE leads SET nie_erreicht=1 WHERE id=?', [id]);
    await db.query("UPDATE reminders SET done_at=NOW() WHERE lead_id=? AND done_at IS NULL AND remind_at > NOW()", [id]);
    const [[liste]] = await db.query("SELECT id FROM call_lists WHERE user_id=? AND filters LIKE '%\"nie_erreicht\":true%' LIMIT 1", [req.user.id]);
    let listId = liste?.id;
    if (!listId) {
      const { cleanFilters } = require('../helpers/queue');
      const [r] = await db.query('INSERT INTO call_lists (user_id, name, filters, shared) VALUES (?,?,?,0)',
        [req.user.id, 'Nie erreicht', JSON.stringify(cleanFilters({ nie_erreicht: true, ignore_followups: true }))]);
      listId = r.insertId;
    }
    await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)', [id, req.user.id, '📋 In Wählliste „nie erreicht“ verschoben']);
    await log(req.user.id, 'lead_nie_erreicht', 'lead', id, { list_id: listId }, req.ip);
    res.json({ ok: true, list_id: listId });
  } catch (e) { console.error('nie-erreicht:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── POST /api/leads/:id/calls/start — Anruf starten ─
router.post('/:id/calls/start', auth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  try {
    const [[lead]] = await db.query(
      'SELECT id, phone, assigned_to, status FROM leads WHERE id=?', [leadId]
    );
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (!lead.phone) return res.status(400).json({ error: 'Keine Telefonnummer gespeichert' });
    if (lead.status === 'keine_anrufe') return res.status(409).json({ error: 'Bei diesem Lead gilt „Keine Anrufe mehr“ – Anrufen ist gesperrt.' });
    if (!canView(req.user, lead))
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Lead' });

    const [r] = await db.query(
      `INSERT INTO call_logs (lead_id, user_id, phone_number, direction, started_at, status)
       VALUES (?, ?, ?, 'outbound', NOW(), 'started')`,
      [leadId, req.user.id, lead.phone]
    );
    await log(req.user.id, 'call_started', 'lead', leadId, { phone: lead.phone }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch(e) {
    console.error('call start error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

module.exports = router;
