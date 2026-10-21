// ============================================================
// Wähllisten: gespeicherte Filter („Praxen in München, nie erreicht,
// letzter Versuch > 3 Tage“), die direkt im Anrufmodus starten.
// Genutzt von der Heute-Seite (closer.html / admin.html).
// ============================================================
const CallLists = {
  lists: [], opts: {}, _editId: null, _previewTimer: null,

  STATUS_LABELS: { neu: 'Neu', kontaktiert: 'Kontaktiert', nicht_erreicht: 'Nicht erreicht', rueckruf: 'Rückruf', kein_interesse: 'Kein Interesse', kunde: 'Kunde' },

  init(opts) { this.opts = opts || {}; this._ensureModal(); },

  async load() {
    try { this.lists = await api('GET', '/call-lists'); } catch (e) { this.lists = []; }
    return this.lists;
  },

  // Kompakte Liste mit Start-Buttons (für die Heute-Seite)
  renderInto(el) {
    if (!el) return;
    if (!this.lists.length) {
      el.innerHTML = `<div class="today-empty">Noch keine Wählliste. Lege dir z.B. „Praxen, nie erreicht“ an und telefoniere sie am Stück ab.</div>`;
      return;
    }
    el.innerHTML = this.lists.map(l => `
      <div class="cl-row">
        <div class="cl-main">
          <div class="cl-name">${escHtml(l.name)}${l.shared ? ' <span class="cl-tag">Team</span>' : ''}</div>
          <div class="cl-desc">${escHtml(this.describe(l.filters))}${!l.mine && l.owner_name ? ' · von ' + escHtml(l.owner_name) : ''}</div>
        </div>
        <span class="cl-count">${l.count}</span>
        ${l.mine || this.opts.isAdmin ? `<button class="btn btn-ghost btn-sm btn-icon" onclick="CallLists.openEditor(${l.id})" title="Bearbeiten"><i class="fas fa-pen"></i></button>` : ''}
        <button class="btn btn-primary btn-sm dialer-launch" ${l.count ? '' : 'disabled'} onclick="CallLists.start(${l.id})"><i class="fas fa-headset"></i> Anrufen</button>
      </div>`).join('');
  },

  describe(f = {}) {
    const parts = [];
    if (f.statuses?.length) parts.push(f.statuses.map(s => this.STATUS_LABELS[s] || s).join('/'));
    if (f.industry) parts.push(`Branche „${f.industry}“`);
    if (f.location) parts.push(`Ort „${f.location}“`);
    if (f.source) parts.push(`Quelle „${f.source}“`);
    if (f.never_reached) parts.push('nie erreicht');
    if (f.min_days_since_call != null) parts.push(`letzter Anruf > ${f.min_days_since_call} T.`);
    if (f.max_calls != null) parts.push(`max. ${f.max_calls} Versuche`);
    if (f.created_within_days != null) parts.push(`neu (≤ ${f.created_within_days} T.)`);
    if (f.has_open_deal === 'yes') parts.push('mit offenem Deal');
    if (f.has_open_deal === 'no') parts.push('ohne Deal');
    if (f.include_unassigned) parts.push('inkl. freie Leads');
    return parts.join(' · ') || 'alle offenen Leads';
  },

  start(id) {
    const l = this.lists.find(x => x.id === id);
    if (typeof this.opts.startDialer === 'function') this.opts.startDialer({ listId: id, listName: l?.name });
  },

  // ── Editor ──────────────────────────────────────────────────
  _ensureModal() {
    if (document.getElementById('callListModal')) return;
    const st = Object.entries(this.STATUS_LABELS).map(([k, v]) =>
      `<label class="cl-check"><input type="checkbox" name="clStatus" value="${k}" onchange="CallLists.preview()"> ${v}</label>`).join('');
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="callListModal" onclick="if(event.target===this)CallLists.close()">
        <div class="modal" style="max-width:640px">
          <button class="modal-close" onclick="CallLists.close()"><i class="fas fa-times"></i></button>
          <div class="modal-title" id="clmTitle">Wählliste</div>
          <div class="form-group"><label>Name *</label><input type="text" id="clmName" class="form-control" maxlength="100" placeholder="z.B. Praxen München – nie erreicht"></div>
          <div class="form-group"><label>Status <span class="cell-sub">(leer = alle offenen)</span></label><div class="cl-checks">${st}</div></div>
          <div class="deal-form-row">
            <div class="form-group"><label>Branche enthält</label><input type="text" id="clmIndustry" class="form-control" placeholder="z.B. Zahnarzt" oninput="CallLists.preview()"></div>
            <div class="form-group"><label>Ort / PLZ enthält</label><input type="text" id="clmLocation" class="form-control" placeholder="z.B. München oder 80" oninput="CallLists.preview()"></div>
          </div>
          <div class="deal-form-row">
            <div class="form-group"><label>Letzter Anruf vor mind. … Tagen</label><input type="number" min="0" id="clmMinDays" class="form-control" placeholder="egal" oninput="CallLists.preview()"></div>
            <div class="form-group"><label>Höchstens … Anrufversuche</label><input type="number" min="0" id="clmMaxCalls" class="form-control" placeholder="egal" oninput="CallLists.preview()"></div>
          </div>
          <div class="deal-form-row">
            <div class="form-group"><label>Angelegt in den letzten … Tagen</label><input type="number" min="0" id="clmCreated" class="form-control" placeholder="egal" oninput="CallLists.preview()"></div>
            <div class="form-group"><label>Deal</label><select id="clmDeal" class="form-control" onchange="CallLists.preview()"><option value="">egal</option><option value="yes">mit offenem Deal</option><option value="no">ohne Deal</option></select></div>
          </div>
          <div class="form-group"><label>Quelle enthält</label><input type="text" id="clmSource" class="form-control" placeholder="z.B. csv-import, web, eingehender-anruf" oninput="CallLists.preview()"></div>
          <div class="cl-checks" style="margin-bottom:14px">
            <label class="cl-check"><input type="checkbox" id="clmNever" onchange="CallLists.preview()"> nie erreicht</label>
            <label class="cl-check"><input type="checkbox" id="clmFree" onchange="CallLists.preview()"> freie Leads einbeziehen (werden beim Anrufen übernommen)</label>
            <label class="cl-check"><input type="checkbox" id="clmIgnoreFu" onchange="CallLists.preview()"> auch Leads mit späterem Termin</label>
            <label class="cl-check" id="clmSharedWrap" style="display:none"><input type="checkbox" id="clmShared"> für das ganze Team sichtbar</label>
          </div>
          <div class="cl-preview" id="clmPreview"></div>
          <div class="deal-modal-err" id="clmErr"></div>
          <div class="deal-modal-actions">
            <button class="btn btn-primary" onclick="CallLists.save()"><i class="fas fa-check"></i> Speichern</button>
            <button class="btn btn-ghost" onclick="CallLists.close()">Abbrechen</button>
            <span class="dc-spacer"></span>
            <button class="btn btn-ghost btn-icon" id="clmDelete" onclick="CallLists.remove()" title="Liste löschen"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      </div>`);
  },

  openEditor(id) {
    const l = id ? this.lists.find(x => x.id === id) : null;
    this._editId = l ? l.id : null;
    const f = l?.filters || {};
    const $ = x => document.getElementById(x);
    $('clmTitle').textContent = l ? 'Wählliste bearbeiten' : 'Neue Wählliste';
    $('clmName').value = l?.name || '';
    document.querySelectorAll('input[name="clStatus"]').forEach(c => { c.checked = (f.statuses || []).includes(c.value); });
    $('clmIndustry').value = f.industry || '';
    $('clmLocation').value = f.location || '';
    $('clmSource').value = f.source || '';
    $('clmMinDays').value = f.min_days_since_call ?? '';
    $('clmMaxCalls').value = f.max_calls ?? '';
    $('clmCreated').value = f.created_within_days ?? '';
    $('clmDeal').value = f.has_open_deal || '';
    $('clmNever').checked = !!f.never_reached;
    $('clmFree').checked = !!f.include_unassigned;
    $('clmIgnoreFu').checked = !!f.ignore_followups;
    $('clmSharedWrap').style.display = this.opts.isAdmin ? '' : 'none';
    $('clmShared').checked = !!l?.shared;
    $('clmDelete').style.display = l ? '' : 'none';
    $('clmErr').textContent = '';
    $('callListModal').classList.add('open');
    this.preview();
    setTimeout(() => $('clmName').focus(), 50);
  },
  close() { document.getElementById('callListModal').classList.remove('open'); },

  _filters() {
    const $ = x => document.getElementById(x);
    const num = x => $(x).value === '' ? null : parseInt($(x).value);
    return {
      statuses: [...document.querySelectorAll('input[name="clStatus"]:checked')].map(c => c.value),
      industry: $('clmIndustry').value.trim(),
      location: $('clmLocation').value.trim(),
      source: $('clmSource').value.trim(),
      min_days_since_call: num('clmMinDays'),
      max_calls: num('clmMaxCalls'),
      created_within_days: num('clmCreated'),
      has_open_deal: $('clmDeal').value,
      never_reached: $('clmNever').checked,
      include_unassigned: $('clmFree').checked,
      ignore_followups: $('clmIgnoreFu').checked,
    };
  },

  preview() {
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(async () => {
      const el = document.getElementById('clmPreview');
      try {
        const r = await api('POST', '/call-lists/preview', { filters: this._filters() });
        el.innerHTML = `<b>${r.count}</b> Leads jetzt anrufbar${r.without_phone ? ` · ${r.without_phone} ohne Telefonnummer` : ''}` +
          (r.sample.length ? `<div class="cl-sample">${r.sample.map(l => escHtml(l.company)).join(' · ')}${r.count > r.sample.length ? ' …' : ''}</div>` : '');
      } catch (e) { el.textContent = e.message; }
    }, 250);
  },

  async save() {
    const name = document.getElementById('clmName').value.trim();
    const err = document.getElementById('clmErr');
    if (!name) { err.textContent = 'Bitte einen Namen angeben.'; return; }
    const body = { name, filters: this._filters(), shared: document.getElementById('clmShared').checked };
    try {
      if (this._editId) await api('PATCH', `/call-lists/${this._editId}`, body);
      else await api('POST', '/call-lists', body);
      showToast('Wählliste gespeichert');
      this.close();
      if (typeof this.opts.onChange === 'function') this.opts.onChange();
    } catch (e) { err.textContent = e.message; }
  },

  async remove() {
    if (!this._editId) return;
    const ok = await customConfirm('Wählliste löschen? Die Leads selbst bleiben unverändert.', { title: 'Wählliste löschen', okLabel: 'Löschen', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/call-lists/${this._editId}`);
      this.close();
      if (typeof this.opts.onChange === 'function') this.opts.onChange();
    } catch (e) { showToast(e.message, 'err'); }
  },
};
