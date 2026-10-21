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
      frameAncestors: ["'none'"],
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
app.use(express.json());

// Rate limiting
app.use('/api/auth/login',    rateLimit({ windowMs: 15*60*1000, max: 20 }));
app.use('/api/auth/setup',    rateLimit({ windowMs: 15*60*1000, max: 5 }));
app.use('/api/auth/password', rateLimit({ windowMs: 15*60*1000, max: 10 }));
app.use('/api/generate',      rateLimit({ windowMs: 60*1000, max: 5 }));

// ── Static Frontend ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public_html'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.set('Cache-Control', 'no-cache, must-revalidate');
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
app.use('/api/email-templates', emailTemplateRoutes);
app.use('/api/tools',           toolRoutes);
app.use('/api/emails',          emailRoutes);
app.use('/api/voice',           voiceRoutes);
app.use('/api/deals',           dealRoutes);

// ── SPA Fallback ──────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public_html/login.html'), (err) => { if (err) res.status(404).end(); });
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
    ['Qualifiziert', 10, 1], ['Termin vereinbart', 30, 2], ['Angebot gesendet', 60, 3], ['Verhandlung', 80, 4],
  ];
  return Promise.all(stages.map(([name, prob, sort]) =>
    migrate('INSERT INTO deal_stages (name, probability, sort_order) VALUES (?,?,?)', [name, prob, sort])));
}).catch(() => {});
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

// ── Cron: Activity Log nach 7 Tagen bereinigen ───────────────
cron.schedule('0 3 * * *', async () => {
  try {
    const [r] = await db.query(
      'DELETE FROM activity_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)'
    );
    console.log(`Activity cleanup: ${r.affectedRows} Einträge gelöscht`);
  } catch(e) { console.error('Activity cleanup error:', e.message); }
});

// ── Start ─────────────────────────────────────────────────────
// Erst starten, wenn alle Migrationen durch sind (sonst schlagen Logins fehl,
// solange Spalten noch fehlen)
_migChain.then(() => app.listen(PORT, () => {
  console.log(`LeadHunter Pro läuft auf Port ${PORT}`);
  console.log(`Umgebung: ${process.env.NODE_ENV || 'development'}`);
  startReminderCron();
  // IMAP-Polling alle 2 Minuten
  cron.schedule('*/2 * * * *', pollIncomingEmails);
  // Erster Abruf leicht verzögert, damit die App nach dem Start sofort erreichbar ist
  setTimeout(pollIncomingEmails, 30 * 1000);
}));
