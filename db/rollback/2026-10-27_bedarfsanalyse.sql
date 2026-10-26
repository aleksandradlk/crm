-- Rückweg für die Bedarfsanalyse (PR „Bedarfsanalyse, angebotsreif, Angebot anfordern“).
-- Nur ausführen, wenn die Funktion wieder entfernt werden soll – die Daten der
-- Bedarfsanalysen gehen dabei verloren. Vorher eine Sicherung ziehen.
DROP TABLE IF EXISTS bedarfsanalyse_snapshots;
DROP TABLE IF EXISTS bedarfsanalysen;
ALTER TABLE deals
  DROP COLUMN herkunft,
  DROP COLUMN paket,
  DROP COLUMN admin_flag,
  DROP COLUMN angefordert_at,
  DROP COLUMN angebot_gesendet_at,
  DROP COLUMN hinweis_24h_at;
DELETE FROM app_settings WHERE key_name = 'vertrieb_regeln';
