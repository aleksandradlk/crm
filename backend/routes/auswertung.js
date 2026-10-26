// ── Vertriebs-Auswertung für den Admin (Tracking) ──────────────────────────
// Angebotsreife Bedarfsanalysen je Closer, Zeit „Angebot anfordern → gesendet“,
// Abschlussquote nach Paket und Herkunft, Gründe für „Verloren“/„passt nicht“
// und Closer ohne Aktivität seit 14 Tagen. ?tage=30|90|365|0 (0 = alles).
const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const R = require('../public_html/shared/bedarf-regeln');

const INAKTIV_TAGE = 14;

// Letzte echte Arbeit je Closer (Anruf, Notiz, Aktion – Login zählt nicht)
async function inaktiv() {
  const [rows] = await db.query(
    `SELECT u.id, u.full_name, u.created_at,
            GREATEST(COALESCE((SELECT MAX(started_at) FROM call_logs WHERE user_id=u.id), '1970-01-01'),
                     COALESCE((SELECT MAX(created_at) FROM comments WHERE user_id=u.id), '1970-01-01'),
                     COALESCE((SELECT MAX(created_at) FROM activity_log WHERE user_id=u.id AND action NOT IN ('login','logout')), '1970-01-01')) AS zuletzt,
            (SELECT MAX(last_active) FROM sessions WHERE user_id=u.id) AS eingeloggt
     FROM users u WHERE u.role='closer' AND u.is_active=1`);
  const grenze = Date.now() - INAKTIV_TAGE * 864e5;
  return rows.map(r => {
    const t = new Date(r.zuletzt).getTime();
    const nie = t < 86400000;
    return { id: r.id, full_name: r.full_name, zuletzt: nie ? null : r.zuletzt, eingeloggt: r.eingeloggt,
      tage: nie ? null : Math.floor((Date.now() - t) / 864e5), seit_anlage: Math.floor((Date.now() - new Date(r.created_at)) / 864e5) };
  }).filter(r => (r.zuletzt ? new Date(r.zuletzt).getTime() < grenze : r.seit_anlage >= INAKTIV_TAGE))
    .sort((a, b) => (b.tage ?? 9999) - (a.tage ?? 9999));
}

// Grund „Zu groß: Text“ → „Zu groß“ (alte Freitext-Gründe landen unter „Sonstiges (alt)“)
const grundKopf = g => {
  const k = String(g || '').split(':')[0].trim();
  return R.GRUENDE.find(x => x.toLowerCase() === k.toLowerCase()) || (k ? 'Sonstiges (alt)' : 'ohne Grund');
};

router.get('/', auth, adminOnly, async (req, res) => {
  const tage = [30, 90, 365, 0].includes(parseInt(req.query.tage)) ? parseInt(req.query.tage) : 90;
  const seit = (spalte) => tage ? `${spalte} >= NOW() - INTERVAL ${tage} DAY` : '1=1';
  try {
    // 1) Bedarfsanalysen je Closer (Lead-Zuständiger)
    const [bedarf] = await db.query(
      `SELECT u.id, u.full_name, COUNT(b.id) AS analysen, SUM(b.angebotsreif) AS reif, SUM(b.angefordert_am IS NOT NULL) AS angefordert,
              ROUND(AVG(b.fragen_ok), 1) AS fragen_schnitt
       FROM users u
       LEFT JOIN leads l ON l.assigned_to = u.id
       LEFT JOIN bedarfsanalysen b ON b.lead_id = l.id AND ${seit('b.updated_at')}
       WHERE u.role='closer' AND u.is_active=1
       GROUP BY u.id, u.full_name ORDER BY u.full_name`);

    // 2) Zeit „Angebot anfordern → Angebot gesendet“
    const [[zeit]] = await db.query(
      `SELECT COUNT(*) AS n, ROUND(AVG(TIMESTAMPDIFF(MINUTE, angefordert_at, angebot_gesendet_at)) / 60, 1) AS std_schnitt,
              ROUND(MAX(TIMESTAMPDIFF(MINUTE, angefordert_at, angebot_gesendet_at)) / 60, 1) AS std_max,
              SUM(TIMESTAMPDIFF(HOUR, angefordert_at, angebot_gesendet_at) <= 24) AS in_24h
       FROM deals WHERE angefordert_at IS NOT NULL AND angebot_gesendet_at IS NOT NULL AND ${seit('angebot_gesendet_at')}`);
    const [[wartend]] = await db.query(
      `SELECT COUNT(*) AS n, ROUND(MAX(TIMESTAMPDIFF(MINUTE, d.angefordert_at, NOW())) / 60, 1) AS std_max
       FROM deals d JOIN deal_stages s ON s.id=d.stage_id
       WHERE d.status='open' AND d.angefordert_at IS NOT NULL AND d.angebot_gesendet_at IS NULL AND s.name REGEXP 'anforder|anfrage'`);

    // 3) Abschlussquote nach Paket und nach Herkunft (entschiedene Deals im Zeitraum)
    const quote = async feld => {
      const [rows] = await db.query(
        `SELECT ${feld} AS gruppe, SUM(status='won') AS gewonnen, SUM(status='lost') AS verloren, SUM(status='open') AS offen,
                SUM(CASE WHEN status='won' THEN value ELSE 0 END) AS umsatz
         FROM deals WHERE (status='open' OR ${seit('COALESCE(won_at, lost_at)')})
         GROUP BY gruppe ORDER BY gewonnen DESC, gruppe`);
      return rows.map(r => {
        const entschieden = Number(r.gewonnen) + Number(r.verloren);
        return { gruppe: r.gruppe, gewonnen: Number(r.gewonnen), verloren: Number(r.verloren), offen: Number(r.offen),
          umsatz: Number(r.umsatz) || 0, quote: entschieden ? Math.round(Number(r.gewonnen) / entschieden * 100) : null };
      });
    };
    const cfg = R.cfgMit({});
    const nachPaket = (await quote("COALESCE(paket, 'ohne')")).map(r => ({ ...r, label: cfg.pakete[r.gruppe]?.name || 'ohne Paket' }));
    const nachHerkunft = (await quote("COALESCE(herkunft, 'crm')")).map(r => ({ ...r, label: r.gruppe === 'uebergabe_warm' ? 'Warme Übergabe' : 'CRM-Lead' }));

    // 4) Gründe für „Verloren“ (Deals) und „passt nicht“ (Leads)
    const [verloren] = await db.query(`SELECT lost_reason FROM deals WHERE status='lost' AND ${seit('lost_at')}`);
    const [passtNicht] = await db.query(`SELECT status_grund FROM leads WHERE status='passt_nicht' AND ${seit('updated_at')}`);
    const zaehle = (liste, feld) => {
      const m = {};
      liste.forEach(r => { const k = grundKopf(r[feld]); m[k] = (m[k] || 0) + 1; });
      return Object.entries(m).map(([grund, n]) => ({ grund, n })).sort((a, b) => b.n - a.n);
    };

    res.json({
      tage,
      bedarf: bedarf.map(b => ({ ...b, analysen: Number(b.analysen), reif: Number(b.reif || 0), angefordert: Number(b.angefordert || 0),
        anteil: Number(b.analysen) ? Math.round(Number(b.reif || 0) / Number(b.analysen) * 100) : null })),
      zeit: { ...zeit, n: Number(zeit.n), in_24h: Number(zeit.in_24h || 0), wartend: Number(wartend.n), wartend_std_max: wartend.std_max },
      nach_paket: nachPaket, nach_herkunft: nachHerkunft,
      gruende: { verloren: zaehle(verloren, 'lost_reason'), passt_nicht: zaehle(passtNicht, 'status_grund') },
      inaktiv: await inaktiv(), inaktiv_tage: INAKTIV_TAGE,
    });
  } catch (e) { console.error('Auswertung:', e); res.status(500).json({ error: 'Auswertung konnte nicht geladen werden.' }); }
});

// Nur der Hinweis fürs Dashboard
router.get('/inaktiv', auth, adminOnly, async (req, res) => {
  try { res.json({ tage: INAKTIV_TAGE, closer: await inaktiv() }); }
  catch (e) { res.json({ tage: INAKTIV_TAGE, closer: [] }); }
});

module.exports = router;
