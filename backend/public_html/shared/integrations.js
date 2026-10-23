// ============================================================
// Integrationen (nur Admin): Telefonie-Anbieter verbinden und die eigene
// Schnittstelle des CRM (API-Schlüssel) verwalten. Eingebunden in admin.html.
// ============================================================
const Integrationen = {
  mount(rootId) {
    const root = document.getElementById(rootId);
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    root.innerHTML = `
      <div class="page-header">
        <div><h1 data-eyebrow="Administration">Integrationen</h1><p class="page-desc">Telefonie-Anbieter verbinden und andere Programme (Airtable, Make, n8n, Zapier …) an dein CRM anschließen.</p></div>
      </div>
      <div class="ig-grid">
        <section class="card ig-card" id="igTel"></section>
        <section class="card ig-card" id="igApi"></section>
      </div>`;
  },

  async load() { this.loadTel(); this.loadApi(); },

  // ── Telefonie (Twilio) ─────────────────────────────────────
  async loadTel() {
    const el = document.getElementById('igTel');
    el.innerHTML = '<div class="ig-head"><span class="ig-logo tel"><i class="fas fa-phone-volume"></i></span><div><h2>Telefonie</h2><p>Wird geladen …</p></div></div>';
    let s;
    try { s = await api('GET', '/voice/setup'); } catch (e) { el.innerHTML = `<div class="ig-body"><div class="line-err">${escHtml(e.message)}</div></div>`; return; }
    const head = `<div class="ig-head"><span class="ig-logo tel"><i class="fas fa-phone-volume"></i></span>
      <div><h2>Telefonie über Twilio</h2><p>Anrufen im Browser und am Handy, eigene Nummern je Vertriebler, eingehende Anrufe im CRM.</p></div>
      <span class="ig-status ${s.verbunden ? 'on' : ''}">${s.verbunden ? 'Verbunden' : 'Nicht verbunden'}</span></div>`;
    const links = `<div class="ig-links">
        <a href="https://console.twilio.com/us1/develop/phone-numbers/manage/search?isoCountry=DE" target="_blank" rel="noopener"><i class="fas fa-shopping-cart"></i> Nummer bei Twilio buchen</a>
        <a href="https://console.twilio.com/us1/develop/phone-numbers/regulatory-compliance/bundles" target="_blank" rel="noopener"><i class="fas fa-id-card"></i> Nachweis für deutsche Nummern</a>
        <a href="https://console.twilio.com/us1/billing/manage-billing/billing-overview" target="_blank" rel="noopener"><i class="fas fa-wallet"></i> Guthaben &amp; Kosten</a>
      </div>`;
    if (s.verbunden) {
      el.innerHTML = head + `<div class="ig-body">
        <div class="ig-facts">
          <div><span>Konto</span><b>${escHtml((s.konto && s.konto.name) || s.accountSid || '—')}</b></div>
          <div><span>Nummern im Konto</span><b>${s.nummern ?? '—'}</b></div>
          <div><span>Firmennummer</span><b class="mono">${s.firmennummer ? escHtml(fmtPhoneDE(s.firmennummer)) : '—'}</b></div>
        </div>
        ${s.fehler ? `<div class="line-err"><i class="fas fa-exclamation-triangle"></i> ${escHtml(s.fehler)}</div>` : ''}
        <p class="ig-hint">Nummern teilst du unter <b>Benutzer → Bearbeiten → Nummer fürs Telefonieren im CRM</b> zu – dort kannst du auch direkt neue holen oder eine Nummer von Hand eintragen.</p>
        ${s.ausEnv ? '<p class="ig-hint">Die Zugangsdaten stehen in der .env-Datei des Servers.</p>' : `
        <div class="ig-row">
          <input id="igFirma" class="form-control" placeholder="Firmennummer, z. B. +49 30 1234567" value="${escHtml(s.firmennummer || '')}">
          <button class="btn btn-ghost btn-sm" onclick="Integrationen.firmennummer()">Speichern</button>
        </div>`}
        ${links}
        ${s.ausEnv ? '' : '<button class="btn btn-ghost btn-sm ig-trennen" onclick="Integrationen.trennen()"><i class="fas fa-unlink"></i> Verbindung trennen</button>'}
      </div>`;
      return;
    }
    el.innerHTML = head + `<div class="ig-body">
      ${s.paketFehlt ? '<div class="line-err">Das Twilio-Paket fehlt auf dem Server (npm install im Ordner backend).</div>' : ''}
      <ol class="ig-steps">
        <li>Bei <a href="https://www.twilio.com/try-twilio" target="_blank" rel="noopener">twilio.com</a> ein Konto anlegen (oder anmelden) und Guthaben aufladen.</li>
        <li>In der <a href="https://console.twilio.com" target="_blank" rel="noopener">Twilio-Konsole</a> auf der Startseite <b>Account SID</b> und <b>Auth Token</b> kopieren und hier einfügen.</li>
        <li>Fertig – das CRM richtet den Rest selbst ein. Danach Nummern buchen und unter Benutzer zuteilen.</li>
      </ol>
      <div class="form-group" style="margin:0"><label>Account SID</label><input id="igSid" class="form-control mono" placeholder="AC…" autocomplete="off"></div>
      <div class="form-group" style="margin:0"><label>Auth Token</label><input id="igToken" type="password" class="form-control mono" placeholder="••••••••" autocomplete="new-password"></div>
      <button class="btn btn-primary" id="igVerbinden" onclick="Integrationen.verbinden()"><i class="fas fa-plug"></i> Twilio verbinden</button>
      ${links}
    </div>`;
  },

  async verbinden() {
    const btn = document.getElementById('igVerbinden');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verbinde …';
    try {
      const r = await api('POST', '/voice/setup', { accountSid: document.getElementById('igSid').value, authToken: document.getElementById('igToken').value });
      showToast(`Verbunden mit ${r.konto} ✓`);
      if (typeof Softphone !== 'undefined') Softphone.config = null;
      this.loadTel();
    } catch (e) { showToast(e.message, 'err'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-plug"></i> Twilio verbinden'; }
  },
  async firmennummer() {
    try { await api('PUT', '/voice/setup/firmennummer', { number: document.getElementById('igFirma').value }); showToast('Firmennummer gespeichert ✓'); this.loadTel(); }
    catch (e) { showToast(e.message, 'err'); }
  },
  async trennen() {
    if (!await customConfirm('Danach kann niemand mehr über das CRM telefonieren, bis du Twilio wieder verbindest. Nummern und Guthaben bleiben bei Twilio.', { title: 'Twilio trennen?', okLabel: 'Trennen', danger: true })) return;
    try { await api('DELETE', '/voice/setup'); showToast('Getrennt'); this.loadTel(); } catch (e) { showToast(e.message, 'err'); }
  },

  // ── Eigene Schnittstelle (API) ─────────────────────────────
  async loadApi() {
    const el = document.getElementById('igApi');
    let keys = [];
    try { keys = await api('GET', '/api-keys'); } catch (e) { el.innerHTML = `<div class="ig-body"><div class="line-err">${escHtml(e.message)}</div></div>`; return; }
    const base = location.origin + '/api/v1';
    const aktiv = keys.filter(k => !k.revoked_at);
    el.innerHTML = `<div class="ig-head"><span class="ig-logo api"><i class="fas fa-code"></i></span>
        <div><h2>Schnittstelle (API)</h2><p>Andere Programme lesen und schreiben Leads, Deals und Anrufe – z. B. neue Anfragen aus Airtable oder einem Formular direkt als Lead.</p></div>
        <span class="ig-status ${aktiv.length ? 'on' : ''}">${aktiv.length ? aktiv.length + ' aktiv' : 'Kein Schlüssel'}</span></div>
      <div class="ig-body">
        <div class="ig-row">
          <input id="igKeyName" class="form-control" placeholder="Wofür? z. B. Airtable, Make, Website-Formular">
          <button class="btn btn-primary btn-sm" onclick="Integrationen.neuerSchluessel()"><i class="fas fa-key"></i> Schlüssel erstellen</button>
        </div>
        <div id="igNeu"></div>
        <div class="ig-keys">${keys.map(k => `<div class="ig-key${k.revoked_at ? ' off' : ''}">
            <i class="fas fa-key"></i>
            <div><b>${escHtml(k.name)}</b><span class="mono">${escHtml(k.prefix)}…</span>
              <small>${k.revoked_at ? 'widerrufen ' + fmtDateShort(k.revoked_at) : k.last_used_at ? 'zuletzt genutzt ' + fmtDate(k.last_used_at) : 'noch nie genutzt'}</small></div>
            ${k.revoked_at ? '' : `<button class="btn btn-ghost btn-sm" onclick="Integrationen.widerrufen(${k.id}, ${escHtml(JSON.stringify(k.name))})">Widerrufen</button>`}
          </div>`).join('') || '<div class="line-hint">Noch kein Schlüssel. Leg für jedes Programm einen eigenen an, dann kannst du ihn einzeln widerrufen.</div>'}</div>
        <details class="ig-doku">
          <summary><i class="fas fa-book"></i> So funktioniert die Schnittstelle</summary>
          <p>Adresse: <code>${escHtml(base)}</code> · Anmeldung mit dem Kopf <code>Authorization: Bearer nf_…</code> · Antworten als JSON · höchstens 120 Anfragen pro Minute.</p>
          <table class="ig-endpoints">
            <tr><td><b>GET</b></td><td>/leads</td><td>Leads auflisten · Filter: <code>status</code>, <code>assigned_to</code>, <code>q</code>, <code>updated_since</code>, <code>limit</code>, <code>offset</code></td></tr>
            <tr><td><b>GET</b></td><td>/leads/:id</td><td>Ein Lead mit seinen Deals</td></tr>
            <tr><td><b>POST</b></td><td>/leads</td><td>Lead anlegen (<code>company</code> Pflicht; <code>ceo</code>, <code>email</code>, <code>phone</code>, <code>website</code>, <code>location</code>, <code>industry</code>, <code>notes</code>, <code>assigned_to</code>, <code>source</code>). Dubletten → 409</td></tr>
            <tr><td><b>PATCH</b></td><td>/leads/:id</td><td>Felder, <code>status</code> oder <code>assigned_to</code> ändern</td></tr>
            <tr><td><b>POST</b></td><td>/leads/:id/notes</td><td>Notiz in den Verlauf (<code>text</code>)</td></tr>
            <tr><td><b>GET</b></td><td>/deals</td><td>Deals · Filter: <code>status</code> (open/won/lost/all), <code>lead_id</code></td></tr>
            <tr><td><b>POST</b></td><td>/deals</td><td>Deal anlegen (<code>lead_id</code>, <code>title</code>, <code>value</code>, <code>stage</code>)</td></tr>
            <tr><td><b>GET</b></td><td>/stages · /users · /calls</td><td>Phasen, Benutzer, Anrufe (<code>since</code>)</td></tr>
          </table>
          <p>Beispiel – neuer Lead aus einem Formular:</p>
          <pre>curl -X POST ${escHtml(base)}/leads \\
  -H "Authorization: Bearer nf_DEIN_SCHLUESSEL" \\
  -H "Content-Type: application/json" \\
  -d '{"company":"Malerbetrieb Krause","phone":"+49 30 1234567","email":"info@krause.de","source":"website"}'</pre>
          <p>In <b>Make</b> oder <b>Zapier</b>: Modul „HTTP – Make a request“ bzw. „Webhooks – Custom Request“ mit derselben Adresse und dem Kopf <code>Authorization</code>. In <b>Airtable</b>: Automation mit „Run script“ und <code>fetch()</code>.</p>
        </details>
      </div>`;
  },

  async neuerSchluessel() {
    try {
      const r = await api('POST', '/api-keys', { name: document.getElementById('igKeyName').value });
      document.getElementById('igNeu').innerHTML = `<div class="ig-neu">
        <b><i class="fas fa-check-circle"></i> Schlüssel „${escHtml(r.name)}“ erstellt – jetzt kopieren, er wird nur dieses eine Mal angezeigt:</b>
        <div class="ig-row"><input class="form-control mono" readonly value="${escHtml(r.key)}" onclick="this.select()">
        <button class="btn btn-primary btn-sm" onclick="navigator.clipboard.writeText(${escHtml(JSON.stringify(r.key))}).then(()=>showToast('Kopiert ✓'))"><i class="fas fa-copy"></i> Kopieren</button></div></div>`;
      const neu = document.getElementById('igNeu').innerHTML;
      await this.loadApi();
      document.getElementById('igNeu').innerHTML = neu;
    } catch (e) { showToast(e.message, 'err'); }
  },

  async widerrufen(id, name) {
    if (!await customConfirm(`Programme, die „${name}“ benutzen, haben danach keinen Zugriff mehr.`, { title: 'Schlüssel widerrufen?', okLabel: 'Widerrufen', danger: true })) return;
    try { await api('DELETE', `/api-keys/${id}`); showToast('Widerrufen'); this.loadApi(); } catch (e) { showToast(e.message, 'err'); }
  },
};
