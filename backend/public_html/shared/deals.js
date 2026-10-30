// ============================================================
// Deals — Pipeline mit Werten (Pipedrive-Prinzip)
// Board: Spalten = Phasen, Summe pro Phase, Karten per Drag & Drop
// verschieben, beim Ziehen erscheinen „Gewonnen“ / „Verloren“.
// Eingebunden in closer.html und admin.html über Deals.mount().
// ============================================================
const Deals = {
  opts: {}, stages: [], lostReasons: [], deals: [], users: [],
  owner: 'me', view: 'board', status: 'open', search: '',
  _drag: null, _current: null, _loaded: false,

  fmt(v) {
    return Number(v || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  },
  fmtShort(v) {
    v = Number(v || 0);
    if (v >= 1e6) return (v / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' Mio. €';
    if (v >= 1e4) return Math.round(v / 1e3).toLocaleString('de-DE') + ' Tsd. €';
    return this.fmt(v);
  },
  initials(name) {
    return String(name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  },
  canSeeAll() { return !!this.opts.canViewAll; },

  // ── Einbinden ───────────────────────────────────────────────
  mount(opts) {
    this.opts = opts;
    this.owner = opts.defaultOwner || 'me';
    const root = document.getElementById(opts.rootId);
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    root.innerHTML = `
      <div class="page-header">
        <div><h1 data-eyebrow="Vertrieb">Deals</h1><p class="page-desc">Deine Verkaufschancen mit Wert. Karten in die nächste Phase ziehen, zum Abschließen auf „Gewonnen“ oder „Verloren“.</p></div>
        <div class="page-actions">
          ${opts.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="Deals.openStageEditor()"><i class="fas fa-sliders-h"></i> Phasen bearbeiten</button>` : ''}
          <button class="btn btn-primary btn-sm" onclick="Deals.openNew()"><i class="fas fa-plus"></i> Deal</button>
        </div>
      </div>
      <div class="dash-kpis" id="dealKpis"></div>
      ${!opts.isAdmin && typeof Provision !== 'undefined' ? '<div id="dealBonus"></div>' : ''}
      <div class="toolbar">
        <div class="search-bar"><i class="fas fa-search search-bar-icon"></i><input type="text" id="dealSearch" class="form-control" placeholder="Deals durchsuchen …" autocomplete="off" oninput="Deals.search=this.value.toLowerCase();Deals.render()"></div>
        ${this.canSeeAll() ? `<div class="chip-row" id="dealOwnerChips">
          <button class="qf-btn" data-ow="me" onclick="Deals.setOwner('me')"><i class="fas fa-user"></i> Meine Deals</button>
          <button class="qf-btn" data-ow="all" onclick="Deals.setOwner('all')"><i class="fas fa-users"></i> Alle</button>
        </div>
        ${opts.isAdmin ? `<select id="dealOwner" class="form-control deal-owner-sel" onchange="Deals.setOwner(this.value || 'all')"><option value="">Person …</option></select>` : ''}` : ''}
        <div class="chip-row" id="dealStatusChips" style="display:none">
          ${[['open', 'Offen'], ['won', 'Gewonnen'], ['lost', 'Verloren'], ['all', 'Alle']].map(([k, l]) =>
            `<button class="qf-btn${k === 'open' ? ' active' : ''}" data-st="${k}" onclick="Deals.setStatus('${k}')">${l}</button>`).join('')}
        </div>
        <div class="toolbar-spacer"></div>
        <div class="view-toggle">
          <button id="dealViewBoard" class="active" onclick="Deals.setView('board')"><i class="fas fa-columns"></i> Pipeline</button>
          <button id="dealViewList" onclick="Deals.setView('list')"><i class="fas fa-list"></i> Liste</button>
        </div>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="Deals.load()" title="Aktualisieren"><i class="fas fa-sync"></i></button>
      </div>
      <div id="dealBoard" class="deal-board"></div>
      <div id="dealList" style="display:none"></div>`;
    this._syncOwner();
    this._ensureModals();
  },

  setOwner(o) { this.owner = String(o); this._syncOwner(); this.load(); },
  _syncOwner() {
    document.querySelectorAll('#dealOwnerChips .qf-btn').forEach(b => b.classList.toggle('active', b.dataset.ow === this.owner));
    const sel = document.getElementById('dealOwner');
    if (sel) sel.value = /^\d+$/.test(this.owner) ? this.owner : '';
  },

  // Phase „Angebot anfordern“: geht nur mit angebotsreifer Bedarfsanalyse (prüft der Server)
  istAnfrage(stageId) { const s = this.stages.find(x => x.id === stageId); return !!s && /anfordern|anfrage/i.test(s.name); },
  // Antwort des Servers auswerten: fehlende Pflichtfragen mit Knopf zur Bedarfsanalyse
  _fehler(e, leadId) {
    if (e.status === 409 && e.data?.fehlt) {
      document.getElementById('anfrageModal')?.remove();
      const o = document.createElement('div');
      o.id = 'anfrageModal'; o.className = 'modal-overlay open'; o.style.zIndex = 960;
      o.onclick = ev => { if (ev.target === o) o.remove(); };
      o.innerHTML = `<div class="modal modal-flex" style="max-width:480px">
        <div class="modal-header"><div class="modal-heading"><span class="modal-icon copper"><i class="fas fa-clipboard-list"></i></span>
          <div><div class="modal-title">Noch nicht angebotsreif</div><div class="modal-subtitle">Für „Angebot anfordern“ fehlt noch:</div></div></div>
          <button class="modal-x" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button></div>
        <div class="modal-body"><ul class="bd-fehlt">${e.data.fehlt.map(f => `<li>${escHtml(f)}</li>`).join('')}</ul></div>
        <div class="modal-footer"><button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Später</button>
          <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove();Deals.close();Bedarf.open(${leadId || e.data.lead_id})"><i class="fas fa-clipboard-list"></i> Bedarfsanalyse öffnen</button></div></div>`;
      document.body.appendChild(o);
      return;
    }
    showToast(e.message, 'err');
  },
  async angebotGesendet(id) {
    try {
      await api('POST', `/deals/${id}/angebot-gesendet`);
      showToast('Angebot als verschickt markiert – der Closer ist informiert');
      this.close();
      this._afterChange();
    } catch (e) { showToast(e.message, 'err'); }
  },

  async show() {
    if (!this._loaded && this.canSeeAll()) {
      try {
        this.users = await api('GET', '/users/list');
        const sel = document.getElementById('dealOwner');
        if (sel) { sel.insertAdjacentHTML('beforeend', this.users.map(u => `<option value="${u.id}">${escHtml(u.full_name)}</option>`).join('')); this._syncOwner(); }
      } catch (_) {}
    }
    this._loaded = true;
    await this.load();
  },

  async loadStages() {
    const r = await api('GET', '/deals/stages');
    this.stages = r.stages; this.lostReasons = r.lost_reasons;
  },

  async load() {
    try {
      const status = this.view === 'board' ? 'open' : this.status;
      const [, deals, summary] = await Promise.all([
        this.loadStages(),
        api('GET', `/deals?status=${status}&owner=${encodeURIComponent(this.owner)}`),
        api('GET', `/deals/summary?owner=${encodeURIComponent(this.owner)}`),
      ]);
      this.deals = deals;
      this.renderKpis(summary);
      this.render();
      if (!this.opts.isAdmin && typeof Provision !== 'undefined') Provision.bonusLeiste('dealBonus');
    } catch (e) { showToast(e.message, 'err'); }
  },

  setView(v) {
    this.view = v;
    document.getElementById('dealViewBoard').classList.toggle('active', v === 'board');
    document.getElementById('dealViewList').classList.toggle('active', v === 'list');
    document.getElementById('dealBoard').style.display = v === 'board' ? '' : 'none';
    document.getElementById('dealList').style.display = v === 'list' ? '' : 'none';
    document.getElementById('dealStatusChips').style.display = v === 'list' ? '' : 'none';
    this.load();
  },
  setStatus(st) {
    this.status = st;
    document.querySelectorAll('#dealStatusChips [data-st]').forEach(b => b.classList.toggle('active', b.dataset.st === st));
    this.load();
  },

  filtered() {
    if (!this.search) return this.deals;
    return this.deals.filter(d => [d.title, d.company, d.ceo, d.owner_name].some(x => String(x || '').toLowerCase().includes(this.search)));
  },

  renderKpis(s) {
    const kpi = (cls, icon, label, value, sub, onclick = '') =>
      `<div class="kpi-card ${cls}"${onclick ? ` onclick="${onclick}"` : ''}><div class="kpi-head"><span class="kpi-label">${label}</span><span class="kpi-icon"><i class="fas ${icon}"></i></span></div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
    document.getElementById('dealKpis').innerHTML =
      kpi('', 'fa-funnel-dollar', 'Offene Pipeline', this.fmtShort(s.open.value), `<b>${s.open.count}</b> offene Deals`, "Deals.setView('board')") +
      kpi('c-ink', 'fa-balance-scale', 'Gewichtete Prognose', this.fmtShort(s.open.weighted), 'Wert × Wahrscheinlichkeit der Phase') +
      kpi('c-green', 'fa-trophy', 'Gewonnen diesen Monat', this.fmtShort(s.won_month.value), `<b>${s.won_month.count}</b> Abschlüsse`, "Deals.setView('list');Deals.setStatus('won')") +
      kpi('c-copper', 'fa-calendar-check', 'Abschluss geplant', this.fmtShort(s.closing_month.value), `<b>${s.closing_month.count}</b> Deals bis Monatsende · <b>${s.lost_month.count}</b> verloren`);
  },

  render() {
    if (this.view === 'board') this.renderBoard(); else this.renderList();
  },

  // ── Pipeline-Board ──────────────────────────────────────────
  nextStep(d) {
    if (!d.next_reminder_at) return `<span class="dc-next ns-none" title="Kein nächster Schritt geplant"><i class="fas fa-exclamation-triangle"></i></span>`;
    const t = new Date(d.next_reminder_at);
    const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
    const cls = t < new Date() ? 'ns-overdue' : t <= endToday ? 'ns-today' : 'ns-future';
    return `<span class="dc-next ${cls}" title="Nächster Schritt: ${fmtDate(t)}"><i class="fas fa-bell"></i></span>`;
  },

  card(d) {
    const stage = this.stages.find(s => s.id === d.stage_id);
    const rotten = stage && stage.rot_days > 0 && d.days_in_stage > stage.rot_days;
    const overdueClose = d.expected_close_date && new Date(d.expected_close_date + 'T23:59:59') < new Date();
    return `
      <div class="deal-card${rotten ? ' is-rotten' : ''}" draggable="true" data-id="${d.id}"
           ondragstart="Deals.dragStart(event, ${d.id})" ondragend="Deals.dragEnd(event)" onclick="Deals.open(${d.id})">
        <div class="dc-title">${escHtml(d.title)}</div>
        <div class="dc-sub">${escHtml(d.company || '')}${d.ceo ? ' · ' + escHtml(d.ceo) : ''}</div>
        ${rotten ? `<div class="dc-rot"><i class="fas fa-hourglass-end"></i>${d.days_in_stage} Tage in dieser Phase</div>` : ''}
        ${d.admin_flag ? `<div class="dc-flag" title="${escHtml(d.admin_flag)}"><i class="fas fa-exclamation-triangle"></i>${escHtml(d.admin_flag)}</div>` : ''}
        <div class="dc-foot">
          <span class="dc-value">${this.fmt(d.value)}</span>
          ${d.expected_close_date ? `<span class="dc-close${overdueClose ? ' is-late' : ''}" title="Erwarteter Abschluss"><i class="fas fa-flag-checkered"></i>${fmtDateShort(d.expected_close_date + 'T12:00:00').slice(0, 6)}</span>` : ''}
          <span class="dc-spacer"></span>
          ${this.nextStep(d)}
          <span class="dc-owner" title="${escHtml(d.owner_name || '')}">${escHtml(this.initials(d.owner_name))}</span>
        </div>
      </div>`;
  },

  renderBoard() {
    const deals = this.filtered();
    const board = document.getElementById('dealBoard');
    if (!this.stages.length) { board.innerHTML = '<div class="wiki-empty">Keine Phasen angelegt.</div>'; return; }
    board.innerHTML = this.stages.map(s => {
      const col = deals.filter(d => d.stage_id === s.id);
      const sum = col.reduce((a, d) => a + Number(d.value || 0), 0);
      return `
        <div class="deal-col">
          <div class="deal-col-head">
            <div class="deal-col-name">${escHtml(s.name)} <span class="deal-col-prob">${s.probability}%</span></div>
            <div class="deal-col-sum">${this.fmt(sum)} · ${col.length} ${col.length === 1 ? 'Deal' : 'Deals'}</div>
          </div>
          <div class="deal-col-body" data-stage="${s.id}"
               ondragover="Deals.dragOver(event)" ondragleave="this.classList.remove('drag-over')" ondrop="Deals.drop(event, ${s.id})">
            ${col.map(d => this.card(d)).join('') || '<div class="pipeline-empty">Keine Deals</div>'}
          </div>
        </div>`;
    }).join('');
  },

  dragStart(e, id) {
    this._drag = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
    e.currentTarget.classList.add('dragging');
    document.getElementById('dealDropBar').classList.add('open');
  },
  dragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    document.getElementById('dealDropBar').classList.remove('open');
    document.querySelectorAll('.deal-col-body.drag-over, .deal-drop.drag-over').forEach(el => el.classList.remove('drag-over'));
  },
  dragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); },

  async drop(e, stageId) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const d = this.deals.find(x => x.id === this._drag);
    this._drag = null;
    if (!d || d.stage_id === stageId) return;
    const prev = d.stage_id;
    d.stage_id = stageId; d.days_in_stage = 0;
    this.renderBoard();
    try {
      const r = await api('PATCH', `/deals/${d.id}`, { stage_id: stageId });
      if (r?.message) showToast(r.message);
      this._refreshSummary();
    } catch (err) {
      d.stage_id = prev; this.renderBoard(); this._fehler(err, d.lead_id);
    }
  },
  async dropOutcome(e, outcome) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    document.getElementById('dealDropBar').classList.remove('open');
    const id = this._drag; this._drag = null;
    if (!id) return;
    if (outcome === 'won') this.markWon(id); else this.askLost(id);
  },

  async _refreshSummary() {
    try { this.renderKpis(await api('GET', `/deals/summary?owner=${encodeURIComponent(this.owner)}`)); } catch (_) {}
  },

  // ── Liste ───────────────────────────────────────────────────
  renderList() {
    const deals = this.filtered();
    const el = document.getElementById('dealList');
    if (!deals.length) { el.innerHTML = '<div class="card"><div class="wiki-empty" style="margin:10px 0"><i class="fas fa-handshake"></i>Keine Deals für diese Auswahl.</div></div>'; return; }
    const total = deals.reduce((a, d) => a + Number(d.value || 0), 0);
    const stCell = d => d.status === 'won' ? `<span class="deal-status won"><i class="fas fa-trophy"></i>Gewonnen ${fmtDateShort(d.won_at)}</span>`
      : d.status === 'lost' ? `<span class="deal-status lost" title="${escHtml(d.lost_reason || '')}"><i class="fas fa-times-circle"></i>Verloren · ${escHtml(d.lost_reason || '')}</span>`
      : `<span class="deal-status open">${escHtml(d.stage_name || '—')}</span>`;
    el.innerHTML = `
      <div class="card">
        <div class="card-header"><div class="card-title"><i class="fas fa-handshake"></i> Deals <span class="badge">${deals.length}</span></div><span class="cell-sub">Summe <b>${this.fmt(total)}</b></span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Deal</th><th>Wert</th><th>Phase / Status</th><th class="mob-hide">Verantwortlich</th><th class="mob-hide">Erw. Abschluss</th><th class="mob-hide">Nächster Schritt</th></tr></thead>
          <tbody>${deals.map(d => `
            <tr class="lead-row" onclick="Deals.open(${d.id})">
              <td><div class="cell-title">${escHtml(d.title)}</div><div class="cell-sub">${escHtml(d.company || '')}</div></td>
              <td><b>${this.fmt(d.value)}</b></td>
              <td>${stCell(d)}</td>
              <td class="mob-hide"><span class="cell-sub">${escHtml(d.owner_name || '—')}</span></td>
              <td class="mob-hide"><span class="cell-sub mono">${d.expected_close_date ? fmtDateShort(d.expected_close_date + 'T12:00:00') : '—'}</span></td>
              <td class="mob-hide">${d.status === 'open' ? nextStepCell({ ...d, status: 'open', last_call_at: null }) : '<span class="cell-sub">—</span>'}</td>
            </tr>`).join('')}
          </tbody></table></div>
      </div>`;
  },

  // ── Deal-Fenster ────────────────────────────────────────────
  _ensureModals() {
    if (document.getElementById('dealModal')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="deal-dropbar" id="dealDropBar">
        <div class="deal-drop lost" ondragover="Deals.dragOver(event)" ondragleave="this.classList.remove('drag-over')" ondrop="Deals.dropOutcome(event,'lost')"><i class="fas fa-times-circle"></i> Verloren</div>
        <div class="deal-drop won" ondragover="Deals.dragOver(event)" ondragleave="this.classList.remove('drag-over')" ondrop="Deals.dropOutcome(event,'won')"><i class="fas fa-trophy"></i> Gewonnen</div>
      </div>

      <div class="modal-overlay" id="dealModal" onclick="if(event.target===this)Deals.close()">
        <div class="modal deal-modal">
          <button class="modal-close" onclick="Deals.close()"><i class="fas fa-times"></i></button>
          <div class="modal-title" id="dmTitle">Deal</div>
          <div id="dmStatusBar"></div>
          <div class="form-group" id="dmLeadGroup">
            <label>Lead / Firma *</label>
            <input type="text" id="dmLeadSearch" class="form-control" placeholder="Firma suchen …" autocomplete="off" oninput="Deals.searchLeads(this.value)">
            <div class="deal-lead-results" id="dmLeadResults"></div>
          </div>
          <div class="form-group"><label>Titel *</label><input type="text" id="dmTitleInput" class="form-control" placeholder="z.B. Website-Relaunch Bäckerei Schmidt" maxlength="200"></div>
          <div class="deal-form-row">
            <div class="form-group"><label>Wert (netto, €)</label><input type="text" id="dmValue" class="form-control" inputmode="decimal" placeholder="z.B. 2.500"></div>
            <div class="form-group"><label>Erwarteter Abschluss</label><input type="date" id="dmClose" class="form-control"></div>
          </div>
          <div class="deal-form-row">
            <div class="form-group"><label>Phase</label><select id="dmStage" class="form-control"></select></div>
            <div class="form-group" id="dmOwnerGroup" style="display:none"><label>Verantwortlich</label><select id="dmOwner" class="form-control"></select></div>
          </div>
          <div class="form-group"><label>Notizen</label><textarea id="dmNotes" class="form-control" rows="3" placeholder="Umfang, Ansprechpartner, Besonderheiten …"></textarea></div>
          <div id="dmProvision"></div>
          <div class="deal-modal-err" id="dmErr"></div>
          <div class="deal-modal-actions" id="dmActions"></div>
        </div>
      </div>

      <div class="modal-overlay" id="dealLostModal" onclick="if(event.target===this)this.classList.remove('open')">
        <div class="modal" style="max-width:440px">
          <button class="modal-close" onclick="document.getElementById('dealLostModal').classList.remove('open')"><i class="fas fa-times"></i></button>
          <div class="modal-title">Deal als verloren markieren</div>
          <div class="form-group"><label>Warum verloren? *</label><div class="chip-row deal-reasons" id="dlReasons"></div></div>
          <div class="form-group"><label>Details (optional)</label><input type="text" id="dlReasonText" class="form-control" placeholder="z.B. hat sich für Agentur XY entschieden"></div>
          <div class="deal-modal-err" id="dlErr"></div>
          <button class="btn btn-danger" style="width:100%;justify-content:center" onclick="Deals.confirmLost()"><i class="fas fa-times-circle"></i> Als verloren markieren</button>
        </div>
      </div>

      <div class="modal-overlay" id="dealStageModal" onclick="if(event.target===this)Deals.closeStageEditor()">
        <div class="modal" style="max-width:560px">
          <button class="modal-close" onclick="Deals.closeStageEditor()"><i class="fas fa-times"></i></button>
          <div class="modal-title">Pipeline-Phasen</div>
          <p class="cell-sub" style="margin:-10px 0 14px">Wahrscheinlichkeit fließt in die gewichtete Prognose ein. „Rot nach“ markiert Deals, die zu lange ohne Fortschritt in einer Phase liegen.</p>
          <div id="stageRows"></div>
          <button class="btn btn-ghost btn-sm" onclick="Deals.addStage()"><i class="fas fa-plus"></i> Phase hinzufügen</button>
        </div>
      </div>`);
  },

  _fillStageSelect(selected) {
    document.getElementById('dmStage').innerHTML = this.stages.map(s =>
      `<option value="${s.id}"${s.id === selected ? ' selected' : ''}>${escHtml(s.name)} (${s.probability}%)</option>`).join('');
  },
  async _fillOwnerSelect(selected) {
    const grp = document.getElementById('dmOwnerGroup');
    if (!this.opts.isAdmin) { grp.style.display = 'none'; return; }
    if (!this.users.length) { try { this.users = await api('GET', '/users/list'); } catch (_) {} }
    grp.style.display = '';
    document.getElementById('dmOwner').innerHTML = this.users.map(u =>
      `<option value="${u.id}"${u.id === selected ? ' selected' : ''}>${escHtml(u.full_name)}</option>`).join('');
  },

  // Neuer Deal — optional direkt für einen Lead (aus Lead-Panel / Anrufmodus)
  async openNew(leadId, company) {
    if (!this.stages.length) await this.loadStages();
    this._current = null;
    this._newLeadId = leadId || null;
    document.getElementById('dmTitle').textContent = 'Neuer Deal';
    document.getElementById('dmStatusBar').innerHTML = '';
    document.getElementById('dmProvision').innerHTML = '';
    document.getElementById('dmLeadGroup').style.display = leadId ? 'none' : '';
    document.getElementById('dmLeadSearch').value = '';
    document.getElementById('dmLeadResults').innerHTML = '';
    document.getElementById('dmTitleInput').value = company || '';
    document.getElementById('dmValue').value = '';
    document.getElementById('dmClose').value = '';
    document.getElementById('dmNotes').value = '';
    document.getElementById('dmErr').textContent = '';
    this._fillStageSelect(this.stages[0]?.id);
    await this._fillOwnerSelect(ME?.id);
    document.getElementById('dmActions').innerHTML =
      `<button class="btn btn-primary" onclick="Deals.save()"><i class="fas fa-check"></i> Deal anlegen</button>
       <button class="btn btn-ghost" onclick="Deals.close()">Abbrechen</button>`;
    document.getElementById('dealModal').classList.add('open');
    setTimeout(() => document.getElementById(leadId ? 'dmValue' : 'dmLeadSearch').focus(), 50);
  },

  async searchLeads(q) {
    const el = document.getElementById('dmLeadResults');
    this._newLeadId = null;
    if (q.trim().length < 2) { el.innerHTML = ''; return; }
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(async () => {
      try {
        const mine = this.opts.isAdmin ? '' : '&mine=1';
        const rows = await api('GET', `/leads?search=${encodeURIComponent(q.trim())}&limit=8${mine}`);
        el.innerHTML = rows.map(l => `<button type="button" class="deal-lead-opt" onclick="Deals.pickLead(${l.id}, ${escHtml(JSON.stringify(l.company || ''))})">
            <b>${escHtml(l.company || '—')}</b><span>${escHtml([l.ceo, l.location].filter(Boolean).join(' · '))}</span></button>`).join('')
          || '<div class="cell-sub" style="padding:8px">Kein passender Lead gefunden</div>';
      } catch (e) { el.innerHTML = ''; }
    }, 200);
  },
  pickLead(id, company) {
    this._newLeadId = id;
    document.getElementById('dmLeadSearch').value = company;
    document.getElementById('dmLeadResults').innerHTML = '';
    const t = document.getElementById('dmTitleInput');
    if (!t.value) t.value = company;
    document.getElementById('dmValue').focus();
  },

  async open(id) {
    if (!this.stages.length) await this.loadStages();
    let d = this.deals.find(x => x.id === id);
    if (!d) {
      const all = await api('GET', `/deals?status=all&owner=${this.canSeeAll() ? 'all' : 'me'}`).catch(() => []);
      d = all.find(x => x.id === id);
    }
    if (!d) { showToast('Deal nicht gefunden', 'err'); return; }
    this._current = d;
    document.getElementById('dmTitle').textContent = d.company || 'Deal';
    document.getElementById('dmLeadGroup').style.display = 'none';
    document.getElementById('dmTitleInput').value = d.title;
    document.getElementById('dmValue').value = Number(d.value) ? Number(d.value).toLocaleString('de-DE') : '';
    document.getElementById('dmClose').value = d.expected_close_date || '';
    document.getElementById('dmNotes').value = d.notes || '';
    document.getElementById('dmErr').textContent = '';
    this._fillStageSelect(d.stage_id);
    await this._fillOwnerSelect(d.owner_id);

    // Phasen-Leiste wie bei Pipedrive: anklicken = Phase wechseln
    const idx = this.stages.findIndex(s => s.id === d.stage_id);
    const steps = d.status === 'open' ? `<div class="deal-steps">${this.stages.map((s, i) =>
      `<button type="button" class="deal-step${i <= idx ? ' done' : ''}${i === idx ? ' current' : ''}" onclick="Deals.moveTo(${s.id})" title="${escHtml(s.name)}">${escHtml(s.name)}</button>`).join('')}</div>` : '';
    const banner = d.status === 'won' ? `<div class="deal-banner won"><i class="fas fa-trophy"></i>Gewonnen am ${fmtDate(d.won_at)}</div>`
      : d.status === 'lost' ? `<div class="deal-banner lost"><i class="fas fa-times-circle"></i>Verloren am ${fmtDate(d.lost_at)} · ${escHtml(d.lost_reason || '')}</div>` : '';
    document.getElementById('dmStatusBar').innerHTML = banner + steps;

    const angebotBtn = typeof this.opts.onAngebot === 'function' && d.status === 'open'
      ? `<button class="btn btn-ghost" onclick="Deals.opts.onAngebot(Deals._current)"><i class="fas fa-file-signature"></i> Angebot erstellen</button>` : '';
    const leadBtn = typeof this.opts.openLead === 'function'
      ? `<button class="btn btn-ghost" onclick="Deals.close();Deals.opts.openLead(${d.lead_id})"><i class="fas fa-external-link-alt"></i> Lead</button>` : '';
    const bedarfBtn = typeof Bedarf !== 'undefined'
      ? `<button class="btn btn-ghost" onclick="Deals.close();Bedarf.open(${d.lead_id})"><i class="fas fa-clipboard-list"></i> Bedarfsanalyse</button>` : '';
    const gesendetBtn = this.opts.isAdmin && d.status === 'open' && this.istAnfrage(d.stage_id)
      ? `<button class="btn btn-ghost" onclick="Deals.angebotGesendet(${d.id})"><i class="fas fa-paper-plane"></i> Angebot verschickt</button>` : '';
    const del = this.opts.isAdmin ? `<button class="btn btn-ghost btn-icon" onclick="Deals.remove()" title="Deal löschen"><i class="fas fa-trash"></i></button>` : '';
    document.getElementById('dmActions').innerHTML = d.status === 'open'
      ? `<button class="btn btn-primary" onclick="Deals.save()"><i class="fas fa-check"></i> Speichern</button>
         <span class="dc-spacer"></span>
         <button class="btn deal-btn-won" onclick="Deals.markWon(${d.id})"><i class="fas fa-trophy"></i> Gewonnen</button>
         <button class="btn deal-btn-lost" onclick="Deals.askLost(${d.id})"><i class="fas fa-times-circle"></i> Verloren</button>
         ${gesendetBtn}${angebotBtn}${bedarfBtn}${leadBtn}${del}`
      : `<button class="btn btn-primary" onclick="Deals.save()"><i class="fas fa-check"></i> Speichern</button>
         <button class="btn btn-ghost" onclick="Deals.reopen(${d.id})"><i class="fas fa-undo"></i> Wieder öffnen</button>
         <span class="dc-spacer"></span>${leadBtn}${del}`;
    document.getElementById('dealModal').classList.add('open');
    if (typeof Provision !== 'undefined') Provision.dealBox('dmProvision', d, { admin: !!this.opts.isAdmin });
  },

  close() { document.getElementById('dealModal').classList.remove('open'); },

  _formData() {
    const raw = document.getElementById('dmValue').value.trim();
    const body = {
      title: document.getElementById('dmTitleInput').value.trim(),
      value: raw,
      expected_close_date: document.getElementById('dmClose').value || null,
      stage_id: parseInt(document.getElementById('dmStage').value) || null,
      notes: document.getElementById('dmNotes').value.trim(),
    };
    if (this.opts.isAdmin) body.owner_id = parseInt(document.getElementById('dmOwner').value) || null;
    return body;
  },

  async save() {
    const err = document.getElementById('dmErr');
    const body = this._formData();
    if (!body.title) { err.textContent = 'Bitte einen Titel angeben.'; return; }
    try {
      if (this._current) {
        const r = await api('PATCH', `/deals/${this._current.id}`, body);
        showToast(r?.message || 'Deal gespeichert');
      } else {
        if (!this._newLeadId) { err.textContent = 'Bitte einen Lead aus der Liste auswählen.'; return; }
        await api('POST', '/deals', { ...body, lead_id: this._newLeadId });
        showToast('Deal angelegt');
      }
      this.close();
      this._afterChange();
    } catch (e) { if (e.status === 409 && e.data?.fehlt) this._fehler(e, this._current?.lead_id); else err.textContent = e.message; }
  },

  async moveTo(stageId) {
    if (!this._current) return;
    try {
      const r = await api('PATCH', `/deals/${this._current.id}`, { stage_id: stageId });
      if (r?.message) showToast(r.message);
      this._current.stage_id = stageId;
      const local = this.deals.find(x => x.id === this._current.id);
      if (local) { local.stage_id = stageId; local.days_in_stage = 0; }
      this.open(this._current.id);
      this._afterChange(true);
    } catch (e) { showToast(e.message, 'err'); }
  },

  async markWon(id) {
    const d = (this.deals || []).find(x => x.id === id) || this._current || {};
    const ok = await customConfirm(`Deal${d.title ? ` „${d.title}“` : ''} als gewonnen markieren?`, { title: 'Gewonnen', okLabel: 'Ja, gewonnen' });
    if (!ok) return;
    try {
      await api('POST', `/deals/${id}/won`, {});
      showToast('Deal gewonnen 🎉');
      this.close();
      this._afterChange();
    } catch (e) { showToast(e.message, 'err'); }
  },

  askLost(id) {
    this._lostId = id;
    this._lostReason = null;
    document.getElementById('dlReasons').innerHTML = this.lostReasons.map(r =>
      `<button type="button" class="qf-btn" onclick="Deals.pickReason(this)">${escHtml(r)}</button>`).join('');
    document.getElementById('dlReasonText').value = '';
    document.getElementById('dlErr').textContent = '';
    document.getElementById('dealLostModal').classList.add('open');
  },
  pickReason(btn) {
    this._lostReason = btn.textContent;
    document.querySelectorAll('#dlReasons .qf-btn').forEach(b => b.classList.toggle('active', b === btn));
  },
  async confirmLost() {
    const detail = document.getElementById('dlReasonText').value.trim();
    if (!this._lostReason) { document.getElementById('dlErr').textContent = 'Bitte einen Grund wählen.'; return; }
    if (this._lostReason === 'Sonstiges' && !detail) { document.getElementById('dlErr').textContent = 'Bei „Sonstiges“ bitte kurz beschreiben, warum.'; return; }
    try {
      await api('POST', `/deals/${this._lostId}/lost`, { grund: this._lostReason, text: detail });
      document.getElementById('dealLostModal').classList.remove('open');
      this.close();
      showToast('Deal als verloren markiert');
      this._afterChange();
    } catch (e) { document.getElementById('dlErr').textContent = e.message; }
  },

  async reopen(id) {
    try { await api('POST', `/deals/${id}/reopen`, {}); showToast('Deal wieder geöffnet'); this.close(); this._afterChange(); }
    catch (e) { showToast(e.message, 'err'); }
  },

  async remove() {
    if (!this._current) return;
    const ok = await customConfirm(`Deal „${this._current.title}“ endgültig löschen?`, { title: 'Deal löschen', okLabel: 'Löschen', danger: true });
    if (!ok) return;
    try { await api('DELETE', `/deals/${this._current.id}`); showToast('Deal gelöscht'); this.close(); this._afterChange(); }
    catch (e) { showToast(e.message, 'err'); }
  },

  _afterChange(quiet) {
    if (document.getElementById(this.opts.rootId)?.offsetParent !== null && this._loaded) this.load();
    if (!quiet && typeof this.opts.onChange === 'function') this.opts.onChange();
  },

  // ── Abschnitt im Lead-Panel ─────────────────────────────────
  leadSection(l, canEdit) {
    const deals = l.deals || [];
    const rows = deals.map(d => {
      const st = d.status === 'won' ? '<span class="deal-status won"><i class="fas fa-trophy"></i>Gewonnen</span>'
        : d.status === 'lost' ? `<span class="deal-status lost"><i class="fas fa-times-circle"></i>Verloren</span>`
        : `<span class="deal-status open">${escHtml(d.stage_name || '')}</span>`;
      return `<button type="button" class="deal-mini" onclick="Deals.open(${d.id})">
        <span class="deal-mini-main"><b>${escHtml(d.title)}</b>${st}</span><span class="deal-mini-val">${this.fmt(d.value)}</span></button>`;
    }).join('');
    return `<div class="panel-section">
      <div class="panel-section-title">Deals</div>
      ${rows ? `<div class="panel-list">${rows}</div>` : '<div class="panel-empty">Noch kein Deal – sobald Interesse besteht, Deal mit Wert anlegen.</div>'}
      ${canEdit ? `<button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="Deals.openNew(${l.id}, ${escHtml(JSON.stringify(l.company || ''))})"><i class="fas fa-plus"></i> Deal anlegen</button>` : ''}
    </div>`;
  },

  // ── Phasen bearbeiten (Admin) ───────────────────────────────
  async openStageEditor() {
    await this.loadStages();
    this._renderStageRows();
    document.getElementById('dealStageModal').classList.add('open');
  },
  closeStageEditor() {
    document.getElementById('dealStageModal').classList.remove('open');
    this.load();
  },
  _renderStageRows() {
    document.getElementById('stageRows').innerHTML = `
      <div class="stage-row stage-head"><span></span><span>Name</span><span>Wahrsch.</span><span>Rot nach</span><span></span></div>` +
      this.stages.map((s, i) => `
      <div class="stage-row">
        <span class="stage-move">
          <button class="panel-icon-btn" ${i === 0 ? 'disabled' : ''} onclick="Deals.moveStage(${i},-1)" title="Nach oben"><i class="fas fa-arrow-up"></i></button>
          <button class="panel-icon-btn" ${i === this.stages.length - 1 ? 'disabled' : ''} onclick="Deals.moveStage(${i},1)" title="Nach unten"><i class="fas fa-arrow-down"></i></button>
        </span>
        <input class="form-control" value="${escHtml(s.name)}" maxlength="100" onchange="Deals.updateStage(${s.id},{name:this.value})">
        <span class="stage-num"><input class="form-control" type="number" min="0" max="100" value="${s.probability}" onchange="Deals.updateStage(${s.id},{probability:this.value})">%</span>
        <span class="stage-num"><input class="form-control" type="number" min="0" max="365" value="${s.rot_days}" onchange="Deals.updateStage(${s.id},{rot_days:this.value})">Tg.</span>
        <button class="panel-icon-btn" onclick="Deals.deleteStage(${s.id})" title="Phase entfernen"><i class="fas fa-trash"></i></button>
      </div>`).join('');
  },
  async updateStage(id, patch) {
    try { await api('PATCH', `/deals/stages/${id}`, patch); await this.loadStages(); showToast('Phase gespeichert'); }
    catch (e) { showToast(e.message, 'err'); this._renderStageRows(); }
  },
  async moveStage(i, dir) {
    const ids = this.stages.map(s => s.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    try { await api('PUT', '/deals/stages/order', { ids }); await this.loadStages(); this._renderStageRows(); }
    catch (e) { showToast(e.message, 'err'); }
  },
  async addStage() {
    try {
      await api('POST', '/deals/stages', { name: 'Neue Phase', probability: 50, rot_days: 14 });
      await this.loadStages(); this._renderStageRows();
      const inputs = document.querySelectorAll('#stageRows .stage-row:last-child input');
      inputs[0]?.select();
    } catch (e) { showToast(e.message, 'err'); }
  },
  async deleteStage(id) {
    const ok = await customConfirm('Phase entfernen? Abgeschlossene Deals bleiben erhalten.', { title: 'Phase entfernen', okLabel: 'Entfernen', danger: true });
    if (!ok) return;
    try { await api('DELETE', `/deals/stages/${id}`); await this.loadStages(); this._renderStageRows(); }
    catch (e) { showToast(e.message, 'err'); }
  },
};
