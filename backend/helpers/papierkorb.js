// ── Papierkorb ────────────────────────────────────────────────
// Gelöschte Kommentare, Deals und Angebotsanhänge landen hier statt endgültig zu verschwinden.
// 30 Tage wiederherstellbar, danach räumt ein täglicher Lauf auf. Endgültig löschen nur Admin.
// Archivierte Leads bleiben wie bisher in der Lead-Tabelle (archived_at) und werden in der
// Papierkorb-Ansicht nur mit angezeigt.
const db = require('../db');

const TAGE = 30;

// SQL-Zeilen ohne Zeitzonen-Umrechnung laden, damit Wiederherstellen dieselben Werte schreibt
async function zeile(tabelle, id) {
  const [[r]] = await db.query({ sql: `SELECT * FROM \`${tabelle}\` WHERE id=?`, values: [id], dateStrings: true });
  return r || null;
}

async function ablegen({ art, leadId = null, titel, daten, userId }) {
  await db.query('INSERT INTO papierkorb (art, lead_id, titel, daten, geloescht_von) VALUES (?,?,?,?,?)',
    [art, leadId, String(titel || art).slice(0, 300), JSON.stringify(daten || {}), userId || null]);
}

// Zeile aus einer Tabelle in den Papierkorb legen und dann löschen
async function zeileLoeschen(tabelle, art, id, { leadId, titel, userId }) {
  const r = await zeile(tabelle, id);
  if (!r) return false;
  await ablegen({ art, leadId: leadId ?? r.lead_id ?? null, titel, daten: { tabelle, zeile: r }, userId });
  await db.query(`DELETE FROM \`${tabelle}\` WHERE id=?`, [id]);
  return true;
}

async function liste() {
  const [rows] = await db.query(
    `SELECT p.id, p.art, p.lead_id, p.titel, p.geloescht_am, u.full_name AS von, l.company
     FROM papierkorb p LEFT JOIN users u ON u.id = p.geloescht_von LEFT JOIN leads l ON l.id = p.lead_id
     ORDER BY p.geloescht_am DESC LIMIT 500`);
  const [leads] = await db.query(
    `SELECT l.id, l.company, l.archived_at, l.archive_reason, u.full_name AS von
     FROM leads l LEFT JOIN users u ON u.id = l.archived_by
     WHERE l.archived_at IS NOT NULL ORDER BY l.archived_at DESC LIMIT 300`);
  return { eintraege: rows, leads, tage: TAGE };
}

// Wiederherstellen: SQL-Zeilen mit ihrer alten ID zurückschreiben, Anhänge über den Hook
let anhangHook = null;
function setzeAnhangHook(fn) { anhangHook = fn; }

async function wiederherstellen(id) {
  const [[p]] = await db.query('SELECT * FROM papierkorb WHERE id=?', [id]);
  if (!p) throw new Error('Nicht mehr im Papierkorb.');
  const d = JSON.parse(p.daten || '{}');
  if (d.tabelle && d.zeile) {
    const [[vorhanden]] = await db.query(`SELECT id FROM \`${d.tabelle}\` WHERE id=?`, [d.zeile.id]);
    const werte = { ...d.zeile };
    if (vorhanden) delete werte.id;   // ID inzwischen vergeben: neue ID
    const cols = Object.keys(werte);
    await db.query(`INSERT INTO \`${d.tabelle}\` (${cols.map(c => '`' + c + '`').join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map(c => werte[c]));
  } else if (p.art === 'anhang') {
    if (!anhangHook) throw new Error('Angebote & Rechnungen sind gerade nicht verfügbar.');
    await anhangHook(d);
  } else throw new Error('Dieser Eintrag lässt sich nicht wiederherstellen.');
  await db.query('DELETE FROM papierkorb WHERE id=?', [id]);
  return p;
}

let dateiHook = null;            // löscht die Datei eines Anhangs endgültig
function setzeDateiHook(fn) { dateiHook = fn; }
async function endgueltig(id) {
  const [[p]] = await db.query('SELECT * FROM papierkorb WHERE id=?', [id]);
  if (!p) return;
  if (p.art === 'anhang' && dateiHook) { try { await dateiHook(JSON.parse(p.daten || '{}')); } catch (_) {} }
  await db.query('DELETE FROM papierkorb WHERE id=?', [id]);
}

// Täglich: Einträge älter als 30 Tage endgültig entfernen
async function aufraeumen() {
  const [alt] = await db.query('SELECT id FROM papierkorb WHERE geloescht_am < NOW() - INTERVAL ? DAY', [TAGE]);
  for (const r of alt) await endgueltig(r.id).catch(() => {});
  return alt.length;
}

module.exports = { ablegen, zeileLoeschen, liste, wiederherstellen, endgueltig, aufraeumen, setzeAnhangHook, setzeDateiHook, TAGE };
