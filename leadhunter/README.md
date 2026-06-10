# LeadHunter Pro — Setup-Anleitung

## Voraussetzungen
- Node.js 18+ auf deinem Hosting
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
│   │   └── generate.js    ← Claude API Lead-Generierung
│   ├── helpers/
│   │   ├── logger.js      ← Aktivitäts-Log
│   │   └── mailer.js      ← E-Mail (Nodemailer)
│   └── cron/
│       └── reminders.js   ← Reminder-Scheduler
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
