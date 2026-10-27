// ============================================================
// „Heute“: verpasste Anrufe, fällige Rückrufe, neue Kundenantworten,
// Deals mit Handlungsbedarf und Wähllisten auf einer Seite.
// Eingebunden in closer.html und admin.html über Today.mount().
// ============================================================
const Today = {
  opts: {}, data: null,

  mount(opts) {
    this.opts = opts;
    const root = document.getElementById(opts.rootId);
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    root.innerHTML = `
      <div class="page-header">
        <div><h1 data-eyebrow="Mein Tag">Heute</h1><p class="page-desc" id="todayDate"></p></div>
        <div class="page-actions">
          <button class="btn btn-ghost btn-sm btn-icon" onclick="Today.load()" title="Aktualisieren"><i class="fas fa-sync"></i></button>
          <button class="btn btn-primary dialer-launch today-start" onclick="Today.opts.startDialer()"><i class="fas fa-headset"></i> Anrufmodus starten <span class="today-start-count" id="todayQueueCount"></span></button>
        </div>
      </div>
      <div class="today-goal" id="todayGoal"></div>
      <div class="today-grid">
        <div class="today-col">
          <section class="card today-card is-anfrage" id="todayTerminCard" hidden>
            <div class="card-header"><div class="card-title"><i class="fas fa-calendar-plus"></i> Neue Übergaben &amp; Terminanfragen <span class="badge" id="todayTerminCount">0</span></div></div>
            <div class="today-list" id="todayTermine"></div>
          </section>
          <section class="card today-card is-anfrage" id="todayAnfrageCard" hidden>
            <div class="card-header"><div class="card-title"><i class="fas fa-file-signature"></i> Angebote anfordern <span class="badge" id="todayAnfrageCount">0</span></div></div>
            <div class="today-list" id="todayAnfragen"></div>
          </section>
          <section class="card today-card is-missed" id="todayMissedCard" hidden>
            <div class="card-header"><div class="card-title"><i class="fas fa-phone-slash"></i> Verpasste Anrufe <span class="badge" id="todayMissedCount">0</span></div></div>
            <div class="today-list" id="todayMissed"></div>
          </section>
          <section class="card today-card">
            <div class="card-header"><div class="card-title"><i class="fas fa-bell"></i> Rückrufe &amp; Wiedervorlagen heute <span class="badge" id="todayFuCount">0</span></div></div>
            <div class="today-list" id="todayFollowups"></div>
          </section>
          <section class="card today-card">
            <div class="card-header"><div class="card-title"><i class="fas fa-envelope-open-text"></i> Neue Kundenantworten <span class="badge" id="todayReplyCount">0</span></div></div>
            <div class="today-list" id="todayReplies"></div>
          </section>
        </div>
        <div class="today-col">
          ${opts.isAdmin ? `<section class="card today-card is-faellig" id="todayFaelligCard" hidden>
            <div class="card-header"><div class="card-title"><i class="fas fa-clipboard-check"></i> Fällig: Abrechnung &amp; Auszahlungen <span class="badge" id="todayFaelligCount">0</span></div></div>
            <div class="today-list" id="todayFaellig"></div>
          </section>` : ''}
          <section class="card today-card">
            <div class="card-header"><div class="card-title"><i class="fas fa-handshake"></i> Deals brauchen Aufmerksamkeit <span class="badge" id="todayDealCount">0</span></div></div>
            <div class="today-list" id="todayDeals"></div>
          </section>
          <section class="card today-card">
            <div class="card-header">
              <div class="card-title"><i class="fas fa-list-ol"></i> Wähllisten</div>
              <button class="btn btn-ghost btn-sm" onclick="CallLists.openEditor()"><i class="fas fa-plus"></i> Neue Liste</button>
            </div>
            <div class="today-list" id="todayLists"></div>
          </section>
        </div>
      </div>`;
    const d = new Date();
    document.getElementById('todayDate').textContent = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }) + ' · was heute ansteht, nach Dringlichkeit';
    CallLists.init({ isAdmin: opts.isAdmin, startDialer: o => opts.startDialer(o), onChange: () => this.loadLists() });
  },

  async load() {
    try {
      this.data = await api('GET', '/today');
      this.render();
    } catch (e) { showToast(e.message, 'err'); }
    this.loadLists();
    if (this.opts.isAdmin) this.loadFaellig();
  },

  // Admin: was in Abrechnung und Provision ansteht (Angebote anfordern stehen schon oben)
  async loadFaellig() {
    const card = document.getElementById('todayFaelligCard');
    if (!card) return;
    try { this.faellig = await api('GET', '/faellig'); } catch (e) { card.hidden = true; return; }
    const punkte = (this.faellig.punkte || []).filter(p => p.aktion?.typ !== 'anfrage');
    card.hidden = !punkte.length;
    document.getElementById('todayFaelligCount').textContent = punkte.length;
    const datum = iso => iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '';
    const GR = { angebot: 'Angebot', rechnung: 'Rechnung', zahlung: 'Zahlung', betreuung: 'Betreuung', provision: 'Auszahlung', telefon: 'Nummer' };
    document.getElementById('todayFaellig').innerHTML = punkte.map((p, i) => {
      const a = p.aktion || {};
      const knopf = a.typ === 'auszahlung'
        ? `<button class="btn btn-primary btn-sm" onclick="Today.ausgezahlt(${i})" title="Als ausgezahlt markieren"><i class="fas fa-check"></i> Ausgezahlt</button>`
        : a.typ === 'abrechnung' ? `<button class="btn btn-ghost btn-sm" onclick="Today.zurAbrechnung('${escHtml(a.bereich || '')}')">Öffnen</button>`
        : a.typ === 'integrationen' && typeof showTab === 'function' ? `<button class="btn btn-ghost btn-sm" onclick="showTab('integrationen')">Nummern-Pool</button>` : '';
      return `<div class="today-row ${p.dringend ? 'is-late' : ''}">
        <div class="today-row-main">
          <div class="today-row-title"><span class="today-tag">${GR[p.gruppe] || ''}</span> ${escHtml(p.titel)}</div>
          <div class="today-row-sub">${escHtml(p.text)}</div>
        </div>
        <span class="today-row-meta">${p.dringend ? '⚠ ' : ''}${datum(p.datum)}</span>
        <div class="today-row-actions">${knopf}</div>
      </div>`;
    }).join('');
    this._faelligListe = punkte;
  },

  zurAbrechnung(bereich) {
    const pfad = '/abrechnung' + (bereich ? '/' + bereich : '');
    if (typeof oeffneAbrechnung === 'function') oeffneAbrechnung(pfad); else window.open(pfad, '_blank');
  },

  async ausgezahlt(i) {
    const p = (this._faelligListe || [])[i];
    if (!p) return;
    const a = p.aktion;
    if (!confirm(`${p.titel}\n\nAls ausgezahlt markieren?`)) return;
    try {
      await api('POST', '/provision/auszahlung', { schluessel: a.schluessel, user_id: a.user_id, betrag: a.betrag });
      showToast('Als ausgezahlt markiert');
      this.loadFaellig();
    } catch (e) { showToast(e.message, 'err'); }
  },

  async loadLists() {
    await CallLists.load();
    CallLists.renderInto(document.getElementById('todayLists'));
  },

  _row({ title, sub, meta, cls = '', leadId, phone, extra = '' }) {
    const ph = phone ? escHtml(phone) : '';
    return `<div class="today-row ${cls}" onclick="Today.opts.openLead(${leadId})">
      <div class="today-row-main">
        <div class="today-row-title">${title}</div>
        ${sub ? `<div class="today-row-sub">${sub}</div>` : ''}
      </div>
      ${meta ? `<span class="today-row-meta">${meta}</span>` : ''}
      <div class="today-row-actions" onclick="event.stopPropagation()">
        ${extra}
        ${ph ? `<button class="btn btn-ghost btn-sm btn-icon today-call" onclick="Today.opts.call(${leadId}, ${escHtml(JSON.stringify(phone))})" title="Anrufen ${ph}"><i class="fas fa-phone-alt"></i></button>` : ''}
      </div>
    </div>`;
  },

  render() {
    const d = this.data;
    const badge = document.getElementById('todayBadge');
    const dueCount = d.missed_calls.length + d.followups.length;
    if (badge) { badge.textContent = dueCount; badge.style.display = dueCount ? '' : 'none'; }
    const pct = d.goal ? Math.min(100, Math.round(d.calls_today / d.goal * 100)) : 0;
    // Closer haben Tagesziel und Kennzahlen schon in ihrer Tagesleiste
    document.getElementById('todayGoal').hidden = !this.opts.showGoal;
    if (typeof Ziele !== 'undefined' && this.opts.showGoal) Ziele.renderInto('todayGoal');
    else document.getElementById('todayGoal').innerHTML = `
      <div class="today-goal-text"><b>${d.calls_today}</b> von ${d.goal} Anrufen heute${pct >= 100 ? ' – Tagesziel erreicht 🎉' : ''}</div>
      <div class="today-goal-bar"><div style="width:${pct}%"></div></div>`;
    document.getElementById('todayQueueCount').textContent = d.queue_count ? d.queue_count : '';
    const time = t => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const done = r => `<button class="btn btn-ghost btn-sm btn-icon" onclick="Today.done(${r.lead_id}, ${r.reminder_id})" title="Erledigt"><i class="fas fa-check"></i></button>`;

    const ta = d.termin_anfragen || [];
    document.getElementById('todayTerminCard').hidden = !ta.length;
    document.getElementById('todayTerminCount').textContent = ta.length;
    document.getElementById('todayTermine').innerHTML = ta.map(a => this._row({
      title: escHtml(a.company || '—'),
      sub: `<b>${escHtml(a.topic || 'Übergabe')}</b>${a.painpoints ? ' – ' + escHtml(String(a.painpoints).slice(0, 120)) : ''}`,
      meta: a.art === 'anruf_bis'
        ? `Anruf bis ${new Date(a.starts_at.slice(0, 10) + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}`
        : new Date(a.starts_at.replace(' ', 'T')).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
      leadId: a.lead_id, phone: a.phone,
      extra: typeof Termine !== 'undefined' ? `<button class="btn btn-primary btn-sm" onclick="Termine.antworten(${a.id}, 'annehmen').then(() => Today.load())"><i class="fas fa-check"></i> Annehmen</button>
        <button class="btn btn-ghost btn-sm" onclick="Today.opts.showTermine ? Today.opts.showTermine() : null">Ansehen</button>` : '',
    })).join('');

    const anfr = d.angebot_anfragen || [];
    document.getElementById('todayAnfrageCard').hidden = !anfr.length;
    document.getElementById('todayAnfrageCount').textContent = anfr.length;
    document.getElementById('todayAnfragen').innerHTML = anfr.map(a => this._row({
      title: `${escHtml(a.company || '—')} <span class="today-deal-val">${typeof Deals !== 'undefined' ? Deals.fmt(a.value) : a.value}</span>`,
      sub: `<b>${escHtml(a.owner_name || '')}:</b> ${escHtml((a.infos || 'ohne Infos').replace(/\s+/g, ' ').slice(0, 160))}`,
      meta: (a.zu_lange ? '⚠ ' : '') + (a.std >= 24 ? `seit ${Math.floor(a.std / 24)} ${Math.floor(a.std / 24) === 1 ? 'Tag' : 'Tagen'}` : a.std >= 1 ? `seit ${a.std} Std.` : 'gerade eben')
        + (a.admin_flag ? ' · Rabatt prüfen' : ''),
      cls: a.zu_lange ? 'is-late' : '',
      leadId: a.lead_id, phone: a.phone,
      extra: (this.opts.onAngebot ? `<button class="btn btn-primary btn-sm" onclick="Today.opts.onAngebot(${a.lead_id}, ${a.id})"><i class="fas fa-file-signature"></i> Angebot erstellen</button>` : '')
        + (this.opts.isAdmin && typeof Deals !== 'undefined' ? `<button class="btn btn-ghost btn-sm" onclick="Deals.angebotGesendet(${a.id}).then(() => Today.load())" title="Angebot ist raus: Closer benachrichtigen, Nachfassen planen"><i class="fas fa-paper-plane"></i> Angebot verschickt</button>` : ''),
    })).join('');

    document.getElementById('todayMissedCard').hidden = !d.missed_calls.length;
    document.getElementById('todayMissedCount').textContent = d.missed_calls.length;
    document.getElementById('todayMissed').innerHTML = d.missed_calls.map(r => this._row({
      title: escHtml(r.company || '—'), sub: escHtml(r.note || ''), meta: time(r.remind_at),
      cls: 'is-overdue', leadId: r.lead_id, phone: r.phone, extra: done(r),
    })).join('');

    document.getElementById('todayFuCount').textContent = d.followups.length;
    document.getElementById('todayFollowups').innerHTML = d.followups.map(r => this._row({
      title: `${escHtml(r.company || '—')} ${statusBadge(r.status)}`,
      sub: escHtml(r.note || (r.ceo || '')),
      meta: r.overdue ? `überfällig · ${new Date(r.remind_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}` : time(r.remind_at),
      cls: r.overdue || new Date(r.remind_at) < new Date() ? 'is-overdue' : '', leadId: r.lead_id, phone: r.phone, extra: done(r),
    })).join('') || '<div class="today-empty">Keine Rückrufe mehr für heute.</div>';

    document.getElementById('todayReplyCount').textContent = d.replies.length;
    document.getElementById('todayReplies').innerHTML = d.replies.map(m => this._row({
      title: escHtml(m.company || '—'), sub: `<b>${escHtml(m.subject || '(kein Betreff)')}</b> – ${escHtml((m.preview || '').replace(/\s+/g, ' ').slice(0, 90))}`,
      meta: fmtDate(m.received_at), leadId: m.lead_id, phone: m.phone,
    })).join('') || '<div class="today-empty">Keine ungelesenen Antworten.</div>';

    document.getElementById('todayDealCount').textContent = d.deals.length;
    document.getElementById('todayDeals').innerHTML = d.deals.map(x => this._row({
      title: `${escHtml(x.title)} <span class="today-deal-val">${typeof Deals !== 'undefined' ? Deals.fmt(x.value) : x.value}</span>`,
      sub: `${escHtml(x.company || '')} · ${escHtml(x.stage_name || '')}`,
      meta: `<span class="today-warn">${escHtml(x.reasons.join(' · '))}</span>`,
      leadId: x.lead_id, phone: x.phone,
      extra: typeof Deals !== 'undefined' ? `<button class="btn btn-ghost btn-sm btn-icon" onclick="Deals.open(${x.id})" title="Deal öffnen"><i class="fas fa-handshake"></i></button>` : '',
    })).join('') || '<div class="today-empty">Alle offenen Deals haben einen nächsten Schritt.</div>';
  },

  async done(leadId, rid) {
    try {
      await api('DELETE', `/leads/${leadId}/reminders/${rid}`);
      showToast('Erledigt');
      this.load();
    } catch (e) { showToast(e.message, 'err'); }
  },
};
