// ============================================================
// Kundenkonten aus dem Angebotstool (die Betriebe, die das Tool nutzen)
// Das CRM zeigt sie aus der Archiv-Kopie (~/crm-abrechnung/angebotstool-archiv),
// die der Abgleich regelmäßig aktualisiert: Firmendaten, Zugang, Kennzahlen und
// – nur zur Ansicht – die komplette Abrechnung jedes Betriebs (Kunden,
// Angebote, Rechnungen, PDFs). Geändert wird weiterhin im Angebotstool.
// ============================================================
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const { findLeadByPhone } = require('../helpers/dedupe');

function erstelle(DATA_DIR) {
  const ARCHIV = path.join(DATA_DIR, 'angebotstool-archiv');
  const mandanten = new Map();
  const { bauMandant } = require('./index');

  function liesBetrieb(slug) {
    try { return JSON.parse(fs.readFileSync(path.join(ARCHIV, 'betriebe', slug + '.json'), 'utf8')); } catch (_) { return null; }
  }
  function slugs() {
    const dir = path.join(ARCHIV, 'betriebe');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(s => /^[a-z0-9-]+$/.test(s));
  }

  // Angebote/Rechnungen aus dem früheren KI-Generator (alte Ablage je Betrieb)
  function liesAltdaten(slug, art) {
    const dir = path.join(ARCHIV, art, slug);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; } })
      .filter(Boolean).sort((a, b) => String(a.erstellt || '').localeCompare(String(b.erstellt || '')));
  }
  const uebernahmen = new Map();

  // Nur-Lese-Mandant je Betrieb; wird nach jedem Abgleich neu geöffnet.
  // Hat sich ein Betrieb seit dem Umbau des Tools nicht mehr angemeldet, liegen
  // seine Angebote nur in der alten Ablage – die übernimmt das CRM wie das Tool
  // selbst in die Abrechnungsansicht, damit nichts fehlt.
  function mandant(slug) {
    if (mandanten.has(slug)) return mandanten.get(slug);
    const b = liesBetrieb(slug);
    if (!b) return null;
    const f = b.firma || {};
    const basis = path.join(ARCHIV, 'abrechnung-betriebe', slug);
    const m = bauMandant(express.Router(), {
      id: slug, istAdmin: false, email: false, nurLesen: true, DATA_DIR: ARCHIV,
      basis, buchhaltung: path.join(basis, 'Buchhaltung'), artikelStandard: [],
      stammdatenStandard: { firma: f.name || slug, inhaberin: f.inhaber || '', inhaberLabel: 'Inhaber/in', marke: null,
        strasse: f.strasse || '', plz: f.plz || '', ort: f.ort || '', telefon: f.telefon || '', email: f.email || '',
        kleinunternehmer: !!b.kleinunternehmer },
      live: () => { const akt = liesBetrieb(slug); return akt ? { logo: akt.logo || null } : {}; },
    });
    mandanten.set(slug, m);
    if (!uebernahmen.has(slug)) {
      uebernahmen.set(slug, m.uebernehmeAltdaten({ angebote: liesAltdaten(slug, 'angebote'), rechnungen: liesAltdaten(slug, 'rechnungen') })
        .then(e => { if (e) console.log(`Kundenkonto ${slug}: Altdaten übernommen (${e.angebote} Angebote, ${e.rechnungen} Rechnungen).`); })
        .catch(e => console.error('Kundenkonto Altdaten', slug, e.message)));
    }
    return m;
  }
  async function bereit(slug) {
    const m = mandant(slug);
    if (m) await uebernahmen.get(slug);
    return m;
  }
  function neuLaden() {
    for (const m of mandanten.values()) { try { m.db.schliesse(); } catch (_) {} }
    mandanten.clear();
    uebernahmen.clear();
  }

  async function leadFuer(f) {
    try {
      if (f.telefon) { const l = await findLeadByPhone(f.telefon); if (l) return l.id; }
      if (f.email) { const [[l]] = await db.query('SELECT id FROM leads WHERE LOWER(email)=LOWER(?) LIMIT 1', [f.email]); if (l) return l.id; }
      if (f.name) { const [[l]] = await db.query('SELECT id FROM leads WHERE LOWER(company)=LOWER(?) LIMIT 1', [f.name]); if (l) return l.id; }
    } catch (_) {}
    return null;
  }

  async function liste() {
    const konten = [];
    for (const slug of slugs()) {
      const b = liesBetrieb(slug);
      if (!b) continue;
      const f = b.firma || {};
      let st = null;
      try { st = (await bereit(slug)).statistik(); } catch (e) { console.error('Kundenkonto', slug, e.message); }
      konten.push({
        slug, name: f.name || slug, inhaber: f.inhaber || '', branche: f.branche || '',
        strasse: f.strasse || '', plz: f.plz || '', ort: f.ort || '', telefon: f.telefon || '', email: f.email || '',
        benutzername: b.benutzername || null, angelegt: b.angelegt || null, letzterLogin: b.letzterLogin || null,
        logo: typeof b.logo === 'string' && b.logo.length < 300000 ? b.logo : null,
        statistik: st, leadId: await leadFuer(f),
      });
    }
    return konten.sort((a, b) => String((b.statistik && b.statistik.letzteAktivitaet) || b.angelegt || '').localeCompare(String((a.statistik && a.statistik.letzteAktivitaet) || a.angelegt || '')));
  }

  // /api/abrechnung/konten/<slug>/<pfad> → Abrechnung des Betriebs (nur lesen)
  async function api(req, res, next) {
    const m = req.path.match(/^\/api\/abrechnung\/konten\/([a-z0-9-]+)(\/.*)$/);
    if (!m) return next();
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Nur für Admins.' });
    if (req.method !== 'GET') return res.status(403).json({ success: false, error: 'Kundenkonten aus dem Angebotstool sind im CRM nur zur Ansicht. Änderungen bitte im Angebotstool.' });
    const md = await bereit(m[1]).catch(() => null);
    if (!md) return res.status(404).json({ success: false, error: 'Kundenkonto nicht gefunden.' });
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = '/api/abrechnung' + m[2] + query;
    md.router(req, res, next);
  }

  // Sicherungsdatei des Angebotstools (Angebotstool-Kundenkonten_….json) einspielen:
  // fehlende Kundenkonten, Angebote und Rechnungen werden ins Archiv ergänzt,
  // Vorhandenes bleibt (der laufende Abgleich ist aktueller als eine Datei).
  function einspielen(d) {
    const z = { kundenkonten: 0, angebote: 0, rechnungen: 0, vorhanden: 0 };
    const sicher = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_');
    const schreibe = (datei, obj, zaehler) => {
      if (fs.existsSync(datei)) { z.vorhanden++; return; }
      fs.mkdirSync(path.dirname(datei), { recursive: true });
      fs.writeFileSync(datei, JSON.stringify(obj, null, 2));
      z[zaehler]++;
    };
    for (const b of Array.isArray(d.betriebe) ? d.betriebe : []) {
      if (!b || !/^[a-z0-9-]+$/.test(b.slug || '')) continue;
      schreibe(path.join(ARCHIV, 'betriebe', b.slug + '.json'), b, 'kundenkonten');
      for (const [art, liste] of [['angebote', d.angebote], ['rechnungen', d.rechnungen]]) {
        for (const x of (liste && Array.isArray(liste[b.slug]) ? liste[b.slug] : [])) {
          if (x && x.nummer) schreibe(path.join(ARCHIV, art, b.slug, sicher(x.nummer) + '.json'), x, art);
        }
      }
    }
    // Neu eingespielte Altdaten sollen in der Ansicht auftauchen: Übernahme-Marker der
    // betroffenen Konten entfernen, damit sie beim nächsten Öffnen nachgezogen werden
    if (z.angebote || z.rechnungen) {
      for (const b of d.betriebe || []) {
        if (/^[a-z0-9-]+$/.test((b && b.slug) || '')) fs.rmSync(path.join(ARCHIV, 'abrechnung-betriebe', b.slug, '_altdaten-uebernommen.json'), { force: true });
      }
    }
    neuLaden();
    return z;
  }

  return { liste, api, neuLaden, einspielen };
}

module.exports = { erstelle };
