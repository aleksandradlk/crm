-- Rückweg für die Zeit-Umstellung vom 28.10.2026 (Termine und Wiedervorlagen in UTC)
-- Nur zusammen mit dem Code-Stand vor der Umstellung verwenden. Stellt die alten Werte
-- (deutsche Zeit) aus zeit_umstellung_alt wieder her; seitdem geänderte Zeilen werden
-- dabei auf den alten Wert zurückgesetzt.
UPDATE appointments a JOIN zeit_umstellung_alt z
  ON z.tabelle = 'appointments' AND z.spalte = 'starts_at' AND z.zeile_id = a.id SET a.starts_at = z.alt;
UPDATE appointments a JOIN zeit_umstellung_alt z
  ON z.tabelle = 'appointments' AND z.spalte = 'counter_at' AND z.zeile_id = a.id SET a.counter_at = z.alt;
UPDATE reminders r JOIN zeit_umstellung_alt z
  ON z.tabelle = 'reminders' AND z.spalte = 'remind_at' AND z.zeile_id = r.id SET r.remind_at = z.alt;
DELETE FROM app_settings WHERE key_name = 'zeit_utc_umgestellt';
DROP TABLE IF EXISTS zeit_umstellung_alt;
