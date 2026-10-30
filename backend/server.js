// Server rechnet in deutscher Zeit (Erinnerungen, „heute“, Mails). Die Datenbank bleibt
// in UTC, siehe db.js und helpers/zeit.js.
process.env.TZ = 'Europe/Berlin';
require('dotenv').config();
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET ist nicht gesetzt.');
  process.exit(1);
}
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const path        = require('path');

const authRoutes     = require('./routes/auth');
const userRoutes     = require('./routes/users');
const leadRoutes     = require('./routes/leads');
const generateRoutes = require('./routes/generate');
const wikiRoutes     = require('./routes/wiki');
const chatRoutes     = require('./routes/chat');
const callRoutes     = require('./routes/calls');
const feedbackRoutes  = require('./routes/feedback');
const settingsRoutes       = require('./routes/settings');
const emailTemplateRoutes  = require('./routes/emailtemplates');
const toolRoutes           = require('./routes/tools');
const emailRoutes          = require('./routes/emails');
const voiceRoutes          = require('./routes/voice');
const dealRoutes           = require('./routes/deals');
const callListRoutes       = require('./routes/calllists');
const todayRoutes          = require('./routes/today');
const termineRoutes        = require('./routes/termine');
const zieleRoutes          = require('./routes/ziele');
const bedarfRoutes         = require('./routes/bedarf');
const auswertungRoutes     = require('./routes/auswertung');
const { startReminderCron } = require('./cron/reminders');
const { pollIncomingEmails } = require('./cron/emailPoller');
const cron           = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      // Die Oberfläche nutzt onclick="…" an Buttons. Helmet setzt sonst standardmäßig
      // script-src-attr 'none' — dann reagiert kein Button (auch nicht „Anmelden“).
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc:      ["'self'", "data:", "blob:"],
      // Twilio Voice SDK: Signalisierung (WebSocket) + Telemetrie + Klingeltöne
      connectSrc:  ["'self'", "wss://*.twilio.com", "https://*.twilio.com"],
      mediaSrc:    ["'self'", "blob:", "https://sdk.twilio.com"],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
      // Abrechnung wird im Admin-Bereich als eingebettete Seite angezeigt
      frameAncestors: ["'self'"],
    }
  }
}));
app.use(compression());
app.use(cors({
  origin: process.env.BASE_URL || (process.env.NODE_ENV !== 'production' ? true : false),
  methods: ['GET','POST','PATCH','DELETE','PUT','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.set('trust proxy', 1);
// JSON-Body: Standard 100 KB. Die Abrechnung (Logos, PDF-Anhänge, Wiederherstellung)
// parst größere Bodies selbst – erst nach der Admin-Prüfung, siehe abrechnung/crm.js
const jsonStandard = express.json();
app.use((req, res, next) => req.path.startsWith('/api/abrechnung/') ? next() : jsonStandard(req, res, next));

// Rate limiting
app.use('/api/auth/login',    rateLimit({ windowMs: 15*60*1000, max: 20 }));
app.use('/api/auth/setup',    rateLimit({ windowMs: 15*60*1000, max: 5 }));
app.use('/api/auth/password', rateLimit({ windowMs: 15*60*1000, max: 10 }));
app.use('/api/generate',      rateLimit({ windowMs: 60*1000, max: 5 }));

// ── Saubere Adressen: /login, /admin, /closer, /setup (ohne .html) ──
const PAGES = ['login', 'admin', 'closer', 'setup'];
app.get(/^\/(login|admin|closer|setup)\.html$/, (req, res) => {
  const q = req.originalUrl.indexOf('?');
  res.redirect(301, '/' + req.params[0] + (q >= 0 ? req.originalUrl.slice(q) : ''));
});
app.get(['/', ...PAGES.map(p => '/' + p)], (req, res) => {
  const page = req.path === '/' ? 'login' : req.path.slice(1);
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public_html', page + '.html'));
});

// ── Static Frontend ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public_html'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      // Mit Cache-Tag (?v=nfXX) ändert sich die Adresse bei jeder neuen Version → darf im Browser bleiben.
      // Spart beim Neuladen ~25 Rückfragen an den Server (vor allem am Handy spürbar).
      const versioniert = !filePath.endsWith('.html') && /[?&]v=/.test(res.req?.originalUrl || '');
      res.set('Cache-Control', versioniert ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate');
    }
  },
}));


// Twilio Voice SDK aus node_modules ausliefern (kein externes CDN nötig)
app.use('/vendor/twilio-voice', express.static(
  path.join(__dirname, 'node_modules/@twilio/voice-sdk/dist'),
  { maxAge: '7d' }
));

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/leads',    leadRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/wiki',     wikiRoutes);
app.use('/api/chats',    chatRoutes);
app.use('/api/calls',    callRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/settings',        settingsRoutes);
app.use('/api/sicherung',       require('./routes/sicherung'));
app.use('/api/email-templates', emailTemplateRoutes);
app.use('/api/tools',           toolRoutes);
app.use('/api/emails',          emailRoutes);
app.use('/api/voice',           voiceRoutes);
app.use('/api/sipgate',         require('./routes/sipgate'));
app.use('/api/deals',           dealRoutes);
app.use('/api/call-lists',      callListRoutes);
app.use('/api/today',           todayRoutes);
app.use('/api/termine',        termineRoutes);
app.use('/api/ziele',          zieleRoutes);
app.use('/api/bedarf',         bedarfRoutes);
app.use('/api/auswertung',     auswertungRoutes);
// Eigene Schnittstelle des CRM (API-Schlüssel) und deren Verwaltung
const apiV1 = require('./routes/api-v1');
app.use('/api/api-keys',        apiV1.keys);
app.use('/api/startklar',       require('./routes/startklar'));
app.use('/api/v1',              rateLimit({ windowMs: 60*1000, max: 300 }), apiV1.v1);

// ── Abrechnung (Angebote, Rechnungen, Abos – nur Admin) ───────
const abrechnung = require('./abrechnung/crm').registriere(app, {
  ki: process.env.CLAUDE_API_KEY
    ? { client: new (require('@anthropic-ai/sdk'))({ apiKey: process.env.CLAUDE_API_KEY }), model: 'claude-haiku-4-5', limit: 0 }
    : null,
});
const provisionRoutes = require('./routes/provision');
provisionRoutes.verbinde(abrechnung.crm);
app.use('/api/provision', provisionRoutes);
const faelligRoutes = require('./routes/faellig');
faelligRoutes.verbinde(abrechnung.crm);
app.use('/api/faellig', faelligRoutes);
// Handy-Benachrichtigungen (Web Push) und Test-Mail
app.use('/api/push', require('./routes/push'));

// ── Gesundheits-Check ─────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await require('./db').query('SELECT 1');
    res.json({ ok: true, abrechnung: abrechnung.status.aktiv });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'Datenbank nicht erreichbar' });
  }
});

// ── SPA Fallback ──────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  // Fehlende Dateien (Bilder, Skripte …) nicht auf die Login-Seite umleiten
  if (/\.[a-z0-9]+$/i.test(req.path)) return res.status(404).end();
  res.redirect(302, '/login');
});

// ── Auto-Migration ────────────────────────────────────────────
const db = require('./db');
// Migrationen strikt nacheinander ausführen: parallel abgefeuerte ALTER TABLEs auf
// dieselbe Tabelle blockieren sich gegenseitig, und weil Fehler bewusst ignoriert
// werden ("Spalte existiert schon"), fehlten danach still einzelne Spalten.
let _migChain = Promise.resolve();
function migrate(sql, params) {
  const p = _migChain.then(() => db.query(sql, params));
  _migChain = p.catch(() => {});
  return p;
}
migrate("ALTER TABLE users MODIFY COLUMN email VARCHAR(150) NULL")
  .then(() => console.log('Migration: email nullable'))
  .catch(() => {});

migrate(`CREATE TABLE IF NOT EXISTS wiki_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mimetype VARCHAR(100),
  size INT,
  uploaded_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});
// Kurzbeschreibung je Unterlage (wurde bisher nur in der Route benutzt, nie angelegt)
migrate('ALTER TABLE wiki_files ADD COLUMN note TEXT NULL').catch(() => {});

migrate(`CREATE TABLE IF NOT EXISTS email_template (
  id INT PRIMARY KEY,
  subject VARCHAR(500),
  body TEXT,
  updated_by INT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`).catch(() => {});

// ── Neue DB-Migrationen ───────────────────────────────────────
migrate('ALTER TABLE comments ADD COLUMN edited_at DATETIME NULL').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN notify_email TINYINT(1) NOT NULL DEFAULT 1').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN notify_sms   TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN phone        VARCHAR(50) NULL').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN onboarding_shown TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});

migrate(`CREATE TABLE IF NOT EXISTS chat_rooms (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  created_by INT NOT NULL,
  is_closed TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

migrate(`CREATE TABLE IF NOT EXISTS chat_participants (
  chat_id INT NOT NULL,
  user_id INT NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, user_id)
)`).catch(() => {});

migrate(`CREATE TABLE IF NOT EXISTS chat_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  chat_id INT NOT NULL,
  user_id INT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

migrate('ALTER TABLE chat_rooms ADD COLUMN lead_id INT NULL').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN can_edit_contacts  TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN can_archive_leads  TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN can_reassign_leads TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN can_view_all_leads TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN can_create_users   TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN can_generate_leads TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});

migrate(`CREATE TABLE IF NOT EXISTS feedback (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  title       VARCHAR(300) NOT NULL,
  description TEXT NULL,
  type        ENUM('bug','wunsch') DEFAULT 'wunsch',
  tag         ENUM('offen','in_planung','erledigt','nicht_moeglich') DEFAULT 'offen',
  admin_note  TEXT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

// ── Call Logs ─────────────────────────────────────────────────
migrate(`CREATE TABLE IF NOT EXISTS call_logs (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  lead_id          INT NOT NULL,
  user_id          INT NOT NULL,
  phone_number     VARCHAR(50),
  direction        ENUM('outbound','inbound') DEFAULT 'outbound',
  started_at       DATETIME,
  ended_at         DATETIME NULL,
  duration_seconds INT NULL,
  status           ENUM('started','reached','no-answer','busy','failed','wrong_number','completed','manual') DEFAULT 'started',
  note             TEXT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});
// ENUM erweitern — enthält alte Werte (completed, manual) für Rückwärtskompatibilität
// Bestehende Zeilen bleiben erhalten; neue Einträge nutzen die neuen Werte
migrate(`ALTER TABLE call_logs MODIFY COLUMN status ENUM('started','reached','no-answer','busy','failed','wrong_number','completed','manual') DEFAULT 'started'`).catch(() => {});

// ── Index-Migrationen (idempotent — Fehler = Index existiert bereits) ────────
migrate('CREATE INDEX idx_leads_status     ON leads (status)').catch(() => {});
migrate('CREATE INDEX idx_leads_created_at ON leads (created_at)').catch(() => {});
migrate('CREATE INDEX idx_leads_updated_at ON leads (updated_at)').catch(() => {});
migrate('CREATE INDEX idx_rem_user_sent_time ON reminders (user_id, sent, remind_at)').catch(() => {});
migrate('CREATE INDEX idx_activity_created_at ON activity_log (created_at)').catch(() => {});
migrate('CREATE INDEX idx_leads_assigned_status ON leads (assigned_to, status)').catch(() => {});
migrate('CREATE INDEX idx_leads_status_created  ON leads (status, created_at)').catch(() => {});

// ── E-Mail-Vorlagen-Tabelle + Seed ───────────────────────────
migrate(`CREATE TABLE IF NOT EXISTS email_templates (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  subject    VARCHAR(500) NOT NULL,
  body       TEXT NOT NULL,
  category   VARCHAR(100) NULL,
  is_active  TINYINT(1)  NOT NULL DEFAULT 1,
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`).then(() => {
  migrate('SELECT COUNT(*) AS cnt FROM email_templates').then(([[{ cnt }]]) => {
    if (cnt > 0) return;
    const seeds = [
      ['Allgemeine Informationen', 'Weitere Informationen zu {{firma}}',
       'Hallo {{kunde}},\n\nwie besprochen sende ich Ihnen hier die wichtigsten Informationen.\n\nWenn Sie Fragen haben oder etwas unklar ist, können wir das gerne kurz telefonisch besprechen.\n\nViele Grüße\n{{closer}}',
       'Allgemein'],
      ['Interesse vorhanden', 'Nächster Schritt für {{firma}}',
       'Hallo {{kunde}},\n\nvielen Dank für das Gespräch. Da grundsätzlich Interesse besteht, würde ich als nächsten Schritt gerne kurz abstimmen, welche Lösung für {{firma}} am sinnvollsten ist.\n\nWann passt es Ihnen für eine kurze Rücksprache?\n\nViele Grüße\n{{closer}}',
       'Vertrieb'],
      ['Nachfassen', 'Kurze Rückfrage zu unserem Gespräch',
       'Hallo {{kunde}},\n\nich wollte kurz nachfragen, ob Sie sich die Informationen bereits anschauen konnten.\n\nGerne können wir die offenen Punkte kurz telefonisch klären.\n\nViele Grüße\n{{closer}}',
       'Nachfassen'],
      ['Termin bestätigen', 'Bestätigung unseres Termins',
       'Hallo {{kunde}},\n\nhiermit bestätige ich unseren Termin.\n\nFalls sich bei Ihnen etwas ändert, geben Sie mir bitte kurz Bescheid.\n\nViele Grüße\n{{closer}}',
       'Termin'],
      ['Mehr Infos senden', 'Weitere Details für {{firma}}',
       'Hallo {{kunde}},\n\ngerne sende ich Ihnen weitere Informationen zu den besprochenen Punkten.\n\nWenn Sie möchten, können wir danach kurz telefonieren und prüfen, was für {{firma}} konkret sinnvoll ist.\n\nViele Grüße\n{{closer}}',
       'Info'],
      ['Keine Antwort', 'Kurze Erinnerung',
       'Hallo {{kunde}},\n\nich wollte mich kurz in Erinnerung bringen, da ich bisher keine Rückmeldung erhalten habe.\n\nBesteht das Thema für {{firma}} aktuell noch?\n\nViele Grüße\n{{closer}}',
       'Nachfassen'],
    ];
    Promise.all(seeds.map(([name, subject, body, category]) =>
      migrate('INSERT INTO email_templates (name, subject, body, category) VALUES (?,?,?,?)',
        [name, subject, body, category])
    )).catch(() => {});
  }).catch(() => {});
}).catch(() => {});

// ── E-Mail-Eingang-Tabelle ────────────────────────────────────
migrate(`CREATE TABLE IF NOT EXISTS lead_emails (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  lead_id      INT NOT NULL,
  direction    ENUM('inbound','outbound') DEFAULT 'inbound',
  from_address VARCHAR(255),
  to_address   VARCHAR(255),
  subject      VARCHAR(500),
  body_text    TEXT,
  message_id   VARCHAR(500),
  received_at  DATETIME,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_message_id (message_id(250))
)`).catch(() => {});

// ── Unzugeordnete eingehende E-Mails ─────────────────────────
migrate(`CREATE TABLE IF NOT EXISTS unmatched_emails (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  from_address VARCHAR(255),
  to_address   VARCHAR(255),
  subject      VARCHAR(500),
  body_text    TEXT,
  message_id   VARCHAR(500),
  received_at  DATETIME,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_unmatched_mid (message_id(250))
)`).catch(() => {});

// ── Posteingang + Telefonie ──────────────────────────────────
// is_read: Default 1, damit bestehende Mails nicht plötzlich als ungelesen erscheinen
migrate('ALTER TABLE lead_emails ADD COLUMN is_read TINYINT(1) NOT NULL DEFAULT 1').catch(() => {});
migrate('ALTER TABLE lead_emails ADD COLUMN from_name VARCHAR(255) NULL').catch(() => {});
migrate('ALTER TABLE lead_emails ADD COLUMN user_id INT NULL').catch(() => {});
migrate('ALTER TABLE lead_emails MODIFY COLUMN body_text MEDIUMTEXT').catch(() => {});
migrate('CREATE INDEX idx_lead_emails_lead ON lead_emails (lead_id)').catch(() => {});
migrate('CREATE INDEX idx_lead_emails_inbox ON lead_emails (direction, is_read)').catch(() => {});
migrate('ALTER TABLE unmatched_emails ADD COLUMN from_name VARCHAR(255) NULL').catch(() => {});
migrate('ALTER TABLE unmatched_emails MODIFY COLUMN body_text MEDIUMTEXT').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN caller_id VARCHAR(30) NULL').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN caller_id_verified TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
migrate('ALTER TABLE call_logs ADD COLUMN twilio_call_sid VARCHAR(64) NULL').catch(() => {});

// ── Settings-Tabelle ─────────────────────────────────────────
migrate(`CREATE TABLE IF NOT EXISTS app_settings (
  key_name VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL
)`).catch(() => {});
migrate("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('closer_sees_admins','false')").catch(() => {});
migrate("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('closer_sees_tool','false')").catch(() => {});
migrate("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('maintenance_mode','false')").catch(() => {});
migrate("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('maintenance_until','')").catch(() => {});

migrate(`CREATE TABLE IF NOT EXISTS tools (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  url            VARCHAR(500) NOT NULL,
  closer_visible TINYINT(1)  NOT NULL DEFAULT 0,
  sort_order     INT         NOT NULL DEFAULT 0,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).then(() => {
  migrate('SELECT COUNT(*) AS cnt FROM tools').then(([[{ cnt }]]) => {
    if (cnt === 0) {
      migrate("INSERT INTO tools (name, url, closer_visible) VALUES ('Angebots-Tool', 'https://tool.novaflowservices.de', 0)").catch(() => {});
    }
  }).catch(() => {});
}).catch(() => {});
migrate("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('call_script','')").catch(() => {});
migrate("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('daily_call_goal','50')").catch(() => {});

// ── Audit-Migrationen ─────────────────────────────────────────
migrate('ALTER TABLE users ADD COLUMN created_by INT NULL').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN can_manage_email_templates TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
// Angebote & Rechnungen für Closer freischalten (Standard: aus, nur Admins)
migrate('ALTER TABLE users ADD COLUMN can_abrechnung TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
// Hell/Dunkel je Benutzer (gilt auf allen Geräten, bis der Benutzer es ändert)
migrate("ALTER TABLE users ADD COLUMN theme VARCHAR(10) NULL").catch(() => {});
// Eigene Telefonnummer je Mitarbeiter (vom Admin aus dem Twilio-Konto zugeteilt)
migrate('ALTER TABLE users ADD COLUMN phone_line VARCHAR(30) NULL').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN phone_line_sid VARCHAR(40) NULL').catch(() => {});
// Zusammengeführte Dubletten – genug, um es rückgängig zu machen
migrate(`CREATE TABLE IF NOT EXISTS lead_merges (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  target_id  INT NOT NULL,
  from_id    INT NOT NULL,
  moved      MEDIUMTEXT NOT NULL,
  filled     TEXT NOT NULL,
  merged_by  INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  undone_at  DATETIME NULL,
  undone_by  INT NULL,
  INDEX (target_id)
)`).catch(() => {});
// API-Schlüssel für die eigene Schnittstelle (/api/v1); gespeichert wird nur der SHA-256-Hash
migrate(`CREATE TABLE IF NOT EXISTS api_keys (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  prefix       VARCHAR(12) NOT NULL,
  key_hash     CHAR(64) NOT NULL UNIQUE,
  created_by   INT NOT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL,
  revoked_at   DATETIME NULL
)`).catch(() => {});
// Zugangsdaten für Anbieter (Twilio …) – getrennt von app_settings, die alle Benutzer lesen dürfen
migrate(`CREATE TABLE IF NOT EXISTS integrations (
  name       VARCHAR(40) PRIMARY KEY,
  config     TEXT NOT NULL,
  updated_by INT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`).then(() => Promise.all([require('./routes/voice').ladeKonfiguration(), require('./routes/sipgate').ladeKonfiguration()])).catch(() => {});
// Telefonie über sipgate: Zuordnung CRM-Benutzer → sipgate-Zugang/Gerät/Nummer, Anruf-Kennung
migrate('ALTER TABLE users ADD COLUMN sipgate_user VARCHAR(20) NULL').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN sipgate_device VARCHAR(20) NULL').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN sipgate_nummer VARCHAR(30) NULL').catch(() => {});
// Closer ohne eigenen sipgate-Zugang: Anruf über den Hauptzugang, zuerst klingelt dieses Handy – Rollback: db/rollback/2026-10-27_sipgate-handy.sql
migrate('ALTER TABLE users ADD COLUMN sipgate_handy VARCHAR(30) NULL').catch(() => {});
migrate('ALTER TABLE call_logs ADD COLUMN sipgate_call_id VARCHAR(64) NULL').catch(() => {});
// Nummern-Pool: Ablaufdatum, Bezeichnung, eigene Nummern – Rollback: db/rollback/2026-10-27_nummern-pool.sql
migrate(`CREATE TABLE IF NOT EXISTS telefonnummern (
  nummer VARCHAR(30) NOT NULL PRIMARY KEY,
  bezeichnung VARCHAR(100) NULL,
  gueltig_bis DATE NULL,
  notiz VARCHAR(255) NULL,
  manuell TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch(e => console.error('Migration telefonnummern:', e.message));
migrate('ALTER TABLE call_logs ADD COLUMN answered_at DATETIME NULL').catch(() => {});
migrate('CREATE INDEX idx_call_logs_sipgate ON call_logs (sipgate_call_id)').catch(() => {});
migrate('ALTER TABLE leads ADD COLUMN archived_at DATETIME NULL').catch(() => {});
migrate('ALTER TABLE leads ADD COLUMN archived_by INT NULL').catch(() => {});
migrate('ALTER TABLE leads ADD COLUMN archive_reason VARCHAR(500) NULL').catch(() => {});
migrate('CREATE INDEX idx_leads_archived ON leads (archived_at)').catch(() => {});
migrate('ALTER TABLE leads ADD FULLTEXT INDEX ft_leads_search (company, ceo, location)').catch(() => {});

// ── Reminder: "erledigt" getrennt von "Benachrichtigung verschickt" ──
// Bisher verschwanden fällige Reminder aus allen Listen, sobald die Erinnerungsmail raus war.
// Beim ersten Start: alte, längst verschickte Reminder als erledigt markieren, die der
// letzten 7 Tage bleiben offen (tauchen als überfällig auf, statt verloren zu sein).
migrate('ALTER TABLE reminders ADD COLUMN done_at DATETIME NULL')
  .then(() => migrate(
    'UPDATE reminders SET done_at = remind_at WHERE sent = 1 AND remind_at < DATE_SUB(NOW(), INTERVAL 7 DAY)'
  ))
  .then(() => console.log('Migration: reminders.done_at'))
  .catch(() => {});
migrate('CREATE INDEX idx_rem_lead_done ON reminders (lead_id, done_at)').catch(() => {});
migrate('CREATE INDEX idx_rem_user_done ON reminders (user_id, done_at, remind_at)').catch(() => {});
migrate('CREATE INDEX idx_call_logs_lead ON call_logs (lead_id, started_at)').catch(() => {});
migrate('CREATE INDEX idx_call_logs_user ON call_logs (user_id, started_at)').catch(() => {});

// ── Einmalig: Mails aufräumen, die nach der alten Logik im CRM gelandet sind ──
// Ins CRM gehören nur Antworten auf Mails aus dem CRM. Entfernt werden
//  - alle Kopien „unzugeordneter“ Mails (die Originale bleiben im Postfach)
//  - eingehende Mails an Leads, denen vorher nie eine CRM-Mail geschickt wurde
//    (können keine Antwort sein, wurden früher nur über die Absenderadresse zugeordnet)
migrate("SELECT value FROM app_settings WHERE key_name='cleanup_mails_v1'").then(async ([rows]) => {
  if (rows.length) return;
  const [u] = await migrate('DELETE FROM unmatched_emails');
  const [l] = await migrate(
    `DELETE le FROM lead_emails le
     WHERE le.direction = 'inbound' AND NOT EXISTS (
       SELECT 1 FROM (SELECT lead_id, MIN(COALESCE(received_at, created_at)) AS first_out
                      FROM lead_emails WHERE direction = 'outbound' GROUP BY lead_id) o
       WHERE o.lead_id = le.lead_id AND o.first_out <= COALESCE(le.received_at, le.created_at))`);
  await migrate("INSERT INTO app_settings (key_name, value) VALUES ('cleanup_mails_v1', ?)",
    [JSON.stringify({ at: new Date().toISOString(), unmatched: u.affectedRows, lead_emails: l.affectedRows })]);
  console.log(`Mail-Aufräumen: ${u.affectedRows} unzugeordnete, ${l.affectedRows} fremde Lead-Mails entfernt`);
}).catch(e => console.error('Mail-Aufräumen fehlgeschlagen:', e.message));

// ── Dubletten-Erkennung: normalisierte Kontaktdaten je Lead ──
migrate('ALTER TABLE leads ADD COLUMN phone_norm VARCHAR(20) NULL').catch(() => {});
migrate('ALTER TABLE leads ADD COLUMN email_norm VARCHAR(150) NULL').catch(() => {});
migrate('ALTER TABLE leads ADD COLUMN domain_norm VARCHAR(150) NULL').catch(() => {});
migrate('ALTER TABLE leads ADD COLUMN norm_v TINYINT NULL').catch(() => {});
migrate('CREATE INDEX idx_leads_phone_norm ON leads (phone_norm)').catch(() => {});
migrate('CREATE INDEX idx_leads_email_norm ON leads (email_norm)').catch(() => {});
migrate('CREATE INDEX idx_leads_domain_norm ON leads (domain_norm)').catch(() => {});
migrate('CREATE INDEX idx_leads_norm_v ON leads (norm_v)').catch(() => {});

// ── Wähllisten (gespeicherte Filter für den Anrufmodus) ──
migrate(`CREATE TABLE IF NOT EXISTS call_lists (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  name       VARCHAR(100) NOT NULL,
  filters    TEXT NOT NULL,
  shared     TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_call_lists_user (user_id)
)`).catch(() => {});
// Art der Wiedervorlage, z.B. 'missed_call' für verpasste eingehende Anrufe
migrate('ALTER TABLE reminders ADD COLUMN kind VARCHAR(20) NULL').catch(() => {});

// ── Deals (Pipedrive-Prinzip: Pipeline-Phasen + Deals mit Wert) ──
migrate(`CREATE TABLE IF NOT EXISTS deal_stages (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  probability TINYINT UNSIGNED NOT NULL DEFAULT 0,
  rot_days    SMALLINT UNSIGNED NOT NULL DEFAULT 14,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).then(() => migrate('SELECT COUNT(*) AS cnt FROM deal_stages')).then(([[{ cnt }]]) => {
  if (cnt > 0) return;
  // Standard-Pipeline, im CRM unter Deals → „Phasen bearbeiten“ anpassbar
  const stages = [
    ['Qualifiziert', 10, 1], ['Termin vereinbart', 30, 2], ['Angebot anfordern', 45, 3], ['Angebot gesendet', 60, 4], ['Verhandlung', 80, 5],
  ];
  return Promise.all(stages.map(([name, prob, sort]) =>
    migrate('INSERT INTO deal_stages (name, probability, sort_order) VALUES (?,?,?)', [name, prob, sort])));
}).catch(() => {});
// Bestehende Pipelines bekommen einmalig die Phase „Angebot anfordern“ vor „Angebot gesendet“:
// Der Closer übergibt dort die Infos, der Admin schreibt und versendet das Angebot.
migrate("SELECT value FROM app_settings WHERE key_name='stage_angebot_anfordern'").then(async ([[done]]) => {
  if (done) return;
  const [stages] = await migrate('SELECT id, name, sort_order FROM deal_stages ORDER BY sort_order');
  if (!stages.length) return;   // frische Datenbank: Standard-Phasen enthalten sie schon
  if (!stages.some(s => /anfordern|anfrage/i.test(s.name))) {
    const gesendet = stages.find(s => /^angebot/i.test(s.name));
    const sort = gesendet ? gesendet.sort_order : stages[stages.length - 1].sort_order + 1;
    await migrate('UPDATE deal_stages SET sort_order = sort_order + 1 WHERE sort_order >= ?', [sort]);
    await migrate('INSERT INTO deal_stages (name, probability, sort_order) VALUES (?,?,?)', ['Angebot anfordern', 45, sort]);
  }
  await migrate("INSERT INTO app_settings (key_name, value) VALUES ('stage_angebot_anfordern', '1') ON DUPLICATE KEY UPDATE value='1'");
}).catch(e => console.error('Migration Phase Angebot anfordern:', e.message));
migrate(`CREATE TABLE IF NOT EXISTS deals (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  lead_id             INT NOT NULL,
  title               VARCHAR(200) NOT NULL,
  value               DECIMAL(12,2) NOT NULL DEFAULT 0,
  stage_id            INT NULL,
  status              ENUM('open','won','lost') NOT NULL DEFAULT 'open',
  owner_id            INT NULL,
  expected_close_date DATE NULL,
  won_at              DATETIME NULL,
  lost_at             DATETIME NULL,
  lost_reason         VARCHAR(300) NULL,
  notes               TEXT NULL,
  stage_changed_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by          INT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  INDEX idx_deals_status_stage (status, stage_id),
  INDEX idx_deals_owner_status (owner_id, status),
  INDEX idx_deals_lead (lead_id),
  INDEX idx_deals_won (status, won_at)
)`).catch(() => {});

// ── Passende Mail nach dem Gespräch ──────────────────────────
// Eine Vorlage kann einem Anrufergebnis zugeordnet werden; das CRM schlägt sie
// dann nach dem Gespräch vor. Das Ergebnis selbst steht am Anruf.
migrate('ALTER TABLE email_templates ADD COLUMN trigger_outcome VARCHAR(30) NULL').catch(() => {});
migrate('ALTER TABLE call_logs ADD COLUMN outcome VARCHAR(30) NULL').catch(() => {});
// Drei fertige Vorlagen, einmalig (wer sie löscht, bekommt sie nicht wieder)
migrate("SELECT value FROM app_settings WHERE key_name='mail_vorschlaege_v1'").then(async ([[done]]) => {
  if (done) return;
  const vorlagen = [
    ['interesse', 'Infos nach dem Telefonat', 'Unser Telefonat – Informationen für {{firma}}',
     'Guten Tag {{kunde}},\n\nvielen Dank für das nette Gespräch eben. Wie besprochen schicke ich Ihnen hier die wichtigsten Informationen.\n\nIm nächsten Schritt erstelle ich Ihnen gerne ein unverbindliches Angebot, das genau zu {{firma}} passt. Bei Fragen antworten Sie einfach auf diese E-Mail.\n\nViele Grüße\n{{closer}}'],
    ['rueckruf', 'Rückruf wie besprochen', 'Unser Rückruf am {{termin}}',
     'Guten Tag {{kunde}},\n\nvielen Dank für Ihre Zeit am Telefon. Wie besprochen rufe ich Sie am {{termin}} noch einmal an.\n\nFalls Ihnen der Zeitpunkt doch nicht passt, antworten Sie einfach kurz auf diese E-Mail, dann finden wir einen anderen.\n\nViele Grüße\n{{closer}}'],
    ['termin', 'Terminbestätigung', 'Terminbestätigung: {{termin}}',
     'Guten Tag {{kunde}},\n\nhiermit bestätige ich unseren Termin am {{termin}}.\n\nIch freue mich auf das Gespräch. Sollte etwas dazwischenkommen, geben Sie mir bitte kurz Bescheid.\n\nViele Grüße\n{{closer}}'],
  ];
  for (const [outcome, name, subject, body] of vorlagen) {
    const [[belegt]] = await migrate('SELECT id FROM email_templates WHERE trigger_outcome=? LIMIT 1', [outcome]);
    if (belegt) continue;
    const [[gleich]] = await migrate('SELECT id FROM email_templates WHERE name=? LIMIT 1', [name]);
    if (gleich) await migrate('UPDATE email_templates SET trigger_outcome=? WHERE id=?', [outcome, gleich.id]);
    else await migrate('INSERT INTO email_templates (name, subject, body, category, trigger_outcome) VALUES (?,?,?,?,?)',
      [name, subject, body, 'Nach dem Gespräch', outcome]);
  }
  await migrate("INSERT INTO app_settings (key_name, value) VALUES ('mail_vorschlaege_v1', '1') ON DUPLICATE KEY UPDATE value='1'");
}).catch(e => console.error('Mail-Vorschläge:', e.message));

// ── Termine (Übergabe an Closer, Terminübersicht) ────────────
migrate(`CREATE TABLE IF NOT EXISTS appointments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  lead_id       INT NOT NULL,
  closer_id     INT NOT NULL,
  proposed_by   INT NULL,
  starts_at     DATETIME NOT NULL,
  duration_min  INT NOT NULL DEFAULT 30,
  topic         VARCHAR(200) NULL,
  notes         TEXT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'vorgeschlagen',
  counter_at    DATETIME NULL,
  response_note VARCHAR(1000) NULL,
  responded_at  DATETIME NULL,
  erinnert      TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  INDEX idx_appt_closer_start (closer_id, starts_at),
  INDEX idx_appt_status (status, starts_at),
  INDEX idx_appt_lead (lead_id)
)`).catch(() => {});
migrate('ALTER TABLE reminders ADD COLUMN appointment_id INT NULL').catch(() => {});
cron.schedule('* * * * *', () => termineRoutes.erinnern());

// ── Ziele pro Closer (leer = Standard aus den Einstellungen) ──
migrate("ALTER TABLE users ADD COLUMN goal_period VARCHAR(10) NULL").catch(() => {});
migrate('ALTER TABLE users ADD COLUMN goal_calls INT NULL').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN goal_talks INT NULL').catch(() => {});
migrate('ALTER TABLE users ADD COLUMN goal_results INT NULL').catch(() => {});
migrate("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('ziel_gespraeche','10')").catch(() => {});
migrate("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('ziel_ergebnisse','2')").catch(() => {});

// Alte Admin-Adresse ad@ gibt es nicht mehr: einmalig auf info@ umstellen
migrate("SELECT value FROM app_settings WHERE key_name='admin_mail_info_v1'").then(async ([[done]]) => {
  if (done) return;
  const [[frei]] = await migrate("SELECT COUNT(*) AS n FROM users WHERE email='info@novaflowservices.de'");
  if (!frei.n) await migrate("UPDATE users SET email='info@novaflowservices.de' WHERE email='ad@novaflowservices.de'");
  await migrate("INSERT INTO app_settings (key_name, value) VALUES ('admin_mail_info_v1', '1') ON DUPLICATE KEY UPDATE value='1'");
}).catch(e => console.error('Admin-Mail:', e.message));

// ── Bedarfsanalyse (nur ergänzend; Rückweg: db/rollback/2026-10-27_bedarfsanalyse.sql) ──
migrate(`CREATE TABLE IF NOT EXISTS bedarfsanalysen (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  lead_id         INT NOT NULL,
  deal_id         INT NULL,
  data            LONGTEXT NOT NULL,
  angebotsreif    TINYINT(1) NOT NULL DEFAULT 0,
  fragen_ok       TINYINT NOT NULL DEFAULT 0,
  paket_vorschlag VARCHAR(20) NULL,
  angefordert_am  DATETIME NULL,
  angefordert_von INT NULL,
  created_by      INT NULL,
  updated_by      INT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bedarf_lead (lead_id),
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
)`).catch(() => {});
migrate(`CREATE TABLE IF NOT EXISTS bedarfsanalyse_snapshots (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  analyse_id INT NOT NULL,
  lead_id    INT NOT NULL,
  deal_id    INT NULL,
  anlass     VARCHAR(30) NOT NULL,
  data       LONGTEXT NOT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bsnap_lead (lead_id)
)`).catch(() => {});
// Schriftgröße je Nutzer (A+/A−), 100 = normal (Rückweg: db/rollback/2026-10-30_ansicht.sql)
migrate('ALTER TABLE users ADD COLUMN ui_schrift SMALLINT NULL').catch(() => {});
// Versionsnummer gegen gegenseitiges Überschreiben (Rückweg: db/rollback/2026-10-30_bedarf-versionen.sql)
migrate('ALTER TABLE bedarfsanalysen ADD COLUMN version INT NOT NULL DEFAULT 0').catch(() => {});
migrate('ALTER TABLE bedarfsanalyse_snapshots ADD INDEX idx_bsnap_analyse (analyse_id, id)').catch(() => {});
for (const col of ['herkunft VARCHAR(30) NULL', 'paket VARCHAR(20) NULL', 'admin_flag VARCHAR(255) NULL',
  'angefordert_at DATETIME NULL', 'angebot_gesendet_at DATETIME NULL', 'hinweis_24h_at DATETIME NULL'])
  migrate(`ALTER TABLE deals ADD COLUMN ${col}`).catch(() => {});
cron.schedule('*/10 * * * *', () => bedarfRoutes.fristen());
// Morgens um 7:41 eine Mail mit allem, was ansteht (nur wenn etwas ansteht, einmal pro Tag)
cron.schedule('41 7 * * *', () => faelligRoutes.morgenMail().catch(e => console.error('Fällig-Mail:', e.message)), { timezone: 'Europe/Berlin' });

// ── Status „passt nicht“/„Keine Anrufe mehr“, Wählliste „nie erreicht“, Übergabe ──
// (nur ergänzend; Rückweg: db/rollback/2026-10-27_status-uebergabe.sql)
migrate("ALTER TABLE leads MODIFY COLUMN status ENUM('neu','kontaktiert','nicht_erreicht','kein_interesse','rueckruf','kunde','passt_nicht','keine_anrufe') NOT NULL DEFAULT 'neu'").catch(e => console.error('Migration Lead-Status:', e.message));
for (const col of ['status_grund VARCHAR(300) NULL', 'nie_erreicht TINYINT(1) NOT NULL DEFAULT 0', 'instagram_url VARCHAR(255) NULL'])
  migrate(`ALTER TABLE leads ADD COLUMN ${col}`).catch(() => {});
for (const col of ["art VARCHAR(20) NOT NULL DEFAULT 'termin'", 'painpoints TEXT NULL', 'versprochen TEXT NULL',
  'offene_fragen VARCHAR(50) NULL', 'uebergabe TINYINT(1) NOT NULL DEFAULT 0', 'vorher_zugewiesen INT NULL'])
  migrate(`ALTER TABLE appointments ADD COLUMN ${col}`).catch(() => {});

// Wissensdatenbank (§5): Artikel (Markdown), Referenzen, „gelesen bis“ je Benutzer
// Rollback: db/rollback/2026-10-27_wissensdatenbank.sql
migrate(`CREATE TABLE IF NOT EXISTS wiki_artikel (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kategorie VARCHAR(100) NOT NULL DEFAULT 'Vertrieb',
  schluessel VARCHAR(80) NULL,
  titel VARCHAR(255) NOT NULL,
  inhalt MEDIUMTEXT NOT NULL,
  sort INT NOT NULL DEFAULT 0,
  updated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wiki_artikel_schluessel (schluessel)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch(e => console.error('Migration wiki_artikel:', e.message));
migrate(`CREATE TABLE IF NOT EXISTS wiki_referenzen (
  id INT AUTO_INCREMENT PRIMARY KEY,
  betrieb VARCHAR(255) NOT NULL,
  branche VARCHAR(120) NULL,
  paket VARCHAR(60) NULL,
  ergebnis TEXT NULL,
  link VARCHAR(500) NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch(e => console.error('Migration wiki_referenzen:', e.message));
migrate('ALTER TABLE users ADD COLUMN wiki_gesehen_at DATETIME NULL').catch(() => {});

// Provision ausgezahlt (je Zahlung des Kunden bzw. je Bonus-Monat) – Rollback: db/rollback/2026-10-27_faellig.sql
migrate(`CREATE TABLE IF NOT EXISTS provision_auszahlungen (
  id INT AUTO_INCREMENT PRIMARY KEY,
  schluessel VARCHAR(120) NOT NULL UNIQUE,
  user_id INT NOT NULL,
  art VARCHAR(20) NOT NULL DEFAULT 'provision',
  betrag DECIMAL(10,2) NOT NULL DEFAULT 0,
  ausgezahlt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  erstellt_von INT NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch(e => console.error('Migration provision_auszahlungen:', e.message));

// Abschlüsse dauerhaft gesichert (Auftragswert, Satz, Provision je gewonnenem Deal) – Rollback: db/rollback/2026-10-27_abschluesse.sql
migrate(`CREATE TABLE IF NOT EXISTS provision_abschluesse (
  deal_id INT NOT NULL PRIMARY KEY,
  user_id INT NULL,
  lead_id INT NULL,
  firma VARCHAR(255) NULL,
  titel VARCHAR(255) NULL,
  paket VARCHAR(20) NULL,
  gewonnen_am DATETIME NULL,
  auftragswert DECIMAL(10,2) NOT NULL DEFAULT 0,
  basis DECIMAL(10,2) NOT NULL DEFAULT 0,
  satz DECIMAL(5,2) NOT NULL DEFAULT 0,
  provision_netto DECIMAL(10,2) NOT NULL DEFAULT 0,
  ust_satz DECIMAL(5,2) NOT NULL DEFAULT 0,
  provision DECIMAL(10,2) NOT NULL DEFAULT 0,
  geschaetzt TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'gewonnen',
  festgeschrieben_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  aktualisiert_am DATETIME NULL,
  INDEX idx_abschluesse_user (user_id, gewonnen_am)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  .then(() => setTimeout(() => provisionRoutes.nachtragen().then(n => { if (n) console.log(`Provision: ${n} Abschlüsse nachgetragen`); }).catch(() => {}), 8000))
  .catch(e => console.error('Migration provision_abschluesse:', e.message));

// Provision (§8): zzgl. USt am Benutzer, Sitz im Ausland (ohne USt) – Rollback: db/rollback/2026-10-27_provision.sql
for (const col of ['provision_zzgl_ust TINYINT(1) NOT NULL DEFAULT 0', 'provision_ausland TINYINT(1) NOT NULL DEFAULT 0'])
  migrate(`ALTER TABLE users ADD COLUMN ${col}`).catch(() => {});

// Mit eigenem Telefon anrufen (solange es keine Firmen-Telefonie gibt) – Rollback: db/rollback/2026-10-27_eigenes-telefon.sql
migrate('ALTER TABLE users ADD COLUMN eigenes_telefon VARCHAR(30) NULL').catch(() => {});

// ── Cron: Activity Log nach 7 Tagen bereinigen ───────────────
cron.schedule('0 3 * * *', async () => {
  try {
    const [r] = await db.query(
      'DELETE FROM activity_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)'
    );
    console.log(`Activity cleanup: ${r.affectedRows} Einträge gelöscht`);
  } catch(e) { console.error('Activity cleanup error:', e.message); }
});

// ── Zeit-Umstellung (28.10.2026) ─────────────────────────────
// Eingetippte Termin- und Wiedervorlage-Zeiten standen bisher in deutscher Zeit in der
// Datenbank, alles andere (NOW()) in UTC – Anzeige und Erinnerungen lagen 1–2 Std. daneben.
// Einmalig nach UTC umrechnen; alte Werte bleiben in zeit_umstellung_alt.
// Rückweg: db/rollback/2026-10-28_zeit-utc.sql
migrate(`CREATE TABLE IF NOT EXISTS zeit_umstellung_alt (
  tabelle VARCHAR(30) NOT NULL, zeile_id INT NOT NULL, spalte VARCHAR(30) NOT NULL, alt DATETIME NULL,
  PRIMARY KEY (tabelle, zeile_id, spalte)) ENGINE=InnoDB`).catch(e => console.error('Migration zeit_umstellung_alt:', e.message));
async function zeitNachUtc() {
  const [[schon]] = await db.query("SELECT 1 AS x FROM app_settings WHERE key_name='zeit_utc_umgestellt'");
  if (schon) return;
  const { ortZuUtc } = require('./helpers/zeit');
  const F = "'%Y-%m-%d %H:%i:%s'";
  const ziele = [
    ['appointments', 'starts_at', `SELECT id, DATE_FORMAT(starts_at, ${F}) AS v FROM appointments`],
    ['appointments', 'counter_at', `SELECT id, DATE_FORMAT(counter_at, ${F}) AS v FROM appointments WHERE counter_at IS NOT NULL`],
    // Nur eingetippte Wiedervorlagen. Automatische (NOW(), Nachfass-Automatik) und die alten
    // Schnell-Knöpfe „Morgen/Übermorgen/In einer Woche“ (jetzt + 20/44/164 Std.) waren schon UTC.
    ['reminders', 'remind_at', `SELECT id, DATE_FORMAT(remind_at, ${F}) AS v FROM reminders
      WHERE (kind IS NULL OR kind IN ('termin','nachfass'))
        AND NOT (kind IS NULL AND note='Rückruf'
                 AND TIMESTAMPDIFF(MINUTE, created_at, remind_at) IN (1198,1199,1200,2638,2639,2640,9838,9839,9840))`],
  ];
  let n = 0;
  for (const [tabelle, spalte, sql] of ziele) {
    const [rows] = await db.query(sql);
    for (const r of rows) {
      const neu = ortZuUtc(r.v);
      if (!neu) continue;
      await db.query('INSERT IGNORE INTO zeit_umstellung_alt (tabelle, zeile_id, spalte, alt) VALUES (?,?,?,?)', [tabelle, r.id, spalte, r.v]);
      await db.query(`UPDATE ${tabelle} SET ${spalte}=? WHERE id=?`, [neu, r.id]);
      n++;
    }
  }
  await db.query("INSERT INTO app_settings (key_name, value) VALUES ('zeit_utc_umgestellt', ?)", [String(n)]);
  console.log(`Zeit-Umstellung: ${n} Termin-/Wiedervorlage-Zeiten nach UTC umgerechnet`);
}
_migChain = _migChain.then(zeitNachUtc).catch(e => console.error('Zeit-Umstellung fehlgeschlagen:', e.message));

// ── Handy-Benachrichtigungen (Web Push) – Rollback: db/rollback/2026-10-28_push.sql ──
migrate(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  endpoint   VARCHAR(600) CHARACTER SET ascii NOT NULL,
  p256dh     VARCHAR(200) NOT NULL,
  auth       VARCHAR(100) NOT NULL,
  geraet     VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_ok_at DATETIME NULL,
  UNIQUE KEY uq_push_endpoint (endpoint),
  INDEX idx_push_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`).catch(e => console.error('Migration push_subscriptions:', e.message));
// Reminder bekommt die Handy-Benachrichtigung nur einmal (unabhängig davon, ob die Mail klappt)
migrate('ALTER TABLE reminders ADD COLUMN push_at DATETIME NULL').catch(() => {});

// Folierer in die Closer-Suche aufnehmen (einmalig; danach entscheidet der Admin unter „Vorgaben für Closer“)
migrate("SELECT value FROM app_settings WHERE key_name='finder_folierung_v1'").then(async ([[done]]) => {
  if (done) return;
  const [[row]] = await db.query("SELECT value FROM app_settings WHERE key_name='finder_vorgaben'");
  let v = null;
  try { v = row ? JSON.parse(row.value) : { branchen: ['Autohäuser', 'Maler', 'Autoaufbereiter', 'Badsanierer', 'Handwerksbetriebe'], groesse: 'small' }; } catch (_) {}
  // Leere Liste = Closer suchen frei → nichts ergänzen
  if (v && Array.isArray(v.branchen) && v.branchen.length && !v.branchen.some(b => /folier/i.test(b))) {
    v.branchen.push('Fahrzeugfolierung');
    await db.query("INSERT INTO app_settings (key_name, value) VALUES ('finder_vorgaben', ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [JSON.stringify(v)]);
    console.log('Closer-Suche: Branche „Fahrzeugfolierung“ ergänzt');
  }
  await db.query("INSERT INTO app_settings (key_name, value) VALUES ('finder_folierung_v1', '1') ON DUPLICATE KEY UPDATE value='1'");
}).catch(e => console.error('Folierung-Vorgabe:', e.message));

// Angeheftete Notizen im Lead (wichtige Infos ganz oben) – Rollback: db/rollback/2026-10-28_notiz-anheften.sql
migrate('ALTER TABLE comments ADD COLUMN pinned_at DATETIME NULL').catch(() => {});
migrate('ALTER TABLE comments ADD COLUMN pinned_by INT NULL').catch(() => {});

// ── Start ─────────────────────────────────────────────────────
// Erst starten, wenn alle Migrationen durch sind (sonst schlagen Logins fehl,
// solange Spalten noch fehlen)
_migChain.then(() => app.listen(PORT, () => {
  console.log(`LeadHunter Pro läuft auf Port ${PORT}`);
  console.log(`Umgebung: ${process.env.NODE_ENV || 'development'}`);
  startReminderCron();
  // Normalisierte Kontaktdaten für vorhandene Leads nachrechnen (läuft im Hintergrund)
  require('./helpers/dedupe').backfillNorm()
    .then(n => { if (n) console.log(`Dubletten-Index: ${n} Leads aufbereitet`); })
    .catch(e => console.error('Dubletten-Index fehlgeschlagen:', e.message));
  // IMAP-Polling alle 2 Minuten
  cron.schedule('*/2 * * * *', pollIncomingEmails);
  // Erster Abruf leicht verzögert, damit die App nach dem Start sofort erreichbar ist
  setTimeout(pollIncomingEmails, 30 * 1000);
}));
