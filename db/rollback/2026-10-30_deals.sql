-- Rückweg Deals-Änderungen (30.10.2026)
ALTER TABLE deals DROP COLUMN aktionsrabatt;
-- Die beim Update geschlossenen automatischen Nachfass-Erinnerungen (kind='nachfass_auto') lassen sich
-- bei Bedarf wieder öffnen: UPDATE reminders SET done_at=NULL WHERE kind='nachfass_auto' AND done_at >= '2026-10-30';
