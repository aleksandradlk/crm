// ============================================================
// Abgleich mit dem Angebotstool
// Holt den NovaFlow-Bestand des Angebotstools (Kunden, Artikel, Angebote,
// Rechnungen, Abos, Stammdaten, Nummernkreise, PDFs, Anhänge) ins CRM und
// sichert alles Übrige des Tools (Sicherungen, Betriebe mit ihren Daten) als
// Archiv-Kopie. Läuft bei jedem Start und auf Knopfdruck; das Tool selbst
// wird nur gelesen, nie verändert.
//
// Regeln je Datensatz (Sammlung + ID):
//   - nur im Tool                      → ins CRM übernehmen
//   - im Tool geändert, im CRM nicht   → Stand aus dem Tool übernehmen
//   - in beiden geändert               → der neuere Stand gewinnt
//   - nur im CRM geändert / gelöscht   → bleibt, wie es im CRM ist
// „Geändert“ heißt: seit dem letzten Abgleich (bzw. der ersten Übernahme).
// Nummernkreise werden zusammengeführt (jeweils der höhere Zähler), damit
// keine Angebots- oder Rechnungsnummer doppelt vergeben wird.
// ============================================================
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SAMMLUNGEN = ['kunden', 'artikel', 'angebote', 'rechnungen', 'abos'];
// Ordner des Tools, die als Archiv mitgesichert werden (nicht Teil der NovaFlow-Abrechnung)
const ARCHIV = ['betriebe', 'angebote', 'rechnungen', 'abrechnung-betriebe', 'backups'];

// Datenordner des Angebotstools: ANGEBOT_TOOL_DATA_DIR, sonst ~/angebot-tool-daten, sonst
// im Home-Verzeichnis suchen (das Tool kann je nach Einrichtung auch woanders speichern)
const istToolOrdner = d => fs.existsSync(path.join(d, 'abrechnung', 'abrechnung.sqlite')) || fs.existsSync(path.join(d, 'betriebe'));
let gefunden = null;
function sucheToolOrdner(start) {
  const treffer = [];
  let besucht = 0;
  (function geh(dir, tiefe) {
    if (tiefe > 5 || besucht > 4000) return;
    besucht++;
    let eintraege;
    try { eintraege = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    if (eintraege.some(e => e.isDirectory() && e.name === 'betriebe') && istToolOrdner(dir)) { treffer.push(dir); return; }
    for (const e of eintraege) {
      if (!e.isDirectory() || ['node_modules', '.git', '.cache', '.npm', 'crm-abrechnung', 'angebotstool-archiv', 'uploads'].includes(e.name)) continue;
      geh(path.join(dir, e.name), tiefe + 1);
    }
  })(start, 0);
  const alter = d => { try { return fs.statSync(path.join(d, 'abrechnung', 'abrechnung.sqlite')).mtimeMs; } catch (_) { return 0; } };
  return treffer.sort((a, b) => alter(b) - alter(a))[0] || null;
}
function toolDatenordner() {
  if (process.env.ANGEBOT_TOOL_DATA_DIR) return path.resolve(process.env.ANGEBOT_TOOL_DATA_DIR);
  const standard = path.join(os.homedir(), 'angebot-tool-daten');
  if (istToolOrdner(standard)) return standard;
  if (!gefunden) gefunden = sucheToolOrdner(os.homedir());
  return gefunden || standard;
}

function liesJson(datei) {
  try { return JSON.parse(fs.readFileSync(datei, 'utf8')); } catch (_) { return null; }
}

// Zähler zusammenführen: Zahlen → Maximum, Objekte → je Schlüssel
function zaehlerMax(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return Math.max(Number(a) || 0, Number(b) || 0);
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const r = { ...a };
    Object.keys(b).forEach(k => { r[k] = k in a ? zaehlerMax(a[k], b[k]) : b[k]; });
    return r;
  }
  return b !== undefined ? b : a;
}

// Ordner kopieren; SQLite-Dateien konsistent über VACUUM INTO (auch während das Tool läuft)
function spiegle(von, nach, sqlite, { ueberschreiben }) {
  if (!fs.existsSync(von)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(von, { withFileTypes: true })) {
    const q = path.join(von, e.name), z = path.join(nach, e.name);
    if (e.isDirectory()) { n += spiegle(q, z, sqlite, { ueberschreiben }); continue; }
    if (!e.isFile() || /\.sqlite-(wal|shm)$/.test(e.name)) continue;
    if (fs.existsSync(z)) {
      if (!ueberschreiben) continue;
      const a = fs.statSync(q), b = fs.statSync(z);
      if (a.size === b.size && a.mtimeMs <= b.mtimeMs && !e.name.endsWith('.sqlite')) continue;
    }
    fs.mkdirSync(nach, { recursive: true });
    if (e.name.endsWith('.sqlite')) {
      const tmp = z + '.neu';
      fs.rmSync(tmp, { force: true });
      const quelle = new sqlite.DatabaseSync(q, { readOnly: true });
      try { quelle.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { quelle.close(); }
      fs.renameSync(tmp, z);
    } else {
      fs.copyFileSync(q, z);
    }
    n++;
  }
  return n;
}

// ziel: Datenordner der CRM-Abrechnung (enthält abrechnung/abrechnung.sqlite)
function gleicheAb(ziel, sqlite) {
  const tool = toolDatenordner();
  const quelleBasis = path.join(tool, 'abrechnung');
  const quelleDb = path.join(quelleBasis, 'abrechnung.sqlite');
  if (!istToolOrdner(tool)) return null;

  const zielBasis = path.join(ziel, 'abrechnung');
  fs.mkdirSync(zielBasis, { recursive: true });
  const stateDatei = path.join(zielBasis, '_abgleich.json');
  const state = liesJson(stateDatei) || { am: null, stand: {} };
  const erste = liesJson(path.join(zielBasis, '_uebernahme.json'));
  const jetzt = new Date().toISOString();

  const ergebnis = { am: jetzt, ordner: tool, von: quelleDb, neu: 0, aktualisiert: 0, konflikte: 0, behalten: 0, toolAnzahl: {}, crmAnzahl: {} };
  // NovaFlow-Abrechnung des Tools (fehlt, wenn dort nie eine Rechnung geschrieben wurde)
  if (fs.existsSync(quelleDb)) {
    const quelle = new sqlite.DatabaseSync(quelleDb, { readOnly: true });
    const zielDb = new sqlite.DatabaseSync(path.join(zielBasis, 'abrechnung.sqlite'));
    try {
      zielDb.exec('PRAGMA busy_timeout = 5000');
      zielDb.exec(`CREATE TABLE IF NOT EXISTS dokumente (sammlung TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, geaendert TEXT NOT NULL, PRIMARY KEY (sammlung, id));
        CREATE TABLE IF NOT EXISTS einstellungen (schluessel TEXT PRIMARY KEY, json TEXT NOT NULL, geaendert TEXT NOT NULL);`);
      const toolDocs = quelle.prepare('SELECT sammlung, id, json, geaendert FROM dokumente').all();
      const toolSet = quelle.prepare('SELECT schluessel, json, geaendert FROM einstellungen').all();
      const crmDoc = zielDb.prepare('SELECT json, geaendert FROM dokumente WHERE sammlung=? AND id=?');
      const crmSet = zielDb.prepare('SELECT json, geaendert FROM einstellungen WHERE schluessel=?');
      const setzeDoc = zielDb.prepare('INSERT INTO dokumente (sammlung, id, json, geaendert) VALUES (?,?,?,?) ON CONFLICT(sammlung, id) DO UPDATE SET json=excluded.json, geaendert=excluded.geaendert');
      const setzeSet = zielDb.prepare('INSERT INTO einstellungen (schluessel, json, geaendert) VALUES (?,?,?) ON CONFLICT(schluessel) DO UPDATE SET json=excluded.json, geaendert=excluded.geaendert');

      // Bezugszeitpunkte: Was im Tool nach dem letzten Abgleich geändert wurde, gilt als neu.
      // Hat es nie eine Übernahme gegeben, stammt alles im CRM nur aus der Grundausstattung
      // (Standard-Artikel, leere Stammdaten), die bei der ersten Inbetriebnahme angelegt wurde.
      const [{ m: crmFrueheste }] = zielDb.prepare('SELECT MIN(g) AS m FROM (SELECT geaendert AS g FROM dokumente UNION ALL SELECT geaendert FROM einstellungen)').all();
      const grundausstattungBis = crmFrueheste ? new Date(Date.parse(crmFrueheste) + 60000).toISOString() : '';
      const zuvor = state.am || (erste && erste.am) || '';
      const crmBezug = zuvor || grundausstattungBis;
      const toolGeaendert = (key, g) => g > (state.stand[key] || zuvor);

      const entscheide = (key, t, c) => {
        if (!c) { ergebnis.neu++; return true; }
        if (c.json === t.json) return false;
        const tNeu = toolGeaendert(key, t.geaendert);
        const cNeu = c.geaendert > crmBezug;
        if (tNeu && cNeu) { ergebnis.konflikte++; if (t.geaendert > c.geaendert) { ergebnis.aktualisiert++; return true; } ergebnis.behalten++; return false; }
        if (tNeu) { ergebnis.aktualisiert++; return true; }
        if (cNeu) ergebnis.behalten++;
        return false;
      };

      zielDb.exec('BEGIN IMMEDIATE');
      try {
        // Monatsrechnungen aus Abos legen Tool und CRM jeweils selbst als Entwurf an –
        // einen Entwurf für denselben Kunden, Monat und dasselbe Abo nicht doppelt übernehmen
        const aboEntwuerfe = zielDb.prepare("SELECT id, json FROM dokumente WHERE sammlung='rechnungen'").all()
          .map(r => ({ id: r.id, ...JSON.parse(r.json) })).filter(r => r.status === 'entwurf' && r.quelle === 'abo');
        const doppelterAboEntwurf = (t) => {
          if (t.sammlung !== 'rechnungen') return false;
          const r = JSON.parse(t.json);
          if (r.status !== 'entwurf' || r.quelle !== 'abo') return false;
          const abos = (r.bezug && r.bezug.aboIds) || [];
          return aboEntwuerfe.some(c => c.id !== t.id && c.kundeId === r.kundeId && c.geplantMonat === r.geplantMonat
            && ((c.bezug && c.bezug.aboIds) || []).some(a => abos.includes(a)));
        };
        for (const t of toolDocs) {
          const key = t.sammlung + '/' + t.id;
          const c = crmDoc.get(t.sammlung, t.id);
          if (!c && doppelterAboEntwurf(t)) { state.stand[key] = t.geaendert; ergebnis.doppelt = (ergebnis.doppelt || 0) + 1; continue; }
          if (entscheide(key, t, c)) setzeDoc.run(t.sammlung, t.id, t.json, t.geaendert);
          state.stand[key] = t.geaendert;
        }
        // Erster Abgleich ohne frühere Übernahme: unveränderte Standard-Artikel des CRM, die es im Tool nicht gibt, entfernen
        if (!zuvor) {
          const imTool = new Set(toolDocs.filter(t => t.sammlung === 'artikel').map(t => t.id));
          for (const r of zielDb.prepare("SELECT id, geaendert FROM dokumente WHERE sammlung='artikel'").all()) {
            if (!imTool.has(r.id) && r.geaendert <= grundausstattungBis) zielDb.prepare("DELETE FROM dokumente WHERE sammlung='artikel' AND id=?").run(r.id);
          }
        }
        for (const t of toolSet) {
          const key = 'einstellung/' + t.schluessel;
          const c = crmSet.get(t.schluessel);
          if (t.schluessel === 'zaehler') {
            const zusammen = JSON.stringify(zaehlerMax(c ? JSON.parse(c.json) : {}, JSON.parse(t.json)));
            if (!c || c.json !== zusammen) setzeSet.run('zaehler', zusammen, jetzt);
          } else if (entscheide(key, t, c)) {
            setzeSet.run(t.schluessel, t.json, t.geaendert);
          }
          state.stand[key] = t.geaendert;
        }
        zielDb.exec('COMMIT');
      } catch (e) { zielDb.exec('ROLLBACK'); throw e; }

      const zaehle = (d) => Object.fromEntries(SAMMLUNGEN.map(s => [s, d.prepare('SELECT COUNT(*) AS n FROM dokumente WHERE sammlung=?').get(s).n]));
      ergebnis.toolAnzahl = zaehle(quelle);
      ergebnis.crmAnzahl = zaehle(zielDb);
    } finally {
      quelle.close();
      zielDb.close();
    }

  }

  // Dateien: archivierte PDFs und Anhänge (unveränderlich → nur fehlende kopieren),
  // dazu Sicherungen und alles Weitere des Tools als Archiv.
  ergebnis.dateien = spiegle(path.join(tool, 'Buchhaltung'), path.join(ziel, 'Buchhaltung'), sqlite, { ueberschreiben: false })
    + spiegle(path.join(quelleBasis, 'anhaenge'), path.join(zielBasis, 'anhaenge'), sqlite, { ueberschreiben: false });
  const archiv = path.join(ziel, 'angebotstool-archiv');
  ergebnis.archiv = spiegle(path.join(quelleBasis, 'sicherungen'), path.join(archiv, 'abrechnung-sicherungen'), sqlite, { ueberschreiben: false });
  for (const d of ARCHIV) ergebnis.archiv += spiegle(path.join(tool, d), path.join(archiv, d), sqlite, { ueberschreiben: true });
  ergebnis.betriebe = fs.existsSync(path.join(tool, 'betriebe')) ? fs.readdirSync(path.join(tool, 'betriebe')).filter(f => f.endsWith('.json')).length : 0;

  state.am = jetzt;
  fs.writeFileSync(stateDatei, JSON.stringify(state));
  fs.writeFileSync(path.join(zielBasis, '_abgleich-ergebnis.json'), JSON.stringify(ergebnis, null, 2));
  return ergebnis;
}

module.exports = { gleicheAb, toolDatenordner, SAMMLUNGEN };
