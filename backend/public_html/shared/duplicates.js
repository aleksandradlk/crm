// ============================================================
// Dubletten: Hinweis im Lead-Panel und Übersicht mit Zusammenführen (Admin)
// ============================================================
const Dupes = {
  opts: {},
  init(opts) { this.opts = opts || {}; },

  // Warnung im Lead-Panel, wenn es Leads mit gleicher Nummer / Mail / Domain gibt
  // Admins immer; Closer, wenn beide Leads ihnen gehören oder frei sind (prüft auch der Server)
  darf(a, b) {
    if (this.opts.isAdmin) return true;
    const me = (Auth.getUser() || {}).id;
    return [a, b].every(x => !x.assigned_to || x.assigned_to === me);
  },

  panelWarning(l) {
    const merges = (l.merges || []).map(m => `<div class="dup-warn-item">
        <span><i class="fas fa-link" style="color:var(--text3);margin-right:6px"></i>Zusammengeführt mit <b>${escHtml(m.from_company || '#' + m.from_id)}</b>
        · ${escHtml(m.merged_by_name || '')} · ${fmtDateShort(m.created_at)}</span>
        ${this.opts.isAdmin || m.merged_by === (Auth.getUser() || {}).id ? `<button class="btn btn-ghost btn-sm" onclick="Dupes.undo(${m.id}, ${l.id})"><i class="fas fa-undo"></i> Rückgängig</button>` : ''}
      </div>`).join('');
    const d = l.duplicates || [];
    if (!d.length) return merges ? `<div class="panel-section"><div class="dup-warn dup-merged">${merges}</div></div>` : '';
    return `<div class="panel-section">${merges ? `<div class="dup-warn dup-merged" style="margin-bottom:8px">${merges}</div>` : ''}<div class="dup-warn">
      <i class="fas fa-clone" style="color:var(--copper);margin-right:6px"></i><b>Mögliche Dublette</b>
      ${d.map(x => `<div class="dup-warn-item">
        <span><a href="#" onclick="event.preventDefault();Dupes.opts.openLead(${x.id})">${escHtml(x.company || '—')}</a>
        · gleiche ${escHtml(String(x.matched_on || '').replace(/,/g, ', '))}
        · ${x.assigned_name ? 'betreut von ' + escHtml(x.assigned_name) : 'nicht zugewiesen'}</span>
        ${this.darf(l, x) ? `<button class="btn btn-ghost btn-sm" onclick="Dupes.merge(${l.id}, ${x.id})" title="Verlauf, Anrufe, Deals von „${escHtml(x.company || '')}“ hierher übernehmen und die Dublette archivieren"><i class="fas fa-compress-alt"></i> Hierher zusammenführen</button>` : ''}
      </div>`).join('')}
    </div></div>`;
  },

  async merge(targetId, fromId) {
    const ok = await customConfirm('Verlauf, Anrufe, Wiedervorlagen, E-Mails und Deals werden in diesen Lead übernommen, leere Felder ergänzt. Die Dublette wird archiviert. Du kannst das jederzeit im Lead rückgängig machen.',
      { title: 'Dubletten zusammenführen', okLabel: 'Zusammenführen' });
    if (!ok) return false;
    try {
      const r = await api('POST', `/leads/${targetId}/merge`, { from_id: fromId });
      this.undoBar(r.merge_id, targetId);
      if (typeof this.opts.onChange === 'function') this.opts.onChange(targetId);
      if (document.getElementById('dupModal')?.classList.contains('open')) this.openOverview();
      return true;
    } catch (e) { showToast(e.message, 'err'); return false; }
  },

  // Hinweis mit „Rückgängig“ direkt nach dem Zusammenführen (10 Sekunden)
  undoBar(mergeId, targetId) {
    document.getElementById('dupUndoBar')?.remove();
    const bar = document.createElement('div');
    bar.id = 'dupUndoBar'; bar.className = 'undo-bar';
    bar.innerHTML = `<i class="fas fa-check-circle"></i><span>Zusammengeführt</span><button onclick="Dupes.undo(${mergeId}, ${targetId})">Rückgängig</button>`;
    document.body.appendChild(bar);
    setTimeout(() => bar.remove(), 10000);
  },

  async undo(mergeId, targetId) {
    document.getElementById('dupUndoBar')?.remove();
    try {
      await api('POST', `/leads/merges/${mergeId}/undo`);
      showToast('Zusammenführung rückgängig gemacht');
      if (typeof this.opts.onChange === 'function') this.opts.onChange(targetId);
    } catch (e) { showToast(e.message, 'err'); }
  },

  // ── Übersicht aller Dubletten (Admin) ───────────────────────
  async openOverview() {
    let modal = document.getElementById('dupModal');
    if (!modal) {
      document.body.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay" id="dupModal" onclick="if(event.target===this)this.classList.remove('open')">
          <div class="modal" style="max-width:760px;padding:0;overflow:hidden">
            <div style="padding:22px 22px 12px;position:relative">
              <button class="modal-close" onclick="document.getElementById('dupModal').classList.remove('open')"><i class="fas fa-times"></i></button>
              <div class="modal-title">Dubletten</div>
              <p class="cell-sub" style="margin-top:6px">Leads mit gleicher Telefonnummer, E-Mail-Adresse oder Website. „Behalten“ übernimmt alles von den anderen Einträgen der Gruppe und archiviert sie.</p>
            </div>
            <div id="dupList" style="max-height:65vh;overflow-y:auto"></div>
          </div>
        </div>`);
      modal = document.getElementById('dupModal');
    }
    modal.classList.add('open');
    const el = document.getElementById('dupList');
    el.innerHTML = '<div class="today-empty"><i class="fas fa-spinner fa-spin"></i> Wird geprüft …</div>';
    try {
      const groups = await api('GET', '/leads/duplicates');
      if (!groups.length) { el.innerHTML = '<div class="today-empty"><i class="fas fa-check-circle" style="color:var(--green)"></i> Keine Dubletten gefunden.</div>'; return; }
      el.innerHTML = groups.map(g => `
        <div class="dup-group">
          <div class="dup-group-head">Gleiche ${escHtml(g.matched_on.join(', '))} · ${g.leads.length} Einträge</div>
          ${g.leads.map(l => `
            <div class="dup-lead">
              <div class="dup-lead-main"><b>${escHtml(l.company || '—')}</b> ${statusBadge(l.status)}
                <span>${escHtml([l.phone, l.email, l.website, l.location].filter(Boolean).join(' · '))}</span>
                <span>${l.assigned_name ? 'Betreut von ' + escHtml(l.assigned_name) : 'Nicht zugewiesen'} · ${l.calls} Anrufe · ${l.deals} Deals · angelegt ${fmtDateShort(l.created_at)}</span>
              </div>
              <button class="btn btn-ghost btn-sm" onclick="Dupes.keep(${l.id}, [${g.leads.map(x => x.id).filter(id => id !== l.id).join(',')}])"><i class="fas fa-check"></i> Behalten</button>
            </div>`).join('')}
        </div>`).join('');
    } catch (e) { el.innerHTML = `<div class="today-empty" style="color:var(--red)">${escHtml(e.message)}</div>`; }
  },

  async keep(targetId, otherIds) {
    const ok = await customConfirm(`${otherIds.length} Eintrag/Einträge werden in diesen Lead zusammengeführt und archiviert.`,
      { title: 'Dubletten zusammenführen', okLabel: 'Zusammenführen' });
    if (!ok) return;
    try {
      for (const id of otherIds) await api('POST', `/leads/${targetId}/merge`, { from_id: id });
      showToast('Zusammengeführt');
      if (typeof this.opts.onChange === 'function') this.opts.onChange(targetId);
      this.openOverview();
    } catch (e) { showToast(e.message, 'err'); }
  },
};
