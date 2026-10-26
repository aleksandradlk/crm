// ============================================================
// Seitenpanel im Anrufmodus: Lead · Bedarfsanalyse · Einwände · FAQ ·
// Preise & Möglich, mit Suche über alle Tabs. Liegt neben dem Lead im
// Anrufmodus und wird beim nächsten Lead nicht neu aufgebaut: Tabwechsel
// stören den laufenden Anruf nicht. Inhalte kommen aus der Wissensdatenbank
// (Kategorie „Vertrieb“, Artikel 01, 05, 06, 07, 08) – gepflegt an einer Stelle.
// Tasten: Alt+1 … Alt+5 Tabs · „/“ Suche · Alt+0 ein-/ausklappen
// ============================================================
const Seite = {
  TABS: [
    ['lead', 'Lead', 'fa-store'],
    ['bedarf', 'Bedarf', 'fa-clipboard-list'],
    ['einwaende', 'Einwände', 'fa-comments'],
    ['faq', 'FAQ', 'fa-question-circle'],
    ['preise', 'Preise & Möglich', 'fa-tags'],
  ],
  // Welcher Artikel gehört zu welchem Teil (Nummer oder Titel)
  QUELLEN: {
    preise: [/^01$/, /preis/i], moeglich: [/^05$/, /geht|möglich|ampel/i], branchen: [/^06$/, /branche/i],
    einwaende: [/^07$/, /einw/i], faq: [/^08$/, /faq|häufige/i],
  },
  SCHNELL: [['persönliche Beratung', /beratung/i], ['genug Aufträge', /genug/i], ['zu teuer', /teuer/i],
    ['nicht binden', /bind/i], ['KI Unsinn', /\bKI\b|unsinn/i], ['schon Software', /software/i], ['Referenzen', /referenz/i]],
  KANAELE: [['Instagram', /instagram/i], ['Facebook', /facebook/i], ['WhatsApp', /whatsapp/i], ['E-Mail', /e-mail|formular|postfach/i],
    ['Telefon', /telefon|anruf|sms/i], ['Portale', /myhammer|check24|portal/i], ['Software', /lexware|sevdesk|hero|craftnote|plancraft|tooltime|software/i],
    ['Google', /google/i], ['Telegram/TikTok', /telegram|tiktok|line\b/i]],

  tab: 'lead', zu: false, lead: null, artikel: [], referenzen: [], cfg: null, kanal: null, _geladen: 0, _q: '',

  _key() { return 'nf_seite_' + (Auth.getUser()?.id || ''); },
  _merken() { try { localStorage.setItem(this._key(), JSON.stringify({ tab: this.tab, zu: this.zu })); } catch (_) {} },
  _mobil() { return window.matchMedia('(max-width: 1100px)').matches; },

  // Einmal im Anrufmodus einhängen (rechts neben #dlBody)
  einbauen() {
    const dialer = document.getElementById('dialer');
    if (!dialer || document.getElementById('dlSide')) return;
    try { const s = JSON.parse(localStorage.getItem(this._key()) || '{}'); if (s.tab) this.tab = s.tab; this.zu = !!s.zu; } catch (_) {}
    if (this._mobil()) this.zu = true;
    const body = document.getElementById('dlBody');
    const frame = document.createElement('div');
    frame.className = 'dl-frame';
    body.replaceWith(frame);
    frame.appendChild(body);
    frame.insertAdjacentHTML('beforeend', `
      <button class="ds-rail" id="dsRail" onclick="Seite.klappen(false)" title="Seitenpanel öffnen (Alt+0)"><i class="fas fa-book-open"></i><span>Wissen</span></button>
      <aside class="dl-side" id="dlSide" aria-label="Seitenpanel">
        <div class="ds-head">
          <label class="ds-search"><i class="fas fa-search"></i>
            <input type="search" id="dsSuche" placeholder="In allen Tabs suchen, z. B. WhatsApp" autocomplete="off" oninput="Seite.suche(this.value)"><kbd>/</kbd></label>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="Seite.klappen(true)" title="Einklappen (Alt+0)"><i class="fas fa-angle-double-right"></i></button>
        </div>
        <nav class="ds-tabs" id="dsTabs">${this.TABS.map(([k, l, ic], i) =>
          `<button data-t="${k}" onclick="Seite.zeige('${k}')" title="${l} (Alt+${i + 1})"><i class="fas ${ic}"></i><span>${l}</span></button>`).join('')}</nav>
        <div class="ds-hits" id="dsHits" hidden></div>
        <div class="ds-body" id="dsBody"></div>
      </aside>`);
    dialer.classList.toggle('ds-zu', this.zu);
    document.addEventListener('keydown', e => this._taste(e));
  },

  async daten(neu) {
    if (!neu && Date.now() - this._geladen < 5 * 60 * 1000) return;
    const [artikel, referenzen, cfg] = await Promise.all([
      api('GET', '/wiki/artikel').catch(() => []), api('GET', '/wiki/referenzen').catch(() => []),
      typeof Bedarf !== 'undefined' ? Bedarf.config().catch(() => null) : null]);
    this.artikel = artikel; this.referenzen = referenzen; this.cfg = cfg; this._geladen = Date.now();
  },
  _art(teil) {
    const [nr, titel] = this.QUELLEN[teil];
    return this.artikel.find(a => a.kategorie === 'Vertrieb' && nr.test(a.schluessel || ''))
      || this.artikel.find(a => titel.test(a.titel)) || null;
  },
  demoLink() { return this.cfg?.demo_link || 'https://novaflowservices.de/#ausprobieren'; },

  // Beim Öffnen des Anrufmodus und bei jedem neuen Lead
  async setLead(lead) {
    this.einbauen();
    const wechsel = this.lead?.id !== lead?.id;
    this.lead = lead;
    await this.daten();
    if (!wechsel && document.getElementById('dsBody').childElementCount) return;
    if (['lead', 'bedarf'].includes(this.tab) || !document.getElementById('dsBody').childElementCount) this.zeige(this.tab, { still: true });
  },

  klappen(zu) {
    this.zu = zu === undefined ? !this.zu : zu;
    document.getElementById('dialer')?.classList.toggle('ds-zu', this.zu);
    if (!this._mobil()) this._merken();
    if (!this.zu && !document.getElementById('dsBody').childElementCount) this.zeige(this.tab);
  },

  zeige(tab, { still } = {}) {
    if (this.tab === 'bedarf' && tab !== 'bedarf' && typeof Bedarf !== 'undefined') Bedarf.flush();
    this.tab = tab;
    if (!still) this._merken();
    document.querySelectorAll('#dsTabs button').forEach(b => b.classList.toggle('active', b.dataset.t === tab));
    const el = document.getElementById('dsBody');
    el.scrollTop = 0;
    el.innerHTML = this['_' + tab]() || '';
    if (tab === 'lead') this._leadNachladen();
    if (tab === 'bedarf' && this.lead && typeof Bedarf !== 'undefined')
      Bedarf.mount(document.getElementById('dsBedarf'), this.lead.id, { onChange: () => Dialer._bedarfStand(this.lead.id) });
    if (tab === 'preise') this._kanalFilter();
  },

  // ── Tabs ────────────────────────────────────────────────────
  _fehlt(name) {
    return `<div class="ds-leer"><i class="fas fa-book"></i><span>Der Artikel „${name}“ fehlt noch in der Wissensdatenbank (Kategorie „Vertrieb“).
      ${Auth.isAdmin() ? 'Unter Wissensdatenbank → „Artikel importieren“ anlegen.' : 'Aleksandra legt ihn dort an.'}</span></div>`;
  },
  _details(teile, prefix, offen) {
    return teile.map((t, i) => `<details class="ds-item" id="ds-${prefix}-${i}"${offen === i ? ' open' : ''}>
      <summary>${MD.inline(t.titel)}</summary><div class="md-body">${MD.render(t.md)}</div></details>`).join('');
  },

  _demoKnoepfe() {
    return `<div class="ds-demo">
      <a class="btn btn-primary btn-sm" href="${escHtml(this.demoLink())}" target="_blank" rel="noopener"><i class="fas fa-play-circle"></i> Live-Demo öffnen</a>
      <button class="btn btn-ghost btn-sm" onclick="Seite.demoKopieren()"><i class="fas fa-link"></i> Demo-Link kopieren</button></div>`;
  },
  async demoKopieren() {
    const link = this.demoLink();
    try { await navigator.clipboard.writeText(link); }
    catch (_) {
      const t = document.createElement('textarea'); t.value = link; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (_) {} t.remove();
    }
    showToast('Link kopiert');
  },

  _lead() {
    const l = this.lead;
    if (!l) return '<div class="ds-leer"><span>Kein Lead geöffnet.</span></div>';
    const link = (url, icon, txt) => url ? `<a href="${escHtml(absUrl(url))}" target="_blank" rel="noopener"><i class="${icon}"></i>${escHtml(txt || String(url).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : '';
    const art = this._art('branchen');
    let branche = '';
    if (art) {
      const teile = MD.abschnitte(art.inhalt).teile.filter(t => /^branche/i.test(t.titel));
      const ind = String(l.industry || '').toLowerCase();
      // „Branche: Bad, SHK, Fliesen“ passt zu „Badsanierung“, „Fahrzeugaufbereiter“ zu „Fahrzeugaufbereitung“
      const woerter = t => t.titel.replace(/^branche\s*:?\s*/i, '').toLowerCase().split(/[,/&]|\bund\b|\s+/).map(w => w.trim()).filter(w => w.length > 2);
      const stamm = w => w.slice(0, Math.min(6, w.length));
      const passt = ind ? teile.findIndex(t => woerter(t).some(w => ind.includes(stamm(w)) || (ind.length > 3 && w.includes(ind.slice(0, 6))))) : -1;
      branche = teile.length ? `<div class="ds-sub">Branchen-Spickzettel${l.industry ? ` · ${escHtml(l.industry)}` : ''}</div>
        ${this._details(passt >= 0 ? [teile[passt], ...teile.filter((_, i) => i !== passt)] : teile, 'branche', passt >= 0 ? 0 : -1)}` : '';
    }
    return `
      <div id="dsUeb" data-lead="${l.id}"></div>
      <div class="ds-card">
        <div class="ds-card-title">${escHtml(l.company || '—')}</div>
        <div class="ds-links">${link(l.website, 'fas fa-globe') || '<span class="ds-muted"><i class="fas fa-globe"></i>keine Webseite im CRM</span>'}
          ${link(l.instagram_url, 'fab fa-instagram')}</div>
        ${this._demoKnoepfe()}
      </div>
      ${branche || (art ? '' : this._fehlt('Gespräch und Branchen (06)'))}`;
  },
  _leadNachladen() {
    if (this.lead && typeof Termine !== 'undefined') Termine.uebergabeBox(this.lead.id, 'dsUeb');
  },

  _bedarf() {
    return this.lead ? '<div id="dsBedarf" class="ds-bedarf"><div class="bd-loading"><i class="fas fa-spinner fa-spin"></i></div></div>'
      : '<div class="ds-leer"><span>Kein Lead geöffnet.</span></div>';
  },

  _einwaende() {
    const art = this._art('einwaende');
    if (!art) return this._fehlt('Einwände (07)');
    const { vorspann, teile } = MD.abschnitte(art.inhalt);
    const knopf = this.SCHNELL.map(([l, re]) => {
      const i = teile.findIndex(t => re.test(t.titel));
      return i < 0 ? '' : `<button class="qf-btn" onclick="Seite.springe('einwaende', 'einwaende-${i}')">${escHtml(l)}</button>`;
    }).join('');
    // Beim Einwand „Referenzen“ zuerst echte Referenzen aus der Wissensdatenbank
    const mitRef = teile.map(t => (/referenz/i.test(t.titel) && this.referenzen.length)
      ? { ...t, md: this.referenzen.map(r => `**${r.betrieb}**${r.branche ? ` · ${r.branche}` : ''}${r.paket ? ` · ${r.paket}` : ''}\n\n${r.ergebnis || ''}${r.link ? `\n\n[Webseite](${r.link})` : ''}`).join('\n\n---\n\n')
          + `\n\n---\n\n*Standardantwort:* ${t.md}` }
      : t);
    return `${vorspann ? `<div class="ds-intro md-body">${MD.render(vorspann)}</div>` : ''}
      <div class="ds-quick">${knopf}</div>${this._details(mitRef, 'einwaende')}`;
  },

  _faq() {
    const art = this._art('faq');
    if (!art) return this._fehlt('FAQ (08)');
    const { vorspann, teile } = MD.abschnitte(art.inhalt);
    const kunde = teile.filter(t => !/^closer\b/i.test(t.titel)), closer = teile.filter(t => /^closer\b/i.test(t.titel));
    const ohne = t => ({ ...t, titel: t.titel.replace(/^(kunde|closer)\s*:\s*/i, '') });
    return `${vorspann ? `<div class="ds-intro md-body">${MD.render(vorspann)}</div>` : ''}
      ${closer.length ? '<div class="ds-sub">Fragen der Kunden</div>' : ''}${this._details(kunde.map(ohne), 'faq')}
      ${closer.length ? `<div class="ds-sub">Deine Fragen</div>${this._details(closer.map(ohne), 'faqc')}` : ''}`;
  },

  _preise() {
    const p = this._art('preise'), m = this._art('moeglich');
    if (!p && !m) return this._fehlt('Produkte und Preise (01)');
    return `${m ? `<div class="ds-sub">Was geht? Nach Kanal filtern</div>
        <div class="ds-quick" id="dsKanal">${['Alle', ...this.KANAELE.map(k => k[0])].map(k =>
          `<button class="qf-btn${(this.kanal || 'Alle') === k ? ' active' : ''}" onclick="Seite.kanal='${k === 'Alle' ? '' : k}';Seite._kanalFilter()">${k}</button>`).join('')}</div>
        <div class="md-body ds-ampel" id="dsAmpel">${MD.render(m.inhalt.replace(/^\s*#\s.*$/m, ''))}</div>` : ''}
      ${p ? `<div class="ds-sub">Preise</div><div class="md-body ds-preise">${MD.render(p.inhalt.replace(/^\s*#\s.*$/m, ''))}</div>` : ''}`;
  },
  _kanalFilter() {
    const re = (this.KANAELE.find(k => k[0] === this.kanal) || [])[1];
    document.querySelectorAll('#dsKanal .qf-btn').forEach(b => b.classList.toggle('active', b.textContent === (this.kanal || 'Alle')));
    document.querySelectorAll('#dsAmpel tbody tr').forEach(tr => { tr.hidden = !!re && !re.test(tr.textContent); });
  },

  // ── Suche über alle Tabs ────────────────────────────────────
  _index() {
    const eintraege = [];
    const add = (tab, teil, prefix, filter) => {
      const a = this._art(teil);
      if (!a) return;
      MD.abschnitte(a.inhalt).teile.forEach((t, i) => { if (!filter || filter(t)) eintraege.push({ tab, id: `${prefix}-${i}`, titel: t.titel, text: t.md }); });
    };
    add('einwaende', 'einwaende', 'einwaende');
    const faq = this._art('faq');
    if (faq) {
      const teile = MD.abschnitte(faq.inhalt).teile;
      const k = teile.filter(t => !/^closer\b/i.test(t.titel)), c = teile.filter(t => /^closer\b/i.test(t.titel));
      k.forEach((t, i) => eintraege.push({ tab: 'faq', id: `faq-${i}`, titel: t.titel.replace(/^kunde\s*:\s*/i, ''), text: t.md }));
      c.forEach((t, i) => eintraege.push({ tab: 'faq', id: `faqc-${i}`, titel: t.titel.replace(/^closer\s*:\s*/i, ''), text: t.md }));
    }
    add('lead', 'branchen', 'branche', t => /^branche/i.test(t.titel));
    ['moeglich', 'preise'].forEach(teil => {
      const a = this._art(teil);
      if (!a) return;
      a.inhalt.split('\n').filter(z => /^\s*\|/.test(z) && !/^\s*\|?\s*:?-{2,}/.test(z)).forEach(z => {
        const zellen = MD._zellen(z);
        eintraege.push({ tab: 'preise', id: null, titel: zellen[0], text: zellen.slice(1).join(' · ') });
      });
      MD.abschnitte(a.inhalt).teile.forEach(t => eintraege.push({ tab: 'preise', id: null, titel: t.titel, text: t.md.replace(/^\s*\|.*$/gm, '') }));
    });
    return eintraege;
  },
  suche(q) {
    this._q = q.trim().toLowerCase();
    const box = document.getElementById('dsHits');
    if (this._q.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
    const tabName = Object.fromEntries(this.TABS.map(([k, l]) => [k, l]));
    const treffer = this._index().filter(e => (e.titel + ' ' + e.text).toLowerCase().includes(this._q));
    const snip = t => { const s = t.replace(/[#*|_>`]/g, ' ').replace(/\s+/g, ' '); const i = s.toLowerCase().indexOf(this._q);
      return i < 0 ? s.slice(0, 90) : (i > 30 ? '…' : '') + s.slice(Math.max(0, i - 30), i + 70) + '…'; };
    const mark = s => escHtml(s).replace(new RegExp(this._q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
    box.hidden = false;
    box.innerHTML = treffer.length ? `<div class="ds-hits-head">${treffer.length} ${treffer.length === 1 ? 'Treffer' : 'Treffer'} in ${[...new Set(treffer.map(t => tabName[t.tab]))].join(', ')}</div>`
      + treffer.slice(0, 14).map((t, i) => `<button class="ds-hit" onclick="Seite._oeffneTreffer(${i})"><span class="ds-hit-tab">${tabName[t.tab]}</span>
        <b>${mark(t.titel.replace(/\*\*/g, ''))}</b><span>${mark(snip(t.text))}</span></button>`).join('')
      : `<div class="ds-hits-head">Nichts gefunden für „${escHtml(q)}“</div>`;
    this._treffer = treffer;
  },
  _oeffneTreffer(i) {
    const t = this._treffer[i];
    if (!t) return;
    document.getElementById('dsHits').hidden = true;
    if (t.tab === 'preise') {
      this.zeige('preise');
      const ziel = [...document.querySelectorAll('#dsBody tr, #dsBody h2, #dsBody h3, #dsBody p, #dsBody li')].find(x => x.textContent.toLowerCase().includes(this._q));
      if (ziel) { ziel.scrollIntoView({ block: 'center' }); ziel.classList.add('ds-flash'); setTimeout(() => ziel.classList.remove('ds-flash'), 1600); }
      return;
    }
    this.springe(t.tab, t.id);
  },
  springe(tab, id) {
    if (this.tab !== tab) this.zeige(tab);
    const d = document.getElementById('ds-' + id);
    if (!d) return;
    d.open = true;
    d.scrollIntoView({ block: 'start', behavior: 'smooth' });
    d.classList.add('ds-flash'); setTimeout(() => d.classList.remove('ds-flash'), 1600);
  },

  _taste(e) {
    if (!document.getElementById('dialer')?.classList.contains('open')) return;
    if (document.querySelector('.modal-overlay.open:not(#dialer)')) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[0-5]$/.test(e.code)) {
      e.preventDefault();
      const n = parseInt(e.code.slice(5));
      if (n === 0) return this.klappen();
      if (this.zu) this.klappen(false);
      this.zeige(this.TABS[n - 1][0]);
      return;
    }
    const tippt = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === '/' && !tippt && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (this.zu) this.klappen(false);
      document.getElementById('dsSuche')?.focus();
    }
    if (e.key === 'Escape' && e.target.id === 'dsSuche') { e.target.value = ''; this.suche(''); e.target.blur(); }
  },
};
