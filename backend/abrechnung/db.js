'use strict';
// ── Datenbank für die Abrechnung (SQLite) ─────────────────────
// Nutzt die in Node.js (ab 22.5) eingebaute SQLite-Bindung (node:sqlite),
// damit auf dem Server nichts kompiliert werden muss.
// Eine Datei: data/abrechnung/abrechnung.sqlite. Jede Sammlung (kunden,
// artikel, angebote, rechnungen, abos) liegt als Tabelle mit den Dokumenten
// als JSON; Einstellungen (Stammdaten, Nummernkreise) in einer Schlüssel-
// Wert-Tabelle. Schreibvorgänge sind transaktional, Nummernkreise werden
// innerhalb einer Transaktion hochgezählt und sind damit lückenlos.
const fs = require('fs');
const path = require('path');
const sqlite = require('node:sqlite');
const { DatabaseSync } = sqlite;

const SAMMLUNGEN = ['kunden', 'artikel', 'angebote', 'rechnungen', 'abos'];

function oeffne(basis) {
  fs.mkdirSync(basis, { recursive: true });
  const datei = path.join(basis, 'abrechnung.sqlite');
  const db = new DatabaseSync(datei);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS dokumente (
      sammlung TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      geaendert TEXT NOT NULL,
      PRIMARY KEY (sammlung, id)
    );
    CREATE INDEX IF NOT EXISTS idx_dokumente_sammlung ON dokumente (sammlung);
    CREATE TABLE IF NOT EXISTS einstellungen (
      schluessel TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      geaendert TEXT NOT NULL
    );
  `);

  const st = {
    alle: db.prepare('SELECT json FROM dokumente WHERE sammlung = ? ORDER BY rowid'),
    eins: db.prepare('SELECT json FROM dokumente WHERE sammlung = ? AND id = ?'),
    setze: db.prepare('INSERT INTO dokumente (sammlung, id, json, geaendert) VALUES (?, ?, ?, ?) ON CONFLICT(sammlung, id) DO UPDATE SET json = excluded.json, geaendert = excluded.geaendert'),
    loesche: db.prepare('DELETE FROM dokumente WHERE sammlung = ? AND id = ?'),
    anzahl: db.prepare('SELECT COUNT(*) AS n FROM dokumente'),
    einstellung: db.prepare('SELECT json FROM einstellungen WHERE schluessel = ?'),
    einstellungSetzen: db.prepare('INSERT INTO einstellungen (schluessel, json, geaendert) VALUES (?, ?, ?) ON CONFLICT(schluessel) DO UPDATE SET json = excluded.json, geaendert = excluded.geaendert')
  };
  const jetzt = () => new Date().toISOString();

  const api = {
    datei,
    alle(sammlung) { return st.alle.all(sammlung).map(r => JSON.parse(r.json)); },
    eins(sammlung, id) { const r = st.eins.get(sammlung, String(id)); return r ? JSON.parse(r.json) : null; },
    setze(sammlung, id, obj) { st.setze.run(sammlung, String(id), JSON.stringify(obj), jetzt()); return obj; },
    loesche(sammlung, id) { st.loesche.run(sammlung, String(id)); },
    einstellung(schluessel, standard) { const r = st.einstellung.get(schluessel); return r ? JSON.parse(r.json) : standard; },
    einstellungSetzen(schluessel, obj) { st.einstellungSetzen.run(schluessel, JSON.stringify(obj), jetzt()); return obj; },
    transaktion(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    leer() { return st.anzahl.get().n === 0 && !st.einstellung.get('stammdaten'); },
    // Konsistente Kopie der Datenbankdatei (für Export und Sicherung)
    async sicherung(ziel) {
      if (typeof sqlite.backup === 'function') { await sqlite.backup(db, ziel); return; }
      // Ältere Node-Versionen: WAL in die Hauptdatei schreiben und Datei kopieren
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(datei, ziel);
    },
    schliesse() { db.close(); }
  };

  // ── Übernahme alter JSON-Dateien (einmalig) ─────────────────
  // Frühere Version speicherte alles als JSON-Dateien. Beim ersten Start mit
  // leerer Datenbank werden sie importiert und danach in einen Ordner
  // "_json-alt" verschoben, damit nichts doppelt gelesen wird.
  function liesJson(d) {
    try { let t = fs.readFileSync(d, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t); } catch (e) { return null; }
  }
  function migriereJson() {
    const kandidaten = ['stammdaten.json', 'artikel.json', 'kunden.json', 'zaehler.json', 'angebote', 'rechnungen', 'abos'].map(n => path.join(basis, n)).filter(p => fs.existsSync(p));
    if (!kandidaten.length || !api.leer()) return 0;
    let n = 0;
    api.transaktion(() => {
      const stamm = liesJson(path.join(basis, 'stammdaten.json'));
      if (stamm) { api.einstellungSetzen('stammdaten', stamm); n++; }
      const zaehler = liesJson(path.join(basis, 'zaehler.json'));
      if (zaehler) { api.einstellungSetzen('zaehler', zaehler); n++; }
      (liesJson(path.join(basis, 'artikel.json')) || []).forEach(a => { api.setze('artikel', a.nr, a); n++; });
      (liesJson(path.join(basis, 'kunden.json')) || []).forEach(k => { api.setze('kunden', k.id, k); n++; });
      ['angebote', 'rechnungen', 'abos'].forEach(s => {
        const dir = path.join(basis, s);
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => { const o = liesJson(path.join(dir, f)); if (o && o.id) { api.setze(s, o.id, o); n++; } });
      });
    });
    const alt = path.join(basis, '_json-alt');
    fs.mkdirSync(alt, { recursive: true });
    kandidaten.forEach(p => fs.renameSync(p, path.join(alt, path.basename(p))));
    return n;
  }
  const migriert = migriereJson();
  if (migriert) console.log(`Abrechnung: ${migriert} Datensätze aus JSON-Dateien in die Datenbank übernommen.`);

  return api;
}

module.exports = { oeffne, SAMMLUNGEN };
