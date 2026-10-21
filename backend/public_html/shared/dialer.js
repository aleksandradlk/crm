// ============================================================
// Anrufmodus (Power-Dialer)
// Ein Lead nach dem anderen: anrufen → Ergebnis wählen → Wiedervorlage
// → „Speichern & weiter“. Reihenfolge kommt vom Server (/leads/queue).
// Tasten: 1–8 Ergebnis · Strg+Enter speichern & weiter · Esc schließen
// ============================================================
const Dialer = {
  OUTCOMES: [
    { key: 'nicht_erreicht', label: 'Nicht erreicht',     icon: 'fa-phone-slash',     tone: 'muted',  followUp: 'tomorrow10' },
    { key: 'besetzt',        label: 'Besetzt',            icon: 'fa-ban',             tone: 'muted',  followUp: '+1h' },
    { key: 'mailbox',        label: 'Mailbox',            icon: 'fa-voicemail',       tone: 'muted',  followUp: 'tomorrow10' },
    { key: 'rueckruf',       label: 'Rückruf vereinbart', icon: 'fa-phone-volume',    tone: 'copper', followUp: 'required' },
    { key: 'interesse',      label: 'Interesse',          icon: 'fa-fire',            tone: 'accent', followUp: '+3d' },
    { key: 'kein_interesse', label: 'Kein Interesse',     icon: 'fa-thumbs-down',     tone: 'red',    followUp: null },
    { key: 'kunde',          label: 'Abschluss',          icon: 'fa-trophy',          tone: 'green',  followUp: null },
    { key: 'falsche_nummer', label: 'Falsche Nummer',     icon: 'fa-triangle-exclamation', tone: 'red', followUp: null },
  ],
  FOLLOW_UPS: [
    ['+1h', 'In 1 Std.'], ['today16', 'Heute 16 Uhr'], ['tomorrow10', 'Morgen 10 Uhr'],
    ['+3d', 'In 3 Tagen'], ['nextweek', 'Nächste Woche'],
  ],

  queue: [], idx: 0, lead: null, opts: {},
  outcome: null, followUp: null, callLogId: null, durationSec: null,
  callsToday: 0, saving: false, _keyHandler: null,

  async open(opts = {}) {
    this.opts = opts;
    // Fokus aus Eingabefeldern dahinter nehmen, sonst greifen die Tasten 1–8 nicht
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    this._ensureDom();
    document.getElementById('dialer').classList.add('open');
    document.body.classList.add('dialer-open');
    this._keyHandler = e => this._onKey(e);
    document.addEventListener('keydown', this._keyHandler);
    this._body('<div class="dl-empty"><i class="fas fa-spinner fa-spin"></i></div>');
    try {
      const [q, dash] = await Promise.all([
        api('GET', '/leads/queue'),
        api('GET', '/leads/dashboard/closer').catch(() => ({})),
      ]);
      this.queue = q.leads || [];
      this.meta = q;
      this.callsToday = dash.callsToday || 0;
      this.idx = 0;
      this._show();
    } catch (e) {
      this._body(`<div class="dl-empty"><i class="fas fa-exclamation-triangle"></i>${escHtml(e.message)}</div>`);
    }
  },

  close() {
    if (Softphone.call) { showToast('Bitte zuerst auflegen', 'err'); return; }
    document.getElementById('dialer')?.classList.remove('open');
    document.body.classList.remove('dialer-open');
    document.removeEventListener('keydown', this._keyHandler);
    if (typeof this.opts.onClose === 'function') this.opts.onClose();
  },

  // ── Darstellung ─────────────────────────────────────────────
  _ensureDom() {
    if (document.getElementById('dialer')) return;
    const el = document.createElement('div');
    el.id = 'dialer';
    el.className = 'dialer';
    el.innerHTML = `
      <div class="dl-top">
        <div class="dl-title"><i class="fas fa-headset"></i> Anrufmodus</div>
        <div class="dl-progress" id="dlProgress"></div>
        <div class="dl-goal" id="dlGoal"></div>
        <button class="btn btn-ghost btn-sm" onclick="Dialer.close()" title="Schließen (Esc)"><i class="fas fa-times"></i> Beenden</button>
      </div>
      <div class="dl-body" id="dlBody"></div>`;
    document.body.appendChild(el);
  },
  _body(html) { document.getElementById('dlBody').innerHTML = html; },

  _header() {
    const total = this.queue.length;
    document.getElementById('dlProgress').innerHTML = total
      ? `<b>${Math.min(this.idx + 1, total)}</b> von ${total}${this.meta?.due_followups ? ` · <span class="dl-due">${this.meta.due_followups} Wiedervorlagen fällig</span>` : ''}`
      : '';
    const goal = this.opts.goal || 0;
    const pct = goal ? Math.min(100, Math.round(this.callsToday / goal * 100)) : 0;
    document.getElementById('dlGoal').innerHTML = goal
      ? `<span>${this.callsToday} / ${goal} Anrufe heute</span><div class="dl-goal-bar"><div style="width:${pct}%"></div></div>`
      : `<span>${this.callsToday} Anrufe heute</span>`;
  },

  _show() {
    this._header();
    this.outcome = null; this.followUp = null; this.callLogId = null; this.durationSec = null;
    if (this.idx >= this.queue.length) {
      const noPhone = this.meta?.without_phone ? `<p>${this.meta.without_phone} Lead(s) ohne Telefonnummer sind nicht in der Liste.</p>` : '';
      this._body(`<div class="dl-empty dl-done">
        <i class="fas fa-check-circle"></i>
        <h2>Alles abtelefoniert</h2>
        <p>Für heute ist nichts mehr fällig. Neue Leads kannst du unter „Alle Leads“ übernehmen.</p>${noPhone}
        <button class="btn btn-primary" onclick="Dialer.close()">Zurück zur Übersicht</button>
      </div>`);
      return;
    }
    this.lead = this.queue[this.idx];
    const l = this.lead;
    const reasonCls = l.reminder_id ? 'is-due' : l.status === 'neu' ? 'is-new' : '';
    const reasonText = l.reminder_id
      ? `Wiedervorlage ${fmtDate(l.remind_at)}${l.reminder_note ? ': ' + escHtml(l.reminder_note) : ''}`
      : escHtml(l.reason || '');
    const lastCall = l.last_call_at
      ? `${l.call_count}× angerufen, zuletzt ${fmtDate(l.last_call_at)}`
      : 'Noch nie angerufen';
    const meta = [
      l.location && `<span><i class="fas fa-map-marker-alt"></i>${escHtml(l.location)}</span>`,
      l.industry && `<span><i class="fas fa-industry"></i>${escHtml(l.industry)}</span>`,
      l.website && `<a href="${escHtml(absUrl(l.website))}" target="_blank" rel="noopener"><i class="fas fa-globe"></i>${escHtml(l.website)}</a>`,
      l.email && `<span><i class="fas fa-envelope"></i>${escHtml(l.email)}</span>`,
    ].filter(Boolean).join('');

    this._body(`
      <div class="dl-main">
        <div class="dl-card dl-lead">
          <div class="dl-reason ${reasonCls}"><i class="fas ${l.reminder_id ? 'fa-bell' : 'fa-circle'}"></i>${reasonText}</div>
          <h2 class="dl-company">${escHtml(l.company || '—')}</h2>
          ${l.ceo ? `<div class="dl-contact"><i class="fas fa-user"></i>${escHtml(l.ceo)}</div>` : ''}
          <div class="dl-phone-row">
            <span class="dl-phone mono">${escHtml(l.phone)}</span>
            <button class="btn btn-ghost btn-sm btn-icon" onclick="Dialer.copy()" title="Nummer kopieren"><i class="fas fa-copy"></i></button>
          </div>
          <div class="dl-actions">
            <button class="dl-call" id="dlCallBtn" onclick="Dialer.call()"><i class="fas fa-phone-alt"></i> Anrufen</button>
            <button class="btn btn-ghost" onclick="Dialer.skip()" title="Überspringen (taucht beim nächsten Öffnen wieder auf)"><i class="fas fa-forward"></i> Überspringen</button>
            ${typeof this.opts.openLead === 'function' ? `<button class="btn btn-ghost" onclick="Dialer.opts.openLead(${l.id})"><i class="fas fa-external-link-alt"></i> Details</button>` : ''}
          </div>
          <div class="dl-meta">${meta}<span><i class="fas fa-history"></i>${lastCall}</span> ${statusBadge(l.status)}</div>
          <div class="dl-history" id="dlHistory"></div>
        </div>

        <div class="dl-card dl-result">
          <div class="dl-label">Ergebnis <span class="dl-hint">Taste 1–8</span></div>
          <div class="dl-outcomes">
            ${this.OUTCOMES.map((o, i) => `
              <button class="dl-outcome t-${o.tone}" data-outcome="${o.key}" onclick="Dialer.pick('${o.key}')">
                <kbd>${i + 1}</kbd><i class="fas ${o.icon}"></i><span>${o.label}</span>
              </button>`).join('')}
          </div>

          <div class="dl-label">Notiz</div>
          <textarea id="dlNote" class="form-control" rows="3" placeholder="Was wurde besprochen? Ansprechpartner, Einwände, nächster Schritt …"></textarea>

          <div id="dlFollowUp" class="dl-followup" hidden>
            <div class="dl-label">Wiedervorlage</div>
            <div class="dl-chips">
              ${this.FOLLOW_UPS.filter(([k]) => k !== 'today16' || new Date().getHours() < 15).map(([k, label]) => `<button class="qf-btn" data-fu="${k}" onclick="Dialer.setFollowUp('${k}')">${label}</button>`).join('')}
              <button class="qf-btn" data-fu="none" onclick="Dialer.setFollowUp('none')">Keine</button>
            </div>
            <input type="datetime-local" id="dlFollowUpAt" class="form-control" onchange="Dialer.setFollowUp('custom')">
          </div>

          <div id="dlDeal" class="dl-deal" hidden></div>

          <div class="dl-error" id="dlError"></div>
          <button class="btn btn-primary dl-save" id="dlSaveBtn" onclick="Dialer.save()" disabled>
            <i class="fas fa-check"></i> Speichern &amp; nächster Lead <kbd>Strg</kbd>+<kbd>Enter</kbd>
          </button>
        </div>
      </div>
      ${this.opts.script ? `<details class="dl-card dl-script" open><summary><i class="fas fa-scroll"></i> Gesprächsleitfaden</summary><div>${escHtml(this.opts.script)}</div></details>` : ''}`);
    this._loadHistory(l.id);
  },

  async _loadHistory(leadId) {
    try {
      const d = await api('GET', `/leads/${leadId}`);
      if (!this.lead || this.lead.id !== leadId) return;
      const items = (d.comments || []).slice(-4).reverse();
      const el = document.getElementById('dlHistory');
      if (el && items.length) {
        el.innerHTML = `<div class="dl-label">Letzte Aktivität</div>` + items.map(c =>
          `<div class="dl-hist-item"><span>${fmtDate(c.created_at)} · ${escHtml(c.full_name || '')}</span>${escHtml(c.text)}</div>`
        ).join('');
      }
      if (d.notes && el) el.insertAdjacentHTML('afterbegin', `<div class="dl-notes"><i class="fas fa-sticky-note"></i>${escHtml(d.notes)}</div>`);
    } catch (_) {}
  },

  // ── Anrufen ─────────────────────────────────────────────────
  async call() {
    const l = this.lead;
    if (!l) return;
    if (Softphone.isEnabled()) {
      Softphone.dial({
        leadId: l.id, phone: l.phone, label: l.company,
        onEnd: ({ callLogId, answered, durationSec }) => {
          if (!this.lead || this.lead.id !== l.id) return;
          this.callLogId = callLogId;
          this.durationSec = durationSec;
          this.callsToday++;
          this._header();
          if (!this.outcome) this.pick(answered ? 'interesse' : 'nicht_erreicht', true);
          document.getElementById('dlNote')?.focus();
        },
      });
      return;
    }
    // Ohne Browser-Telefonie: Nummer über die Telefon-App des Rechners wählen
    try {
      const r = await api('POST', `/leads/${l.id}/calls/start`);
      this.callLogId = r.id;
      this.callsToday++;
      this._header();
    } catch (e) { showToast(e.message, 'err'); return; }
    window.location.href = 'tel:' + String(l.phone).replace(/[^\d+]/g, '');
    document.getElementById('dlNote')?.focus();
  },

  // ── Ergebnis & Wiedervorlage ────────────────────────────────
  pick(key, auto = false) {
    const o = this.OUTCOMES.find(x => x.key === key);
    if (!o) return;
    this.outcome = key;
    document.querySelectorAll('#dlBody .dl-outcome').forEach(b => b.classList.toggle('active', b.dataset.outcome === key));
    const fu = document.getElementById('dlFollowUp');
    fu.hidden = !o.followUp;
    if (o.followUp && o.followUp !== 'required') this.setFollowUp(o.followUp);
    else this.setFollowUp(o.followUp === 'required' ? null : 'none');
    if (o.followUp === 'required' && !auto) document.getElementById('dlFollowUpAt').focus();
    this._renderDeal(key);
    this._validate();
  },

  // Deal direkt aus dem Gespräch: anlegen, Wert anpassen oder als gewonnen buchen
  _renderDeal(key) {
    const el = document.getElementById('dlDeal');
    const l = this.lead;
    const prevValue = document.getElementById('dlDealValue')?.value;
    const hasDeal = !!l.deal_id;
    const valueInput = (label, val) => `
      <div class="dl-deal-row">
        <label for="dlDealValue">${label}</label>
        <div class="dl-deal-input"><input type="text" id="dlDealValue" class="form-control" inputmode="decimal" placeholder="z.B. 2.500" value="${escHtml(prevValue ?? val ?? '')}"><span>€</span></div>
      </div>`;
    const dealInfo = hasDeal
      ? `<div class="dl-deal-info"><i class="fas fa-handshake"></i><span><b>${escHtml(l.deal_title)}</b> · ${escHtml(l.deal_stage || '')}</span></div>` : '';
    const existingVal = hasDeal && Number(l.deal_value) ? Number(l.deal_value).toLocaleString('de-DE') : '';
    let html = '';
    if (key === 'kunde') {
      html = `<div class="dl-label">Deal</div>${dealInfo}
        ${valueInput(hasDeal ? 'Auftragswert – Deal wird als gewonnen gebucht' : 'Auftragswert – wird als gewonnener Deal gebucht', existingVal)}`;
    } else if (key === 'interesse' || key === 'rueckruf') {
      html = hasDeal
        ? `<div class="dl-label">Deal</div>${dealInfo}${valueInput('Wert anpassen', existingVal)}`
        : `<div class="dl-label">Deal</div>
           <label class="dl-deal-check"><input type="checkbox" id="dlDealCreate" ${key === 'interesse' ? 'checked' : ''} onchange="document.getElementById('dlDealValueWrap').hidden=!this.checked"> Deal in der Pipeline anlegen</label>
           <div id="dlDealValueWrap" ${key === 'interesse' ? '' : 'hidden'}>${valueInput('Geschätzter Wert', '')}</div>`;
    } else if (key === 'kein_interesse' && hasDeal) {
      html = `<div class="dl-label">Deal</div>${dealInfo}<div class="dl-deal-hint">Der offene Deal wird als verloren markiert („Kein Bedarf“).</div>`;
    }
    el.innerHTML = html;
    el.hidden = !html;
  },

  setFollowUp(key) {
    const input = document.getElementById('dlFollowUpAt');
    if (key === 'custom') {
      this.followUp = input.value ? new Date(input.value) : null;
    } else if (key === 'none' || key === null) {
      this.followUp = null;
      if (input) input.value = '';
    } else {
      this.followUp = this._resolve(key);
      if (input) input.value = this._toLocalInput(this.followUp);
    }
    this._followUpKey = key;
    document.querySelectorAll('#dlFollowUp [data-fu]').forEach(b => b.classList.toggle('active', b.dataset.fu === key));
    this._validate();
  },

  _resolve(key) {
    const d = new Date();
    const at = (days, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(h, m, 0, 0); return x; };
    if (key === '+1h') return new Date(d.getTime() + 3600000);
    if (key === 'today16') return d.getHours() < 16 ? at(0, 16) : at(1, 10);
    if (key === 'tomorrow10') {
      const x = at(1, 10);
      while ([0, 6].includes(x.getDay())) x.setDate(x.getDate() + 1);  // Wochenende überspringen
      return x;
    }
    if (key === '+3d') {
      const x = at(3, 10);
      while ([0, 6].includes(x.getDay())) x.setDate(x.getDate() + 1);
      return x;
    }
    if (key === 'nextweek') { const x = at(7 - ((d.getDay() + 6) % 7), 10); return x; }  // nächster Montag
    return null;
  },
  _toLocalInput(d) {
    if (!d) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  _toSql(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
  },

  _validate() {
    const btn = document.getElementById('dlSaveBtn');
    const err = document.getElementById('dlError');
    if (!btn) return false;
    const o = this.OUTCOMES.find(x => x.key === this.outcome);
    let msg = '';
    if (!o) msg = '';
    else if (o.followUp === 'required' && !this.followUp) msg = 'Wann soll zurückgerufen werden?';
    else if (this.followUp && this.followUp.getTime() < Date.now() - 60000) msg = 'Die Wiedervorlage liegt in der Vergangenheit.';
    err.textContent = msg;
    const ok = !!o && !msg;
    btn.disabled = !ok || this.saving;
    return ok;
  },

  async save() {
    if (!this._validate() || this.saving || !this.lead) return;
    if (Softphone.call) { showToast('Bitte zuerst auflegen', 'err'); return; }
    this.saving = true;
    const btn = document.getElementById('dlSaveBtn');
    btn.disabled = true;
    const l = this.lead;
    try {
      await api('POST', `/leads/${l.id}/outcome`, {
        outcome: this.outcome,
        note: document.getElementById('dlNote').value,
        deal: document.getElementById('dlDealValue') || document.getElementById('dlDealCreate') ? {
          create: !!document.getElementById('dlDealCreate')?.checked,
          value: document.getElementById('dlDealValue')?.value || undefined,
        } : undefined,
        call_log_id: this.callLogId,
        duration_seconds: this.durationSec,
        follow_up_at: this.followUp ? this._toSql(this.followUp) : null,
      });
      if (!this.callLogId) { this.callsToday++; }
      const o = this.OUTCOMES.find(x => x.key === this.outcome);
      showToast(o.key === 'kunde' ? 'Abschluss gespeichert 🎉' : `${o.label} gespeichert`);
      this.idx++;
      this._show();
    } catch (e) {
      document.getElementById('dlError').textContent = e.message;
    } finally {
      this.saving = false;
      this._validate();
    }
  },

  copy() {
    if (!this.lead?.phone) return;
    navigator.clipboard.writeText(this.lead.phone).then(() => showToast('Nummer kopiert'));
  },

  skip() {
    if (Softphone.call) { showToast('Bitte zuerst auflegen', 'err'); return; }
    this.idx++;
    this._show();
  },

  _onKey(e) {
    if (!document.getElementById('dialer')?.classList.contains('open')) return;
    if (e.key === 'Escape') {
      if (document.querySelector('.modal-overlay.open, .slide-panel.open')) return;
      e.preventDefault(); this.close(); return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.save(); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = parseInt(e.key);
    if (n >= 1 && n <= this.OUTCOMES.length) { e.preventDefault(); this.pick(this.OUTCOMES[n - 1].key); }
  },
};
