'use strict';
// ── Abrechnung: Angebote & Rechnungen von NovaFlow Services ─────────
// Eigenes Admin-Modul, getrennt vom Handwerker-Angebotstool.
// Speicherung als JSON-Dateien unter data/abrechnung/, archivierte PDFs
// unter data/Buchhaltung/JJJJ/MM/. Nichts wird automatisch gelöscht.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { ZipArchive } = require('archiver');
const { erzeugeAngebotPdf, erzeugeRechnungPdf, erzeugeMahnungPdf, MAHN_TITEL } = require('./pdf');
const mail = require('./mail');
const datenbank = require('./db');

const UST_SATZ = 19;

// ── Standard-Stammdaten & Artikelkatalog (werden beim ersten Start angelegt) ──
const STAMMDATEN_STANDARD = {
  firma: 'NovaFlow Services',
  inhaberin: 'Aleksandra Dalak',
  strasse: 'Hinsbecker Str. 20',
  plz: '47804',
  ort: 'Krefeld',
  steuernummer: '',
  telefon: '',
  email: '',
  website: 'novaflowservices.de',
  bank: { name: '', iban: '', bic: '', kontoinhaberin: 'Aleksandra Dalak' },
  kleinunternehmer: true,
  zahlungszielTage: 14,
  angebotGueltigTage: 14,
  aboStichtag: 1,
  mahnfristTage: 7,
  mahngebuehr2: 0,
  mahngebuehr3: 0,
  sicherungMail: { aktiv: true, an: '', rhythmusTage: 7 }
};

const ARTIKEL_STANDARD = [
  { nr: 'AB-001', titel: 'Automation Business', preis: 1500, einheit: 'Paket', einheitMehrzahl: 'Pakete', abrechnung: 'einmalig',
    beschreibung: 'Einrichtung Ihrer automatisierten Anfragen- und Kundenstrecke: Website-Formular, automatische Bestätigung, Terminvorschlag, Übergabe in Ihre Kundenliste. Inklusive Einweisung und Feinschliff nach dem Start.' },
  { nr: 'AB-002', titel: 'Automation Business (Referenzkunde)', preis: 1200, einheit: 'Paket', einheitMehrzahl: 'Pakete', abrechnung: 'einmalig',
    beschreibung: 'Einrichtung Ihrer automatisierten Anfragen- und Kundenstrecke zum Referenzkunden-Preis: Website-Formular, automatische Bestätigung, Terminvorschlag, Übergabe in Ihre Kundenliste. Inklusive Einweisung und Feinschliff nach dem Start.' },
  { nr: 'AB-003', titel: 'Einrichtungspaket Website & Anfragen-Automatisierung', preis: 1300, einheit: 'Paket', einheitMehrzahl: 'Pakete', abrechnung: 'einmalig',
    beschreibung: 'Einrichtung einer Website-Seite mit Anfrageformular und automatisierter Weiterverarbeitung der Anfragen (Bestätigung, Weiterleitung, Ablage). Inklusive Einweisung.' },
  { nr: 'BT-001', titel: 'Betreuungspaket', preis: 99, einheit: 'Monat', einheitMehrzahl: 'Monate', abrechnung: 'monatlich',
    beschreibung: 'Laufende Betreuung Ihrer Automatisierung: Überwachung, kleine Anpassungen, Ansprechpartnerin bei Fragen. Monatlich kündbar.' },
  { nr: 'BT-002', titel: 'Betreuungspaket (Referenzkunde)', preis: 79, einheit: 'Monat', einheitMehrzahl: 'Monate', abrechnung: 'monatlich',
    beschreibung: 'Laufende Betreuung Ihrer Automatisierung zum Referenzkunden-Preis: Überwachung, kleine Anpassungen, Ansprechpartnerin bei Fragen. Monatlich kündbar.' },
  { nr: 'HO-001', titel: 'Hosting Website', preis: 9.99, einheit: 'Monat', einheitMehrzahl: 'Monate', abrechnung: 'monatlich',
    beschreibung: 'Hosting und technischer Betrieb Ihrer Website inklusive SSL-Zertifikat und Updates. Monatlich kündbar.' },
  { nr: 'HO-002', titel: 'Hosting Automation Business', preis: 19.99, einheit: 'Monat', einheitMehrzahl: 'Monate', abrechnung: 'monatlich',
    beschreibung: 'Hosting und technischer Betrieb Ihrer Automatisierung (Server, Updates, Sicherung). Monatlich kündbar.' },
  { nr: 'HO-003', titel: 'Hosting & Betrieb Automatisierung (Referenzkunde)', preis: 15, einheit: 'Monat', einheitMehrzahl: 'Monate', abrechnung: 'monatlich',
    beschreibung: 'Hosting und technischer Betrieb Ihrer Automatisierung zum Referenzkunden-Preis (Server, Updates, Sicherung). Monatlich kündbar.' }
];

// ── Hilfsfunktionen ───────────────────────────────────────────
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function heute() { return new Date().toISOString().slice(0, 10); }
function pad(n, l) { return String(n).padStart(l, '0'); }
function neueId() { return crypto.randomBytes(8).toString('hex'); }

function plusTage(iso, tage) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(tage || 0));
  return d.toISOString().slice(0, 10);
}
function plusMonate(iso, monate) {
  // Gleicher Tag im Zielmonat; fällt er weg (31. → Februar), letzter Tag des Monats.
  const d = new Date(iso + 'T00:00:00Z');
  const tag = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(monate || 0));
  const letzter = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(tag, letzter));
  return d.toISOString().slice(0, 10);
}
function monatVon(iso) { return String(iso || '').slice(0, 7); }
function monatsAnfang(monat) { return monat + '-01'; }
function monatsEnde(monat) {
  const [j, m] = monat.split('-').map(Number);
  return `${j}-${pad(m, 2)}-${pad(new Date(Date.UTC(j, m, 0)).getUTCDate(), 2)}`;
}
function naechsterMonat(monat) { return monatVon(plusMonate(monatsAnfang(monat), 1)); }
function istDatum(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s)); }
function datumDe(iso) {
  if (!istDatum(iso)) return '';
  const [j, m, t] = iso.split('-');
  return `${t}.${m}.${j}`;
}
function dateiSlug(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kunde';
}
function menge(n) { return Number.isInteger(Number(n)) ? String(n) : String(round2(n)).replace('.', ','); }
function vorname(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }

// Zugangsschutz: nur der Admin darf das Modul sehen. Wird in server.js VOR
// express.static eingehängt, damit auch abrechnung.html gesperrt ist.
function nurAdmin(istAdmin) {
  return function (req, res, next) {
    if (istAdmin(req)) return next();
    if ((req.baseUrl + req.path).startsWith('/api/')) return res.status(403).json({ success: false, error: 'Nur für den Admin-Zugang.' });
    res.redirect('/');
  };
}

// Ein Mandant = ein eigener Datenbestand (NovaFlow selbst oder ein Betrieb).
// ctx: { id, istAdmin, email, DATA_DIR, basis, buchhaltung, stammdatenStandard,
//        artikelStandard, live() → Felder, die bei jedem Laden aus dem Betrieb kommen (Logo),
//        nurLesen → keine Abo-Läufe, Sicherungen oder Sicherungs-Mails (reine Ansicht) }
function bauMandant(app, ctx) {
  const { DATA_DIR, backupHandwerker } = ctx;
  const BASIS = ctx.basis;
  const BUCHHALTUNG_DIR = ctx.buchhaltung;
  const STD = { ...STAMMDATEN_STANDARD, ...(ctx.stammdatenStandard || {}) };
  const ARTIKEL_START = ctx.artikelStandard || ARTIKEL_STANDARD;
  fs.mkdirSync(BUCHHALTUNG_DIR, { recursive: true });
  const db = datenbank.oeffne(BASIS);
  // Sammlungen in der Datenbank
  const ANGEBOTE_DIR = 'angebote';
  const RECHNUNGEN_DIR = 'rechnungen';
  const ABOS_DIR = 'abos';

  // ── Datenzugriff ──────────────────────────────────────────
  function ladeStammdaten() {
    const s = db.einstellung('stammdaten', null);
    if (!s) { db.einstellungSetzen('stammdaten', STD); return { ...STD, bank: { ...STD.bank }, ...(ctx.live ? ctx.live() : {}) }; }
    return { ...STD, ...s, bank: { ...STD.bank, ...(s.bank || {}) }, sicherungMail: { ...STD.sicherungMail, ...(s.sicherungMail || {}) }, ...(ctx.live ? ctx.live() : {}) };
  }
  function speichereStammdaten(s) { db.einstellungSetzen('stammdaten', s); }
  function ladeArtikel() {
    let a = db.alle('artikel');
    if (!a.length) {
      db.transaktion(() => ARTIKEL_START.forEach(x => db.setze('artikel', x.nr, { ...x, aktiv: true })));
      a = db.alle('artikel');
    }
    // Ältere Datensätze ohne Mehrzahl-Einheit ergänzen
    a.forEach(x => {
      if (!x.einheitMehrzahl) {
        const std = ARTIKEL_STANDARD.find(y => y.nr === x.nr);
        x.einheitMehrzahl = (std && std.einheit === x.einheit && std.einheitMehrzahl) || { Paket: 'Pakete', Monat: 'Monate', Stunde: 'Stunden' }[x.einheit] || x.einheit;
        db.setze('artikel', x.nr, x);
      }
    });
    return a;
  }
  function speichereArtikelListe(liste) {
    db.transaktion(() => {
      const vorhanden = new Set(db.alle('artikel').map(x => x.nr));
      liste.forEach(x => { db.setze('artikel', x.nr, x); vorhanden.delete(x.nr); });
      vorhanden.forEach(nr => db.loesche('artikel', nr));
    });
  }
  function ladeKunden() { return db.alle('kunden'); }
  function speichereKundenListe(liste) {
    db.transaktion(() => {
      const vorhanden = new Set(db.alle('kunden').map(x => x.id));
      liste.forEach(x => { db.setze('kunden', x.id, x); vorhanden.delete(x.id); });
      vorhanden.forEach(id => db.loesche('kunden', id));
    });
  }
  function ladeZaehler() { return db.einstellung('zaehler', { kunden: 0, angebote: {}, rechnungen: {} }); }
  function speichereZaehler(z) { db.einstellungSetzen('zaehler', z); }

  function ladeAlle(sammlung) { return db.alle(sammlung); }
  function ladeEins(sammlung, id) {
    if (!/^[a-f0-9]{16}$/.test(String(id || ''))) return null;
    return db.eins(sammlung, id);
  }
  function speichere(sammlung, obj) {
    // CRM: Statuswechsel eines Angebots melden (z. B. angenommen → Deal gewonnen)
    const vorher = sammlung === 'angebote' && ctx.onAngebotStatus ? db.eins(sammlung, obj.id) : null;
    db.setze(sammlung, obj.id, obj);
    if (ctx.onAngebotStatus && sammlung === 'angebote' && obj.status !== (vorher ? vorher.status : 'entwurf')) {
      Promise.resolve().then(() => ctx.onAngebotStatus(angebotAnsicht(obj), vorher ? vorher.status : null))
        .catch(e => console.error('Abrechnung → CRM:', e.message));
    }
    return obj;
  }
  function loesche(sammlung, id) { db.loesche(sammlung, id); }

  // ── Nummernkreise ─────────────────────────────────────────
  // Die Zähler werden nie zurückgesetzt: eine einmal vergebene Nummer
  // wird auch dann nicht wiederverwendet, wenn das Dokument später
  // storniert wird. Rechnungsnummern werden erst beim Finalisieren vergeben.
  function naechsteKundennummer() {
    return db.transaktion(() => { const z = ladeZaehler(); z.kunden = (z.kunden || 0) + 1; speichereZaehler(z); return 'K-' + pad(z.kunden, 5); });
  }
  function naechsteAngebotsnummer(jahr) {
    return db.transaktion(() => { const z = ladeZaehler(); z.angebote[jahr] = (z.angebote[jahr] || 0) + 1; speichereZaehler(z); return `A-${jahr}-${pad(z.angebote[jahr], 3)}`; });
  }
  function naechsteRechnungsnummer(jahr) {
    return db.transaktion(() => { const z = ladeZaehler(); z.rechnungen[jahr] = (z.rechnungen[jahr] || 0) + 1; speichereZaehler(z); return `R-${jahr}-${pad(z.rechnungen[jahr], 3)}`; });
  }

  // ── Kunde: Anrede & Texte ─────────────────────────────────
  function kundeAnrede(kunde) {
    if (!kunde) return 'Guten Tag,';
    if (kunde.anrede === 'du') {
      const v = vorname(kunde.ansprechpartner);
      return v ? `Hey ${v},` : 'Hey,';
    }
    return kunde.ansprechpartner ? `Guten Tag ${kunde.ansprechpartner},` : 'Guten Tag,';
  }
  // Beginnt ein Text selbst mit einer Begrüßung, entfällt die automatische Anrede
  function beginntMitBegruessung(text) {
    return /^\s*(hey|hallo|hi|moin|servus|guten\s+(tag|morgen|abend)|liebe[rs]?|sehr\s+geehrte\w*)\b/i.test(String(text || ''));
  }
  function anredeFuer(dok, kunde, standardEinleitung) {
    if (dok.anrede) return dok.anrede;
    const einleitung = dok.einleitung || standardEinleitung;
    return beginntMitBegruessung(einleitung) ? '' : kundeAnrede(kunde);
  }
  function kundeGruss(kunde) { return kunde && kunde.anrede === 'du' ? 'Viele Grüße' : 'Mit freundlichen Grüßen'; }
  function standardTexte(kunde) {
    const du = kunde && kunde.anrede === 'du';
    return {
      angebotEinleitung: du ? 'vielen Dank für dein Interesse. Hier ist das besprochene Angebot:' : 'vielen Dank für Ihr Interesse. Hier ist das besprochene Angebot:',
      angebotSchluss: du ? 'Ich freue mich auf die Zusammenarbeit. Bei Fragen melde dich gern.' : 'Ich freue mich auf die Zusammenarbeit. Bei Fragen melden Sie sich gern.',
      rechnungEinleitung: du ? 'vielen Dank für die Zusammenarbeit. Hiermit stelle ich dir folgende Leistungen in Rechnung:' : 'vielen Dank für die Zusammenarbeit. Hiermit stelle ich Ihnen folgende Leistungen in Rechnung:',
      rechnungSchluss: du ? 'Vielen Dank für dein Vertrauen.' : 'Vielen Dank für Ihr Vertrauen.'
    };
  }
  function kundeSnapshot(k) {
    if (!k) return null;
    return { id: k.id, nummer: k.nummer, firma: k.firma, ansprechpartner: k.ansprechpartner, strasse: k.strasse, plz: k.plz, ort: k.ort, email: k.email, anrede: k.anrede };
  }
  function absenderSnapshot(s) {
    return { firma: s.firma, inhaberin: s.inhaberin, inhaberLabel: s.inhaberLabel || 'Inhaberin', marke: s.marke || null, logo: s.logo || null, strasse: s.strasse, plz: s.plz, ort: s.ort, steuernummer: s.steuernummer, telefon: s.telefon, email: s.email, website: s.website, bank: { ...s.bank } };
  }

  // ── Positionen & Summen ───────────────────────────────────
  function bereinigePositionen(liste) {
    if (!Array.isArray(liste)) return [];
    return liste.map(p => ({
      artikelNr: p.artikelNr ? String(p.artikelNr) : null,
      titel: String(p.titel || '').trim(),
      beschreibung: String(p.beschreibung || '').trim(),
      menge: Number(p.menge) > 0 ? Number(p.menge) : 1,
      einheit: String(p.einheit || 'Stück').trim(),
      einheitMehrzahl: String(p.einheitMehrzahl || '').trim(),
      einzelpreis: round2(p.einzelpreis),
      rabatt: Math.max(0, Math.min(100, Number(p.rabatt) || 0)),
      abrechnung: p.abrechnung === 'monatlich' ? 'monatlich' : 'einmalig'
    })).filter(p => p.titel);
  }
  // Zeilensumme einer Position inkl. Rabatt in Prozent
  function positionGesamt(p) {
    return round2((Number(p.menge) || 0) * (Number(p.einzelpreis) || 0) * (1 - (Number(p.rabatt) || 0) / 100));
  }
  function summen(positionen, kleinunternehmer) {
    const positionenSumme = round2(positionen.reduce((s, p) => s + (Number(p.menge) || 0) * (Number(p.einzelpreis) || 0), 0));
    const netto = round2(positionen.reduce((s, p) => s + positionGesamt(p), 0));
    const ust = kleinunternehmer ? 0 : round2(netto * UST_SATZ / 100);
    return { positionenSumme, rabatt: round2(positionenSumme - netto), netto, ust, brutto: round2(netto + ust), ustSatz: kleinunternehmer ? 0 : UST_SATZ };
  }
  function ratenplan(gesamt, anzahl, ersteRate) {
    anzahl = Math.max(1, Math.min(36, parseInt(anzahl, 10) || 1));
    const rate = round2(gesamt / anzahl);
    const raten = [];
    let verteilt = 0;
    for (let i = 1; i <= anzahl; i++) {
      const betrag = i === anzahl ? round2(gesamt - verteilt) : rate; // Rundungsdifferenz auf die letzte Rate
      verteilt = round2(verteilt + betrag);
      raten.push({ nr: i, faelligAm: plusMonate(ersteRate, i - 1), betrag });
    }
    return raten;
  }

  // ── Angebot: Ansicht mit berechneten Feldern ──────────────
  function angebotAnsicht(a) {
    const einmalig = a.positionen.filter(p => p.abrechnung === 'einmalig');
    const monatlich = a.positionen.filter(p => p.abrechnung === 'monatlich');
    const s = summen(einmalig, a.kleinunternehmer);
    const zahlung = { art: a.zahlung.art, anzahl: a.zahlung.anzahl || 1, ersteRate: a.zahlung.ersteRate || null, raten: [], anzahlungProzent: a.zahlung.anzahlungProzent || 50, anzahlungText: a.zahlung.anzahlungText || 'bei Auftragserteilung', restText: a.zahlung.restText || 'nach Abschluss des Projekts' };
    if (zahlung.art === 'anzahlung') {
      zahlung.anzahlungBetrag = round2(s.brutto * zahlung.anzahlungProzent / 100);
      zahlung.restBetrag = round2(s.brutto - zahlung.anzahlungBetrag);
    }
    if (zahlung.art === 'raten') {
      const erste = istDatum(zahlung.ersteRate) ? zahlung.ersteRate : plusTage(a.datum, 14);
      zahlung.ersteRate = erste;
      zahlung.raten = ratenplan(s.brutto, zahlung.anzahl, erste);
    }
    let status = a.status;
    if (status === 'versendet' && a.gueltigBis < heute()) status = 'abgelaufen';
    const monatlichSumme = round2(monatlich.reduce((x, p) => x + positionGesamt(p), 0));
    return { ...a, summen: s, zahlung, monatlichSumme, monatlichPositionen: monatlich, statusEffektiv: status };
  }
  function angebotPdfDaten(a, kunde, stamm) {
    const v = angebotAnsicht(a);
    const texte = standardTexte(kunde);
    return {
      angebot: {
        nummer: a.nummer, datum: a.datum, gueltigBis: a.gueltigBis, betreff: a.betreff,
        anrede: anredeFuer(a, kunde, texte.angebotEinleitung),
        einleitung: a.einleitung || texte.angebotEinleitung,
        positionen: v.positionen.filter(p => p.abrechnung === 'einmalig'),
        summen: v.summen,
        zahlung: v.zahlung,
        monatlich: v.monatlichPositionen.map(p => ({ titel: p.titel, preis: positionGesamt(p), einheit: 'Monat', start: a.monatlichStart || plusMonate(monatsAnfang(monatVon(a.datum)), 1) })),
        projektvereinbarung: a.projektvereinbarung !== false,
        schlusstext: a.schlusstext || texte.angebotSchluss,
        gruss: a.gruss || kundeGruss(kunde)
      },
      kunde: kundeSnapshot(kunde), absender: absenderSnapshot(stamm), kleinunternehmer: !!a.kleinunternehmer
    };
  }

  // ── Rechnung: Ansicht & PDF-Daten ─────────────────────────
  function rechnungAnsicht(r) {
    const s = summen(r.positionen, r.kleinunternehmer);
    let zahlungsstatus = r.zahlung.status;
    if (r.status !== 'finalisiert') zahlungsstatus = 'entwurf';
    else if (r.typ === 'storno') zahlungsstatus = 'storno';
    else if (r.storniertDurch) zahlungsstatus = 'storniert';
    else if (r.status === 'finalisiert' && zahlungsstatus === 'offen' && r.faelligAm && r.faelligAm < heute()) zahlungsstatus = 'ueberfaellig';
    const mahnungen = r.mahnungen || [];
    return { ...r, summen: s, zahlungsstatus, mahnungen, versand: r.versand || [], mahnstufe: mahnungen.length, naechsteMahnung: mahnungen.length < 3 ? MAHN_TITEL[mahnungen.length + 1] : null };
  }
  function rechnungPdfDaten(r, kunde, stamm) {
    const texte = standardTexte(kunde);
    const s = summen(r.positionen, r.kleinunternehmer);
    return {
      rechnung: {
        nummer: r.nummer, typ: r.typ, datum: r.datum || heute(), faelligAm: r.faelligAm,
        leistungVon: r.leistungVon, leistungBis: r.leistungBis, titel: r.titel,
        anrede: anredeFuer(r, kunde, texte.rechnungEinleitung), du: kunde && kunde.anrede === 'du',
        einleitung: r.einleitung || texte.rechnungEinleitung,
        positionen: r.positionen, summen: s,
        bezug: { angebot: r.bezug.angebotNummer, rate: r.bezug.rate, ratenGesamt: r.bezug.ratenGesamt, original: r.bezug.originalNummer, anzahlung: !!r.bezug.anzahlung, schlussrechnung: !!r.bezug.schlussrechnung },
        schlusstext: r.schlusstext || texte.rechnungSchluss,
        gruss: r.gruss || kundeGruss(kunde),
        entwurf: r.status !== 'finalisiert'
      },
      kunde: kundeSnapshot(kunde), absender: absenderSnapshot(stamm), kleinunternehmer: !!r.kleinunternehmer
    };
  }
  function neueRechnung(felder) {
    const stamm = ladeStammdaten();
    return {
      id: neueId(), nummer: null, typ: 'rechnung', status: 'entwurf', quelle: 'manuell',
      kundeId: null, kunde: null, absender: null, kleinunternehmer: !!stamm.kleinunternehmer,
      datum: null, faelligAm: null, leistungVon: heute(), leistungBis: heute(), geplantMonat: monatVon(heute()),
      titel: '', anrede: '', einleitung: '', schlusstext: '', gruss: '',
      positionen: [], bezug: {}, zahlung: { status: 'offen', bezahltAm: null },
      finalisiertAm: null, archivPfad: null, storniertDurch: null, mahnungen: [], versand: [],
      erstellt: new Date().toISOString(), geaendert: new Date().toISOString(),
      ...felder
    };
  }

  // ── Archiv ────────────────────────────────────────────────
  function archivOrdner(iso, art) {
    const [j, m] = iso.split('-');
    const dir = path.join(BUCHHALTUNG_DIR, j, m, art);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  function pdfDateiname(nummer, kunde, typ) {
    return `${nummer}_${dateiSlug(kunde && kunde.firma)}_${typ}.pdf`;
  }

  // ── Finalisieren / Storno ─────────────────────────────────
  async function finalisiere(r, felder = {}) {
    if (r.status === 'finalisiert') throw new Error('Rechnung ist bereits finalisiert.');
    const kunde = ladeKunden().find(k => k.id === r.kundeId);
    if (!kunde) throw new Error('Der Rechnung ist kein Kunde zugeordnet.');
    if (!r.positionen.length) throw new Error('Die Rechnung hat keine Positionen.');
    const stamm = ladeStammdaten();
    if (!stamm.steuernummer) throw new Error('Bitte zuerst die Steuernummer in den Stammdaten eintragen (Pflichtangabe nach § 14 UStG).');
    if (!stamm.bank.iban) throw new Error('Bitte zuerst die Bankverbindung in den Stammdaten eintragen.');
    const datum = istDatum(felder.datum) ? felder.datum : heute();
    r.datum = datum;
    r.faelligAm = istDatum(felder.faelligAm) ? felder.faelligAm : plusTage(datum, stamm.zahlungszielTage);
    r.kunde = kundeSnapshot(kunde);
    r.absender = absenderSnapshot(stamm);
    if (r.typ !== 'storno') r.kleinunternehmer = !!stamm.kleinunternehmer; // Storno übernimmt die Regelung der Originalrechnung
    r.anrede = anredeFuer(r, kunde, standardTexte(kunde).rechnungEinleitung);
    r.gruss = r.gruss || kundeGruss(kunde);
    r.einleitung = r.einleitung || standardTexte(kunde).rechnungEinleitung;
    r.schlusstext = r.schlusstext || standardTexte(kunde).rechnungSchluss;
    r.nummer = naechsteRechnungsnummer(datum.slice(0, 4));
    r.status = 'finalisiert';
    r.finalisiertAm = new Date().toISOString();
    r.geaendert = r.finalisiertAm;
    const pdf = await erzeugeRechnungPdf(rechnungPdfDaten(r, kunde, stamm));
    const datei = path.join(archivOrdner(datum, 'Einnahmen'), pdfDateiname(r.nummer, kunde, r.typ === 'storno' ? 'Stornorechnung' : 'Rechnung'));
    fs.writeFileSync(datei, pdf);
    r.archivPfad = path.relative(DATA_DIR, datei);
    speichere(RECHNUNGEN_DIR, r);
    return r;
  }

  // ── Abo-Lauf ──────────────────────────────────────────────
  // Legt zum Stichtag automatisch einen Rechnungsentwurf pro Abo und Monat an
  // (Leistungszeitraum = Kalendermonat). Gibt es im selben Monat für denselben
  // Kunden bereits einen offenen Raten-Entwurf, werden die Abo-Positionen dort
  // angehängt — eine Rechnung statt zwei.
  function aboLauf() {
    const stamm = ladeStammdaten();
    const stichtag = Math.max(1, Math.min(28, parseInt(stamm.aboStichtag, 10) || 1));
    const jetzt = heute();
    let angelegt = 0;
    for (const abo of ladeAlle(ABOS_DIR)) {
      if (!abo.aktiv) continue;
      let monat = abo.letzteAbrechnung ? naechsterMonat(abo.letzteAbrechnung) : monatVon(abo.start);
      let geaendert = false;
      while (true) {
        if (abo.ende && monat > monatVon(abo.ende)) { abo.aktiv = false; geaendert = true; break; }
        const faelligTag = `${monat}-${pad(stichtag, 2)}`;
        if (faelligTag > jetzt) break;
        const positionen = abo.positionen.map(p => ({
          artikelNr: p.artikelNr || null, titel: p.titel,
          beschreibung: [p.beschreibung, `Leistungszeitraum ${datumDe(monatsAnfang(monat))} – ${datumDe(monatsEnde(monat))}`].filter(Boolean).join(' '),
          menge: 1, einheit: 'Monat', einheitMehrzahl: 'Monate', einzelpreis: round2(p.preis), abrechnung: 'einmalig'
        }));
        const vorhandener = ladeAlle(RECHNUNGEN_DIR).find(r => r.status === 'entwurf' && r.typ === 'rechnung' && r.kundeId === abo.kundeId && r.geplantMonat === monat && !(r.bezug.aboIds || []).includes(abo.id));
        if (vorhandener) {
          vorhandener.positionen.push(...positionen);
          vorhandener.bezug.aboIds = [...(vorhandener.bezug.aboIds || []), abo.id];
          vorhandener.leistungVon = vorhandener.leistungVon < monatsAnfang(monat) ? vorhandener.leistungVon : monatsAnfang(monat);
          vorhandener.leistungBis = vorhandener.leistungBis > monatsEnde(monat) ? vorhandener.leistungBis : monatsEnde(monat);
          vorhandener.geaendert = new Date().toISOString();
          speichere(RECHNUNGEN_DIR, vorhandener);
        } else {
          speichere(RECHNUNGEN_DIR, neueRechnung({
            quelle: 'abo', kundeId: abo.kundeId, positionen,
            leistungVon: monatsAnfang(monat), leistungBis: monatsEnde(monat), geplantMonat: monat,
            titel: abo.titel || 'Monatliche Leistungen',
            bezug: { aboIds: [abo.id], angebotId: abo.angebotId || null, angebotNummer: abo.angebotNummer || null }
          }));
        }
        angelegt++;
        abo.letzteAbrechnung = monat;
        geaendert = true;
        monat = naechsterMonat(monat);
      }
      if (geaendert) speichere(ABOS_DIR, abo);
    }
    return angelegt;
  }

  // Saubere Adressen: /abrechnung und /abrechnung/<bereich> liefern die Oberfläche
  const SEITE = path.join(__dirname, '..', 'public_html', 'abrechnung.html');
  app.get(['/abrechnung', '/abrechnung/:bereich'], (req, res) => res.sendFile(SEITE));

  const ok = (res, daten) => res.json({ success: true, ...daten });
  const fehler = (res, code, text) => res.status(code).json({ success: false, error: text });
  const asyncRoute = fn => (req, res) => fn(req, res).catch(e => { console.error('Abrechnung:', e.message); fehler(res, 400, e.message); });

  // ── Stammdaten ────────────────────────────────────────────
  app.get('/api/abrechnung/stammdaten', (req, res) => ok(res, { stammdaten: ladeStammdaten() }));
  app.put('/api/abrechnung/stammdaten', express.json({ limit: '3mb' }), asyncRoute(async (req, res) => {
    const b = req.body || {};
    const alt = ladeStammdaten();
    const neu = {
      ...alt,
      firma: String(b.firma ?? alt.firma).trim(), inhaberin: String(b.inhaberin ?? alt.inhaberin).trim(),
      strasse: String(b.strasse ?? alt.strasse).trim(), plz: String(b.plz ?? alt.plz).trim(), ort: String(b.ort ?? alt.ort).trim(),
      steuernummer: String(b.steuernummer ?? alt.steuernummer).trim(), telefon: String(b.telefon ?? alt.telefon).trim(),
      email: String(b.email ?? alt.email).trim(), website: String(b.website ?? alt.website).trim(),
      bank: { ...alt.bank, ...(b.bank || {}) },
      kleinunternehmer: b.kleinunternehmer === undefined ? alt.kleinunternehmer : !!b.kleinunternehmer,
      zahlungszielTage: Math.max(0, parseInt(b.zahlungszielTage ?? alt.zahlungszielTage, 10) || 0),
      angebotGueltigTage: Math.max(1, parseInt(b.angebotGueltigTage ?? alt.angebotGueltigTage, 10) || 14),
      aboStichtag: Math.max(1, Math.min(28, parseInt(b.aboStichtag ?? alt.aboStichtag, 10) || 1)),
      mahnfristTage: Math.max(1, parseInt(b.mahnfristTage ?? alt.mahnfristTage, 10) || 7),
      mahngebuehr2: Math.max(0, round2(b.mahngebuehr2 ?? alt.mahngebuehr2)),
      mahngebuehr3: Math.max(0, round2(b.mahngebuehr3 ?? alt.mahngebuehr3)),
      sicherungMail: {
        aktiv: b.sicherungMail && b.sicherungMail.aktiv !== undefined ? !!b.sicherungMail.aktiv : (alt.sicherungMail || {}).aktiv !== false,
        an: String((b.sicherungMail && b.sicherungMail.an) ?? (alt.sicherungMail || {}).an ?? '').trim(),
        rhythmusTage: Math.max(1, Math.min(31, parseInt((b.sicherungMail && b.sicherungMail.rhythmusTage) ?? (alt.sicherungMail || {}).rhythmusTage, 10) || 7))
      }
    };
    Object.keys(neu.bank).forEach(k => { neu.bank[k] = String(neu.bank[k] || '').trim(); });
    // Logo (Betriebe): Bild als Data-URL, max. ca. 500 KB; null entfernt es
    let logoNeu;
    if ('logo' in b) {
      if (b.logo === null || b.logo === '') logoNeu = null;
      else if (typeof b.logo === 'string' && /^data:image\/(png|jpe?g);base64,/.test(b.logo) && b.logo.length <= 700000) logoNeu = b.logo;
      else throw new Error('Logo muss ein PNG- oder JPG-Bild sein (max. ca. 500 KB).');
    }
    delete neu.logo; // Logo liegt beim Betrieb, nicht in der Datenbank der Abrechnung
    speichereStammdaten(neu);
    if (ctx.speichereFirma) ctx.speichereFirma(neu, logoNeu);
    ok(res, { stammdaten: ladeStammdaten() });
  }));

  // ── Artikel ───────────────────────────────────────────────
  app.get('/api/abrechnung/artikel', (req, res) => ok(res, { artikel: ladeArtikel() }));
  function artikelAusBody(b, alt = {}) {
    const a = {
      nr: String(b.nr ?? alt.nr ?? '').trim().toUpperCase(),
      titel: String(b.titel ?? alt.titel ?? '').trim(),
      beschreibung: String(b.beschreibung ?? alt.beschreibung ?? '').trim(),
      preis: round2(b.preis ?? alt.preis),
      abrechnung: (b.abrechnung ?? alt.abrechnung) === 'monatlich' ? 'monatlich' : 'einmalig',
      einheit: String(b.einheit ?? alt.einheit ?? '').trim(),
      einheitMehrzahl: String(b.einheitMehrzahl ?? alt.einheitMehrzahl ?? '').trim(),
      aktiv: b.aktiv === undefined ? alt.aktiv !== false : !!b.aktiv
    };
    if (!a.einheit) a.einheit = a.abrechnung === 'monatlich' ? 'Monat' : 'Paket';
    if (!a.einheitMehrzahl) a.einheitMehrzahl = { Paket: 'Pakete', Monat: 'Monate', Stunde: 'Stunden', Stück: 'Stück' }[a.einheit] || a.einheit;
    if (!/^[A-Z]{2,4}-\d{3}$/.test(a.nr)) throw new Error('Artikelnummer im Format AB-001 angeben.');
    if (!a.titel) throw new Error('Bezeichnung fehlt.');
    return a;
  }
  app.post('/api/abrechnung/artikel', asyncRoute(async (req, res) => {
    const liste = ladeArtikel();
    const a = artikelAusBody(req.body || {});
    if (liste.some(x => x.nr === a.nr)) throw new Error(`Artikelnummer ${a.nr} ist bereits vergeben.`);
    liste.push(a); speichereArtikelListe(liste);
    ok(res, { artikel: a });
  }));
  app.put('/api/abrechnung/artikel/:nr', asyncRoute(async (req, res) => {
    const liste = ladeArtikel();
    const i = liste.findIndex(x => x.nr === String(req.params.nr).toUpperCase());
    if (i < 0) throw new Error('Artikel nicht gefunden.');
    const a = artikelAusBody(req.body || {}, liste[i]);
    if (a.nr !== liste[i].nr && liste.some(x => x.nr === a.nr)) throw new Error(`Artikelnummer ${a.nr} ist bereits vergeben.`);
    liste[i] = a; speichereArtikelListe(liste);
    ok(res, { artikel: a });
  }));
  app.delete('/api/abrechnung/artikel/:nr', (req, res) => {
    loesche('artikel', String(req.params.nr).toUpperCase());
    ok(res, {});
  });

  // ── Kunden ────────────────────────────────────────────────
  function kundeAusBody(b, alt = {}) {
    const k = {
      firma: String(b.firma ?? alt.firma ?? '').trim(),
      ansprechpartner: String(b.ansprechpartner ?? alt.ansprechpartner ?? '').trim(),
      strasse: String(b.strasse ?? alt.strasse ?? '').trim(),
      plz: String(b.plz ?? alt.plz ?? '').trim(),
      ort: String(b.ort ?? alt.ort ?? '').trim(),
      email: String(b.email ?? alt.email ?? '').trim(),
      anrede: (b.anrede ?? alt.anrede) === 'du' ? 'du' : 'sie'
    };
    if (!k.firma && !k.ansprechpartner) throw new Error('Firma oder Ansprechpartner angeben.');
    if (!k.firma) k.firma = k.ansprechpartner;
    return k;
  }
  function kundeStatistik(k) {
    const angebote = ladeAlle(ANGEBOTE_DIR).filter(a => a.kundeId === k.id);
    const rechnungen = ladeAlle(RECHNUNGEN_DIR).filter(r => r.kundeId === k.id);
    const abos = ladeAlle(ABOS_DIR).filter(a => a.kundeId === k.id);
    const offen = rechnungen.map(rechnungAnsicht).filter(r => r.status === 'finalisiert' && (r.zahlungsstatus === 'offen' || r.zahlungsstatus === 'ueberfaellig'));
    return { angebote: angebote.length, rechnungen: rechnungen.length, abos: abos.filter(a => a.aktiv).length, offenerBetrag: round2(offen.reduce((s, r) => s + r.summen.brutto, 0)) };
  }
  app.get('/api/abrechnung/kunden', (req, res) => ok(res, { kunden: ladeKunden().map(k => ({ ...k, statistik: kundeStatistik(k) })) }));
  app.post('/api/abrechnung/kunden', asyncRoute(async (req, res) => {
    const liste = ladeKunden();
    const k = { id: neueId(), nummer: naechsteKundennummer(), ...kundeAusBody(req.body || {}), angelegt: new Date().toISOString() };
    liste.push(k); speichereKundenListe(liste);
    ok(res, { kunde: k });
  }));
  app.put('/api/abrechnung/kunden/:id', asyncRoute(async (req, res) => {
    const liste = ladeKunden();
    const i = liste.findIndex(x => x.id === req.params.id);
    if (i < 0) throw new Error('Kunde nicht gefunden.');
    liste[i] = { ...liste[i], ...kundeAusBody(req.body || {}, liste[i]) };
    speichere('kunden', liste[i]);
    ok(res, { kunde: liste[i] });
  }));
  app.delete('/api/abrechnung/kunden/:id', asyncRoute(async (req, res) => {
    const liste = ladeKunden();
    const k = liste.find(x => x.id === req.params.id);
    if (!k) throw new Error('Kunde nicht gefunden.');
    const st = kundeStatistik(k);
    if (st.angebote || st.rechnungen || ladeAlle(ABOS_DIR).some(a => a.kundeId === k.id)) throw new Error('Kunde hat bereits Dokumente und kann nicht gelöscht werden.');
    loesche('kunden', k.id);
    ok(res, {});
  }));

  // ── Angebote ──────────────────────────────────────────────
  function angebotAusBody(b, alt) {
    const stamm = ladeStammdaten();
    const kunden = ladeKunden();
    const kundeId = String(b.kundeId ?? alt.kundeId ?? '');
    if (!kunden.some(k => k.id === kundeId)) throw new Error('Bitte einen Kunden auswählen.');
    const datum = istDatum(b.datum) ? b.datum : (alt.datum || heute());
    const zahlungAlt = alt.zahlung || {};
    const zahlungNeu = b.zahlung || {};
    const a = {
      ...alt,
      kundeId, datum,
      gueltigBis: istDatum(b.gueltigBis) ? b.gueltigBis : (alt.gueltigBis || plusTage(datum, stamm.angebotGueltigTage)),
      betreff: String(b.betreff ?? alt.betreff ?? '').trim(),
      anrede: String(b.anrede ?? alt.anrede ?? '').trim(),
      einleitung: String(b.einleitung ?? alt.einleitung ?? '').trim(),
      schlusstext: String(b.schlusstext ?? alt.schlusstext ?? '').trim(),
      gruss: String(b.gruss ?? alt.gruss ?? '').trim(),
      positionen: b.positionen !== undefined ? bereinigePositionen(b.positionen) : (alt.positionen || []),
      zahlung: {
        art: ['raten', 'anzahlung'].includes(zahlungNeu.art ?? zahlungAlt.art) ? (zahlungNeu.art ?? zahlungAlt.art) : 'einmal',
        anzahl: Math.max(1, Math.min(36, parseInt(zahlungNeu.anzahl ?? zahlungAlt.anzahl, 10) || 1)),
        ersteRate: istDatum(zahlungNeu.ersteRate) ? zahlungNeu.ersteRate : (zahlungAlt.ersteRate || null),
        // Anzahlung + Schlussrechnung (z. B. 50 % bei Auftrag, 50 % nach Abschluss)
        anzahlungProzent: Math.max(1, Math.min(99, round2(zahlungNeu.anzahlungProzent ?? zahlungAlt.anzahlungProzent) || 50)),
        anzahlungText: String(zahlungNeu.anzahlungText ?? zahlungAlt.anzahlungText ?? '').trim() || 'bei Auftragserteilung',
        restText: String(zahlungNeu.restText ?? zahlungAlt.restText ?? '').trim() || 'nach Abschluss des Projekts'
      },
      monatlichStart: istDatum(b.monatlichStart) ? b.monatlichStart : (alt.monatlichStart || null),
      projektvereinbarung: b.projektvereinbarung === undefined ? alt.projektvereinbarung !== false : !!b.projektvereinbarung,
      kleinunternehmer: alt.kleinunternehmer === undefined ? !!stamm.kleinunternehmer : alt.kleinunternehmer,
      geaendert: new Date().toISOString()
    };
    if (a.zahlung.art === 'raten' && !a.zahlung.ersteRate) a.zahlung.ersteRate = plusTage(datum, 14);
    if (!a.betreff) a.betreff = a.positionen.length ? a.positionen[0].titel : 'Angebot';
    return a;
  }
  function angebotMitKunde(a) {
    const kunde = ladeKunden().find(k => k.id === a.kundeId) || a.kunde || null;
    return { ...angebotAnsicht(a), kunde: kundeSnapshot(kunde) };
  }
  app.get('/api/abrechnung/angebote', (req, res) => {
    const liste = ladeAlle(ANGEBOTE_DIR).map(angebotMitKunde).sort((x, y) => (y.nummer > x.nummer ? 1 : -1));
    ok(res, { angebote: liste });
  });
  app.get('/api/abrechnung/angebote/:id', (req, res) => {
    const a = ladeEins(ANGEBOTE_DIR, req.params.id);
    if (!a) return fehler(res, 404, 'Angebot nicht gefunden.');
    ok(res, { angebot: angebotMitKunde(a) });
  });
  app.post('/api/abrechnung/angebote', asyncRoute(async (req, res) => {
    const b = req.body || {};
    const datum = istDatum(b.datum) ? b.datum : heute();
    const basis = { id: neueId(), nummer: naechsteAngebotsnummer(datum.slice(0, 4)), status: 'entwurf', umgewandelt: null, erstellt: new Date().toISOString() };
    const a = angebotAusBody(b, basis);
    speichere(ANGEBOTE_DIR, a);
    ok(res, { angebot: angebotMitKunde(a) });
  }));
  app.put('/api/abrechnung/angebote/:id', asyncRoute(async (req, res) => {
    const alt = ladeEins(ANGEBOTE_DIR, req.params.id);
    if (!alt) throw new Error('Angebot nicht gefunden.');
    if (alt.umgewandelt) throw new Error('Angebot wurde bereits in Rechnungen umgewandelt und ist gesperrt.');
    const a = angebotAusBody(req.body || {}, alt);
    speichere(ANGEBOTE_DIR, a);
    ok(res, { angebot: angebotMitKunde(a) });
  }));
  app.delete('/api/abrechnung/angebote/:id', asyncRoute(async (req, res) => {
    const a = ladeEins(ANGEBOTE_DIR, req.params.id);
    if (!a) throw new Error('Angebot nicht gefunden.');
    if (a.status !== 'entwurf') throw new Error('Nur Entwürfe können gelöscht werden. Versendete Angebote bitte auf „Abgelehnt“ setzen.');
    loesche(ANGEBOTE_DIR, a.id);
    ok(res, {});
  }));
  const ANGEBOT_STATUS = ['entwurf', 'versendet', 'angenommen', 'abgelehnt'];
  app.post('/api/abrechnung/angebote/:id/status', asyncRoute(async (req, res) => {
    const a = ladeEins(ANGEBOTE_DIR, req.params.id);
    if (!a) throw new Error('Angebot nicht gefunden.');
    const status = String((req.body || {}).status || '');
    if (!ANGEBOT_STATUS.includes(status)) throw new Error('Ungültiger Status.');
    if (a.umgewandelt && status !== 'angenommen') throw new Error('Umgewandelte Angebote bleiben auf „Angenommen“.');
    if (status === 'entwurf' && a.status !== 'entwurf') throw new Error('Ein versendetes Angebot kann nicht zurück in den Entwurf.');
    if (status === 'versendet' && !a.positionen.length) throw new Error('Das Angebot hat keine Positionen.');
    if (status === 'versendet') await angebotVersenden(a);
    a.status = status;
    a.geaendert = new Date().toISOString();
    speichere(ANGEBOTE_DIR, a);
    ok(res, { angebot: angebotMitKunde(a) });
  }));
  app.get('/api/abrechnung/angebote/:id/pdf', asyncRoute(async (req, res) => {
    const a = ladeEins(ANGEBOTE_DIR, req.params.id);
    if (!a) throw new Error('Angebot nicht gefunden.');
    const kunde = ladeKunden().find(k => k.id === a.kundeId) || a.kunde;
    const stamm = ladeStammdaten();
    const pdf = await erzeugeAngebotPdf(angebotPdfDaten(a, kunde, stamm));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${pdfDateiname(a.nummer, kunde, 'Angebot')}"`);
    res.send(pdf);
  }));

  // Versendeter Stand wird als PDF unverändert archiviert.
  async function angebotVersenden(a) {
    const kunde = ladeKunden().find(k => k.id === a.kundeId);
    const stamm = ladeStammdaten();
    a.kunde = kundeSnapshot(kunde); a.absender = absenderSnapshot(stamm);
    const pdf = await erzeugeAngebotPdf(angebotPdfDaten(a, kunde, stamm));
    const datei = path.join(archivOrdner(a.datum, 'Angebote'), pdfDateiname(a.nummer, kunde, 'Angebot'));
    fs.writeFileSync(datei, pdf);
    a.archivPfad = path.relative(DATA_DIR, datei);
    (a.anhaenge || []).forEach(n => { try { fs.copyFileSync(anhangPfad(a, n), path.join(path.dirname(datei), `${a.nummer}_${n}`)); } catch (e) { /* Anhang fehlt */ } });
    a.versendetAm = a.versendetAm || new Date().toISOString();
    a.status = 'versendet';
    return pdf;
  }

  // ── E-Mail ────────────────────────────────────────────────
  app.get('/api/abrechnung/kontext', (req, res) => {
    const stamm = ladeStammdaten();
    ok(res, { admin: !!ctx.istAdmin, nurLesen: !!ctx.nurLesen, mandant: ctx.id, firma: stamm.firma, inhaberLabel: stamm.inhaberLabel || 'Inhaberin', emailMoeglich: !!ctx.email && mail.konfiguration().konfiguriert, emailErlaubt: !!ctx.email, kiVerfuegbar: !!(ctx.ki && ctx.ki.client), logoErlaubt: !!ctx.speichereFirma });
  });
  app.get('/api/abrechnung/email/status', (req, res) => {
    const k = mail.konfiguration();
    ok(res, { konfiguriert: !!ctx.email && k.konfiguriert, von: ctx.email && k.konfiguriert ? k.von : null });
  });
  // Test-E-Mail an die eigene Adresse, um die SMTP-Einrichtung zu prüfen
  app.post('/api/abrechnung/email/test', asyncRoute(async (req, res) => {
    const stamm = ladeStammdaten();
    const an = mail.nurAdresse((req.body || {}).an || stamm.email || mail.konfiguration().von || '');
    if (!an) throw new Error('Bitte zuerst eine E-Mail-Adresse in den Stammdaten eintragen.');
    const ergebnis = await mail.sende({ an, betreff: 'Test-E-Mail aus der NovaFlow-Abrechnung', text: `Diese Test-E-Mail wurde am ${datumDe(heute())} aus dem Abrechnungsbereich von tool.novaflowservices.de gesendet. Wenn sie ankommt, ist der Versand korrekt eingerichtet.\n\n${stamm.firma}` });
    ok(res, { an: ergebnis.an });
  }));
  function emailVorlage(typ, dok, kunde, stamm, extra = {}) {
    const du = kunde && kunde.anrede === 'du';
    const anrede = kundeAnrede(kunde);
    const gruss = `${kundeGruss(kunde)}\n${stamm.inhaberin}\n${stamm.firma}${stamm.telefon ? '\n' + stamm.telefon : ''}${stamm.website ? '\n' + stamm.website : ''}`;
    let betreff, text;
    if (typ === 'angebot') {
      betreff = `Angebot ${dok.nummer} – ${dok.betreff || stamm.firma}`;
      const mitPv = (dok.anhaenge || []).length ? (du ? ' sowie die Projektvereinbarung' : ' sowie die Projektvereinbarung') : '';
      text = `${anrede}\n\n${du ? 'wie besprochen findest du' : 'wie besprochen finden Sie'} im Anhang das Angebot ${dok.nummer}${mitPv}. Es ist gültig bis ${datumDe(dok.gueltigBis)}.\n\n${du ? 'Wenn du Fragen hast, melde dich gern. Ich freue mich auf die Zusammenarbeit!' : 'Bei Fragen melden Sie sich gern. Ich freue mich auf die Zusammenarbeit!'}\n\n${gruss}`;
    } else if (typ === 'mahnung') {
      const m = extra.mahnung;
      betreff = `${MAHN_TITEL[m.stufe]} zu Rechnung ${dok.nummer}`;
      text = `${anrede}\n\n${du ? 'im Anhang findest du' : 'im Anhang finden Sie'} ${m.stufe === 1 ? 'eine Zahlungserinnerung' : 'eine Mahnung'} zur Rechnung ${dok.nummer} vom ${datumDe(dok.datum)} über ${euroText(summen(dok.positionen, dok.kleinunternehmer).brutto)}. ${du ? 'Bitte überweise' : 'Bitte überweisen Sie'} den Betrag bis zum ${datumDe(m.frist)}.\n\n${du ? 'Falls du bereits gezahlt hast, betrachte diese Nachricht bitte als gegenstandslos.' : 'Falls Sie bereits gezahlt haben, betrachten Sie diese Nachricht bitte als gegenstandslos.'}\n\n${gruss}`;
    } else if (dok.typ === 'storno') {
      betreff = `Stornorechnung ${dok.nummer} zu Rechnung ${dok.bezug.originalNummer}`;
      text = `${anrede}\n\n${du ? 'im Anhang findest du' : 'im Anhang finden Sie'} die Stornorechnung ${dok.nummer} zur Rechnung ${dok.bezug.originalNummer}.\n\n${gruss}`;
    } else {
      betreff = `Rechnung ${dok.nummer}${dok.titel ? ' – ' + dok.titel : ''}`;
      text = `${anrede}\n\n${du ? 'im Anhang findest du' : 'im Anhang finden Sie'} die Rechnung ${dok.nummer} über ${euroText(summen(dok.positionen, dok.kleinunternehmer).brutto)}${dok.bezug.rate ? ` (Rate ${dok.bezug.rate} von ${dok.bezug.ratenGesamt} zum Angebot ${dok.bezug.angebotNummer})` : ''}. ${du ? 'Bitte überweise' : 'Bitte überweisen Sie'} den Betrag bis zum ${datumDe(dok.faelligAm)} mit dem Verwendungszweck ${dok.nummer}.\n\n${du ? 'Vielen Dank für dein Vertrauen!' : 'Vielen Dank für Ihr Vertrauen!'}\n\n${gruss}`;
    }
    return { an: (kunde && kunde.email) || '', betreff, text };
  }
  function euroText(n) { return round2(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
  async function versende(body, vorlage, anhaenge, stamm) {
    if (!ctx.email) throw new Error('E-Mail-Versand ist in diesem Konto nicht verfügbar. Bitte das PDF herunterladen und selbst versenden.');
    const an = String((body || {}).an || vorlage.an || '').trim();
    const betreff = String((body || {}).betreff || vorlage.betreff);
    const text = String((body || {}).text || vorlage.text);
    const ergebnis = await mail.sende({ an, betreff, text, anhaenge, antwortAn: stamm.email || undefined, kopie: !!(body || {}).kopie });
    return { am: new Date().toISOString(), an: ergebnis.an, betreff };
  }

  // ── Anhänge am Angebot (z. B. Projektvereinbarung als PDF) ──
  // Werden beim E-Mail-Versand automatisch mitgeschickt und beim Versand mit archiviert.
  const ANHAENGE_DIR = path.join(BASIS, 'anhaenge');
  fs.mkdirSync(ANHAENGE_DIR, { recursive: true });
  function anhangPfad(a, name) { return path.join(ANHAENGE_DIR, `${a.id}_${name}`); }
  function angebotAnhaenge(a) {
    return (a.anhaenge || []).map(n => ({ filename: n, content: fs.readFileSync(anhangPfad(a, n)) })).filter(x => x.content);
  }
  app.post('/api/abrechnung/angebote/:id/anhang', express.json({ limit: '25mb' }), asyncRoute(async (req, res) => {
    const a = ladeEins(ANGEBOTE_DIR, req.params.id);
    if (!a) throw new Error('Angebot nicht gefunden.');
    if (a.umgewandelt) throw new Error('Angebot ist bereits umgewandelt und gesperrt.');
    const b = req.body || {};
    const name = String(b.name || '').replace(/[^A-Za-z0-9äöüÄÖÜß ._-]/g, '_').trim();
    if (!/\.pdf$/i.test(name)) throw new Error('Bitte eine PDF-Datei anhängen.');
    const daten = Buffer.from(String(b.daten || '').replace(/^data:.*?;base64,/, ''), 'base64');
    if (!daten.length || daten.slice(0, 4).toString() !== '%PDF') throw new Error('Die Datei ist keine gültige PDF.');
    if (daten.length > 15 * 1024 * 1024) throw new Error('Die Datei ist zu groß (max. 15 MB).');
    fs.writeFileSync(anhangPfad(a, name), daten);
    a.anhaenge = [...new Set([...(a.anhaenge || []), name])];
    a.geaendert = new Date().toISOString();
    speichere(ANGEBOTE_DIR, a);
    ok(res, { angebot: angebotMitKunde(a) });
  }));
  app.delete('/api/abrechnung/angebote/:id/anhang/:name', asyncRoute(async (req, res) => {
    const a = ladeEins(ANGEBOTE_DIR, req.params.id);
    if (!a) throw new Error('Angebot nicht gefunden.');
    if (a.umgewandelt) throw new Error('Angebot ist bereits umgewandelt und gesperrt.');
    const name = String(req.params.name);
    a.anhaenge = (a.anhaenge || []).filter(n => n !== name);
    try { fs.unlinkSync(anhangPfad(a, name)); } catch (e) { /* schon weg */ }
    speichere(ANGEBOTE_DIR, a);
    ok(res, { angebot: angebotMitKunde(a) });
  }));
  app.get('/api/abrechnung/angebote/:id/anhang/:name', (req, res) => {
    const a = ladeEins(ANGEBOTE_DIR, req.params.id);
    const name = String(req.params.name);
    if (!a || !(a.anhaenge || []).includes(name)) return fehler(res, 404, 'Anhang nicht gefunden.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    res.send(fs.readFileSync(anhangPfad(a, name)));
  });

  app.get('/api/abrechnung/angebote/:id/email', (req, res) => {
    const a = ladeEins(ANGEBOTE_DIR, req.params.id);
    if (!a) return fehler(res, 404, 'Angebot nicht gefunden.');
    const kunde = ladeKunden().find(k => k.id === a.kundeId) || a.kunde;
    ok(res, { vorlage: emailVorlage('angebot', a, kunde, ladeStammdaten()), versand: a.versand || [] });
  });
  app.post('/api/abrechnung/angebote/:id/email', asyncRoute(async (req, res) => {
    const a = ladeEins(ANGEBOTE_DIR, req.params.id);
    if (!a) throw new Error('Angebot nicht gefunden.');
    if (!a.positionen.length) throw new Error('Das Angebot hat keine Positionen.');
    const kunde = ladeKunden().find(k => k.id === a.kundeId) || a.kunde;
    const stamm = ladeStammdaten();
    // Beim Versand wird der Stand archiviert und das Angebot auf „Versendet“ gesetzt (falls noch Entwurf).
    const pdf = a.status === 'entwurf' ? await angebotVersenden(a) : await erzeugeAngebotPdf(angebotPdfDaten(a, kunde, stamm));
    const eintrag = await versende(req.body, emailVorlage('angebot', a, kunde, stamm), [{ filename: pdfDateiname(a.nummer, kunde, 'Angebot'), content: pdf }, ...angebotAnhaenge(a)], stamm);
    a.versand = [...(a.versand || []), eintrag];
    a.geaendert = new Date().toISOString();
    speichere(ANGEBOTE_DIR, a);
    ok(res, { angebot: angebotMitKunde(a), versand: eintrag });
  }));

  // In Rechnung(en) umwandeln
  app.post('/api/abrechnung/angebote/:id/umwandeln', asyncRoute(async (req, res) => {
    const a = ladeEins(ANGEBOTE_DIR, req.params.id);
    if (!a) throw new Error('Angebot nicht gefunden.');
    if (a.umgewandelt) throw new Error('Angebot wurde bereits umgewandelt.');
    if (a.status === 'entwurf') throw new Error('Bitte das Angebot zuerst auf „Versendet“ oder „Angenommen“ setzen.');
    if (a.status === 'abgelehnt') throw new Error('Ein abgelehntes Angebot kann nicht umgewandelt werden.');
    const v = angebotAnsicht(a);
    const einmalig = v.positionen.filter(p => p.abrechnung === 'einmalig');
    const rechnungen = [];
    const abos = [];
    const bezug = { angebotId: a.id, angebotNummer: a.nummer };
    const beschreibungPositionen = einmalig.map(p => `${p.menge} × ${p.titel}`).join(', ');

    if (einmalig.length && v.zahlung.art === 'einmal') {
      rechnungen.push(speichere(RECHNUNGEN_DIR, neueRechnung({
        quelle: 'angebot', kundeId: a.kundeId, kleinunternehmer: a.kleinunternehmer,
        positionen: einmalig, titel: a.betreff, geplantMonat: monatVon(heute()),
        leistungVon: heute(), leistungBis: heute(), bezug: { ...bezug }
      })));
    } else if (einmalig.length && v.zahlung.art === 'anzahlung') {
      const z = v.zahlung;
      const nettoAnz = a.kleinunternehmer ? z.anzahlungBetrag : round2(z.anzahlungBetrag / (1 + UST_SATZ / 100));
      rechnungen.push(speichere(RECHNUNGEN_DIR, neueRechnung({
        quelle: 'angebot', kundeId: a.kundeId, kleinunternehmer: a.kleinunternehmer,
        titel: `Anzahlung ${menge(z.anzahlungProzent)} % – ${a.betreff}`, geplantMonat: monatVon(heute()),
        leistungVon: heute(), leistungBis: heute(),
        positionen: [{ artikelNr: null, titel: `Anzahlung ${menge(z.anzahlungProzent)} % ${z.anzahlungText}`, beschreibung: `Anzahlung gemäß Angebot ${a.nummer} vom ${datumDe(a.datum)} (${beschreibungPositionen}). Der Restbetrag von ${euroText(z.restBetrag)} wird ${z.restText} in Rechnung gestellt.`, menge: 1, einheit: 'Pauschal', einheitMehrzahl: 'Pauschal', einzelpreis: nettoAnz, abrechnung: 'einmalig' }],
        bezug: { ...bezug, rate: 1, ratenGesamt: 2, anzahlung: true }
      })));
      // Schlussrechnung: alle Positionen, abzüglich der geleisteten Anzahlung
      rechnungen.push(speichere(RECHNUNGEN_DIR, neueRechnung({
        quelle: 'angebot', kundeId: a.kundeId, kleinunternehmer: a.kleinunternehmer,
        titel: `Schlussrechnung – ${a.betreff}`, geplantMonat: monatVon(heute()),
        leistungVon: heute(), leistungBis: heute(),
        positionen: [...einmalig, { artikelNr: null, titel: `abzüglich Anzahlung ${menge(z.anzahlungProzent)} %`, beschreibung: `Bereits mit der Anzahlungsrechnung zum Angebot ${a.nummer} berechnet.`, menge: 1, einheit: 'Pauschal', einheitMehrzahl: 'Pauschal', einzelpreis: round2(-nettoAnz), abrechnung: 'einmalig' }],
        bezug: { ...bezug, rate: 2, ratenGesamt: 2, schlussrechnung: true }
      })));
    } else if (einmalig.length && v.zahlung.art === 'raten') {
      const n = v.zahlung.raten.length;
      v.zahlung.raten.forEach(rate => {
        // Rate netto: bei USt-Pflicht ist der Ratenbetrag brutto, die Position wird netto geführt.
        const netto = a.kleinunternehmer ? rate.betrag : round2(rate.betrag / (1 + UST_SATZ / 100));
        rechnungen.push(speichere(RECHNUNGEN_DIR, neueRechnung({
          quelle: 'angebot', kundeId: a.kundeId, kleinunternehmer: a.kleinunternehmer,
          titel: a.betreff, geplantMonat: monatVon(rate.faelligAm),
          leistungVon: a.datum < rate.faelligAm ? a.datum : rate.faelligAm, leistungBis: rate.faelligAm,
          positionen: [{ artikelNr: null, titel: `${a.betreff} – Rate ${rate.nr} von ${n}`, beschreibung: `Teilzahlung gemäß Angebot ${a.nummer} vom ${datumDe(a.datum)} (${beschreibungPositionen}).`, menge: 1, einheit: 'Rate', einheitMehrzahl: 'Raten', einzelpreis: netto, abrechnung: 'einmalig' }],
          bezug: { ...bezug, rate: rate.nr, ratenGesamt: n, geplantFaellig: rate.faelligAm }
        })));
      });
    }
    if (v.monatlichPositionen.length) {
      const start = a.monatlichStart || plusMonate(monatsAnfang(monatVon(heute())), 1);
      abos.push(speichere(ABOS_DIR, {
        id: neueId(), kundeId: a.kundeId, angebotId: a.id, angebotNummer: a.nummer,
        titel: a.betreff, aktiv: true, start, ende: null, letzteAbrechnung: null,
        positionen: v.monatlichPositionen.map(p => ({ artikelNr: p.artikelNr, titel: p.titel, beschreibung: p.beschreibung, preis: positionGesamt(p) })),
        erstellt: new Date().toISOString()
      }));
    }
    a.status = 'angenommen';
    a.umgewandelt = { am: new Date().toISOString(), rechnungen: rechnungen.map(r => r.id), abos: abos.map(x => x.id) };
    a.geaendert = a.umgewandelt.am;
    speichere(ANGEBOTE_DIR, a);
    aboLauf();
    ok(res, { angebot: angebotMitKunde(a), rechnungen: rechnungen.map(rechnungAnsicht), abos });
  }));

  // ── Rechnungen ────────────────────────────────────────────
  function rechnungMitKunde(r) {
    const kunde = r.kunde || kundeSnapshot(ladeKunden().find(k => k.id === r.kundeId));
    return { ...rechnungAnsicht(r), kunde };
  }
  app.get('/api/abrechnung/rechnungen', (req, res) => {
    const liste = ladeAlle(RECHNUNGEN_DIR).map(rechnungMitKunde)
      .sort((x, y) => String(y.nummer || 'Z' + y.erstellt).localeCompare(String(x.nummer || 'Z' + x.erstellt)));
    ok(res, { rechnungen: liste });
  });
  app.get('/api/abrechnung/rechnungen/:id', (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) return fehler(res, 404, 'Rechnung nicht gefunden.');
    ok(res, { rechnung: rechnungMitKunde(r) });
  });
  function rechnungAusBody(b, alt) {
    const r = {
      ...alt,
      kundeId: b.kundeId !== undefined ? String(b.kundeId) : alt.kundeId,
      titel: String(b.titel ?? alt.titel ?? '').trim(),
      anrede: String(b.anrede ?? alt.anrede ?? '').trim(),
      einleitung: String(b.einleitung ?? alt.einleitung ?? '').trim(),
      schlusstext: String(b.schlusstext ?? alt.schlusstext ?? '').trim(),
      gruss: String(b.gruss ?? alt.gruss ?? '').trim(),
      leistungVon: istDatum(b.leistungVon) ? b.leistungVon : alt.leistungVon,
      leistungBis: istDatum(b.leistungBis) ? b.leistungBis : alt.leistungBis,
      datum: istDatum(b.datum) ? b.datum : alt.datum,
      faelligAm: istDatum(b.faelligAm) ? b.faelligAm : alt.faelligAm,
      positionen: b.positionen !== undefined ? bereinigePositionen(b.positionen).map(p => ({ ...p, abrechnung: 'einmalig' })) : alt.positionen,
      geaendert: new Date().toISOString()
    };
    if (!ladeKunden().some(k => k.id === r.kundeId)) throw new Error('Bitte einen Kunden auswählen.');
    if (r.leistungBis < r.leistungVon) r.leistungBis = r.leistungVon;
    r.geplantMonat = monatVon(r.leistungBis);
    return r;
  }
  app.post('/api/abrechnung/rechnungen', asyncRoute(async (req, res) => {
    const r = rechnungAusBody(req.body || {}, neueRechnung({}));
    speichere(RECHNUNGEN_DIR, r);
    ok(res, { rechnung: rechnungMitKunde(r) });
  }));
  app.put('/api/abrechnung/rechnungen/:id', asyncRoute(async (req, res) => {
    const alt = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!alt) throw new Error('Rechnung nicht gefunden.');
    if (alt.status === 'finalisiert') throw new Error('Finalisierte Rechnungen sind gesperrt. Änderungen nur per Storno-/Korrekturrechnung.');
    const r = rechnungAusBody(req.body || {}, alt);
    speichere(RECHNUNGEN_DIR, r);
    ok(res, { rechnung: rechnungMitKunde(r) });
  }));
  app.delete('/api/abrechnung/rechnungen/:id', asyncRoute(async (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) throw new Error('Rechnung nicht gefunden.');
    if (r.status === 'finalisiert') throw new Error('Finalisierte Rechnungen können nicht gelöscht werden (Aufbewahrungspflicht). Bitte stornieren.');
    loesche(RECHNUNGEN_DIR, r.id);
    ok(res, {});
  }));
  app.post('/api/abrechnung/rechnungen/:id/finalisieren', asyncRoute(async (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) throw new Error('Rechnung nicht gefunden.');
    await finalisiere(r, req.body || {});
    ok(res, { rechnung: rechnungMitKunde(r) });
  }));
  app.post('/api/abrechnung/rechnungen/:id/zahlung', asyncRoute(async (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) throw new Error('Rechnung nicht gefunden.');
    if (r.status !== 'finalisiert') throw new Error('Nur finalisierte Rechnungen haben einen Zahlungsstatus.');
    if (r.typ === 'storno' || r.storniertDurch) throw new Error('Stornierte Rechnungen haben keinen Zahlungsstatus.');
    const b = req.body || {};
    if (b.status === 'bezahlt') r.zahlung = { status: 'bezahlt', bezahltAm: istDatum(b.bezahltAm) ? b.bezahltAm : heute() };
    else if (b.status === 'offen') r.zahlung = { status: 'offen', bezahltAm: null };
    else throw new Error('Status muss „offen“ oder „bezahlt“ sein.');
    r.geaendert = new Date().toISOString();
    speichere(RECHNUNGEN_DIR, r);
    ok(res, { rechnung: rechnungMitKunde(r) });
  }));
  // Storno: finalisierte Rechnung wird durch eine Stornorechnung (eigene Nummer,
  // negative Beträge) aufgehoben. Optional entsteht eine Korrektur als neuer Entwurf.
  app.post('/api/abrechnung/rechnungen/:id/storno', asyncRoute(async (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) throw new Error('Rechnung nicht gefunden.');
    if (r.status !== 'finalisiert') throw new Error('Nur finalisierte Rechnungen können storniert werden. Entwürfe einfach löschen.');
    if (r.typ === 'storno') throw new Error('Eine Stornorechnung kann nicht storniert werden.');
    if (r.storniertDurch) throw new Error('Diese Rechnung wurde bereits storniert.');
    const storno = neueRechnung({
      typ: 'storno', quelle: 'storno', kundeId: r.kundeId, kleinunternehmer: r.kleinunternehmer,
      titel: r.titel, leistungVon: r.leistungVon, leistungBis: r.leistungBis,
      positionen: r.positionen.map(p => ({ ...p, einzelpreis: round2(-p.einzelpreis) })),
      bezug: { ...r.bezug, originalId: r.id, originalNummer: r.nummer },
      schlusstext: 'Der Betrag wird nicht fällig bzw. bereits gezahlte Beträge werden erstattet.'
    });
    await finalisiere(storno, {});
    storno.zahlung = { status: 'storno', bezahltAm: null };
    speichere(RECHNUNGEN_DIR, storno);
    r.storniertDurch = { id: storno.id, nummer: storno.nummer, am: storno.finalisiertAm };
    r.geaendert = new Date().toISOString();
    speichere(RECHNUNGEN_DIR, r);
    let korrektur = null;
    if ((req.body || {}).korrektur) {
      korrektur = speichere(RECHNUNGEN_DIR, neueRechnung({
        quelle: 'korrektur', kundeId: r.kundeId, kleinunternehmer: ladeStammdaten().kleinunternehmer,
        titel: r.titel, anrede: r.anrede, einleitung: r.einleitung, schlusstext: '', gruss: r.gruss,
        leistungVon: r.leistungVon, leistungBis: r.leistungBis, geplantMonat: r.geplantMonat,
        positionen: r.positionen.map(p => ({ ...p })),
        bezug: { ...r.bezug, korrekturZu: r.nummer }
      }));
    }
    ok(res, { storno: rechnungMitKunde(storno), original: rechnungMitKunde(r), korrektur: korrektur && rechnungMitKunde(korrektur) });
  }));
  // ── KI-Vorschlag für ein Angebot ──────────────────────────
  // Aus einer freien Auftragsbeschreibung macht die KI Betreff, Einleitung,
  // Positionen (bevorzugt aus dem eigenen Artikelkatalog) und Schlusstext.
  // Preise sind Vorschläge und werden im Editor geprüft.
  app.post('/api/abrechnung/ki/angebot', asyncRoute(async (req, res) => {
    if (!ctx.ki || !ctx.ki.client) throw new Error('KI ist auf diesem Server nicht eingerichtet (ANTHROPIC_API_KEY fehlt).');
    if (ctx.ki.rateLimit && !ctx.ki.rateLimit(req)) throw new Error(`Tageslimit erreicht (max. ${ctx.ki.limit} KI-Vorschläge pro Tag).`);
    const b = req.body || {};
    const beschreibung = String(b.beschreibung || '').trim();
    if (beschreibung.length < 10) throw new Error('Bitte den Auftrag kurz beschreiben (mindestens ein Satz).');
    const kunde = ladeKunden().find(k => k.id === b.kundeId) || null;
    const stamm = ladeStammdaten();
    const artikel = ladeArtikel().filter(a => a.aktiv !== false);
    const katalog = artikel.length ? artikel.map(a => `- ${a.nr}: ${a.titel} – ${round2(a.preis)} € pro ${a.einheit} (${a.abrechnung}) – ${a.beschreibung || ''}`).join('\n') : '(leer)';
    const du = kunde && kunde.anrede === 'du';
    const prompt = `Du hilfst dem Unternehmen "${stamm.firma}" (${stamm.kleinunternehmer ? 'Kleinunternehmer, Preise ohne USt' : 'Preise netto zzgl. 19 % USt'}), ein professionelles deutsches Angebot zu formulieren.

AUFTRAGSBESCHREIBUNG:
${beschreibung}

${kunde ? `KUNDE: ${kunde.firma}${kunde.ansprechpartner ? ', Ansprechpartner ' + kunde.ansprechpartner : ''} (Anrede: ${du ? 'Du' : 'Sie'})` : 'KUNDE: nicht angegeben (Sie-Form)'}

ARTIKELKATALOG (bevorzugt verwenden, Preise und Einheiten übernehmen):
${katalog}

Regeln:
- 2 bis 6 Positionen, fachlich sinnvoll gegliedert. Passt ein Katalogartikel, nutze seine "artikelNr" und seinen Preis.
- Für freie Positionen: realistischen Einzelpreis in Euro schätzen, Einheit sinnvoll wählen (Stunde/Stunden, Paket/Pakete, Stück/Stück, Pauschal/Pauschal, Monat/Monate).
- "abrechnung": "monatlich" nur für laufende Leistungen (Wartung, Hosting, Betreuung), sonst "einmalig".
- Einleitung: 1–2 Sätze, ${du ? 'Du-Form' : 'Sie-Form'}, OHNE Anrede/Begrüßung am Anfang (die setzt das Tool).
- Schlusstext: 1 Satz, freundlich, ${du ? 'Du-Form' : 'Sie-Form'}.
- Keine Preise im Fließtext.

Antworte NUR mit gültigem JSON, kein Text davor oder danach:
{
  "betreff": "kurzer Betreff",
  "einleitung": "...",
  "positionen": [
    { "artikelNr": "AB-001 oder null", "titel": "...", "beschreibung": "1–2 Sätze", "menge": 1, "einheit": "Stunde", "einheitMehrzahl": "Stunden", "einzelpreis": 0, "abrechnung": "einmalig" }
  ],
  "schlusstext": "..."
}`;
    const antwort = await ctx.ki.client.messages.create({ model: ctx.ki.model || 'claude-haiku-4-5', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
    const text = (antwort.content && antwort.content[0] && antwort.content[0].text || '').trim();
    const a0 = text.indexOf('{'), a1 = text.lastIndexOf('}');
    if (a0 < 0 || a1 < 0) throw new Error('Die KI hat keine verwertbare Antwort geliefert, bitte noch einmal versuchen.');
    let ki;
    try { ki = JSON.parse(text.slice(a0, a1 + 1)); } catch (e) { throw new Error('Die KI-Antwort war nicht lesbar, bitte noch einmal versuchen.'); }
    const positionen = (Array.isArray(ki.positionen) ? ki.positionen : []).map(p => {
      const art = p.artikelNr ? artikel.find(a => a.nr === String(p.artikelNr).toUpperCase()) : null;
      return {
        artikelNr: art ? art.nr : null,
        titel: String((art && art.titel) || p.titel || '').trim(),
        beschreibung: String(p.beschreibung || (art && art.beschreibung) || '').trim(),
        menge: Number(p.menge) > 0 ? Number(p.menge) : 1,
        einheit: String((art && art.einheit) || p.einheit || 'Stück').trim(),
        einheitMehrzahl: String((art && art.einheitMehrzahl) || p.einheitMehrzahl || '').trim(),
        einzelpreis: art ? round2(art.preis) : round2(p.einzelpreis),
        rabatt: 0,
        abrechnung: (art ? art.abrechnung : p.abrechnung) === 'monatlich' ? 'monatlich' : 'einmalig'
      };
    }).filter(p => p.titel);
    if (!positionen.length) throw new Error('Die KI hat keine Positionen vorgeschlagen, bitte die Beschreibung präzisieren.');
    ok(res, { vorschlag: { betreff: String(ki.betreff || '').trim(), einleitung: String(ki.einleitung || '').trim(), schlusstext: String(ki.schlusstext || '').trim(), positionen } });
  }));

  // Kennzahlen für die Admin-Übersicht
  function statistik() {
    const rechnungen = ladeAlle(RECHNUNGEN_DIR).map(rechnungAnsicht);
    const angebote = ladeAlle(ANGEBOTE_DIR).map(angebotAnsicht);
    const zeiten = [...rechnungen, ...angebote].map(x => x.geaendert || x.erstellt).filter(Boolean).sort();
    const finalisiert = rechnungen.filter(r => r.status === 'finalisiert');
    return {
      kunden: ladeKunden().length,
      angebote: angebote.length,
      angeboteStatus: { offen: angebote.filter(a => ['entwurf', 'versendet'].includes(a.statusEffektiv)).length, angenommen: angebote.filter(a => a.statusEffektiv === 'angenommen').length, abgelehnt: angebote.filter(a => ['abgelehnt', 'abgelaufen'].includes(a.statusEffektiv)).length },
      rechnungen: finalisiert.length,
      umsatz: round2(finalisiert.reduce((s, r) => s + r.summen.brutto, 0)),
      offen: round2(finalisiert.filter(r => ['offen', 'ueberfaellig'].includes(r.zahlungsstatus)).reduce((s, r) => s + r.summen.brutto, 0)),
      letzteAktivitaet: zeiten.length ? zeiten[zeiten.length - 1] : null
    };
  }

  // ── Mahnwesen: Zahlungserinnerung → 1. Mahnung → 2. Mahnung ──
  async function erzeugeMahnung(r, felder = {}) {
    if (r.status !== 'finalisiert') throw new Error('Nur finalisierte Rechnungen können gemahnt werden.');
    if (r.typ === 'storno' || r.storniertDurch) throw new Error('Stornierte Rechnungen können nicht gemahnt werden.');
    if (r.zahlung.status === 'bezahlt') throw new Error('Die Rechnung ist bereits bezahlt.');
    if (!r.faelligAm || r.faelligAm >= heute()) throw new Error(`Die Rechnung ist erst am ${datumDe(r.faelligAm)} fällig.`);
    const mahnungen = r.mahnungen || [];
    const stufe = mahnungen.length + 1;
    if (stufe > 3) throw new Error('Es wurden bereits Zahlungserinnerung, 1. und 2. Mahnung erstellt.');
    const stamm = ladeStammdaten();
    const kunde = r.kunde || kundeSnapshot(ladeKunden().find(k => k.id === r.kundeId));
    const brutto = summen(r.positionen, r.kleinunternehmer).brutto;
    const standardGebuehr = stufe === 2 ? stamm.mahngebuehr2 : stufe === 3 ? stamm.mahngebuehr3 : 0;
    const gebuehr = stufe === 1 ? 0 : Math.max(0, round2(felder.gebuehr === undefined || felder.gebuehr === '' ? standardGebuehr : felder.gebuehr));
    const datum = heute();
    const m = {
      stufe, titel: MAHN_TITEL[stufe], datum,
      frist: istDatum(felder.frist) ? felder.frist : plusTage(datum, stamm.mahnfristTage),
      gebuehr, gesamt: round2(brutto + gebuehr), text: String(felder.text || '').trim(),
      archivPfad: null, versand: []
    };
    const pdf = await erzeugeMahnungPdf({
      mahnung: m, rechnung: { nummer: r.nummer, datum: r.datum, faelligAm: r.faelligAm, brutto },
      kunde, absender: r.absender || absenderSnapshot(stamm),
      du: kunde && kunde.anrede === 'du', anrede: r.anrede || kundeAnrede(kunde), gruss: r.gruss || kundeGruss(kunde)
    });
    const datei = path.join(archivOrdner(datum, 'Mahnungen'), pdfDateiname(r.nummer, kunde, stufe === 1 ? 'Zahlungserinnerung' : `Mahnung-${stufe - 1}`));
    fs.writeFileSync(datei, pdf);
    m.archivPfad = path.relative(DATA_DIR, datei);
    r.mahnungen = [...mahnungen, m];
    r.geaendert = new Date().toISOString();
    speichere(RECHNUNGEN_DIR, r);
    return { mahnung: m, pdf };
  }
  function mahnungVon(r, stufe) {
    const m = (r.mahnungen || []).find(x => x.stufe === Number(stufe));
    if (!m) throw new Error('Mahnung nicht gefunden.');
    return m;
  }
  app.post('/api/abrechnung/rechnungen/:id/mahnung', asyncRoute(async (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) throw new Error('Rechnung nicht gefunden.');
    const { mahnung } = await erzeugeMahnung(r, req.body || {});
    ok(res, { rechnung: rechnungMitKunde(r), mahnung });
  }));
  app.get('/api/abrechnung/rechnungen/:id/mahnung/:stufe/pdf', asyncRoute(async (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) throw new Error('Rechnung nicht gefunden.');
    const m = mahnungVon(r, req.params.stufe);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${path.basename(m.archivPfad)}"`);
    res.send(fs.readFileSync(path.join(DATA_DIR, m.archivPfad)));
  }));
  app.get('/api/abrechnung/rechnungen/:id/mahnung/:stufe/email', (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) return fehler(res, 404, 'Rechnung nicht gefunden.');
    let m; try { m = mahnungVon(r, req.params.stufe); } catch (e) { return fehler(res, 404, e.message); }
    const kunde = r.kunde || kundeSnapshot(ladeKunden().find(k => k.id === r.kundeId));
    ok(res, { vorlage: emailVorlage('mahnung', r, kunde, ladeStammdaten(), { mahnung: m }), versand: m.versand || [] });
  });
  app.post('/api/abrechnung/rechnungen/:id/mahnung/:stufe/email', asyncRoute(async (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) throw new Error('Rechnung nicht gefunden.');
    const m = mahnungVon(r, req.params.stufe);
    const kunde = r.kunde || kundeSnapshot(ladeKunden().find(k => k.id === r.kundeId));
    const stamm = ladeStammdaten();
    const anhaenge = [{ filename: path.basename(m.archivPfad), content: fs.readFileSync(path.join(DATA_DIR, m.archivPfad)) }];
    if (r.archivPfad && fs.existsSync(path.join(DATA_DIR, r.archivPfad))) anhaenge.push({ filename: path.basename(r.archivPfad), content: fs.readFileSync(path.join(DATA_DIR, r.archivPfad)) });
    const eintrag = await versende(req.body, emailVorlage('mahnung', r, kunde, stamm, { mahnung: m }), anhaenge, stamm);
    m.versand = [...(m.versand || []), eintrag];
    r.geaendert = new Date().toISOString();
    speichere(RECHNUNGEN_DIR, r);
    ok(res, { rechnung: rechnungMitKunde(r), versand: eintrag });
  }));

  app.get('/api/abrechnung/rechnungen/:id/email', (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) return fehler(res, 404, 'Rechnung nicht gefunden.');
    if (r.status !== 'finalisiert') return fehler(res, 400, 'Nur finalisierte Rechnungen können versendet werden.');
    const kunde = r.kunde || kundeSnapshot(ladeKunden().find(k => k.id === r.kundeId));
    ok(res, { vorlage: emailVorlage('rechnung', r, kunde, ladeStammdaten()), versand: r.versand || [] });
  });
  app.post('/api/abrechnung/rechnungen/:id/email', asyncRoute(async (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) throw new Error('Rechnung nicht gefunden.');
    if (r.status !== 'finalisiert') throw new Error('Nur finalisierte Rechnungen können versendet werden.');
    if (!r.archivPfad || !fs.existsSync(path.join(DATA_DIR, r.archivPfad))) throw new Error('Archiv-PDF nicht gefunden.');
    const kunde = r.kunde || kundeSnapshot(ladeKunden().find(k => k.id === r.kundeId));
    const stamm = ladeStammdaten();
    const eintrag = await versende(req.body, emailVorlage('rechnung', r, kunde, stamm), [{ filename: path.basename(r.archivPfad), content: fs.readFileSync(path.join(DATA_DIR, r.archivPfad)) }], stamm);
    r.versand = [...(r.versand || []), eintrag];
    r.geaendert = new Date().toISOString();
    speichere(RECHNUNGEN_DIR, r);
    ok(res, { rechnung: rechnungMitKunde(r), versand: eintrag });
  }));

  app.get('/api/abrechnung/rechnungen/:id/pdf', asyncRoute(async (req, res) => {
    const r = ladeEins(RECHNUNGEN_DIR, req.params.id);
    if (!r) throw new Error('Rechnung nicht gefunden.');
    const kunde = r.kunde || ladeKunden().find(k => k.id === r.kundeId);
    const disposition = req.query.download ? 'attachment' : 'inline';
    if (r.status === 'finalisiert' && r.archivPfad && fs.existsSync(path.join(DATA_DIR, r.archivPfad))) {
      // Finalisierte Rechnungen kommen immer unverändert aus dem Archiv.
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${disposition}; filename="${path.basename(r.archivPfad)}"`);
      return res.send(fs.readFileSync(path.join(DATA_DIR, r.archivPfad)));
    }
    if (!kunde) throw new Error('Der Rechnung ist kein Kunde zugeordnet.');
    const pdf = await erzeugeRechnungPdf(rechnungPdfDaten(r, kunde, r.absender ? { ...ladeStammdaten(), ...r.absender } : ladeStammdaten()));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="Entwurf_${dateiSlug(kunde.firma)}_Rechnung.pdf"`);
    res.send(pdf);
  }));

  // ── Abos ──────────────────────────────────────────────────
  function aboMitKunde(a) {
    const kunde = kundeSnapshot(ladeKunden().find(k => k.id === a.kundeId));
    const monatlich = round2(a.positionen.reduce((s, p) => s + round2(p.preis), 0));
    return { ...a, kunde, monatlich };
  }
  app.get('/api/abrechnung/abos', (req, res) => ok(res, { abos: ladeAlle(ABOS_DIR).map(aboMitKunde).sort((x, y) => y.erstellt.localeCompare(x.erstellt)) }));
  app.post('/api/abrechnung/abos', asyncRoute(async (req, res) => {
    const b = req.body || {};
    if (!ladeKunden().some(k => k.id === b.kundeId)) throw new Error('Bitte einen Kunden auswählen.');
    const positionen = (Array.isArray(b.positionen) ? b.positionen : []).map(p => ({ artikelNr: p.artikelNr || null, titel: String(p.titel || '').trim(), beschreibung: String(p.beschreibung || '').trim(), preis: round2(p.preis) })).filter(p => p.titel);
    if (!positionen.length) throw new Error('Das Abo braucht mindestens eine Position.');
    const start = istDatum(b.start) ? b.start : monatsAnfang(monatVon(heute()));
    const abo = speichere(ABOS_DIR, { id: neueId(), kundeId: b.kundeId, angebotId: null, angebotNummer: null, titel: String(b.titel || 'Monatliche Leistungen').trim(), aktiv: true, start, ende: istDatum(b.ende) ? b.ende : null, letzteAbrechnung: null, positionen, erstellt: new Date().toISOString() });
    aboLauf();
    ok(res, { abo: aboMitKunde(ladeEins(ABOS_DIR, abo.id)) });
  }));
  app.put('/api/abrechnung/abos/:id', asyncRoute(async (req, res) => {
    const abo = ladeEins(ABOS_DIR, req.params.id);
    if (!abo) throw new Error('Abo nicht gefunden.');
    const b = req.body || {};
    if (b.titel !== undefined) abo.titel = String(b.titel).trim();
    if (b.ende !== undefined) abo.ende = istDatum(b.ende) ? b.ende : null;
    if (b.aktiv !== undefined) abo.aktiv = !!b.aktiv;
    if (Array.isArray(b.positionen)) {
      abo.positionen = b.positionen.map(p => ({ artikelNr: p.artikelNr || null, titel: String(p.titel || '').trim(), beschreibung: String(p.beschreibung || '').trim(), preis: round2(p.preis) })).filter(p => p.titel);
      if (!abo.positionen.length) throw new Error('Das Abo braucht mindestens eine Position.');
    }
    speichere(ABOS_DIR, abo);
    ok(res, { abo: aboMitKunde(abo) });
  }));
  app.post('/api/abrechnung/abos/lauf', (req, res) => ok(res, { angelegt: aboLauf() }));

  // ── Export & Archiv ───────────────────────────────────────
  function csvZelle(v) {
    const s = String(v == null ? '' : v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function betragDe(n) { return round2(n).toFixed(2).replace('.', ','); }
  function rechnungenImMonat(monat) {
    return ladeAlle(RECHNUNGEN_DIR).filter(r => r.status === 'finalisiert' && monatVon(r.datum) === monat).map(rechnungMitKunde).sort((x, y) => x.nummer.localeCompare(y.nummer));
  }
  function zahlungsstatusText(s) {
    return { offen: 'Offen', bezahlt: 'Bezahlt', ueberfaellig: 'Überfällig', storno: 'Stornorechnung', storniert: 'Storniert' }[s] || s;
  }
  function csvFuer(rechnungen) {
    const kopf = ['Rechnungsnr.', 'Datum', 'Kunde', 'Kundennr.', 'Leistungszeitraum', 'Netto', 'USt', 'Betrag', 'Status', 'Bezahlt am', 'Bezug'];
    const zeilen = rechnungen.map(r => [
      r.nummer, datumDe(r.datum), r.kunde && r.kunde.firma, r.kunde && r.kunde.nummer,
      r.leistungVon === r.leistungBis ? datumDe(r.leistungVon) : `${datumDe(r.leistungVon)} – ${datumDe(r.leistungBis)}`,
      betragDe(r.summen.netto), betragDe(r.summen.ust), betragDe(r.summen.brutto),
      zahlungsstatusText(r.zahlungsstatus), datumDe(r.zahlung.bezahltAm),
      r.typ === 'storno' ? `Storno zu ${r.bezug.originalNummer}` : (r.bezug.angebotNummer ? `Angebot ${r.bezug.angebotNummer}${r.bezug.rate ? ` (Rate ${r.bezug.rate}/${r.bezug.ratenGesamt})` : ''}` : '')
    ]);
    return '﻿' + [kopf, ...zeilen].map(z => z.map(csvZelle).join(';')).join('\r\n') + '\r\n';
  }
  app.get('/api/abrechnung/export/monate', (req, res) => {
    const monate = {};
    ladeAlle(RECHNUNGEN_DIR).filter(r => r.status === 'finalisiert').forEach(r => {
      const m = monatVon(r.datum);
      monate[m] = monate[m] || { monat: m, anzahl: 0, summe: 0 };
      monate[m].anzahl++;
      monate[m].summe = round2(monate[m].summe + summen(r.positionen, r.kleinunternehmer).brutto);
    });
    ok(res, { monate: Object.values(monate).sort((a, b) => b.monat.localeCompare(a.monat)) });
  });
  app.get('/api/abrechnung/export/csv', (req, res) => {
    const monat = String(req.query.monat || '');
    if (!/^\d{4}-\d{2}$/.test(monat)) return fehler(res, 400, 'Monat im Format JJJJ-MM angeben.');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Rechnungen_${monat}.csv"`);
    res.send(csvFuer(rechnungenImMonat(monat)));
  });
  app.get('/api/abrechnung/export/zip', (req, res) => {
    const monat = String(req.query.monat || '');
    if (!/^\d{4}-\d{2}$/.test(monat)) return fehler(res, 400, 'Monat im Format JJJJ-MM angeben.');
    const rechnungen = rechnungenImMonat(monat);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Buchhaltung_${monat}_Einnahmen.zip"`);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on('error', e => { console.error('ZIP:', e.message); res.end(); });
    zip.pipe(res);
    zip.append(csvFuer(rechnungen), { name: `Rechnungen_${monat}.csv` });
    rechnungen.forEach(r => {
      const datei = r.archivPfad && path.join(DATA_DIR, r.archivPfad);
      if (datei && fs.existsSync(datei)) zip.file(datei, { name: path.basename(datei) });
    });
    // Mahnungen des Monats (nach Mahndatum) als eigener Ordner
    ladeAlle(RECHNUNGEN_DIR).forEach(r => (r.mahnungen || []).forEach(m => {
      const datei = m.archivPfad && path.join(DATA_DIR, m.archivPfad);
      if (monatVon(m.datum) === monat && datei && fs.existsSync(datei)) zip.file(datei, { name: 'Mahnungen/' + path.basename(datei) });
    }));
    zip.finalize();
  });

  // Alle Daten der Abrechnung als eine JSON-Datei (zum Wiedereinspielen)
  function datenAuszug() {
    const d = { tool: 'abrechnung', version: 1, erstellt: new Date().toISOString(), stammdaten: ladeStammdaten(), zaehler: ladeZaehler() };
    datenbank.SAMMLUNGEN.forEach(sm => { d[sm] = db.alle(sm); });
    return d;
  }
  app.get('/api/abrechnung/export/daten.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="NovaFlow-Abrechnung-Daten_${heute()}.json"`);
    res.send(JSON.stringify(datenAuszug(), null, 2));
  });
  // Sicherung einspielen: ergänzt fehlende Datensätze, vorhandene bleiben
  // (außer „ueberschreiben“). Nummernkreise werden nie zurückgesetzt.
  app.post('/api/abrechnung/wiederherstellen', express.json({ limit: '50mb' }), (req, res) => {
    const b = req.body || {};
    const d = b.daten || b;
    if (!d || d.tool !== 'abrechnung') return fehler(res, 400, 'Das ist keine Datensicherung der Abrechnung.');
    const ueberschreiben = !!b.ueberschreiben;
    const z = { eingespielt: 0, uebersprungen: 0 };
    db.transaktion(() => {
      // Stammdaten: übernehmen, wenn noch nichts Eigenes eingetragen ist (Steuernummer/IBAN leer)
      const aktuell = ladeStammdaten();
      if (d.stammdaten && (ueberschreiben || (!aktuell.steuernummer && !aktuell.bank.iban))) { speichereStammdaten({ ...STD, ...d.stammdaten }); z.eingespielt++; }
      if (d.zaehler) {
        const z0 = ladeZaehler();
        z0.kunden = Math.max(z0.kunden || 0, d.zaehler.kunden || 0);
        ['angebote', 'rechnungen'].forEach(k => Object.entries(d.zaehler[k] || {}).forEach(([jahr, n]) => { z0[k][jahr] = Math.max(z0[k][jahr] || 0, n); }));
        speichereZaehler(z0);
      }
      datenbank.SAMMLUNGEN.forEach(sm => (Array.isArray(d[sm]) ? d[sm] : []).forEach(o => {
        const id = sm === 'artikel' ? o.nr : o.id;
        if (!id) return;
        if (db.eins(sm, id) && !ueberschreiben) { z.uebersprungen++; return; }
        db.setze(sm, id, o); z.eingespielt++;
      }));
    });
    ok(res, z);
  });

  // Gesamtarchiv: alle PDFs (Angebote, Rechnungen, Mahnungen) mit Ordnerstruktur
  // Buchhaltung/JJJJ/MM/… plus Jahres-CSVs und eine Sicherung der Rohdaten.
  // Gedacht zum Entpacken in den eigenen Buchhaltungsordner auf dem PC.
  app.get('/api/abrechnung/export/gesamt', (req, res) => {
    const jahr = /^\d{4}$/.test(String(req.query.jahr || '')) ? String(req.query.jahr) : null;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="NovaFlow-Abrechnung${jahr ? '_' + jahr : '_Gesamtarchiv'}_${heute()}.zip"`);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on('error', e => { console.error('ZIP:', e.message); res.end(); });
    zip.pipe(res);
    if (fs.existsSync(BUCHHALTUNG_DIR)) {
      fs.readdirSync(BUCHHALTUNG_DIR).filter(j => /^\d{4}$/.test(j) && (!jahr || j === jahr)).forEach(j => {
        zip.directory(path.join(BUCHHALTUNG_DIR, j), path.join('Buchhaltung', j));
      });
    }
    // CSV je Jahr mit allen finalisierten Rechnungen
    const alle = ladeAlle(RECHNUNGEN_DIR).filter(r => r.status === 'finalisiert').map(rechnungMitKunde);
    const jahre = [...new Set(alle.map(r => String(r.datum).slice(0, 4)))].filter(j => !jahr || j === jahr).sort();
    jahre.forEach(j => zip.append(csvFuer(alle.filter(r => String(r.datum).startsWith(j)).sort((x, y) => x.nummer.localeCompare(y.nummer))), { name: `Buchhaltung/${j}/Rechnungen_${j}.csv` }));
    // Rohdaten-Sicherung (JSON), damit nichts verloren geht
    if (!jahr) {
      zip.append(JSON.stringify(datenAuszug(), null, 2), { name: 'Datensicherung/NovaFlow-Abrechnung-Daten.json' });
      // Komplette Datenbankdatei als konsistente Kopie
      const kopie = path.join(BASIS, `sicherung-${Date.now()}.sqlite`);
      db.sicherung(kopie).then(() => {
        zip.file(kopie, { name: 'Datensicherung/abrechnung.sqlite' });
        zip.finalize();
        zip.on('end', () => { try { fs.unlinkSync(kopie); } catch (e) { /* egal */ } });
      }).catch(e => { console.error('DB-Sicherung:', e.message); zip.finalize(); });
      return;
    }
    zip.finalize();
  });

  // ── Übersicht ─────────────────────────────────────────────
  app.get('/api/abrechnung/uebersicht', (req, res) => {
    const rechnungen = ladeAlle(RECHNUNGEN_DIR).map(rechnungAnsicht);
    const jahr = heute().slice(0, 4);
    const offen = rechnungen.filter(r => r.status === 'finalisiert' && (r.zahlungsstatus === 'offen' || r.zahlungsstatus === 'ueberfaellig'));
    ok(res, {
      kunden: ladeKunden().length,
      angeboteOffen: ladeAlle(ANGEBOTE_DIR).map(angebotAnsicht).filter(a => a.statusEffektiv === 'versendet').length,
      entwuerfe: rechnungen.filter(r => r.status === 'entwurf').length,
      offen: offen.length, offenerBetrag: round2(offen.reduce((s, r) => s + r.summen.brutto, 0)),
      ueberfaellig: rechnungen.filter(r => r.zahlungsstatus === 'ueberfaellig').length,
      // Stornorechnungen gehen negativ ein, Stornierte bleiben drin — die Summe stimmt so.
      umsatzJahr: round2(rechnungen.filter(r => r.status === 'finalisiert' && String(r.datum).startsWith(jahr)).reduce((s, r) => s + r.summen.brutto, 0)),
      abosAktiv: ladeAlle(ABOS_DIR).filter(a => a.aktiv).length,
      kleinunternehmer: !!ladeStammdaten().kleinunternehmer
    });
  });

  // ── Automatische Sicherung per E-Mail ─────────────────────
  // Schickt im eingestellten Rhythmus (Standard: alle 7 Tage) eine Mail mit
  // der kompletten Datensicherung (Abrechnung + Kundenkonten des Angebots-
  // tools) und einem Statusbericht (überfällige Rechnungen, offene Entwürfe).
  // Am Monatsanfang hängt zusätzlich das Buchhaltungs-ZIP des Vormonats dran.
  function zipPuffer(monat) {
    return new Promise((resolve, reject) => {
      const zip = new ZipArchive({ zlib: { level: 6 } });
      const teile = [];
      zip.on('data', c => teile.push(c));
      zip.on('end', () => resolve(Buffer.concat(teile)));
      zip.on('error', reject);
      const rechnungen = rechnungenImMonat(monat);
      zip.append(csvFuer(rechnungen), { name: `Rechnungen_${monat}.csv` });
      rechnungen.forEach(r => { const d = r.archivPfad && path.join(DATA_DIR, r.archivPfad); if (d && fs.existsSync(d)) zip.file(d, { name: path.basename(d) }); });
      ladeAlle(RECHNUNGEN_DIR).forEach(r => (r.mahnungen || []).forEach(m => { const d = m.archivPfad && path.join(DATA_DIR, m.archivPfad); if (monatVon(m.datum) === monat && d && fs.existsSync(d)) zip.file(d, { name: 'Mahnungen/' + path.basename(d) }); }));
      ladeAlle(ANGEBOTE_DIR).forEach(a => { const d = a.archivPfad && path.join(DATA_DIR, a.archivPfad); if (monatVon(a.datum) === monat && d && fs.existsSync(d)) zip.file(d, { name: 'Angebote/' + path.basename(d) }); });
      zip.finalize();
    });
  }
  function statusbericht() {
    const rechnungen = ladeAlle(RECHNUNGEN_DIR).map(rechnungMitKunde);
    const ueberfaellig = rechnungen.filter(r => r.zahlungsstatus === 'ueberfaellig');
    const offen = rechnungen.filter(r => r.zahlungsstatus === 'offen');
    const entwuerfe = rechnungen.filter(r => r.status === 'entwurf');
    const angebote = ladeAlle(ANGEBOTE_DIR).map(angebotMitKunde).filter(a => a.statusEffektiv === 'versendet');
    const zeile = r => `  • ${r.nummer} · ${r.kunde ? r.kunde.firma : '–'} · ${euroText(r.summen.brutto)} · fällig ${datumDe(r.faelligAm)}${(r.mahnungen || []).length ? ` · ${r.mahnungen[r.mahnungen.length - 1].titel} am ${datumDe(r.mahnungen[r.mahnungen.length - 1].datum)}` : ''}`;
    const teile = [];
    teile.push(ueberfaellig.length ? `ÜBERFÄLLIG (${ueberfaellig.length}) – bitte mahnen oder als bezahlt markieren:\n${ueberfaellig.map(zeile).join('\n')}` : 'Überfällig: keine.');
    teile.push(offen.length ? `Offen, noch nicht fällig (${offen.length}):\n${offen.map(zeile).join('\n')}` : 'Offen: keine.');
    teile.push(entwuerfe.length ? `Rechnungsentwürfe zum Freigeben (${entwuerfe.length}):\n${entwuerfe.map(r => `  • ${r.kunde ? r.kunde.firma : '–'} · ${r.titel || ''} · ${euroText(r.summen.brutto)} · Monat ${r.geplantMonat}`).join('\n')}` : 'Rechnungsentwürfe: keine.');
    teile.push(angebote.length ? `Versendete Angebote ohne Antwort (${angebote.length}):\n${angebote.map(a => `  • ${a.nummer} · ${a.kunde ? a.kunde.firma : '–'} · ${euroText(a.summen.brutto)} · gültig bis ${datumDe(a.gueltigBis)}`).join('\n')}` : 'Offene Angebote: keine.');
    return teile.join('\n\n');
  }
  async function sicherungsMailSenden(erzwingen) {
    if (!ctx.email) return null;
    const stamm = ladeStammdaten();
    const einst = stamm.sicherungMail || {};
    const zustand = db.einstellung('sicherungMail', { letzte: null, letzterMonatsZip: null });
    if (!erzwingen) {
      if (einst.aktiv === false || !mail.konfiguration().konfiguriert) return null;
      if (zustand.letzte && plusTage(zustand.letzte.slice(0, 10), einst.rhythmusTage || 7) > heute()) return null;
    }
    const an = einst.an || stamm.email || mail.konfiguration().von;
    const anhaenge = [
      { filename: `NovaFlow-Abrechnung-Daten_${heute()}.json`, content: Buffer.from(JSON.stringify(datenAuszug(), null, 2)) }
    ];
    if (typeof backupHandwerker === 'function') {
      try { anhaenge.push({ filename: `Angebotstool-Kundenkonten_${heute()}.json`, content: Buffer.from(JSON.stringify(backupHandwerker(), null, 2)) }); } catch (e) { console.error('Backup Angebotstool:', e.message); }
    }
    // Monats-ZIP des Vormonats, einmal pro Monat
    const vormonat = monatVon(plusMonate(monatsAnfang(monatVon(heute())), -1));
    let zipHinweis = '';
    if (zustand.letzterMonatsZip !== vormonat && rechnungenImMonat(vormonat).length) {
      anhaenge.push({ filename: `Buchhaltung_${vormonat}.zip`, content: await zipPuffer(vormonat) });
      zipHinweis = `\n\nIm Anhang außerdem das Buchhaltungs-ZIP für ${vormonat} (alle Rechnungen, Mahnungen und Angebote des Monats als PDF plus CSV) – bitte in deinen Buchhaltungsordner ablegen.`;
    }
    const text = `Hallo Aleksandra,\n\nhier ist die automatische Sicherung aus der NovaFlow-Abrechnung vom ${datumDe(heute())}.\n\nIm Anhang:\n  • NovaFlow-Abrechnung-Daten_….json – alle Kunden, Artikel, Angebote, Rechnungen, Abos und Stammdaten (unter Abrechnung → Export → „Sicherung einspielen“ wieder einspielbar)\n  • Angebotstool-Kundenkonten_….json – alle Kundenkonten des Angebotstools mit ihren Angeboten und Rechnungen (unter Firmendaten → Datensicherung → „Backup einspielen“)${zipHinweis}\n\nSTATUS\n\n${statusbericht()}\n\nDiese Mail kommt automatisch alle ${einst.rhythmusTage || 7} Tage. Einstellen unter Abrechnung → Stammdaten → Automatische Sicherung.\n\nNovaFlow-Abrechnung · tool.novaflowservices.de`;
    const ergebnis = await mail.sende({ an, betreff: `Sicherung NovaFlow-Abrechnung ${datumDe(heute())}${zipHinweis ? ` + Buchhaltung ${vormonat}` : ''}`, text, anhaenge, kopie: false });
    zustand.letzte = new Date().toISOString();
    if (zipHinweis) zustand.letzterMonatsZip = vormonat;
    db.einstellungSetzen('sicherungMail', zustand);
    return { an: ergebnis.an, am: zustand.letzte, anhaenge: anhaenge.map(a => a.filename) };
  }
  app.get('/api/abrechnung/sicherung/status', (req, res) => {
    const z = db.einstellung('sicherungMail', { letzte: null });
    ok(res, { letzte: z.letzte, mailKonfiguriert: mail.konfiguration().konfiguriert });
  });
  app.post('/api/abrechnung/sicherung/senden', asyncRoute(async (req, res) => {
    const e = await sicherungsMailSenden(true);
    ok(res, e);
  }));
  // Beim Start (verzögert) und danach stündlich prüfen, ob eine Sicherung fällig ist.
  // ctx.nurLesen (CRM-Ansicht der Kundenkonten aus dem Angebotstool): keine Hintergrundläufe
  if (!ctx.nurLesen) {
    setTimeout(() => sicherungsMailSenden(false).catch(e => console.error('Sicherungs-Mail:', e.message)), 60 * 1000).unref();
    setInterval(() => sicherungsMailSenden(false).catch(e => console.error('Sicherungs-Mail:', e.message)), 60 * 60 * 1000).unref();
  }

  // Tägliche Sicherungskopie der Datenbank (letzte 30 bleiben erhalten)
  const SICHERUNG_DIR = path.join(BASIS, 'sicherungen');
  function sichereDatenbank() {
    fs.mkdirSync(SICHERUNG_DIR, { recursive: true });
    const ziel = path.join(SICHERUNG_DIR, `abrechnung-${heute()}.sqlite`);
    if (fs.existsSync(ziel)) return;
    db.sicherung(ziel).then(() => {
      const alle = fs.readdirSync(SICHERUNG_DIR).filter(f => /^abrechnung-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort();
      alle.slice(0, Math.max(0, alle.length - 30)).forEach(f => fs.unlinkSync(path.join(SICHERUNG_DIR, f)));
    }).catch(e => console.error('DB-Sicherung:', e.message));
  }
  if (!ctx.nurLesen) {
    sichereDatenbank();
    setInterval(sichereDatenbank, 24 * 60 * 60 * 1000).unref();
    // Abo-Lauf beim Start und danach alle 6 Stunden
    try { ladeStammdaten(); ladeArtikel(); aboLauf(); } catch (e) { console.error('Abrechnung Start:', e.message); }
    setInterval(() => { try { aboLauf(); } catch (e) { console.error('Abo-Lauf:', e.message); } }, 6 * 60 * 60 * 1000).unref();
  }

  // ── Übernahme der Altdaten aus dem früheren KI-Angebotsgenerator ──
  // Alte Angebote und Rechnungen eines Betriebs werden einmalig in die
  // Abrechnung übernommen: Kunden werden angelegt, Nummern bleiben erhalten,
  // Nummernkreise werden hochgesetzt, finalisierte Rechnungen bekommen ein PDF im Archiv.
  async function uebernehmeAltdaten({ angebote = [], rechnungen = [] }) {
    const marker = path.join(BASIS, '_altdaten-uebernommen.json');
    if (fs.existsSync(marker) || (!angebote.length && !rechnungen.length)) return null;
    const ergebnis = { kunden: 0, angebote: 0, rechnungen: 0 };
    const stamm = ladeStammdaten();
    const kundeFuer = (name) => {
      const n = String(name || 'Unbekannt').trim() || 'Unbekannt';
      let k = ladeKunden().find(x => x.firma.toLowerCase() === n.toLowerCase());
      if (!k) { k = { id: neueId(), nummer: naechsteKundennummer(), firma: n, ansprechpartner: '', strasse: '', plz: '', ort: '', email: '', anrede: 'sie', angelegt: new Date().toISOString() }; speichere('kunden', k); ergebnis.kunden++; }
      return k;
    };
    const positionenAus = (quote) => (quote && Array.isArray(quote.positionen) ? quote.positionen : []).map(p => {
      const std = /std/i.test(p.einheit || '');
      const pauschal = /pausch/i.test(p.einheit || '');
      return { artikelNr: null, titel: String(p.beschreibung || 'Leistung').trim(), beschreibung: '', menge: Number(p.menge) > 0 ? Number(p.menge) : 1,
        einheit: std ? 'Stunde' : pauschal ? 'Pauschal' : (p.einheit || 'Stück'), einheitMehrzahl: std ? 'Stunden' : pauschal ? 'Pauschal' : (p.einheit || 'Stück'),
        einzelpreis: round2(p.einzelpreis), rabatt: Number(quote.rabatt_prozent) > 0 ? round2(quote.rabatt_prozent) : 0, abrechnung: 'einmalig' };
    });
    const zaehlerHoch = (art, nummer) => {
      const m = String(nummer || '').match(/^[AR]-(\d{4})-(\d+)$/);
      if (!m) return;
      const z = ladeZaehler(); z[art][m[1]] = Math.max(z[art][m[1]] || 0, parseInt(m[2], 10)); speichereZaehler(z);
    };
    const datumVon = iso => (String(iso || '').slice(0, 10) || heute());
    for (const alt of angebote) {
      if (!alt || !alt.nummer) continue;
      if (ladeAlle(ANGEBOTE_DIR).some(a => a.nummer === alt.nummer)) continue;
      const form = alt.form || {}, quote = alt.quote || {};
      const kunde = kundeFuer(form.kundenname);
      const datum = datumVon(alt.erstellt);
      const status = alt.status === 'angenommen' ? 'angenommen' : alt.status === 'abgelehnt' ? 'abgelehnt' : 'versendet';
      speichere(ANGEBOTE_DIR, {
        id: neueId(), nummer: alt.nummer, status, umgewandelt: alt.rechnungsnummer ? { am: alt.erstellt, rechnungen: [], abos: [] } : null,
        kundeId: kunde.id, datum, gueltigBis: plusTage(datum, 14), betreff: String(form.arbeitsart || 'Angebot').trim(),
        anrede: '', einleitung: String(form.beschreibung || '').trim(), schlusstext: String(quote.anmerkung || '').trim(), gruss: '',
        positionen: positionenAus(quote), zahlung: { art: 'einmal', anzahl: 1, ersteRate: null, anzahlungProzent: 50, anzahlungText: 'bei Auftragserteilung', restText: 'nach Abschluss des Projekts' },
        monatlichStart: null, projektvereinbarung: false, kleinunternehmer: !!quote.kleinunternehmer, quelle: 'altdaten',
        erstellt: alt.erstellt || new Date().toISOString(), geaendert: alt.erstellt || new Date().toISOString()
      });
      zaehlerHoch('angebote', alt.nummer); ergebnis.angebote++;
    }
    for (const alt of rechnungen) {
      if (!alt || !alt.nummer) continue;
      if (ladeAlle(RECHNUNGEN_DIR).some(r => r.nummer === alt.nummer)) continue;
      const form = alt.form || {}, quote = alt.quote || {};
      const kunde = kundeFuer(form.kundenname);
      const datum = datumVon(alt.erstellt);
      const angebot = ladeAlle(ANGEBOTE_DIR).find(a => a.nummer === alt.angebotNummer);
      const r = neueRechnung({
        quelle: 'altdaten', status: 'finalisiert', nummer: alt.nummer, kundeId: kunde.id, kunde: kundeSnapshot(kunde), absender: absenderSnapshot(stamm),
        kleinunternehmer: !!quote.kleinunternehmer, datum, faelligAm: datumVon(alt.faelligAm) || plusTage(datum, 14),
        leistungVon: datum, leistungBis: datum, geplantMonat: monatVon(datum), titel: String(form.arbeitsart || 'Rechnung').trim(),
        positionen: positionenAus(quote), bezug: angebot ? { angebotId: angebot.id, angebotNummer: angebot.nummer } : (alt.angebotNummer ? { angebotNummer: alt.angebotNummer } : {}),
        finalisiertAm: alt.erstellt || new Date().toISOString(), erstellt: alt.erstellt || new Date().toISOString(), geaendert: alt.erstellt || new Date().toISOString()
      });
      try {
        const pdf = await erzeugeRechnungPdf(rechnungPdfDaten(r, kunde, stamm));
        const datei = path.join(archivOrdner(datum, 'Einnahmen'), pdfDateiname(r.nummer, kunde, 'Rechnung'));
        if (!fs.existsSync(datei)) fs.writeFileSync(datei, pdf);
        r.archivPfad = path.relative(DATA_DIR, datei);
      } catch (e) { console.error('Altdaten-PDF', alt.nummer, e.message); }
      speichere(RECHNUNGEN_DIR, r);
      if (angebot && angebot.umgewandelt) { angebot.umgewandelt.rechnungen.push(r.id); speichere(ANGEBOTE_DIR, angebot); }
      zaehlerHoch('rechnungen', alt.nummer); ergebnis.rechnungen++;
    }
    fs.writeFileSync(marker, JSON.stringify({ am: new Date().toISOString(), ...ergebnis }, null, 2));
    return ergebnis;
  }

  // ── Schnittstelle zum CRM (Leads & Deals) ─────────────────
  const crm = {
    // Kunde zu einem CRM-Lead finden (verknüpft, gleiche E-Mail oder gleiche Firma) oder anlegen
    kundeFuerLead(lead) {
      const kunden = ladeKunden();
      const mail = String(lead.email || '').trim().toLowerCase();
      const firma = String(lead.company || '').trim().toLowerCase();
      let k = kunden.find(x => x.crmLeadId === lead.id)
        || (mail && kunden.find(x => String(x.email || '').trim().toLowerCase() === mail))
        || (firma && kunden.find(x => String(x.firma || '').trim().toLowerCase() === firma));
      if (k) {
        if (k.crmLeadId !== lead.id) { k = { ...k, crmLeadId: lead.id }; speichere('kunden', k); }
        return k;
      }
      const plzOrt = String(lead.location || '').trim().match(/^(\d{5})\s+(.+)$/);
      k = {
        id: neueId(), nummer: naechsteKundennummer(),
        ...kundeAusBody({
          firma: lead.company || '', ansprechpartner: lead.ceo || '', email: lead.email || '',
          plz: plzOrt ? plzOrt[1] : '', ort: plzOrt ? plzOrt[2] : (lead.location || ''), strasse: '', anrede: 'sie',
        }),
        crmLeadId: lead.id, angelegt: new Date().toISOString(),
      };
      speichere('kunden', k);
      return k;
    },
    // Neuen Angebotsentwurf für einen Deal anlegen
    angebotEntwurf({ lead, deal, positionen, zahlung }) {
      const kunde = crm.kundeFuerLead(lead);
      const datum = heute();
      const basis = { id: neueId(), nummer: naechsteAngebotsnummer(datum.slice(0, 4)), status: 'entwurf', umgewandelt: null,
        erstellt: new Date().toISOString(), crm: { leadId: lead.id, dealId: deal ? deal.id : null } };
      const a = angebotAusBody({ kundeId: kunde.id, datum, betreff: deal ? deal.title : '', positionen: positionen || [], zahlung }, basis);
      speichere(ANGEBOTE_DIR, a);
      return angebotMitKunde(a);
    },
    // Angebote und Rechnungen eines Leads: über verknüpften Kunden, sonst (noch nicht
    // verknüpfte, z. B. übernommene Kunden) über gleiche E-Mail oder gleiche Firma
    dokumenteFuerLead(lead) {
      const leadId = lead.id;
      const mail = String(lead.email || '').trim().toLowerCase();
      const firma = String(lead.company || '').trim().toLowerCase();
      const passt = k => k.crmLeadId === leadId || (!k.crmLeadId && (
        (mail && String(k.email || '').trim().toLowerCase() === mail) ||
        (firma && String(k.firma || '').trim().toLowerCase() === firma)));
      const kundenIds = new Set(ladeKunden().filter(passt).map(k => k.id));
      const angebote = ladeAlle(ANGEBOTE_DIR).filter(a => kundenIds.has(a.kundeId) || (a.crm && a.crm.leadId === leadId))
        .map(angebotAnsicht).map(a => ({ id: a.id, nummer: a.nummer, betreff: a.betreff, datum: a.datum, status: a.statusEffektiv || a.status,
          netto: a.summen.netto, brutto: a.summen.brutto, monatlich: a.monatlichSumme || 0, dealId: a.crm ? a.crm.dealId : null }));
      const rechnungen = ladeAlle(RECHNUNGEN_DIR).filter(r => kundenIds.has(r.kundeId)).map(rechnungAnsicht)
        .map(r => ({ id: r.id, nummer: r.nummer || '(Entwurf)', titel: r.titel, datum: r.datum, status: r.status, zahlungsstatus: r.zahlungsstatus, brutto: r.summen.brutto }));
      return { angebote: angebote.sort((x, y) => (y.nummer > x.nummer ? 1 : -1)), rechnungen: rechnungen.sort((x, y) => String(y.datum).localeCompare(String(x.datum))) };
    },
    leer: () => db.leer(),
  };

  return { router: app, aboLauf, statistik, uebernehmeAltdaten, crm, db };
}

// ── Mandanten-Verteiler ───────────────────────────────────
// Admin → NovaFlow-Abrechnung (data/abrechnung). Betrieb → eigener Bestand
// unter data/abrechnung-betriebe/<slug>, mit Logo und Firmendaten des Betriebs.
// Betriebe sehen ausschließlich ihre eigenen Daten, nie die von NovaFlow oder anderen.
function registriere(app, { DATA_DIR, backupHandwerker, ladeBetrieb, speichereBetrieb, istAdmin, ki }) {
  const mandanten = new Map();
  function stammdatenAusBetrieb(b) {
    const f = b.firma || {};
    return {
      firma: f.name || b.slug, inhaberin: f.inhaber || '', inhaberLabel: 'Inhaber/in', marke: null,
      strasse: f.strasse || '', plz: f.plz || '', ort: f.ort || '', telefon: f.telefon || '', email: f.email || '', website: '',
      steuernummer: '', bank: { name: '', iban: '', bic: '', kontoinhaberin: f.inhaber || '' },
      kleinunternehmer: !!b.kleinunternehmer, sicherungMail: { aktiv: false, an: '', rhythmusTage: 7 }
    };
  }
  function hole(id, bauen) {
    if (!mandanten.has(id)) mandanten.set(id, bauMandant(express.Router(), bauen()));
    return mandanten.get(id);
  }
  function novaflow() {
    return hole('novaflow', () => ({
      id: 'novaflow', istAdmin: true, email: true, DATA_DIR, backupHandwerker, ki,
      basis: path.join(DATA_DIR, 'abrechnung'), buchhaltung: path.join(DATA_DIR, 'Buchhaltung'),
      stammdatenStandard: { marke: 'novaflow' }
    }));
  }
  function liesAltdaten(slug, art) {
    const dir = path.join(DATA_DIR, art, slug);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return null; } }).filter(Boolean)
      .sort((a, b) => String(a.erstellt || '').localeCompare(String(b.erstellt || '')));
  }
  function betriebMandant(slug) {
    const b = ladeBetrieb(slug);
    if (!b) return null;
    const neu = !mandanten.has('betrieb:' + slug);
    const m = holeBetrieb(slug, b);
    if (neu) {
      uebernahmen.set(slug, m.uebernehmeAltdaten({ angebote: liesAltdaten(slug, 'angebote'), rechnungen: liesAltdaten(slug, 'rechnungen') })
        .then(e => { if (e) console.log(`Abrechnung ${slug}: Altdaten übernommen (${e.kunden} Kunden, ${e.angebote} Angebote, ${e.rechnungen} Rechnungen).`); })
        .catch(e => console.error('Altdaten', slug, e.message)));
    }
    return m;
  }
  const uebernahmen = new Map();
  function holeBetrieb(slug, b) {
    return hole('betrieb:' + slug, () => ({
      id: slug, istAdmin: false, email: false, DATA_DIR,
      basis: path.join(DATA_DIR, 'abrechnung-betriebe', slug), buchhaltung: path.join(DATA_DIR, 'abrechnung-betriebe', slug, 'Buchhaltung'),
      stammdatenStandard: stammdatenAusBetrieb(b), artikelStandard: [], ki,
      live: () => { const akt = ladeBetrieb(slug); return akt ? { logo: akt.logo || null } : {}; },
      // Stammdaten der Abrechnung sind für Betriebe die Firmendaten: zurück in den Betriebsdatensatz schreiben
      speichereFirma: (st, logo) => {
        const akt = ladeBetrieb(slug); if (!akt) return;
        akt.firma = { ...(akt.firma || {}), name: st.firma || akt.firma.name, inhaber: st.inhaberin || '', strasse: st.strasse || '', plz: st.plz || '', ort: st.ort || '', telefon: st.telefon || '', email: st.email || '' };
        akt.kleinunternehmer = !!st.kleinunternehmer;
        if (logo !== undefined) akt.logo = logo;
        speichereBetrieb(akt);
      }
    }));
  }
  function mandantFuer(req) {
    if (istAdmin(req)) return novaflow();
    const slug = req.zugriff && req.zugriff.scope;
    return slug ? betriebMandant(slug) : null;
  }
  app.use((req, res, next) => {
    const p = req.path;
    if (!(p.startsWith('/api/abrechnung') || p === '/abrechnung' || p.startsWith('/abrechnung/'))) return next();
    const m = mandantFuer(req);
    if (!m) return p.startsWith('/api/') ? res.status(403).json({ success: false, error: 'Bitte zuerst anmelden.' }) : res.redirect('/login.html');
    // Läuft für diesen Betrieb gerade die Altdaten-Übernahme, erst abwarten
    const slug = req.zugriff && req.zugriff.scope;
    const laufend = slug && uebernahmen.get(slug);
    if (laufend) return laufend.then(() => m.router(req, res, next), () => m.router(req, res, next));
    return m.router(req, res, next);
  });
  // Beim Start alle vorhandenen Bestände laden (damit Abo-Lauf und Sicherungen für alle laufen)
  novaflow();
  const kandidaten = new Set();
  ['abrechnung-betriebe', 'angebote', 'rechnungen'].forEach(d => { const dir = path.join(DATA_DIR, d); if (fs.existsSync(dir)) fs.readdirSync(dir).forEach(slug => kandidaten.add(slug)); });
  kandidaten.forEach(slug => { try { betriebMandant(slug); } catch (e) { console.error('Abrechnung Betrieb', slug, e.message); } });
  function statistikFuer(slug) {
    const m = betriebMandant(slug);
    return m ? m.statistik() : null;
  }
  return { mandantFuer, statistikFuer };
}

module.exports = { nurAdmin, registriere, bauMandant };
