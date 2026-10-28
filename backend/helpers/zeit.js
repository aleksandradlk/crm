// ── Zeiten: Datenbank in UTC, Eingabe und Anzeige in deutscher Zeit ─────────
// NOW() und alle automatischen Zeitstempel stehen in UTC in der Datenbank.
// Was Closer eintippen (Termin 15:00, Wiedervorlage morgen 9:00), ist deutsche
// Zeit – beim Speichern nach UTC umrechnen, beim Ausgeben als Text zurück.
// Sommer-/Winterzeit wird je Zeitpunkt berücksichtigt.
const ZONE = 'Europe/Berlin';
const pad = n => String(n).padStart(2, '0');
const RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function ortTeile(ms) {
  const t = {};
  fmt.formatToParts(new Date(ms)).forEach(p => { t[p.type] = p.value; });
  return t;
}
// Abstand deutsche Zeit − UTC in ms zum Zeitpunkt ms (+1 h Winter, +2 h Sommer)
function versatz(ms) {
  const t = ortTeile(ms);
  return Date.UTC(+t.year, +t.month - 1, +t.day, +t.hour % 24, +t.minute, +t.second) - Math.floor(ms / 1000) * 1000;
}
const alsSql = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

// '2026-10-28 15:00' oder '2026-10-28T15:00' (deutsche Zeit) → '2026-10-28 14:00:00' (UTC)
function ortZuUtc(v) {
  const m = RE.exec(String(v || ''));
  if (!m) return null;
  const wand = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let ms = wand - versatz(wand);
  const zweiter = versatz(ms);              // rund um die Umstellung nachrechnen
  if (wand - zweiter !== ms) ms = wand - zweiter;
  return alsSql(new Date(ms));
}

// UTC aus der Datenbank (Date oder 'YYYY-MM-DD HH:MM:SS') → deutsche Zeit 'YYYY-MM-DD HH:MM:SS'
function utcZuOrt(v) {
  if (!v) return v ?? null;
  let ms;
  if (v instanceof Date) ms = v.getTime();
  else {
    const m = RE.exec(String(v));
    if (!m) return v;
    ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }
  if (Number.isNaN(ms)) return null;
  const t = ortTeile(ms);
  return `${t.year}-${t.month}-${t.day} ${pad(+t.hour % 24)}:${t.minute}:${t.second}`;
}

// Eingabe aus dem Browser → UTC für die Datenbank. Mit Zonenangabe (…Z, +01:00) ist der
// Zeitpunkt eindeutig, ohne Angabe ist es deutsche Zeit. Ungültig → null.
function eingabeZuUtc(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : alsSql(d);
  }
  return ortZuUtc(s);
}

module.exports = { ZONE, ortZuUtc, utcZuOrt, eingabeZuUtc };
