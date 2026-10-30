// ============================================================
// Leads generieren („Neue Kunden finden“): KI-Recherche mit Web-Suche.
// Gemeinsame Seite für Admin und Closer (mit Berechtigung), eingebunden
// über Finder.mount(). Treffer lassen sich vor dem Speichern abwählen.
// ============================================================
const Finder = {
  opts: {}, leads: [], picked: new Set(), size: 'small', max: 10, assign: null, busy: false, vorgaben: null,

  SIZES: [['', 'Egal'], ['small', 'Klein · bis 49'], ['medium', 'Mittelstand · 50–250']],
  FIELDS: [['company', 'Unternehmen', true], ['ceo', 'Geschäftsführer', true], ['email', 'E-Mail', true], ['phone', 'Telefon', true],
    ['location', 'Standort', true], ['linkedin', 'LinkedIn', false], ['revenue', 'Umsatz', false], ['employees', 'Mitarbeiter', false]],
  IDEEN: ['Handwerksbetriebe', 'Arztpraxen', 'Steuerberater', 'Immobilienmakler', 'Restaurants', 'Autohäuser', 'Fitnessstudios', 'Friseure'],
  SCHRITTE: ['Durchsucht das Web …', 'Prüft Webseiten und Impressum …', 'Sammelt Ansprechpartner …', 'Gleicht Telefonnummern ab …', 'Bewertet die Treffer …'],

  // opts: rootId, isAdmin, users (für „Zuweisen an“), assignTo (Closer: eigene ID), onSaved
  mount(opts) {
    this.opts = opts;
    const root = document.getElementById(opts.rootId);
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    root.innerHTML = `
      <div class="fd">
        <header class="kb-hero fd-hero">
          <div class="kb-hero-main">
            <div class="kb-eyebrow">Leads generieren</div>
            <h1 class="kb-title">Neue Kunden finden</h1>
            <p class="kb-sub">Sag, wen du suchst und wo. Die KI recherchiert im Web und liefert geprüfte Firmen mit Ansprechpartner und Telefonnummer.</p>
            <form class="fd-search" onsubmit="event.preventDefault();Finder.run()">
              <label class="fd-field"><i class="fas fa-briefcase"></i><input id="fdQuery" placeholder="Branche, z. B. Malerbetriebe" autocomplete="off"></label>
              <span class="fd-sep"></span>
              <label class="fd-field"><i class="fas fa-map-marker-alt"></i><input id="fdLocation" placeholder="Ort oder Region" autocomplete="off"></label>
              <button class="btn fd-go" id="fdGo" type="submit"><i class="fas fa-search"></i><span>Finden</span></button>
            </form>
            <div class="fd-ideas" id="fdIdeas"></div>
          </div>
        </header>

        <section class="fd-opts">
          <div class="fd-opt"><span class="fd-opt-label">Größe</span><div class="kb-picks" id="fdSizes"></div></div>
          <div class="fd-opt"><span class="fd-opt-label">Anzahl</span><div class="kb-picks" id="fdMax"></div></div>
          ${opts.isAdmin ? '<div class="fd-opt"><span class="fd-opt-label">Zuweisen an</span><div class="kb-picks" id="fdAssign"></div></div>' : ''}
          ${opts.isAdmin ? `<details class="fd-more">
            <summary><i class="fas fa-user-lock"></i> Vorgaben für Closer</summary>
            <div class="fd-opt fd-opt-wide"><span class="fd-opt-label">Branchen</span>
              <input id="fdVBranchen" class="form-control" placeholder="z. B. Maler, Autohäuser, Badsanierer (mit Komma trennen, leer = frei)"></div>
            <div class="fd-opt"><span class="fd-opt-label">Größe</span><div class="kb-picks" id="fdVGroesse"></div></div>
            <div class="fd-opt"><button type="button" class="btn btn-primary btn-sm" onclick="Finder.vorgabenSpeichern()"><i class="fas fa-save"></i> Vorgaben speichern</button></div>
            <p class="ig-hint" style="margin:0">Closer können nur diese Branchen suchen, die Größe ist fest eingestellt. Du selbst suchst weiter frei.</p>
          </details>` : ''}
          <details class="fd-more">
            <summary><i class="fas fa-sliders-h"></i> Mehr Optionen</summary>
            <div class="fd-opt"><span class="fd-opt-label">Felder</span><div class="kb-picks" id="fdFields"></div></div>
            <div class="fd-opt fd-opt-wide"><span class="fd-opt-label">Zusätzlich beachten</span>
              <textarea id="fdExtra" class="form-control" rows="2" placeholder="z. B. nur inhabergeführt, keine Ketten, mit eigener Website"></textarea></div>
          </details>
        </section>

        <section class="fd-run" id="fdRun" hidden></section>
        <section id="fdResults"></section>
      </div>`;
    this.renderOpts();
    this.renderIdeas();
    this.ladeVorgaben();
  },

  // Vorgaben für Closer: erlaubte Branchen und feste Größe (Admin stellt sie ein)
  async ladeVorgaben() {
    try { this.vorgaben = await api('GET', '/generate/vorgaben'); } catch { this.vorgaben = null; return; }
    const v = this.vorgaben;
    if (this.opts.isAdmin) {
      document.getElementById('fdVBranchen').value = v.branchen.join(', ');
      this._vGroesse = v.groesse;
      this._picks('fdVGroesse', this.SIZES, v.groesse, 'setVGroesse');
      return;
    }
    this.size = v.groesse;
    if (v.branchen.length) {
      const feld = document.getElementById('fdQuery');
      const sel = document.createElement('select');
      sel.id = 'fdQuery';
      sel.innerHTML = '<option value="">Branche wählen …</option>' + v.branchen.map(b => `<option>${escHtml(b)}</option>`).join('');
      feld.replaceWith(sel);
    }
    this.renderOpts();
    this.renderIdeas();
  },
  setVGroesse(v) { this._vGroesse = v; this._picks('fdVGroesse', this.SIZES, v, 'setVGroesse'); },
  async vorgabenSpeichern() {
    try {
      const r = await api('PUT', '/generate/vorgaben', { branchen: document.getElementById('fdVBranchen').value, groesse: this._vGroesse || '' });
      this.vorgaben = { ...this.vorgaben, branchen: r.branchen, groesse: r.groesse };
      document.getElementById('fdVBranchen').value = r.branchen.join(', ');
      showToast('Vorgaben für Closer gespeichert ✓');
    } catch (e) { showToast(e.message, 'err'); }
  },
  // Closer mit Vorgaben: Größe steht fest
  _fest() { return !this.opts.isAdmin && this.vorgaben; },

  setUsers(users) { this.opts.users = users; this.renderOpts(); },

  _picks(id, list, current, fn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = list.map(([v, label, icon]) => `<button type="button" class="kb-pick${String(v) === String(current) ? ' on' : ''}"
      onclick="Finder.${fn}(${escHtml(JSON.stringify(v))})">${icon ? `<i class="fas fa-${icon}"></i>` : ''}${escHtml(label)}</button>`).join('');
  },

  renderOpts() {
    if (this._fest()) {
      const el = document.getElementById('fdSizes');
      if (el) el.innerHTML = `<span class="kb-pick on" title="Vom Admin festgelegt"><i class="fas fa-lock"></i>${escHtml((this.SIZES.find(([k]) => k === this.size) || [, 'Egal'])[1])}</span>`;
    } else this._picks('fdSizes', this.SIZES, this.size, 'setSize');
    // Höchstens 20 pro Suche: dafür wird jede Firma gründlich geprüft (zwei Websuchen je Lead)
    if (this.max > 20) this.max = 20;
    this._picks('fdMax', [5, 10, 20].map(n => [n, String(n)]), this.max, 'setMax');
    if (this.opts.isAdmin) {
      const users = (this.opts.users || []).filter(u => u.is_active);
      this._picks('fdAssign', [[null, 'Niemand', 'inbox']].concat(users.map(u => [u.id, u.full_name.split(' ')[0], u.role === 'admin' ? 'user-shield' : 'headset'])), this.assign, 'setAssign');
    }
    const f = document.getElementById('fdFields');
    if (f && !f.dataset.done) {
      f.dataset.done = '1';
      f.innerHTML = this.FIELDS.map(([k, label, on]) => `<button type="button" class="kb-pick${on ? ' on' : ''}" data-field="${k}" onclick="this.classList.toggle('on')">${escHtml(label)}</button>`).join('');
    }
  },
  setSize(v) { this.size = v; this.renderOpts(); },
  setMax(v) { this.max = v; this.renderOpts(); },
  setAssign(v) { this.assign = v; this.renderOpts(); },

  _recent() { try { return JSON.parse(localStorage.getItem('lh_finder_recent') || '[]'); } catch { return []; } },
  renderIdeas() {
    const recent = this._recent();
    const chip = (q, l, icon) => `<button type="button" class="fd-idea" onclick="Finder.fill(${escHtml(JSON.stringify(q))}, ${escHtml(JSON.stringify(l || ''))})"><i class="fas fa-${icon}"></i>${escHtml(q)}${l ? ` · ${escHtml(l)}` : ''}</button>`;
    document.getElementById('fdIdeas').innerHTML = recent.length
      ? `<span class="fd-ideas-label">Zuletzt</span>${recent.map(r => chip(r.q, r.l, 'history')).join('')}`
      : `<span class="fd-ideas-label">Ideen</span>${this.IDEEN.slice(0, 6).map(q => chip(q, '', 'lightbulb')).join('')}`;
    // Closer mit Branchen-Vorgabe: nur diese als Vorschläge, „Zuletzt“ nur mit erlaubten Branchen
    const erlaubt = this._fest() && this.vorgaben.branchen.length ? this.vorgaben.branchen : null;
    if (erlaubt) {
      const zuletzt = recent.filter(r => erlaubt.some(b => b.toLowerCase() === String(r.q).toLowerCase()));
      document.getElementById('fdIdeas').innerHTML = `<span class="fd-ideas-label">Branchen</span>${erlaubt.map(q => chip(q, '', 'briefcase')).join('')}`
        + (zuletzt.length ? `<span class="fd-ideas-label">Zuletzt</span>${zuletzt.map(r => chip(r.q, r.l, 'history')).join('')}` : '');
    }
  },
  fill(q, l) {
    document.getElementById('fdQuery').value = q;
    if (l) document.getElementById('fdLocation').value = l;
    document.getElementById(l ? 'fdQuery' : 'fdLocation').focus();
  },

  async run() {
    if (this.busy) return;
    const query = document.getElementById('fdQuery').value.trim();
    const location = document.getElementById('fdLocation').value.trim();
    if (!query) { showToast('Wen suchst du? Bitte eine Branche eingeben.', 'err'); document.getElementById('fdQuery').focus(); return; }
    const recent = [{ q: query, l: location }].concat(this._recent().filter(r => r.q !== query || r.l !== location)).slice(0, 5);
    try { localStorage.setItem('lh_finder_recent', JSON.stringify(recent)); } catch {}
    this.busy = true;
    const go = document.getElementById('fdGo');
    go.disabled = true; go.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Sucht …</span>';
    document.getElementById('fdResults').innerHTML = '';
    const run = document.getElementById('fdRun');
    run.hidden = false;
    let i = 0;
    const step = () => {
      run.innerHTML = `<div class="fd-run-card"><div class="fd-orb"><i class="fas fa-search"></i></div>
        <div><b>${escHtml(query)}${location ? ` in ${escHtml(location)}` : ''}</b><span>${this.SCHRITTE[i % this.SCHRITTE.length]}</span></div>
        <div class="fd-bar"><div></div></div></div>`;
      i++;
    };
    step();
    const timer = setInterval(step, 3500);
    const fields = [...document.querySelectorAll('#fdFields .kb-pick.on')].map(b => b.dataset.field);
    try {
      const data = await api('POST', '/generate', {
        query, location, size: this.size || '', max_leads: this.max,
        sources: ['google', 'web', 'maps'], fields: fields.length ? fields : ['company', 'phone'],
        extra: document.getElementById('fdExtra').value.trim(),
      });
      this.leads = data.leads || [];
      // Schon im CRM vorhandene Firmen sind markiert und nicht vorausgewählt
      this.picked = new Set(this.leads.map((l, k) => l.vorhanden ? -1 : k).filter(k => k >= 0));
      const st = data.statistik || {};
      const teile = [
        st.ohne_telefon ? `${st.ohne_telefon} ohne Telefon aussortiert` : '',
        st.ausserhalb ? `${st.ausserhalb} außerhalb der Region aussortiert` : '',
        st.unsicher ? `${st.unsicher} unsichere aussortiert` : '',
        st.schon_im_crm ? `${st.schon_im_crm} schon im CRM` : '',
        st.region_ungeprueft ? `${st.region_ungeprueft} Ort ungeprüft` : '',
      ].filter(Boolean);
      const anteil = (n) => this.leads.length ? `${n} von ${this.leads.length}` : '0';
      run.innerHTML = `<div class="fd-run-card done"><div class="fd-orb"><i class="fas fa-check"></i></div>
        <div><b>${this.leads.length ? `${this.leads.length} ${this.leads.length === 1 ? 'Firma' : 'Firmen'} gefunden` : 'Keine passenden Firmen gefunden'}</b>
        <span>${data.real_data ? `Per Web-Suche geprüft (${st.websuchen || 0} Suchen)` : 'Web-Suche ohne Treffer – Angaben aus KI-Wissen, bitte prüfen'}${teile.length ? ' · ' + teile.join(' · ') : ''}</span>
        ${this.leads.length ? `<span class="fd-stat">Alle mit Telefon · E-Mail ${anteil(st.mit_email || 0)} · Webseite ${anteil(st.mit_webseite || 0)} · Instagram ${anteil(st.mit_instagram || 0)}</span>` : ''}</div></div>`;
      this.renderResults(data.real_data);
    } catch (e) {
      run.innerHTML = `<div class="fd-run-card err"><div class="fd-orb"><i class="fas fa-exclamation"></i></div><div><b>Suche fehlgeschlagen</b><span>${escHtml(e.message)}</span></div></div>`;
    } finally {
      clearInterval(timer);
      this.busy = false;
      go.disabled = false; go.innerHTML = '<i class="fas fa-search"></i><span>Finden</span>';
      this.renderIdeas();
    }
  },

  renderResults(live) {
    const el = document.getElementById('fdResults');
    if (!this.leads.length) { el.innerHTML = ''; return; }
    const n = this.picked.size;
    const ziel = this.opts.isAdmin
      ? (this.assign ? `für ${escHtml(((this.opts.users || []).find(u => u.id === this.assign) || {}).full_name || '')}` : 'ohne Zuweisung')
      : 'in „Meine Leads“';
    el.innerHTML = `
      <div class="fd-res-head">
        <h2 class="kb-cat-title">Treffer <span class="kb-cat-count">${n} von ${this.leads.length} ausgewählt</span>
          <span class="data-badge ${live ? 'live' : 'ai'}">${live ? 'Live-Daten' : 'KI-Wissen'}</span></h2>
        <div class="fd-res-actions">
          <button class="btn btn-ghost btn-sm" onclick="Finder.toggleAll()">${n === this.leads.length ? 'Keine' : 'Alle'} auswählen</button>
          <button class="btn btn-primary" id="fdSave" ${n ? '' : 'disabled'} onclick="Finder.save()"><i class="fas fa-check"></i> ${n} speichern ${ziel}</button>
        </div>
      </div>
      <div class="fd-grid">${this.leads.map((l, k) => this._card(l, k)).join('')}</div>`;
  },

  _card(l, k) {
    const on = this.picked.has(k);
    const conf = Math.max(0, Math.min(100, parseInt(l.confidence) || 0));
    const row = (icon, html) => html ? `<div class="fd-row"><i class="fas fa-${icon}"></i><span>${html}</span></div>` : '';
    return `<article class="fd-card${on ? ' on' : ''}" onclick="Finder.toggle(${k})">
      <span class="fd-check"><i class="fas fa-check"></i></span>
      <div class="fd-card-head">
        <span class="fd-logo">${escHtml((l.company || '?').trim().charAt(0).toUpperCase())}</span>
        <div class="fd-card-title"><b>${escHtml(l.company || '—')}</b>${l.location ? `<span>${escHtml(l.location)}</span>` : ''}</div>
        ${conf ? `<span class="fd-conf" style="--p:${conf}" title="Sicherheit ${conf} %"><span>${conf}</span></span>` : ''}
      </div>
      ${l.vorhanden ? `<div class="fd-vorhanden"><i class="fas fa-clone"></i>Schon im CRM${l.vorhanden.betreut ? ` (betreut von ${escHtml(l.vorhanden.betreut)})` : ''}</div>` : ''}
      ${l.region === 'ungeprueft' ? `<div class="fd-region"><i class="fas fa-map-marker-alt"></i>Ort ungeprüft, bitte kurz checken</div>` : ''}
      ${row('user-tie', escHtml(l.ceo || ''))}
      ${row('phone-alt', l.phone ? `<span class="mono">${escHtml(l.phone)}</span>` : '')}
      ${row('envelope', escHtml(l.email || ''))}
      ${row('globe', l.website ? escHtml(String(l.website).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) : '')}
      ${row('camera', l.instagram_url ? escHtml(String(l.instagram_url).replace(/^instagram\.com\//, '@')) : '')}
    </article>`;
  },

  toggle(k) { this.picked.has(k) ? this.picked.delete(k) : this.picked.add(k); this.renderResults(document.querySelector('.fd-res-head .data-badge.live')); },
  toggleAll() {
    this.picked = this.picked.size === this.leads.length ? new Set() : new Set(this.leads.map((_, k) => k));
    this.renderResults(document.querySelector('.fd-res-head .data-badge.live'));
  },

  async save() {
    const leads = this.leads.filter((_, k) => this.picked.has(k));
    if (!leads.length) return;
    const btn = document.getElementById('fdSave');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Speichert …';
    try {
      const r = await api('POST', '/leads/bulk', { leads, assigned_to: this.opts.isAdmin ? this.assign : (this.opts.assignTo || null) });
      const dup = (r.skipped_duplicates || []).length;
      showToast(`${r.ids.length} Leads gespeichert ✓${dup ? ` · ${dup} schon vorhanden` : ''}`);
      this.leads = []; this.picked = new Set();
      document.getElementById('fdResults').innerHTML = '';
      document.getElementById('fdRun').hidden = true;
      if (this.opts.onSaved) this.opts.onSaved(r);
    } catch (e) {
      showToast(e.message, 'err');
      btn.disabled = false; btn.innerHTML = `<i class="fas fa-check"></i> ${leads.length} speichern`;
    }
  },
};
