-- Rückweg für „passt nicht“/„Keine Anrufe mehr“, Wählliste „nie erreicht“ und warme Übergabe.
-- Vorher eine Sicherung ziehen. Leads mit den neuen Status werden auf „kein_interesse“ gesetzt.
UPDATE leads SET status = 'kein_interesse' WHERE status IN ('passt_nicht', 'keine_anrufe');
ALTER TABLE leads MODIFY COLUMN status ENUM('neu','kontaktiert','nicht_erreicht','kein_interesse','rueckruf','kunde') NOT NULL DEFAULT 'neu';
ALTER TABLE leads DROP COLUMN status_grund, DROP COLUMN nie_erreicht, DROP COLUMN instagram_url;
ALTER TABLE appointments DROP COLUMN art, DROP COLUMN painpoints, DROP COLUMN versprochen,
  DROP COLUMN offene_fragen, DROP COLUMN uebergabe, DROP COLUMN vorher_zugewiesen;
DELETE FROM call_lists WHERE filters LIKE '%"nie_erreicht":true%';
