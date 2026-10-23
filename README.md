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
- `BASE_URL` → z.B. https://crm.novaflowservices.de

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

In Plesk/Apache/Nginx: Subdomain `crm.novaflowservices.de` auf Port 3000 weiterleiten.

**Nginx Beispiel:**
```nginx
server {
    listen 443 ssl;
    server_name crm.novaflowservices.de;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Live-Gang und automatische Prüfung

Das Repository ist mit Hostinger verbunden: Sobald ein Stand in `main` landet, holt Hostinger ihn
automatisch und startet das CRM neu – dafür muss nichts eingestellt werden.

Vorher prüft GitHub jeden Pull Request (`.github/workflows/check.yml`): Syntax aller Dateien,
Test-Datenbank anlegen, CRM testweise starten und ansprechen (u.a. `/api/health`). Ein Pull Request
wird nur übernommen, wenn diese Prüfung grün ist.

`/api/health` zeigt auch im Live-Betrieb, ob das CRM läuft und die Datenbank erreichbar ist.

---

## Schritt 6 — Ersten Admin anlegen

1. Browser öffnen: `https://crm.novaflowservices.de/setup`
2. Admin-Account ausfüllen und erstellen
3. Mit `/login` anmelden

---

## E-Mail-Eingang (Kundenantworten im CRM)

Das CRM ruft alle 2 Minuten das Postfach aus `IMAP_USER` ab (Standard: `info@novaflowservices.de`).
Ins CRM kommen **nur Antworten auf Mails, die aus dem CRM verschickt wurden**:

1. Der Kunde drückt in seinem Mailprogramm „Antworten“ (erkannt über `In-Reply-To`/`References`)
2. Fallback: Antwort („Re:“/„AW:“) mit Lead-Kennung im Betreff, z.B. `[NF-123]`

Alle anderen Mails an das Postfach (Newsletter, Rechnungen, neue Anfragen …) werden nicht geladen,
nicht gespeichert und sind im CRM für niemanden sichtbar – sie bleiben ganz normal im Postfach.
Zugeordnete Antworten sieht nur der Vertriebler, dem der Lead gehört (und der Admin):
im **Posteingang** (mit Ungelesen-Zähler) und im E-Mail-Verlauf des Leads, dort mit „Antworten“-Button.

Mails aus dem CRM gehen mit dem Namen des Mitarbeiters raus („Max Muster | NovaFlow Services“),
aber über das gemeinsame Postfach, damit Antworten wieder im CRM landen.

`.env`: `IMAP_HOST`, `IMAP_PORT` (993), `IMAP_USER`, `IMAP_PASS`. Beim ersten Abruf werden die letzten
30 Tage geprüft. Status und „Jetzt abrufen“ findest du als Admin unter **Posteingang**.

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
   - Voice Request URL: `https://crm.novaflowservices.de/api/voice/twiml` (HTTP POST)
   - die SID (beginnt mit `AP`) als `TWILIO_TWIML_APP_SID` eintragen.
5. **Geo Permissions** (Console → Voice → Settings → Geo permissions): Deutschland aktivieren
   (ggf. Österreich/Schweiz).
6. `BASE_URL` in `.env` muss exakt der öffentlichen Adresse entsprechen (wird zur Prüfung der
   Twilio-Signatur benötigt).
7. Optional `TWILIO_CALLER_ID`: Firmennummer, die angezeigt wird, wenn ein Mitarbeiter (noch) keine
   eigene Nummer hinterlegt hat. Muss eine bei Twilio gekaufte oder dort verifizierte Nummer sein.
8. `npm install` im Ordner `backend`, dann `pm2 restart leadhunter`.

### Eingehende Anrufe auf die Firmennummer

Kunden rufen eine Twilio-Firmennummer an, und es klingelt direkt im CRM (Browser-Tab muss offen sein):

1. In Twilio eine deutsche Nummer kaufen (Console → Phone Numbers → Buy a number; für deutsche
   Nummern verlangt Twilio einmalig einen Adress-/Firmennachweis, „Regulatory Bundle“).
2. Bei der Nummer unter „Voice Configuration“ → „A call comes in“: Webhook
   `https://crm.novaflowservices.de/api/voice/incoming` (HTTP POST) eintragen.
3. Dieselbe Nummer als `TWILIO_CALLER_ID` in `.env` eintragen – dann sehen Kunden bei
   ausgehenden Anrufen diese Nummer und landen beim Rückruf wieder im CRM.

Ablauf: Der Anrufer wird über die Telefonnummer dem Lead zugeordnet (unbekannte Nummer → neuer Lead
„Anrufer +49 …“). Es klingelt zuerst 20 Sekunden beim betreuenden Vertriebler, danach beim ganzen Team.
Wer annimmt, sieht sofort den Lead; danach öffnet sich die Anruf-Dokumentation. Nimmt niemand ab,
hört der Anrufer eine Ansage und im CRM entsteht unter **Heute → Verpasste Anrufe** eine Rückruf-Aufgabe.

### Eigene Nummer je Vertriebler (empfohlen)

Der Admin teilt jedem Mitarbeiter eine Nummer aus dem Twilio-Konto zu: **Benutzer → Bearbeiten →
„Nummer fürs Telefonieren im CRM“**. Dort stehen alle Nummern des Kontos (frei / bei wem); mit
„Neue Nummer holen“ sucht man nach Vorwahl (z. B. 030) und kauft die Nummer direkt.
- Der Mitarbeiter muss nichts bestätigen: Die Nummer gehört NovaFlow. Sie wird bei seinen Anrufen
  (auch im Anrufmodus) angezeigt.
- Anrufe auf diese Nummer klingeln nur bei ihm im CRM (Browser oder Handy, Seite muss offen sein).
  Nimmt er nicht ab, entsteht bei ihm eine Rückruf-Aufgabe unter **Heute → Verpasste Anrufe**. Unbekannte
  Anrufer werden als Lead angelegt und ihm zugewiesen.
- Den Webhook der Nummer setzt das CRM beim Zuteilen selbst.
- Einmalige Voraussetzung für deutsche Nummern: der bestätigte Nachweis (Firmenadresse + Ausweis) in
  Twilio unter Phone Numbers → Regulatory Compliance. Das CRM nutzt ihn beim Kauf automatisch.

**Ohne zugeteilte Nummer:** Einstellungen → „Telefonie im Browser“ → eigene Handynummer eintragen →
„Übernehmen“. Das CRM zeigt einen 6-stelligen Code, das Telefon klingelt kurz, Code eintippen – fertig.
Diese einmalige Bestätigung ist Pflicht: Telefonanbieter dürfen nur Nummern als Absender anzeigen, deren
Besitz nachgewiesen ist (Schutz gegen Rufnummern-Fälschung).

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
│   │   ├── voice.js       ← Telefonie im Browser (Twilio)
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

### Anrufmodus (für alle):
- Button **„Anrufmodus starten“** (Seitenleiste bzw. „Meine Leads“): Leads werden nacheinander angezeigt,
  in sinnvoller Reihenfolge – erst fällige Wiedervorlagen, dann Rückrufe ohne Termin, neue Leads,
  dann Leads, die heute noch nicht angerufen wurden. Leads mit Termin in der Zukunft tauchen erst zum Termin auf.
- Pro Lead: **Anrufen** → Ergebnis wählen (Tasten **1–8**) → Notiz → Wiedervorlage (vorausgefüllt)
  → **Strg+Enter** speichert alles in einem Schritt (Anruf, Status, Verlauf, nächster Termin) und öffnet den nächsten Lead.
- „Rückruf vereinbart“ lässt sich nur mit Termin speichern – kein Lead geht verloren.

### Angebote & Rechnungen (Admins, Closer nur mit Berechtigung):
- Menüpunkt **Angebote & Rechnungen**: die komplette Abrechnung aus dem früheren Angebotstool – Kunden,
  Artikel (Pakete & Preise), Angebote mit KI-Entwurf, Rechnungen mit lückenlosen Nummernkreisen,
  Mahnungen, Abos, PDF-Archiv, E-Mail-Versand und Export für die Buchhaltung.
- **Berechtigung:** Closer sehen den Bereich nur, wenn ein Admin unter Benutzer → Bearbeiten
  „Angebote & Rechnungen“ anhakt (Standard: aus). Stammdaten, Export und Sicherungen bleiben Admins vorbehalten.
- **Verknüpft mit Leads & Deals:** „Angebot erstellen“ im Lead oder im Deal-Fenster legt den Kunden an
  (bzw. findet ihn über E-Mail/Firma) und öffnet den Angebotsentwurf. Wird das Angebot versendet, rückt der
  Deal in „Angebot gesendet“; angenommen → Deal gewonnen (mit Angebotswert), abgelehnt → Deal verloren.
  Im Lead stehen alle Angebote und Rechnungen des Kunden.
- **Daten:** liegen außerhalb des App-Ordners in `~/crm-abrechnung` (SQLite + archivierte PDFs), damit sie
  bei jedem Deploy erhalten bleiben (anderer Ort: `ABRECHNUNG_DATA_DIR`).
- **Abgleich mit dem Angebotstool:** Bei jedem Start, alle 3 Stunden und per „Jetzt abgleichen“ holt das CRM
  alles aus `~/angebot-tool-daten`: Kunden, Artikel, Angebote, Rechnungen, Abos, Stammdaten, Nummernkreise,
  PDFs und Anhänge. Im Tool Geändertes wird übernommen, im CRM Geändertes bleibt, bei beidem gewinnt der neuere
  Stand; Nummernkreise werden zusammengeführt. Zusätzlich landen die Sicherungen des Tools und alle
  Betriebe-Daten als Kopie in `~/crm-abrechnung/angebotstool-archiv`. Das Tool selbst wird nur gelesen.
- **Kundenkonten aus dem Angebotstool** (Umschalter oben in „Angebote & Rechnungen“, nur Admin): alle Betriebe
  mit Firmendaten, Zugang, letztem Login, Kunden, Angeboten, Rechnungen, Umsatz und offenem Betrag; „Ansehen“ zeigt
  die komplette Abrechnung des Betriebs inkl. PDFs – nur zur Ansicht, bearbeitet wird weiterhin im Tool. Ist der
  Betrieb auch als Lead im CRM, führt „Lead“ direkt dorthin. Liegt das Tool nicht unter `~/angebot-tool-daten`,
  sucht das CRM den Ordner im Home-Verzeichnis selbst.
- Voraussetzung: Node.js 22.13 oder neuer. E-Mails gehen als „NovaFlow Services <SMTP_USER>“ raus
  (anders: `ABRECHNUNG_SMTP_FROM`), KI-Entwürfe nutzen `CLAUDE_API_KEY`.

### Heute, Wähllisten, Dubletten:
- **Heute** (Startseite der Vertriebler): verpasste Anrufe, fällige Rückrufe, neue Kundenantworten,
  Deals ohne nächsten Schritt / mit erreichtem Abschlussdatum – jeweils mit Anrufen-Knopf.
- **Wähllisten**: gespeicherte Filter (Status, Branche, Ort/PLZ, nie erreicht, letzter Anruf vor x Tagen,
  max. Versuche, mit/ohne Deal, Quelle, inkl. freier Leads) – „Anrufen“ startet den Anrufmodus nur mit diesen Leads.
  Freie Leads werden beim Speichern des Ergebnisses automatisch übernommen. Admins können Listen fürs Team teilen.
- **Dubletten-Check**: gleiche Telefonnummer (egal wie geschrieben), E-Mail oder Website-Domain wird beim
  Anlegen, CSV-Import und der KI-Generierung erkannt. Im Lead erscheint ein Hinweis; Admins führen Dubletten
  unter Alle Leads → **Dubletten** zusammen (Verlauf, Anrufe, Deals wandern mit, die Kopie wird archiviert).

### Deals (wie bei Pipedrive):
- Ein Lead (Firma/Ansprechpartner) kann mehrere **Deals** haben: Titel, Wert (netto, €), Phase,
  erwarteter Abschluss, Verantwortlicher, Notizen. Abschluss als **Gewonnen** oder **Verloren** (mit Grund).
- Menüpunkt **Deals**: Pipeline-Board mit Summe pro Phase, Karten per Drag & Drop verschieben,
  beim Ziehen erscheinen die Zonen „Gewonnen“ / „Verloren“. Daneben eine Liste aller Deals (offen/gewonnen/verloren).
- Kennzahlen: offene Pipeline, gewichtete Prognose (Wert × Wahrscheinlichkeit der Phase),
  Umsatz im Monat, geplante Abschlüsse; im Admin-Dashboard zusätzlich Umsatz je Closer.
- Rot markierte Karten liegen länger als eingestellt in einer Phase („Rot nach x Tagen“).
- Phasen, Wahrscheinlichkeiten und „Rot nach“ stellt der Admin unter Deals → **Phasen bearbeiten** ein.
- Im Anrufmodus: „Interesse“/„Rückruf“ legt auf Wunsch direkt einen Deal mit Wert an,
  „Abschluss“ bucht den offenen Deal als gewonnen (oder legt einen gewonnenen an),
  „Kein Interesse“ schließt offene Deals als verloren.

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
