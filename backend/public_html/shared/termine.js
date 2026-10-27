// ============================================================
// Termine: Übergabe an Closer und Terminübersicht
// Admin schlägt einem Closer einen Termin vor (auch mit neuem Lead, z. B. aus
// Instagram/LinkedIn). Der Closer nimmt an, lehnt ab oder schlägt eine andere
// Zeit vor. „Termine“ zeigt alles nach Tagen, mit Telefon und Lead-Link.
// Eingebunden in admin.html und closer.html über Termine.mount().
// ============================================================
const Termine = {
  opts: {}, rows: [], users: [], filterCloser: '', zeigeVergangen: false,
  _badgeTimer: null, _offen: null,
  QUELLEN: ['Instagram', 'LinkedIn', 'Facebook', 'Empfehlung', 'Website', 'Telefon', 'Sonstiges'],
  STATUS: {
    vorgeschlagen: ['Wartet auf Antwort', 'warte'], gegenvorschlag: ['Andere Zeit vorgeschlagen', 'gegen'],
    angenommen: ['Bestätigt', 'ok'], abgelehnt: ['Abgelehnt', 'nein'], abgesagt: ['Abgesagt', 'aus'], erledigt: ['Erledigt', 'aus'],
  },

  mount(opts) {
    this.opts = opts;
    const root = document.getElementById(opts.rootId);
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    root.innerHTML = `
      <div class="page-header">
        <div><h1 data-eyebrow="Kalender">Termine</h1><p class="page-desc">${opts.isAdmin
          ? 'Termine an Closer übergeben und alle Termine im Blick behalten'
          : 'Deine Termine nach Tagen – Anfragen vom Admin oben'}</p></div>
        <div class="page-actions">
          ${opts.isAdmin ? '<select id="trCloserFilter" class="form-control" style="width:auto" onchange="Termine.filterCloser=this.value;Termine.load()"><option value="">Alle Closer</option></select>' : ''}
          <button class="btn btn-ghost btn-sm btn-icon" onclick="Termine.load()" title="Aktualisieren"><i class="fas fa-sync"></i></button>
          ${opts.isAdmin ? '<button class="btn btn-primary" onclick="Termine.openEditor()"><i class="fas fa-calendar-plus"></i> Termin übergeben</button>' : ''}
        </div>
      </div>
      <div id="trAnfragen"></div>
      <div id="trListe"></div>
      <div class="tr-past-toggle"><button class="btn btn-ghost btn-sm" id="trPastBtn" onclick="Termine.zeigeVergangen=!Termine.zeigeVergangen;Termine.render()"></button></div>
      <div id="trVergangen"></div>`;
  },

  async _users() {
    if (!this.opts.isAdmin || this.users.length) return this.users;
    this.users = (await api('GET', '/users').catch(() => [])).filter(u => u.is_active);
    const sel = document.getElementById('trCloserFilter');
    if (sel) sel.innerHTML = '<option value="">Alle Closer</option>' + this.users.map(u =>
      `<option value="${u.id}">${escHtml(u.full_name)}</option>`).join('');
    return this.users;
  },

  async load() {
    try {
      await this._users();
      this.rows = await api('GET', '/termine' + (this.filterCloser ? `?closer=${this.filterCloser}` : ''));
      this.render();
      this.refreshBadge();
    } catch (e) { showToast(e.message, 'err'); }
  },

  // ── Zeiten ───────────────────────────────────────────────────
  _d(sql) { return new Date(String(sql).replace(' ', 'T')); },
  _uhr(sql) { return String(sql).slice(11, 16); },
  _tag(d) {
    const heute = new Date(); heute.setHours(0, 0, 0, 0);
    const t = new Date(d); t.setHours(0, 0, 0, 0);
    const diff = Math.round((t - heute) / 864e5);
    const datum = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
    if (diff === 0) return `Heute · ${datum}`;
    if (diff === 1) return `Morgen · ${datum}`;
    if (diff === -1) return `Gestern · ${datum}`;
    return datum;
  },
  _lang(sql) {
    return this._d(sql).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ', ' + this._uhr(sql) + ' Uhr';
  },
  _wann(a) {
    return a.art === 'anruf_bis' ? 'Anruf bis ' + this._d(a.starts_at).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) : this._lang(a.starts_at);
  },
  _sql(datum, uhr) { return `${datum} ${uhr}:00`; },
  _iso(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },

  // ── Darstellung ──────────────────────────────────────────────
  render() {
    const jetzt = Date.now();
    const admin = this.opts.isAdmin;
    const ende = a => a.art === 'anruf_bis' ? this._d(a.starts_at.slice(0, 10) + ' 23:59:59').getTime()
      : this._d(a.starts_at).getTime() + (a.duration_min || 30) * 60000;
    const offen = this.rows.filter(a => admin
      ? ['gegenvorschlag', 'abgelehnt', 'vorgeschlagen'].includes(a.status)
      : a.status === 'vorgeschlagen');
    const kommend = this.rows.filter(a => a.status === 'angenommen' && ende(a) >= jetzt);
    const vergangen = this.rows.filter(a => !offen.includes(a) && !kommend.includes(a)).reverse();

    // Oben: was eine Antwort braucht
    const anfr = document.getElementById('trAnfragen');
    anfr.innerHTML = offen.length ? `
      <section class="card tr-anfragen">
        <div class="card-header"><div class="card-title"><i class="fas fa-inbox"></i> ${admin ? 'Übergaben' : 'Neue Terminanfragen'} <span class="badge">${offen.length}</span></div></div>
        <div class="tr-cards">${offen.map(a => this._anfrage(a)).join('')}</div>
      </section>` : '';

    // Kommende Termine nach Tagen
    const tage = {};
    kommend.forEach(a => { const k = a.starts_at.slice(0, 10); (tage[k] = tage[k] || []).push(a); });
    document.getElementById('trListe').innerHTML = Object.keys(tage).length
      ? Object.entries(tage).map(([k, list]) => `
          <section class="tr-day">
            <h3 class="tr-day-head">${escHtml(this._tag(this._d(k + ' 00:00:00')))} <span>${list.length} ${list.length === 1 ? 'Termin' : 'Termine'}</span></h3>
            <div class="card tr-day-list">${list.map(a => this._zeile(a)).join('')}</div>
          </section>`).join('')
      : `<div class="card tr-empty"><i class="fas fa-calendar-check"></i><div><b>Keine anstehenden Termine</b><span>${admin
          ? 'Vereinbarte Termine hier an einen Closer übergeben – er wird sofort benachrichtigt.'
          : 'Sobald du einen Termin vereinbarst oder der Admin dir einen gibt, steht er hier.'}</span></div></div>`;

    const btn = document.getElementById('trPastBtn');
    btn.hidden = !vergangen.length;
    btn.innerHTML = `<i class="fas fa-chevron-${this.zeigeVergangen ? 'up' : 'down'}"></i> Vergangene und abgesagte (${vergangen.length})`;
    document.getElementById('trVergangen').innerHTML = this.zeigeVergangen && vergangen.length
      ? `<div class="card tr-day-list is-past">${vergangen.map(a => this._zeile(a, true)).join('')}</div>` : '';
  },

  _status(a) {
    const [t, c] = this.STATUS[a.status] || [a.status, ''];
    return `<span class="tr-status s-${c}">${escHtml(t)}</span>`;
  },

  _anfrage(a) {
    const admin = this.opts.isAdmin;
    const kopf = `
      <div class="tr-card-when"><b>${escHtml(this._wann(a))}</b>${a.art === 'anruf_bis' ? '' : ` · ${a.duration_min} Min.`} ${this._status(a)}${a.uebergabe ? ' <span class="tr-status s-warm">Warme Übergabe</span>' : ''}</div>
      <div class="tr-card-who">${escHtml(a.company || '—')}${a.ceo ? ` <span>· ${escHtml(a.ceo)}</span>` : ''}</div>
      ${a.topic ? `<div class="tr-card-topic">${escHtml(a.topic)}</div>` : ''}
      ${a.painpoints ? `<div class="tr-card-notes tr-pain"><i class="fas fa-quote-left"></i>${escHtml(a.painpoints)}</div>` : ''}
      ${a.website ? `<a class="tr-card-link" href="${escHtml(absUrl(a.website))}" target="_blank" rel="noopener"><i class="fas fa-globe"></i>${escHtml(a.website)}</a>` : ''}
      ${a.notes ? `<div class="tr-card-notes"><i class="fas fa-sticky-note"></i>${escHtml(a.notes)}</div>` : ''}
      <div class="tr-card-meta">${[
        admin ? `<span><i class="fas fa-user"></i>${escHtml(a.closer_name || '')}</span>` : `<span><i class="fas fa-user-tie"></i>von ${escHtml(a.proposed_name || 'Admin')}</span>`,
        this.QUELLEN.includes(a.source) ? `<span><i class="fas fa-tag"></i>${escHtml(a.source)}</span>` : '',
        a.phone ? `<span class="mono"><i class="fas fa-phone"></i>${escHtml(a.phone)}</span>` : '',
      ].join('')}</div>`;
    let unten = '';
    if (!admin) {
      unten = `<div class="tr-card-actions">
        <button class="btn btn-primary btn-sm" onclick="Termine.antworten(${a.id}, 'annehmen')"><i class="fas fa-check"></i> Annehmen</button>
        <button class="btn btn-ghost btn-sm" onclick="Termine.openGegen(${a.id})"><i class="fas fa-clock"></i> Andere Zeit</button>
        <button class="btn btn-ghost btn-sm tr-nein" onclick="Termine.openAblehnen(${a.id})"><i class="fas fa-times"></i> Ablehnen</button>
      </div>`;
    } else if (a.status === 'gegenvorschlag') {
      unten = `<div class="tr-card-reply"><i class="fas fa-reply"></i><span><b>${escHtml(a.closer_name)}</b> schlägt <b>${escHtml(this._lang(a.counter_at))}</b> vor${a.response_note ? ': „' + escHtml(a.response_note) + '“' : ''}</span></div>
        <div class="tr-card-actions">
          <button class="btn btn-primary btn-sm" onclick="Termine.antworten(${a.id}, 'annehmen')"><i class="fas fa-check"></i> Neue Zeit übernehmen</button>
          <button class="btn btn-ghost btn-sm" onclick="Termine.openEditor({ id: ${a.id} })"><i class="fas fa-edit"></i> Neu planen</button>
          <button class="btn btn-ghost btn-sm tr-nein" onclick="Termine.absagen(${a.id})"><i class="fas fa-ban"></i> Absagen</button>
        </div>`;
    } else if (a.status === 'abgelehnt') {
      unten = `<div class="tr-card-reply is-no"><i class="fas fa-times-circle"></i><span><b>${escHtml(a.closer_name)}</b> kann nicht${a.response_note ? ': „' + escHtml(a.response_note) + '“' : ''}</span></div>
        <div class="tr-card-actions">
          <button class="btn btn-primary btn-sm" onclick="Termine.openUebergeben(${a.id})"><i class="fas fa-user-friends"></i> Anderem Closer geben</button>
          <button class="btn btn-ghost btn-sm tr-nein" onclick="Termine.absagen(${a.id})"><i class="fas fa-ban"></i> Absagen</button>
        </div>`;
    } else {
      unten = `<div class="tr-card-actions">
          <button class="btn btn-ghost btn-sm" onclick="Termine.openEditor({ id: ${a.id} })"><i class="fas fa-edit"></i> Ändern</button>
          <button class="btn btn-ghost btn-sm" onclick="Termine.openUebergeben(${a.id})"><i class="fas fa-user-friends"></i> Anderem Closer</button>
          <button class="btn btn-ghost btn-sm tr-nein" onclick="Termine.absagen(${a.id})"><i class="fas fa-ban"></i> Zurückziehen</button>
        </div>`;
    }
    return `<div class="tr-card s-${(this.STATUS[a.status] || [])[1] || ''}">${kopf}${unten}</div>`;
  },

  _zeile(a, vergangen = false) {
    const admin = this.opts.isAdmin;
    const eigen = a.closer_id === (typeof ME !== 'undefined' ? ME?.id : null);
    const laeuft = !vergangen && this._d(a.starts_at).getTime() <= Date.now();
    const darfLead = admin || a.assigned_to === ME?.id;
    return `<div class="tr-row ${laeuft ? 'is-now' : ''} ${vergangen ? 'is-past' : ''}">
      <div class="tr-time">${a.art === 'anruf_bis' ? '<b class="tr-bis">bis</b><span>Anruf</span>' : `<b>${this._uhr(a.starts_at)}</b><span>${vergangen ? escHtml(this._d(a.starts_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })) : a.duration_min + ' Min.'}</span>`}</div>
      <div class="tr-main" ${darfLead ? `onclick="Termine.opts.openLead(${a.lead_id})"` : ''}>
        <div class="tr-title">${escHtml(a.company || '—')}${a.ceo ? ` <span>· ${escHtml(a.ceo)}</span>` : ''} ${vergangen || a.status !== 'angenommen' ? this._status(a) : ''}</div>
        ${a.topic ? `<div class="tr-topic">${escHtml(a.topic)}</div>` : ''}
        ${a.painpoints ? `<div class="tr-notes tr-pain"><i class="fas fa-quote-left"></i>${escHtml(a.painpoints)}</div>` : ''}
        ${a.notes ? `<div class="tr-notes"><i class="fas fa-sticky-note"></i>${escHtml(a.notes)}</div>` : ''}
        <div class="tr-meta">${[
          admin ? `<span><i class="fas fa-user"></i>${escHtml(a.closer_name || '')}</span>` : '',
          this.QUELLEN.includes(a.source) ? `<span><i class="fas fa-tag"></i>${escHtml(a.source)}</span>` : '',
          a.proposed_by && a.proposed_by !== a.closer_id && !admin ? `<span><i class="fas fa-user-tie"></i>von ${escHtml(a.proposed_name || 'Admin')}</span>` : '',
        ].join('')}</div>
      </div>
      <div class="tr-actions">
        ${a.phone && !vergangen ? `<button class="btn btn-ghost btn-sm today-call" onclick="Termine.anrufen(${a.lead_id}, ${escHtml(JSON.stringify(a.phone))})" title="Anrufen ${escHtml(a.phone)}"><i class="fas fa-phone-alt"></i> <span class="mono">${escHtml(a.phone)}</span></button>` : ''}
        ${darfLead ? `<button class="btn btn-ghost btn-sm btn-icon" onclick="Termine.opts.openLead(${a.lead_id})" title="Lead öffnen"><i class="fas fa-external-link-alt"></i></button>` : ''}
        ${!vergangen ? `<button class="btn btn-ghost btn-sm btn-icon" onclick="Termine.ics(${a.id})" title="In meinen Kalender (.ics)"><i class="fas fa-calendar-plus"></i></button>` : ''}
        ${!vergangen && admin ? `<button class="btn btn-ghost btn-sm tr-ueb-btn" onclick="Termine.openUebergeben(${a.id})" title="Diesen Termin einem Closer geben"><i class="fas fa-user-friends"></i><span class="tr-ueb-txt"> ${a.closer_id === ME?.id ? 'An Closer übergeben' : 'Anderem Closer'}</span></button>` : ''}
        ${!vergangen && (admin || eigen) ? `
          <button class="btn btn-ghost btn-sm btn-icon" onclick="Termine.erledigt(${a.id})" title="Erledigt"><i class="fas fa-check"></i></button>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="Termine.openEditor({ id: ${a.id} })" title="Ändern"><i class="fas fa-edit"></i></button>
          <button class="btn btn-ghost btn-sm btn-icon tr-nein" onclick="Termine.absagen(${a.id})" title="Absagen"><i class="fas fa-ban"></i></button>` : ''}
      </div>
    </div>`;
  },

  anrufen(leadId, phone) {
    if (typeof this.opts.call === 'function') this.opts.call(leadId, phone);
    else window.location.href = 'tel:' + String(phone).replace(/[^\d+]/g, '');
  },

  // ── Aktionen ─────────────────────────────────────────────────
  async antworten(id, aktion, extra = {}) {
    try {
      await api('POST', `/termine/${id}/antwort`, { aktion, ...extra });
      showToast({
        annehmen: this.opts.isAdmin ? 'Neue Zeit übernommen – der Termin steht' : 'Termin angenommen – der Lead gehört jetzt dir',
        ablehnen: 'Abgelehnt – der Admin ist informiert',
        gegenvorschlag: 'Vorschlag an den Admin gesendet',
      }[aktion]);
      this._close();
      this.load();
      if (typeof this.opts.onChange === 'function') this.opts.onChange();
    } catch (e) { showToast(e.message, 'err'); }
  },
  async _patch(id, body, msg) {
    try {
      await api('PATCH', `/termine/${id}`, body);
      showToast(msg);
      this.load();
      if (typeof this.opts.onChange === 'function') this.opts.onChange();
    } catch (e) { showToast(e.message, 'err'); }
  },
  erledigt(id) { this._patch(id, { status: 'erledigt' }, 'Als erledigt markiert'); },
  absagen(id) {
    const a = this.rows.find(x => x.id === id);
    if (!confirm(`Termin${a ? ' mit ' + a.company : ''} wirklich absagen?`)) return;
    this._patch(id, { status: 'abgesagt' }, 'Termin abgesagt');
  },

  // .ics-Datei für Google-, Apple- oder Outlook-Kalender
  ics(id) {
    const a = this.rows.find(x => x.id === id);
    if (!a) return;
    const f = sql => sql.slice(0, 10).replace(/-/g, '') + 'T' + sql.slice(11, 16).replace(':', '') + '00';
    const endD = new Date(this._d(a.starts_at).getTime() + (a.duration_min || 30) * 60000);
    const p = n => String(n).padStart(2, '0');
    const end = `${endD.getFullYear()}${p(endD.getMonth() + 1)}${p(endD.getDate())}T${p(endD.getHours())}${p(endD.getMinutes())}00`;
    const t = s => String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
    const desc = [a.ceo && 'Ansprechpartner: ' + a.ceo, a.phone && 'Telefon: ' + a.phone, a.email && 'E-Mail: ' + a.email, a.notes].filter(Boolean).join('\n');
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NovaFlow CRM//Termine//DE', 'BEGIN:VEVENT',
      `UID:termin-${a.id}@novaflow-crm`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART:${f(a.starts_at)}`, `DTEND:${end}`,
      `SUMMARY:${t((a.topic ? a.topic + ' – ' : 'Termin – ') + (a.company || ''))}`, `DESCRIPTION:${t(desc)}`,
      'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Termin', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    link.download = `Termin-${(a.company || 'Kunde').replace(/[^\wäöüÄÖÜß-]+/g, '-')}.ics`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  },

  // ── Fenster ──────────────────────────────────────────────────
  _modal(title, icon, body, footer) {
    this._close();
    const el = document.createElement('div');
    el.className = 'modal-overlay open';
    el.id = 'trModal';
    el.onclick = e => { if (e.target === el) this._close(); };
    el.innerHTML = `<div class="modal modal-flex" style="max-width:560px">
      <div class="modal-header">
        <div class="modal-heading"><div class="modal-icon"><i class="fas ${icon}"></i></div><div class="modal-title">${title}</div></div>
        <button class="modal-x" onclick="Termine._close()" title="Schließen"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">${body}<div class="tr-err" id="trErr"></div><div class="modal-actions">${footer}</div></div>
    </div>`;
    document.body.appendChild(el);
    return el;
  },
  _close() { document.getElementById('trModal')?.remove(); },
  _err(msg) { const e = document.getElementById('trErr'); if (e) e.innerHTML = msg; },

  openGegen(id) {
    const a = this.rows.find(x => x.id === id);
    const d = this._d(a.starts_at);
    this._modal('Andere Zeit vorschlagen', 'fa-clock', `
      <p class="tr-hint">Vorschlag vom Admin: <b>${escHtml(this._lang(a.starts_at))}</b> mit ${escHtml(a.company)}. Wann passt es dir?</p>
      <div class="tr-grid2">
        <div class="form-group" style="margin:0"><label>Datum</label><input type="date" id="trGDate" class="form-control" value="${this._iso(d)}"></div>
        <div class="form-group" style="margin:0"><label>Uhrzeit</label><input type="time" id="trGTime" class="form-control" step="900" value="${this._uhr(a.starts_at)}"></div>
      </div>
      <div class="form-group" style="margin:0"><label>Nachricht an den Admin <span class="tr-opt">(optional)</span></label><input type="text" id="trGNote" class="form-control" placeholder="z. B. Vormittags bin ich im Termin, ab 14 Uhr frei"></div>`,
      `<button class="btn btn-ghost btn-sm" onclick="Termine._close()">Abbrechen</button>
       <button class="btn btn-primary btn-sm" onclick="Termine.antworten(${id}, 'gegenvorschlag', { starts_at: Termine._sql(document.getElementById('trGDate').value, document.getElementById('trGTime').value), note: document.getElementById('trGNote').value })"><i class="fas fa-paper-plane"></i> Vorschlag senden</button>`);
  },

  openAblehnen(id) {
    const a = this.rows.find(x => x.id === id);
    this._modal('Termin ablehnen', 'fa-times', `
      <p class="tr-hint">${escHtml(a.company)} · ${escHtml(this._lang(a.starts_at))}. Der Admin gibt den Termin dann an jemand anderen.</p>
      <div class="form-group" style="margin:0"><label>Grund <span class="tr-opt">(optional)</span></label><input type="text" id="trANote" class="form-control" placeholder="z. B. Bin an dem Tag nicht da"></div>`,
      `<button class="btn btn-ghost btn-sm" onclick="Termine._close()">Abbrechen</button>
       <button class="btn btn-primary btn-sm" onclick="Termine.antworten(${id}, 'ablehnen', { note: document.getElementById('trANote').value })">Ablehnen</button>`);
  },

  // Vorhandenen Termin (z. B. selbst vereinbart) einem Closer geben: nur Closer, Thema,
  // Painpoints und Notiz. Der Lead wandert sofort mit, der Closer nimmt an oder lehnt ab.
  async openUebergeben(id) {
    const a = this.rows.find(x => x.id === id);
    if (!a) return;
    const users = await this._users();
    const closers = users.filter(u => u.role === 'closer' && u.id !== a.closer_id);
    if (!closers.length) return showToast('Es gibt noch keinen anderen aktiven Closer. Zuerst unter „Benutzer“ anlegen.', 'err');
    this._modal('An Closer übergeben', 'fa-user-friends', `
      <div class="tr-lead"><i class="fas fa-building"></i><b>${escHtml(a.company || '')}</b>${a.ceo ? ' · ' + escHtml(a.ceo) : ''}
        <span class="tr-lead-wann">${escHtml(this._wann(a))}</span></div>
      <div class="form-group" style="margin:0"><label>An wen? <span class="tr-req">*</span></label>
        <div class="tr-closer-pick" id="trUCloser">${closers.map(u => `<button type="button" class="qf-btn" data-id="${u.id}"
          onclick="this.parentNode.querySelectorAll('.qf-btn').forEach(b => b.classList.toggle('active', b === this))">${escHtml(u.full_name)}</button>`).join('')}</div></div>
      <div class="form-group" style="margin:0"><label>Thema <span class="tr-req">*</span></label><input type="text" id="trUTopic" class="form-control" value="${escHtml(a.topic || '')}" placeholder="eine Zeile, z. B. Anfragen über Instagram automatisieren"></div>
      <div class="form-group" style="margin:0"><label>Painpoints <span class="tr-req">*</span> <span class="tr-opt">kurz, in Worten des Kunden</span></label>
        <textarea id="trUPain" class="form-control" rows="2" placeholder="z. B. „Ich komme abends nicht hinterher mit den WhatsApp-Anfragen“">${escHtml(a.painpoints || '')}</textarea></div>
      <div class="form-group" style="margin:0"><label>Notizen für den Closer <span class="tr-opt">(optional)</span></label><textarea id="trUNotes" class="form-control" rows="2" placeholder="Was weiß der Kunde schon? Worauf achten?">${escHtml(a.notes || '')}</textarea></div>
      <label class="tr-check"><input type="checkbox" id="trUMail" checked> Closer zusätzlich per E-Mail benachrichtigen</label>
      <p class="tr-hint">Der Lead gehört sofort dem Closer. Lehnt er ab, geht der Lead zurück und der Termin steht wieder bei dir unter „Übergaben“.</p>`,
      `<button class="btn btn-ghost btn-sm" onclick="Termine._close()">Abbrechen</button>
       <button class="btn btn-primary btn-sm" id="trUSave" onclick="Termine.uebergeben(${id})"><i class="fas fa-paper-plane"></i> Übergeben</button>`);
    if (closers.length === 1) document.querySelector('#trUCloser .qf-btn').classList.add('active');
  },
  async uebergeben(id) {
    const v = x => document.getElementById(x)?.value.trim() || '';
    const closerId = parseInt(document.querySelector('#trUCloser .qf-btn.active')?.dataset.id);
    if (!closerId) return this._err('Bitte einen Closer wählen.');
    if (!v('trUTopic') || !v('trUPain')) return this._err('Bitte Thema und Painpoints eintragen, damit der Closer gut vorbereitet ist.');
    const btn = document.getElementById('trUSave'); btn.disabled = true;
    try {
      await api('PATCH', `/termine/${id}`, { closer_id: closerId, topic: v('trUTopic'), painpoints: v('trUPain'), notes: v('trUNotes'),
        notify_mail: document.getElementById('trUMail').checked });
      const an = this.users.find(u => u.id === closerId);
      showToast(`An ${an ? an.full_name : 'den Closer'} übergeben – wartet auf Antwort`);
      this._close();
      this.load();
      if (typeof this.opts.onChange === 'function') this.opts.onChange();
    } catch (e) { btn.disabled = false; this._err(escHtml(e.message)); }
  },

  // Neuer Termin (mit vorhandenem oder neuem Lead) oder bestehenden ändern.
  // o.lead: Lead aus dem Panel · o.id: Termin bearbeiten
  // Admin → anderer Closer = warme Übergabe (Handbuch S. 4): mit Thema, Painpoints,
  // Webseite und den schon bekannten Pflichtfragen.
  UEB_QUELLEN: ['Instagram', 'LinkedIn', 'Empfehlung', 'Sonstiges'],
  async openEditor(o = {}) {
    const admin = this.opts.isAdmin;
    const a = o.id ? this.rows.find(x => x.id === o.id) || null : null;
    const lead = o.lead || null;
    const users = await this._users();
    const morgen = new Date(); morgen.setDate(morgen.getDate() + 1);
    while ([0, 6].includes(morgen.getDay())) morgen.setDate(morgen.getDate() + 1);
    const datum = a ? a.starts_at.slice(0, 10) : this._iso(morgen);
    const uhr = a && a.art !== 'anruf_bis' ? this._uhr(a.starts_at) : '10:00';
    const closerId = a ? a.closer_id : (lead?.assigned_to && lead.assigned_to !== ME?.id ? lead.assigned_to : '');
    const closers = users.filter(u => u.role === 'closer');
    const andere = users.filter(u => u.role !== 'closer');
    const userOpts = list => list.map(u => `<option value="${u.id}" ${u.id === closerId ? 'selected' : ''}>${escHtml(u.full_name)}${u.id === ME?.id ? ' (ich)' : ''}</option>`).join('');
    const neuerLead = !a && !lead;
    const R = window.BedarfRegeln;
    this._editLeadId = a ? a.lead_id : lead?.id || null;
    this._editId = a ? a.id : null;
    this._art = o.art || a?.art || 'termin';
    const voll = admin && !a;     // komplettes Übergabe-Formular
    const L = lead || {};
    const feld = (id, label, val, extra = '', req = false) => `<div class="form-group" style="margin:0"><label>${label}${req ? ' <span class="tr-req">*</span>' : ''}</label><input class="form-control" id="${id}" value="${escHtml(val || '')}" ${extra}></div>`;
    const chips = (id, liste, multi) => `<div class="dl-chips tr-qchips" id="${id}" data-multi="${multi ? 1 : 0}">${liste.map(([k, l]) => `<button type="button" class="qf-btn" data-v="${escHtml(k)}">${escHtml(l)}</button>`).join('')}</div>`;
    const frage = (nr, titel, body) => `<div class="tr-q"><label class="tr-check"><input type="checkbox" data-q="${nr}" onchange="this.closest('.tr-q').querySelector('.tr-q-body').hidden=!this.checked"> ${nr}. ${titel} <span class="tr-opt">bekannt</span></label><div class="tr-q-body" hidden>${body}</div></div>`;
    this._modal(a ? 'Termin ändern' : admin ? 'Termin an Closer übergeben' : 'Termin eintragen', 'fa-calendar-plus', `
      ${voll ? `
        <div class="tr-sub">Betrieb</div>
        ${neuerLead ? `<div class="form-group" style="margin:0;position:relative"><label>Lead suchen <span class="tr-opt">oder unten neu anlegen</span></label>
          <input class="form-control" id="trLSearch" placeholder="Firma, Name oder Telefon" oninput="Termine._suche(this.value)" autocomplete="off">
          <div class="tr-results" id="trLResults"></div></div>` : ''}
        <div id="trLeadPick">${lead ? `<div class="tr-lead"><i class="fas fa-building"></i><b>${escHtml(L.company)}</b>${L.ceo ? ' · ' + escHtml(L.ceo) : ''}</div>` : ''}</div>
        <div class="tr-grid2">
          ${neuerLead ? feld('trLCompany', 'Firma oder Name', '', 'placeholder="z. B. Malerbetrieb Klaus"', true) : ''}
          ${feld('trLCeo', 'Ansprechpartner', L.ceo, 'placeholder="z. B. Klaus Becker"', true)}
          ${feld('trLPhone', 'Telefon', L.phone, 'type="tel" placeholder="+49 …"', true)}
          ${feld('trLEmail', 'E-Mail', L.email, 'type="email"')}
          ${feld('trLWeb', 'Webseite', L.website, 'placeholder="betrieb.de"')}
          ${feld('trLInsta', 'Instagram', L.instagram_url, 'placeholder="instagram.com/…"')}
          ${feld('trLBranche', 'Branche', L.industry, 'list="trBranchen" placeholder="z. B. Maler"', true)}
        </div>
        <datalist id="trBranchen">${R.W.branche.filter(([k]) => k !== 'andere').map(([, l]) => `<option value="${escHtml(l)}">`).join('')}</datalist>
        ${neuerLead ? `<div class="form-group" style="margin:0" id="trQuelleGroup"><label>Quelle <span class="tr-req">*</span></label>
          <div class="dl-chips" id="trLSource">${this.UEB_QUELLEN.map((q, i) => `<button type="button" class="qf-btn ${i === 0 ? 'active' : ''}" data-q="${q}" onclick="Termine._quelle(this)">${q}</button>`).join('')}</div>
        </div>` : ''}` : (a ? '' : `<div class="tr-lead"><i class="fas fa-building"></i><b>${escHtml(L.company || '')}</b>${L.ceo ? ' · ' + escHtml(L.ceo) : ''}</div>`)}
      ${a ? `<div class="tr-lead"><i class="fas fa-building"></i><b>${escHtml(a.company || '')}</b>${a.ceo ? ' · ' + escHtml(a.ceo) : ''}</div>` : ''}
      <div class="tr-sub">Termin</div>
      ${admin ? `<div class="form-group" style="margin:0"><label>Closer <span class="tr-req">*</span></label>
        <select id="trCloser" class="form-control"><option value="">— Closer wählen —</option>
          ${closers.length ? `<optgroup label="Closer">${userOpts(closers)}</optgroup>` : ''}
          ${andere.length ? `<optgroup label="Admins">${userOpts(andere)}</optgroup>` : ''}
        </select></div>` : ''}
      ${admin ? `<div class="dl-chips" id="trArt">
        <button type="button" class="qf-btn ${this._art === 'termin' ? 'active' : ''}" data-art="termin" onclick="Termine._setArt('termin')">Fester Termin</button>
        <button type="button" class="qf-btn ${this._art === 'anruf_bis' ? 'active' : ''}" data-art="anruf_bis" onclick="Termine._setArt('anruf_bis')">Anruf bis …</button>
        ${a ? '' : `<button type="button" class="qf-btn ${this._art === 'heute' ? 'active' : ''}" data-art="heute" onclick="Termine._setArt('heute')">Heute spontan anrufen</button>`}</div>
        <p class="tr-hint" id="trHeuteHint" ${this._art === 'heute' ? '' : 'hidden'}>Kein fester Termin: Der Closer soll den Kunden heute noch anrufen. Er bekommt die Übergabe sofort, der Anruf steht bei ihm unter „Heute“.</p>` : ''}
      <div class="tr-grid3" id="trZeitTermin" ${this._art !== 'termin' ? 'style="display:none"' : ''}>
        <div class="form-group" style="margin:0"><label>Datum</label><input type="date" id="trDate" class="form-control" value="${datum}"></div>
        <div class="form-group" style="margin:0"><label>Uhrzeit</label><input type="time" id="trTime" class="form-control" step="900" value="${uhr}"></div>
        <div class="form-group" style="margin:0"><label>Dauer</label><select id="trDur" class="form-control">
          ${[15, 30, 45, 60, 90].map(m => `<option value="${m}" ${m === (a?.duration_min || 30) ? 'selected' : ''}>${m} Min.</option>`).join('')}</select></div>
      </div>
      <div class="form-group" id="trZeitBis" style="margin:0;${this._art === 'anruf_bis' ? '' : 'display:none'}"><label>Anrufen bis spätestens</label>
        <input type="date" id="trBis" class="form-control" value="${datum}" style="max-width:220px"></div>
      <div class="form-group" style="margin:0"><label>Thema${voll ? ' <span class="tr-req">*</span>' : ''}</label><input type="text" id="trTopic" class="form-control" value="${escHtml(a?.topic || '')}" placeholder="eine Zeile, z. B. Anfragen über Instagram automatisieren"></div>
      ${admin ? `<div class="form-group" style="margin:0"><label>Painpoints${voll ? ' <span class="tr-req">*</span>' : ''} <span class="tr-opt">kurz, in Worten des Kunden</span></label>
        <textarea id="trPain" class="form-control" rows="2" placeholder="z. B. „Ich komme abends nicht hinterher mit den WhatsApp-Anfragen“">${escHtml(a?.painpoints || '')}</textarea></div>` : ''}
      ${voll ? `<div class="tr-sub">Schon bekannt? <span class="tr-opt">abhaken + Antwort eintragen, landet in der Bedarfsanalyse</span></div>
        <div class="tr-qs">
          ${frage(1, 'Kanäle', chips('trQKanaele', R.W.kanaele, true))}
          ${frage(2, 'Menge', '<input type="number" min="0" class="form-control" id="trQAnfragen" placeholder="Anfragen pro Woche" style="max-width:200px">')}
          ${frage(3, 'Ablauf heute', '<input class="form-control" id="trQAblauf" placeholder="Wer antwortet, und wann?">')}
          ${frage(4, 'Größter Zeitfresser', '<input class="form-control" id="trQProblem" placeholder="Wörtlich, wie der Kunde es sagt">')}
          ${frage(5, 'Rahmen', `<input class="form-control" id="trQStart" placeholder="Wunschstart, z. B. März">${chips('trQEntscheider', R.W.entscheider, false)}`)}
        </div>` : ''}
      ${admin ? `<div class="form-group" style="margin:0"><label>Bereits versprochen / erwähnt <span class="tr-opt">(optional)</span></label><input id="trVersprochen" class="form-control" value="${escHtml(a?.versprochen || '')}" placeholder="z. B. Demo gezeigt, 10 % Rabatt angedeutet"></div>` : ''}
      <div class="form-group" style="margin:0"><label>Notizen ${admin ? 'für den Closer' : ''} <span class="tr-opt">(optional)</span></label><textarea id="trNotes" class="form-control" rows="2" placeholder="Was weiß der Kunde schon? Worauf achten?">${escHtml(a?.notes || '')}</textarea></div>
      ${admin && !a ? '<label class="tr-check"><input type="checkbox" id="trMail" checked> Closer zusätzlich per E-Mail benachrichtigen</label>' : ''}`,
      `<button class="btn btn-ghost btn-sm" onclick="Termine._close()">Abbrechen</button>
       <button class="btn btn-primary btn-sm" id="trSave" onclick="Termine.speichern()"><i class="fas fa-paper-plane"></i> ${a ? 'Speichern' : admin ? 'Übergeben' : 'Eintragen'}</button>`);
    document.querySelectorAll('#trModal .tr-qchips').forEach(c => c.addEventListener('click', e => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      if (c.dataset.multi !== '1') c.querySelectorAll('button').forEach(x => x !== b && x.classList.remove('active'));
      b.classList.toggle('active');
    }));
    setTimeout(() => document.getElementById(neuerLead && voll ? 'trLSearch' : admin && !closerId ? 'trCloser' : 'trTopic')?.focus(), 50);
  },
  _quelle(btn) {
    document.querySelectorAll('#trLSource .qf-btn').forEach(b => b.classList.toggle('active', b === btn));
  },
  _setArt(art) {
    this._art = art;
    document.querySelectorAll('#trArt .qf-btn').forEach(b => b.classList.toggle('active', b.dataset.art === art));
    document.getElementById('trZeitTermin').style.display = art === 'termin' ? '' : 'none';
    document.getElementById('trZeitBis').style.display = art === 'anruf_bis' ? '' : 'none';
    const h = document.getElementById('trHeuteHint'); if (h) h.hidden = art !== 'heute';
  },
  // Vorhandenen Lead im Übergabe-Formular suchen und übernehmen
  _suche(q) {
    clearTimeout(this._sucheT);
    const box = document.getElementById('trLResults');
    if (q.trim().length < 2) { box.innerHTML = ''; return; }
    this._sucheT = setTimeout(async () => {
      const rows = await api('GET', `/leads?search=${encodeURIComponent(q.trim())}&limit=8`).catch(() => []);
      const list = Array.isArray(rows) ? rows : rows.leads || [];
      this._treffer = list;
      box.innerHTML = list.length ? list.map(l => `<button type="button" class="tr-result" onclick="Termine._waehle(${l.id})">
        <b>${escHtml(l.company || '—')}</b><span>${escHtml([l.ceo, l.phone, l.location].filter(Boolean).join(' · '))}</span></button>`).join('')
        : '<div class="tr-result is-empty">Nichts gefunden – unten neu anlegen</div>';
    }, 250);
  },
  _waehle(id) {
    const l = (this._treffer || []).find(x => x.id === id);
    if (!l) return;
    this._editLeadId = id;
    document.getElementById('trLResults').innerHTML = '';
    document.getElementById('trLSearch').value = '';
    document.getElementById('trLeadPick').innerHTML = `<div class="tr-lead"><i class="fas fa-building"></i><b>${escHtml(l.company)}</b>${l.ceo ? ' · ' + escHtml(l.ceo) : ''}
      <button type="button" class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="Termine._editLeadId=null;this.closest('.tr-lead').remove();document.getElementById('trLCompany').closest('.form-group').hidden=false;document.getElementById('trQuelleGroup').hidden=false">Anderer</button></div>`;
    document.getElementById('trLCompany').closest('.form-group').hidden = true;
    document.getElementById('trQuelleGroup').hidden = true;
    const set = (fid, v) => { const i = document.getElementById(fid); if (i && !i.value && v) i.value = v; };
    set('trLCeo', l.ceo); set('trLPhone', l.phone); set('trLEmail', l.email); set('trLWeb', l.website); set('trLBranche', l.industry);
  },
  _fragen() {
    const an = nr => document.querySelector(`#trModal [data-q="${nr}"]`)?.checked;
    const v = id => document.getElementById(id)?.value.trim() || '';
    const sel = id => [...document.querySelectorAll(`#${id} .qf-btn.active`)].map(b => b.dataset.v);
    const f = {};
    if (an(1)) { f.kanaele = sel('trQKanaele'); if (f.kanaele.length === 1) f.kanal_wichtigster = f.kanaele[0]; }
    if (an(2) && v('trQAnfragen')) f.anfragen_pro_woche = v('trQAnfragen');
    if (an(3) && v('trQAblauf')) f.ablauf_heute = v('trQAblauf');
    if (an(4) && v('trQProblem')) f.groesstes_problem = v('trQProblem');
    if (an(5)) { if (v('trQStart')) f.wunschstart = v('trQStart'); const e = sel('trQEntscheider')[0]; if (e) f.entscheider = e; }
    return f;
  },

  async speichern(force = false, leadId = null) {
    const v = id => document.getElementById(id)?.value.trim() || '';
    const admin = this.opts.isAdmin;
    const heute = this._art === 'heute';
    const bis = this._art === 'anruf_bis' || heute;
    const datum = v('trDate'), uhr = v('trTime');
    if (heute ? false : bis ? !v('trBis') : (!datum || !uhr)) return this._err(bis ? 'Bis wann soll angerufen werden?' : 'Bitte Datum und Uhrzeit angeben.');
    if (admin && !v('trCloser')) return this._err('Bitte einen Closer wählen.');
    const body = {
      art: bis ? 'anruf_bis' : 'termin',
      ...(bis ? { anruf_bis: heute ? this._iso(new Date()) : v('trBis') } : { starts_at: this._sql(datum, uhr) }),
      duration_min: parseInt(v('trDur')) || 30,
      topic: v('trTopic'), notes: v('trNotes'),
      painpoints: document.getElementById('trPain') ? v('trPain') : undefined,
      versprochen: document.getElementById('trVersprochen') ? v('trVersprochen') : undefined,
      closer_id: admin ? parseInt(v('trCloser')) : undefined,
      notify_mail: document.getElementById('trMail') ? document.getElementById('trMail').checked : undefined,
    };
    if (!this._editId && document.getElementById('trLCeo')) {
      body.lead = { ceo: v('trLCeo'), phone: v('trLPhone'), email: v('trLEmail'), website: v('trLWeb'), instagram: v('trLInsta'), industry: v('trLBranche') };
      body.fragen = this._fragen();
    }
    const btn = document.getElementById('trSave');
    btn.disabled = true;
    try {
      let r;
      if (this._editId) r = await api('PATCH', `/termine/${this._editId}`, body);
      else {
        const lid = leadId || this._editLeadId;
        if (lid) body.lead_id = lid;
        else {
          if (!v('trLCompany')) { btn.disabled = false; return this._err('Bitte Firma oder Namen des Kunden eintragen.'); }
          body.lead = { ...(body.lead || {}), company: v('trLCompany'), source: document.querySelector('#trLSource .qf-btn.active')?.dataset.q || '' };
          body.force = force;
        }
        r = await api('POST', '/termine', body);
      }
      const an = this.users.find(u => u.id === body.closer_id);
      showToast(r.status === 'vorgeschlagen' ? `An ${an ? an.full_name : 'den Closer'} übergeben – wartet auf Antwort` : 'Termin eingetragen ✓');
      this._close();
      this.load();
      if (typeof this.opts.onChange === 'function') this.opts.onChange();
    } catch (e) {
      btn.disabled = false;
      if (e.status === 409 && e.data?.duplicates) {
        const d = e.data.duplicates[0];
        this._err(`Diesen Kunden gibt es schon: <b>${escHtml(d.company)}</b>${d.assigned_name ? ' (betreut von ' + escHtml(d.assigned_name) + ')' : ''}.
          <div class="tr-err-actions"><button class="btn btn-primary btn-sm" onclick="Termine.speichern(false, ${d.id})">Für diesen Lead übergeben</button>
          <button class="btn btn-ghost btn-sm" onclick="Termine.speichern(true)">Trotzdem neu anlegen</button></div>`);
      } else this._err(escHtml(e.message));
    }
  },

  // Übergabe-Infos zum Lead (Anrufmodus, Lead-Panel): Thema, Painpoints, Webseite, „Noch klären“
  async uebergabeBox(leadId, elId) {
    // Erst laden, dann suchen: der Platz wird oft gerade erst gezeichnet
    const u = await api('GET', `/termine/uebergabe/${leadId}`).catch(() => null);
    const box = document.getElementById(elId);
    if (box && box.dataset.lead && box.dataset.lead !== String(leadId)) return;   // inzwischen anderer Lead
    if (!box || !u) { if (box) box.innerHTML = ''; return; }
    const link = (url, icon) => url ? `<a href="${escHtml(absUrl(url))}" target="_blank" rel="noopener"><i class="${icon}"></i>${escHtml(String(url).replace(/^https?:\/\//, ''))}</a>` : '';
    box.innerHTML = `<div class="tr-ueb">
      <div class="tr-ueb-head"><i class="fas fa-handshake"></i> Übergabe von ${escHtml(u.proposed_name || 'Aleksandra')}
        <span>${u.art === 'anruf_bis' ? 'Anruf bis ' + escHtml(this._d(u.starts_at).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })) : escHtml(this._lang(u.starts_at))}</span></div>
      ${u.topic ? `<div class="tr-ueb-topic">${escHtml(u.topic)}</div>` : ''}
      ${u.painpoints ? `<div class="tr-ueb-pain"><i class="fas fa-quote-left"></i>${escHtml(u.painpoints)}</div>` : ''}
      <div class="tr-ueb-links">${link(u.website, 'fas fa-globe')}${link(u.instagram, 'fab fa-instagram')}</div>
      ${u.noch_klaeren?.length ? `<div class="tr-ueb-offen"><b>Noch klären:</b> ${u.noch_klaeren.map(f => escHtml(f.titel)).join(' · ')}</div>` : '<div class="tr-ueb-offen is-ok"><i class="fas fa-check-circle"></i> Alle Pflichtfragen bekannt</div>'}
      ${u.versprochen ? `<div class="tr-ueb-vers"><b>Bereits versprochen:</b> ${escHtml(u.versprochen)}</div>` : ''}
    </div>`;
  },

  // ── Hinweise: Anfragen-Zähler und Erinnerung kurz vor dem Termin ──
  async refreshBadge() {
    try {
      const r = await api('GET', '/termine/badge');
      const badge = document.getElementById('termineBadge');
      if (badge) {
        const n = r.offen || 0;
        badge.textContent = n || r.heute;
        badge.style.display = n || r.heute ? '' : 'none';
        badge.classList.toggle('badge-soft', !n);
        badge.title = n ? (this.opts.isAdmin ? 'Antworten der Closer' : 'Neue Terminanfragen') : 'Termine heute';
      }
      if (!this.opts.isAdmin && this._offen !== null && r.offen > this._offen) {
        showToast('📅 Neue Terminanfrage vom Admin – unter „Termine“ annehmen');
        if (document.getElementById(this.opts.rootId)?.offsetParent) this.load();
      }
      this._offen = r.offen;
      let gezeigt = [];
      try { gezeigt = JSON.parse(sessionStorage.getItem('nf_termin_hinweis') || '[]'); } catch (_) {}
      (r.bald || []).filter(a => !gezeigt.includes(a.id)).forEach(a => {
        gezeigt.push(a.id);
        this._toast(a);
      });
      try { sessionStorage.setItem('nf_termin_hinweis', JSON.stringify(gezeigt.slice(-50))); } catch (_) {}
    } catch (_) {}
  },
  _toast(a) {
    const box = document.getElementById('reminderNotifContainer') || document.body;
    const card = document.createElement('div');
    card.className = 'rem-toast';
    card.setAttribute('data-notif', 'termin-' + a.id);
    card.innerHTML = `
      <div class="rem-toast-eyebrow"><i class="fas fa-calendar-check"></i> Termin um ${this._uhr(a.starts_at)} Uhr</div>
      <div class="rem-toast-title">${escHtml(a.company || '—')}</div>
      ${a.topic ? `<div class="rem-toast-note">${escHtml(a.topic)}</div>` : ''}
      <div class="rem-toast-time">${a.phone ? escHtml(a.phone) : ''}</div>
      <button type="button" class="rem-toast-x" onclick="this.closest('[data-notif]').remove()" title="Schließen"><i class="fas fa-times"></i></button>
      <button class="btn btn-primary btn-sm" onclick="Termine.opts.openLead(${a.lead_id});this.closest('[data-notif]').remove()"><i class="fas fa-external-link-alt"></i> Lead öffnen</button>`;
    box.appendChild(card);
  },
  startBadge() {
    this.refreshBadge();
    clearInterval(this._badgeTimer);
    this._badgeTimer = setInterval(() => this.refreshBadge(), 60 * 1000);
  },
};
