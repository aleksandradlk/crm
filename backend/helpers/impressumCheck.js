// Gleicht Telefonnummer/E-Mail eines Leads gegen das Impressum/die Kontaktseite der
// eigenen Firmen-Website ab — kostenlos (nur ein HTTP-Abruf), aber die einzige Prüfung
// in diesem System, die tatsächlich belegt, dass eine Nummer/Adresse zu GENAU dieser
// Firma gehört (statt nur "sieht aus wie eine Telefonnummer").
//
// Sicherheit: die Ziel-URL kommt letztlich von der KI bzw. aus einem CSV-Import, der
// Server darf also nicht blind auf beliebige (auch interne) Adressen zugreifen (SSRF).
// Deshalb wird vor jedem Request die aufgelöste IP gegen private/reservierte Bereiche
// geprüft, Redirects werden manuell verfolgt und dabei erneut geprüft.
const dns = require('dns').promises;
const net = require('net');

const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 300 * 1024;
const MAX_REDIRECTS = 3;
const IMPRESSUM_PATHS = ['/impressum', '/impressum.html', '/impressum/', '/kontakt', '/contact', '/imprint', '/legal-notice'];

function isPrivateIpv4(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
         (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
}

// Zerlegt eine (ggf. per "::" komprimierte) IPv6-Adresse in 8 16-Bit-Hextets.
function expandIPv6Hextets(ip) {
  const [headStr, tailStr] = ip.split('::');
  const head = headStr ? headStr.split(':').filter(Boolean) : [];
  const tail = tailStr ? tailStr.split(':').filter(Boolean) : [];
  const missing = Math.max(8 - head.length - tail.length, 0);
  const hextets = [...head, ...new Array(missing).fill('0'), ...tail].map(h => parseInt(h, 16) || 0);
  while (hextets.length < 8) hextets.push(0);
  return hextets;
}

function hextetsToIpv4(a, b) {
  return [(a >> 8) & 0xff, a & 0xff, (b >> 8) & 0xff, b & 0xff].join('.');
}

// Dekodiert IPv6-Adressformen, die eine IPv4-Adresse einbetten (NAT64 64:ff9b::/96,
// 6to4 2002::/16), damit z.B. 64:ff9b::7f00:1 (= 127.0.0.1) nicht an den generischen
// Checks unten vorbeirutscht, nur weil es kein fc/fd/fe80/::1-Präfix hat.
function embeddedIpv4(hextets) {
  if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets[2] === 0 &&
      hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0) {
    return hextetsToIpv4(hextets[6], hextets[7]); // NAT64
  }
  if (hextets[0] === 0x2002) {
    return hextetsToIpv4(hextets[1], hextets[2]); // 6to4
  }
  return null;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    // IPv4-mapped/-compatible IPv6 (::ffff:127.0.0.1, ::10.0.0.5, ...) muss auf die
    // eingebettete IPv4-Adresse geprüft werden, sonst umgeht sie die IPv4-Sperre oben.
    const mapped = lo.match(/(?:^::ffff:|^::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]);
    if (lo === '::1' || lo.startsWith('fc') || lo.startsWith('fd') || lo.startsWith('fe80') || lo === '::') return true;
    const hextets = expandIPv6Hextets(lo);
    const embedded = embeddedIpv4(hextets);
    return embedded ? isPrivateIpv4(embedded) : false;
  }
  return true; // unbekanntes Format -> sicherheitshalber blockieren
}

async function safeUrl(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  try {
    const { address } = await dns.lookup(url.hostname);
    if (isPrivateIp(address)) return null;
  } catch { return null; }
  return url;
}

async function fetchSafe(urlStr, redirectsLeft = MAX_REDIRECTS) {
  const url = await safeUrl(urlStr);
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'LeadHunterPro-Verifier/1.0 (Kontaktdaten-Abgleich)' },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  if ([301, 302, 303, 307, 308].includes(res.status) && redirectsLeft > 0) {
    const loc = res.headers.get('location');
    if (!loc) return null;
    try { return await fetchSafe(new URL(loc, url).toString(), redirectsLeft - 1); }
    catch { return null; }
  }
  if (!res.ok || !res.body) return null;

  let html = '';
  const reader = res.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      html += Buffer.from(value).toString('utf-8');
      if (received > MAX_BODY_BYTES) { reader.cancel().catch(() => {}); break; }
    }
  } catch {
    return null;
  }
  return { url: url.toString(), html };
}

const EMAIL_FIND_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_FIND_RE = /(?:\+49[\d\s\/\-()]{6,17}\d|0[\d\s\/\-()]{6,17}\d)/g;

function extractContacts(html) {
  const emails = [...new Set((html.match(EMAIL_FIND_RE) || []).map(e => e.toLowerCase()))];
  const phones = [...new Set((html.match(PHONE_FIND_RE) || []).map(p => p.trim()))];
  return { emails, phones };
}

function findImpressumLink(html, baseUrl) {
  const linkRe = /<a\s+[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const text = m[2].replace(/<[^>]+>/g, ' ').toLowerCase();
    if (/impressum|imprint|kontakt|contact|legal/.test(text) || /impressum|imprint/.test(m[1].toLowerCase())) {
      try { return new URL(m[1], baseUrl).toString(); } catch { continue; }
    }
  }
  return null;
}

function digitsOnly(s) { return (s || '').replace(/\D/g, ''); }

// Vergleicht die letzten 8 Ziffern (nationale Rufnummer ohne Vorwahl-/Länderpräfix-
// Mehrdeutigkeit: +49 30 1234567 vs. 030/1234567 vs. 0049 30 1234567 etc.)
function phoneMatches(a, b) {
  const da = digitsOnly(a), db = digitsOnly(b);
  if (da.length < 6 || db.length < 6) return false;
  return da.slice(-8) === db.slice(-8);
}

// Liefert { phone_confirmed, email_confirmed, impressum_url } — jeweils true (auf der
// Website gefunden), false (Website hat Kontaktdaten, aber keine passt) oder null
// (nicht feststellbar: keine Website, Seite nicht erreichbar, oder Seite nennt gar
// keine Telefonnummer/E-Mail zum Vergleich).
async function checkImpressum(website, phone, email) {
  const result = { phone_confirmed: null, email_confirmed: null, impressum_url: null };
  if (!website || (!phone && !email)) return result;

  const homeUrl = website.match(/^https?:\/\//) ? website : `https://${website}`;
  const home = await fetchSafe(homeUrl);
  if (!home) return result;

  let contactPage = null;
  const link = findImpressumLink(home.html, home.url);
  if (link) {
    contactPage = await fetchSafe(link);
  }
  if (!contactPage) {
    for (const path of IMPRESSUM_PATHS) {
      try {
        contactPage = await fetchSafe(new URL(path, home.url).toString());
        if (contactPage) break;
      } catch { /* ungültiger Pfad, nächsten versuchen */ }
    }
  }

  const homeContacts = extractContacts(home.html);
  const pageContacts = contactPage ? extractContacts(contactPage.html) : { emails: [], phones: [] };
  const emails = [...new Set([...homeContacts.emails, ...pageContacts.emails])];
  const phones = [...new Set([...homeContacts.phones, ...pageContacts.phones])];

  result.impressum_url = contactPage ? contactPage.url : home.url;
  if (phone) {
    result.phone_confirmed = phones.length ? phones.some(p => phoneMatches(p, phone)) : null;
  }
  if (email) {
    result.email_confirmed = emails.length ? emails.includes(email.toLowerCase()) : null;
  }
  return result;
}

module.exports = { checkImpressum, phoneMatches };
