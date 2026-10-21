# NovaFlow CRM – Roadmap

Ziel: Vertriebler (Closer) sollen so schnell wie möglich Leads anrufen und abschließen können,
ohne durch unnötige Klicks, doppelte Eingaben oder Suchen ausgebremst zu werden.

Grundlage: Recherche zu Pipedrive, Close, HubSpot Sales Hub, Salesforce, Zoho CRM, Freshsales
und CentralStationCRM (Bewertungen von Vertrieblern auf G2, Capterra, OMR, TrustRadius, Gartner).

## Was Vertriebler an CRMs mögen
- Einfache, sichtbare Pipeline; liegengebliebene Deals werden rot markiert (Pipedrive)
- Power-Dialer mit automatischer Protokollierung jedes Anrufs (Close)
- Gespeicherte Filterlisten („Smart Views“), direkt abtelefonierbar (Close)
- Ein Arbeitsplatz für alle Aufgaben des Tages (HubSpot Prospecting Queue)

## Was sie stört
- Zu viele Klicks, manuelle Dateneingabe (72 % verbringen bis zu 1 Std./Tag damit – Clari)
- Langsame, überladene Oberfläche (Zoho), schwache Handy-Apps (Pipedrive)
- Doppelte Kontakte, ungenaue Anrufzählung
- Wichtige Funktionen nur in teuren Tarifen

## Erledigt
- [x] Anrufmodus (Power-Dialer): Warteschlange, Ergebnis per Taste 1–8, Wiedervorlage in einem Schritt
- [x] „Nächster Schritt“ je Lead, Rückrufe gehen nicht mehr verloren
- [x] Deals mit Wert, Pipeline-Phasen, Gewonnen/Verloren mit Grund, „Rot nach x Tagen“
- [x] Umsatz und Prognose im Dashboard, Umsatz je Closer
- [x] E-Mails: nur Kundenantworten ins CRM, nur für den betreuenden Vertriebler sichtbar
- [x] Saubere Adressen (/login, /admin, /closer)
- [x] Agenten entfernt
- [x] „Heute“-Liste: verpasste Anrufe, fällige Rückrufe, neue Kundenantworten, Deals mit Handlungsbedarf
- [x] Dubletten-Check (Telefon, E-Mail, Website) bei Anlegen, Import, KI-Generierung + Zusammenführen
- [x] Wähllisten: gespeicherte Filter direkt im Anrufmodus abtelefonieren
- [x] Eingehende Anrufe: Anrufer erkennen, im Browser annehmen, verpasste Anrufe als Rückruf-Aufgabe

## Später
| Feature | Nutzen | Aufwand |
|---|---|---|
| Mailbox-Ansage per Klick | Ansage einmal aufnehmen und bei jeder Mailbox abspielen, spart 30–60 Sek. pro Mailbox | klein |
| Mail-Öffnungs-Hinweis | „Kunde hat das Angebot gerade geöffnet – jetzt anrufen“ | mittel |
| Follow-up-Abläufe (Sequenzen) | Anruf → Mail → Anruf, stoppt automatisch bei Antwort, Termin oder „Kein Interesse“; Leads gesammelt einschreiben | mittel–groß |
| Kalender-Sync und Buchungslink | Google/Outlook-Termine, Buchungslink in Mails, kein Hin und Her | mittel |
| Handy-Version (PWA) mit Push | Rückrufe und Wiedervorlagen unterwegs | mittel–groß |
| KI-Gesprächsnotiz | Gespräch automatisch zusammengefasst am Lead, Vorschlag für Wiedervorlage und Deal-Wert. Nur mit Einwilligung zur Aufnahme (§201 StGB, DSGVO) | groß |
| Produkte und Preisliste | Deals aus festen Paketen zusammenklicken statt Wert frei eintippen | mittel |
| Beste Anrufzeit je Branche | Auswertung, wann welche Branche am besten erreichbar ist (Handwerker früh, Praxen mittags) | klein |
| Mehrere Rufnummern und Spam-Schutz | Anrufe auf mehrere Nummern verteilen, damit keine Nummer als Spam markiert wird | klein–mittel |
| Inline-Bearbeitung in Listen | Felder direkt in der Tabelle ändern, weniger Klicks | klein |
| Server-seitige Suche und Seiten | Admin-Listen auch bei vielen tausend Leads schnell und vollständig | mittel |
| Sichtbarkeit einstellbar | Festlegen, ob Vertriebler alle Leads oder nur eigene + freie sehen | klein |
| Automatische Auslieferung | Nach dem Mergen automatisch auf den Server (GitHub Action mit SSH) | klein |
