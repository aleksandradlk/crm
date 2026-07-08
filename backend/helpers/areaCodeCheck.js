// Kostenloser, komplett offline laufender Plausibilitätscheck: passt die Telefon-
// Vorwahl zur angegebenen Stadt/Region? Funktioniert unabhängig von einer Website —
// wichtig für Zielgruppen wie Handwerksbetriebe, die oft keine (aktuelle) Website
// haben und bei denen der Impressum-Abgleich (impressumCheck.js) daher meist NULL
// (nicht prüfbar) liefert.
//
// WICHTIG — bewusste Einschränkung: Diese Tabelle ist eine kleine, manuell geprüfte
// Auswahl bekannter Vorwahlen großer/mittlerer deutscher Städte, NICHT das
// vollständige amtliche Vorwahlverzeichnis der Bundesnetzagentur (das kostenlos als
// CSV verfügbar ist, hier aber mangels Internetzugriff beim Bau nicht eingebunden
// werden konnte — siehe README-Hinweis). Für kleinere Orte/Landkreise liefert der
// Check deshalb bewusst NULL statt einer geratenen Zuordnung.
const VORWAHL_ORT = {
  '030':   ['berlin'],
  '040':   ['hamburg'],
  '069':   ['frankfurt', 'frankfurt am main'],
  '089':   ['münchen', 'muenchen', 'munich'],
  '0201':  ['essen'],
  '0202':  ['wuppertal'],
  '0203':  ['duisburg'],
  '0211':  ['düsseldorf', 'duesseldorf'],
  '0212':  ['solingen'],
  '02151': ['krefeld'],
  '02161': ['mönchengladbach', 'moenchengladbach'],
  '0221':  ['köln', 'koeln', 'cologne'],
  '0228':  ['bonn'],
  '0231':  ['dortmund'],
  '0234':  ['bochum'],
  '0241':  ['aachen'],
  '0251':  ['münster', 'muenster'],
  '0271':  ['siegen'],
  '02191': ['remscheid'],
  '0331':  ['potsdam'],
  '0341':  ['leipzig'],
  '0351':  ['dresden'],
  '0361':  ['erfurt'],
  '0371':  ['chemnitz'],
  '0391':  ['magdeburg'],
  '0421':  ['bremen'],
  '0431':  ['kiel'],
  '0451':  ['lübeck', 'luebeck'],
  '0471':  ['bremerhaven'],
  '0511':  ['hannover'],
  '0531':  ['braunschweig'],
  '0541':  ['osnabrück', 'osnabrueck'],
  '0561':  ['kassel'],
  '0611':  ['wiesbaden'],
  '06131': ['mainz'],
  '06151': ['darmstadt'],
  '0621':  ['mannheim'],
  '06221': ['heidelberg'],
  '0631':  ['kaiserslautern'],
  '0641':  ['gießen', 'giessen'],
  '0661':  ['fulda'],
  '0681':  ['saarbrücken', 'saarbruecken'],
  '0711':  ['stuttgart'],
  '0721':  ['karlsruhe'],
  '0731':  ['ulm'],
  '0761':  ['freiburg'],
  '07531': ['konstanz'],
  '0821':  ['augsburg'],
  '0831':  ['kempten'],
  '0841':  ['ingolstadt'],
  '0851':  ['passau'],
  '0871':  ['landshut'],
  '0911':  ['nürnberg', 'nuernberg', 'nuremberg'],
  '0921':  ['bayreuth'],
  '0931':  ['würzburg', 'wuerzburg'],
  '0941':  ['regensburg'],
  '0951':  ['bamberg'],
};

function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .trim();
}

// Reverse-Index Stadtname -> Vorwahl, einmalig beim Laden aufgebaut.
const CITY_TO_VORWAHL = {};
for (const [vorwahl, cities] of Object.entries(VORWAHL_ORT)) {
  for (const city of cities) CITY_TO_VORWAHL[normalize(city)] = vorwahl;
}
// Längste Vorwahlen zuerst prüfen (z.B. "06221" vor dem kürzeren "062"-Präfix).
const KNOWN_VORWAHLEN = Object.keys(VORWAHL_ORT).sort((a, b) => b.length - a.length);

function extractVorwahl(phone) {
  if (!phone) return null;
  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+49')) digits = '0' + digits.slice(3);
  else if (digits.startsWith('0049')) digits = '0' + digits.slice(4);
  if (!digits.startsWith('0')) return null;
  return KNOWN_VORWAHLEN.find(v => digits.startsWith(v)) || null;
}

// true = Vorwahl passt zur genannten Stadt, false = die Vorwahl gehört nachweislich zu
// einer ANDEREN bekannten Stadt als im Ort genannt (klarer Widerspruch), null = nicht
// feststellbar (Vorwahl oder Ort nicht in der Tabelle — z.B. kleinere Gemeinde).
// Bewusst konservativ: ein unbekannter, aber echter kleiner Ort löst KEINE Warnung
// aus, nur ein eindeutiger Widerspruch zwischen zwei bekannten Städten.
function checkAreaCode(phone, location) {
  const vorwahl = extractVorwahl(phone);
  if (!vorwahl) return null;

  const normLoc = normalize(location);
  if (!normLoc) return null;

  if (VORWAHL_ORT[vorwahl].some(c => normLoc.includes(normalize(c)))) return true;

  for (const [city, otherVorwahl] of Object.entries(CITY_TO_VORWAHL)) {
    if (otherVorwahl !== vorwahl && normLoc.includes(city)) return false;
  }
  return null;
}

module.exports = { checkAreaCode };
