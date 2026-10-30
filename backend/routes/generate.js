const router  = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const db = require('../db');
const { findDuplicates } = require('../helpers/dedupe');
const { imGebiet } = require('../helpers/regionen');

// Vorgaben für Closer (Admin stellt sie unter „Leads generieren“ ein, app_settings.finder_vorgaben):
// erlaubte Branchen und feste Größe. Der Admin selbst sucht frei.
const GROESSEN = { small: 'klein (bis 49 Mitarbeiter, auch inhabergeführte Kleinbetriebe)', medium: 'Mittelstand (50–250 Mitarbeiter)' };
const VORGABEN_STANDARD = { branchen: ['Autohäuser', 'Maler', 'Autoaufbereiter', 'Badsanierer', 'Handwerksbetriebe'], groesse: 'small' };
async function vorgaben() {
  const [[r]] = await db.query("SELECT value FROM app_settings WHERE key_name='finder_vorgaben'").catch(() => [[null]]);
  let v = {};
  try { v = r ? JSON.parse(r.value) : {}; } catch (_) {}
  return {
    branchen: Array.isArray(v.branchen) ? v.branchen : VORGABEN_STANDARD.branchen,
    groesse: v.groesse !== undefined ? v.groesse : VORGABEN_STANDARD.groesse,
  };
}

const FIELD_LABELS = {
  company:   'Unternehmensname',
  ceo:       'Geschäftsführer / Ansprechpartner',
  email:     'E-Mail-Adresse',
  phone:     'Telefonnummer',
  location:  'Standort / Adresse (Straße, PLZ, Ort)',
  instagram: 'Instagram-Profil',
  linkedin:  'LinkedIn-URL',
  revenue:   'Jahresumsatz (nur falls öffentlich bekannt)',
  employees: 'Mitarbeiterzahl',
};
const DEFAULT_FIELDS = ['company', 'ceo', 'email', 'phone', 'location', 'instagram'];
// Gründlicher statt breiter: höchstens so viele Leads pro Klick, je Lead zwei Websuchen
const MAX_LEADS = 20;
// Alles unter dieser Schwelle wird serverseitig verworfen, unabhängig davon, was das
// Modell selbst als confidence angibt — die Selbsteinschätzung allein ist kein verlässlicher Filter.
const MIN_CONFIDENCE = 80;

const SYSTEM_PROMPT = `Du bist ein professionelles Business-Intelligence-System für Lead-Recherche.
Dir steht ein Web-Search-Tool zur Verfügung — nutze es aktiv, um JEDES Unternehmen zu
verifizieren, bevor du es in die Ergebnisliste aufnimmst.

ABSOLUT VERBOTEN:
- Daten erfinden oder halluzinieren
- Ein Unternehmen aufnehmen, das du nicht per Suche verifizieren konntest
- Generische Dummy-E-Mails oder fiktive Telefonnummern
- Einen Firmennamen aus Kategorie + Straße konstruieren (z.B. "Malerbetrieb Musterstraße"),
  wenn du keinen echten, per Suche bestätigten Firmennamen gefunden hast

REGELN:
- Suche für jedes Kandidaten-Unternehmen mindestens einmal, um Existenz und Kontaktdaten
  zu bestätigen (z.B. über Impressum, Firmenwebsite, Google-Maps-Eintrag, Branchenverzeichnis)
- E-Mail/Telefon NUR übernehmen, wenn sie in den Suchergebnissen belegt sind
- Fehlende Werte als null
- confidence: 85-100 = Firmenname UND mindestens ein Kontaktdatum direkt in Suchergebnissen
  bestätigt, 65-84 = Firma bestätigt, aber Details aus Kontext erschlossen, 40-64 = unsicher
- Nur Ergebnisse mit confidence ≥ ${MIN_CONFIDENCE} werden überhaupt gespeichert — alles
  darunter lässt du direkt weg, anstatt es unsicher ins Ergebnis zu schreiben
- Nur Betriebe mit belegter Telefonnummer aufnehmen (Leads ohne Telefon werden verworfen)
- Nur Betriebe im angegebenen Standort bzw. dessen Umland; "plz" und "ort" immer angeben
- Instagram-Profil (instagram.com/…) mit angeben, wenn es auf der Webseite oder in der Suche belegt ist
- Lieber 3 verifizierte Leads als 10 ungeprüfte
- Antworte am Ende NUR mit einem validen JSON-Array, keine Erklärungen danach`;

function buildUserPrompt({ query, location, size, maxL, extra, fields }) {
  const wanted = (Array.isArray(fields) && fields.length ? fields : DEFAULT_FIELDS)
    .map(f => FIELD_LABELS[f] || f).join(', ');

  return `Recherchiere per Web-Suche bis zu ${maxL} ECHTE, existierende Unternehmen und verifiziere jedes davon:

Suchbegriff: "${query}"
${location ? `Standort: "${location}"` : ''}
${size ? `Unternehmensgröße: ${size}` : ''}
${extra ? `Zusätzliche Kriterien: ${extra}` : ''}

Gewünschte Felder (so vollständig wie recherchierbar): ${wanted}

Antworte NUR mit diesem JSON-Array:
[{"company":"Name","ceo":null,"email":null,"phone":"+49 …","strasse":null,"plz":"12345","ort":"Stadt","website":null,"instagram":null,"linkedin_url":null,"employees":null,"revenue":null,"source":"web","confidence":70,"notes":null}]`;
}

// GET /api/generate/vorgaben — Vorgaben für Closer (alle mit Zugriff auf die Suche)
router.get('/vorgaben', auth, async (req, res) => {
  res.json({ ...(await vorgaben()), groessen: GROESSEN });
});
// PUT /api/generate/vorgaben — Admin legt Branchen und Größe für Closer fest
router.put('/vorgaben', auth, adminOnly, async (req, res) => {
  const branchen = [...new Set((Array.isArray(req.body.branchen) ? req.body.branchen : String(req.body.branchen || '').split(','))
    .map(b => String(b).trim().slice(0, 60)).filter(Boolean))].slice(0, 30);
  const groesse = req.body.groesse in GROESSEN ? req.body.groesse : '';
  await db.query("INSERT INTO app_settings (key_name, value) VALUES ('finder_vorgaben', ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    [JSON.stringify({ branchen, groesse })]);
  await log(req.user.id, 'finder_vorgaben', 'system', null, { branchen, groesse }, req.ip);
  res.json({ ok: true, branchen, groesse });
});

// POST /api/generate — KI-Lead-Generierung mit Live-Web-Suche (Admin oder can_generate_leads)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'admin' && !req.user.can_generate_leads)
    return res.status(403).json({ error: 'Keine Berechtigung für Lead-Generierung' });

  const { location, max_leads, fields, extra } = req.body;
  let query = String(req.body.query || '').trim();
  let size = req.body.size;
  if (!query) return res.status(400).json({ error: 'Suchbegriff fehlt' });
  // Closer: nur freigegebene Branchen, Größe wie vom Admin festgelegt
  if (req.user.role !== 'admin') {
    const v = await vorgaben();
    if (v.branchen.length) {
      const treffer = v.branchen.find(b => b.toLowerCase() === query.toLowerCase());
      if (!treffer) return res.status(400).json({ error: `Bitte eine dieser Branchen wählen: ${v.branchen.join(', ')}` });
      query = treffer;
    }
    size = GROESSEN[v.groesse] || '';
  } else if (GROESSEN[size]) size = GROESSEN[size];

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Claude API Key nicht konfiguriert (.env)' });

  const maxL = Math.min(parseInt(max_leads) || 10, MAX_LEADS);
  // Suchen sind mit $10 / 1000 Anfragen abgerechnet — je Lead zwei (Existenz + Kontaktdaten),
  // gedeckelt bei 40, damit ein einzelner Klick höchstens ca. 40 Cent Suchkosten hat.
  const maxSearches = Math.min(Math.max(maxL * 2, 5), 40);

  // Je Lead ca. 250 Token JSON – bei festen 4000 Token brach die Liste ab 15–20 Leads ab
  const maxTokens = Math.min(16000, 2000 + maxL * 300);
  const client = new Anthropic({ apiKey });
  const tools  = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }];

  try {
    let messages = [{ role: 'user', content: buildUserPrompt({ query, location, size, maxL, extra, fields }) }];
    let response  = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Der serverseitige Such-Loop pausiert nach 10 internen Iterationen (pause_turn) —
    // bei vielen angeforderten Leads ggf. mehrfach fortsetzen.
    let continuations = 0;
    // Websuchen über alle Durchläufe zählen (vorher nur der letzte → „Live-Daten“ war manchmal falsch)
    let searchesUsed = response.usage?.server_tool_use?.web_search_requests || 0;
    while (response.stop_reason === 'pause_turn' && continuations < 3) {
      messages = [...messages, { role: 'assistant', content: response.content }];
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
      continuations++;
      searchesUsed += response.usage?.server_tool_use?.web_search_requests || 0;
    }
    const realData = searchesUsed > 0;

    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Kein JSON-Array in Antwort');

    let leads = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(leads)) throw new Error('Ungültiges Format');

    const t = v => (v == null ? '' : String(v).trim());
    const insta = v => { v = t(v); if (!v) return null; if (/instagram\.com/i.test(v)) return v.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 255); return v.startsWith('@') ? 'instagram.com/' + v.slice(1) : null; };
    leads = leads
      .map(l => ({
        company:      l.company || null,
        ceo:          l.ceo || null,
        email:        l.email || null,
        phone:        l.phone || null,
        plz:          (t(l.plz).match(/\d{5}/) || [null])[0],
        ort:          t(l.ort) || null,
        // Adresse wie überall im CRM: „Str. Nr, PLZ Ort“
        location:     [t(l.strasse), [t(l.plz), t(l.ort)].filter(Boolean).join(' ')].filter(Boolean).join(', ') || l.location || null,
        website:      l.website || null,
        instagram_url: insta(l.instagram || l.instagram_url),
        linkedin_url: l.linkedin_url || null,
        // Branche fest = gesuchte Branche (nicht die freie Formulierung der KI)
        industry:     query,
        employees:    l.employees != null ? String(l.employees) : null,
        revenue:      l.revenue || null,
        source:       l.source || 'web',
        confidence:   Math.min(100, Math.max(0, parseInt(l.confidence) || 50)),
        notes:        l.notes || null,
      }))
      .filter(l => l.company);

    const candidateCount = leads.length;
    leads = leads.filter(l => l.confidence >= MIN_CONFIDENCE);
    const droppedLowConfidence = candidateCount - leads.length;
    // Telefon ist Pflicht (Nala ruft an)
    const vorTelefon = leads.length;
    leads = leads.filter(l => String(l.phone || '').replace(/\D/g, '').length >= 6);
    const ohneTelefon = vorTelefon - leads.length;
    // Region: Treffer außerhalb des Suchgebiets fliegen raus, ohne PLZ/Ort werden sie markiert
    const vorRegion = leads.length;
    leads = leads.map(l => ({ ...l, region: imGebiet(l, location) })).filter(l => l.region !== 'nein');
    const ausserhalb = vorRegion - leads.length;
    // Schon im CRM? (gleiche Telefonnummer, E-Mail, Webseite oder gleicher Firmenname) → markieren
    for (const l of leads) {
      let d = (await findDuplicates(l, 0, 1).catch(() => []))[0];
      if (!d) {
        const [[g]] = await db.query(
          `SELECT l.id, l.company, u.full_name AS assigned_name FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
           WHERE l.archived_at IS NULL AND LOWER(TRIM(l.company)) = LOWER(?) LIMIT 1`, [String(l.company).trim()]).catch(() => [[null]]);
        d = g;
      }
      if (d) l.vorhanden = { id: d.id, company: d.company, betreut: d.assigned_name || null };
    }
    const statistik = {
      kandidaten: candidateCount, unsicher: droppedLowConfidence, ohne_telefon: ohneTelefon, ausserhalb,
      treffer: leads.length, schon_im_crm: leads.filter(l => l.vorhanden).length,
      region_ungeprueft: leads.filter(l => l.region === 'ungeprueft').length,
      mit_email: leads.filter(l => l.email).length, mit_webseite: leads.filter(l => l.website).length,
      mit_instagram: leads.filter(l => l.instagram_url).length, websuchen: searchesUsed,
    };

    await log(req.user.id, 'leads_generate', 'system', null,
      { query, location, count: leads.length, dropped_low_confidence: droppedLowConfidence,
        real_data: realData, web_searches: searchesUsed, statistik }, req.ip);

    res.json({ ok: true, leads, real_data: realData, dropped_low_confidence: droppedLowConfidence, statistik });
  } catch (err) {
    console.error('Generate error:', err);
    const status = err instanceof Anthropic.APIError ? (err.status || 500) : 500;
    const message = err instanceof Anthropic.APIError ? err.message : 'Ein Fehler ist aufgetreten.';
    res.status(status).json({ error: message });
  }
});

module.exports = router;
