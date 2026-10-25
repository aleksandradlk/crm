// ============================================================
// Ziele pro Closer: Anwahlen, Gespräche, Angebotsanfragen/Termine
// Fortschritt für den Einzelnen (Tagesleiste, „Heute“) und die
// Wochenübersicht im Tracking (Admin) mit Ziele-Bearbeitung je Closer.
// ============================================================
const Ziele = {
  ARTEN: [
    ['anwahlen', 'Anwahlen', 'fa-phone-alt'],
    ['gespraeche', 'Gespräche', 'fa-comments'],
    ['ergebnisse', 'Anfragen & Termine', 'fa-calendar-check'],
  ],
  RICHTWERT: 'Richtwerte pro Tag: 60–80 Anwahlen, 10–15 Gespräche, 2–3 Angebotsanfragen oder Termine. In der Einarbeitung 50–70 % davon.',
  daten: null, team: null, woche: 0,

  async mein() {
    this.daten = await api('GET', '/ziele/mein');
    return this.daten;
  },

  _pct(ist, soll) { return soll ? Math.min(100, Math.round(ist / soll * 100)) : 0; },
  _bar(ist, soll) {
    const p = this._pct(ist, soll);
    return `<div class="zl-bar"><div style="width:${p}%" class="${p >= 100 ? 'is-done' : ''}"></div></div>`;
  },

  // Drei Fortschrittsbalken für den eigenen Stand
  html(d) {
    const woche = d.zeitraum === 'woche';
    const stand = woche ? d.diese_woche : d.heute;
    const alle = this.ARTEN.every(([k]) => stand[k] >= d.ziel[k]);
    return `<div class="zl-head"><span>${woche ? 'Wochenziel' : 'Tagesziel'}</span>${alle ? '<b class="zl-yay">Ziel erreicht 🎉</b>' : ''}</div>
      <div class="zl-grid">${this.ARTEN.map(([k, label, icon]) => `
        <div class="zl-item">
          <div class="zl-top"><span><i class="fas ${icon}"></i>${label}</span><span class="zl-num"><b>${stand[k]}</b> / ${d.ziel[k]}</span></div>
          ${this._bar(stand[k], d.ziel[k])}
          ${woche ? `<div class="zl-sub">heute ${d.heute[k]} · Tagesschnitt ${d.tag[k]}</div>` : ''}
        </div>`).join('')}</div>`;
  },

  async renderInto(elId) {
    const el = document.getElementById(elId);
    if (!el) return null;
    try {
      const d = await this.mein();
      el.innerHTML = this.html(d);
      return d;
    } catch (_) { return null; }
  },

  // ── Wochenübersicht (Admin, Tracking) ───────────────────────
  async renderTeam(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    try { this.team = await api('GET', `/ziele/team?woche=${this.woche}`); }
    catch (e) { el.innerHTML = `<div class="card" style="padding:16px;color:var(--red)">${escHtml(e.message)}</div>`; return; }
    const t = this.team;
    const fmt = s => new Date(s + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    const bisAnzeige = new Date(t.bis + 'T00:00:00'); bisAnzeige.setDate(bisAnzeige.getDate() - 1);
    const wt = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const wochenende = t.closer.some(c => c.tage.slice(5).some(x => x.anwahlen));
    const tage = t.tage.map((d, i) => ({ d, i })).filter(({ i }) => i < 5 || wochenende);
    el.innerHTML = `
      <div class="zl-nav">
        <button class="btn btn-ghost btn-sm btn-icon" onclick="Ziele.woche--;Ziele.renderTeam('${elId}')" title="Woche davor"><i class="fas fa-chevron-left"></i></button>
        <b>${this.woche === 0 ? 'Diese Woche' : this.woche === -1 ? 'Letzte Woche' : 'Woche'}</b><span>${fmt(t.von)} – ${bisAnzeige.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</span>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="Ziele.woche++;Ziele.renderTeam('${elId}')" title="Woche danach" ${this.woche >= 0 ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>
      </div>
      ${t.closer.length ? `<div class="card zl-team-wrap"><table class="zl-team">
        <thead><tr><th>Closer</th>${this.ARTEN.map(([, l]) => `<th>${l}</th>`).join('')}
          ${tage.map(({ d, i }) => `<th class="zl-day ${d === t.heute ? 'is-today' : ''}">${wt[i]}<span>${fmt(d)}</span></th>`).join('')}<th></th></tr></thead>
        <tbody>${t.closer.map(c => `<tr>
          <td class="zl-name"><b>${escHtml(c.full_name)}</b><span>${c.zeitraum === 'woche' ? 'Wochenziel' : 'Tagesziel'}${c.eigen ? '' : ' · Standard'}</span></td>
          ${this.ARTEN.map(([k]) => `<td class="zl-cell"><div class="zl-num"><b>${c.summe[k]}</b> / ${c.woche[k]}</div>${this._bar(c.summe[k], c.woche[k])}</td>`).join('')}
          ${tage.map(({ d }) => {
            const x = c.tage.find(y => y.tag === d);
            const zukunft = d > t.heute;
            const ok = x.anwahlen >= c.tag.anwahlen;
            return `<td class="zl-day ${d === t.heute ? 'is-today' : ''} ${zukunft ? 'is-future' : ok ? 'is-ok' : x.anwahlen ? 'is-low' : ''}" title="${x.anwahlen} Anwahlen · ${x.gespraeche} Gespräche · ${x.ergebnisse} Anfragen/Termine">
              ${zukunft ? '–' : `<b>${x.anwahlen}</b><span>${x.gespraeche} · ${x.ergebnisse}</span>`}</td>`;
          }).join('')}
          <td><button class="btn btn-ghost btn-sm" onclick="Ziele.openEdit(${c.id})"><i class="fas fa-bullseye"></i> Ziel</button></td>
        </tr>`).join('')}</tbody></table>
        <div class="zl-legend">Tage: Anwahlen groß, darunter Gespräche · Anfragen/Termine. Grün = Tagesziel bei den Anwahlen erreicht.</div>
      </div>` : '<div class="card" style="padding:18px;color:var(--text2)">Noch keine Closer angelegt.</div>'}`;
    this._elId = elId;
  },

  openEdit(userId) {
    const c = this.team?.closer.find(x => x.id === userId);
    if (!c) return;
    const std = this.team.standard;
    const r = c.roh;
    document.getElementById('zlModal')?.remove();
    const el = document.createElement('div');
    el.className = 'modal-overlay open';
    el.id = 'zlModal';
    el.onclick = e => { if (e.target === el) el.remove(); };
    el.innerHTML = `<div class="modal modal-flex" style="max-width:480px">
      <div class="modal-header">
        <div class="modal-heading"><div class="modal-icon"><i class="fas fa-bullseye"></i></div><div><div class="modal-title">Ziel für ${escHtml(c.full_name)}</div><div class="modal-subtitle">Leer lassen = Standard aus den Einstellungen</div></div></div>
        <button class="modal-x" onclick="document.getElementById('zlModal').remove()" title="Schließen"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div class="dl-chips" id="zlPeriod">
          <button type="button" class="qf-btn ${r.zeitraum !== 'woche' ? 'active' : ''}" data-p="tag" onclick="Ziele._period(this)">Pro Tag</button>
          <button type="button" class="qf-btn ${r.zeitraum === 'woche' ? 'active' : ''}" data-p="woche" onclick="Ziele._period(this)">Pro Woche</button>
        </div>
        <div class="zl-edit">${this.ARTEN.map(([k, label, icon]) => `
          <label for="zl-${k}"><i class="fas ${icon}"></i>${label}</label>
          <input type="number" min="0" max="9999" id="zl-${k}" class="form-control" value="${r[k] || ''}" data-std="${std[k]}">`).join('')}
        </div>
        <div class="zl-hint">${this.RICHTWERT}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" onclick="Ziele.speichern(${c.id}, true)">Standard verwenden</button>
          <button class="btn btn-primary btn-sm" onclick="Ziele.speichern(${c.id})"><i class="fas fa-check"></i> Speichern</button>
        </div>
      </div></div>`;
    document.body.appendChild(el);
    this._period(el.querySelector('#zlPeriod .qf-btn.active'));
  },
  _period(btn) {
    document.querySelectorAll('#zlPeriod .qf-btn').forEach(b => b.classList.toggle('active', b === btn));
    const woche = btn.dataset.p === 'woche';
    this.ARTEN.forEach(([k]) => {
      const i = document.getElementById('zl-' + k);
      i.placeholder = `Standard: ${Number(i.dataset.std) * (woche ? 5 : 1)}`;
    });
  },
  async speichern(userId, standard = false) {
    const v = k => standard ? null : (parseInt(document.getElementById('zl-' + k).value) || null);
    try {
      await api('PATCH', `/ziele/${userId}`, {
        zeitraum: standard ? 'tag' : document.querySelector('#zlPeriod .qf-btn.active')?.dataset.p,
        anwahlen: v('anwahlen'), gespraeche: v('gespraeche'), ergebnisse: v('ergebnisse'),
      });
      document.getElementById('zlModal')?.remove();
      showToast('Ziel gespeichert ✓');
      if (this._elId) this.renderTeam(this._elId);
    } catch (e) { showToast(e.message, 'err'); }
  },
};
