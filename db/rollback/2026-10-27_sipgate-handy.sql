-- Rückweg: Closer ohne eigenen sipgate-Zugang (Handy klingelt zuerst über den Hauptzugang).
ALTER TABLE users DROP COLUMN sipgate_handy;
