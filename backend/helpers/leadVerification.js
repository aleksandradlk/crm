// Automatisierte, kostenlose Plausibilitätsprüfung für (KI-generierte) Leads.
// Nutzt nur Node-Bordmittel (dns) und Regex — keine externen/kostenpflichtigen Dienste.
const dns = require('dns').promises;
const db  = require('../db');
const { checkImpressum } = require('./impressumCheck');
const { checkAreaCode } = require('./areaCodeCheck');

// Server-weiter Schalter, falls der Betreiber den ausgehenden Website-Abruf
// (Impressum-Abgleich) nicht möchte. Standardmäßig an, da genau diese Prüfung
// als einzige die Firma-zu-Kontaktdaten-Zuordnung belegt (statt nur Formatchecks).
function impressumCheckEnabled() {
  return process.env.IMPRESSUM_CHECK !== 'false';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE_RE = /^\+?[0-9][0-9\s\-\/()]{5,19}$/;

const DNS_TIMEOUT_MS = 3000;
// domain -> Promise<true|false|null> (null = unbekannt/nicht prüfbar). Speichert das
// Promise selbst (nicht erst das Ergebnis), damit gleichzeitige Anfragen für dieselbe
// Domain sich einen einzigen DNS-Lookup teilen statt ihn zu duplizieren.
const domainCache = new Map();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function extractDomain(value) {
  if (!value) return null;
  const raw = value.includes('@') ? value.split('@')[1] : value;
  if (!raw) return null;
  try {
    const url = new URL(raw.match(/^https?:\/\//) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// true = Domain lässt sich auflösen, false = Domain existiert nachweislich nicht,
// null = nicht feststellbar (z.B. Netzwerk-Timeout) — wird NICHT als "ungültig" gewertet.
// Prüft nur, ob die Domain existiert (A/AAAA) — bewusst KEIN MX-Check: das Vorhandensein
// eines Mailservers sagt nichts darüber aus, ob die Website/Firma real ist, und umgekehrt
// haben viele echte Firmenwebsites keinen eigenen MX-Eintrag.
function domainIsResolvable(domain) {
  if (!domain) return Promise.resolve(null);
  if (domainCache.has(domain)) return domainCache.get(domain);

  const promise = withTimeout(dns.lookup(domain), DNS_TIMEOUT_MS)
    .then(() => true)
    .catch(err => (err.code === 'ENOTFOUND' ? false : null));
  domainCache.set(domain, promise);
  return promise;
}

// Prüft einen einzelnen Lead automatisiert. Liefert null (nicht prüfbar/kein Wert)
// statt false, wenn keine verlässliche Aussage möglich ist.
async function verifyLead(lead) {
  const checks = {
    email_valid: null, phone_valid: null, domain_valid: null,
    // phone_confirmed/email_confirmed: NICHT nur Formatplausibilität, sondern ein Fund
    // auf der tatsächlichen Firmen-Website (Impressum/Kontakt) — belegt die Zuordnung
    // "diese Nummer/Adresse gehört zu genau dieser Firma", siehe impressumCheck.js.
    phone_confirmed: null, email_confirmed: null, impressum_url: null,
    // area_code_valid: passt die Vorwahl zum genannten Ort? Läuft komplett offline,
    // ohne Website — wichtig für Leads ohne (aktuelle) Website, siehe areaCodeCheck.js.
    area_code_valid: null,
  };

  const emailFormatOk = lead.email ? EMAIL_RE.test(lead.email) : null;
  if (lead.email && !emailFormatOk) checks.email_valid = false;

  const [emailDomainOk, domainOk, impressum] = await Promise.all([
    lead.email && emailFormatOk ? domainIsResolvable(extractDomain(lead.email)) : null,
    lead.website ? domainIsResolvable(extractDomain(lead.website)) : null,
    (lead.website && impressumCheckEnabled())
      ? checkImpressum(lead.website, lead.phone, lead.email).catch(() => null)
      : null,
  ]);
  if (lead.email && emailFormatOk) checks.email_valid = emailDomainOk;
  if (lead.website) checks.domain_valid = domainOk;
  if (impressum) {
    checks.phone_confirmed = impressum.phone_confirmed;
    checks.email_confirmed = impressum.email_confirmed;
    checks.impressum_url   = impressum.impressum_url;
  }

  if (lead.phone) {
    checks.phone_valid = PHONE_RE.test(lead.phone.trim());
    checks.area_code_valid = checkAreaCode(lead.phone, lead.location);
  }

  return checks;
}

// Sucht einen bestehenden, nicht archivierten Lead mit gleicher E-Mail/Telefonnummer
// bzw. gleicher Firma+Standort. Verhindert, dass die KI denselben Lead doppelt anlegt.
async function findDuplicateLead(lead) {
  const conds = [];
  const params = [];
  if (lead.email) { conds.push('email = ?'); params.push(lead.email); }
  if (lead.phone) { conds.push('phone = ?'); params.push(lead.phone); }
  if (lead.company && lead.location) {
    conds.push('(company = ? AND location = ?)');
    params.push(lead.company, lead.location);
  }
  if (!conds.length) return null;

  const [rows] = await db.query(
    `SELECT id, company FROM leads WHERE archived_at IS NULL AND (${conds.join(' OR ')}) LIMIT 1`,
    params
  );
  return rows[0] || null;
}

function minConfidence() {
  const v = parseInt(process.env.MIN_LEAD_CONFIDENCE);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 40;
}

// Normalisiert einen confidence-Wert auf 0-100. Wichtig: `0` bleibt `0` (echtes "sehr
// unsicher") statt wie `value || 50` fälschlich zum Default 50 zu werden — sonst würde
// ein Lead, den die KI selbst mit confidence=0 markiert, das Confidence-Gate umgehen.
function clampConfidence(value) {
  const n = parseInt(value, 10);
  return Math.min(100, Math.max(0, Number.isFinite(n) ? n : 50));
}

module.exports = { EMAIL_RE, PHONE_RE, verifyLead, findDuplicateLead, minConfidence, clampConfidence };
