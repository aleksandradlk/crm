// ============================================================
// Feedback-Board: Wünsche und Fehler als Spalten nach Status.
// Admin zieht Karten in eine andere Spalte und antwortet direkt an der
// Karte; Closer sehen ihre eigenen Einträge samt Antwort.
// Eingebunden in admin.html und closer.html über Board.mount().
// ============================================================
const Board = {
  opts: {}, items: [], typ: 'wunsch',

  COLS: [
    ['offen', 'Offen', 'inbox', 'navy'],
    ['in_planung', 'In Planung', 'tools', 'copper'],
    ['erledigt', 'Erledigt', 'check-circle', 'green'],
    ['nicht_moeglich', 'Nicht möglich', 'ban', 'muted'],
  ],

  // opts: rootId, isAdmin
  mount(opts) {
    this.opts = opts;
    const root = document.getElementById(opts.rootId);
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    root.innerHTML = `
      <div class="bd">
        <header class="bd-hero">
          <div class="bd-hero-text">
            <div class="kb-eyebrow">Feedback-Board</div>
            <h1 class="bd-title">${opts.isAdmin ? 'Was dein Team sich wünscht' : 'Mach das CRM besser'}</h1>
            <p class="bd-sub">${opts.isAdmin
              ? 'Wünsche und Fehlermeldungen aus dem Team. Karte in eine andere Spalte ziehen ändert den Status, „Antworten“ schreibt direkt an den Eintrag.'
              : 'Dir fehlt etwas oder etwas hakt? Schreib es kurz auf, Aleksandra antwortet direkt am Eintrag.'}</p>
          </div>
          <div class="bd-hero-actions">
            <button class="bd-big" onclick="Board.openForm('wunsch')"><span><i class="fas fa-lightbulb"></i></span><b>Idee einreichen</b><small>Was würde dir die Arbeit leichter machen?</small></button>
            <button class="bd-big bug" onclick="Board.openForm('bug')"><span><i class="fas fa-bug"></i></span><b>Fehler melden</b><small>Etwas funktioniert nicht wie es soll</small></button>
          </div>
        </header>
        <div class="bd-cols" id="bdCols"></div>
      </div>`;
  },

  async load() {
    try { this.items = await api('GET', '/feedback'); this.render(); }
    catch (e) { showToast(e.message, 'err'); }
  },

  render() {
    const el = document.getElementById('bdCols');
    if (!el) return;
    el.innerHTML = this.COLS.map(([tag, label, icon, tone]) => {
      const list = this.items.filter(f => (f.tag || 'offen') === tag);
      return `<section class="bd-col tone-${tone}" data-tag="${tag}">
        <div class="bd-col-head"><i class="fas fa-${icon}"></i><b>${label}</b><span class="bd-count">${list.length}</span></div>
        <div class="bd-col-body">${list.map(f => this._card(f)).join('') || `<div class="bd-empty">${tag === 'offen' && !this.items.length ? 'Noch nichts eingereicht – leg los!' : 'Leer'}</div>`}</div>
      </section>`;
    }).join('');
    if (this.opts.isAdmin) this._dnd(el);
  },

  _card(f) {
    const bug = f.type === 'bug';
    const initials = (f.author_name || '?').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
    const admin = this.opts.isAdmin;
    return `<article class="bd-card" data-id="${f.id}" ${admin ? 'draggable="true"' : ''}>
      <div class="bd-card-top">
        <span class="bd-type ${bug ? 'bug' : ''}"><i class="fas fa-${bug ? 'bug' : 'lightbulb'}"></i>${bug ? 'Fehler' : 'Idee'}</span>
        <span class="bd-date">${fmtDateShort(f.created_at)}</span>
      </div>
      <h3 class="bd-card-title">${escHtml(f.title)}</h3>
      ${f.description ? `<p class="bd-card-desc">${escHtml(f.description)}</p>` : ''}
      ${f.admin_note ? `<div class="bd-answer"><i class="fas fa-reply"></i><span>${escHtml(f.admin_note)}</span></div>` : ''}
      <div class="bd-card-foot">
        ${admin ? `<span class="bd-author"><span class="bd-av">${escHtml(initials)}</span>${escHtml((f.author_name || '').split(' ')[0])}</span>` : '<span></span>'}
        <span class="bd-tools">
          ${admin ? `<button class="btn btn-ghost btn-sm btn-icon${f.admin_note ? '' : ' bd-reply'}" title="${f.admin_note ? 'Antwort ändern' : 'Antworten'}" onclick="Board.answer(${f.id})"><i class="fas fa-reply"></i></button>
            <button class="btn btn-ghost btn-sm btn-icon bd-move" title="Status ändern" onclick="Board.menu(event, ${f.id})"><i class="fas fa-exchange-alt"></i></button>` : ''}
          <button class="btn btn-ghost btn-sm btn-icon" title="Löschen" onclick="Board.remove(${f.id})"><i class="fas fa-trash"></i></button>
        </span>
      </div>
    </article>`;
  },

  // Admin: Karten zwischen Spalten ziehen
  _dnd(el) {
    el.querySelectorAll('.bd-card').forEach(c => {
      c.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); });
      c.addEventListener('dragend', () => c.classList.remove('dragging'));
    });
    el.querySelectorAll('.bd-col').forEach(col => {
      col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
      col.addEventListener('drop', e => {
        e.preventDefault(); col.classList.remove('over');
        const id = parseInt(e.dataTransfer.getData('text/plain'));
        if (id) this.setTag(id, col.dataset.tag);
      });
    });
  },

  // Admin: Status per Menü ändern (Handy, ohne Ziehen)
  menu(ev, id) {
    ev.stopPropagation();
    document.querySelector('.bd-menu')?.remove();
    const f = this.items.find(x => x.id === id);
    const m = document.createElement('div');
    m.className = 'bd-menu';
    m.innerHTML = this.COLS.map(([tag, label, icon, tone]) => `<button class="tone-${tone}${f.tag === tag ? ' on' : ''}" onclick="Board.setTag(${id}, '${tag}')"><i class="fas fa-${icon}"></i>${label}</button>`).join('');
    document.body.appendChild(m);
    const r = ev.currentTarget.getBoundingClientRect();
    m.style.top = Math.min(window.innerHeight - m.offsetHeight - 8, r.bottom + 6) + 'px';
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px';
    setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
  },

  async setTag(id, tag) {
    document.querySelector('.bd-menu')?.remove();
    const f = this.items.find(x => x.id === id);
    if (!f || f.tag === tag) return;
    const vorher = f.tag;
    f.tag = tag; this.render();
    try { await api('PATCH', `/feedback/${id}`, { tag }); }
    catch (e) { f.tag = vorher; this.render(); showToast(e.message, 'err'); }
  },

  _modal(html) {
    document.getElementById('bdModal')?.remove();
    const o = document.createElement('div');
    o.id = 'bdModal'; o.className = 'modal-overlay open'; o.style.zIndex = 900;
    o.innerHTML = `<div class="modal modal-flex" style="max-width:500px">${html}</div>`;
    o.addEventListener('mousedown', e => { if (e.target === o) o.remove(); });
    document.body.appendChild(o);
    return o;
  },

  openForm(typ) {
    this.typ = typ;
    const o = this._modal(`
      <div class="modal-header"><div class="modal-heading"><span class="modal-icon ${typ === 'bug' ? 'red' : 'copper'}"><i class="fas fa-${typ === 'bug' ? 'bug' : 'lightbulb'}"></i></span>
        <div><div class="modal-title">${typ === 'bug' ? 'Fehler melden' : 'Idee einreichen'}</div><div class="modal-subtitle">${typ === 'bug' ? 'Was ist passiert und wo?' : 'Je konkreter, desto schneller umgesetzt'}</div></div></div>
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        <div class="kb-picks">
          <button type="button" class="kb-pick${typ === 'wunsch' ? ' on' : ''}" onclick="Board.openForm('wunsch')"><i class="fas fa-lightbulb"></i>Idee</button>
          <button type="button" class="kb-pick${typ === 'bug' ? ' on' : ''}" onclick="Board.openForm('bug')"><i class="fas fa-bug"></i>Fehler</button>
        </div>
        <div class="form-group" style="margin:0"><label>In einem Satz</label>
          <input id="bdTitle" class="form-control" maxlength="200" placeholder="${typ === 'bug' ? 'z. B. Anrufmodus springt nach dem Speichern nicht weiter' : 'z. B. Wiedervorlage direkt aus dem Posteingang setzen'}"></div>
        <div class="form-group" style="margin:0"><label>Details <span class="kb-opt">optional</span></label>
          <textarea id="bdDesc" class="form-control" rows="4" placeholder="${typ === 'bug' ? 'Was hast du gemacht, was ist passiert, was hättest du erwartet?' : 'Wobei würde es dir helfen?'}"></textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Abbrechen</button>
        <button class="btn btn-primary" id="bdSend" onclick="Board.submit()"><i class="fas fa-paper-plane"></i> Absenden</button>
      </div>`);
    const t = o.querySelector('#bdTitle');
    t.focus();
    t.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.submit(); } });
  },

  async submit() {
    const title = document.getElementById('bdTitle').value.trim();
    if (!title) { showToast('Bitte kurz beschreiben, worum es geht', 'err'); return; }
    const btn = document.getElementById('bdSend'); btn.disabled = true;
    try {
      await api('POST', '/feedback', { title, description: document.getElementById('bdDesc').value.trim() || null, type: this.typ });
      document.getElementById('bdModal')?.remove();
      showToast(this.typ === 'bug' ? 'Danke, Fehler gemeldet ✓' : 'Danke für deine Idee ✓');
      this.load();
    } catch (e) { showToast(e.message, 'err'); btn.disabled = false; }
  },

  answer(id) {
    const f = this.items.find(x => x.id === id);
    const o = this._modal(`
      <div class="modal-header"><div class="modal-heading"><span class="modal-icon"><i class="fas fa-reply"></i></span>
        <div style="min-width:0"><div class="modal-title">Antworten</div><div class="modal-subtitle">${escHtml(f.title)}</div></div></div>
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        ${f.description ? `<div class="modal-note">${escHtml(f.description)}</div>` : ''}
        <textarea id="bdNote" class="form-control" rows="4" placeholder="z. B. Gute Idee, kommt nächste Woche!">${escHtml(f.admin_note || '')}</textarea>
        <div class="kb-picks">${this.COLS.map(([tag, label, icon]) => `<button type="button" class="kb-pick${f.tag === tag ? ' on' : ''}" data-tag="${tag}" onclick="this.parentNode.querySelectorAll('.kb-pick').forEach(b=>b.classList.toggle('on', b===this))"><i class="fas fa-${icon}"></i>${label}</button>`).join('')}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Abbrechen</button>
        <button class="btn btn-primary" onclick="Board.saveAnswer(${id})"><i class="fas fa-check"></i> Speichern</button>
      </div>`);
    o.querySelector('#bdNote').focus();
  },

  async saveAnswer(id) {
    const f = this.items.find(x => x.id === id);
    const note = document.getElementById('bdNote').value.trim();
    const tag = document.querySelector('#bdModal .kb-pick.on')?.dataset.tag || f.tag;
    try {
      await api('PATCH', `/feedback/${id}`, { admin_note: note, tag });
      f.admin_note = note || null; f.tag = tag;
      document.getElementById('bdModal')?.remove();
      showToast('Antwort gespeichert ✓');
      this.render();
    } catch (e) { showToast(e.message, 'err'); }
  },

  async remove(id) {
    if (!await customConfirm('Der Eintrag wird endgültig gelöscht.', { title: 'Eintrag löschen?', okLabel: 'Löschen', danger: true })) return;
    try { await api('DELETE', `/feedback/${id}`); this.items = this.items.filter(x => x.id !== id); this.render(); }
    catch (e) { showToast(e.message, 'err'); }
  },
};
