-- Rückweg: dauerhaft gesicherte Abschlüsse (Provision je gewonnenem Deal).
-- Achtung: Damit geht die festgeschriebene Historie verloren. Vorher sichern:
--   SELECT * FROM provision_abschluesse INTO OUTFILE ... oder per Export.
DROP TABLE IF EXISTS provision_abschluesse;
