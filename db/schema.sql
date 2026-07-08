-- ============================================================
-- LeadHunter Pro — Datenbank-Schema
-- Ausführen: mysql -u root -p leadhunter < schema.sql
--
-- Dieses Schema spiegelt den tatsächlichen Produktivstand wider,
-- inkl. aller Migrationen, die backend/server.js beim Start
-- idempotent nachzieht (ALTER TABLE ... / CREATE TABLE IF NOT
-- EXISTS ...). Bei Änderungen an server.js bitte auch diese Datei
-- nachziehen, damit ein Frisch-Setup denselben Stand ergibt.
-- ============================================================

CREATE DATABASE IF NOT EXISTS leadhunter CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE leadhunter;

-- ------------------------------------------------------------
-- USERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NULL UNIQUE,
  phone         VARCHAR(50)  NULL,
  role          ENUM('admin','closer') NOT NULL DEFAULT 'closer',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  notify_email  TINYINT(1) NOT NULL DEFAULT 1,
  notify_sms    TINYINT(1) NOT NULL DEFAULT 0,
  onboarding_shown TINYINT(1) NOT NULL DEFAULT 0,
  -- Feingranulare Berechtigungen (zusätzlich zu role)
  can_edit_contacts           TINYINT(1) NOT NULL DEFAULT 0,
  can_archive_leads           TINYINT(1) NOT NULL DEFAULT 0,
  can_reassign_leads          TINYINT(1) NOT NULL DEFAULT 0,
  can_view_all_leads          TINYINT(1) NOT NULL DEFAULT 0,
  can_create_users            TINYINT(1) NOT NULL DEFAULT 0,
  can_generate_leads          TINYINT(1) NOT NULL DEFAULT 0,
  can_manage_email_templates  TINYINT(1) NOT NULL DEFAULT 0,
  created_by    INT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login    DATETIME
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- LEADS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  company       VARCHAR(200),
  ceo           VARCHAR(150),
  email         VARCHAR(150),
  phone         VARCHAR(60),
  location      VARCHAR(150),
  website       VARCHAR(255),
  linkedin_url  VARCHAR(255),
  industry      VARCHAR(100),
  employees     VARCHAR(50),
  revenue       VARCHAR(100),
  source        VARCHAR(50),
  confidence    TINYINT UNSIGNED DEFAULT 50,
  notes         TEXT,
  -- Automatisierte, kostenlose Plausibilitätsprüfung (DNS/Regex) — siehe
  -- backend/helpers/leadVerification.js. NULL = nicht geprüft/nicht feststellbar,
  -- nicht "ungültig". Ersetzt kein manuelles Review, reduziert aber Blindvertrauen
  -- in von der KI selbst geschätzte confidence-Werte.
  email_valid   TINYINT(1) NULL,
  phone_valid   TINYINT(1) NULL,
  domain_valid  TINYINT(1) NULL,
  -- Impressum-Abgleich (backend/helpers/impressumCheck.js): true = Telefon/E-Mail wurde
  -- wortwörtlich auf der Firmen-Website gefunden (belegt die Firma-Kontakt-Zuordnung),
  -- false = Website hat andere Kontaktdaten, keine passt, NULL = nicht feststellbar.
  phone_confirmed TINYINT(1) NULL,
  email_confirmed TINYINT(1) NULL,
  impressum_url   VARCHAR(500) NULL,
  -- Vorwahl-Orts-Check (backend/helpers/areaCodeCheck.js, komplett offline, ohne
  -- Website): true = Vorwahl passt zum Ort, false = Vorwahl gehört nachweislich zu
  -- einer anderen bekannten Stadt, NULL = nicht feststellbar (unbekannter Ort/Vorwahl).
  area_code_valid TINYINT(1) NULL,
  verified_at   DATETIME NULL,
  status        ENUM('neu','kontaktiert','nicht_erreicht','kein_interesse','rueckruf','kunde') NOT NULL DEFAULT 'neu',
  assigned_to   INT,               -- user.id des Closers
  created_by    INT NOT NULL,       -- user.id des Admins
  archived_at   DATETIME NULL,      -- Soft-Delete: NULL = aktiv
  archived_by   INT NULL,
  archive_reason VARCHAR(500) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by)  REFERENCES users(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- COMMENTS (Kommentare + Verlauf pro Lead)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  lead_id    INT NOT NULL,
  user_id    INT NOT NULL,
  text       TEXT NOT NULL,
  edited_at  DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- REMINDERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminders (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  lead_id      INT NOT NULL,
  user_id      INT NOT NULL,
  remind_at    DATETIME NOT NULL,
  note         TEXT,
  sent         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- ACTIVITY LOG (Tracking — nur Admin sichtbar)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  action      VARCHAR(100) NOT NULL,   -- z.B. 'status_change', 'comment_add', 'login'
  target_type VARCHAR(50),             -- 'lead', 'user', 'system'
  target_id   INT,
  detail      TEXT,                    -- JSON-String mit Details
  ip          VARCHAR(45),
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- SESSIONS (Echtzeit-Tracking)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL UNIQUE,
  token         VARCHAR(512) NOT NULL,
  login_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  click_count   INT UNSIGNED NOT NULL DEFAULT 0,
  ip            VARCHAR(45),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- WIKI (Datei-Uploads für die Wissensdatenbank)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wiki_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mimetype VARCHAR(100),
  size INT,
  uploaded_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- E-MAIL-VORLAGE (Legacy-Einzelvorlage, siehe auch email_templates)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_template (
  id INT PRIMARY KEY,
  subject VARCHAR(500),
  body TEXT,
  updated_by INT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- E-MAIL-VORLAGEN (mehrere, kategorisiert, mit Seed-Daten)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_templates (
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
) ENGINE=InnoDB;
-- Seed-Vorlagen werden beim ersten Start automatisch von server.js eingefügt,
-- wenn die Tabelle leer ist (siehe dort für die Texte).

-- ------------------------------------------------------------
-- CHAT (interner Team-Chat, optional pro Lead)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_rooms (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  created_by INT NOT NULL,
  lead_id INT NULL,
  is_closed TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chat_participants (
  chat_id INT NOT NULL,
  user_id INT NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chat_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  chat_id INT NOT NULL,
  user_id INT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- FEEDBACK (Bugs/Wünsche aus der App)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  title       VARCHAR(300) NOT NULL,
  description TEXT NULL,
  type        ENUM('bug','wunsch') DEFAULT 'wunsch',
  tag         ENUM('offen','in_planung','erledigt','nicht_moeglich') DEFAULT 'offen',
  admin_note  TEXT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- CALL LOGS (Anruf-Historie pro Lead)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_logs (
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
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- LEAD-E-MAILS (gesendeter/empfangener Verlauf pro Lead)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_emails (
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
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- UNZUGEORDNETE EINGEHENDE E-MAILS (IMAP-Poller findet keinen Lead)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unmatched_emails (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  from_address VARCHAR(255),
  to_address   VARCHAR(255),
  subject      VARCHAR(500),
  body_text    TEXT,
  message_id   VARCHAR(500),
  received_at  DATETIME,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_unmatched_mid (message_id(250))
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- APP SETTINGS (Key-Value, globale Einstellungen)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key_name VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL
) ENGINE=InnoDB;
INSERT IGNORE INTO app_settings (key_name, value) VALUES ('closer_sees_admins','false');
INSERT IGNORE INTO app_settings (key_name, value) VALUES ('closer_sees_tool','false');
INSERT IGNORE INTO app_settings (key_name, value) VALUES ('maintenance_mode','false');
INSERT IGNORE INTO app_settings (key_name, value) VALUES ('maintenance_until','');
INSERT IGNORE INTO app_settings (key_name, value) VALUES ('call_script','');
INSERT IGNORE INTO app_settings (key_name, value) VALUES ('daily_call_goal','50');

-- ------------------------------------------------------------
-- TOOLS (externe Tool-Links im Dashboard)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tools (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  url            VARCHAR(500) NOT NULL,
  closer_visible TINYINT(1)  NOT NULL DEFAULT 0,
  sort_order     INT         NOT NULL DEFAULT 0,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- INDEXES (Performance bei 10.000+ Leads)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_status          ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_created_at      ON leads (created_at);
CREATE INDEX IF NOT EXISTS idx_leads_updated_at      ON leads (updated_at);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_status ON leads (assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_leads_status_created  ON leads (status, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_archived        ON leads (archived_at);
CREATE INDEX IF NOT EXISTS idx_rem_user_sent_time    ON reminders (user_id, sent, remind_at);
CREATE INDEX IF NOT EXISTS idx_activity_created_at   ON activity_log (created_at);
ALTER TABLE leads ADD FULLTEXT INDEX ft_leads_search (company, ceo, location);

-- ------------------------------------------------------------
-- Standard-Admin anlegen (Passwort wird beim ersten Start gesetzt)
-- ------------------------------------------------------------
-- Admin-Account wird über /api/auth/setup erstellt beim ersten Start
