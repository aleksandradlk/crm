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
function planAusZahlung(art, prozent, raten) {
  if (art === 'anzahlung') { const p = Math.min(99, Math.max(1, Number(prozent) || 50)) / 100; return [{ anteil: p, art: 'anzahlung' }, { anteil: 1 - p, art: 'rest' }]; }
  if (art === 'raten' && raten.length > 1) { const s = raten.reduce((a, b) => a + b, 0) || 1; return raten.map((b, i) => ({ anteil: b / s, art: i ? 'rate' : 'anzahlung', nr: i + 1, von: raten.length })); }
  return [{ anteil: 1, art: 'einmal' }];
}
function planAusWunsch(zw) {
  if (zw === '5050') return planAusZahlung('anzahlung', 50, []);
  const m = /^raten(\d+)/.exec(zw || '');
  return m ? planAusZahlung('raten', 0, Array(Math.max(1, parseInt(m[1]))).fill(1)) : planAusZahlung('einmal');
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

  let basisPreis, rabatt, plan, quelle, angebot = null;
  let analyse = null;
  const ladeAnalyse = async () => analyse || (analyse = (await bedarf.analyseLaden(deal.lead_id).catch(() => null))?.data || {});
  const daten = provisionsDaten(deal.id);
  if (daten) {
    quelle = 'angebot';
    angebot = { nummer: daten.angebot.nummer, status: daten.angebot.status };
    basisPreis = daten.angebot.einmaligNetto;
    rabatt = daten.angebot.rabatt;
    if (daten.rechnungen.length) {
      const summe = daten.rechnungen.reduce((s, r) => s + r.netto, 0) || 1;
      plan = daten.rechnungen.map((r, i) => ({
        anteil: r.netto / summe, art: r.anzahlung || (i === 0 && r.ratenGesamt > 1) ? 'anzahlung' : r.ratenGesamt > 1 ? 'rate' : 'einmal',
        nr: r.rate, von: r.ratenGesamt, rechnung: r.nummer, bezahlt_am: r.status === 'bezahlt' ? r.bezahltAm : null,
        zahlungsstatus: r.status, kunde_faellig: r.faelligAm }));
    } else plan = planAusZahlung(daten.angebot.zahlung.art, daten.angebot.zahlung.anzahlungProzent, daten.angebot.zahlung.raten);
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
    if (qw) upgrade = { abzug: Number(cfg.pakete.quickwin?.einrichtung) || 0, quickwin_deal: qw.id };
  }
  const basis = round2(Math.max(0, basisPreis - (upgrade ? upgrade.abzug : 0)));
  const satz = rabatt ? Number(P.satz_rabatt) : Number(P.satz);
  const netto = round2(basis * satz / 100);
  const mitUst = !!(besitzer && besitzer.provision_zzgl_ust && !besitzer.provision_ausland);
  const ustSatz = mitUst ? Number(P.ust) : 0;
  const auszahlung = round2(netto * (1 + ustSatz / 100));

  // Auf die Zahlungen verteilen, Rundungsrest auf die letzte
  let verteilt = 0;
  const heute = new Date().toISOString().slice(0, 10);
  const teile = plan.map((t, i) => {
    const n = i === plan.length - 1 ? round2(netto - verteilt) : round2(netto * t.anteil);
    verteilt = round2(verteilt + n);
    const faellig = t.bezahlt_am ? plusTage(t.bezahlt_am, Number(P.faellig_tage) || 0) : null;
    const status = t.bezahlt_am ? (faellig <= heute ? 'faellig' : 'bezahlt') : t.rechnung !== undefined ? 'offen' : 'geplant';
    return { art: t.art, nr: t.nr || i + 1, von: t.von || plan.length, rechnung: t.rechnung || null, netto: n,
      auszahlung: round2(n * (1 + ustSatz / 100)), kunde_bezahlt_am: t.bezahlt_am || null, rechnung_status: t.zahlungsstatus || null, faellig_am: faellig, status };
  });

  return {
    quelle, geschaetzt: quelle !== 'angebot', angebot, paket, upgrade,
    basis_preis: round2(basisPreis), basis, rabatt, satz, netto,
    ust: { aktiv: mitUst, satz: ustSatz, ausland: !!(besitzer && besitzer.provision_ausland), betrag: round2(auszahlung - netto) },
    auszahlung, teile, text: planText(teile),
    erste_zahlung_da: teile.some(t => t.kunde_bezahlt_am),
  };
}

async function besitzerLaden(id) {
  const [[u]] = await db.query('SELECT id, full_name, role, provision_zzgl_ust, provision_ausland FROM users WHERE id=?', [id]);
  return u || null;
}

// Bonus-Zähler eines Closers für einen Monat (Monat der Unterschrift = Gewonnen-Datum)
async function bonus(userId, monat, cfg) {
  const P = cfg.provision;
  const [deals] = await db.query(
    `SELECT d.id, d.title, d.lead_id, d.paket, d.won_at, l.company FROM deals d LEFT JOIN leads l ON l.id=d.lead_id
     WHERE d.owner_id=? AND d.status='won' AND DATE_FORMAT(d.won_at, '%Y-%m')=? ORDER BY d.won_at`, [userId, monat]);
  const zaehlt = [], wartet = [];
  for (const d of deals) {
    let paket = d.paket;
    if (!paket) paket = (await bedarf.analyseLaden(d.lead_id).catch(() => null))?.data?.paket_empfohlen || null;
    if (!P.bonus_pakete.includes(paket)) continue;
    const daten = provisionsDaten(d.id);
    const bezahlt = !!daten && daten.rechnungen.some(r => r.status === 'bezahlt');
    (bezahlt ? zaehlt : wartet).push({ id: d.id, title: d.title, company: d.company, paket, paket_name: cfg.pakete[paket]?.name || paket });
  }
  const stufen = [...P.bonus].map(s => ({ ab: Number(s.ab), betrag: Number(s.betrag) })).filter(s => s.ab > 0).sort((a, b) => a.ab - b.ab);
  const n = zaehlt.length;
  const erreicht = stufen.filter(s => n >= s.ab);
  const naechste = stufen.find(s => n < s.ab) || null;
  return { monat, anzahl: n, summe: erreicht.reduce((s, x) => s + x.betrag, 0), stufen, naechste,
    fehlen: naechste ? naechste.ab - n : 0, zaehlt, wartet };
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
        bonus: { anzahl: u.bonus.anzahl, summe: u.bonus.summe, fehlen: u.bonus.fehlen, naechste: u.bonus.naechste, wartet: u.bonus.wartet.length },
        deals: u.deals.map(d => ({ id: d.id, title: d.title, company: d.company, auszahlung: d.auszahlung, text: d.text, geschaetzt: d.geschaetzt,
          teile: d.teile.filter(t => t.faellig_am && t.faellig_am.slice(0, 7) === monat) })) });
    }
    res.json({ monat, team, abrechnung: !!crm });
  } catch (e) { console.error('Provision Team:', e); res.status(500).json({ error: 'Provision konnte nicht geladen werden.' }); }
});

router.berechne = berechne;
router.bonus = bonus;
module.exports = router;
