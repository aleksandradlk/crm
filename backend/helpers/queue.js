// ── Anruf-Warteschlange (Anrufmodus, Heute-Liste, Wähllisten) ──────────────
// Standard-Reihenfolge:
//   1. fällige / überfällige Wiedervorlagen (älteste zuerst)
//   2. Rückruf ohne Termin
//   3. neue Leads (noch nie angerufen)
//   4. nicht erreicht / kontaktiert, die heute noch nicht angerufen wurden
// Leads mit einer Wiedervorlage in der Zukunft tauchen erst zum Termin wieder auf.
// Eine Wählliste (gespeicherter Filter) schränkt die Leads zusätzlich ein.
const db = require('../db');
const { siehtAlles, freieLeadsSichtbar } = require('./sichtbarkeit');

const STATUSES = ['neu', 'kontaktiert', 'nicht_erreicht', 'kein_interesse', 'rueckruf', 'kunde'];
// Nie im Anrufmodus: „Keine Anrufe mehr“ (gesperrt) und „passt nicht“
const GESPERRT = "l.status NOT IN ('keine_anrufe','passt_nicht')";

// Filter aus Benutzereingaben auf erlaubte Werte reduzieren
function cleanFilters(f = {}) {
  const int = (v, max) => { const n = parseInt(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : null; };
  const str = v => String(v || '').trim().slice(0, 100) || null;
  return {
    statuses: Array.isArray(f.statuses) ? f.statuses.filter(s => STATUSES.includes(s)) : [],
    industry: str(f.industry),
    location: str(f.location),
    source: str(f.source),
    never_reached: !!f.never_reached,
    min_days_since_call: int(f.min_days_since_call, 3650),
    max_calls: int(f.max_calls, 1000),
    created_within_days: int(f.created_within_days, 3650),
    has_open_deal: ['yes', 'no'].includes(f.has_open_deal) ? f.has_open_deal : '',
    include_unassigned: !!f.include_unassigned,
    ignore_followups: !!f.ignore_followups,
    nie_erreicht: !!f.nie_erreicht,
  };
}

async function buildQueue(user, rawFilters) {
  const uid = user.id;
  const f = rawFilters ? cleanFilters(rawFilters) : null;
  const where = ['l.archived_at IS NULL', GESPERRT];
  const params = [uid, uid];

  if (f && f.include_unassigned && (siehtAlles(user) || freieLeadsSichtbar())) { where.push('(l.assigned_to = ? OR l.assigned_to IS NULL)'); params.push(uid); }
  else { where.push('l.assigned_to = ?'); params.push(uid); }

  if (f && f.statuses.length) { where.push(`l.status IN (${f.statuses.map(() => '?').join(',')})`); params.push(...f.statuses); }
  else where.push("l.status NOT IN ('kunde','kein_interesse')");
  // Wählliste „nie erreicht“: nur die dorthin verschobenen Leads – sonst sind sie raus
  where.push(f && f.nie_erreicht ? 'l.nie_erreicht = 1' : 'COALESCE(l.nie_erreicht, 0) = 0');

  if (f) {
    const like = v => `%${v.replace(/[%_]/g, '\\$&')}%`;
    if (f.industry) { where.push('l.industry LIKE ?'); params.push(like(f.industry)); }
    if (f.location) { where.push('l.location LIKE ?'); params.push(like(f.location)); }
    if (f.source)   { where.push('l.source LIKE ?');   params.push(like(f.source)); }
    if (f.never_reached) where.push("NOT EXISTS (SELECT 1 FROM call_logs c WHERE c.lead_id = l.id AND c.status IN ('reached','completed'))");
    if (f.min_days_since_call !== null) { where.push('(lc.last_call_at IS NULL OR lc.last_call_at < NOW() - INTERVAL ? DAY)'); params.push(f.min_days_since_call); }
    if (f.max_calls !== null) { where.push('COALESCE(lc.call_count, 0) <= ?'); params.push(f.max_calls); }
    if (f.created_within_days !== null) { where.push('l.created_at >= NOW() - INTERVAL ? DAY'); params.push(f.created_within_days); }
    if (f.has_open_deal === 'yes') where.push('od.id IS NOT NULL');
    if (f.has_open_deal === 'no') where.push('od.id IS NULL');
  }

  const [rows] = await db.query(
    `SELECT l.id, l.company, l.ceo, l.phone, l.email, l.location, l.status, l.created_at,
            l.website, l.instagram_url, l.industry, l.assigned_to,
            r.id AS reminder_id, r.remind_at, r.note AS reminder_note,
            lc.last_call_at, lc.call_count, COALESCE(lc.gespraeche, 0) AS gespraeche, lc.versuch_zeiten,
            od.id AS deal_id, od.title AS deal_title, od.value AS deal_value, ds.name AS deal_stage,
            (SELECT MIN(r2.remind_at) FROM reminders r2
              WHERE r2.lead_id = l.id AND r2.user_id = ? AND r2.done_at IS NULL) AS next_reminder_at
     FROM leads l
     LEFT JOIN (
       SELECT lead_id, MIN(id) AS id FROM reminders
       WHERE user_id = ? AND done_at IS NULL AND remind_at <= NOW()
       GROUP BY lead_id
     ) rd ON rd.lead_id = l.id
     LEFT JOIN reminders r ON r.id = rd.id
     LEFT JOIN (
       SELECT lead_id, MAX(started_at) AS last_call_at, COUNT(*) AS call_count,
              SUM(status IN ('reached','completed') OR outcome IN ('rueckruf','interesse','termin','kein_interesse','kunde')) AS gespraeche,
              GROUP_CONCAT(DATE_FORMAT(started_at, '%H:%i') ORDER BY started_at SEPARATOR ',') AS versuch_zeiten
       FROM call_logs WHERE direction IS NULL OR direction <> 'inbound' GROUP BY lead_id
     ) lc ON lc.lead_id = l.id
     LEFT JOIN (
       SELECT lead_id, MAX(id) AS id FROM deals WHERE status = 'open' GROUP BY lead_id
     ) odm ON odm.lead_id = l.id
     LEFT JOIN deals od ON od.id = odm.id
     LEFT JOIN deal_stages ds ON ds.id = od.stage_id
     WHERE ${where.join(' AND ')}`,
    params
  );

  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const STATUS_RANK = { rueckruf: 1, neu: 2, nicht_erreicht: 3, kontaktiert: 4 };
  const queue = [];
  for (const l of rows) {
    if (l.reminder_id) {
      queue.push({ ...l, rank: 0, sortKey: new Date(l.remind_at).getTime(), reason: 'Wiedervorlage' });
      continue;
    }
    if (l.next_reminder_at && !(f && f.ignore_followups)) continue;  // Termin in der Zukunft
    if (l.last_call_at && new Date(l.last_call_at) >= startOfToday) continue;  // heute schon angerufen
    const rank = STATUS_RANK[l.status] || 5;
    const reason = { 1: 'Rückruf ohne Termin', 2: 'Neu', 3: 'Erneut versuchen', 4: 'Nachfassen' }[rank] || '';
    // Neue Leads: älteste zuerst. Wiederholungen: am längsten nicht angerufen zuerst.
    const sortKey = new Date(l.last_call_at || l.created_at || 0).getTime() || l.id;
    queue.push({ ...l, rank, sortKey, reason: l.assigned_to ? reason : 'Freier Lead' });
  }
  queue.sort((a, b) => a.rank - b.rank || a.sortKey - b.sortKey || a.id - b.id);
  const withPhone = queue.filter(l => l.phone);
  return {
    total: queue.length,
    without_phone: queue.length - withPhone.length,
    due_followups: queue.filter(l => l.rank === 0).length,
    leads: withPhone.slice(0, 300).map(({ rank, sortKey, ...l }) => l),
  };
}

module.exports = { buildQueue, cleanFilters };
