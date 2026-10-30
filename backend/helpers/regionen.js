// ── Region prüfen (Leadsuche) ─────────────────────────────────
// Ordnet einen Suchort („Krefeld“, „Rhein-Main“, „NRW“) den deutschen PLZ-Leitzonen (erste zwei
// Ziffern) zu. Ein Treffer liegt im Suchgebiet, wenn seine PLZ in einer dieser Zonen liegt.
// Unbekannter Suchort: Vergleich über den Ortsnamen. Ohne PLZ und ohne Ortsnamen: „ungeprüft“.
const z = (...a) => a.map(n => String(n).padStart(2, '0'));

const REGIONEN = {
  // Bundesländer (Leitzonen grob, Randgebiete können anders liegen)
  'nrw': z(32, 33, 40, 41, 42, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 57, 58, 59),
  'nordrhein-westfalen': z(32, 33, 40, 41, 42, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 57, 58, 59),
  'hessen': z(34, 35, 36, 60, 61, 63, 64, 65),
  'bayern': z(63, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97),
  'baden-württemberg': z(68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 88, 89, 97),
  'niedersachsen': z(21, 26, 27, 28, 29, 30, 31, 37, 38, 49),
  'rheinland-pfalz': z(54, 55, 56, 57, 66, 67, 76),
  'saarland': z(66),
  'berlin': z(10, 12, 13, 14),
  'hamburg': z(20, 21, 22),
  'bremen': z(27, 28),
  'schleswig-holstein': z(22, 23, 24, 25),
  'sachsen': z('01', '02', '04', '08', '09'),
  'thüringen': z('04', '06', '07', '36', '37', '96', '98', '99'),
  'sachsen-anhalt': z('06', '29', '38', '39'),
  'brandenburg': z('01', '03', '04', '14', '15', '16', '17', '19'),
  'mecklenburg-vorpommern': z('17', '18', '19', '23'),
  // Ballungsräume
  'rhein-main': z(55, 60, 61, 63, 64, 65),
  'ruhrgebiet': z(44, 45, 46, 47, 58, 59),
  'rheinland': z(40, 41, 42, 47, 50, 51, 52, 53),
  'niederrhein': z(41, 46, 47),
  'rhein-neckar': z(67, 68, 69, 74),
  'bergisches land': z(42, 51),
  'münsterland': z(48, 59),
  'ostwestfalen': z(32, 33),
  'sauerland': z(57, 58, 59),
  // Größere Städte (mit Umland in derselben Leitzone)
  'krefeld': z(47), 'duisburg': z(47), 'moers': z(47), 'düsseldorf': z(40, 41), 'neuss': z(41), 'mönchengladbach': z(41),
  'köln': z(50, 51), 'bonn': z(53), 'aachen': z(52), 'essen': z(45), 'dortmund': z(44), 'bochum': z(44), 'wuppertal': z(42),
  'gelsenkirchen': z(45), 'oberhausen': z(46), 'münster': z(48), 'bielefeld': z(33), 'paderborn': z(33), 'hagen': z(58),
  'frankfurt': z(60, 61, 63, 65), 'frankfurt am main': z(60, 61, 63, 65), 'offenbach': z(63), 'darmstadt': z(64), 'wiesbaden': z(65),
  'mainz': z(55, 65), 'hanau': z(63), 'kassel': z(34), 'mannheim': z(68), 'heidelberg': z(69), 'karlsruhe': z(76),
  'stuttgart': z(70, 71, 73), 'münchen': z(80, 81, 82, 85), 'nürnberg': z(90, 91), 'augsburg': z(86), 'regensburg': z(93),
  'würzburg': z(97), 'hamburg-umland': z(20, 21, 22, 25), 'hannover': z(30, 31), 'braunschweig': z(38), 'bremerhaven': z(27),
  'leipzig': z('04'), 'dresden': z('01'), 'chemnitz': z('09'), 'erfurt': z(99), 'magdeburg': z(39), 'rostock': z(18),
  'kiel': z(24), 'lübeck': z(23), 'saarbrücken': z(66), 'koblenz': z(56), 'trier': z(54), 'freiburg': z(79), 'ulm': z(89),
};

function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/^(raum|region|großraum|umgebung|im|in)\s+/, '').trim(); }

// Leitzonen für einen Suchort (mehrere Orte mit Komma/„und“ möglich) oder null
function zonen(suchort) {
  const teile = norm(suchort).split(/\s*(?:,|\bund\b|\/|\+)\s*/).filter(Boolean);
  const alle = new Set();
  for (const t of teile) {
    const k = REGIONEN[t] || REGIONEN[t.replace(/\s*\(.*\)$/, '')] || REGIONEN[t.split(' ')[0]];
    if (!k) return null;               // ein Teil unbekannt → nicht über PLZ prüfen
    k.forEach(x => alle.add(x));
  }
  return alle.size ? [...alle] : null;
}

function plzAus(lead) {
  const m = String(lead.plz || '').match(/\b\d{5}\b/) || String(lead.location || '').match(/\b\d{5}\b/);
  return m ? m[0] : null;
}

// 'ja' | 'nein' | 'ungeprueft'
function imGebiet(lead, suchort) {
  if (!String(suchort || '').trim()) return 'ja';
  const plz = plzAus(lead);
  const zs = zonen(suchort);
  if (zs && plz) return zs.includes(plz.slice(0, 2)) ? 'ja' : 'nein';
  const ort = norm([lead.ort, lead.location].filter(Boolean).join(' '));
  const gesucht = norm(suchort).split(/\s*(?:,|\bund\b|\/)\s*/).filter(Boolean);
  if (ort && gesucht.some(g => ort.includes(g))) return 'ja';
  return 'ungeprueft';
}

module.exports = { imGebiet, zonen, plzAus };
