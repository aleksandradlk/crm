// Verbindung zum Angebotstool (tool.novaflowservices.de).
// Das Tool liefert über /api/crm/* Kunden mit Angeboten, Rechnungen, Abos und
// den daraus berechneten Werten. Zugriff mit dem gemeinsamen Schlüssel
// ANGEBOT_TOOL_KEY (= CRM_API_KEY im Angebotstool).
// Ohne ANGEBOT_TOOL_URL/ANGEBOT_TOOL_KEY ist die Anbindung einfach aus.

const TIMEOUT_MS = 8000;
const CACHE_MS   = 60 * 1000;

const cfg = () => ({
  url: (process.env.ANGEBOT_TOOL_URL || '').replace(/\/$/, ''),
  key: process.env.ANGEBOT_TOOL_KEY || '',
});

function isConfigured() {
  const c = cfg();
  return !!(c.url && c.key);
}

async function request(method, path, body, timeoutMs = TIMEOUT_MS) {
  const c = cfg();
  if (!c.url || !c.key) throw new Error('Angebotstool ist nicht verbunden');
  const res = await fetch(c.url + path, {
    method,
    headers: { 'X-CRM-Key': c.key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Angebotstool antwortet mit HTTP ${res.status}`);
  }
  return data;
}

// Alle Kunden mit Werten – kurz zwischengespeichert, damit Listen schnell laden
let _kundenCache = { at: 0, kunden: null, pending: null };
async function alleKunden({ frisch = false } = {}) {
  if (!frisch && _kundenCache.kunden && Date.now() - _kundenCache.at < CACHE_MS) return _kundenCache.kunden;
  if (_kundenCache.pending) return _kundenCache.pending;
  _kundenCache.pending = request('GET', '/api/crm/kunden')
    .then(d => { _kundenCache = { at: Date.now(), kunden: d.kunden || [], pending: null }; return _kundenCache.kunden; })
    .catch(e => { _kundenCache.pending = null; throw e; });
  return _kundenCache.pending;
}
function cacheLeeren() { _kundenCache = { at: 0, kunden: null, pending: null }; }

// Kunde zu einem Lead (über Lead-ID, E-Mail oder Firmenname) inkl. Dokumente
async function kundeZuLead(lead, timeoutMs) {
  const q = new URLSearchParams();
  q.set('leadId', String(lead.id));
  if (lead.email)   q.set('email', lead.email);
  if (lead.company) q.set('firma', lead.company);
  return request('GET', `/api/crm/kunde?${q}`, null, timeoutMs);
}

// Lead im Angebotstool als Kunden anlegen bzw. vorhandenen Kunden verknüpfen
async function leadUebernehmen(lead) {
  const ort = String(lead.location || '').trim();
  const plzOrt = ort.match(/^(\d{5})\s+(.+)$/);
  const d = await request('POST', '/api/crm/kunden', {
    leadId: lead.id,
    firma: lead.company || lead.ceo || '',
    ansprechpartner: lead.ceo || '',
    email: lead.email || '',
    telefon: lead.phone || '',
    plz: plzOrt ? plzOrt[1] : '',
    ort: plzOrt ? plzOrt[2] : ort,
  });
  cacheLeeren();
  return d;
}

const normMail = s => String(s || '').trim().toLowerCase();

// Ordnet Kunden des Tools den Leads zu: feste Verknüpfung (Lead-ID) vor E-Mail.
// leads: [{ id, email }] → Map(leadId → werte + Kundennummer)
function werteJeLead(kunden, leads) {
  const result = new Map();
  const leadIds = new Set(leads.map(l => String(l.id)));
  const nachMail = new Map();
  leads.forEach(l => { const m = normMail(l.email); if (m && !nachMail.has(m)) nachMail.set(m, l.id); });
  const vergeben = new Set();
  // 1. Feste Verknüpfungen
  kunden.forEach(k => {
    if (k.crmLeadId && leadIds.has(String(k.crmLeadId))) {
      result.set(parseInt(k.crmLeadId), { kunde_nr: k.nummer, firma: k.firma, ...k.werte });
      vergeben.add(k.id);
    }
  });
  // 2. Über die E-Mail-Adresse (nur wenn der Lead noch keinen Kunden hat)
  kunden.forEach(k => {
    if (vergeben.has(k.id) || k.crmLeadId) return;
    const leadId = nachMail.get(normMail(k.email));
    if (leadId && !result.has(leadId)) result.set(leadId, { kunde_nr: k.nummer, firma: k.firma, ...k.werte });
  });
  return result;
}

module.exports = { isConfigured, alleKunden, kundeZuLead, leadUebernehmen, werteJeLead, cacheLeeren, toolUrl: () => cfg().url };
