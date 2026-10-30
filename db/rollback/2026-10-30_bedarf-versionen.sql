-- Rückweg für die Versionierung der Bedarfsanalyse (30.10.2026)
-- Die gespeicherten Versionen (Zeilen mit anlass 'autosave', 'speichern', 'stand_vorher',
-- 'wiederherstellung', 'konflikt') bleiben erhalten; sie stören den alten Code nicht.
ALTER TABLE bedarfsanalysen DROP COLUMN version;
ALTER TABLE bedarfsanalyse_snapshots DROP INDEX idx_bsnap_analyse;
