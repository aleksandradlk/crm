-- Rollback für §5 Wissensdatenbank (Artikel, Referenzen, Hinweis „Aktualisiert“)
-- Vorher eine Sicherung ziehen: Artikel und Referenzen gehen dabei verloren.
DROP TABLE IF EXISTS wiki_artikel;
DROP TABLE IF EXISTS wiki_referenzen;
ALTER TABLE users DROP COLUMN wiki_gesehen_at;
