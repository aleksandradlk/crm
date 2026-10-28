-- Rückweg für angeheftete Notizen (2026-10-28)
-- Vorher den Code-Stand vor diesem Update deployen, sonst legt der Server die Spalten neu an.
ALTER TABLE comments DROP COLUMN pinned_at;
ALTER TABLE comments DROP COLUMN pinned_by;
