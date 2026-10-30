// ── CRM-Sicherung (nur Admin, nur lesend) ─────────────────────
// GET /api/sicherung → ZIP mit
//   crm-datenbank.sql   kompletter SQL-Dump aller Tabellen (Struktur + Daten),
//                       einspielbar per phpMyAdmin „Importieren“ oder `mysql DB < crm-datenbank.sql`
//   leads.csv           alle Leads zum Ansehen in Excel
//   tabellen/*.json     jede Tabelle zusätzlich als JSON
// Die Datei enthält Passwort-Hashes und Zugangsschlüssel → sicher aufbewahren.
const router = require('express').Router();
const { ZipArchive } = require('archiver');
const db = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

function sqlWert(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) return isNaN(v) ? 'NULL' : `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
  if (Buffer.isBuffer(v)) return v.length ? '0x' + v.toString('hex') : "''";
  if (typeof v === 'object') v = JSON.stringify(v);
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0').replace(/\x1a/g, '\\Z') + "'";
}

function csvZelle(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) v = isNaN(v) ? '' : v.toISOString();
  return '"' + String(v).replace(/"/g, '""') + '"';
}

router.get('/', auth, adminOnly, async (req, res) => {
  const stempel = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 16).replace(/[-:]/g, '').replace(' ', '-');
  // dateStrings: Datumswerte genau so, wie sie in der Datenbank stehen (keine Zeitzonen-Umrechnung)
  const conn = await db.getConnection();
  try {
    const [tabellen] = await conn.query({ sql: 'SHOW FULL TABLES WHERE Table_type = "BASE TABLE"', rowsAsArray: true });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="CRM-Sicherung_${stempel}.zip"`);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on('error', e => { console.error('Sicherung ZIP:', e.message); res.end(); });
    zip.pipe(res);

    // Einheitlicher Stand über alle Tabellen
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const sql = [
      `-- CRM-Sicherung vom ${new Date().toISOString()}`,
      'SET NAMES utf8mb4;', 'SET FOREIGN_KEY_CHECKS=0;', "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';", ''
    ];
    const anzahl = {};
    for (const [name] of tabellen) {
      const [[erstellt]] = await conn.query({ sql: `SHOW CREATE TABLE \`${name}\``, rowsAsArray: true });
      sql.push(`-- Tabelle ${name}`, `DROP TABLE IF EXISTS \`${name}\`;`, erstellt[1] + ';');
      const [zeilen, felder] = await conn.query({ sql: `SELECT * FROM \`${name}\``, dateStrings: true });
      anzahl[name] = zeilen.length;
      const spalten = felder.map(f => '`' + f.name + '`').join(', ');
      for (let i = 0; i < zeilen.length; i += 200) {
        const block = zeilen.slice(i, i + 200).map(z => '(' + felder.map(f => sqlWert(z[f.name])).join(', ') + ')');
        sql.push(`INSERT INTO \`${name}\` (${spalten}) VALUES\n${block.join(',\n')};`);
      }
      sql.push('');
      zip.append(JSON.stringify(zeilen, (k, v) => Buffer.isBuffer(v) ? v.toString('base64') : v, 1), { name: `tabellen/${name}.json` });
      if (name === 'leads' && zeilen.length) {
        const kopf = felder.map(f => f.name);
        const csv = [kopf.map(csvZelle).join(';'), ...zeilen.map(z => kopf.map(k => csvZelle(z[k])).join(';'))].join('\r\n');
        zip.append('﻿' + csv, { name: 'leads.csv' });
      }
    }
    await conn.query('COMMIT');
    sql.push('SET FOREIGN_KEY_CHECKS=1;');
    zip.append(sql.join('\n'), { name: 'crm-datenbank.sql' });
    zip.append([
      `CRM-Sicherung vom ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`,
      '',
      'crm-datenbank.sql  – komplette Datenbank. Zurückspielen: Hostinger → phpMyAdmin → Datenbank wählen → Importieren → diese Datei.',
      '                     ACHTUNG: ersetzt dabei alle Tabellen durch den Stand dieser Sicherung.',
      'leads.csv          – alle Leads zum Ansehen (Excel: Daten → Aus Text/CSV, Trennzeichen Semikolon).',
      'tabellen/*.json    – jede Tabelle einzeln.',
      '',
      'Enthält Passwort-Hashes und Zugangsschlüssel: sicher aufbewahren, nicht weitergeben.',
      '',
      'Anzahl Zeilen je Tabelle:',
      ...Object.entries(anzahl).map(([t, n]) => `  ${t}: ${n}`)
    ].join('\r\n'), { name: 'LIESMICH.txt' });
    await zip.finalize();
  } catch (e) {
    console.error('Sicherung:', e.message);
    try { await conn.query('ROLLBACK'); } catch (_) {}
    if (!res.headersSent) res.status(500).json({ error: 'Sicherung fehlgeschlagen: ' + e.message });
    else res.end();
  } finally {
    conn.release();
  }
});

module.exports = router;
