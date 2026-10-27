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
        <section class="card ig-card ig-wide" id="igSipgate"></section>
        <section class="card ig-card" id="igTel"></section>
        <section class="card ig-card" id="igApi"></section>
      </div>`;
  },

  async load() { this.loadSipgate(); this.loadTel(); this.loadApi(); },

  // ── Telefonie über sipgate ─────────────────────────────────
  async loadSipgate() {
    const el = document.getElementById('igSipgate');
    el.innerHTML = '<div class="ig-head"><span class="ig-logo sg"><i class="fas fa-headset"></i></span><div><h2>Telefonie über sipgate</h2><p>Wird geladen …</p></div></div>';
    let s;
    try { s = await api('GET', '/sipgate/setup'); } catch (e) { el.innerHTML = `<div class="ig-body"><div class="line-err">${escHtml(e.message)}</div></div>`; return; }
    this._sg = s;
    const head = `<div class="ig-head"><span class="ig-logo sg"><i class="fas fa-headset"></i></span>
      <div><h2>Telefonie über sipgate</h2><p>Deutsche Nummern ohne Extra-Prüfung. „Anrufen“ im CRM lässt zuerst das sipgate-Telefon des Vertrieblers klingeln (App, Web-Telefon oder Tischtelefon) und verbindet dann mit dem Kunden. Alle Anrufe landen automatisch beim Lead.</p></div>
      <span class="ig-status ${s.verbunden ? 'on' : ''}">${s.verbunden ? 'Verbunden' : 'Nicht verbunden'}</span></div>`;
    const links = `<div class="ig-links">
        <a href="https://app.sipgate.com/personal-access-token" target="_blank" rel="noopener"><i class="fas fa-key"></i> Token erstellen</a>
        <a href="https://app.sipgate.com/phonenumbers" target="_blank" rel="noopener"><i class="fas fa-hashtag"></i> Rufnummern bei sipgate</a>
        <a href="https://app.sipgate.com/webphone" target="_blank" rel="noopener"><i class="fas fa-globe"></i> sipgate Web-Telefon</a>
      </div>`;
    if (!s.verbunden) {
      el.innerHTML = head + `<div class="ig-body">
        <ol class="ig-steps">
          <li>In sipgate oben rechts auf deinen Namen → <b>Personal Access Token</b> → neuen Token anlegen. Name z. B. „NovaFlow CRM“, <b>alle Bereiche anhaken</b>.</li>
          <li><b>Token-ID</b> (sieht aus wie <span class="mono">token-AB12CD</span>) und den <b>Token</b> hier einfügen. Der Token wird nur einmal angezeigt.</li>
          <li>Fertig – das CRM trägt sich selbst für die Anrufmeldungen ein und ordnet Benutzer mit gleicher E-Mail automatisch zu.</li>
        </ol>
        <div class="form-group" style="margin:0"><label>Token-ID</label><input id="igSgId" class="form-control mono" placeholder="token-…" autocomplete="off"></div>
        <div class="form-group" style="margin:0"><label>Token</label><input id="igSgToken" type="password" class="form-control mono" placeholder="••••••••" autocomplete="new-password"></div>
        <button class="btn btn-primary" id="igSgVerbinden" onclick="Integrationen.sgVerbinden()"><i class="fas fa-plug"></i> sipgate verbinden</button>
        ${links}
      </div>`;
      return;
    }
    const nummern = s.nummern || [], benutzer = s.benutzer || [];
    const firmaAnzeige = s.firmennummer ? ((nummern.find(n => n.nummer === s.firmennummer) || {}).anzeige || fmtPhoneDE(s.firmennummer)) : '';
    const pool = s.pool || [];
    const poolInfo = n => { const p = pool.find(x => x.nummer === n.nummer) || {};
      return [p.bezeichnung, n.typ === 'MOBILE' ? 'Handy' : '', n.test ? 'Testnummer' : '', p.status === 'abgelaufen' ? 'abgelaufen' : p.gueltig_bis ? 'bis ' + new Date(p.gueltig_bis + 'T12:00:00').toLocaleDateString('de-DE') : '',
        p.firma ? 'Firmennummer' : '', (p.vergeben_an || []).length ? 'vergeben: ' + p.vergeben_an.map(v => v.name).join(', ') : p.firma ? '' : 'frei'].filter(Boolean).join(' · '); };
    const nrOpts = (aktuell) => `<option value="">${s.firmennummer ? 'Firmennummer (' + escHtml(firmaAnzeige) + ')' : 'Standard von sipgate'}</option>`
      + nummern.map(n => `<option value="${escHtml(n.nummer)}" ${n.nummer === aktuell ? 'selected' : ''}>${escHtml(n.anzeige)} – ${escHtml(poolInfo(n))}</option>`).join('');
    const userOpts = (aktuell, handy) => `<option value="">– nicht telefonieren –</option>`
      + `<option value="handy" ${!aktuell && handy ? 'selected' : ''}>Ohne eigenen Zugang: Handy klingelt</option>`
      + benutzer.map(b => `<option value="${escHtml(b.id)}" ${b.id === aktuell ? 'selected' : ''}>${escHtml(b.name)}</option>`).join('');
    const geraetOpts = (sUser, aktuell) => {
      const b = benutzer.find(x => x.id === sUser);
      if (!b) return '<option value="">–</option>';
      return `<option value="">Standard-Telefon</option>` + b.geraete.map(d =>
        `<option value="${escHtml(d.id)}" ${d.id === aktuell ? 'selected' : ''}>${escHtml(d.alias || d.id)}${d.online ? ' · online' : ''}</option>`).join('');
    };
    const hook = s.webhook;
    // Meldungen kamen in den letzten 14 Tagen an → eingerichtet (z. B. von Hand in sipgate)
    const zuletzt = s.webhook_zuletzt && (Date.now() - new Date(s.webhook_zuletzt).getTime() < 14 * 864e5) ? new Date(s.webhook_zuletzt) : null;
    const hookOk = (hook && hook.eingehend && hook.ausgehend) || !!zuletzt;
    // Hinweise: Testnummern laufen ab, eine Nummer bei mehreren Closern, Closer ohne Zugang
    const testNr = new Set(nummern.filter(n => n.test).map(n => n.nummer));
    const zu = (s.zuordnung || []);
    const nutzt = u => u.sipgate_nummer || s.firmennummer;
    const telefoniert = u => u.sipgate_user || u.sipgate_handy;
    const mitTest = zu.filter(u => telefoniert(u) && testNr.has(nutzt(u)));
    const proNummer = {};
    zu.filter(u => telefoniert(u) && u.sipgate_nummer).forEach(u => { (proNummer[u.sipgate_nummer] = proNummer[u.sipgate_nummer] || []).push(u.full_name); });
    const doppelt = Object.entries(proNummer).filter(([, l]) => l.length > 1);
    const ohne = zu.filter(u => u.role === 'closer' && !telefoniert(u));
    const hinweise = [
      mitTest.length || testNr.has(s.firmennummer) ? `<b>Testnummern laufen ab</b> (sipgate zeigt das Datum unter Rufnummern, z. B. „Nutzbar bis 20.11.2026“). Betroffen: ${escHtml([...(testNr.has(s.firmennummer) ? ['Firmennummer'] : []), ...mitTest.map(u => u.full_name)].join(', '))}. Rechtzeitig feste Nummern buchen und hier zuordnen.` : '',
      doppelt.length ? `<b>Gleiche Nummer bei mehreren:</b> ${doppelt.map(([n, l]) => `${escHtml(fmtPhoneDE(n))} (${escHtml(l.join(', '))})`).join('; ')}. Rückrufe auf diese Nummer klingeln nur dort, wo sie in sipgate als Ziel eingestellt ist.` : '',
      ohne.length ? `<b>Noch ohne sipgate-Zugang:</b> ${escHtml(ohne.map(u => u.full_name).join(', '))} – diese Closer können im CRM noch nicht anrufen.` : '',
    ].filter(Boolean);
    el.innerHTML = head + `<div class="ig-body">
      <div class="ig-facts">
        <div><span>Zugänge bei sipgate</span><b>${benutzer.length}</b></div>
        <div><span>Rufnummern</span><b>${nummern.length}</b></div>
        <div><span>Anrufe automatisch erfassen</span><b>${hookOk ? 'Aktiv' : 'Nicht eingerichtet'}</b>${zuletzt ? `<small>letzte Meldung ${zuletzt.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</small>` : ''}</div>
      </div>
      ${s.fehler ? `<div class="line-err"><i class="fas fa-exclamation-triangle"></i> ${escHtml(s.fehler)}</div>` : ''}
      ${!hook && !s.fehler && !hookOk ? `<div class="line-err"><i class="fas fa-exclamation-triangle"></i> Das CRM darf die Anrufmeldungen nicht selbst einrichten (dem Token fehlt der Bereich für Webhooks). Ohne sie werden Anrufe trotzdem gestartet, aber Dauer, Ergebnis und verpasste Rückrufe kommen nicht ins CRM.
        <b>So geht es ohne neuen Token:</b> in sipgate unter Webhooks (sipgate.io) diese Adresse bei <i>eingehend</i> und <i>ausgehend</i> eintragen: <span class="mono">${escHtml(s.webhookUrl)}</span>
        <button class="btn btn-ghost btn-sm" style="margin-left:6px" onclick="navigator.clipboard.writeText('${escHtml(s.webhookUrl)}').then(() => showToast('Adresse kopiert ✓'))">Adresse kopieren</button>
        Nach dem ersten Anruf steht hier „Aktiv“.</div>` : ''}
      ${hook && !hookOk ? `<div class="line-err"><i class="fas fa-exclamation-triangle"></i> Damit Anrufe automatisch beim Lead landen, muss sipgate sie an <span class="mono">${escHtml(s.webhookUrl)}</span> melden.
        ${hook.incomingUrl && !hook.eingehend ? ` Zurzeit ist dort eine andere Adresse eingetragen (<span class="mono">${escHtml(hook.incomingUrl)}</span>).` : ''}
        <button class="btn btn-ghost btn-sm" style="margin-left:6px" onclick="Integrationen.sgWebhooks()">Jetzt eintragen</button></div>` : ''}
      <div class="ig-row">
        <select id="igSgFirma" class="form-control">${nummern.length ? `<option value="" ${s.firmennummer ? '' : 'selected'}>– Firmennummer wählen –</option>` : ''}${nummern.map(n => `<option value="${escHtml(n.nummer)}" ${n.nummer === s.firmennummer ? 'selected' : ''}>${escHtml(n.anzeige)}${n.test ? ' · Testnummer' : ''}</option>`).join('') || '<option value="">Keine Nummer</option>'}</select>
        <button class="btn btn-ghost btn-sm" onclick="Integrationen.sgFirma()">Als Firmennummer</button>
      </div>
      <p class="ig-hint">Die <b>Firmennummer</b> sehen Kunden, wenn ein Vertriebler keine eigene Nummer hat. Am besten eine feste Nummer wählen, keine Testnummer.</p>
      ${hinweise.map(h => `<div class="line-err"><i class="fas fa-exclamation-triangle"></i> ${h}</div>`).join('')}
      ${this.poolHtml(pool)}
      <div class="modal-section-label" style="margin:4px 0 0">Wer telefoniert womit?</div>
      <div class="sg-map">
        <div class="sg-map-head"><span>CRM-Benutzer</span><span>sipgate-Zugang</span><span>Telefon, das klingelt</span><span>Nummer, die Kunden sehen</span></div>
        ${(s.zuordnung || []).map(u => `<div class="sg-map-row" data-id="${u.id}">
          <b>${escHtml(u.full_name)}<small>${u.role === 'admin' ? 'Admin' : 'Closer'}</small></b>
          <select class="form-control" data-f="sipgate_user" onchange="Integrationen.sgZuordnen(${u.id}, this)">${userOpts(u.sipgate_user, u.sipgate_handy)}</select>
          ${!u.sipgate_user && u.sipgate_handy
            ? `<input class="form-control" data-f="sipgate_handy" placeholder="Handy, z. B. 0171 1234567" value="${escHtml(u.sipgate_handy ? fmtPhoneDE(u.sipgate_handy) : '')}" onchange="Integrationen.sgZuordnen(${u.id})" title="Dieses Handy klingelt zuerst. Kunden sehen es nicht, sie sehen die Nummer rechts.">`
            : `<select class="form-control" data-f="sipgate_device" onchange="Integrationen.sgZuordnen(${u.id})" ${u.sipgate_user ? '' : 'disabled'}>${geraetOpts(u.sipgate_user, u.sipgate_device)}</select>`}
          <select class="form-control" data-f="sipgate_nummer" onchange="Integrationen.sgZuordnen(${u.id})" ${telefoniert(u) ? '' : 'disabled'}>${nrOpts(u.sipgate_nummer)}</select>
        </div>`).join('')}
      </div>
      <p class="ig-hint"><b>Ohne eigenen Zugang</b> (zum Testen, ohne zusätzliche sipgate-Benutzer): „Anrufen“ läuft über deinen sipgate-Zugang, zuerst klingelt das Handy des Closers, Kunden sehen die Nummer rechts. Dabei fallen zwei Gesprächsstrecken an (Closer und Kunde). Rückrufe klingeln dort, wo die Nummer in sipgate als Ziel eingestellt ist.</p>
      <p class="ig-hint">Mit eigenem Zugang: Jeder, der telefonieren soll, braucht einen eigenen <b>sipgate-Zugang</b> (in sipgate unter Benutzer anlegen) und dort ein Telefon – am einfachsten die <b>sipgate App</b> auf dem Handy oder das <b>Web-Telefon</b> im Browser. Testnummern von sipgate laufen zum angegebenen Datum ab; danach eine feste Nummer zuordnen.</p>
      ${links}
      <button class="btn btn-ghost btn-sm ig-trennen" onclick="Integrationen.sgTrennen()"><i class="fas fa-unlink"></i> Verbindung trennen</button>
    </div>`;
  },

  async sgVerbinden() {
    const btn = document.getElementById('igSgVerbinden');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verbinde …';
    try {
      const r = await api('POST', '/sipgate/setup', { tokenId: document.getElementById('igSgId').value, token: document.getElementById('igSgToken').value });
      showToast('sipgate verbunden ✓');
      if (r.hinweis) showToast(r.hinweis, 'err');
      if (typeof Sipgate !== 'undefined') Sipgate.loadConfig();
      this.loadSipgate();
    } catch (e) { showToast(e.message, 'err'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-plug"></i> sipgate verbinden'; }
  },
  // ── Nummern-Pool: Ablaufdatum, Bezeichnung, eigene Nummern, verteilen ──
  poolHtml(pool) {
    const tag = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('de-DE') : '';
    const STATUS = { frei: ['ok', 'frei'], vergeben: ['', 'vergeben'], laeuft_ab: ['warn', 'läuft bald ab'], abgelaufen: ['err', 'abgelaufen'], fehlt: ['err', 'nicht in sipgate'] };
    const zeile = n => {
      const [cls, txt] = STATUS[n.status] || ['', n.status];
      const wer = [n.firma ? 'Firmennummer' : '', ...n.vergeben_an.map(v => v.name)].filter(Boolean).join(', ');
      return `<div class="sg-pool-row" data-nr="${escHtml(n.nummer)}">
        <b>${escHtml(n.anzeige)}<small>${[n.typ === 'MOBILE' ? 'Handy' : '', n.test ? 'Testnummer' : '', n.manuell ? 'selbst eingetragen' : ''].filter(Boolean).join(' · ') || 'Festnetz'}</small></b>
        <input class="form-control" data-f="bezeichnung" maxlength="100" placeholder="z. B. Krefeld, Maria" value="${escHtml(n.bezeichnung)}" onchange="Integrationen.poolSpeichern(this)">
        <input class="form-control" type="date" data-f="gueltig_bis" value="${escHtml(n.gueltig_bis || '')}" onchange="Integrationen.poolSpeichern(this)" title="Nutzbar bis (leer = unbegrenzt)">
        <span class="sg-pool-wer">${escHtml(wer) || '<em>niemand</em>'}</span>
        <span class="sg-pool-st ${cls}">${txt}${n.ohne_datum ? '<br><em>Datum fehlt</em>' : ''}</span>
        ${n.manuell || n.in_sipgate === false ? `<button class="btn btn-ghost btn-sm btn-icon" title="Aus dem Pool entfernen" onclick="Integrationen.poolEntfernen('${escHtml(n.nummer)}')"><i class="fas fa-trash"></i></button>` : '<span></span>'}
      </div>`;
    };
    const frei = pool.filter(n => n.status === 'frei').length;
    return `<div class="modal-section-label" style="margin:4px 0 0">Nummern-Pool <span class="sg-pool-zahl">${pool.length} Nummern · ${frei} frei</span></div>
      <div class="sg-pool">
        <div class="sg-pool-head"><span>Nummer</span><span>Bezeichnung</span><span>Nutzbar bis</span><span>Genutzt von</span><span>Status</span><span></span></div>
        ${pool.map(zeile).join('') || '<div class="sg-pool-row"><em>Noch keine Nummern. In sipgate Nummern buchen, sie erscheinen hier automatisch.</em></div>'}
        <div class="sg-pool-row sg-pool-neu">
          <input class="form-control" id="poolNeuNr" placeholder="Neue Nummer, z. B. 02151 9719631">
          <input class="form-control" id="poolNeuBez" maxlength="100" placeholder="Bezeichnung">
          <input class="form-control" id="poolNeuBis" type="date" title="Nutzbar bis (leer = unbegrenzt)">
          <button class="btn btn-ghost btn-sm" onclick="Integrationen.poolNeu()"><i class="fas fa-plus"></i> Hinzufügen</button>
          <span></span><span></span>
        </div>
      </div>
      <div class="ig-row">
        <button class="btn btn-ghost btn-sm" onclick="Integrationen.poolVerteilen()"><i class="fas fa-random"></i> Freie Nummern an Closer ohne Nummer verteilen</button>
        ${pool.some(n => n.ohne_datum) ? `<button class="btn btn-ghost btn-sm" onclick="Integrationen.poolTestDatum()"><i class="fas fa-calendar-alt"></i> Ablaufdatum für alle Testnummern setzen</button>` : ''}
      </div>
      <p class="ig-hint">Nummern aus sipgate erscheinen hier automatisch. Trag bei <b>Testnummern</b> das Datum aus sipgate ein („Nutzbar bis …“), dann erinnert dich „Heute → Fällig“ 14 Tage vorher. Neue Closer bekommen beim ersten Zuordnen automatisch eine freie Nummer, feste Nummern zuerst. Abgelaufene Nummern werden nicht mehr gesendet, dann sehen Kunden die Firmennummer. Selbst eingetragene Nummern müssen auch in sipgate gebucht sein.</p>`;
  },
  async poolSpeichern(el) {
    const row = el.closest('.sg-pool-row');
    const v = f => row.querySelector(`[data-f="${f}"]`).value;
    try {
      await api('PUT', `/sipgate/nummern/${encodeURIComponent(row.dataset.nr)}`, { bezeichnung: v('bezeichnung'), gueltig_bis: v('gueltig_bis') || null });
      showToast('Gespeichert ✓');
      if (el.dataset.f === 'gueltig_bis') this.loadSipgate();
    } catch (e) { showToast(e.message, 'err'); }
  },
  async poolNeu() {
    const nr = document.getElementById('poolNeuNr').value.trim();
    if (!nr) return showToast('Bitte eine Nummer eingeben', 'err');
    try {
      await api('POST', '/sipgate/nummern', { nummer: nr, bezeichnung: document.getElementById('poolNeuBez').value, gueltig_bis: document.getElementById('poolNeuBis').value || null });
      showToast('Nummer hinzugefügt ✓');
      this.loadSipgate();
    } catch (e) { showToast(e.message, 'err'); }
  },
  async poolEntfernen(nr) {
    if (!await customConfirm('Wer die Nummer nutzt, telefoniert danach mit der Firmennummer.', { title: 'Nummer aus dem Pool entfernen?', okLabel: 'Entfernen', danger: true })) return;
    try { const r = await api('DELETE', `/sipgate/nummern/${encodeURIComponent(nr)}`); showToast(r.freigegeben ? `Entfernt, ${r.freigegeben} Benutzer jetzt mit Firmennummer` : 'Entfernt'); this.loadSipgate(); }
    catch (e) { showToast(e.message, 'err'); }
  },
  async poolTestDatum() {
    const ein = (prompt('Bis wann sind die Testnummern nutzbar? (steht in sipgate unter Rufnummern, z. B. 20.11.2026)', '') || '').trim();
    if (!ein) return;
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(ein);
    if (!m) return showToast('Bitte als TT.MM.JJJJ eingeben, z. B. 20.11.2026', 'err');
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    try {
      const { nummern } = await api('GET', '/sipgate/nummern');
      const test = nummern.filter(n => n.test && !n.gueltig_bis);
      for (const n of test) await api('PUT', `/sipgate/nummern/${encodeURIComponent(n.nummer)}`, { bezeichnung: n.bezeichnung, gueltig_bis: iso });
      showToast(`${test.length} Testnummern: nutzbar bis ${ein} ✓`);
      this.loadSipgate();
    } catch (e) { showToast(e.message, 'err'); }
  },
  async poolVerteilen() {
    try {
      const r = await api('POST', '/sipgate/nummern/verteilen');
      const ok = r.verteilt.filter(v => v.nummer), ohne = r.verteilt.filter(v => !v.nummer);
      showToast(ok.length ? ok.map(v => `${v.name}: ${v.anzeige}`).join(' · ') : 'Alle Closer mit sipgate-Zugang haben schon eine Nummer');
      if (ohne.length) showToast(`Keine freie Nummer mehr für: ${ohne.map(v => v.name).join(', ')} – in sipgate weitere Nummern buchen`, 'err');
      this.loadSipgate();
    } catch (e) { showToast(e.message, 'err'); }
  },
  async sgZuordnen(userId, userSelect) {
    const row = document.querySelector(`.sg-map-row[data-id="${userId}"]`);
    const wert = f => row.querySelector(`[data-f="${f}"]`)?.value || null;
    const art = wert('sipgate_user');
    // „Handy klingelt“: erst die Nummer abfragen, dann speichern
    if (art === 'handy') {
      let handy = userSelect ? null : wert('sipgate_handy');
      if (!handy) handy = (prompt('Handynummer des Closers, die zuerst klingelt (Kunden sehen sie nicht):', '') || '').trim();
      if (!handy) { this.loadSipgate(); return; }
      try {
        const r = await api('PUT', `/sipgate/zuordnung/${userId}`, { sipgate_user: null, sipgate_handy: handy, sipgate_nummer: userSelect ? null : wert('sipgate_nummer') });
        showToast(r.automatisch ? `Gespeichert ✓ – Nummer ${fmtPhoneDE(r.nummer)} aus dem Pool zugewiesen` : 'Gespeichert ✓');
      } catch (e) { showToast(e.message, 'err'); }
      this.loadSipgate();
      return;
    }
    const body = { sipgate_user: art, sipgate_device: userSelect ? null : wert('sipgate_device'), sipgate_nummer: wert('sipgate_nummer') };
    if (!body.sipgate_user) { body.sipgate_device = null; body.sipgate_nummer = null; }
    try {
      const r = await api('PUT', `/sipgate/zuordnung/${userId}`, body);
      showToast(r.automatisch ? `Gespeichert ✓ – Nummer ${fmtPhoneDE(r.nummer)} aus dem Pool zugewiesen` : 'Gespeichert ✓');
      if (typeof Sipgate !== 'undefined') Sipgate.loadConfig();
      if (userSelect) this.loadSipgate();
    } catch (e) { showToast(e.message, 'err'); }
  },
  async sgFirma() {
    try { await api('PUT', '/sipgate/firmennummer', { nummer: document.getElementById('igSgFirma').value }); showToast('Firmennummer gespeichert ✓'); this.loadSipgate(); }
    catch (e) { showToast(e.message, 'err'); }
  },
  async sgWebhooks() {
    if (this._sg && this._sg.webhook && (this._sg.webhook.incomingUrl || this._sg.webhook.outgoingUrl)
      && !await customConfirm('In sipgate ist schon eine andere Adresse für Anrufmeldungen eingetragen (z. B. für einen KI-Assistenten). Soll das CRM sie ersetzen?', { title: 'Adresse ersetzen?', okLabel: 'Ersetzen' })) return;
    try {
      const r = await api('POST', '/sipgate/webhooks', { ersetzen: true });
      showToast(r.incoming && r.outgoing ? 'Anrufmeldungen eingerichtet ✓' : 'In sipgate unter Webhooks die CRM-Adresse von Hand eintragen', r.incoming && r.outgoing ? undefined : 'err');
      this.loadSipgate();
    } catch (e) { showToast(e.message, 'err'); }
  },
  async sgTrennen() {
    if (!await customConfirm('Danach startet „Anrufen“ im CRM keine sipgate-Anrufe mehr. Nummern und Vertrag bleiben bei sipgate.', { title: 'sipgate trennen?', okLabel: 'Trennen', danger: true })) return;
    try { await api('DELETE', '/sipgate/setup'); showToast('Getrennt'); if (typeof Sipgate !== 'undefined') Sipgate.loadConfig(); this.loadSipgate(); } catch (e) { showToast(e.message, 'err'); }
  },

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
