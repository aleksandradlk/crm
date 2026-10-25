// ============================================================
// Passende Mail nach dem Gespräch
// Jede Vorlage kann einem Anrufergebnis zugeordnet sein (Einstellung an der
// Vorlage). Nach dem Gespräch schlägt das CRM sie vor – mit Kundendaten
// gefüllt, im Anrufmodus und im Lead-Panel.
// ============================================================
const MailVorschlag = {
  ERGEBNISSE: [
    ['interesse', 'Interesse'], ['rueckruf', 'Rückruf vereinbart'], ['termin', 'Termin vereinbart'],
    ['mailbox', 'Mailbox'], ['nicht_erreicht', 'Nicht erreicht'], ['kein_interesse', 'Kein Interesse'], ['kunde', 'Abschluss'],
  ],
  _vorlagen: null,

  label(outcome) { return (this.ERGEBNISSE.find(([k]) => k === outcome) || [])[1] || ''; },

  async vorlagen() {
    if (!this._vorlagen) {
      const rows = await api('GET', '/email-templates').catch(() => []);
      this._vorlagen = rows.filter(t => t.is_active === undefined || t.is_active);
    }
    return this._vorlagen;
  },
  // Nach dem Speichern oder Löschen einer Vorlage neu laden
  reset() { this._vorlagen = null; },

  async fuer(outcome) {
    if (!outcome) return null;
    return (await this.vorlagen()).find(t => t.trigger_outcome === outcome) || null;
  },

  // Auswahlliste für die Vorlagen-Bearbeitung
  optionen(aktuell) {
    return '<option value="">— nicht automatisch vorschlagen —</option>' + this.ERGEBNISSE.map(([k, l]) =>
      `<option value="${k}"${k === aktuell ? ' selected' : ''}>${escHtml(l)}</option>`).join('');
  },

  // „Dienstag, 27.10.2026 um 14:30 Uhr“
  terminText(d) {
    if (!d) return '';
    const x = d instanceof Date ? d : new Date(String(d).replace(' ', 'T'));
    if (Number.isNaN(x.getTime())) return '';
    const tag = x.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    const zeit = x.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return `${tag} um ${zeit} Uhr`;
  },

  // Nächste offene Wiedervorlage des Leads (für {{termin}} im Lead-Panel)
  naechsterTermin(lead) {
    const jetzt = Date.now();
    const r = (lead?.reminders || [])
      .map(x => new Date(String(x.remind_at).replace(' ', 'T')))
      .filter(d => d.getTime() > jetzt)
      .sort((a, b) => a - b)[0];
    return r || null;
  },

  fuellen(text, lead, opts = {}) {
    if (!text) return text;
    lead = lead || {};
    const termin = opts.termin !== undefined ? opts.termin : this.naechsterTermin(lead);
    const werte = {
      '{{kunde}}':   lead.ceo || '',
      '{{firma}}':   lead.company || '',
      '{{closer}}':  (typeof ME !== 'undefined' && ME?.full_name) || '',
      '{{telefon}}': lead.phone || '',
      '{{email}}':   lead.email || '',
      '{{termin}}':  this.terminText(termin),
      '{company}':   lead.company || '',
    };
    Object.entries(werte).forEach(([k, v]) => { text = text.split(k).join(v); });
    // Ohne Ansprechpartner: „Guten Tag ,“ → „Guten Tag,“
    return text.replace(/ +,/g, ',');
  },

  alsHtml(text) {
    if (!text) return '';
    if (/<[a-z][\s\S]*>/i.test(text)) return text;
    return text.split('\n').map(l => `<div>${escHtml(l) || '<br>'}</div>`).join('');
  },

  // Lead-Panel: Vorschlag nach dem letzten Gespräch, solange danach noch keine Mail rausging
  async panelBox(lead, elId, oeffnen) {
    // Erst nach dem Laden suchen: der Platz wird gerade erst ins Panel geschrieben
    const vorlagen = (await this.vorlagen()).filter(t => t.trigger_outcome);
    const el = document.getElementById(elId);
    if (!el || !lead || !vorlagen.length) return;
    el.innerHTML = '';
    const anruf = (lead.call_logs || []).find(c => c.outcome || ['reached', 'completed'].includes(c.status));
    if (!anruf) return;
    const wann = new Date(String(anruf.ended_at || anruf.started_at).replace(' ', 'T')).getTime();
    if (Date.now() - wann > 7 * 864e5) return;
    const spaeterGemailt = (lead.email_thread || []).some(m => m.direction === 'outbound'
      && new Date(String(m.received_at || m.created_at).replace(' ', 'T')).getTime() >= wann - 60000);
    if (spaeterGemailt) return;
    const passend = anruf.outcome && vorlagen.find(t => t.trigger_outcome === anruf.outcome);
    const andere = vorlagen.filter(t => t !== passend);
    el.innerHTML = `<div class="mv-box">
      <div class="mv-head"><i class="fas fa-envelope-open-text"></i>
        <span>${passend ? `Nach „${escHtml(this.label(anruf.outcome))}“ passt diese Mail` : 'Mail nach dem Gespräch'}</span></div>
      ${passend ? `<button class="btn btn-primary btn-sm mv-main" onclick="${oeffnen}(${passend.id})"><i class="fas fa-paper-plane"></i> ${escHtml(passend.name)}</button>` : ''}
      <div class="mv-chips">${andere.map(t => `<button class="qf-btn" onclick="${oeffnen}(${t.id})">${escHtml(t.name)}</button>`).join('')}</div>
    </div>`;
  },
};
