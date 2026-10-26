-- Rollback für §8 Provision und Bonus
-- Entfernt die beiden Provisions-Felder am Benutzer. Die Provision selbst wird
-- nicht gespeichert, sondern bei jedem Aufruf aus Angeboten und Rechnungen berechnet.
ALTER TABLE users DROP COLUMN provision_zzgl_ust;
ALTER TABLE users DROP COLUMN provision_ausland;
