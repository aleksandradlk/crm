// ── Dubletten-Erkennung ──────────────────────────────────────
// Leads gelten als mögliche Dublette, wenn Telefonnummer (normalisiert),
// E-Mail-Adresse oder Website-Domain übereinstimmen. Die normalisierten Werte
// stehen in leads.phone_norm / email_norm / domain_norm (mit Index).
const db = require('../db');
const { toE164 } = require('./phone');

// Domains von Freemail-Anbietern sagen nichts über die Firma aus
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'web.de', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 't-online.de',
  'outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'live.com', 'live.de', 'msn.com',
  'yahoo.com', 'yahoo.de', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aol.de', 'freenet.de',
  'posteo.de', 'mail.de', 'online.de', 'arcor.de', 'vodafone.de', 'email.de', 'mailbox.org', 'proton.me', 'protonmail.com',
]);

function normPhone(phone) {
  return toE164(phone) || null;
}
function normEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e.slice(0, 150) : null;
}
function hostOf(url) {
  let s = String(url || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\d?\./, '').split(/[/?#:]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s.slice(0, 150) : null;
}
function normDomain(website, email) {
  const fromWeb = hostOf(website);
  if (fromWeb && !FREEMAIL.has(fromWeb)) return fromWeb;
  const e = normEmail(email);
  const d = e ? e.split('@')[1] : null;
  return d && !FREEMAIL.has(d) ? d : null;
}
function normFields({ phone, email, website }) {
  return { phone_norm: normPhone(phone), email_norm: normEmail(email), domain_norm: normDomain(website, email) };
}

// Normalisierte Felder eines Leads aus den aktuellen Werten neu berechnen
async function refreshNorm(leadId) {
  const [[l]] = await db.query('SELECT phone, email, website FROM leads WHERE id=?', [leadId]);
  if (!l) return;
  const n = normFields(l);
  await db.query('UPDATE leads SET phone_norm=?, email_norm=?, domain_norm=?, norm_v=1 WHERE id=?',
    [n.phone_norm, n.email_norm, n.domain_norm, leadId]);
}

// Mögliche Dubletten zu den übergebenen Kontaktdaten (nur aktive Leads)
async function findDuplicates({ phone, email, website }, excludeId = 0, limit = 5) {
  const n = normFields({ phone, email, website });
  const conds = [], params = [];
  if (n.phone_norm)  { conds.push('l.phone_norm = ?');  params.push(n.phone_norm); }
  if (n.email_norm)  { conds.push('l.email_norm = ?');  params.push(n.email_norm); }
  if (n.domain_norm) { conds.push('l.domain_norm = ?'); params.push(n.domain_norm); }
  if (!conds.length) return [];
  const [rows] = await db.query(
    `SELECT l.id, l.company, l.ceo, l.phone, l.email, l.website, l.location, l.status, l.assigned_to,
            u.full_name AS assigned_name,
            CONCAT_WS(',',
              IF(l.phone_norm = ?, 'Telefon', NULL),
              IF(l.email_norm = ?, 'E-Mail', NULL),
              IF(l.domain_norm = ?, 'Website', NULL)) AS matched_on
     FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
     WHERE l.archived_at IS NULL AND l.id <> ? AND (${conds.join(' OR ')})
     ORDER BY l.id ASC LIMIT ?`,
    [n.phone_norm, n.email_norm, n.domain_norm, excludeId || 0, ...params, limit]
  );
  return rows;
}

// Lead anhand der Telefonnummer finden (eingehende Anrufe)
async function findLeadByPhone(phone) {
  const p = normPhone(phone);
  if (!p) return null;
  const [[row]] = await db.query(
    `SELECT l.id, l.company, l.ceo, l.assigned_to FROM leads l
     WHERE l.phone_norm = ? AND l.archived_at IS NULL
     ORDER BY l.assigned_to IS NULL, l.updated_at DESC LIMIT 1`, [p]);
  return row || null;
}

// Einmalig: normalisierte Felder für alle vorhandenen Leads berechnen
async function backfillNorm() {
  let done = 0;
  for (;;) {
    const [rows] = await db.query(
      `SELECT id, phone, email, website FROM leads
       WHERE norm_v IS NULL ORDER BY id LIMIT 500`);
    if (!rows.length) break;
    for (const l of rows) {
      const n = normFields(l);
      await db.query('UPDATE leads SET phone_norm=?, email_norm=?, domain_norm=?, norm_v=1 WHERE id=?',
        [n.phone_norm, n.email_norm, n.domain_norm, l.id]);
    }
    done += rows.length;
  }
  return done;
}

module.exports = { normFields, normPhone, refreshNorm, findDuplicates, findLeadByPhone, backfillNorm };
