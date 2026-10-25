// ============================================================
// Startklar-Check (nur Admin): Was fehlt noch, damit der Vertrieb
// loslegen kann? Daten von GET /api/startklar. Eingebunden in admin.html
// (eigener Bereich + kurzer Hinweis auf dem Dashboard).
// ============================================================
const Startklar = {
  rootId: null, data: null,

  mount(rootId) {
    this.rootId = rootId;
    const root = document.getElementById(rootId);
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    root.innerHTML = `
      <div class="page-header">
        <div><h1 data-eyebrow="Administration">Startklar-Check</h1><p class="page-desc">Alles, was das CRM für den Vertrieb braucht – grün ist erledigt, gelb ist ein Hinweis, rot fehlt noch.</p></div>
        <div class="page-actions"><button class="btn btn-ghost btn-sm" onclick="Startklar.load()"><i class="fas fa-sync"></i> Neu prüfen</button></div>
      </div>
      <div id="skBody"><div class="wiki-empty"><i class="fas fa-spinner fa-spin"></i>Wird geprüft …</div></div>`;
  },

  async load() {
    const body = document.getElementById('skBody');
    if (body) body.innerHTML = '<div class="wiki-empty"><i class="fas fa-spinner fa-spin"></i>Wird geprüft – Telefonie und E-Mail werden live getestet …</div>';
    try {
      this.data = await api('GET', '/startklar');
      this.render();
      this.badge();
    } catch (e) { if (body) body.innerHTML = `<div class="wiki-empty" style="color:var(--red)">${escHtml(e.message)}</div>`; }
  },

  icon(stand) {
    return { ok: '<i class="fas fa-check"></i>', warn: '<i class="fas fa-exclamation"></i>', fehlt: '<i class="fas fa-times"></i>' }[stand];
  },

  aktion(a) {
    if (!a) return '';
    if (a.url) return `<a class="btn btn-ghost btn-sm" href="${escHtml(a.url)}" target="_blank" rel="noopener">${escHtml(a.label)} <i class="fas fa-external-link-alt"></i></a>`;
    return `<button class="btn btn-ghost btn-sm" onclick="showTab('${escHtml(a.tab)}')">${escHtml(a.label)} <i class="fas fa-arrow-right"></i></button>`;
  },

  render() {
    const body = document.getElementById('skBody');
    if (!body || !this.data) return;
    const d = this.data, gesamt = d.punkte.length;
    const prozent = gesamt ? Math.round(d.ok / gesamt * 100) : 0;
    const gruppen = [...new Set(d.punkte.map(p => p.gruppe))];
    const titel = d.fehlt ? `Noch ${d.fehlt} ${d.fehlt === 1 ? 'Punkt' : 'Punkte'} bis startklar`
      : d.warn ? 'Startklar – mit ein paar Hinweisen' : 'Alles startklar';
    body.innerHTML = `
      <div class="sk-hero ${d.fehlt ? 'fehlt' : d.warn ? 'warn' : 'ok'}">
        <div class="sk-ring" style="--p:${prozent}"><b>${prozent}%</b></div>
        <div class="sk-hero-text"><b>${titel}</b>
          <span>${d.ok} von ${gesamt} erledigt${d.warn ? ` · ${d.warn} ${d.warn === 1 ? 'Hinweis' : 'Hinweise'}` : ''}${d.fehlt ? ` · ${d.fehlt} offen` : ''}</span></div>
      </div>
      <div class="sk-grid">${gruppen.map(g => {
        const ps = d.punkte.filter(p => p.gruppe === g)
          .sort((a, b) => ({ fehlt: 0, warn: 1, ok: 2 }[a.stand] - { fehlt: 0, warn: 1, ok: 2 }[b.stand]));
        return `<section class="sk-card"><div class="sk-card-head">${escHtml(g)}
            <span>${ps.filter(p => p.stand === 'ok').length}/${ps.length}</span></div>
          ${ps.map(p => `<div class="sk-row ${p.stand}">
            <span class="sk-ic">${this.icon(p.stand)}</span>
            <div class="sk-main"><b>${escHtml(p.titel)}</b><span>${escHtml(p.text)}</span></div>
            ${p.stand !== 'ok' ? this.aktion(p.aktion) : ''}
          </div>`).join('')}</section>`;
      }).join('')}</div>`;
  },

  badge() {
    const n = this.data ? this.data.fehlt : 0;
    const b = document.getElementById('startklarBadge');
    if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
    const dash = document.getElementById('dashStartklar');
    if (!dash || !this.data) return;
    const d = this.data;
    dash.innerHTML = d.fehlt || d.warn ? `<button class="sk-bar ${d.fehlt ? 'fehlt' : 'warn'}" onclick="showTab('startklar')">
        <i class="fas ${d.fehlt ? 'fa-rocket' : 'fa-check-circle'}"></i>
        <span><b>${d.fehlt ? `Noch ${d.fehlt} ${d.fehlt === 1 ? 'Punkt' : 'Punkte'} bis startklar` : 'Startklar'}</b>${d.warn ? ` · ${d.warn} ${d.warn === 1 ? 'Hinweis' : 'Hinweise'}` : ''}</span>
        <span class="sk-bar-go">Ansehen <i class="fas fa-arrow-right"></i></span></button>` : '';
  },

  // Für Dashboard und Badge im Hintergrund prüfen
  async vorab() {
    try { this.data = await api('GET', '/startklar'); this.badge(); } catch (_) {}
  },
};
