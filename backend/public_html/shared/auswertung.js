// ============================================================
// Vertriebs-Auswertung (Admin, Tracking): angebotsreife Bedarfsanalysen,
// Zeit bis zum Angebot, Abschlussquote nach Paket/Herkunft, Gründe,
// Closer ohne Aktivität. Daten: GET /api/auswertung?tage=…
// ============================================================
const Auswertung = {
  tage: 90, daten: null,

  async render(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    this._elId = elId;
    try { this.daten = await api('GET', `/auswertung?tage=${this.tage}`); }
    catch (e) { el.innerHTML = `<div class="card" style="padding:16px;color:var(--red)">${escHtml(e.message)}</div>`; return; }
    const d = this.daten;
    const eur = v => Number(v || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
    const std = h => {
      if (h == null) return '—';
      if (h < 48) return `${String(h).replace('.', ',')} Std.`;
      const t = Math.round(h / 24 * 10) / 10;
      return `${String(t).replace('.', ',')} ${t === 1 ? 'Tag' : 'Tage'}`;
    };
    const balken = (p, ok) => `<div class="zl-bar au-bar"><div style="width:${p || 0}%" class="${ok ? 'is-done' : ''}"></div></div>`;
    const leer = t => `<div class="au-empty">${t}</div>`;
    const quoteTab = (rows, titel) => `
      <div class="card au-card"><div class="au-h">${titel}</div>
        ${rows.length ? `<table class="au-table"><thead><tr><th></th><th>Gewonnen</th><th>Verloren</th><th>Offen</th><th>Quote</th><th>Umsatz</th></tr></thead><tbody>
          ${rows.map(r => `<tr><td><b>${escHtml(r.label)}</b></td><td data-l="Gewonnen">${r.gewonnen}</td><td data-l="Verloren">${r.verloren}</td><td data-l="Offen">${r.offen}</td>
            <td data-l="Quote">${r.quote == null ? '<span class="au-muted">—</span>' : `<b>${r.quote} %</b>${balken(r.quote, r.quote >= 30)}`}</td><td data-l="Umsatz">${eur(r.umsatz)}</td></tr>`).join('')}
        </tbody></table>` : leer('Noch keine Deals im Zeitraum.')}
      </div>`;
    const gruende = (rows, titel) => {
      const max = Math.max(1, ...rows.map(r => r.n));
      return `<div class="au-gruende"><div class="au-sub">${titel}</div>${rows.length ? rows.map(r => `
        <div class="au-grund"><span>${escHtml(r.grund)}</span><div class="zl-bar au-bar"><div style="width:${Math.round(r.n / max * 100)}%"></div></div><b>${r.n}</b></div>`).join('') : leer('Keine im Zeitraum.')}</div>`;
    };
    el.innerHTML = `
      <div class="zl-nav au-nav">
        ${[[30, '30 Tage'], [90, '90 Tage'], [365, '12 Monate'], [0, 'Alles']].map(([t, l]) =>
          `<button class="qf-btn ${this.tage === t ? 'active' : ''}" onclick="Auswertung.tage=${t};Auswertung.render('${elId}')">${l}</button>`).join('')}
      </div>
      ${d.inaktiv.length ? `<div class="au-warn"><i class="fas fa-user-clock"></i><div><b>${d.inaktiv.length} Closer ohne Aktivität seit ${d.inaktiv_tage} Tagen</b>
        <span>${d.inaktiv.map(c => `${escHtml(c.full_name)} (${c.tage == null ? 'noch nie aktiv' : 'seit ' + c.tage + ' Tagen'})`).join(' · ')}</span></div></div>` : ''}
      <div class="au-grid">
        <div class="card au-card"><div class="au-h">Bedarfsanalysen je Closer</div>
          ${d.bedarf.length ? `<table class="au-table"><thead><tr><th>Closer</th><th>Analysen</th><th>Angebotsreif</th><th>Angefordert</th><th title="Pflichtfragen im Schnitt beantwortet">Durchschnittlich beantwortete Fragen</th></tr></thead><tbody>
            ${d.bedarf.map(b => `<tr><td><b>${escHtml(b.full_name)}</b></td><td data-l="Analysen">${b.analysen}</td>
              <td data-l="Angebotsreif">${b.anteil == null ? '<span class="au-muted">—</span>' : `<b>${b.anteil} %</b> <span class="au-muted">(${b.reif})</span>${balken(b.anteil, b.anteil >= 60)}`}</td>
              <td data-l="Angefordert">${b.angefordert}</td><td data-l="Durchschnittlich beantwortete Fragen">${b.fragen_schnitt == null ? '—' : String(b.fragen_schnitt).replace('.', ',') + ' / 5'}</td></tr>`).join('')}
          </tbody></table>` : leer('Noch keine Closer angelegt.')}
        </div>
        <div class="card au-card"><div class="au-h">Angebot anfordern → Angebot gesendet</div>
          <div class="au-kpis">
            <div><b>${std(d.zeit.std_schnitt)}</b><span>im Schnitt</span></div>
            <div><b>${d.zeit.n ? Math.round(d.zeit.in_24h / d.zeit.n * 100) + ' %' : '—'}</b><span>in 24 Std.</span></div>
            <div><b>${std(d.zeit.std_max)}</b><span>längste</span></div>
            <div class="${d.zeit.wartend ? 'is-warn' : ''}"><b>${d.zeit.wartend}</b><span>wartet gerade${d.zeit.wartend ? ` · max. ${std(d.zeit.wartend_std_max)}` : ''}</span></div>
          </div>
          <div class="au-muted" style="font-size:12px">${d.zeit.n} ${d.zeit.n === 1 ? 'Angebot' : 'Angebote'} im Zeitraum verschickt</div>
        </div>
        ${quoteTab(d.nach_paket, 'Abschlussquote nach Paket')}
        ${quoteTab(d.nach_herkunft, 'Abschlussquote nach Herkunft')}
        <div class="card au-card au-wide"><div class="au-h">Gründe</div>
          <div class="au-gruende-wrap">${gruende(d.gruende.verloren, 'Deal verloren')}${gruende(d.gruende.passt_nicht, 'Lead passt nicht')}</div>
        </div>
        ${typeof Provision !== 'undefined' ? '<div class="au-wide" id="auProvision"></div><div class="au-wide" id="auAbschluesse"></div>' : ''}
      </div>`;
    if (typeof Provision !== 'undefined') { Provision.team('auProvision'); Provision.abschluesseAdmin('auAbschluesse'); }
  },

  // Dashboard: Hinweis auf Closer ohne Aktivität
  async dashboard(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    try {
      const r = await api('GET', '/auswertung/inaktiv');
      const n = r.closer.length;
      el.innerHTML = n ? `<button class="sk-bar warn" onclick="showTab('tracking')"><i class="fas fa-user-clock"></i>
        <span><b>${n} Closer ohne Aktivität seit ${r.tage} Tagen</b> · ${r.closer.slice(0, 3).map(c => escHtml(c.full_name)).join(', ')}${n > 3 ? ' …' : ''}</span>
        <span class="sk-bar-go">Ansehen <i class="fas fa-arrow-right"></i></span></button>` : '';
    } catch (_) { el.innerHTML = ''; }
  },
};
