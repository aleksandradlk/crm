// ── Provision und Bonus (§8) ────────────────────────────────────────────────
// Wird nicht gespeichert, sondern bei jedem Aufruf berechnet – aus dem Angebot
// zum Deal und den daraus erstellten Rechnungen (Abrechnung). Gibt es noch kein
// Angebot, wird aus der Bedarfsanalyse bzw. dem Deal-Wert geschätzt.
//   Basis   = Einmalpreis (Einrichtung + Zusätze) netto, ohne Betreuung/Hosting
//   Satz    = 20 %, mit Rabatt 15 % vom reduzierten Preis (Gratismonat zählt nicht)
//   Upgrade = Quick-Win → Autopilot beim selben Kunden in 30 Tagen: Basis − Quick-Win-Preis
//   Fällig  = Zahlungseingang + 14 Tage, je Zahlung anteilig
//   USt     = + 19 %, wenn am Benutzer „zzgl. USt“ (nicht bei Sitz im Ausland)
// Alle Zahlen aus den Vertriebsregeln (cfg.provision). Closer sehen nur eigene Deals.
const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const bedarf = require('./bedarf');
const R      = bedarf.R;

let crm = null;   // Schnittstelle der Abrechnung (null, wenn sie nicht läuft)
router.verbinde = c => { crm = c; };

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const plusTage = (iso, t) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + t); return d.toISOString().slice(0, 10); };
const monatJetzt = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const monatParam = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || '')) ? m : monatJetzt();

function provisionsDaten(dealId) {
  if (!crm || typeof crm.provisionsDaten !== 'function') return null;
  try { return crm.provisionsDaten(dealId); } catch (e) { console.error('Provision (Abrechnung):', e.message); return null; }
}

// Zahlungsplan als Anteile, wenn es noch keine Rechnungen gibt
function planAusZahlung(art, prozent, raten, mitAnzahlung) {
  if (art === 'anzahlung') { const p = Math.min(99, Math.max(1, Number(prozent) || 50)) / 100; return [{ anteil: p, art: 'anzahlung' }, { anteil: 1 - p, art: 'rest' }]; }
  if (art === 'raten' && raten.length > 1) {
    const s = raten.reduce((a, b) => a + b, 0) || 1;
    // Mit Anzahlung: „Anzahlung, dann Rate 1 … n von n“ wie auf den Rechnungen
    if (mitAnzahlung) return raten.map((b, i) => ({ anteil: b / s, art: i ? 'rate' : 'anzahlung', nr: i, von: raten.length - 1 }));
    return raten.map((b, i) => ({ anteil: b / s, art: i ? 'rate' : 'anzahlung', nr: i + 1, von: raten.length }));
  }
  return [{ anteil: 1, art: 'einmal' }];
}
// Wunsch aus der Bedarfsanalyse: 50/50 oder 50 % bei Auftrag + Rest in n Monatsraten
function planAusWunsch(zw) {
  if (zw === '5050') return planAusZahlung('anzahlung', 50, []);
  const m = /^raten(\d+)/.exec(zw || '');
  if (!m) return planAusZahlung('einmal');
  const n = Math.max(1, parseInt(m[1]));
  return planAusZahlung('raten', 0, [n, ...Array(n).fill(1)], true);
}

// „X € bei Anzahlung, dann 3 × Y €“
function planText(teile) {
  const eur = R.eur;
  if (!teile.length) return '';
  if (teile.length === 1) return `${eur(teile[0].auszahlung)} nach Zahlungseingang`;
  const rest = teile.slice(1).map(t => t.auszahlung);
  const gleich = rest.every(b => Math.abs(b - rest[0]) < 0.02);
  return `${eur(teile[0].auszahlung)} bei Anzahlung, dann ${gleich ? (rest.length > 1 ? `${rest.length} × ` : '') + eur(rest[0]) : rest.map(eur).join(' + ')}`;
}

// Provision eines Deals. deal braucht id, lead_id, owner_id, status, paket, value, won_at.
async function berechne(deal, cfg, besitzer) {
  const P = cfg.provision;
  if (deal.status === 'lost') return { keine: true, grund: 'Der Deal ist verloren – keine Provision.' };
  if (besitzer && besitzer.role === 'admin') return { keine: true, grund: 'Deal eines Admins – keine Provision.' };

  let basisPreis, rabatt, plan, quelle, angebot = null, gutschrift = 0;
  let analyse = null;
  const ladeAnalyse = async () => analyse || (analyse = (await bedarf.analyseLaden(deal.lead_id).catch(() => null))?.data || {});
  const daten = provisionsDaten(deal.id);
  if (daten) {
    quelle = 'angebot';
    angebot = { nummer: daten.angebot.nummer, status: daten.angebot.status };
    basisPreis = daten.angebot.einmaligNetto;
    rabatt = daten.angebot.rabatt;
    gutschrift = daten.angebot.gutschrift || 0;
    if (daten.rechnungen.length) {
      const summe = daten.rechnungen.reduce((s, r) => s + r.netto, 0) || 1;
      plan = daten.rechnungen.map((r, i) => ({
        anteil: r.netto / summe, art: r.anzahlung || (i === 0 && r.ratenGesamt > 1) ? 'anzahlung' : r.ratenGesamt > 1 ? 'rate' : 'einmal',
        nr: r.rate, von: r.ratenGesamt, rechnung: r.nummer, rechnung_id: r.id, bezahlt_am: r.status === 'bezahlt' ? r.bezahltAm : null,
        zahlungsstatus: r.status, kunde_faellig: r.faelligAm }));
    } else plan = planAusZahlung(daten.angebot.zahlung.art, daten.angebot.zahlung.anzahlungProzent, daten.angebot.zahlung.raten, daten.angebot.zahlung.mitAnzahlung);
  } else {
    const d = await ladeAnalyse();
    if (d.paket_empfohlen && cfg.pakete[d.paket_empfohlen]) {
      quelle = 'bedarf';
      basisPreis = R.dealWert(d, cfg);
      rabatt = Number(d.rabatt_prozent) > 0;
      plan = planAusWunsch(d.zahlungswunsch);
    } else {
      quelle = 'deal';
      basisPreis = Number(deal.value) || 0;
      rabatt = false;
      plan = planAusZahlung('einmal');
    }
  }

  // Quick-Win-Upgrade: derselbe Kunde hatte kurz vorher einen gewonnenen Quick-Win
  const paket = deal.paket || (await ladeAnalyse()).paket_empfohlen || null;
  let upgrade = null;
  if (paket && paket !== 'quickwin') {
    const [[qw]] = await db.query(
      `SELECT id, won_at FROM deals WHERE lead_id=? AND id<>? AND status='won' AND paket='quickwin'
         AND won_at BETWEEN COALESCE(?, NOW()) - INTERVAL ? DAY AND COALESCE(?, NOW()) ORDER BY won_at DESC LIMIT 1`,
      [deal.lead_id, deal.id, deal.won_at || null, P.upgrade_tage, deal.won_at || null]);
    if (qw) {
      // Steht die Anrechnung schon als Minus-Position im Angebot, nicht doppelt abziehen – und sie ist kein Rabatt
      upgrade = gutschrift > 0
        ? { abzug: 0, im_angebot: gutschrift, quickwin_deal: qw.id }
        : { abzug: Number(cfg.pakete.quickwin?.einrichtung) || 0, quickwin_deal: qw.id };
      if (gutschrift > 0) rabatt = !!daten.angebot.rabattProzent;
    }
  }
  const basis = round2(Math.max(0, basisPreis - (upgrade ? upgrade.abzug : 0)));
  const satz = rabatt ? Number(P.satz_rabatt) : Number(P.satz);
  const netto = round2(basis * satz / 100);
  const mitUst = !!(besitzer && besitzer.provision_zzgl_ust && !besitzer.provision_ausland);
  const ustSatz = mitUst ? Number(P.ust) : 0;

  // Auf die Zahlungen verteilen, Rundungsrest auf die letzte. Stornierte Rechnungen: Anteil entfällt
  const storno = t => t.zahlungsstatus === 'storniert';
  const letzte = plan.map(t => !storno(t)).lastIndexOf(true);
  const soll = round2(netto * plan.filter(t => !storno(t)).reduce((x, t) => x + t.anteil, 0));
  let verteilt = 0;
  const heute = new Date().toISOString().slice(0, 10);
  // Schon ausgezahlte Teile (Admin hat „ausgezahlt“ markiert)
  const schluessel = plan.filter(t => t.rechnung_id).map(t => 'prov:' + t.rechnung_id);
  const ausgezahlt = {};
  if (schluessel.length) {
    const [rows] = await db.query('SELECT schluessel, ausgezahlt_am FROM provision_auszahlungen WHERE schluessel IN (?)', [schluessel]).catch(() => [[]]);
    rows.forEach(r => { ausgezahlt[r.schluessel] = r.ausgezahlt_am; });
  }
  const teile = plan.map((t, i) => {
    if (storno(t)) return { art: t.art, nr: t.nr || i + 1, von: t.von || plan.length, rechnung: t.rechnung || null, netto: 0, auszahlung: 0,
      kunde_bezahlt_am: null, rechnung_status: 'storniert', faellig_am: null, status: 'storniert' };
    const n = i === letzte ? round2(soll - verteilt) : round2(netto * t.anteil);
    verteilt = round2(verteilt + n);
    const faellig = t.bezahlt_am ? plusTage(t.bezahlt_am, Number(P.faellig_tage) || 0) : null;
    const key = t.rechnung_id ? 'prov:' + t.rechnung_id : null;
    const status = key && ausgezahlt[key] ? 'ausgezahlt' : t.bezahlt_am ? (faellig <= heute ? 'faellig' : 'bezahlt') : t.rechnung !== undefined ? 'offen' : 'geplant';
    return { art: t.art, nr: t.nr || i + 1, von: t.von || plan.length, rechnung: t.rechnung || null, schluessel: key, ausgezahlt_am: key ? ausgezahlt[key] || null : null, netto: n,
      auszahlung: round2(n * (1 + ustSatz / 100)), kunde_bezahlt_am: t.bezahlt_am || null, rechnung_status: t.zahlungsstatus || null, faellig_am: faellig, status };
  });

  const gueltig = teile.filter(t => t.status !== 'storniert');
  const nettoSoll = round2(gueltig.reduce((x, t) => x + t.netto, 0));
  const auszahlungSoll = round2(gueltig.reduce((x, t) => x + t.auszahlung, 0));
  return {
    quelle, geschaetzt: quelle !== 'angebot', angebot, paket, upgrade,
    basis_preis: round2(basisPreis), basis, rabatt, satz, netto: nettoSoll, netto_voll: netto,
    ust: { aktiv: mitUst, satz: ustSatz, ausland: !!(besitzer && besitzer.provision_ausland), betrag: round2(auszahlungSoll - nettoSoll) },
    auszahlung: auszahlungSoll, teile, text: planText(gueltig), storniert: gueltig.length < teile.length,
    erste_zahlung_da: teile.some(t => t.kunde_bezahlt_am),
  };
}

async function besitzerLaden(id) {
  const [[u]] = await db.query('SELECT id, full_name, role, provision_zzgl_ust, provision_ausland FROM users WHERE id=?', [id]);
  return u || null;
}

// Bonus-Zähler eines Closers für einen Monat (Monat der Unterschrift = Gewonnen-Datum).
// Ein Abschluss zählt nur mit S, M, L oder individueller Software und erst, wenn die erste
// Zahlung da ist. Einmalig: Bonus für den allerersten bezahlten Abschluss; pro Monat: Stufen.
async function zaehlbar(d, cfg) {
  let paket = d.paket;
  if (!paket) paket = (await bedarf.analyseLaden(d.lead_id).catch(() => null))?.data?.paket_empfohlen || null;
  if (!cfg.provision.bonus_pakete.includes(paket)) return null;
  const daten = provisionsDaten(d.id);
  return { paket, bezahlt: !!daten && daten.rechnungen.some(r => r.status === 'bezahlt') };
}
async function bonus(userId, monat, cfg) {
  const P = cfg.provision;
  const [deals] = await db.query(
    `SELECT d.id, d.title, d.lead_id, d.paket, d.won_at, l.company FROM deals d LEFT JOIN leads l ON l.id=d.lead_id
     WHERE d.owner_id=? AND d.status='won' AND DATE_FORMAT(d.won_at, '%Y-%m')=? ORDER BY d.won_at`, [userId, monat]);
  const zaehlt = [], wartet = [];
  for (const d of deals) {
    const z = await zaehlbar(d, cfg);
    if (!z) continue;
    (z.bezahlt ? zaehlt : wartet).push({ id: d.id, title: d.title, company: d.company, paket: z.paket, paket_name: cfg.pakete[z.paket]?.name || z.paket });
  }
  // Ältere Einträge mit „ab 1“ (frühere Standardwerte) gelten als Bonus für den ersten Abschluss
  const alle = [...P.bonus].map(s => ({ ab: Number(s.ab), betrag: Number(s.betrag) })).filter(s => s.ab > 0);
  const ersterBetrag = Number(P.bonus_erster ?? alle.find(s => s.ab === 1)?.betrag ?? 0);
  const stufen = alle.filter(s => s.ab > 1).sort((a, b) => a.ab - b.ab);
  // Erster Abschluss: gab es schon vor diesem Monat einen bezahlten, zählbaren?
  let frueher = false;
  if (ersterBetrag > 0) {
    const [alt] = await db.query(
      `SELECT id, lead_id, paket FROM deals WHERE owner_id=? AND status='won' AND won_at < ? ORDER BY won_at`, [userId, monat + '-01']);
    for (const d of alt) { const z = await zaehlbar(d, cfg); if (z && z.bezahlt) { frueher = true; break; } }
  }
  const n = zaehlt.length;
  const erster = { betrag: ersterBetrag, erreicht: !frueher && n > 0 && ersterBetrag > 0, schon_frueher: frueher };
  const erreicht = stufen.filter(s => n >= s.ab);
  const naechste = stufen.find(s => n < s.ab) || null;
  return { monat, anzahl: n, summe: erreicht.reduce((s, x) => s + x.betrag, 0) + (erster.erreicht ? ersterBetrag : 0),
    erster, stufen, naechste, fehlen: naechste ? naechste.ab - n : 0, zaehlt, wartet };
}

// Übersicht eines Closers: Provision je gewonnenem Deal (12 Monate) + Bonus des Monats
async function uebersicht(userId, monat, cfg) {
  const besitzer = await besitzerLaden(userId);
  const [deals] = await db.query(
    `SELECT d.id, d.title, d.lead_id, d.owner_id, d.status, d.paket, d.value, d.won_at, l.company
     FROM deals d LEFT JOIN leads l ON l.id=d.lead_id
     WHERE d.owner_id=? AND d.status='won' AND d.won_at >= NOW() - INTERVAL 365 DAY ORDER BY d.won_at DESC`, [userId]);
  const liste = [];
  let faelligMonat = 0, ausstehend = 0, verdient = 0;
  for (const d of deals) {
    const p = await berechne(d, cfg, besitzer);
    if (p.keine) continue;
    p.teile.forEach(t => {
      if (t.faellig_am && t.faellig_am.slice(0, 7) === monat) faelligMonat += t.auszahlung;
      if (t.kunde_bezahlt_am) verdient += t.auszahlung; else ausstehend += t.auszahlung;
    });
    liste.push({ id: d.id, title: d.title, company: d.company, won_at: d.won_at, ...p });
  }
  return { user: besitzer && { id: besitzer.id, full_name: besitzer.full_name, ust: !!besitzer.provision_zzgl_ust && !besitzer.provision_ausland },
    monat, faellig_monat: round2(faelligMonat), ausstehend: round2(ausstehend), verdient: round2(verdient),
    bonus: await bonus(userId, monat, cfg), deals: liste };
}

// GET /api/provision/deal/:id – Provision eines Deals (Closer: nur eigene)
router.get('/deal/:id', auth, async (req, res) => {
  try {
    const [[deal]] = await db.query('SELECT id, lead_id, owner_id, status, paket, value, won_at FROM deals WHERE id=?', [parseInt(req.params.id)]);
    if (!deal) return res.status(404).json({ error: 'Deal nicht gefunden' });
    if (req.user.role !== 'admin' && deal.owner_id !== req.user.id) return res.status(403).json({ error: 'Kein Zugriff' });
    const cfg = await bedarf.regeln();
    res.json(await berechne(deal, cfg, await besitzerLaden(deal.owner_id)));
  } catch (e) { console.error('Provision Deal:', e); res.status(500).json({ error: 'Provision konnte nicht berechnet werden.' }); }
});

// GET /api/provision/mein?monat=YYYY-MM – eigene Provision und Bonus
router.get('/mein', auth, async (req, res) => {
  try { res.json(await uebersicht(req.user.id, monatParam(req.query.monat), await bedarf.regeln())); }
  catch (e) { console.error('Provision mein:', e); res.status(500).json({ error: 'Provision konnte nicht geladen werden.' }); }
});

// GET /api/provision/team?monat=YYYY-MM – alle Closer (Admin)
router.get('/team', auth, adminOnly, async (req, res) => {
  try {
    const monat = monatParam(req.query.monat);
    const cfg = await bedarf.regeln();
    const [closer] = await db.query("SELECT id FROM users WHERE role='closer' AND is_active=1 ORDER BY full_name");
    const team = [];
    for (const c of closer) {
      const u = await uebersicht(c.id, monat, cfg);
      team.push({ ...u.user, faellig_monat: u.faellig_monat, ausstehend: u.ausstehend, verdient: u.verdient,
        bonus: { anzahl: u.bonus.anzahl, summe: u.bonus.summe, fehlen: u.bonus.fehlen, naechste: u.bonus.naechste, erster: u.bonus.erster, wartet: u.bonus.wartet.length },
        deals: u.deals.map(d => ({ id: d.id, title: d.title, company: d.company, auszahlung: d.auszahlung, text: d.text, geschaetzt: d.geschaetzt,
          teile: d.teile.filter(t => t.faellig_am && t.faellig_am.slice(0, 7) === monat) })) });
    }
    res.json({ monat, team, abrechnung: !!crm });
  } catch (e) { console.error('Provision Team:', e); res.status(500).json({ error: 'Provision konnte nicht geladen werden.' }); }
});

// Alles, was an Closer auszuzahlen ist: fällige Provision (Kunde hat bezahlt + 14 Tage)
// und der Bonus des Vormonats – jeweils ohne die schon als ausgezahlt markierten
async function faelligeAuszahlungen() {
  const cfg = await bedarf.regeln();
  const [closer] = await db.query("SELECT id, full_name FROM users WHERE role='closer' AND is_active=1");
  const raus = [];
  const heute = new Date().toISOString().slice(0, 10);
  for (const c of closer) {
    const besitzer = await besitzerLaden(c.id);
    const [deals] = await db.query(`SELECT d.id, d.title, d.lead_id, d.owner_id, d.status, d.paket, d.value, d.won_at, l.company
      FROM deals d LEFT JOIN leads l ON l.id=d.lead_id WHERE d.owner_id=? AND d.status='won'`, [c.id]);
    for (const d of deals) {
      const p = await berechne(d, cfg, besitzer);
      if (p.keine) continue;
      p.teile.filter(t => t.status === 'faellig' && t.schluessel).forEach(t => raus.push({ art: 'provision', user_id: c.id, closer: c.full_name,
        deal_id: d.id, kunde: d.company || d.title, teil: t.art === 'anzahlung' ? 'Anzahlung' : t.art === 'rate' ? `Rate ${t.nr} von ${t.von}` : 'Zahlung',
        betrag: t.auszahlung, datum: t.faellig_am, schluessel: t.schluessel }));
    }
    // Bonus des Vormonats (fällig ab dem 1. des Folgemonats)
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    const vormonat = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const b = await bonus(c.id, vormonat, cfg);
    const key = `bonus:${c.id}:${vormonat}`;
    if (b.summe > 0) {
      const [[schon]] = await db.query('SELECT id FROM provision_auszahlungen WHERE schluessel=?', [key]).catch(() => [[null]]);
      if (!schon) raus.push({ art: 'bonus', user_id: c.id, closer: c.full_name, kunde: `${b.anzahl} bezahlte Abschlüsse`, teil: `Bonus ${vormonat.slice(5)}/${vormonat.slice(0, 4)}`,
        betrag: b.summe * (besitzer && besitzer.provision_zzgl_ust && !besitzer.provision_ausland ? 1 + Number(cfg.provision.ust) / 100 : 1), datum: heute.slice(0, 8) + '01', schluessel: key });
    }
  }
  return raus.sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
}

// POST /api/provision/auszahlung { schluessel, user_id, betrag, art } – als ausgezahlt markieren (Admin)
router.post('/auszahlung', auth, adminOnly, async (req, res) => {
  const key = String(req.body.schluessel || '');
  if (!/^(prov:[0-9a-f]{6,40}|bonus:\d+:\d{4}-\d{2})$/.test(key)) return res.status(400).json({ error: 'Unbekannte Auszahlung' });
  try {
    await db.query('INSERT IGNORE INTO provision_auszahlungen (schluessel, user_id, art, betrag, erstellt_von) VALUES (?,?,?,?,?)',
      [key, parseInt(req.body.user_id) || 0, key.startsWith('bonus') ? 'bonus' : 'provision', round2(req.body.betrag), req.user.id]);
    res.json({ ok: true });
  } catch (e) { console.error('Auszahlung:', e); res.status(500).json({ error: 'Konnte nicht gespeichert werden.' }); }
});
router.delete('/auszahlung/:schluessel', auth, adminOnly, async (req, res) => {
  try { await db.query('DELETE FROM provision_auszahlungen WHERE schluessel=?', [String(req.params.schluessel)]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Konnte nicht gelöscht werden.' }); }
});

router.faelligeAuszahlungen = faelligeAuszahlungen;
router.berechne = berechne;
router.bonus = bonus;
module.exports = router;
