// ── Wer sieht welche Leads? ─────────────────────────────────────────────────
// Closer sehen nur ihre eigenen Leads (und damit auch nur ihre Deals und Summen).
// Freie Leads (ohne Zuständigen) sehen sie nur, wenn der Admin das unter
// Einstellungen erlaubt (app_settings.closer_freie_leads, Standard: an).
// Admins und Closer mit dem Recht „Alle Leads sehen“ sehen alles.
const db = require('../db');

let freie = true, geladenAm = 0;
async function lade() {
  try {
    const [[r]] = await db.query("SELECT value FROM app_settings WHERE key_name='closer_freie_leads'");
    freie = !r || r.value !== '0';
  } catch (_) { /* Tabelle fehlt beim ersten Start noch */ }
  geladenAm = Date.now();
}
lade();

// Synchron nutzbar (Wert wird spätestens nach 30 s aufgefrischt, nach Änderung sofort)
function freieLeadsSichtbar() {
  if (Date.now() - geladenAm > 30000) lade();
  return freie;
}
function neuLaden() { return lade(); }

function siehtAlles(user) {
  return user.role === 'admin' || !!user.can_view_all_leads;
}

function darfSehen(user, lead) {
  if (siehtAlles(user)) return true;
  if (lead.assigned_to === user.id) return true;
  return lead.assigned_to === null && freieLeadsSichtbar();
}

// WHERE-Bedingung für Listen (Lead-Alias frei wählbar)
function leadFilter(user, alias = 'l') {
  if (siehtAlles(user)) return { sql: '1=1', params: [] };
  return freieLeadsSichtbar()
    ? { sql: `(${alias}.assigned_to = ? OR ${alias}.assigned_to IS NULL)`, params: [user.id] }
    : { sql: `${alias}.assigned_to = ?`, params: [user.id] };
}

// Lead geht an einen anderen Vertriebler: offene Deals, offene
// Wiedervorlagen und feste Termine wandern mit, damit der Neue alles weiterführen kann.
async function uebergeben(leadId, alterId, neuerId) {
  if (!neuerId || neuerId === alterId) return;
  await db.query("UPDATE deals SET owner_id=? WHERE lead_id=? AND status='open'", [neuerId, leadId]);
  if (alterId) await db.query('UPDATE reminders SET user_id=? WHERE lead_id=? AND user_id=? AND done_at IS NULL', [neuerId, leadId, alterId]);
  // Feste Termine gehen mit; offene Vorschläge an andere bleiben, wie sie sind
  if (alterId) await db.query(
    "UPDATE appointments SET closer_id=?, erinnert=0 WHERE lead_id=? AND closer_id=? AND status='angenommen' AND starts_at >= NOW()",
    [neuerId, leadId, alterId]).catch(() => {});
}

module.exports = { freieLeadsSichtbar, neuLaden, siehtAlles, darfSehen, leadFilter, uebergeben };
