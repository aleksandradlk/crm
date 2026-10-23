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

  // Nur-Lese-Mandant je Betrieb; wird nach jedem Abgleich neu geöffnet
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
    return m;
  }
  function neuLaden() {
    for (const m of mandanten.values()) { try { m.db.schliesse(); } catch (_) {} }
    mandanten.clear();
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
      try { st = mandant(slug).statistik(); } catch (e) { console.error('Kundenkonto', slug, e.message); }
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
  function api(req, res, next) {
    const m = req.path.match(/^\/api\/abrechnung\/konten\/([a-z0-9-]+)(\/.*)$/);
    if (!m) return next();
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Nur für Admins.' });
    if (req.method !== 'GET') return res.status(403).json({ success: false, error: 'Kundenkonten aus dem Angebotstool sind im CRM nur zur Ansicht. Änderungen bitte im Angebotstool.' });
    const md = mandant(m[1]);
    if (!md) return res.status(404).json({ success: false, error: 'Kundenkonto nicht gefunden.' });
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = '/api/abrechnung' + m[2] + query;
    md.router(req, res, next);
  }

  return { liste, api, neuLaden };
}

module.exports = { erstelle };
