# LeadHunter Pro — Setup-Anleitung

## Voraussetzungen
- Node.js 20+ auf deinem Hosting
- MySQL/MariaDB Datenbank
- SSH-Zugang zu deinem Server

---

## Schritt 1 — Datenbank anlegen

Im Hoster-Control-Panel (z.B. Plesk, cPanel):
1. Neue Datenbank anlegen: `leadhunter`
2. Neuen DB-User anlegen mit Vollzugriff auf diese DB
3. Zugangsdaten notieren

Dann Tabellen erstellen:
```bash
mysql -u DEIN_DB_USER -p leadhunter < db/schema.sql
```

---

## Schritt 2 — Backend konfigurieren

```bash
cd backend
cp .env.example .env
nano .env   # Werte eintragen (DB, JWT, SMTP, Claude API Key)
```

Wichtige Werte in `.env`:
- `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` → von Schritt 1
- `JWT_SECRET` → beliebiger langer zufälliger String (min. 32 Zeichen)
- `CLAUDE_API_KEY` → von console.anthropic.com
- `SMTP_HOST` / `SMTP_PASS` → SMTP-Zugangsdaten für info@novaflowservices.de
- `BASE_URL` → z.B. https://leads.novaflowservices.de

---

## Schritt 3 — Dependencies installieren

```bash
cd backend
npm install
```

---

## Schritt 4 — App starten

**Testweise:**
```bash
node server.js
```

**Dauerhaft (mit PM2 empfohlen):**
```bash
npm install -g pm2
pm2 start server.js --name leadhunter
pm2 save
pm2 startup
```

---

## Schritt 5 — Webserver / Subdomain konfigurieren

In Plesk/Apache/Nginx: Subdomain `leads.novaflowservices.de` auf Port 3000 weiterleiten.

**Nginx Beispiel:**
```nginx
server {
    listen 443 ssl;
    server_name leads.novaflowservices.de;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Schritt 6 — Ersten Admin anlegen

1. Browser öffnen: `https://leads.novaflowservices.de/setup.html`
2. Admin-Account ausfüllen und erstellen
3. Mit `/login.html` anmelden

---

## E-Mail-Eingang (Kundenantworten im CRM)

Das CRM ruft alle 2 Minuten das Postfach aus `IMAP_USER` ab (Standard: `info@novaflowservices.de`).
Eingehende Mails werden automatisch dem passenden Lead zugeordnet:

1. Antwort auf eine Mail aus dem CRM (Kunde drückt „Antworten“, erkannt über `In-Reply-To`/`References`)
2. Lead-Kennung im Betreff, z.B. `[NF-123]`
3. Absenderadresse = E-Mail-Adresse eines Leads

Zugeordnete Mails erscheinen im **Posteingang** (mit Ungelesen-Zähler) und im E-Mail-Verlauf des Leads,
dort mit „Antworten“-Button. Nicht zuordenbare Mails landen beim Admin unter
**Posteingang → Unzugeordnete E-Mails** und lassen sich dort per „Zuordnen“ einem Lead zuweisen.

Mails aus dem CRM gehen mit dem Namen des Mitarbeiters raus („Max Muster | NovaFlow Services“),
aber über das gemeinsame Postfach, damit Antworten wieder im CRM landen.

`.env`: `IMAP_HOST`, `IMAP_PORT` (993), `IMAP_USER`, `IMAP_PASS`. Beim ersten Abruf werden die letzten
30 Tage importiert. Status und „Jetzt abrufen“ findest du als Admin unter **Posteingang**.

---

## Telefonie im Browser einrichten (Twilio)

Mitarbeiter rufen direkt im CRM per Klick auf „Anrufen“ an (Headset/Mikrofon am PC). Beim Kunden
erscheint die hinterlegte Nummer des Mitarbeiters. Nach dem Auflegen öffnet sich die Anruf-Dokumentation
mit vorausgefülltem Ergebnis und Gesprächsdauer. Ohne Twilio-Konfiguration bleibt alles wie bisher
(Nummer wählen über Handy, Anruf danach dokumentieren).

1. Konto auf [twilio.com](https://www.twilio.com) anlegen und auf ein bezahltes Konto upgraden
   (Testkonten können nur verifizierte Nummern anrufen und spielen eine Ansage ab).
2. **Account SID** und **Auth Token** (Twilio Console → Account Info) in `.env` eintragen:
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.
3. **API Key** anlegen (Console → Account → API keys & tokens → Create API key, Typ „Standard“):
   `TWILIO_API_KEY_SID` (beginnt mit `SK`) und `TWILIO_API_KEY_SECRET`.
4. **TwiML App** anlegen (Console → Voice → TwiML Apps → Create):
   - Voice Request URL: `https://leads.novaflowservices.de/api/voice/twiml` (HTTP POST)
   - die SID (beginnt mit `AP`) als `TWILIO_TWIML_APP_SID` eintragen.
5. **Geo Permissions** (Console → Voice → Settings → Geo permissions): Deutschland aktivieren
   (ggf. Österreich/Schweiz).
6. `BASE_URL` in `.env` muss exakt der öffentlichen Adresse entsprechen (wird zur Prüfung der
   Twilio-Signatur benötigt).
7. Optional `TWILIO_CALLER_ID`: Firmennummer, die angezeigt wird, wenn ein Mitarbeiter (noch) keine
   eigene Nummer hinterlegt hat. Muss eine bei Twilio gekaufte oder dort verifizierte Nummer sein.
8. `npm install` im Ordner `backend`, dann `pm2 restart leadhunter`.

**Pro Mitarbeiter (einmalig, ca. 30 Sekunden):** Einstellungen → „Telefonie im Browser“ → eigene
Nummer eintragen → „Übernehmen“. Das CRM zeigt einen 6-stelligen Code, das Telefon klingelt kurz,
Code eintippen – fertig. Diese einmalige Bestätigung ist Pflicht: Telefonanbieter dürfen nur Nummern
als Absender anzeigen, deren Besitz nachgewiesen ist (Schutz gegen Rufnummern-Fälschung).

---

## Angebotstool anbinden (Kundenwert im CRM)

Das CRM zeigt pro Lead die Angebote, Rechnungen und Abos aus dem Angebotstool
(tool.novaflowservices.de) – und damit, welcher Kunde wie viel wert ist:

- **Lead öffnen → „Angebote & Umsatz“**: offene Angebote, bezahlter Umsatz, offene Rechnungen,
  monatliche Abos. Closer sehen die Werte nur lesend.
- **Als Admin**: „Als Kunde anlegen & Angebot erstellen“ übernimmt den Lead als Kunden ins
  Angebotstool und öffnet dort direkt ein neues Angebot für ihn. „Neues Angebot“ / „Im Angebotstool öffnen“
  springt in das Tool (dort ist dein Admin-Login nötig).
- **€-Badges** in Lead-Liste und Pipeline, Menüpunkt **Kundenwert** mit allen Kunden und Summen.

Zuordnung Lead ↔ Kunde: feste Verknüpfung (entsteht beim Übernehmen), sonst gleiche E-Mail-Adresse,
sonst eindeutiger Firmenname.

Einrichtung (einmalig):
1. Einen langen zufälligen Schlüssel erzeugen, z.B. `openssl rand -hex 32`.
2. **Angebotstool** (Hostinger → Umgebungsvariablen): `CRM_API_KEY=<schlüssel>` setzen, neu starten.
3. **CRM** `.env`: `ANGEBOT_TOOL_URL=https://tool.novaflowservices.de` und `ANGEBOT_TOOL_KEY=<derselbe schlüssel>`,
   dann `pm2 restart leadhunter`.

Ohne diese Werte bleibt der Bereich einfach ausgeblendet.

---

## Eingehende Anrufe aufs Handy (wie bei Pipedrive)

Ruft ein Kunde die Firmennummer an, passiert Folgendes:

1. Das CRM sucht die Nummer bei den Leads.
2. Auf deinem Handy (und dem des zuständigen Closers) erscheint sofort eine Benachrichtigung:
   **„📞 Müller Bau GmbH ruft an“** – mit Ansprechpartner, Status, Zuständigem und offenen Angeboten/Umsatz.
   Antippen öffnet den Lead im CRM.
3. Der Anruf wird auf das Handy des zuständigen Closers weitergeleitet (ist der Lead niemandem zugewiesen
   oder unbekannt: an die Admins). Angezeigt wird die Nummer des Kunden. Beim Abheben sagt eine kurze
   Ansage „CRM-Anruf von Müller Bau GmbH“, dann ist der Kunde durchgestellt.
4. Der Anruf landet im Anruf-Verlauf des Leads („Eingehend“). Nimmt niemand ab, hört der Kunde
   „Wir rufen Sie schnellstmöglich zurück“, alle bekommen „❗ Verpasster Anruf“ und der Zuständige eine
   Rückruf-Erinnerung.

Auch fällige Reminder kommen als Push aufs Handy.

**Einrichtung:**
1. Twilio ist wie unter „Telefonie im Browser“ eingerichtet.
2. In Twilio eine Rufnummer kaufen (Console → Phone Numbers → Buy a number). Für deutsche Nummern
   verlangt Twilio einmalig ein „Regulatory Bundle“ (Adresse im Ortsnetz bzw. Firmennachweis).
3. Bei der Nummer unter **Voice Configuration → A call comes in**: Webhook
   `https://leads.novaflowservices.de/api/voice/incoming`, HTTP POST.
4. Diese Nummer ist ab jetzt deine Firmennummer (Website, Visitenkarte, Google). Am besten auch als
   `TWILIO_CALLER_ID` eintragen, dann sehen Kunden sie auch bei Anrufen aus dem CRM.
5. **Jeder Mitarbeiter:** Einstellungen → **„Meine Telefonnummer“** = eigene Handynummer (dorthin wird
   weitergeleitet; ist sie leer, wird die bestätigte Anrufnummer genommen) und → „Anrufe & Erinnerungen
   aufs Handy“ → **Auf diesem Gerät aktivieren**. Als „Meine Anrufnummer“ kann die Twilio-Firmennummer
   stehen, dann sehen Kunden auch bei Anrufen aus dem CRM die Firmennummer.
   - **iPhone:** CRM in Safari öffnen → Teilen → **Zum Home-Bildschirm**, dann über das neue App-Symbol
     öffnen und dort aktivieren (Apple erlaubt Push nur für installierte Web-Apps, ab iOS 16.4).
   - **Android:** direkt in Chrome aktivieren (optional „Zum Startbildschirm hinzufügen“).

Tipp: Die Mailbox auf dem Handy erst nach mehr als 25 Sekunden anspringen lassen (oder abschalten),
sonst nimmt sie weitergeleitete Anrufe an, bevor das CRM „verpasst“ melden kann.

**Und die eSIM?** Eine eSIM ist einfach eine zweite Leitung auf demselben Handy. Du kannst die
Twilio-Nummer auf eine eSIM-Nummer weiterleiten lassen (die eSIM-Nummer als „Meine Telefonnummer“ im CRM
hinterlegen), damit Geschäftsanrufe auf der Geschäftsleitung klingeln. Wichtig: Die Nummer, die Kunden
anrufen, muss die Twilio-Nummer sein. Ruft jemand die eSIM-Nummer direkt an, bekommt das CRM davon nichts mit.

---

## Dateistruktur

```
leadhunter/
├── backend/
│   ├── server.js          ← Hauptserver
│   ├── db.js              ← DB-Verbindung
│   ├── .env               ← Konfiguration (NICHT in Git!)
│   ├── package.json
│   ├── middleware/
│   │   └── auth.js        ← JWT-Auth
│   ├── routes/
│   │   ├── auth.js        ← Login/Logout/Heartbeat
│   │   ├── users.js       ← Benutzerverwaltung
│   │   ├── leads.js       ← Lead CRUD + Kommentare + Reminder
│   │   ├── emails.js      ← Posteingang (Kundenmails, gelesen/ungelesen)
│   │   ├── voice.js       ← Telefonie: Anrufe aus dem Browser + eingehende Anrufe (Twilio)
│   │   ├── angebote.js    ← Angebote & Umsatz aus dem Angebotstool
│   │   ├── push.js        ← Push-Benachrichtigungen aufs Handy
│   │   └── generate.js    ← Claude API Lead-Generierung
│   ├── helpers/
│   │   ├── logger.js      ← Aktivitäts-Log
│   │   └── mailer.js      ← E-Mail (Nodemailer)
│   └── cron/
│       ├── reminders.js   ← Reminder-Scheduler
│       └── emailPoller.js ← Holt Kundenmails per IMAP ab
├── frontend/
│   ├── login.html         ← Login-Seite
│   ├── setup.html         ← Ersteinrichtung
│   ├── admin.html         ← Admin-Dashboard
│   ├── closer.html        ← Closer-Dashboard
│   └── shared/
│       ├── style.css      ← Globale Styles
│       └── api.js         ← API-Client + Auth + Tracking
└── db/
    └── schema.sql         ← Datenbankstruktur
```

---

## Features Übersicht

### Admin kann:
- Leads per Claude AI generieren und Closern zuweisen
- Alle Leads sehen, bearbeiten, löschen
- Benutzerkonten anlegen, bearbeiten, sperren
- Tracking sehen: Sitzungsdauer, Klick-Anzahl, letzter Login
- Aktivitätslog: wer hat wann was gemacht
- CSV exportieren

### Closer kann:
- Nur eigene (zugewiesene) Leads sehen
- Status setzen: Neu / Kontaktiert / Nicht erreicht / Kein Interesse / Rückruf / Kunde
- Kommentare pro Lead schreiben
- Reminder setzen (In-App + E-Mail)
- Keine Lead-Generierung, keine anderen User sehen

### Sicherheit:
- Auto-Logout nach 15 Min. Inaktivität (konfigurierbar in .env)
- JWT-Sessions (12h gültig)
- Passwörter bcrypt-gehasht
- Rate Limiting auf Login (20/15min) und Generate (5/min)
- Audit Trail aller Aktionen in DB
