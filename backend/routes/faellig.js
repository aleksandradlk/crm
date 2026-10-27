// ── Was ist fällig? (Admin) ─────────────────────────────────────────────────
// Eine Liste für „Heute“ und die tägliche Erinnerungsmail: Angebote schreiben,
// Rechnungen fertig machen und senden, überfällige Zahlungen, ablaufende Angebote,
// Betreuung startet bald (Kunde erinnern), Provision und Bonus auszahlen.
// Nichts wird automatisch verschickt – die Liste erinnert nur.
const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const bedarf = require('./bedarf');
const provision = require('./provision');

let crm = null;
router.verbinde = c => { crm = c; };

const eur = n => Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 }) + ' €';
const datum = iso => iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';

async function sammeln() {
  const heute = new Date().toISOString().slice(0, 10);
  const punkte = [];
  // 1) Angebote, die Closer angefordert haben
  const cfg = await bedarf.regeln();
  const [anfragen] = await db.query(
    `SELECT d.id, d.lead_id, d.angefordert_at, l.company, u.full_name AS owner_name,
            TIMESTAMPDIFF(HOUR, d.angefordert_at, NOW()) AS std
     FROM deals d JOIN deal_stages s ON s.id=d.stage_id LEFT JOIN leads l ON l.id=d.lead_id LEFT JOIN users u ON u.id=d.owner_id
     WHERE d.status='open' AND s.name REGEXP 'anforder|anfrage' ORDER BY d.angefordert_at`).catch(() => [[]]);
  anfragen.forEach(a => punkte.push({ gruppe: 'angebot', titel: `Angebot schreiben: ${a.company || '–'}`,
    text: `angefordert von ${a.owner_name || '–'}${a.std != null ? `, wartet seit ${a.std >= 24 ? Math.floor(a.std / 24) + ' Tag(en)' : a.std + ' Std.'}` : ''}`,
    datum: a.angefordert_at ? new Date(a.angefordert_at).toISOString().slice(0, 10) : heute,
    dringend: a.std != null && a.std >= (cfg.anfrage_warte_std || 24), aktion: { typ: 'anfrage', lead_id: a.lead_id, deal_id: a.id } }));
  // 2) Abrechnung
  const f = crm && typeof crm.faellig === 'function' ? (() => { try { return crm.faellig(); } catch (e) { console.error('Fällig (Abrechnung):', e.message); return null; } })() : null;
  if (f) {
    f.entwuerfe.forEach(r => punkte.push({ gruppe: 'rechnung', titel: `${r.art} fertig machen und senden: ${r.kunde}`,
      text: `${r.titel ? r.titel + ' · ' : ''}${eur(r.brutto)}, ${r.datum <= heute ? 'fällig seit' : 'fällig am'} ${datum(r.datum)}`, datum: r.datum,
      dringend: r.datum <= heute, aktion: { typ: 'abrechnung', bereich: 'rechnungen' } }));
    f.unversendet.forEach(r => punkte.push({ gruppe: 'rechnung', titel: `Rechnung ${r.nummer} noch nicht verschickt: ${r.kunde}`,
      text: `${eur(r.brutto)}, erstellt am ${datum(r.datum)}`, datum: r.datum, dringend: true, aktion: { typ: 'abrechnung', bereich: 'rechnungen' } }));
    f.ueberfaellig.forEach(r => punkte.push({ gruppe: 'zahlung', titel: `Zahlung fehlt: ${r.nummer} · ${r.kunde}`,
      text: `${eur(r.brutto)}, fällig seit ${datum(r.datum)}${r.naechste ? ` – nächster Schritt: ${r.naechste}` : ''}`, datum: r.datum, dringend: true,
      aktion: { typ: 'abrechnung', bereich: 'rechnungen' } }));
    f.angebote.forEach(a => punkte.push({ gruppe: 'angebot', titel: `${a.abgelaufen ? 'Angebot abgelaufen' : 'Angebot läuft ab'}: ${a.nummer} · ${a.kunde}`,
      text: `${a.betreff ? a.betreff + ' · ' : ''}gültig bis ${datum(a.datum)} – nachfassen oder verlängern`, datum: a.datum, dringend: a.abgelaufen,
      aktion: { typ: 'abrechnung', bereich: 'angebote' } }));
    f.abos.forEach(x => punkte.push({ gruppe: 'betreuung', titel: `Betreuung wird abgerechnet: ${x.kunde}`,
      text: `erste Monatsrechnung am ${datum(x.datum)} über ${eur(x.monatlich)} – vorher prüfen, ob alles läuft (bei Quick-Win: Kunde kurz erinnern)`, datum: x.datum,
      dringend: false, aktion: { typ: 'abrechnung', bereich: 'abos' } }));
  }
  // 3) Provision und Bonus auszahlen
  const raus = await provision.faelligeAuszahlungen().catch(e => { console.error('Fällig (Provision):', e.message); return []; });
  raus.forEach(p => punkte.push({ gruppe: 'provision', titel: `${p.art === 'bonus' ? 'Bonus' : 'Provision'} auszahlen: ${p.closer} ${eur(p.betrag)}`,
    text: `${p.kunde} · ${p.teil}${p.art === 'provision' ? `, fällig seit ${datum(p.datum)}` : ''}`, datum: p.datum, dringend: true,
    aktion: { typ: 'auszahlung', schluessel: p.schluessel, user_id: p.user_id, betrag: p.betrag } }));
  punkte.sort((a, b) => (b.dringend - a.dringend) || String(a.datum).localeCompare(String(b.datum)));
  return { punkte, anzahl: punkte.length, dringend: punkte.filter(p => p.dringend).length, abrechnung: !!crm };
}

router.get('/', auth, adminOnly, async (req, res) => {
  try { res.json(await sammeln()); }
  catch (e) { console.error('Fällig:', e); res.status(500).json({ error: 'Liste konnte nicht geladen werden.' }); }
});

// Tägliche Erinnerungsmail an die Admin-Adresse aus den Vertriebsregeln (nur wenn etwas ansteht)
const GRUPPEN = { angebot: 'Angebote', rechnung: 'Rechnungen', zahlung: 'Zahlungen', betreuung: 'Betreuung', provision: 'Provision & Bonus' };
async function morgenMail() {
  const cfg = await bedarf.regeln();
  if (cfg.faellig_mail === false || !cfg.admin_mail) return null;
  const heute = new Date().toISOString().slice(0, 10);
  const [[schon]] = await db.query("SELECT value FROM app_settings WHERE key_name='faellig_mail_am'").catch(() => [[null]]);
  if (schon && schon.value === heute) return null;
  const { punkte } = await sammeln();
  await db.query("INSERT INTO app_settings (key_name, value) VALUES ('faellig_mail_am', ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [heute]);
  if (!punkte.length) return 0;
  const { sendInfoMail } = require('../helpers/mailer');
  const zeilen = [`Heute stehen <b>${punkte.length}</b> Punkte an:`, ''];
  Object.entries(GRUPPEN).forEach(([g, name]) => {
    const liste = punkte.filter(p => p.gruppe === g);
    if (!liste.length) return;
    zeilen.push(`<b>${name}</b>`);
    liste.forEach(p => zeilen.push(`• ${p.dringend ? '<b>Dringend:</b> ' : ''}${p.titel} – ${p.text}`));
    zeilen.push('');
  });
  zeilen.push('Alles auch im CRM unter „Heute“. Nichts wird automatisch verschickt.');
  await sendInfoMail({ to: cfg.admin_mail, toName: 'Aleksandra', subject: `Heute fällig: ${punkte.length} ${punkte.length === 1 ? 'Punkt' : 'Punkte'}`, zeilen });
  return punkte.length;
}

router.sammeln = sammeln;
router.morgenMail = morgenMail;
module.exports = router;
