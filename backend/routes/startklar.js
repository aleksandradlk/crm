// ── Startklar-Check (Admin) ─────────────────────────────────────────────────
// Prüft auf einen Blick, ob das CRM für den Vertrieb bereit ist: Telefonie,
// E-Mail, Server-Einstellungen, Angebote & Rechnungen, Closer, Inhalte.
// Jeder Punkt: stand 'ok' | 'warn' | 'fehlt', ein Satz Erklärung und – wo
// möglich – wohin man zum Beheben klickt (tab = Admin-Bereich).
const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

const mitFrist = (p, ms = 6000) => Promise.race([p, new Promise((_, nein) => setTimeout(() => nein(new Error('Zeitüberschreitung')), ms))]);

async function smtpPruefen() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return { stand: 'fehlt', grund: 'nicht eingetragen' };
  try {
    const t = require('nodemailer').createTransport({
      host: process.env.SMTP_HOST, port: require('../helpers/mailer').SMTP_PORT,
      secure: require('../helpers/mailer').SMTP_SECURE, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await mitFrist(t.verify());
    return { stand: 'ok' };
  } catch (e) { return { stand: 'warn', grund: e.message }; }
}

router.get('/', auth, adminOnly, async (req, res) => {
  const punkte = [];
  const add = (gruppe, titel, stand, text, aktion) => punkte.push({ gruppe, titel, stand, text, aktion: aktion || null });
  const zahl = async (sql, p = []) => { try { const [[r]] = await db.query(sql, p); return Number(Object.values(r)[0]) || 0; } catch (_) { return 0; } };
  const einstellung = async k => { try { const [[r]] = await db.query('SELECT value FROM app_settings WHERE key_name=?', [k]); return r ? r.value : null; } catch (_) { return null; } };

  try {
    const [tw, mail, sgSt] = await Promise.all([
      require('./voice').twilioStatus().catch(e => ({ verbunden: false, fehler: e.message })), smtpPruefen(),
      require('./sipgate').status().catch(e => ({ verbunden: false, fehler: e.message }))]);

    // ── Telefonie ── (sipgate hat Vorrang; Twilio wird nur geprüft, wenn sipgate nicht verbunden ist)
    const zuIntegration = { label: 'Integrationen', tab: 'integrationen' };
    if (sgSt.verbunden) {
      add('Telefonie', 'sipgate verbunden', sgSt.fehler ? 'warn' : 'ok', sgSt.fehler ? `Verbunden, aber sipgate antwortet gerade nicht: ${sgSt.fehler}` : '„Anrufen“ im CRM klingelt am sipgate-Telefon des Vertrieblers und verbindet dann.', zuIntegration);
      add('Telefonie', 'Anrufe automatisch erfassen', sgSt.webhook ? 'ok' : 'warn', sgSt.webhook ? 'sipgate meldet jeden Anruf ans CRM – Dauer und verpasste Anrufe landen beim Lead.' : 'Optional: sipgate meldet Gesprächsdauer und verpasste Anrufe noch nicht. Anleitung unter Integrationen → sipgate („So richtest du es ein“).', zuIntegration);
      add('Telefonie', 'Absendernummer', sgSt.firmennummer || sgSt.nummern ? 'ok' : 'fehlt', sgSt.firmennummer ? 'Firmennummer ist festgelegt.' : sgSt.nummern ? `${sgSt.nummern} Nummer(n) bei sipgate – unter Integrationen eine Firmennummer wählen.` : 'Bei sipgate gibt es noch keine Rufnummer.', zuIntegration);
    } else if (!tw.verbunden) {
      add('Telefonie', 'Twilio verbunden', 'fehlt', 'Ohne Verbindung können die Closer nicht aus dem CRM anrufen. Unter Integrationen Account SID und Auth Token eintragen.', zuIntegration);
    } else {
      add('Telefonie', 'Twilio verbunden', tw.fehler ? 'warn' : 'ok', tw.fehler ? `Verbunden, aber Twilio antwortet gerade nicht: ${tw.fehler}` : 'Anrufe im Browser und auf dem Handy sind eingerichtet.', zuIntegration);
      if (tw.kontoTyp === 'Trial') add('Telefonie', 'Twilio-Konto aufgeladen', 'fehlt', 'Das Konto ist noch ein Testkonto: Es ruft nur bestätigte Nummern an und spielt vorher eine Ansage. In Twilio auf „Upgrade“ klicken und Guthaben aufladen.', { label: 'Twilio öffnen', url: 'https://console.twilio.com/us1/billing/manage-billing/upgrade' });
      else if (tw.kontoTyp) add('Telefonie', 'Twilio-Konto aufgeladen', 'ok', 'Vollkonto – Anrufe gehen ohne Ansage raus.');
      if (tw.deutschland === false) add('Telefonie', 'Anrufe nach Deutschland erlaubt', 'fehlt', 'In Twilio sind Anrufe nach Deutschland gesperrt. Unter Voice → Settings → Geo Permissions „Germany“ anhaken.', { label: 'Twilio öffnen', url: 'https://console.twilio.com/us1/develop/voice/settings/geo-permissions' });
      else if (tw.deutschland) add('Telefonie', 'Anrufe nach Deutschland erlaubt', 'ok', 'Geo-Freigabe für Deutschland ist an.');
      const u = tw.unterlagen || [];
      if (u.includes('twilio-approved')) add('Telefonie', 'Unterlagen für deutsche Nummern', 'ok', 'Von Twilio geprüft – du kannst deutsche Nummern holen und zuteilen.');
      else if (u.some(s => /review/.test(s))) add('Telefonie', 'Unterlagen für deutsche Nummern', 'warn', 'Bei Twilio in Prüfung (meist 1–3 Werktage). Bis dahin rufen alle mit der Firmennummer an.');
      else if (u.includes('twilio-rejected')) add('Telefonie', 'Unterlagen für deutsche Nummern', 'fehlt', 'Twilio hat die Unterlagen abgelehnt. In der Twilio-Konsole steht der Grund, danach neu einreichen.', { label: 'Twilio öffnen', url: 'https://console.twilio.com/us1/develop/phone-numbers/regulatory-compliance/bundles' });
      else add('Telefonie', 'Unterlagen für deutsche Nummern', 'warn', 'Für eigene deutsche Nummern verlangt Twilio einmalig Ausweis und Gewerbe-/Adressnachweis (Regulatory Bundle). Prüfung dauert 1–3 Werktage.', { label: 'Twilio öffnen', url: 'https://console.twilio.com/us1/develop/phone-numbers/regulatory-compliance/bundles' });
      add('Telefonie', 'Absendernummer', tw.firmennummer || tw.nummern ? 'ok' : 'fehlt',
        tw.firmennummer ? 'Firmennummer ist hinterlegt – wer keine eigene Nummer hat, ruft mit ihr an.'
          : tw.nummern ? `${tw.nummern} Nummer(n) im Konto – unter Benutzer den Closern zuteilen.` : 'Es gibt noch keine Nummer, mit der die Closer anrufen können. Unter Integrationen eine Firmennummer festlegen oder eine Nummer holen.', zuIntegration);
    }
    const basis = process.env.BASE_URL || '';
    add('Telefonie', 'Server-Adresse (BASE_URL)', /^https:\/\//.test(basis) ? 'ok' : 'warn',
      /^https:\/\//.test(basis) ? `${basis} – ${sgSt.verbunden ? 'sipgate' : 'Twilio'} erreicht das CRM darüber.` : `In Hostinger bei den Umgebungsvariablen BASE_URL=https://crm.novaflowservices.de eintragen, damit ${sgSt.verbunden ? 'sipgate' : 'Twilio'}-Rückmeldungen (Anrufstatus, eingehende Anrufe) sicher ankommen.`);

    // ── E-Mail & Server ──
    add('E-Mail & Server', 'E-Mail-Versand', mail.stand,
      mail.stand === 'ok' ? `Mails gehen über ${process.env.SMTP_USER} raus.` :
      mail.stand === 'fehlt' ? 'In Hostinger SMTP_HOST, SMTP_USER und SMTP_PASS (Postfach info@novaflowservices.de) eintragen – sonst gehen keine Mails, Angebote und Rechnungen raus.'
        : `Anmeldung am Mailserver klappt nicht (${mail.grund}). Passwort und Server in Hostinger prüfen.`);
    const nodeOk = (() => { const [a, b] = process.versions.node.split('.').map(Number); return a > 22 || (a === 22 && b >= 13); })();
    add('E-Mail & Server', 'Node.js-Version', nodeOk ? 'ok' : 'fehlt', nodeOk ? `Node ${process.versions.node}` : `Node ${process.versions.node} ist zu alt für Angebote & Rechnungen. In Hostinger bei der CRM-App Node 22 auswählen.`);
    add('E-Mail & Server', 'Sicherheitsschlüssel (JWT_SECRET)', String(process.env.JWT_SECRET || '').length >= 32 ? 'ok' : 'fehlt',
      String(process.env.JWT_SECRET || '').length >= 32 ? 'Lang genug.' : 'In Hostinger einen langen Zufallswert (mind. 32 Zeichen) für JWT_SECRET eintragen.');
    add('E-Mail & Server', 'KI für „Leads generieren“', process.env.CLAUDE_API_KEY ? 'ok' : 'warn', process.env.CLAUDE_API_KEY ? 'Eingerichtet.' : 'CLAUDE_API_KEY fehlt – ohne ihn funktioniert „Leads generieren“ nicht.');

    // ── Angebote & Rechnungen ──
    const abr = require('../abrechnung/crm').status;
    if (!abr.aktiv) add('Angebote & Rechnungen', 'Modul läuft', 'fehlt', abr.grund || 'Angebote & Rechnungen konnten nicht gestartet werden.', { label: 'Ansehen', tab: 'abrechnung' });
    else {
      add('Angebote & Rechnungen', 'Modul läuft', 'ok', 'Angebote, Rechnungen, Mahnungen und Abos sind verfügbar.');
      const g = abr.abgleich, e = abr.eingespielt || {};
      const am = iso => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
      if (g) add('Angebote & Rechnungen', 'Daten aus dem Angebotstool', 'ok', `Wird automatisch abgeglichen, zuletzt am ${am(g.am)}.`);
      else if (e.novaflow && e.kundenkonten) add('Angebote & Rechnungen', 'Daten aus dem Angebotstool', 'ok', `Aus der Sicherung eingespielt (NovaFlow ${am(e.novaflow)}, Kundenkonten ${am(e.kundenkonten)}). Neuere Daten: nächste Sicherungs-Mail einfach wieder einspielen.`, { label: 'Sicherung einspielen', tab: 'abrechnung' });
      else add('Angebote & Rechnungen', 'Daten aus dem Angebotstool', 'warn',
        `Das Angebotstool liegt nicht auf diesem Server. ${e.novaflow || e.kundenkonten ? `Es fehlt noch die Datei ${e.novaflow ? 'Angebotstool-Kundenkonten_….json' : 'NovaFlow-Abrechnung-Daten_….json'}.` : 'Die beiden Dateien aus der Sicherungs-Mail'} unter Angebote & Rechnungen → „Sicherung einspielen“ übernehmen.`, { label: 'Sicherung einspielen', tab: 'abrechnung' });
    }

    // ── Team ──
    const [closer] = await db.query(
      `SELECT u.id, u.full_name, u.phone_line, u.caller_id, u.caller_id_verified, u.last_login, u.sipgate_user, u.sipgate_nummer,
              (SELECT COUNT(*) FROM leads l WHERE l.assigned_to=u.id AND l.archived_at IS NULL AND l.status NOT IN ('kunde','kein_interesse')) AS offen
       FROM users u WHERE u.role='closer' AND u.is_active=1 ORDER BY u.full_name`);
    if (!closer.length) add('Team', 'Closer angelegt', 'fehlt', 'Noch kein Closer angelegt. Unter Benutzer anlegen und die Zugangsdaten schicken.', { label: 'Benutzer', tab: 'users' });
    else {
      add('Team', 'Closer angelegt', 'ok', `${closer.length} aktiv: ${closer.map(c => c.full_name).join(', ')}.`);
      if (sgSt.verbunden) {
        const ohneZugang = closer.filter(c => !c.sipgate_user);
        add('Team', 'sipgate-Telefon je Closer', !ohneZugang.length ? 'ok' : 'fehlt',
          !ohneZugang.length ? 'Jeder Closer hat einen sipgate-Zugang.' : `Noch ohne sipgate-Zugang: ${ohneZugang.map(c => c.full_name).join(', ')}. In sipgate einen Benutzer anlegen und unter Integrationen zuordnen – bis dahin wählen sie über ihr eigenes Telefon.`, zuIntegration);
        const ohneNummer = closer.filter(c => c.sipgate_user && !c.sipgate_nummer);
        if (ohneNummer.length) add('Team', 'Nummer je Closer', 'warn', `Mit Firmennummer: ${ohneNummer.map(c => c.full_name).join(', ')}. Eigene Nummer optional unter Integrationen.`, zuIntegration);
      } else {
        const ohneNummer = closer.filter(c => !c.phone_line && !(c.caller_id && c.caller_id_verified));
        add('Team', 'Nummer je Closer', !ohneNummer.length ? 'ok' : (tw.firmennummer ? 'warn' : 'fehlt'),
          !ohneNummer.length ? 'Jeder Closer hat eine eigene Nummer.'
            : `Ohne eigene Nummer: ${ohneNummer.map(c => c.full_name).join(', ')}.${tw.firmennummer ? ' Sie rufen bis dahin mit der Firmennummer an.' : ''}`, { label: 'Benutzer', tab: 'users' });
      }
      const wenig = closer.filter(c => c.offen < 20);
      add('Team', 'Leads verteilt', !wenig.length ? 'ok' : 'warn',
        !wenig.length ? 'Jeder Closer hat mindestens 20 offene Leads.'
          : `Wenig zu tun (unter 20 offene Leads): ${wenig.map(c => `${c.full_name} (${c.offen})`).join(', ')}.`, { label: 'Alle Leads', tab: 'leads' });
      const nieDa = closer.filter(c => !c.last_login);
      if (nieDa.length) add('Team', 'Erste Anmeldung', 'warn', `Noch nie angemeldet: ${nieDa.map(c => c.full_name).join(', ')}. Zugangsdaten verschickt?`, { label: 'Benutzer', tab: 'users' });
    }
    const frei = await zahl('SELECT COUNT(*) FROM leads WHERE assigned_to IS NULL AND archived_at IS NULL');
    if (frei) add('Team', 'Freie Leads', 'warn', `${frei} Lead(s) ohne Zuständigen. ${(await einstellung('closer_freie_leads')) === '0' ? 'Closer sehen sie nicht – bitte zuteilen.' : 'Closer können sie sich nehmen, besser gezielt zuteilen.'}`, { label: 'Alle Leads', tab: 'leads' });

    // ── Inhalte für die Closer ──
    const wiki = await zahl('SELECT COUNT(*) FROM wiki_files');
    add('Inhalte', 'Wissensdatenbank', wiki ? 'ok' : 'fehlt', wiki ? `${wiki} Dokument(e) – z. B. Preisliste, Pakete, Leitfaden.` : 'Noch leer. Rein gehören Produkt & Pakete mit Preisen, was „Starttermin“ bedeutet, Gesprächsleitfaden und Einwandbehandlung.', { label: 'Wissensdatenbank', tab: 'wiki' });
    const skript = (await einstellung('call_script')) || '';
    add('Inhalte', 'Gesprächsleitfaden', skript.trim().length > 40 ? 'ok' : 'warn', skript.trim().length > 40 ? 'Wird den Closern beim Anrufen angezeigt.' : 'Noch kein Leitfaden hinterlegt – er erscheint beim Anrufen neben dem Lead. Unter Einstellungen (Zahnrad) eintragen.');
    const vorlagen = await zahl('SELECT COUNT(*) FROM email_templates');
    add('Inhalte', 'E-Mail-Vorlagen', vorlagen >= 2 ? 'ok' : 'warn', vorlagen >= 2 ? `${vorlagen} Vorlagen.` : 'Mindestens „Infos nach dem Telefonat“ und „Terminbestätigung“ anlegen, dann schicken die Closer das mit einem Klick.', { label: 'Wissensdatenbank', tab: 'wiki' });
    const anfordern = await zahl("SELECT COUNT(*) FROM deal_stages WHERE is_active=1 AND name REGEXP 'anforder|anfrage'");
    add('Inhalte', 'Deal-Phase „Angebot anfordern“', anfordern ? 'ok' : 'warn', anfordern ? 'Closer geben dir darüber die Infos fürs Angebot.' : 'Die Phase fehlt in der Pipeline – ohne sie landen Angebots-Anfragen nicht bei dir.', { label: 'Deals', tab: 'deals' });

    const offen = punkte.filter(p => p.stand !== 'ok');
    res.json({ punkte, fehlt: offen.filter(p => p.stand === 'fehlt').length, warn: offen.filter(p => p.stand === 'warn').length, ok: punkte.length - offen.length });
  } catch (e) {
    console.error('Startklar-Check:', e);
    res.status(500).json({ error: 'Startklar-Check fehlgeschlagen: ' + e.message });
  }
});

module.exports = router;
