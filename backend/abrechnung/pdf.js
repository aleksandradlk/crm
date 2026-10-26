// PDF-Erzeugung für Angebote und Rechnungen (Abrechnungs-Modul).
// Layout nach NovaFlow-Markensystem: Montserrat eingebettet, Navy/Ink/Grau,
// kein Kupfer. Fußzeile auf jeder Seite mit "Seite X von Y".
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(path.dirname(require.resolve('@fontsource/montserrat/package.json')), 'files');
const FONTS = {
  regular: path.join(FONT_DIR, 'montserrat-latin-400-normal.woff'),
  semibold: path.join(FONT_DIR, 'montserrat-latin-600-normal.woff'),
  bold: path.join(FONT_DIR, 'montserrat-latin-700-normal.woff')
};
const LOGO = path.join(__dirname, 'novaflow-logo.png');

const NAVY = '#2C3A55';
const INK = '#1A2330';
const GRAU = '#59616E';
const TABELLENKOPF = '#F5F7FA';
const LINIE = '#D5DCE6';

const SEITE = { breite: 595.28, hoehe: 841.89 };
const RAND = { links: 50, rechts: 50, oben: 100, unten: 105 };
const INHALT_BREITE = SEITE.breite - RAND.links - RAND.rechts;
const INHALT_UNTEN = SEITE.hoehe - RAND.unten;

function euro(n) {
  return (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}
function menge(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}
function datum(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function round2(n) { return Math.round(n * 100) / 100; }

function neuesDokument() {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: RAND.oben, bottom: RAND.unten, left: RAND.links, right: RAND.rechts },
    bufferPages: true,
    info: { Producer: 'NovaFlow Services', Creator: 'NovaFlow Angebot-Tool' }
  });
  doc.registerFont('M400', FONTS.regular);
  doc.registerFont('M600', FONTS.semibold);
  doc.registerFont('M700', FONTS.bold);
  return doc;
}

function platzSicherstellen(doc, benoetigt) {
  if (doc.y + benoetigt > INHALT_UNTEN) {
    doc.addPage();
  }
}

// ── Kopf & Fuß auf jeder Seite ────────────────────────────────
function kopfUndFussZeichnen(doc, absender, entwurf) {
  const range = doc.bufferedPageRange();
  const gesamt = range.count;
  for (let i = 0; i < gesamt; i++) {
    doc.switchToPage(range.start + i);
    // Kopf und Fuß liegen außerhalb des Satzspiegels; ohne Rand-Nullung
    // würde pdfkit beim Schreiben in die Fußzone automatisch neue Seiten anlegen.
    doc.page.margins.bottom = 0;
    doc.page.margins.top = 0;

    const abs = absender || {};
    if (abs.marke === 'novaflow') {
      // NovaFlow: Bildmarke + Schriftzug
      const logoHoehe = 30;
      const logoBreite = logoHoehe * (221 / 160);
      try { doc.image(LOGO, RAND.links, 34, { height: logoHoehe }); } catch (e) { /* ohne Logo weiter */ }
      doc.font('M600').fontSize(15).fillColor(NAVY).text('NovaFlow', RAND.links + logoBreite + 10, 36, { lineBreak: false });
      doc.font('M400').fontSize(8.5).fillColor(GRAU).text('Services', RAND.links + logoBreite + 10, 55, { lineBreak: false });
    } else {
      // Betrieb: eigenes Logo (falls hochgeladen) und Firmenname
      let x = RAND.links;
      if (abs.logo && /^data:image\/(png|jpe?g);base64,/.test(abs.logo)) {
        try {
          const bild = Buffer.from(abs.logo.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          doc.image(bild, RAND.links, 30, { fit: [110, 40] });
          x = RAND.links + 120;
        } catch (e) { /* Logo nicht lesbar – nur Name */ }
      }
      doc.font('M600').fontSize(14).fillColor(NAVY).text(abs.firma || '', x, 38, { width: 300, lineBreak: false });
    }

    if (entwurf) {
      doc.font('M700').fontSize(9).fillColor('#B3261E')
        .text('ENTWURF – keine gültige Rechnung', RAND.links, 40, { width: INHALT_BREITE, align: 'right', lineBreak: false });
    }

    // Fußzeile
    const fussY = SEITE.hoehe - 82;
    doc.moveTo(RAND.links, fussY - 8).lineTo(SEITE.breite - RAND.rechts, fussY - 8).lineWidth(0.6).strokeColor(NAVY).stroke();
    // Spaltenbreiten: Firma | Kontakt | Bank (breiter, wegen IBAN) | Seitenzahl
    const spalten = [165, 125, 150, INHALT_BREITE - 165 - 125 - 150];
    const spaltenX = [0, 165, 290, 440];
    const s = absender || {};
    const bank = s.bank || {};
    const blocks = [
      [s.firma || '', s.inhaberin ? (s.inhaberLabel || 'Inhaberin') + ': ' + s.inhaberin : '', s.strasse || '', [s.plz, s.ort].filter(Boolean).join(' '), s.steuernummer ? 'Steuernr.: ' + s.steuernummer : ''],
      ['Kontakt', s.telefon || '', s.email || '', s.website || ''],
      ['Bankverbindung', bank.name || '', bank.iban ? 'IBAN ' + bank.iban : '', bank.bic ? 'BIC ' + bank.bic : '', bank.kontoinhaberin ? (s.marke === 'novaflow' ? 'Inhaberin: ' : 'Inhaber/in: ') + bank.kontoinhaberin : ''],
    ];
    blocks.forEach((zeilen, idx) => {
      const x = RAND.links + spaltenX[idx];
      zeilen = zeilen.filter(Boolean);
      zeilen.forEach((z, zi) => {
        doc.font(zi === 0 ? 'M600' : 'M400').fontSize(7).fillColor(zi === 0 ? NAVY : GRAU)
          .text(z, x, fussY + zi * 9.5, { width: spalten[idx] - 8, lineBreak: false, ellipsis: false });
      });
    });
    doc.font('M400').fontSize(7).fillColor(GRAU)
      .text(`Seite ${i + 1} von ${gesamt}`, RAND.links + spaltenX[3], fussY, { width: spalten[3], align: 'right', lineBreak: false });
  }
}

// ── Gemeinsame Bausteine ──────────────────────────────────────
function adressblockUndMeta(doc, absender, kunde, meta) {
  const s = absender || {};
  const absenderzeile = [s.firma, s.inhaberin, s.strasse, [s.plz, s.ort].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  doc.font('M400').fontSize(7).fillColor(GRAU).text(absenderzeile, RAND.links, RAND.oben, { width: 300, lineBreak: false });

  let y = RAND.oben + 14;
  const k = kunde || {};
  doc.font('M600').fontSize(10).fillColor(INK).text(k.firma || '', RAND.links, y, { width: 280 });
  doc.font('M400').fontSize(10).fillColor(INK);
  [k.ansprechpartner, k.strasse, [k.plz, k.ort].filter(Boolean).join(' ')].filter(Boolean).forEach(z => {
    doc.text(z, RAND.links, doc.y, { width: 280 });
  });
  const adressEnde = doc.y;

  // Meta rechts
  const metaX = 325;
  const labelBreite = 92;
  const metaBreite = SEITE.breite - RAND.rechts - metaX;
  let my = RAND.oben + 14;
  meta.forEach(([label, wert]) => {
    if (!wert) return;
    doc.font('M400').fontSize(8.5).fillColor(GRAU).text(label, metaX, my, { width: labelBreite, lineBreak: false });
    doc.font('M600').fontSize(8.5).fillColor(INK).text(wert, metaX + labelBreite, my, { width: metaBreite - labelBreite, lineBreak: false });
    my += 13;
  });

  doc.y = Math.max(adressEnde, my) + 26;
}

function titel(doc, text, untertitel) {
  doc.font('M600').fontSize(16).fillColor(NAVY).text(text, RAND.links, doc.y, { width: INHALT_BREITE });
  if (untertitel) {
    doc.font('M600').fontSize(10.5).fillColor(INK).text(untertitel, RAND.links, doc.y + 2, { width: INHALT_BREITE });
  }
  doc.y += 12;
}

function absatz(doc, text, opts = {}) {
  if (!text) return;
  doc.font(opts.font || 'M400').fontSize(opts.groesse || 10).fillColor(opts.farbe || INK);
  platzSicherstellen(doc, doc.heightOfString(text, { width: INHALT_BREITE }) + 4);
  doc.text(text, RAND.links, doc.y, { width: INHALT_BREITE, lineGap: 2 });
  doc.y += opts.abstand == null ? 10 : opts.abstand;
}

function ueberschrift(doc, text) {
  platzSicherstellen(doc, 30);
  doc.font('M600').fontSize(10).fillColor(NAVY).text(text, RAND.links, doc.y, { width: INHALT_BREITE });
  doc.y += 4;
}

// Positionen-Tabelle mit Seitenumbruch
function positionenTabelle(doc, positionen) {
  const spalten = [
    { key: 'pos', titel: 'Pos.', breite: 30, align: 'left' },
    { key: 'bez', titel: 'Bezeichnung', breite: 235, align: 'left' },
    { key: 'menge', titel: 'Menge', breite: 45, align: 'right' },
    { key: 'einheit', titel: 'Einheit', breite: 55, align: 'left' },
    { key: 'einzel', titel: 'Einzelpreis', breite: 65, align: 'right' },
    { key: 'gesamt', titel: 'Gesamt', breite: 65, align: 'right' }
  ];
  const xStart = RAND.links;
  const zeilenPad = 6;

  function kopf() {
    const h = 20;
    const y0 = doc.y;
    doc.rect(xStart, y0, INHALT_BREITE, h).fill(TABELLENKOPF);
    let x = xStart;
    spalten.forEach(sp => {
      doc.font('M600').fontSize(8.5).fillColor(NAVY)
        .text(sp.titel, x + 5, y0 + 6, { width: sp.breite - 10, align: sp.align, lineBreak: false });
      x += sp.breite;
    });
    doc.y = y0 + h;
  }

  platzSicherstellen(doc, 60);
  kopf();

  positionen.forEach((p, i) => {
    const rabatt = Number(p.rabatt) || 0;
    const vollpreis = round2((Number(p.menge) || 0) * (Number(p.einzelpreis) || 0));
    const gesamt = round2(vollpreis * (1 - rabatt / 100));
    const rabattText = rabatt > 0 ? `abzgl. ${menge(rabatt)} % Rabatt (${euro(gesamt - vollpreis)})` : '';
    const bezBreite = spalten[1].breite - 10;
    doc.font('M600').fontSize(9.5);
    const titelH = doc.heightOfString(p.titel || '', { width: bezBreite });
    doc.font('M400').fontSize(8.5);
    const beschrH = p.beschreibung ? doc.heightOfString(p.beschreibung, { width: bezBreite, lineGap: 1 }) + 3 : 0;
    const rabattH = rabattText ? 12 : 0;
    const zeilenH = titelH + beschrH + rabattH + zeilenPad * 2;

    if (doc.y + zeilenH > INHALT_UNTEN) {
      doc.addPage();
      kopf();
    }
    const y0 = doc.y;
    let x = xStart;
    const zelle = (text, sp, font, groesse, farbe) => {
      doc.font(font).fontSize(groesse).fillColor(farbe)
        .text(text, x + 5, y0 + zeilenPad, { width: sp.breite - 10, align: sp.align, lineBreak: false });
    };
    zelle(String(i + 1), spalten[0], 'M400', 9, GRAU); x += spalten[0].breite;
    doc.font('M600').fontSize(9.5).fillColor(INK).text(p.titel || '', x + 5, y0 + zeilenPad, { width: bezBreite });
    if (p.beschreibung) {
      doc.font('M400').fontSize(8.5).fillColor(GRAU).text(p.beschreibung, x + 5, y0 + zeilenPad + titelH + 3, { width: bezBreite, lineGap: 1 });
    }
    if (rabattText) {
      doc.font('M600').fontSize(8.5).fillColor(GRAU).text(rabattText, x + 5, y0 + zeilenPad + titelH + beschrH + 2, { width: bezBreite, lineBreak: false });
    }
    x += spalten[1].breite;
    zelle(menge(p.menge), spalten[2], 'M400', 9, INK); x += spalten[2].breite;
    zelle((Number(p.menge) !== 1 && p.einheitMehrzahl) ? p.einheitMehrzahl : (p.einheit || ''), spalten[3], 'M400', 9, INK); x += spalten[3].breite;
    zelle(euro(p.einzelpreis), spalten[4], 'M400', 9, INK); x += spalten[4].breite;
    zelle(euro(gesamt), spalten[5], 'M600', 9, INK);

    doc.y = y0 + zeilenH;
    doc.moveTo(xStart, doc.y).lineTo(xStart + INHALT_BREITE, doc.y).lineWidth(0.4).strokeColor(LINIE).stroke();
  });
  doc.y += 8;
}

function summenBlock(doc, summen, kleinunternehmer, opts = {}) {
  const breite = 260;
  const wertBreite = 100;
  const x = SEITE.breite - RAND.rechts - breite;
  const zeile = (label, wert, fett, gross) => {
    platzSicherstellen(doc, 18);
    const y = doc.y;
    doc.font(fett ? 'M700' : 'M400').fontSize(gross ? 11 : 9.5).fillColor(INK);
    doc.text(label, x, y, { width: breite - wertBreite, lineBreak: false });
    doc.text(wert, x + breite - wertBreite, y, { width: wertBreite, align: 'right', lineBreak: false });
    doc.y = y + (gross ? 18 : 15);
  };
  const gesamtLabel = opts.gesamtLabel || 'Gesamtbetrag';
  if (summen.rabatt > 0) {
    zeile('Summe Positionen', euro(summen.positionenSumme));
    zeile('abzgl. Rabatt', euro(-summen.rabatt));
  }
  if (kleinunternehmer) {
    if (summen.rabatt > 0) zeile('Zwischensumme', euro(summen.netto));
    doc.moveTo(x, doc.y).lineTo(x + breite, doc.y).lineWidth(0.8).strokeColor(NAVY).stroke();
    doc.y += 6;
    zeile(gesamtLabel, euro(summen.brutto), true, true);
  } else {
    zeile('Zwischensumme netto', euro(summen.netto));
    zeile('zzgl. 19 % USt', euro(summen.ust));
    doc.moveTo(x, doc.y).lineTo(x + breite, doc.y).lineWidth(0.8).strokeColor(NAVY).stroke();
    doc.y += 6;
    zeile(gesamtLabel + ' brutto', euro(summen.brutto), true, true);
  }
  doc.y += 4;
  if (!kleinunternehmer) doc.y += 10;
  if (kleinunternehmer) {
    absatz(doc, 'Gemäß § 19 UStG wird aufgrund der Kleinunternehmerregelung keine Umsatzsteuer erhoben.', { groesse: 8.5, farbe: GRAU, abstand: 12 });
  }
}

function ratenplanTabelle(doc, raten) {
  const breite = 300;
  const x = RAND.links;
  platzSicherstellen(doc, 24 + raten.length * 16);
  let y = doc.y;
  doc.rect(x, y, breite, 18).fill(TABELLENKOPF);
  doc.font('M600').fontSize(8.5).fillColor(NAVY);
  doc.text('Rate', x + 5, y + 5, { width: 60, lineBreak: false });
  doc.text('Fälligkeit', x + 70, y + 5, { width: 100, lineBreak: false });
  doc.text('Betrag', x + 180, y + 5, { width: 110, align: 'right', lineBreak: false });
  y += 18;
  raten.forEach(r => {
    if (y + 16 > INHALT_UNTEN) { doc.addPage(); y = doc.y; }
    doc.font('M400').fontSize(9).fillColor(INK);
    doc.text(r.anzahlung ? 'Anzahlung' : `${r.nr} von ${raten.filter(x => !x.anzahlung).length}`, x + 5, y + 4, { width: 60, lineBreak: false });
    doc.text(datum(r.faelligAm), x + 70, y + 4, { width: 100, lineBreak: false });
    doc.font('M600').text(euro(r.betrag), x + 180, y + 4, { width: 110, align: 'right', lineBreak: false });
    y += 16;
    doc.moveTo(x, y).lineTo(x + breite, y).lineWidth(0.4).strokeColor(LINIE).stroke();
  });
  doc.y = y + 10;
}

// ── Angebot ───────────────────────────────────────────────────
// angebot: { nummer, datum, gueltigBis, betreff, anrede, einleitung, positionen, schlusstext, gruss,
//            zahlung: { art: 'einmal'|'raten', raten: [{nr, faelligAm, betrag}] }, monatlich: [{titel, preis, einheit, start}],
//            projektvereinbarung, summen: {netto, ust, brutto} }
function erzeugeAngebotPdf({ angebot, kunde, absender, kleinunternehmer }) {
  const doc = neuesDokument();
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const fertig = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  adressblockUndMeta(doc, absender, kunde, [
    ['Angebotsnr.', angebot.nummer],
    ['Datum', datum(angebot.datum)],
    ['Gültig bis', datum(angebot.gueltigBis)],
    ['Kundennr.', kunde && kunde.nummer]
  ]);

  titel(doc, `Angebot ${angebot.nummer}`, angebot.betreff);
  absatz(doc, angebot.anrede, { abstand: 6 });
  absatz(doc, angebot.einleitung);

  positionenTabelle(doc, angebot.positionen || []);
  summenBlock(doc, angebot.summen, kleinunternehmer, { gesamtLabel: 'Gesamtbetrag (einmalig)' });

  if (angebot.monatlich && angebot.monatlich.length) {
    ueberschrift(doc, 'Monatliche Leistungen');
    angebot.monatlich.forEach(m => {
      absatz(doc, `Zusätzlich ab ${datum(m.start)}: ${euro(m.preis)} pro ${m.einheit || 'Monat'} für ${m.titel}, monatlich kündbar${kleinunternehmer ? '' : ' (zzgl. 19 % USt)'}.`, { abstand: 4 });
    });
    doc.y += 8;
  }

  const raten = angebot.zahlung && angebot.zahlung.art === 'raten' ? (angebot.zahlung.raten || []) : [];
  // Überschrift, Einleitung und Ratentabelle zusammenhalten
  platzSicherstellen(doc, 60 + raten.length * 16);
  ueberschrift(doc, 'Zahlungsbedingungen');
  if (raten.length) {
    const n = raten.filter(r => !r.anzahlung).length;
    absatz(doc, raten[0].anzahlung
      ? `${menge(angebot.zahlung.ratenAnzahlung)} % Anzahlung bei Auftrag, der Rest in ${n} ${n === 1 ? 'Monatsrate' : 'monatlichen Raten'}, jeweils fällig zum angegebenen Datum:`
      : `Zahlung in ${n} monatlichen Raten, jeweils fällig zum angegebenen Datum:`, { abstand: 6 });
    ratenplanTabelle(doc, angebot.zahlung.raten);
  } else if (angebot.zahlung && angebot.zahlung.art === 'anzahlung') {
    const z = angebot.zahlung;
    const p = Number(z.anzahlungProzent) || 50;
    absatz(doc, `${menge(p)} % Anzahlung (${euro(z.anzahlungBetrag)}) ${z.anzahlungText || 'bei Auftragserteilung'}, die restlichen ${menge(round2(100 - p))} % (${euro(z.restBetrag)}) ${z.restText || 'nach Abschluss des Projekts'}. Jeweils zahlbar innerhalb von 14 Tagen nach Rechnungsstellung.`);
  } else {
    absatz(doc, 'Einmalzahlung, 14 Tage nach Rechnungsstellung.');
  }

  if (angebot.projektvereinbarung) {
    absatz(doc, 'Es gilt die beiliegende Projektvereinbarung.', { font: 'M600', abstand: 12 });
  }

  absatz(doc, angebot.schlusstext);
  absatz(doc, angebot.gruss, { abstand: 2 });
  absatz(doc, (absender && absender.inhaberin) || '', { font: 'M600' });

  kopfUndFussZeichnen(doc, absender, false);
  doc.end();
  return fertig;
}

// ── Rechnung ──────────────────────────────────────────────────
// rechnung: { nummer, typ: 'rechnung'|'storno', datum, faelligAm, leistungVon, leistungBis, titel, positionen,
//             bezug: { angebot, rate, ratenGesamt, original }, summen, entwurf }
function erzeugeRechnungPdf({ rechnung, kunde, absender, kleinunternehmer }) {
  const doc = neuesDokument();
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const fertig = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const istStorno = rechnung.typ === 'storno';
  const leistung = rechnung.leistungVon && rechnung.leistungBis && rechnung.leistungVon !== rechnung.leistungBis
    ? `${datum(rechnung.leistungVon)} – ${datum(rechnung.leistungBis)}`
    : datum(rechnung.leistungVon || rechnung.datum);
  const bezug = rechnung.bezug || {};

  adressblockUndMeta(doc, absender, kunde, [
    ['Rechnungsnr.', rechnung.nummer || 'ENTWURF'],
    ['Rechnungsdatum', datum(rechnung.datum)],
    [rechnung.leistungVon && rechnung.leistungBis && rechnung.leistungVon !== rechnung.leistungBis ? 'Leistungszeitraum' : 'Leistungsdatum', leistung],
    ['Fällig am', istStorno ? '' : datum(rechnung.faelligAm)],
    ['Kundennr.', kunde && kunde.nummer],
    ['Steuernr.', absender && absender.steuernummer]
  ]);

  const dokumentTyp = istStorno ? 'Stornorechnung' : bezug.anzahlung ? 'Anzahlungsrechnung' : bezug.schlussrechnung ? 'Schlussrechnung' : 'Rechnung';
  let kopfzeile = [dokumentTyp, rechnung.nummer || ''].filter(Boolean).join(' ');
  if (bezug.rate && !bezug.anzahlung && !bezug.schlussrechnung) kopfzeile += ` – Rate ${bezug.rate} von ${bezug.ratenGesamt}`;
  let unter = rechnung.titel || '';
  if (istStorno && bezug.original) unter = (unter ? unter + ' · ' : '') + `Storno zu Rechnung ${bezug.original}`;
  else if (bezug.angebot) unter = (unter ? unter + ' · ' : '') + `zu Angebot ${bezug.angebot}`;
  titel(doc, kopfzeile.trim(), unter);

  absatz(doc, rechnung.anrede, { abstand: 6 });
  const du = !!rechnung.du;
  absatz(doc, istStorno
    ? `hiermit storniere ich die Rechnung ${bezug.original || ''} vollständig. Die folgenden Positionen werden gutgeschrieben:`
    : (rechnung.einleitung || (du ? 'vielen Dank für die Zusammenarbeit. Hiermit stelle ich dir folgende Leistungen in Rechnung:' : 'vielen Dank für die Zusammenarbeit. Hiermit stelle ich Ihnen folgende Leistungen in Rechnung:')));

  positionenTabelle(doc, rechnung.positionen || []);
  summenBlock(doc, rechnung.summen, kleinunternehmer, { gesamtLabel: istStorno ? 'Gutschriftsbetrag' : 'Rechnungsbetrag' });

  if (!istStorno) {
    ueberschrift(doc, 'Zahlung');
    const bank = (absender && absender.bank) || {};
    absatz(doc, `Bitte ${du ? 'überweise' : 'überweisen Sie'} den Rechnungsbetrag bis zum ${datum(rechnung.faelligAm)} auf das folgende Konto. Verwendungszweck: ${rechnung.nummer || '(Rechnungsnummer)'}.`, { abstand: 6 });
    const bankzeilen = [bank.kontoinhaberin ? (absender && absender.marke === 'novaflow' ? 'Kontoinhaberin: ' : 'Kontoinhaber/in: ') + bank.kontoinhaberin : '', bank.name ? 'Bank: ' + bank.name : '', bank.iban ? 'IBAN: ' + bank.iban : '', bank.bic ? 'BIC: ' + bank.bic : ''].filter(Boolean);
    bankzeilen.forEach(z => absatz(doc, z, { groesse: 9.5, abstand: 1 }));
    doc.y += 10;
  }

  absatz(doc, rechnung.schlusstext);
  absatz(doc, rechnung.gruss, { abstand: 2 });
  absatz(doc, (absender && absender.inhaberin) || '', { font: 'M600' });

  kopfUndFussZeichnen(doc, absender, !!rechnung.entwurf);
  doc.end();
  return fertig;
}

// ── Mahnung ───────────────────────────────────────────────
// mahnung: { stufe: 1|2|3, datum, frist, gebuehr, gesamt, text (optional, ersetzt den Haupttext) }
// rechnung: { nummer, datum, faelligAm, brutto }
const MAHN_TITEL = { 1: 'Zahlungserinnerung', 2: '1. Mahnung', 3: '2. Mahnung' };
function erzeugeMahnungPdf({ mahnung, rechnung, kunde, absender, du, anrede, gruss }) {
  const doc = neuesDokument();
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const fertig = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const stufe = Number(mahnung.stufe) || 1;
  const titelText = MAHN_TITEL[stufe] || 'Zahlungserinnerung';

  adressblockUndMeta(doc, absender, kunde, [
    ['Datum', datum(mahnung.datum)],
    ['Rechnungsnr.', rechnung.nummer],
    ['Rechnungsdatum', datum(rechnung.datum)],
    ['War fällig am', datum(rechnung.faelligAm)],
    ['Neue Frist', datum(mahnung.frist)],
    ['Kundennr.', kunde && kunde.nummer]
  ]);

  titel(doc, titelText, `zu Rechnung ${rechnung.nummer} vom ${datum(rechnung.datum)}`);
  absatz(doc, anrede, { abstand: 6 });
  const sie = !du;
  const standard = {
    1: `${sie ? 'bestimmt ist es Ihnen nur durchgerutscht' : 'bestimmt ist es dir nur durchgerutscht'}: Die Rechnung ${rechnung.nummer} vom ${datum(rechnung.datum)} über ${euro(rechnung.brutto)} war am ${datum(rechnung.faelligAm)} fällig. Ein Zahlungseingang liegt mir bisher nicht vor. ${sie ? 'Bitte überweisen Sie' : 'Bitte überweise'} den Betrag bis zum ${datum(mahnung.frist)} auf das unten genannte Konto. ${sie ? 'Sollten Sie' : 'Solltest du'} die Zahlung in den letzten Tagen bereits veranlasst haben, ${sie ? 'betrachten Sie' : 'betrachte'} diese Erinnerung bitte als gegenstandslos.`,
    2: `trotz meiner Zahlungserinnerung ist die Rechnung ${rechnung.nummer} vom ${datum(rechnung.datum)} über ${euro(rechnung.brutto)} weiterhin offen. ${sie ? 'Ich bitte Sie' : 'Ich bitte dich'}, den unten aufgeführten Gesamtbetrag bis spätestens ${datum(mahnung.frist)} zu überweisen. ${sie ? 'Sollten Sie' : 'Solltest du'} zwischenzeitlich gezahlt haben, ${sie ? 'geben Sie' : 'gib'} mir bitte kurz Bescheid.`,
    3: `leider ist die Rechnung ${rechnung.nummer} vom ${datum(rechnung.datum)} über ${euro(rechnung.brutto)} trotz Zahlungserinnerung und Mahnung noch immer nicht beglichen. ${sie ? 'Ich fordere Sie' : 'Ich fordere dich'} hiermit letztmalig auf, den unten aufgeführten Gesamtbetrag bis spätestens ${datum(mahnung.frist)} zu überweisen. Geht die Zahlung bis dahin nicht ein, behalte ich mir vor, weitere Schritte einzuleiten und die daraus entstehenden Kosten in Rechnung zu stellen.`
  };
  absatz(doc, mahnung.text || standard[stufe] || standard[1]);

  // Betragstabelle
  const breite = 260;
  const x = SEITE.breite - RAND.rechts - breite;
  platzSicherstellen(doc, 70);
  const zeile = (label, wert, fett) => {
    const y = doc.y;
    doc.font(fett ? 'M700' : 'M400').fontSize(fett ? 11 : 9.5).fillColor(INK);
    doc.text(label, x, y, { width: 160, lineBreak: false });
    doc.text(wert, x + 160, y, { width: 100, align: 'right', lineBreak: false });
    doc.y = y + (fett ? 18 : 15);
  };
  doc.y += 4;
  zeile(`Rechnungsbetrag ${rechnung.nummer}`, euro(rechnung.brutto));
  if (Number(mahnung.gebuehr) > 0) zeile('Mahngebühr', euro(mahnung.gebuehr));
  doc.moveTo(x, doc.y).lineTo(x + breite, doc.y).lineWidth(0.8).strokeColor(NAVY).stroke();
  doc.y += 6;
  zeile('Zu zahlender Betrag', euro(mahnung.gesamt), true);
  doc.y += 10;

  ueberschrift(doc, 'Zahlung');
  const bank = (absender && absender.bank) || {};
  absatz(doc, `Verwendungszweck: ${rechnung.nummer}`, { abstand: 6 });
  [bank.kontoinhaberin ? (absender && absender.marke === 'novaflow' ? 'Kontoinhaberin: ' : 'Kontoinhaber/in: ') + bank.kontoinhaberin : '', bank.name ? 'Bank: ' + bank.name : '', bank.iban ? 'IBAN: ' + bank.iban : '', bank.bic ? 'BIC: ' + bank.bic : '']
    .filter(Boolean).forEach(z => absatz(doc, z, { groesse: 9.5, abstand: 1 }));
  doc.y += 10;
  absatz(doc, sie ? 'Vielen Dank für Ihr Verständnis.' : 'Vielen Dank für dein Verständnis.');
  absatz(doc, gruss, { abstand: 2 });
  absatz(doc, (absender && absender.inhaberin) || '', { font: 'M600' });

  kopfUndFussZeichnen(doc, absender, false);
  doc.end();
  return fertig;
}

module.exports = { erzeugeAngebotPdf, erzeugeRechnungPdf, erzeugeMahnungPdf, MAHN_TITEL };
