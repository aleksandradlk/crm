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
      // einrichtung_bestehend: Preis, wenn das Profil schon besteht oder jemand anderes es betreut (übernehmen + optimieren)
      google: { name: 'Google Business Profil', einrichtung: 349, einrichtung_bestehend: 249, betreuung: 0 },
      webseite: { name: 'Webseite', einrichtung: 1200, betreuung: 29 },
      automation: { name: 'Weitere Automation', einrichtung: 0, betreuung: 0 },
    },
    rabatt_grenze: 20,
    nachfass_tage: [2, 5, 10],
    textlimit: 10000,          // max. Zeichen in großen Textfeldern der Bedarfsanalyse
    anfrage_warte_std: 24,
    admin_mail: 'info@novaflowservices.de',
    faellig_mail: true,                   // morgens eine Mail mit allem, was fällig ist
    demo_link: 'https://novaflowservices.de/#ausprobieren',   // Abschnitt „Nicht nur lesen. Ausprobieren.“
    // l_wenig_anfragen: unter so vielen Anfragen pro Woche über 1–2 Kanäle wird nie L vorgeschlagen
    regeln: { l_auftragswert: 5000, m_kanaele: 3, m_anfragen: 10, l_wenig_anfragen: 5 },
    // Provision und Bonus (§8): Basis = gezahlter Einmalpreis ohne Betreuung/Hosting
    provision: {
      satz: 20, satz_rabatt: 15,          // % – mit Rabatt > 0 vom reduzierten Preis
      upgrade_tage: 30,                   // Quick-Win → Autopilot beim selben Kunden: Basis − Quick-Win-Preis
      faellig_tage: 14,                   // Provision fällig = Zahlungseingang + X Tage
      ust: 19,                            // Aufschlag, wenn am Benutzer „zzgl. USt“
      bonus_pakete: ['s', 'm', 'l', 'software'],
      bonus_erster: 50,                   // einmalig für den allerersten bezahlten Abschluss (Vertrag § 4)
      bonus: [{ ab: 5, betrag: 150 }, { ab: 10, betrag: 300 }],   // pro Kalendermonat, zusammen 450 €
    },
    gesundheit: ['arzt', 'ärzt', 'praxis', 'zahnarzt', 'heilpraktiker', 'therapie', 'therapeut', 'physio', 'pflege', 'klinik', 'ergo', 'logopäd', 'osteopath'],
  };

  // Kurzinhalt je Paket für die Preis-Seitenleiste der Bedarfsanalyse (wie Leistungsübersicht)
  const INHALT = {
    quickwin: 'Handy-Benachrichtigung bei jeder Anfrage, automatische Eingangsbestätigung. In einer Woche fertig, wird bei Upgrade binnen 30 Tagen angerechnet.',
    s: 'Bis 2 Kanäle in einem Postfach, sofortige Antwort, Vorqualifizierung mit Fotos, Maßen und Wunsch, Übersicht aller Anfragen.',
    m: 'Alles aus S, dazu bis 4 Kanäle, KI-Antwortentwurf, KI-Angebotsentwurf, Terminvorschlag und Erinnerung, Nachfassen offener Angebote, Bewertungsanfrage.',
    l: 'Alles aus M, dazu Zahlungserinnerung, Erinnerung an Bestandskunden, Monatsübersicht mit Kennzahlen, Quartalsgespräch.',
    software: 'Eigene Tools für interne Abläufe, z. B. Kalkulation oder Auftragsübersicht. Preis nach Umfang.',
    google: 'Profil einrichten oder optimieren, Keywords für die Region, Bing und Apple, Bewertungslink mit QR-Code.',
    webseite: 'Leistungen, Preisrahmen, Anfrageformular direkt in den Autopiloten. Aktuell bis 4 Seiten inkl. Impressum und Datenschutz.',
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
    zuerst_weg: [['vor_rausfahren', 'Angebot vor dem Rausfahren'], ['nachfassen', 'Nachfassen'],
      ['liegen', 'Anfragen bleiben liegen'], ['preisfragen', 'Preisfragen ohne Infos'], ['besichtigungen', 'Besichtigungen umsonst'],
      ['terminabstimmung', 'Terminabstimmung'], ['bewertungen', 'Bewertungen sammeln'],
      ['angebote', 'Angebote schreiben'], ['zahlungen', 'Zahlungen hinterherlaufen'], ['bestandskunden', 'Bestandskunden erinnern']],
    kalender: [['google', 'Google'], ['outlook', 'Outlook'], ['papier', 'Papier'], ['software', 'Software'], ['keiner', 'keiner']],
    webseite_status: [['ja', 'besteht schon'], ['nein', 'nein'], ['veraltet', 'veraltet'], ['anderer', 'macht jemand anderes']],
    google_profil: [['ja', 'besteht schon'], ['nein', 'nein'], ['schwach', 'schwach'], ['anderer', 'macht jemand anderes']],
    entscheider: [['allein', 'er/sie allein'], ['partner', 'mit Partner'], ['anderer', 'anderer']],
    paket_empfohlen: [['quickwin', 'Quick-Win'], ['s', 'Autopilot S'], ['m', 'Autopilot M'], ['l', 'Autopilot L'], ['software', 'Individuelle Software']],
    zusatzleistungen: [['google', 'Google Business Profil'], ['webseite', 'Webseite'], ['automation', 'weitere Automation']],
    reaktion_preis: [['passt', 'passt'], ['zoegert', 'zögert'], ['zu_teuer', 'zu teuer']],
    zahlungswunsch: [['5050', '50/50'], ['raten2', 'Raten 2 Monate'], ['raten3', 'Raten 3 Monate']],
  };
  // Gründe für „Verloren“ (Deal) und „passt nicht“ (Lead) – Pflicht beim Speichern
  const GRUENDE = ['Falsche Branche', 'Zu groß', 'Kein Bedarf', 'Kein Budget', 'Gesundheitsbranche', 'Nicht erreicht', 'Sonstiges'];
  // „Sonstiges“ braucht einen Text; gespeichert wird „Grund: Text“
  function grundPruefen(grund, text) {
    const g = GRUENDE.find(x => x.toLowerCase() === String(grund || '').trim().toLowerCase());
    const t = String(text || '').trim().slice(0, 250);
    if (!g) return { fehler: 'Bitte einen Grund wählen.' };
    if (g === 'Sonstiges' && !t) return { fehler: 'Bei „Sonstiges“ bitte kurz beschreiben, warum.' };
    return { grund: g, text: t, voll: t ? `${g}: ${t}` : g };
  }
  // Lead-Status (Reihenfolge = Anzeige)
  const STATUS = [['neu', 'Neu'], ['kontaktiert', 'Kontaktiert'], ['nicht_erreicht', 'Nicht erreicht'], ['rueckruf', 'Rückruf'],
    ['kein_interesse', 'Kein Interesse'], ['passt_nicht', 'Passt nicht'], ['keine_anrufe', 'Keine Anrufe mehr'], ['kunde', 'Kunde']];

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
    sonderwuensche: 'Sonderwünsche', notiz: 'Notiz', einleitung_notiz: 'Für die Einleitung',
  };
  // Alle Felder mit Anzeigenamen (Verlauf, Konflikt-Ansicht, Änderungs-Stichpunkte)
  const FELDLABEL = {
  ansprechpartner_rolle: 'Ansprechpartner', branche: 'Branche', branche_text: 'Branche (Text)', email_angebot: 'E-Mail fürs Angebot',
  webseite: 'Webseite', instagram: 'Instagram', teamgroesse: 'Teamgröße', buero_vorhanden: 'Büro vorhanden', kanaele: 'Kanäle',
  kanal_wichtigster: 'Wichtigster Kanal', instagram_business: 'Instagram Business', whatsapp_firmennummer: 'WhatsApp Firmennummer',
  anfragen_pro_woche: 'Anfragen pro Woche', anfragen_unpassend: 'Davon unpassend', auftragswert_schnitt: 'Auftragswert im Schnitt',
  ablauf_heute: 'Ablauf heute', antwortzeit: 'Antwortzeit', nachfragen: 'Was fragt er nach?', besichtigungen: 'Besichtigungen',
  groesstes_problem: 'Größtes Problem', zuerst_weg: 'Was soll zuerst weg?', wunschstart: 'Wunschstart', software: 'Software',
  kalender: 'Kalender', webseite_status: 'Webseite (Stand)', google_profil: 'Google-Profil', entscheider: 'Entscheider',
  entscheider_text: 'Entscheider (Text)', paket_empfohlen: 'Paket', zusatzleistungen: 'Zusatzleistungen', preis_genannt: 'Preis genannt',
  reaktion_preis: 'Reaktion auf den Preis', rabatt_prozent: 'Rabatt %', rabatt_begruendung: 'Begründung Rabatt', gratismonat: 'Gratismonat',
  zahlungswunsch: 'Zahlungswunsch', sonderwuensche: 'Sonderwünsche', nachfass_termin: 'Nachfass-Termin', notiz: 'Notiz',
  einleitung_notiz: 'Für die Einleitung', aktion_prozent: 'Aktion %', aktion_bis: 'Aktion gültig bis',
};
  // Google-Profil: besteht schon (auch „schwach“) oder wird von jemand anderem betreut → übernehmen und optimieren (günstiger)
  const GOOGLE_BESTEHEND = ['ja', 'schwach', 'anderer'];
  function googlePreis(d, cfg) {
    const g = cfgMit(cfg).zusatz.google;
    return GOOGLE_BESTEHEND.includes(d && d.google_profil) && g.einrichtung_bestehend != null ? g.einrichtung_bestehend : g.einrichtung;
  }
  const zusatzPreis = (k, d, cfg) => k === 'google' ? googlePreis(d, cfg) : (cfgMit(cfg).zusatz[k]?.einrichtung || 0);
  // Rabatt im Angebot: eigener Rabatt des Vertrieblers, sonst eine zugesagte Aktion
  const angebotsRabatt = d => Math.min(100, Math.max(0, Number(d.rabatt_prozent) || Number(d.aktion_prozent) || 0));

  function cfgMit(cfg) {
    const c = { ...(cfg || {}) };
    // Früherer Standard ohne Anker → auf den Abschnitt „Ausprobieren“ zeigen
    if (/^https:\/\/novaflowservices\.de\/?$/.test(c.demo_link || '')) delete c.demo_link;
    return { ...STANDARD, ...c, pakete: { ...STANDARD.pakete, ...(c.pakete || {}) }, zusatz: { ...STANDARD.zusatz, ...(c.zusatz || {}) },
      regeln: { ...STANDARD.regeln, ...(c.regeln || {}) }, provision: { ...STANDARD.provision, ...(c.provision || {}) } };
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
    } else if ((['6-20', '20+'].includes(d.teamgroesse) || wert >= r.l_auftragswert || hat(d.zuerst_weg, ['zahlungen', 'bestandskunden']))
      && !(kanaele > 0 && kanaele <= 2 && anfragen > 0 && anfragen < (r.l_wenig_anfragen ?? 5))) {
      paket = 'l';
      grund = ['6-20', '20+'].includes(d.teamgroesse) ? 'Größeres Team – lohnt sich mit allen Abläufen.'
        : wert >= r.l_auftragswert ? `Hohe Auftragswerte (ab ${r.l_auftragswert.toLocaleString('de-DE')} €) – jeder gewonnene Auftrag zählt.`
          : 'Will Zahlungen oder Bestandskunden automatisieren.';
    } else if (kanaele >= r.m_kanaele || anfragen >= r.m_anfragen || hat(d.zuerst_weg, ['angebote', 'vor_rausfahren', 'terminabstimmung', 'nachfassen', 'bewertungen'])) {
      paket = 'm';
      grund = kanaele >= r.m_kanaele ? `${kanaele} Kanäle – alles an einem Ort bündeln.`
        : anfragen >= r.m_anfragen ? `${anfragen} Anfragen pro Woche – automatisch vorsortieren spart viel Zeit.`
          : hat(d.zuerst_weg, ['vor_rausfahren', 'angebote']) ? 'Will Angebote schneller raus haben, am besten bevor er rausfährt.'
            : 'Will Termine, Nachfassen oder Bewertungen automatisieren.';
    } else {
      paket = 's'; grund = 'Überschaubare Anfragen – der solide Einstieg in den Autopiloten.';
    }
    // Hoher Auftragswert, aber wenige Anfragen über 1–2 Kanäle: L lohnt sich (noch) nicht
    if (paket !== 'l' && paket !== 'quickwin' && kanaele > 0 && kanaele <= 2 && anfragen > 0 && anfragen < (r.l_wenig_anfragen ?? 5)
        && (['6-20', '20+'].includes(d.teamgroesse) || wert >= r.l_auftragswert || hat(d.zuerst_weg, ['zahlungen', 'bestandskunden'])))
      grund = `Nur ${anfragen} Anfragen pro Woche über ${kanaele} ${kanaele === 1 ? 'Kanal' : 'Kanäle'} – L lohnt sich noch nicht. ` + grund;
    const p = cfg.pakete[paket];
    const monat = Math.round((p.einrichtung / 12 + p.betreuung) / 10) * 10;

    const hinweise = [];
    if (['nein', 'schwach'].includes(d.google_profil) && !hat(d.zusatzleistungen, ['google'])) hinweise.push(`+ ${cfg.zusatz.google.name} (${eur(googlePreis(d, cfg))})`);
    if (GOOGLE_BESTEHEND.includes(d.google_profil) && hat(d.zusatzleistungen, ['google']))
      hinweise.push(`${cfg.zusatz.google.name}: Profil ${{ ja: 'besteht schon', schwach: 'besteht, ist aber schwach', anderer: 'betreut jemand anderes' }[d.google_profil]} – übernehmen und optimieren für ${eur(googlePreis(d, cfg))}.`);
    if (d.webseite_status === 'anderer' && hat(d.zusatzleistungen, ['webseite'])) hinweise.push('Webseite macht jemand anderes – vorher klären, ob wir sie übernehmen sollen.');
    if (Number(d.aktion_prozent) > 0) hinweise.push(`Zugesagte Aktion: ${d.aktion_prozent} %${d.aktion_bis ? ' bis ' + String(d.aktion_bis).split('-').reverse().join('.') : ''}${Number(d.rabatt_prozent) > 0 ? ' (im Angebot gilt der eigene Rabatt)' : ''}.`);
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
    const zus = (d.zusatzleistungen || []).reduce((s, k) => s + zusatzPreis(k, d, cfg), 0);
    const rabatt = angebotsRabatt(d);
    return Math.round((p.einrichtung + zus) * (1 - rabatt / 100) * 100) / 100;
  }

  // Positionen fürs Angebots-Tool (vorbefüllt)
  function positionen(d, cfg) {
    cfg = cfgMit(cfg);
    const p = cfg.pakete[d.paket_empfohlen];
    if (!p) return [];
    const rabatt = angebotsRabatt(d);
    const key = d.paket_empfohlen;
    const out = [{ key, titel: `${p.name} – Einrichtung`, beschreibung: '', einzelpreis: p.einrichtung, rabatt, abrechnung: 'einmalig' }];
    if (p.betreuung) out.push({ key, titel: `${p.name} – Betreuung`, beschreibung: d.gratismonat === 'ja' ? 'Erster Monat gratis' : '', einzelpreis: p.betreuung, abrechnung: 'monatlich', einheit: 'Monat', einheitMehrzahl: 'Monate' });
    (d.zusatzleistungen || []).forEach(k => {
      const z = cfg.zusatz[k];
      if (!z) return;
      const preis = zusatzPreis(k, d, cfg);
      if (preis) out.push({ key: k, titel: z.name, beschreibung: k === 'google' && preis !== z.einrichtung ? 'Bestehendes Profil übernehmen und optimieren' : '', einzelpreis: preis, rabatt, abrechnung: 'einmalig' });
      if (z.betreuung) out.push({ key: k, titel: `${z.name} – Hosting & Pflege`, einzelpreis: z.betreuung, abrechnung: 'monatlich', einheit: 'Monat', einheitMehrzahl: 'Monate' });
    });
    return out;
  }

  // Stichpunkte, was sich zwischen zwei Ständen geändert hat (für den Verlauf), z. B.
  // „Instagram hinzugefügt (Kanäle)“, „Paket: Autopilot M → Autopilot L“, „Größtes Problem ergänzt“
  function aenderungen(alt, neu) {
    alt = alt || {}; neu = neu || {};
    const LANGTEXT = ['ablauf_heute', 'groesstes_problem', 'sonderwuensche', 'notiz', 'rabatt_begruendung', 'einleitung_notiz'];
    const L = (f, v) => label(f === 'kanal_wichtigster' ? 'kanaele' : f, v);
    const out = [];
    for (const f of Object.keys(FELDLABEL)) {
      const a = alt[f], b = neu[f];
      if ((leer(a) && leer(b)) || JSON.stringify(a) === JSON.stringify(b)) continue;
      const name = FELDLABEL[f];
      if (Array.isArray(a) || Array.isArray(b)) {
        const A = Array.isArray(a) ? a : [], B = Array.isArray(b) ? b : [];
        B.filter(x => !A.includes(x)).forEach(x => out.push(`${L(f, x)} hinzugefügt (${name})`));
        A.filter(x => !B.includes(x)).forEach(x => out.push(`${L(f, x)} entfernt (${name})`));
      } else if (LANGTEXT.includes(f)) {
        const sa = String(a || '').trim(), sb = String(b || '').trim();
        out.push(!sa ? `${name} eingetragen` : !sb ? `${name} gelöscht` : sb.startsWith(sa) ? `${name} ergänzt` : sb.length < sa.length - 20 ? `${name} gekürzt` : `${name} geändert`);
      } else if (leer(a)) out.push(`${name}: ${L(f, b)}`);
      else if (leer(b)) out.push(`${name} entfernt`);
      else out.push(`${name}: ${L(f, a)} → ${L(f, b)}`);
    }
    return out;
  }

  const api = { GRUENDE, grundPruefen, STATUS, STANDARD, W, FELDNAME, FELDLABEL, INHALT, googlePreis, aenderungen, FRAGEN, ERGEBNIS, label, pruefen, vorschlag, dealWert, positionen, gesundheit, cfgMit, eur, leer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BedarfRegeln = api;
})(typeof window !== 'undefined' ? window : globalThis);
