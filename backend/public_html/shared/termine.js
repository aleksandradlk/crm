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
  _sql(datum, uhr) { return `${datum} ${uhr}:00`; },
  _iso(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },

  // ── Darstellung ──────────────────────────────────────────────
  render() {
    const jetzt = Date.now();
    const admin = this.opts.isAdmin;
    const ende = a => this._d(a.starts_at).getTime() + (a.duration_min || 30) * 60000;
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
      <div class="tr-card-when"><b>${escHtml(this._lang(a.starts_at))}</b> · ${a.duration_min} Min. ${this._status(a)}</div>
      <div class="tr-card-who">${escHtml(a.company || '—')}${a.ceo ? ` <span>· ${escHtml(a.ceo)}</span>` : ''}</div>
      ${a.topic ? `<div class="tr-card-topic">${escHtml(a.topic)}</div>` : ''}
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
          <button class="btn btn-primary btn-sm" onclick="Termine.openEditor({ id: ${a.id} })"><i class="fas fa-user-friends"></i> Anderem Closer geben</button>
          <button class="btn btn-ghost btn-sm tr-nein" onclick="Termine.absagen(${a.id})"><i class="fas fa-ban"></i> Absagen</button>
        </div>`;
    } else {
      unten = `<div class="tr-card-actions">
          <button class="btn btn-ghost btn-sm" onclick="Termine.openEditor({ id: ${a.id} })"><i class="fas fa-edit"></i> Ändern</button>
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
      <div class="tr-time"><b>${this._uhr(a.starts_at)}</b><span>${vergangen ? escHtml(this._d(a.starts_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })) : a.duration_min + ' Min.'}</span></div>
      <div class="tr-main" ${darfLead ? `onclick="Termine.opts.openLead(${a.lead_id})"` : ''}>
        <div class="tr-title">${escHtml(a.company || '—')}${a.ceo ? ` <span>· ${escHtml(a.ceo)}</span>` : ''} ${vergangen || a.status !== 'angenommen' ? this._status(a) : ''}</div>
        ${a.topic ? `<div class="tr-topic">${escHtml(a.topic)}</div>` : ''}
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

  // Neuer Termin (mit vorhandenem oder neuem Lead) oder bestehenden ändern.
  // o.lead: Lead aus dem Panel · o.id: Termin bearbeiten
  async openEditor(o = {}) {
    const admin = this.opts.isAdmin;
    const a = o.id ? this.rows.find(x => x.id === o.id) || null : null;
    const lead = o.lead || null;
    const users = await this._users();
    const morgen = new Date(); morgen.setDate(morgen.getDate() + 1);
    while ([0, 6].includes(morgen.getDay())) morgen.setDate(morgen.getDate() + 1);
    const datum = a ? a.starts_at.slice(0, 10) : this._iso(morgen);
    const uhr = a ? this._uhr(a.starts_at) : '10:00';
    const closerId = a ? a.closer_id : (lead?.assigned_to || '');
    const closers = users.filter(u => u.role === 'closer');
    const andere = users.filter(u => u.role !== 'closer');
    const userOpts = list => list.map(u => `<option value="${u.id}" ${u.id === closerId ? 'selected' : ''}>${escHtml(u.full_name)}${u.id === ME?.id ? ' (ich)' : ''}</option>`).join('');
    const neuerLead = !a && !lead;
    this._editLeadId = a ? a.lead_id : lead?.id || null;
    this._editId = a ? a.id : null;
    this._modal(a ? 'Termin ändern' : admin ? 'Termin an Closer übergeben' : 'Termin eintragen', 'fa-calendar-plus', `
      ${neuerLead ? `
        <div class="tr-sub">Kunde</div>
        <div class="tr-grid2">
          <div class="form-group" style="margin:0"><label>Firma oder Name <span class="tr-req">*</span></label><input type="text" id="trLCompany" class="form-control" placeholder="z. B. Malerbetrieb Klaus"></div>
          <div class="form-group" style="margin:0"><label>Ansprechpartner</label><input type="text" id="trLCeo" class="form-control" placeholder="z. B. Klaus Becker"></div>
          <div class="form-group" style="margin:0"><label>Telefon</label><input type="tel" id="trLPhone" class="form-control" placeholder="+49 …"></div>
          <div class="form-group" style="margin:0"><label>E-Mail</label><input type="email" id="trLEmail" class="form-control"></div>
        </div>
        <div class="form-group" style="margin:0"><label>Woher kommt der Kontakt?</label>
          <div class="dl-chips" id="trLSource">${this.QUELLEN.map((q, i) => `<button type="button" class="qf-btn ${i === 0 ? 'active' : ''}" data-q="${q}" onclick="Termine._quelle(this)">${q}</button>`).join('')}</div>
        </div>` : `<div class="tr-lead"><i class="fas fa-building"></i><b>${escHtml(a?.company || lead?.company || '')}</b>${(a?.ceo || lead?.ceo) ? ' · ' + escHtml(a?.ceo || lead?.ceo) : ''}</div>`}
      <div class="tr-sub">Termin</div>
      ${admin ? `<div class="form-group" style="margin:0"><label>Closer <span class="tr-req">*</span></label>
        <select id="trCloser" class="form-control"><option value="">— Closer wählen —</option>
          ${closers.length ? `<optgroup label="Closer">${userOpts(closers)}</optgroup>` : ''}
          ${andere.length ? `<optgroup label="Admins">${userOpts(andere)}</optgroup>` : ''}
        </select></div>` : ''}
      <div class="tr-grid3">
        <div class="form-group" style="margin:0"><label>Datum</label><input type="date" id="trDate" class="form-control" value="${datum}"></div>
        <div class="form-group" style="margin:0"><label>Uhrzeit</label><input type="time" id="trTime" class="form-control" step="900" value="${uhr}"></div>
        <div class="form-group" style="margin:0"><label>Dauer</label><select id="trDur" class="form-control">
          ${[15, 30, 45, 60, 90].map(m => `<option value="${m}" ${m === (a?.duration_min || 30) ? 'selected' : ''}>${m} Min.</option>`).join('')}</select></div>
      </div>
      <div class="form-group" style="margin:0"><label>Thema</label><input type="text" id="trTopic" class="form-control" value="${escHtml(a?.topic || '')}" placeholder="z. B. Website-Angebot besprechen"></div>
      <div class="form-group" style="margin:0"><label>Notizen ${admin ? 'für den Closer' : ''} <span class="tr-opt">(optional)</span></label><textarea id="trNotes" class="form-control" rows="3" placeholder="Was weiß der Kunde schon? Worauf achten?">${escHtml(a?.notes || '')}</textarea></div>
      ${admin ? '<label class="tr-check"><input type="checkbox" id="trMail" checked> Closer zusätzlich per E-Mail benachrichtigen</label>' : ''}`,
      `<button class="btn btn-ghost btn-sm" onclick="Termine._close()">Abbrechen</button>
       <button class="btn btn-primary btn-sm" id="trSave" onclick="Termine.speichern()"><i class="fas fa-paper-plane"></i> ${a ? 'Speichern' : admin ? 'Übergeben' : 'Eintragen'}</button>`);
    setTimeout(() => document.getElementById(neuerLead ? 'trLCompany' : admin && !closerId ? 'trCloser' : 'trTopic')?.focus(), 50);
  },
  _quelle(btn) {
    document.querySelectorAll('#trLSource .qf-btn').forEach(b => b.classList.toggle('active', b === btn));
  },

  async speichern(force = false, leadId = null) {
    const v = id => document.getElementById(id)?.value.trim() || '';
    const datum = v('trDate'), uhr = v('trTime');
    if (!datum || !uhr) return this._err('Bitte Datum und Uhrzeit angeben.');
    if (this.opts.isAdmin && !v('trCloser')) return this._err('Bitte einen Closer wählen.');
    const body = {
      starts_at: this._sql(datum, uhr), duration_min: parseInt(v('trDur')) || 30,
      topic: v('trTopic'), notes: v('trNotes'),
      closer_id: this.opts.isAdmin ? parseInt(v('trCloser')) : undefined,
      notify_mail: document.getElementById('trMail') ? document.getElementById('trMail').checked : undefined,
    };
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
          body.lead = { company: v('trLCompany'), ceo: v('trLCeo'), phone: v('trLPhone'), email: v('trLEmail'),
            source: document.querySelector('#trLSource .qf-btn.active')?.dataset.q || '' };
          body.force = force;
        }
        r = await api('POST', '/termine', body);
      }
      const an = this.users.find(u => u.id === body.closer_id);
      showToast(r.status === 'vorgeschlagen' ? `Termin an ${an ? an.full_name : 'den Closer'} geschickt – wartet auf Antwort` : 'Termin eingetragen ✓');
      this._close();
      this.load();
      if (typeof this.opts.onChange === 'function') this.opts.onChange();
    } catch (e) {
      btn.disabled = false;
      if (e.status === 409 && e.data?.duplicates) {
        const d = e.data.duplicates[0];
        this._err(`Diesen Kunden gibt es schon: <b>${escHtml(d.company)}</b>${d.assigned_name ? ' (betreut von ' + escHtml(d.assigned_name) + ')' : ''}.
          <div class="tr-err-actions"><button class="btn btn-primary btn-sm" onclick="Termine.speichern(false, ${d.id})">Termin für diesen Lead</button>
          <button class="btn btn-ghost btn-sm" onclick="Termine.speichern(true)">Trotzdem neu anlegen</button></div>`);
      } else this._err(escHtml(e.message));
    }
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
