const router  = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { auth } = require('../middleware/auth');
const { log } = require('../helpers/logger');

const FIELD_LABELS = {
  company:   'Unternehmensname',
  ceo:       'Geschäftsführer / Ansprechpartner',
  email:     'E-Mail-Adresse',
  phone:     'Telefonnummer',
  location:  'Standort / Adresse',
  linkedin:  'LinkedIn-URL',
  revenue:   'Jahresumsatz (nur falls öffentlich bekannt)',
  employees: 'Mitarbeiterzahl',
};
const DEFAULT_FIELDS = ['company', 'ceo', 'email', 'phone', 'location'];
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
[{"company":"Name","ceo":null,"email":null,"phone":null,"location":"Stadt","website":null,"linkedin_url":null,"industry":"Branche","employees":null,"revenue":null,"source":"web","confidence":70,"notes":null}]`;
}

// POST /api/generate — KI-Lead-Generierung mit Live-Web-Suche (Admin oder can_generate_leads)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'admin' && !req.user.can_generate_leads)
    return res.status(403).json({ error: 'Keine Berechtigung für Lead-Generierung' });

  const { query, location, size, max_leads, fields, extra } = req.body;
  if (!query) return res.status(400).json({ error: 'Suchbegriff fehlt' });

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Claude API Key nicht konfiguriert (.env)' });

  const maxL = Math.min(parseInt(max_leads) || 10, 100);
  // Suchen sind mit $10 / 1000 Anfragen abgerechnet — an die gewünschte Lead-Zahl gekoppelt,
  // aber gedeckelt, damit ein einzelner Generieren-Klick nie außer Kontrolle gerät.
  const maxSearches = Math.min(Math.max(maxL, 3), 20);

  const client = new Anthropic({ apiKey });
  const tools  = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }];

  try {
    let messages = [{ role: 'user', content: buildUserPrompt({ query, location, size, maxL, extra, fields }) }];
    let response  = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Der serverseitige Such-Loop pausiert nach 10 internen Iterationen (pause_turn) —
    // bei vielen angeforderten Leads ggf. mehrfach fortsetzen.
    let continuations = 0;
    while (response.stop_reason === 'pause_turn' && continuations < 3) {
      messages = [...messages, { role: 'assistant', content: response.content }];
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
      continuations++;
    }

    const searchesUsed = response.usage?.server_tool_use?.web_search_requests || 0;
    const realData = searchesUsed > 0;

    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Kein JSON-Array in Antwort');

    let leads = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(leads)) throw new Error('Ungültiges Format');

    leads = leads
      .map(l => ({
        company:      l.company || null,
        ceo:          l.ceo || null,
        email:        l.email || null,
        phone:        l.phone || null,
        location:     l.location || null,
        website:      l.website || null,
        linkedin_url: l.linkedin_url || null,
        industry:     l.industry || null,
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

    await log(req.user.id, 'leads_generate', 'system', null,
      { query, location, count: leads.length, dropped_low_confidence: droppedLowConfidence,
        real_data: realData, web_searches: searchesUsed }, req.ip);

    res.json({ ok: true, leads, real_data: realData, dropped_low_confidence: droppedLowConfidence });
  } catch (err) {
    console.error('Generate error:', err);
    const status = err instanceof Anthropic.APIError ? (err.status || 500) : 500;
    const message = err instanceof Anthropic.APIError ? err.message : 'Ein Fehler ist aufgetreten.';
    res.status(status).json({ error: message });
  }
});

module.exports = router;
