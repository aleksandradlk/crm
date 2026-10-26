// ============================================================
// Bedarfsanalyse: Felder, Pflichtfragen, Paket-Vorschlag und Preise.
// Eine Datei für Server (require) und Oberfläche (<script>), damit beide
// dieselben Regeln rechnen. Zahlen kommen aus der Konfiguration
// (app_settings.vertrieb_regeln), STANDARD gilt, solange nichts gespeichert ist.
// ============================================================
(function (root) {
  const STANDARD = {
    pakete: {
      quickwin: { name: 'Quick-Win', einrichtung: 490, betreuung: 59 },
      s: { name: 'Autopilot S', einrichtung: 1490, betreuung: 99 },
      m: { name: 'Autopilot M', einrichtung: 2490, betreuung: 199 },
      l: { name: 'Autopilot L', einrichtung: 3990, betreuung: 349 },
      software: { name: 'Individuelle Software', einrichtung: 2490, betreuung: 199, ab: true },
    },
    zusatz: {
      google: { name: 'Google Business Profil', einrichtung: 349, betreuung: 0 },
      webseite: { name: 'Webseite', einrichtung: 1200, betreuung: 29 },
      automation: { name: 'Weitere Automation', einrichtung: 0, betreuung: 0 },
    },
    rabatt_grenze: 20,
    nachfass_tage: [2, 5, 10],
    anfrage_warte_std: 24,
    admin_mail: 'info@novaflowservices.de',
    demo_link: 'https://novaflowservices.de/',
    regeln: { l_auftragswert: 5000, m_kanaele: 3, m_anfragen: 10 },
    gesundheit: ['arzt', 'ärzt', 'praxis', 'zahnarzt', 'heilpraktiker', 'therapie', 'therapeut', 'physio', 'pflege', 'klinik', 'ergo', 'logopäd', 'osteopath'],
  };

  // Auswahlwerte: [Schlüssel, Anzeige]
  const W = {
    branche: [['fahrzeug', 'Fahrzeugaufbereitung'], ['bad', 'Bad/SHK/Fliesen'], ['maler', 'Maler'], ['boden', 'Boden/Parkett'], ['andere', 'Andere']],
    teamgroesse: [['allein', 'allein'], ['2-5', '2–5'], ['6-20', '6–20'], ['20+', 'über 20']],
    janein: [['ja', 'Ja'], ['nein', 'Nein']],
    instagram_business: [['ja', 'Ja'], ['nein', 'Nein'], ['weiss_nicht', 'weiß nicht']],
    whatsapp_firmennummer: [['ja', 'Ja'], ['nein', 'Nein'], ['privat', 'privat']],
    kanaele: [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['whatsapp', 'WhatsApp'], ['telefon', 'Telefon'], ['email', 'E-Mail'],
      ['formular', 'Webseiten-Formular'], ['portale', 'Portale (MyHammer/Check24)'], ['google', 'Google'], ['empfehlung', 'Empfehlung'], ['telegram', 'Telegram/TikTok/Line']],
    antwortzeit: [['unter1', 'unter 1 Std.'], ['tag', 'am selben Tag'], ['1-2', '1–2 Tage'], ['laenger', 'länger']],
    nachfragen: [['fotos', 'Fotos'], ['masse', 'Maße'], ['budget', 'Budget'], ['termin', 'Termin'], ['adresse', 'Adresse'], ['objekt', 'Fahrzeug/Objekt'], ['sonstiges', 'Sonstiges']],
    zuerst_weg: [['liegen', 'Anfragen bleiben liegen'], ['preisfragen', 'Preisfragen ohne Infos'], ['besichtigungen', 'Besichtigungen umsonst'],
      ['terminabstimmung', 'Terminabstimmung'], ['nachfassen', 'Angebote nachfassen'], ['bewertungen', 'Bewertungen sammeln'],
      ['angebote', 'Angebote schreiben'], ['zahlungen', 'Zahlungen hinterherlaufen'], ['bestandskunden', 'Bestandskunden erinnern']],
    kalender: [['google', 'Google'], ['outlook', 'Outlook'], ['papier', 'Papier'], ['software', 'Software'], ['keiner', 'keiner']],
    webseite_status: [['ja', 'ja'], ['nein', 'nein'], ['veraltet', 'veraltet']],
    google_profil: [['ja', 'ja'], ['nein', 'nein'], ['schwach', 'schwach']],
    entscheider: [['allein', 'er/sie allein'], ['partner', 'mit Partner'], ['anderer', 'anderer']],
    paket_empfohlen: [['quickwin', 'Quick-Win'], ['s', 'Autopilot S'], ['m', 'Autopilot M'], ['l', 'Autopilot L'], ['software', 'Individuelle Software']],
    zusatzleistungen: [['google', 'Google Business Profil'], ['webseite', 'Webseite'], ['automation', 'weitere Automation']],
    reaktion_preis: [['passt', 'passt'], ['zoegert', 'zögert'], ['zu_teuer', 'zu teuer']],
    zahlungswunsch: [['5050', '50/50'], ['raten2', 'Raten 2 Monate'], ['raten3', 'Raten 3 Monate']],
  };
  const label = (feld, wert) => ((W[feld] || []).find(([k]) => k === wert) || [])[1] || wert || '';

  // Die 5 Pflichtfragen (Handbuch S. 9) und die Pflichtfelder im Ergebnis
  const leer = v => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
  const FRAGEN = [
    { nr: 1, titel: 'Kanäle', felder: ['kanaele', 'kanal_wichtigster'] },
    { nr: 2, titel: 'Menge', felder: ['anfragen_pro_woche'] },
    { nr: 3, titel: 'Ablauf heute', felder: ['ablauf_heute'] },
    { nr: 4, titel: 'Größter Zeitfresser', felder: ['groesstes_problem'] },
    { nr: 5, titel: 'Rahmen', felder: ['wunschstart', 'entscheider'] },
  ];
  const ERGEBNIS = [['paket_empfohlen', 'Paket'], ['preis_genannt', 'Preis genannt?'], ['nachfass_termin', 'Nachfass-Termin']];
  const FELDNAME = {
    kanaele: 'Kanäle', kanal_wichtigster: 'wichtigster Kanal', anfragen_pro_woche: 'Anfragen pro Woche', ablauf_heute: 'Ablauf heute',
    groesstes_problem: 'größtes Problem', wunschstart: 'Wunschstart', entscheider: 'Entscheider', rabatt_begruendung: 'Begründung für den Rabatt',
  };

  function cfgMit(cfg) {
    const c = cfg || {};
    return { ...STANDARD, ...c, pakete: { ...STANDARD.pakete, ...(c.pakete || {}) }, zusatz: { ...STANDARD.zusatz, ...(c.zusatz || {}) },
      regeln: { ...STANDARD.regeln, ...(c.regeln || {}) } };
  }

  function pruefen(d, cfg) {
    d = d || {};
    cfg = cfgMit(cfg);
    const fragen = FRAGEN.map(f => ({ ...f, ok: f.felder.every(k => !leer(d[k])) }));
    const fehlt = [];
    fragen.filter(f => !f.ok).forEach(f => fehlt.push(`${f.nr}. ${f.titel} (${f.felder.filter(k => leer(d[k])).map(k => FELDNAME[k]).join(', ')})`));
    ERGEBNIS.forEach(([k, l]) => { if (leer(d[k])) fehlt.push(l); });
    const rabatt = Number(d.rabatt_prozent) || 0;
    const rabattHoch = rabatt > cfg.rabatt_grenze;
    if (rabattHoch && leer(d.rabatt_begruendung)) fehlt.push(FELDNAME.rabatt_begruendung);
    const raten = /^raten/.test(d.zahlungswunsch || '');
    if (raten && d.paket_empfohlen === 'quickwin') fehlt.push('Raten gibt es erst ab Autopilot S');
    return {
      fragen, fragen_ok: fragen.filter(f => f.ok).length, fragen_gesamt: FRAGEN.length,
      fehlt, angebotsreif: !fehlt.length, rabatt_hoch: rabattHoch, gesundheit: gesundheit(d, cfg),
    };
  }

  function gesundheit(d, cfg) {
    const text = [d.branche === 'andere' ? d.branche_text : '', d.branche_text, d._industry].filter(Boolean).join(' ').toLowerCase();
    return !!text && cfgMit(cfg).gesundheit.some(w => text.includes(String(w).toLowerCase()));
  }

  const hat = (arr, liste) => (Array.isArray(arr) ? arr : []).some(x => liste.includes(x));

  // Paket-Vorschlag (Handbuch S. 8), Reihenfolge wie in der Tabelle
  function vorschlag(d, cfg) {
    d = d || {};
    cfg = cfgMit(cfg);
    const r = cfg.regeln;
    const kanaele = Array.isArray(d.kanaele) ? d.kanaele.length : 0;
    const anfragen = Number(d.anfragen_pro_woche) || 0;
    const wert = Number(d.auftragswert_schnitt) || 0;
    const notiz = [d.sonderwuensche, d.groesstes_problem, d.ablauf_heute, d.notiz].filter(Boolean).join(' ');
    let paket, grund;
    if (d.reaktion_preis === 'zu_teuer' || /testen/i.test(notiz)) {
      paket = 'quickwin'; grund = d.reaktion_preis === 'zu_teuer' ? 'Der Preis war zu hoch – mit einem kleinen Einstieg testen.' : 'Will erst testen – Einstieg mit Quick-Win.';
    } else if (['6-20', '20+'].includes(d.teamgroesse) || wert >= r.l_auftragswert || hat(d.zuerst_weg, ['angebote', 'zahlungen', 'bestandskunden'])) {
      paket = 'l';
      grund = ['6-20', '20+'].includes(d.teamgroesse) ? 'Größeres Team – lohnt sich mit allen Abläufen.'
        : wert >= r.l_auftragswert ? `Hohe Auftragswerte (ab ${r.l_auftragswert.toLocaleString('de-DE')} €) – jeder gewonnene Auftrag zählt.`
          : 'Will Angebote, Zahlungen oder Bestandskunden automatisieren.';
    } else if (kanaele >= r.m_kanaele || anfragen >= r.m_anfragen || hat(d.zuerst_weg, ['terminabstimmung', 'nachfassen', 'bewertungen'])) {
      paket = 'm';
      grund = kanaele >= r.m_kanaele ? `${kanaele} Kanäle – alles an einem Ort bündeln.`
        : anfragen >= r.m_anfragen ? `${anfragen} Anfragen pro Woche – automatisch vorsortieren spart viel Zeit.`
          : 'Will Termine, Nachfassen oder Bewertungen automatisieren.';
    } else {
      paket = 's'; grund = 'Überschaubare Anfragen – der solide Einstieg in den Autopiloten.';
    }
    const p = cfg.pakete[paket];
    const monat = Math.round((p.einrichtung / 12 + p.betreuung) / 10) * 10;

    const hinweise = [];
    if (['nein', 'schwach'].includes(d.google_profil)) hinweise.push(`+ ${cfg.zusatz.google.name} (${eur(cfg.zusatz.google.einrichtung)})`);
    if (['nein', 'veraltet'].includes(d.webseite_status)) hinweise.push(`+ ${cfg.zusatz.webseite.name} (${eur(cfg.zusatz.webseite.einrichtung)} + ${eur(cfg.zusatz.webseite.betreuung)}/Monat)`);
    const sw = String(d.software || '').toLowerCase();
    if (/craftnote|plancraft|tooltime/.test(sw) || (sw && !/lexware|hero|sevdesk|excel|keine|kein|^-$/.test(sw)))
      hinweise.push('Anbindung an diese Software nicht zusagen – Aleksandra prüft.');
    if (/lexware/.test(sw)) hinweise.push('Lexware Office: Anbindung erst ab Tarif XL.');
    if (hat(d.kanaele, ['telefon'])) hinweise.push('SMS bei verpasstem Anruf oder KI-Telefonassistent nur auf Anfrage (Cloud-Telefonie, laufende Kosten). Als Sonderwunsch notieren.');
    if (hat(d.kanaele, ['telegram'])) hinweise.push('Telegram/TikTok/Line: auf Anfrage.');
    return { paket, name: p.name, grund, einrichtung: p.einrichtung, betreuung: p.betreuung, monat_erstes_jahr: monat, ab: !!p.ab, hinweise };
  }

  function eur(v) { const n = Number(v || 0); return n.toLocaleString('de-DE', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }) + ' €'; }

  // Deal-Wert = Einrichtung Paket + Zusätze − Rabatt (Betreuung zählt nicht)
  function dealWert(d, cfg) {
    cfg = cfgMit(cfg);
    const p = cfg.pakete[d.paket_empfohlen];
    if (!p) return 0;
    const zus = (d.zusatzleistungen || []).reduce((s, k) => s + (cfg.zusatz[k]?.einrichtung || 0), 0);
    const rabatt = Math.min(100, Math.max(0, Number(d.rabatt_prozent) || 0));
    return Math.round((p.einrichtung + zus) * (1 - rabatt / 100) * 100) / 100;
  }

  // Positionen fürs Angebots-Tool (vorbefüllt)
  function positionen(d, cfg) {
    cfg = cfgMit(cfg);
    const p = cfg.pakete[d.paket_empfohlen];
    if (!p) return [];
    const rabatt = Math.min(100, Math.max(0, Number(d.rabatt_prozent) || 0));
    const out = [{ titel: `${p.name} – Einrichtung`, beschreibung: '', einzelpreis: p.einrichtung, rabatt, abrechnung: 'einmalig' }];
    if (p.betreuung) out.push({ titel: `${p.name} – Betreuung`, beschreibung: d.gratismonat === 'ja' ? 'Erster Monat gratis' : '', einzelpreis: p.betreuung, abrechnung: 'monatlich', einheit: 'Monat', einheitMehrzahl: 'Monate' });
    (d.zusatzleistungen || []).forEach(k => {
      const z = cfg.zusatz[k];
      if (!z) return;
      if (z.einrichtung) out.push({ titel: z.name, einzelpreis: z.einrichtung, rabatt, abrechnung: 'einmalig' });
      if (z.betreuung) out.push({ titel: `${z.name} – Hosting & Pflege`, einzelpreis: z.betreuung, abrechnung: 'monatlich', einheit: 'Monat', einheitMehrzahl: 'Monate' });
    });
    return out;
  }

  const api = { STANDARD, W, FRAGEN, ERGEBNIS, label, pruefen, vorschlag, dealWert, positionen, gesundheit, cfgMit, eur, leer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BedarfRegeln = api;
})(typeof window !== 'undefined' ? window : globalThis);
