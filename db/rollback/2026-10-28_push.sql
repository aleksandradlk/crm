-- Rückweg für Handy-Benachrichtigungen (Web Push) und Folierer-Vorgabe (2026-10-28)
-- Vorher den Code-Stand vor diesem Update deployen, sonst legt der Server die Tabelle neu an.
DROP TABLE IF EXISTS push_subscriptions;
ALTER TABLE reminders DROP COLUMN push_at;
DELETE FROM integrations WHERE name = 'webpush';
-- Folierer-Vorgabe: Branche „Fahrzeugfolierung“ im CRM unter Generieren → Vorgaben für Closer entfernen.
-- Das Merkzeichen nur löschen, wenn die einmalige Ergänzung erneut laufen soll:
-- DELETE FROM app_settings WHERE key_name = 'finder_folierung_v1';
