// ============================================================
// Wissensdatenbank: Unterlagen und E-Mail-Vorlagen auf einer Seite,
// mit Suche, Kategorien und (für Admins) Hochladen per Drag & Drop.
// Eingebunden in closer.html und admin.html über Wiki.mount().
// ============================================================
const Wiki = {
  opts: {}, files: [], templates: [], artikel: [], referenzen: [], neu: null, q: '', cat: 'alle', thumbs: {},
  form: null,

  DEFAULT_CATS: ['Preise & Angebote', 'Gesprächsleitfaden', 'Referenzen', 'Marke & Design', 'Sonstiges'],
  CAT_ICONS: [
    [/preis|angebot|kondition/i, 'tags'],
    [/leitfaden|gespr|einw|skript|script|telefon/i, 'comments'],
    [/marke|design|logo|brand/i, 'palette'],
    [/referenz|kunde|case|erfolg/i, 'star'],
    [/vorlage|vertrag|formular/i, 'file-signature'],
    [/dienstleist|leistung|produkt|paket/i, 'briefcase'],
    [/schulung|onboard|lern|training/i, 'graduation-cap'],
  ],

  // opts: rootId, isAdmin, title, sub, help (Kontaktkarte für Closer),
  //       templates: { mode: 'manage'|'read', slotHtml, onNew, hint }
  mount(opts) {
    this.opts = opts;
    const root = document.getElementById(opts.rootId);
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    const t = opts.templates || {};
    root.innerHTML = `
      <div class="kb${opts.isAdmin ? ' kb-admin' : ''}">
        <header class="kb-hero">
          <div class="kb-hero-main">
            <div class="kb-eyebrow">Wissensdatenbank</div>
            <h1 class="kb-title">${opts.title}</h1>
            <p class="kb-sub">${opts.sub}</p>
            <label class="kb-search">
              <i class="fas fa-search"></i>
              <input type="search" id="kbSearch" placeholder="Artikel, Unterlagen und Vorlagen durchsuchen…" autocomplete="off" oninput="Wiki.search(this.value)">
              <kbd>/</kbd>
            </label>
          </div>
          <div class="kb-hero-side">
            <div class="kb-stats" id="kbStats"></div>
            ${opts.isAdmin ? `<div class="kb-hero-actions">
              <button class="btn kb-btn-light" onclick="Wiki.openForm()"><i class="fas fa-cloud-upload-alt"></i> Unterlage hochladen</button>
              <button class="btn kb-btn-glass" onclick="Wiki.editArtikel()"><i class="fas fa-file-alt"></i> Neuer Artikel</button>
              <label class="btn kb-btn-glass" title="Markdown-Dateien wie 00_Start-hier.md … 08_FAQ.md"><i class="fas fa-file-import"></i> Artikel importieren
                <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple hidden onchange="Wiki.importieren(this.files);this.value=''"></label>
              ${t.onNew ? `<button class="btn kb-btn-glass" onclick="${t.onNew}"><i class="fas fa-plus"></i> Neue Vorlage</button>` : ''}
            </div>` : ''}
          </div>
        </header>
        <div id="kbNeu"></div>
        <nav class="kb-chips" id="kbChips"></nav>
        <div id="kbDocs"></div>
        <section class="kb-cat kb-tpl" id="kbTplSection" hidden>
          <div class="kb-cat-head">
            <span class="kb-cat-ic tone-navy"><i class="fas fa-envelope-open-text"></i></span>
            <div class="kb-cat-text"><h2 class="kb-cat-title">E-Mail-Vorlagen <span class="kb-cat-count" id="kbTplCount"></span></h2>
              <p class="kb-cat-hint">${t.hint || ''}</p></div>
            ${t.mode === 'manage' && t.onNew && !opts.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="${t.onNew}"><i class="fas fa-plus"></i> Neue Vorlage</button>` : ''}
          </div>
          <div id="kbTplSlot">${t.mode === 'manage' ? (t.slotHtml || '') : '<div class="tpl-grid" id="kbTplGrid"></div>'}</div>
        </section>
        <div class="kb-none" id="kbNone" hidden></div>
        ${opts.help ? '<aside class="kb-help" id="kbHelp"></aside>' : ''}
        ${opts.isAdmin ? '<div class="kb-dropveil"><div><i class="fas fa-cloud-upload-alt"></i><b>Loslassen zum Hochladen</b><span>Die Datei landet in der Wissensdatenbank</span></div></div>' : ''}
      </div>`;

    document.addEventListener('keydown', e => {
      if (e.key !== '/' || !root.offsetParent || /input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable) return;
      e.preventDefault();
      document.getElementById('kbSearch').focus();
    });
    if (opts.isAdmin) this._pageDrop(root.querySelector('.kb'));
    if (opts.help) this._loadHelp();
  },

  async load() {
    try {
      const reqs = [api('GET', '/wiki/files'), api('GET', '/wiki/artikel').catch(() => []), api('GET', '/wiki/referenzen').catch(() => []),
        this.neu ? Promise.resolve(this.neu) : api('GET', '/wiki/neu').catch(() => null)];
      if (this.opts.templates?.mode === 'read') reqs.push(api('GET', '/email-templates').catch(() => []));
      const [files, artikel, referenzen, neu, templates] = await Promise.all(reqs);
      this.files = files; this.artikel = artikel; this.referenzen = referenzen; this.neu = neu;
      if (templates) this.templates = templates;
      this.render();
      this._neuGesehen();
    } catch (e) { showToast(e.message, 'err'); }
  },

  // Seiten mit eigener Vorlagenverwaltung rufen das nach dem Neuzeichnen auf
  templatesChanged() { this.renderChips(); this.filter(); },

  search(v) { this.q = v.trim().toLowerCase(); this.filter(); },
  setCat(c) { this.cat = c; this.renderChips(); this.filter(); },

  // ── Darstellung ────────────────────────────────────────────
  _kind(f) {
    const fn = f.filename || '';
    if (f.mimetype?.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(fn)) return 'img';
    if (f.mimetype === 'application/pdf' || /\.pdf$/i.test(fn)) return 'pdf';
    if (/\.xlsx?$/i.test(fn)) return 'xls';
    if (/\.(docx?|odt)$/i.test(fn)) return 'doc';
    return 'txt';
  },
  _ext(f) { const fn = f.filename || ''; return fn.includes('.') ? fn.split('.').pop().toUpperCase() : ''; },
  _size(n) { return n ? (n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB') : ''; },
  _catIcon(c) { return (this.CAT_ICONS.find(([re]) => re.test(c)) || [, 'folder'])[1]; },
  // „Vertrieb“ zuerst, „Referenzen“ zuletzt, dazwischen alphabetisch
  _cats() {
    const alle = [...new Set([...this.files.map(f => f.category), ...this.artikel.map(a => a.kategorie), 'Referenzen'])];
    const rang = c => c === 'Vertrieb' ? 0 : c === 'Referenzen' ? 2 : 1;
    return alle.sort((a, b) => rang(a) - rang(b) || a.localeCompare(b, 'de'));
  },
  _anzahl(c) {
    return this.files.filter(f => f.category === c).length + this.artikel.filter(a => a.kategorie === c).length
      + (c === 'Referenzen' ? this.referenzen.length : 0);
  },
  _tplCount() {
    return this.opts.templates?.mode === 'read'
      ? this.templates.length
      : document.querySelectorAll('#kbTplSlot .tpl-card').length;
  },

  render() {
    const cats = this._cats();
    const docs = document.getElementById('kbDocs');
    if (!this.files.length && !this.artikel.length && !this.opts.isAdmin) {
      docs.innerHTML = `<div class="kb-empty">
        <div class="kb-empty-art"><span class="kb-page"><b>PDF</b><span></span><span></span><span></span></span></div>
        <h3>${this.opts.isAdmin ? 'Noch keine Unterlagen' : 'Hier entsteht deine Wissensdatenbank'}</h3>
        <p>${this.opts.isAdmin ? 'Zieh eine Preisliste, einen Leitfaden oder Referenzen einfach hier hinein.' : 'Sobald Unterlagen hochgeladen sind, findest du sie hier.'}</p>
        ${this.opts.isAdmin ? '<button class="btn btn-primary" onclick="Wiki.openForm()"><i class="fas fa-cloud-upload-alt"></i> Erste Unterlage hochladen</button>' : ''}
      </div>`;
    } else {
      docs.innerHTML = cats.map((c, i) => {
        const list = this.files.filter(f => f.category === c);
        const art = this.artikel.filter(a => a.kategorie === c);
        const ref = c === 'Referenzen';
        return `<section class="kb-cat" data-cat="${escHtml(c)}">
          <div class="kb-cat-head">
            <span class="kb-cat-ic ${i % 2 ? 'tone-copper' : 'tone-navy'}"><i class="fas fa-${c === 'Vertrieb' ? 'bullhorn' : this._catIcon(c)}"></i></span>
            <div class="kb-cat-text"><h2 class="kb-cat-title">${escHtml(c)} <span class="kb-cat-count">${this._anzahl(c)}</span></h2>
              ${c === 'Vertrieb' ? '<p class="kb-cat-hint">Handbuch, Preise, Einwände und FAQ – das gleiche findest du im Anrufmodus rechts im Seitenpanel.</p>' : ''}</div>
            ${ref && this.opts.isAdmin ? '<button class="btn btn-ghost btn-sm" onclick="Wiki.editRef()"><i class="fas fa-plus"></i> Referenz anlegen</button>' : ''}
          </div>
          ${list.length ? `<div class="kb-grid">${list.map(f => this._card(f)).join('')}</div>` : ''}
          ${art.length ? `<div class="kb-arts">${art.map(a => this._artCard(a)).join('')}</div>` : ''}
          ${ref ? this._refsHtml() : ''}
        </section>`;
      }).join('');
    }
    if (this.opts.templates?.mode === 'read') {
      document.getElementById('kbTplGrid').innerHTML = this.templates.map((t, i) =>
        `<div class="kb-tpl-click" onclick="Wiki.showTemplate(${i})">${renderTemplateCard(t)}</div>`).join('');
    }
    const last = this.files.reduce((m, f) => (f.created_at > m ? f.created_at : m), '');
    const lastArt = this.artikel.reduce((m, a) => (a.updated_at > m ? a.updated_at : m), '');
    const stand = lastArt > last ? lastArt : last;
    document.getElementById('kbStats').innerHTML = [
      this.artikel.length ? [this.artikel.length, this.artikel.length === 1 ? 'Artikel' : 'Artikel'] : null,
      [this.files.length, this.files.length === 1 ? 'Unterlage' : 'Unterlagen'],
      [cats.length, cats.length === 1 ? 'Kategorie' : 'Kategorien'],
      stand ? [fmtDateShort(stand).replace(/\.\d{4}$/, '.'), 'Stand'] : null,
    ].filter(Boolean).map(([n, l]) => `<div class="kb-stat"><b>${n}</b><span>${l}</span></div>`).join('');
    this.renderChips();
    this.filter();
    this._loadThumbs();
  },

  _card(f) {
    const kind = this._kind(f), ext = this._ext(f);
    const fresh = f.created_at && (Date.now() - new Date(f.created_at)) < 14 * 864e5;
    const meta = [ext, this._size(f.size), fmtDateShort(f.created_at)].filter(Boolean).join(' · ');
    const search = [f.name, f.note, f.category, ext].join(' ').toLowerCase();
    return `<article class="kb-doc k-${kind}" data-q="${escHtml(search)}" onclick="Wiki.open(${f.id})" tabindex="0"
        onkeydown="if(event.key==='Enter')Wiki.open(${f.id})">
      <div class="kb-doc-thumb">
        ${kind === 'img'
          ? `<img class="kb-doc-img" data-thumb="${escHtml(f.filename)}" alt="">`
          : `<span class="kb-page"><b>${escHtml(ext || 'DATEI')}</b><span></span><span></span><span></span></span>`}
        ${fresh ? '<span class="kb-new">Neu</span>' : ''}
      </div>
      <div class="kb-doc-body">
        <h3 class="kb-doc-name" title="${escHtml(f.name)}">${escHtml(f.name)}</h3>
        ${f.note ? `<p class="kb-doc-note">${escHtml(f.note)}</p>` : ''}
        <div class="kb-doc-meta">${meta}</div>
      </div>
      <div class="kb-doc-foot" onclick="event.stopPropagation()">
        <button class="kb-open" onclick="Wiki.open(${f.id})">${kind === 'img' || kind === 'pdf' || kind === 'txt' ? 'Ansehen' : 'Öffnen'} <i class="fas fa-arrow-right"></i></button>
        <span class="kb-doc-tools">
          <button class="btn btn-ghost btn-sm btn-icon" title="Herunterladen" onclick="Wiki.download(${f.id})"><i class="fas fa-download"></i></button>
          ${this.opts.isAdmin ? `<button class="btn btn-ghost btn-sm btn-icon" title="Bearbeiten" onclick="Wiki.openForm(${f.id})"><i class="fas fa-pen"></i></button>` : ''}
        </span>
      </div>
    </article>`;
  },

  renderChips() {
    const el = document.getElementById('kbChips');
    if (!el) return;
    const n = this._tplCount();
    const chips = [['alle', 'Alles', this.files.length + this.artikel.length + this.referenzen.length + n, 'th-large']]
      .concat(this._cats().map(c => [c, c, this._anzahl(c), c === 'Vertrieb' ? 'bullhorn' : this._catIcon(c)]));
    if (n) chips.push(['__tpl', 'E-Mail-Vorlagen', n, 'envelope-open-text']);
    if (chips.length < 3) { el.innerHTML = ''; return; }
    el.innerHTML = chips.map(([k, label, count, icon]) => `<button class="kb-chip${this.cat === k ? ' active' : ''}"
      onclick="Wiki.setCat(${escHtml(JSON.stringify(k))})"><i class="fas fa-${icon}"></i>${escHtml(label)}<span class="n">${count}</span></button>`).join('');
  },

  filter() {
    const q = this.q, cat = this.cat;
    let shown = 0;
    document.querySelectorAll('#kbDocs .kb-cat').forEach(sec => {
      const catOk = cat === 'alle' || sec.dataset.cat === cat;
      let any = false;
      sec.querySelectorAll('.kb-doc, .kb-art, .kb-ref').forEach(d => {
        const ok = catOk && (!q || d.dataset.q.includes(q));
        d.hidden = !ok; if (ok) { any = true; shown++; }
      });
      // Referenzen zeigen ihren Platzhalter, solange nicht gesucht wird
      const leer = sec.querySelector('.kb-ref-leer');
      if (leer) { leer.hidden = !catOk || !!q; if (!leer.hidden) any = true; }
      sec.hidden = !any;
    });
    const tplSec = document.getElementById('kbTplSection');
    const tplOk = cat === 'alle' || cat === '__tpl';
    let tplAny = false;
    document.querySelectorAll('#kbTplSlot .tpl-card').forEach(c => {
      const box = c.closest('.kb-tpl-click') || c;
      const ok = tplOk && (!q || c.textContent.toLowerCase().includes(q));
      box.hidden = !ok; if (ok) { tplAny = true; shown++; }
    });
    // Admins sehen den Vorlagenbereich auch leer, damit sie die erste Vorlage anlegen können
    const manageEmpty = this.opts.templates?.mode === 'manage' && !this._tplCount() && !q && tplOk;
    tplSec.hidden = !(tplAny || manageEmpty);
    document.getElementById('kbTplCount').textContent = this._tplCount() || '';
    const none = document.getElementById('kbNone');
    none.hidden = !(this.files.length || this.artikel.length || this._tplCount()) || shown > 0 || manageEmpty;
    none.innerHTML = `<i class="fas fa-search"></i><b>Nichts gefunden${q ? ` für „${escHtml(this.q)}“` : ''}</b>
      <button class="btn btn-ghost btn-sm" onclick="Wiki.reset()">Suche zurücksetzen</button>`;
  },

  reset() {
    this.q = ''; this.cat = 'alle';
    const s = document.getElementById('kbSearch'); if (s) s.value = '';
    this.renderChips(); this.filter();
  },

  async _blob(filename) {
    const r = await fetch(`/api/wiki/files/${encodeURIComponent(filename)}`, { headers: { Authorization: 'Bearer ' + Auth.getToken() } });
    if (!r.ok) throw new Error('Datei nicht verfügbar');
    return r.blob();
  },

  async _loadThumbs() {
    for (const img of document.querySelectorAll('#kbDocs img[data-thumb]')) {
      const fn = img.dataset.thumb;
      try {
        this.thumbs[fn] = this.thumbs[fn] || URL.createObjectURL(await this._blob(fn));
        img.src = this.thumbs[fn];
        img.onload = () => img.classList.add('ready');
      } catch { /* Platzhalter bleibt */ }
    }
  },

  // ── Öffnen & Herunterladen ─────────────────────────────────
  async open(id) {
    const f = this.files.find(x => x.id === id);
    if (!f) return;
    const kind = this._kind(f);
    if (kind === 'doc') return this._docxPreview(f);
    if (kind === 'xls') return this.download(id);
    try {
      const url = URL.createObjectURL(await this._blob(f.filename));
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { showToast(e.message, 'err'); }
  },

  async download(id) {
    const f = this.files.find(x => x.id === id);
    if (!f) return;
    try {
      const url = URL.createObjectURL(await this._blob(f.filename));
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name + (this._ext(f) && !f.name.toLowerCase().endsWith('.' + this._ext(f).toLowerCase()) ? '.' + this._ext(f).toLowerCase() : '');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { showToast(e.message, 'err'); }
  },

  _modal(id, html, wide) {
    document.getElementById(id)?.remove();
    const o = document.createElement('div');
    o.id = id; o.className = 'modal-overlay open'; o.style.zIndex = 900;
    o.innerHTML = `<div class="modal modal-flex" style="max-width:${wide ? 780 : 520}px">${html}</div>`;
    o.addEventListener('mousedown', e => { if (e.target === o) o.remove(); });
    document.body.appendChild(o);
    return o;
  },

  async _docxPreview(f) {
    const o = this._modal('kbPreview', `
      <div class="modal-header"><div class="modal-heading"><span class="modal-icon"><i class="fas fa-file-word"></i></span>
        <div style="min-width:0"><div class="modal-title">${escHtml(f.name)}</div><div class="modal-subtitle">${escHtml(f.category)}</div></div></div>
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body"><div class="kb-docx" id="kbDocx"><i class="fas fa-spinner fa-spin"></i></div></div>
      <div class="modal-footer"><button class="btn btn-primary" onclick="Wiki.download(${f.id})"><i class="fas fa-download"></i> Herunterladen</button></div>`, true);
    try {
      const res = await mammoth.convertToHtml({ arrayBuffer: await (await this._blob(f.filename)).arrayBuffer() });
      o.querySelector('#kbDocx').innerHTML = res.value || '<p>Das Dokument ist leer.</p>';
    } catch {
      o.querySelector('#kbDocx').innerHTML = '<p>Vorschau nicht möglich. Bitte herunterladen.</p>';
    }
  },

  showTemplate(i) {
    const t = this.templates[i];
    if (!t) return;
    const body = String(t.body || '');
    const html = /<[a-z][\s\S]*>/i.test(body) ? body : escHtml(body).replace(/\n/g, '<br>');
    this._modal('kbTplPreview', `
      <div class="modal-header"><div class="modal-heading"><span class="modal-icon"><i class="fas fa-envelope-open-text"></i></span>
        <div style="min-width:0"><div class="modal-title">${escHtml(t.name)}</div>${t.category ? `<div class="modal-subtitle">${escHtml(t.category)}</div>` : ''}</div></div>
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        <div class="kb-mail"><div class="kb-mail-subj"><span>Betreff</span>${escHtml(t.subject || '')}</div><div class="kb-mail-body">${html}</div></div>
        <div class="modal-note"><i class="fas fa-lightbulb" style="color:var(--copper);margin-right:6px"></i>Im Lead auf <b>E-Mail</b> klicken und diese Vorlage wählen. Name und Firma werden automatisch eingesetzt.</div>
      </div>`);
  },

  async _loadHelp() {
    const el = document.getElementById('kbHelp');
    let c = {};
    try { c = await api('GET', '/users/admin-contact'); } catch {}
    const name = c.full_name || 'Aleksandra Dalak';
    const first = name.split(' ')[0];
    const initials = name.split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
    const wa = c.phone ? String(c.phone).replace(/[^\d+]/g, '').replace(/^(\+|00)/, '').replace(/^0/, '49') : '';
    el.innerHTML = `
      <span class="kb-help-av">${escHtml(initials)}</span>
      <div class="kb-help-text"><b>Fragen? Melde dich einfach.</b><span>${escHtml(first)} hilft dir gern weiter, ob zu Preisen, Einwänden oder einem bestimmten Kunden.</span></div>
      <div class="kb-help-actions">
        ${wa ? `<a class="btn btn-ghost btn-sm" href="https://wa.me/${wa}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> WhatsApp</a>` : ''}
        ${c.email ? `<a class="btn btn-ghost btn-sm" href="mailto:${escHtml(c.email)}"><i class="fas fa-envelope"></i> E-Mail</a>` : ''}
        ${typeof showSection === 'function' ? `<button class="btn btn-primary btn-sm" onclick="showSection('chat')"><i class="fas fa-comments"></i> Rücksprache</button>` : ''}
      </div>`;
  },

  // ── Admin: Hochladen & Bearbeiten ──────────────────────────
  _pageDrop(box) {
    let depth = 0;
    const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
    box.addEventListener('dragenter', e => { if (!hasFiles(e) || document.getElementById('kbForm')) return; depth++; box.classList.add('kb-dragging'); });
    box.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; box.classList.remove('kb-dragging'); } });
    box.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    box.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; box.classList.remove('kb-dragging');
      const file = e.dataTransfer.files[0];
      if (file && !document.getElementById('kbForm')) this.openForm(null, file);
    });
  },

  openForm(id, file) {
    const f = id ? this.files.find(x => x.id === id) : null;
    const cats = [...new Set([...this._cats(), ...this.DEFAULT_CATS])];
    const cat = f ? f.category : (this.cat !== 'alle' && this.cat !== '__tpl' ? this.cat : '');
    this.form = { id: f?.id || null, file: null, cat };
    const o = this._modal('kbForm', `
      <div class="modal-header"><div class="modal-heading"><span class="modal-icon ${f ? '' : 'copper'}"><i class="fas fa-${f ? 'pen' : 'cloud-upload-alt'}"></i></span>
        <div><div class="modal-title">${f ? 'Unterlage bearbeiten' : 'Unterlage hochladen'}</div>
        <div class="modal-subtitle">${f ? 'Änderungen sieht dein Team sofort' : 'Dein Team sieht sie sofort in der Wissensdatenbank'}</div></div></div>
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        <div class="kb-drop" id="kbDrop" tabindex="0" onclick="document.getElementById('kbFile').click()"
          onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}">
          <input type="file" id="kbFile" hidden accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.xlsx,.txt" onchange="Wiki._pick(this.files[0])">
          <div class="kb-drop-empty">
            <span class="kb-drop-ic"><i class="fas fa-cloud-upload-alt"></i></span>
            <b>${f ? 'Neue Version hierher ziehen' : 'Datei hierher ziehen'}</b>
            <span>oder <u>vom Computer auswählen</u></span>
            <small>PDF, Bild, Word, Excel oder Text · bis 15 MB${f ? ' · optional' : ''}</small>
          </div>
          <div class="kb-drop-file" id="kbDropFile"></div>
        </div>
        <div class="form-group" style="margin:0"><label>Bezeichnung</label>
          <input type="text" class="form-control" id="kbName" maxlength="255" placeholder="z. B. Preisliste 2026" value="${escHtml(f?.name || '')}"></div>
        <div class="form-group" style="margin:0"><label>Kategorie</label>
          <div class="kb-picks" id="kbPicks">
            ${cats.map(c => `<button type="button" class="kb-pick${c === cat ? ' on' : ''}" data-cat="${escHtml(c)}" onclick="Wiki._cat(this)"><i class="fas fa-${this._catIcon(c)}"></i>${escHtml(c)}</button>`).join('')}
            <button type="button" class="kb-pick kb-pick-new" onclick="Wiki._newCat(this)"><i class="fas fa-plus"></i>Neue Kategorie</button>
          </div></div>
        <div class="form-group" style="margin:0"><label>Hinweis fürs Team <span class="kb-opt">optional</span></label>
          <textarea class="form-control" id="kbNote" rows="2" maxlength="500" placeholder="z. B. Vor dem ersten Kundengespräch lesen. Gültig ab Januar.">${escHtml(f?.note || '')}</textarea></div>
      </div>
      <div class="modal-footer">
        ${f ? `<button class="btn btn-ghost kb-del" onclick="Wiki.remove(${f.id})"><i class="fas fa-trash"></i> Löschen</button><span style="flex:1"></span>` : ''}
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Abbrechen</button>
        <button class="btn btn-primary" id="kbSave" onclick="Wiki.save()"><i class="fas fa-check"></i> ${f ? 'Speichern' : 'Hochladen'}</button>
      </div>`);
    const drop = o.querySelector('#kbDrop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); this._pick(e.dataTransfer.files[0]); });
    if (file) this._pick(file);
    setTimeout(() => (f || file ? o.querySelector('#kbName') : drop).focus(), 40);
  },

  _pick(file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'docx', 'xlsx', 'txt'].includes(ext)) return showToast('Nur PDF, Bilder, Word, Excel und Text sind erlaubt', 'err');
    if (file.size > 15 * 1048576) return showToast('Die Datei ist größer als 15 MB', 'err');
    this.form.file = file;
    const name = document.getElementById('kbName');
    if (!name.value.trim()) {
      const n = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      name.value = n.charAt(0).toUpperCase() + n.slice(1);
    }
    const drop = document.getElementById('kbDrop');
    drop.classList.add('has-file');
    document.getElementById('kbDropFile').innerHTML = `
      <span class="kb-page sm"><b>${escHtml(ext.toUpperCase())}</b><span></span><span></span></span>
      <div class="kb-drop-meta"><b>${escHtml(file.name)}</b><span>${this._size(file.size)} · bereit${this.form.id ? ' zum Austauschen' : ''}</span></div>
      <span class="kb-drop-change">Andere Datei</span>`;
  },

  _cat(btn) {
    document.querySelectorAll('#kbPicks .kb-pick').forEach(b => b.classList.toggle('on', b === btn));
    this.form.cat = btn.dataset.cat;
  },

  _newCat(btn) {
    const input = document.createElement('input');
    input.className = 'kb-pick-input'; input.maxLength = 100; input.placeholder = 'Name der Kategorie';
    btn.replaceWith(input);
    input.focus();
    const done = () => {
      const v = input.value.trim();
      if (!v) { input.replaceWith(btn); return; }
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'kb-pick'; b.dataset.cat = v;
      b.innerHTML = `<i class="fas fa-${this._catIcon(v)}"></i>${escHtml(v)}`;
      b.onclick = () => this._cat(b);
      input.replaceWith(b, btn);
      this._cat(b);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = ''; input.blur(); } });
    input.addEventListener('blur', done);
  },

  async save() {
    const fm = this.form;
    const name = document.getElementById('kbName').value.trim();
    const note = document.getElementById('kbNote').value.trim();
    if (!fm.id && !fm.file) return showToast('Bitte zuerst eine Datei auswählen', 'err');
    if (!name) return showToast('Bitte eine Bezeichnung eingeben', 'err');
    if (!fm.cat) return showToast('Bitte eine Kategorie wählen', 'err');
    const btn = document.getElementById('kbSave');
    btn.disabled = true;
    const send = async (method, url, body) => {
      const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + Auth.getToken() }, body });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Speichern fehlgeschlagen');
    };
    try {
      if (fm.id) {
        await api('PATCH', `/wiki/files/${fm.id}`, { name, category: fm.cat, note });
        if (fm.file) { const d = new FormData(); d.append('file', fm.file); await send('PUT', `/api/wiki/files/${fm.id}/replace`, d); }
      } else {
        const d = new FormData();
        d.append('file', fm.file); d.append('name', name); d.append('category', fm.cat); d.append('note', note);
        await send('POST', '/api/wiki/files', d);
      }
      document.getElementById('kbForm')?.remove();
      showToast(fm.id ? 'Gespeichert ✓' : 'Hochgeladen ✓');
      this.load();
    } catch (e) { showToast(e.message, 'err'); btn.disabled = false; }
  },

  async remove(id) {
    const f = this.files.find(x => x.id === id);
    if (!await customConfirm(`„${f?.name || 'Unterlage'}“ wird für das ganze Team gelöscht.`, { title: 'Unterlage löschen?', okLabel: 'Löschen', danger: true })) return;
    try {
      await api('DELETE', `/wiki/files/${id}`);
      document.getElementById('kbForm')?.remove();
      showToast('Gelöscht');
      this.load();
    } catch (e) { showToast(e.message, 'err'); }
  },
};
