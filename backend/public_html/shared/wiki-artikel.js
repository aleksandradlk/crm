// ============================================================
// Wissensdatenbank: Artikel (Markdown), Referenzen und der einmalige
// Hinweis „Aktualisiert: …“. Ergänzt Wiki (wiki.js), rendert mit MD.
// Daten: /api/wiki/artikel, /wiki/artikel/import, /wiki/referenzen, /wiki/neu
// ============================================================
Object.assign(Wiki, {
  _frisch: new Set(),

  _plain(md) {
    return String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/^\s*#.*$/gm, ' ').replace(/[|*_>`#~-]+/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  },

  _artCard(a) {
    const text = this._plain(a.inhalt);
    const nr = /^\d+$/.test(a.schluessel || '') ? a.schluessel : '';
    return `<article class="kb-art" data-q="${escHtml([a.titel, a.kategorie, text].join(' ').toLowerCase())}" tabindex="0"
        onclick="Wiki.openArtikel(${a.id})" onkeydown="if(event.key==='Enter')Wiki.openArtikel(${a.id})">
      <span class="kb-art-nr">${nr ? escHtml(nr) : '<i class="fas fa-file-alt"></i>'}</span>
      <div class="kb-art-body">
        <h3 class="kb-art-title">${escHtml(a.titel)}${this._frisch.has(a.id) ? ' <span class="kb-new is-inline">Aktualisiert</span>' : ''}</h3>
        <p class="kb-art-snip">${escHtml(text.slice(0, 170))}${text.length > 170 ? ' …' : ''}</p>
      </div>
      <span class="kb-art-meta">${fmtDateShort(a.updated_at)}</span>
      <i class="fas fa-chevron-right kb-art-go"></i>
    </article>`;
  },

  openArtikel(id) {
    const a = this.artikel.find(x => x.id === id);
    if (!a) return;
    const o = this._modal('kbArtikel', `
      <div class="modal-header"><div class="modal-heading"><span class="modal-icon"><i class="fas fa-file-alt"></i></span>
        <div style="min-width:0"><div class="modal-title">${escHtml(a.titel)}</div>
          <div class="modal-subtitle">${escHtml(a.kategorie)} · Stand ${fmtDateShort(a.updated_at)}</div></div></div>
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body"><div class="md-body">${MD.render(a.inhalt)}</div></div>
      ${this.opts.isAdmin ? `<div class="modal-footer">
        <button class="btn btn-ghost" onclick="Wiki.loescheArtikel(${a.id})"><i class="fas fa-trash"></i> Löschen</button>
        <span style="flex:1"></span>
        <button class="btn btn-primary" onclick="Wiki.editArtikel(${a.id})"><i class="fas fa-pen"></i> Bearbeiten</button></div>` : ''}`, true);
    // Treffer der Suche im Artikel markieren
    if (this.q) this._markiere(o.querySelector('.md-body'), this.q);
  },
  _markiere(el, q) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const treffer = [];
    while (walker.nextNode()) if (walker.currentNode.nodeValue.toLowerCase().includes(q)) treffer.push(walker.currentNode);
    treffer.forEach(n => {
      const i = n.nodeValue.toLowerCase().indexOf(q);
      const m = document.createElement('mark');
      const rest = n.splitText(i); rest.splitText(q.length);
      m.textContent = rest.nodeValue; rest.replaceWith(m);
    });
    el.querySelector('mark')?.scrollIntoView({ block: 'center' });
  },

  // ── Admin: Artikel anlegen, bearbeiten, importieren ─────────
  editArtikel(id) {
    const a = id ? this.artikel.find(x => x.id === id) : null;
    document.getElementById('kbArtikel')?.remove();
    const cats = [...new Set(['Vertrieb', ...this._cats().filter(c => c !== 'Referenzen')])];
    const o = this._modal('kbArtEdit', `
      <div class="modal-header"><div class="modal-heading"><span class="modal-icon"><i class="fas fa-pen"></i></span>
        <div><div class="modal-title">${a ? 'Artikel bearbeiten' : 'Neuer Artikel'}</div>
          <div class="modal-subtitle">Markdown: # Überschrift, **fett**, - Liste, | Tabelle |</div></div></div>
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        <div class="kb-art-form">
          <div class="form-group" style="margin:0"><label>Titel</label><input class="form-control" id="kaTitel" maxlength="255" value="${escHtml(a?.titel || '')}"></div>
          <div class="form-group" style="margin:0"><label>Kategorie</label><input class="form-control" id="kaKat" list="kaKats" maxlength="100" value="${escHtml(a?.kategorie || 'Vertrieb')}">
            <datalist id="kaKats">${cats.map(c => `<option value="${escHtml(c)}">`).join('')}</datalist></div>
          <div class="form-group" style="margin:0"><label>Reihenfolge</label><input class="form-control" id="kaSort" type="number" min="0" value="${escHtml(a?.sort ?? '')}" placeholder="z. B. 7"></div>
        </div>
        <div class="view-toggle kb-art-tabs"><button class="active" data-t="text">Text</button><button data-t="vorschau">Vorschau</button></div>
        <textarea class="form-control kb-art-text" id="kaText" rows="18" spellcheck="true">${escHtml(a?.inhalt || '')}</textarea>
        <div class="md-body kb-art-vorschau" id="kaVorschau" hidden></div>
      </div>
      <div class="modal-footer"><button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Abbrechen</button>
        <button class="btn btn-primary" id="kaSave"><i class="fas fa-check"></i> Speichern</button></div>`, true);
    o.querySelectorAll('.kb-art-tabs button').forEach(b => b.onclick = () => {
      o.querySelectorAll('.kb-art-tabs button').forEach(x => x.classList.toggle('active', x === b));
      const v = b.dataset.t === 'vorschau';
      o.querySelector('#kaText').hidden = v; o.querySelector('#kaVorschau').hidden = !v;
      if (v) o.querySelector('#kaVorschau').innerHTML = MD.render(o.querySelector('#kaText').value);
    });
    o.querySelector('#kaSave').onclick = async () => {
      const body = { titel: o.querySelector('#kaTitel').value.trim(), kategorie: o.querySelector('#kaKat').value.trim() || 'Vertrieb',
        sort: o.querySelector('#kaSort').value, inhalt: o.querySelector('#kaText').value };
      if (!body.titel) return showToast('Bitte einen Titel eingeben', 'err');
      try {
        await api(a ? 'PUT' : 'POST', a ? `/wiki/artikel/${a.id}` : '/wiki/artikel', body);
        o.remove(); showToast('Artikel gespeichert ✓'); this.load();
      } catch (e) { showToast(e.message, 'err'); }
    };
  },

  async loescheArtikel(id) {
    const a = this.artikel.find(x => x.id === id);
    if (!await customConfirm(`„${a?.titel || 'Artikel'}“ wird für das ganze Team gelöscht.`, { title: 'Artikel löschen?', okLabel: 'Löschen', danger: true })) return;
    try { await api('DELETE', `/wiki/artikel/${id}`); document.getElementById('kbArtikel')?.remove(); showToast('Gelöscht'); this.load(); }
    catch (e) { showToast(e.message, 'err'); }
  },

  // Mehrere .md-Dateien auf einmal; gleiche Nummer (z. B. „07_…“) ersetzt den vorhandenen Artikel
  async importieren(liste) {
    const dateien = [...(liste || [])].filter(f => /\.(md|markdown|txt)$/i.test(f.name));
    if (!dateien.length) return showToast('Bitte Markdown-Dateien (.md) wählen', 'err');
    const erg = { neu: 0, ersetzt: 0, gleich: 0, fehler: [] };
    for (const f of dateien) {
      try {
        const r = await api('POST', '/wiki/artikel/import', { name: f.name, inhalt: await f.text() });
        if (r.neu) erg.neu++; else if (r.ersetzt) erg.ersetzt++; else erg.gleich++;
      } catch (e) { erg.fehler.push(`${f.name}: ${e.message}`); }
    }
    showToast([erg.neu && `${erg.neu} neu`, erg.ersetzt && `${erg.ersetzt} aktualisiert`, erg.gleich && `${erg.gleich} unverändert`]
      .filter(Boolean).join(' · ') || 'Nichts importiert', erg.fehler.length ? 'err' : undefined);
    if (erg.fehler.length) console.warn('Import:', erg.fehler);
    this.load();
  },

  // ── Referenzen ──────────────────────────────────────────────
  _refsHtml() {
    if (!this.referenzen.length) return `<div class="kb-ref-leer"><i class="fas fa-seedling"></i>
      <span>Die ersten Kundenprojekte sind in der Umsetzung, Referenzen folgen nach Abschluss.</span></div>`;
    return `<div class="kb-refs">${this.referenzen.map(r => `
      <article class="kb-ref" data-q="${escHtml([r.betrieb, r.branche, r.paket, r.ergebnis].join(' ').toLowerCase())}">
        <div class="kb-ref-top"><b>${escHtml(r.betrieb)}</b>${r.paket ? `<span class="pv-tag is-ok">${escHtml(r.paket)}</span>` : ''}</div>
        ${r.branche ? `<div class="kb-ref-branche">${escHtml(r.branche)}</div>` : ''}
        ${r.ergebnis ? `<p>${escHtml(r.ergebnis)}</p>` : ''}
        <div class="kb-ref-foot">${r.link ? `<a href="${escHtml(r.link)}" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i> Webseite</a>` : '<span></span>'}
          ${this.opts.isAdmin ? `<button class="btn btn-ghost btn-sm btn-icon" title="Bearbeiten" onclick="Wiki.editRef(${r.id})"><i class="fas fa-pen"></i></button>` : ''}</div>
      </article>`).join('')}</div>`;
  },

  editRef(id) {
    const r = id ? this.referenzen.find(x => x.id === id) : null;
    const pakete = ['Quick-Win', 'Autopilot S', 'Autopilot M', 'Autopilot L', 'Individuelle Software'];
    const o = this._modal('kbRefEdit', `
      <div class="modal-header"><div class="modal-heading"><span class="modal-icon"><i class="fas fa-star"></i></span>
        <div><div class="modal-title">${r ? 'Referenz bearbeiten' : 'Neue Referenz'}</div>
          <div class="modal-subtitle">Erscheint im Anrufmodus beim Einwand „Referenzen“</div></div></div>
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        <div class="form-group"><label>Betrieb *</label><input class="form-control" id="krBetrieb" maxlength="255" value="${escHtml(r?.betrieb || '')}"></div>
        <div class="deal-form-row">
          <div class="form-group"><label>Branche</label><input class="form-control" id="krBranche" maxlength="120" value="${escHtml(r?.branche || '')}" placeholder="z. B. Badsanierung"></div>
          <div class="form-group"><label>Paket</label><select class="form-control" id="krPaket"><option value="">–</option>${pakete.map(p => `<option${r?.paket === p ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
        </div>
        <div class="form-group"><label>Ergebnis (2–3 Sätze)</label><textarea class="form-control" id="krErgebnis" rows="3" maxlength="2000">${escHtml(r?.ergebnis || '')}</textarea></div>
        <div class="form-group"><label>Link zur Webseite</label><input class="form-control" id="krLink" type="url" maxlength="500" value="${escHtml(r?.link || '')}" placeholder="https://…"></div>
      </div>
      <div class="modal-footer">${r ? `<button class="btn btn-ghost" id="krDel"><i class="fas fa-trash"></i> Löschen</button>` : ''}<span style="flex:1"></span>
        <button class="btn btn-primary" id="krSave"><i class="fas fa-check"></i> Speichern</button></div>`);
    o.querySelector('#krSave').onclick = async () => {
      const body = { betrieb: o.querySelector('#krBetrieb').value.trim(), branche: o.querySelector('#krBranche').value.trim(),
        paket: o.querySelector('#krPaket').value, ergebnis: o.querySelector('#krErgebnis').value.trim(), link: o.querySelector('#krLink').value.trim() };
      if (!body.betrieb) return showToast('Bitte den Betrieb eintragen', 'err');
      if (body.link && !/^https?:\/\//i.test(body.link)) body.link = 'https://' + body.link;
      try { await api(r ? 'PUT' : 'POST', r ? `/wiki/referenzen/${r.id}` : '/wiki/referenzen', body); o.remove(); showToast('Referenz gespeichert ✓'); this.load(); }
      catch (e) { showToast(e.message, 'err'); }
    };
    o.querySelector('#krDel')?.addEventListener('click', async () => {
      if (!await customConfirm(`Referenz „${r.betrieb}“ löschen?`, { title: 'Referenz löschen?', okLabel: 'Löschen', danger: true })) return;
      try { await api('DELETE', `/wiki/referenzen/${r.id}`); o.remove(); showToast('Gelöscht'); this.load(); }
      catch (e) { showToast(e.message, 'err'); }
    });
  },

  // ── „Aktualisiert: …“ einmal anzeigen, dann als gesehen merken ──
  _neuGesehen() {
    const n = this.neu;
    const el = document.getElementById('kbNeu');
    if (!n || !n.anzahl) { if (el && !this._frisch.size) el.innerHTML = ''; return; }
    n.artikel.forEach(a => this._frisch.add(a.id));
    const titel = [...n.artikel, ...n.dateien].map(x => x.titel);
    if (el) el.innerHTML = `<div class="kb-neu"><i class="fas fa-bell"></i>
      <span><b>Aktualisiert:</b> ${titel.slice(0, 4).map(escHtml).join(', ')}${titel.length > 4 ? ` und ${titel.length - 4} weitere` : ''}</span>
      <button class="modal-x" onclick="this.closest('.kb-neu').remove()" title="Ausblenden"><i class="fas fa-times"></i></button></div>`;
    this.render();
    this.neu = { anzahl: 0, artikel: [], dateien: [] };
    api('POST', '/wiki/gesehen').catch(() => {});
    WikiNeu.setze(0);
  },
});

// Badge an „Wissensdatenbank“ in der Navigation
const WikiNeu = {
  elId: 'wikiBadge',
  async pruefen() {
    try { const r = await api('GET', '/wiki/neu'); this.setze(r.anzahl); Wiki.neu = r; } catch (_) {}
  },
  setze(n) {
    const el = document.getElementById(this.elId);
    if (!el) return;
    el.textContent = n; el.style.display = n ? '' : 'none';
    el.title = n ? `${n} ${n === 1 ? 'Artikel wurde' : 'Artikel wurden'} aktualisiert` : '';
  },
};
