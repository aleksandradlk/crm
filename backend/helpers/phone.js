// Telefonnummern ins E.164-Format bringen (z.B. "0171 / 123 45 67" → "+491711234567").
// Standard-Ländervorwahl: Deutschland (49), überschreibbar per DEFAULT_COUNTRY_CODE.
function toE164(raw, defaultCc = process.env.DEFAULT_COUNTRY_CODE || '49') {
  if (!raw) return null;
  let s = String(raw).trim()
    .replace(/\(0\)/g, '')          // "+49 (0) 30 …" → "+49 30 …"
    .replace(/[^\d+]/g, '');        // Leerzeichen, Klammern, Bindestriche, Schrägstriche
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (s.startsWith('0')) s = '+' + defaultCc + s.slice(1);
  else if (!s.startsWith('+')) s = '+' + defaultCc + s;
  s = '+' + s.slice(1).replace(/\+/g, '');
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

module.exports = { toE164 };
