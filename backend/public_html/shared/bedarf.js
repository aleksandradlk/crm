// ============================================================
// Bedarfsanalyse (Handbuch S. 4, 5, 8, 9)
// Formular mit den 5 Pflichtfragen, Fortschritt, „angebotsreif“,
// Paket-Vorschlag und Knopf „Angebot anfordern“. Speichert automatisch.
// Bedarf.open(leadId) = Fenster · Bedarf.mount(el, leadId) = eingebettet
// (Seitenpanel im Anrufmodus) · Bedarf.kurzCheck(lead, opts) = „Keine Zeit“.
// Regeln: shared/bedarf-regeln.js (gleich wie auf dem Server).
// ============================================================
const Bedarf = {
  cfg: null, leadId: null, lead: null, data: {}, info: null, el: null,
  _timer: null, _saving: null, _dirty: false, _opts: {},
  R: () => window.BedarfRegeln,

  async config() {
    if (!this.cfg) this.cfg = await api('GET', '/bedarf/config').catch(() => this.R().cfgMit({}));
    return this.cfg;
  },

  // ── Öffnen ───────────────────────────────────────────────────
  async open(leadId, opts = {}) {
    await this.flush();
    document.getElementById('bdModal')?.remove();
    const o = document.createElement('div');
    o.id = 'bdModal';
    o.className = 'modal-overlay open bd-overlay';
    o.onclick = e => { if (e.target === o) this.close(); };
    o.innerHTML = `<div class="bd-sheet" role="dialog">
      <div class="bd-sheet-head">
        <div class="modal-heading"><div class="modal-icon"><i class="fas fa-clipboard-list"></i></div>
          <div style="min-width:0"><div class="modal-title">Bedarfsanalyse</div><div class="modal-subtitle" id="bdSub"></div></div></div>
        <span class="bd-saved" id="bdSaved"></span>
        <button class="modal-x" onclick="Bedarf.close()" title="Schließen"><i class="fas fa-times"></i></button>
      </div>
      <div class="bd-sheet-body" id="bdRoot"><div class="bd-loading"><i class="fas fa-spinner fa-spin"></i></div></div>
    </div>`;
    document.body.appendChild(o);
    await this.mount(document.getElementById('bdRoot'), leadId, opts);
  },
  async close() {
    await this.flush();
    document.getElementById('bdModal')?.remove();
    if (typeof this._opts.onClose === 'function') this._opts.onClose(this.info);
  },

  async mount(el, leadId, opts = {}) {
    await this.flush();
    this.el = el; this.leadId = leadId; this._opts = opts;
    try {
      await this.config();
      const r = await api('GET', `/bedarf/lead/${leadId}`);
      if (this.leadId !== leadId) return;
      this.lead = r.lead; this.data = r.data || {}; this.info = r;
      const sub = document.getElementById('bdSub');
      if (sub) sub.textContent = [r.lead.company, r.lead.ceo].filter(Boolean).join(' · ');
      this.render();
    } catch (e) {
      el.innerHTML = `<div class="bd-loading" style="color:var(--red)">${escHtml(e.message)}</div>`;
    }
  },

  // ── Auswertung (live, gleiche Regeln wie der Server) ────────
  _calc() {
    const d = { ...this.data, _industry: this.lead?.industry || '' };
    return { p: this.R().pruefen(d, this.cfg), v: this.R().vorschlag(d, this.cfg), wert: this.R().dealWert(d, this.cfg) };
  },

  // ── Darstellung ─────────────────────────────────────────────
  render() {
    const R = this.R(), d = this.data;
    const W = R.W;
    const chips = (f, liste, multi = false, attrs = {}) => `<div class="bd-chips" data-f="${f}" data-multi="${multi ? 1 : 0}">${liste.map(([k, l]) => {
      const on = multi ? (d[f] || []).includes(k) : d[f] === k;
      const dis = attrs.disabled && attrs.disabled(k);
      return `<button type="button" class="qf-btn${on ? ' active' : ''}" data-v="${escHtml(k)}" ${dis ? 'disabled title="' + escHtml(dis) + '"' : ''}>${escHtml(l)}</button>`;
    }).join('')}</div>`;
    const inp = (f, type = 'text', ph = '', extra = '') => `<input type="${type}" class="form-control" data-f="${f}" value="${escHtml(d[f] ?? '')}" placeholder="${escHtml(ph)}" ${extra}>`;
    const area = (f, ph = '', rows = 2) => `<textarea class="form-control" data-f="${f}" rows="${rows}" placeholder="${escHtml(ph)}">${escHtml(d[f] ?? '')}</textarea>`;
    const url = (f, ph) => `<div class="bd-url">${inp(f, 'text', ph)}<a class="btn btn-ghost btn-sm btn-icon" data-link="${f}" target="_blank" rel="noopener" title="Öffnen" ${d[f] ? `href="${escHtml(absUrl(d[f]))}"` : 'hidden'}><i class="fas fa-external-link-alt"></i></a></div>`;
    const row = (label, html, cls = '') => `<div class="bd-row ${cls}"><label>${label}</label><div>${html}</div></div>`;
    const sec = (nr, titel, pflicht, html, id) => `<section class="bd-sec" ${id ? `id="${id}"` : ''}>
      <h4>${nr ? `<span class="bd-nr">${nr}</span>` : ''}${titel}${pflicht ? ' <span class="bd-star" title="Pflichtfrage">★</span>' : ''}<span class="bd-ok" data-ok="${nr || ''}"></span></h4>${html}</section>`;
    const kanalOpts = W.kanaele.filter(([k]) => (d.kanaele || []).includes(k));

    this.el.innerHTML = `
      <div class="bd-top" id="bdTop"></div>
      ${sec('', 'Betrieb', false, `
        ${row('Ansprechpartner', inp('ansprechpartner_rolle', 'text', 'Rolle, z. B. Inhaber'))}
        ${row('Branche', chips('branche', W.branche) + `<div data-show="branche_text" ${d.branche === 'andere' ? '' : 'hidden'}>${inp('branche_text', 'text', 'Welche Branche?')}</div>`)}
        <div id="bdGesund"></div>
        ${row('E-Mail fürs Angebot', inp('email_angebot', 'email', 'name@betrieb.de'))}
        ${row('Webseite', url('webseite', 'betrieb.de'))}
        ${row('Instagram', url('instagram', 'instagram.com/…'))}
        ${row('Teamgröße', chips('teamgroesse', W.teamgroesse))}
        ${row('Büro vorhanden', chips('buero_vorhanden', W.janein))}`)}
      ${sec(1, 'Kanäle', true, `
        ${row('Wo kommen Anfragen rein?', chips('kanaele', W.kanaele, true))}
        ${row('Wichtigster Kanal', `<div id="bdWichtig">${kanalOpts.length ? chips('kanal_wichtigster', kanalOpts) : '<span class="bd-hint">Erst Kanäle wählen</span>'}</div>`)}
        ${row('Instagram Business', chips('instagram_business', W.instagram_business))}
        ${row('WhatsApp Firmennummer', chips('whatsapp_firmennummer', W.whatsapp_firmennummer))}`)}
      ${sec(2, 'Menge', true, `
        ${row('Anfragen pro Woche', inp('anfragen_pro_woche', 'number', 'z. B. 8', 'min="0" inputmode="numeric"'))}
        ${row('Davon unpassend', inp('anfragen_unpassend', 'text', 'Zahl oder %'))}
        ${row('Auftragswert im Schnitt', `<div class="bd-eur">${inp('auftragswert_schnitt', 'number', 'z. B. 1500', 'min="0" inputmode="numeric"')}<span>€</span></div>`)}`)}
      ${sec(3, 'Ablauf heute', true, `
        ${row('Wer antwortet, und wann?', area('ablauf_heute', 'Wer antwortet, und wann? z. B. Inhaber selbst, abends'))}
        ${row('Antwortzeit', chips('antwortzeit', W.antwortzeit))}
        ${row('Was fragt er nach?', chips('nachfragen', W.nachfragen, true))}
        ${row('Besichtigungen', inp('besichtigungen', 'text', 'pro Woche, wie viele werden zum Auftrag'))}`)}
      ${sec(4, 'Größter Zeitfresser', true, `
        ${row('Größtes Problem', area('groesstes_problem', 'Wörtlich mitschreiben, z. B. „Ich sitz jeden Abend eine Stunde am Handy“', 3))}
        ${row('Was soll zuerst weg?', chips('zuerst_weg', W.zuerst_weg, true))}`)}
      ${sec(5, 'Rahmen', true, `
        ${row('Wunschstart', inp('wunschstart', 'text', 'z. B. vor Saisonstart März'))}
        ${row('Entscheider', chips('entscheider', W.entscheider) + `<div data-show="entscheider_text" ${d.entscheider === 'anderer' ? '' : 'hidden'}>${inp('entscheider_text', 'text', 'Wer entscheidet mit?')}</div>`)}`)}
      ${sec('', 'Technik', false, `
        ${row('Software', inp('software', 'text', 'Lexware Office, HERO, sevDesk, Excel, keine …'))}
        ${row('Kalender', chips('kalender', W.kalender))}
        ${row('Webseite', chips('webseite_status', W.webseite_status))}
        ${row('Google-Profil', chips('google_profil', W.google_profil))}`)}
      ${sec('', 'Ergebnis', false, `
        <div id="bdVorschlag"></div>
        ${row('Paket <span class="bd-star">★</span>', chips('paket_empfohlen', W.paket_empfohlen))}
        ${row('Zusatzleistungen', chips('zusatzleistungen', W.zusatzleistungen, true))}
        ${row('Preis genannt? <span class="bd-star">★</span>', chips('preis_genannt', W.janein))}
        ${row('Reaktion auf den Preis', chips('reaktion_preis', W.reaktion_preis))}
        ${row('Rabatt', `<div class="bd-eur">${inp('rabatt_prozent', 'number', '0', 'min="0" max="100" inputmode="numeric"')}<span>%</span></div><div id="bdRabatt"></div>
          <div data-show="rabatt_begruendung" hidden>${area('rabatt_begruendung', 'Warum mehr Rabatt? (Pflicht)')}</div>`)}
        ${row('Gratismonat', chips('gratismonat', W.janein) + '<div class="bd-hint">höchstens 1 Monat</div>')}
        ${row('Zahlungswunsch', `<div id="bdZahlung"></div>`)}
        ${row('Sonderwünsche', area('sonderwuensche', 'Alles, was nicht im Handbuch steht'))}
        ${row('Nachfass-Termin <span class="bd-star">★</span>', `<input type="datetime-local" class="form-control" data-f="nachfass_termin">` + '<div class="bd-hint">Legt automatisch eine Erinnerung für dich an.</div>')}`, 'bdErgebnis')}
      <div class="bd-foot" id="bdFoot"></div>`;

    // datetime-local braucht „YYYY-MM-DDTHH:MM“
    const nf = this.el.querySelector('[data-f="nachfass_termin"]');
    if (nf) nf.value = String(d.nachfass_termin || '').replace(' ', 'T').slice(0, 16);

    this.el.querySelectorAll('input[data-f], textarea[data-f]').forEach(i => i.addEventListener('input', () => this._feld(i)));
    this.el.querySelectorAll('.bd-chips').forEach(c => c.addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (b && !b.disabled) this._chip(c.dataset.f, b.dataset.v, c.dataset.multi === '1');
    }));
    this._update();
  },

  // Teile, die sich mit den Antworten ändern
  _update() {
    const { p, v, wert } = this._calc();
    const R = this.R(), d = this.data, cfg = this.cfg;
    const top = this.el.querySelector('#bdTop');
    const pct = Math.round(p.fragen_ok / p.fragen_gesamt * 100);
    top.innerHTML = `
      <div class="bd-progress">
        <div class="bd-progress-text"><b>${p.fragen_ok} von ${p.fragen_gesamt}</b> Pflichtfragen
          ${p.angebotsreif ? '<span class="bd-reif"><i class="fas fa-check-circle"></i> angebotsreif</span>' : ''}</div>
        <div class="zl-bar"><div style="width:${pct}%" class="${p.angebotsreif ? 'is-done' : ''}"></div></div>
        <div class="bd-steps">${p.fragen.map(f => `<button type="button" class="bd-step ${f.ok ? 'ok' : ''}" onclick="Bedarf._springe(${f.nr})">${f.ok ? '<i class="fas fa-check"></i>' : `<em>${f.nr}</em>`}<span>${escHtml(f.titel)}</span></button>`).join('')}</div>
        ${p.fehlt.length && !p.angebotsreif ? `<div class="bd-fehlt-line"><b>Es fehlt noch:</b> ${p.fehlt.map(escHtml).join(' · ')}</div>` : ''}
      </div>`;
    this.el.querySelectorAll('.bd-ok[data-ok]').forEach(s => {
      const f = p.fragen.find(x => String(x.nr) === s.dataset.ok);
      s.innerHTML = f && f.ok ? '<i class="fas fa-check-circle"></i>' : '';
    });

    // Gesundheitsbranche
    this.el.querySelector('#bdGesund').innerHTML = p.gesundheit
      ? `<div class="bd-warn is-red"><i class="fas fa-ban"></i><span><b>Gesundheitsbranche nehmen wir aktuell nicht an.</b> Freundlich absagen und den Lead als „passt nicht“ markieren.</span>
          <button type="button" class="btn btn-ghost btn-sm" style="margin-left:auto;white-space:nowrap" onclick="Bedarf.passtNicht()">Als „passt nicht“ markieren</button></div>` : '';

    // Paket-Vorschlag
    const gewaehlt = d.paket_empfohlen;
    this.el.querySelector('#bdVorschlag').innerHTML = `
      <div class="bd-vorschlag">
        <div class="bd-v-head"><span>Vorschlag: <b>${escHtml(v.name)}</b></span>
          ${gewaehlt === v.paket ? '<span class="bd-v-ok"><i class="fas fa-check"></i> übernommen</span>' : `<button type="button" class="btn btn-primary btn-sm" onclick="Bedarf.uebernehmen()">Übernehmen</button>`}</div>
        <div class="bd-v-grund">${escHtml(v.grund)}</div>
        <div class="bd-v-preise">
          <div><span>Einrichtung</span><b>${v.ab ? 'ab ' : ''}${R.eur(v.einrichtung)}</b></div>
          <div><span>Betreuung</span><b>${R.eur(v.betreuung)}/Monat</b></div>
          <div><span>1. Jahr pro Monat</span><b>ca. ${R.eur(v.monat_erstes_jahr)}</b></div>
        </div>
        ${v.hinweise.length ? `<ul class="bd-v-hinweise">${v.hinweise.map(h => `<li>${escHtml(h)}</li>`).join('')}</ul>` : ''}
      </div>`;

    // Rabatt
    const rabatt = Number(d.rabatt_prozent) || 0;
    this.el.querySelector('#bdRabatt').innerHTML = p.rabatt_hoch
      ? `<div class="bd-warn"><i class="fas fa-exclamation-triangle"></i><span>Mehr als ${cfg.rabatt_grenze} % nur mit E-Mail-Zustimmung von Aleksandra. Begründung ist Pflicht, der Deal wird markiert.</span></div>` : '';
    const rb = this.el.querySelector('[data-show="rabatt_begruendung"]');
    if (rb) rb.hidden = !(rabatt > cfg.rabatt_grenze);

    // Zahlungswunsch: Raten erst ab S
    const qw = gewaehlt === 'quickwin';
    const z = this.el.querySelector('#bdZahlung');
    z.innerHTML = `<div class="bd-chips" data-f="zahlungswunsch" data-multi="0">${R.W.zahlungswunsch.map(([k, l]) => {
      const dis = qw && /^raten/.test(k);
      return `<button type="button" class="qf-btn${d.zahlungswunsch === k ? ' active' : ''}" data-v="${k}" ${dis ? 'disabled title="Raten erst ab Autopilot S"' : ''}>${escHtml(l)}</button>`;
    }).join('')}</div>${qw ? '<div class="bd-hint">Raten erst ab Autopilot S</div>' : ''}`;
    z.querySelector('.bd-chips').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (b && !b.disabled) this._chip('zahlungswunsch', b.dataset.v, false);
    });

    // Fuß: Wert + Angebot anfordern
    const angefordert = this.info?.angefordert_am;
    const tip = p.angebotsreif ? '' : 'Es fehlt noch: ' + p.fehlt.join(', ');
    this.el.querySelector('#bdFoot').innerHTML = `
      <div class="bd-foot-info">${d.paket_empfohlen ? `Deal-Wert: <b>${R.eur(wert)}</b>` : 'Paket wählen, dann steht der Deal-Wert hier'}
        ${angefordert ? `<span class="bd-hint">· zuletzt angefordert ${escHtml(fmtDate(angefordert))}</span>` : ''}</div>
      <span class="bd-anfordern-wrap" title="${escHtml(tip)}">
        <button type="button" class="btn btn-primary bd-anfordern" ${p.angebotsreif ? '' : 'disabled'} onclick="Bedarf.anfordern()">
          <i class="fas fa-file-signature"></i> Angebot anfordern</button></span>`;
  },

  async passtNicht() {
    try {
      await statusSetzen(this.leadId, 'passt_nicht', { grund: 'Gesundheitsbranche', grund_text: this.data.branche_text || '' });
      showToast('Lead als „passt nicht“ markiert (Gesundheitsbranche)');
      this.close();
    } catch (e) { showToast(e.message, 'err'); }
  },

  _springe(nr) {
    const s = [...this.el.querySelectorAll('.bd-sec')].find(x => x.querySelector(`.bd-nr`)?.textContent === String(nr));
    s?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    s?.querySelector('input, textarea, button')?.focus({ preventScroll: true });
  },

  // ── Eingaben ────────────────────────────────────────────────
  _feld(i) {
    const f = i.dataset.f;
    let v = i.value;
    if (f === 'nachfass_termin') v = v ? v.replace('T', ' ') : '';
    if (v === '') delete this.data[f]; else this.data[f] = v;
    if (i.closest('.bd-url')) {
      const a = this.el.querySelector(`[data-link="${f}"]`);
      if (a) { a.hidden = !v; if (v) a.href = absUrl(v); }
    }
    this._geaendert();
  },
  _chip(f, v, multi) {
    const d = this.data;
    if (multi) {
      const set = new Set(d[f] || []);
      set.has(v) ? set.delete(v) : set.add(v);
      d[f] = [...set];
      if (!d[f].length) delete d[f];
      if (f === 'kanaele' && d.kanal_wichtigster && !(d.kanaele || []).includes(d.kanal_wichtigster)) delete d.kanal_wichtigster;
      if (f === 'kanaele' && (d.kanaele || []).length === 1) d.kanal_wichtigster = d.kanaele[0];
    } else {
      if (d[f] === v) delete d[f]; else d[f] = v;
      if (f === 'paket_empfohlen' && v === 'quickwin' && /^raten/.test(d.zahlungswunsch || '')) delete d.zahlungswunsch;
    }
    // Gewählte Chips neu zeichnen, abhängige Felder ein-/ausblenden
    const box = this.el.querySelector(`.bd-chips[data-f="${f}"]`);
    box?.querySelectorAll('button[data-v]').forEach(b => b.classList.toggle('active', multi ? (d[f] || []).includes(b.dataset.v) : d[f] === b.dataset.v));
    if (f === 'kanaele') {
      const W = this.R().W.kanaele.filter(([k]) => (d.kanaele || []).includes(k));
      const w = this.el.querySelector('#bdWichtig');
      w.innerHTML = W.length ? `<div class="bd-chips" data-f="kanal_wichtigster" data-multi="0">${W.map(([k, l]) =>
        `<button type="button" class="qf-btn${d.kanal_wichtigster === k ? ' active' : ''}" data-v="${k}">${escHtml(l)}</button>`).join('')}</div>` : '<span class="bd-hint">Erst Kanäle wählen</span>';
      w.querySelector('.bd-chips')?.addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) this._chip('kanal_wichtigster', b.dataset.v, false); });
    }
    const show = (k, on) => { const x = this.el.querySelector(`[data-show="${k}"]`); if (x) x.hidden = !on; };
    if (f === 'branche') show('branche_text', d.branche === 'andere');
    if (f === 'entscheider') show('entscheider_text', d.entscheider === 'anderer');
    this._geaendert();
  },
  uebernehmen() {
    const { v } = this._calc();
    this.data.paket_empfohlen = v.paket;
    if (v.paket === 'quickwin' && /^raten/.test(this.data.zahlungswunsch || '')) delete this.data.zahlungswunsch;
    this.el.querySelectorAll('.bd-chips[data-f="paket_empfohlen"] button').forEach(b => b.classList.toggle('active', b.dataset.v === v.paket));
    this._geaendert();
  },

  // ── Speichern (verzögert) ───────────────────────────────────
  _geaendert() {
    this._dirty = true;
    this._status('…');
    this._update();
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 800);
  },
  _status(t) { const s = document.getElementById('bdSaved') || this.el?.querySelector('.bd-saved'); if (s) s.textContent = t; },
  async flush() {
    clearTimeout(this._timer);
    if (this._saving) await this._saving;
    if (!this._dirty || !this.leadId) return;
    this._dirty = false;
    const leadId = this.leadId, data = { ...this.data };
    this._saving = api('PUT', `/bedarf/lead/${leadId}`, { data })
      .then(r => { if (this.leadId === leadId) { this.info = { ...this.info, ...r }; this._status('Gespeichert ✓'); } })
      .catch(e => { this._dirty = true; this._status('Nicht gespeichert'); showToast('Bedarfsanalyse: ' + e.message, 'err'); })
      .finally(() => { this._saving = null; });
    return this._saving;
  },
  // Beim Schließen des Tabs: letzte Änderung noch rausschicken
  _beacon() {
    if (!this._dirty || !this.leadId) return;
    try {
      fetch(`/api/bedarf/lead/${this.leadId}`, { method: 'PUT', keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Auth.getToken() },
        body: JSON.stringify({ data: this.data }) });
      this._dirty = false;
    } catch (_) {}
  },

  // ── Angebot anfordern ───────────────────────────────────────
  async anfordern() {
    await this.flush();
    const btn = this.el.querySelector('.bd-anfordern');
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', `/bedarf/lead/${this.leadId}/anfordern`);
      this.info = { ...this.info, angefordert_am: new Date().toISOString() };
      this._update();
      this._erfolg(r.message);
      if (typeof this._opts.onChange === 'function') this._opts.onChange(r);
      if (typeof Deals !== 'undefined' && Deals._loaded) Deals.load?.();
    } catch (e) {
      if (btn) btn.disabled = false;
      showToast(e.data?.fehlt ? 'Es fehlt noch: ' + e.data.fehlt.join(', ') : e.message, 'err');
    }
  },
  _erfolg(text) {
    const box = document.createElement('div');
    box.className = 'bd-done';
    box.innerHTML = `<i class="fas fa-check-circle"></i><div><b>Angebot angefordert.</b><span>${escHtml(text.replace(/^Angebot angefordert\.\s*/, ''))}</span></div>`;
    this.el.querySelector('#bdFoot')?.before(box);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showToast('Angebot angefordert ✓');
  },

  // ── „Keine Zeit: Kurz-Check“ ────────────────────────────────
  // opts.onSaved(rueckrufDate, vorschlag) – im Anrufmodus legt das Ergebnis den Rückruf an
  async kurzCheck(lead, opts = {}) {
    await this.config();
    const R = this.R();
    const vorher = await api('GET', `/bedarf/lead/${lead.id}`).then(r => r.data).catch(() => ({}));
    const sel = new Set(vorher.kanaele || []);
    const morgen = (h) => { const x = new Date(); x.setDate(x.getDate() + 1); while ([0, 6].includes(x.getDay())) x.setDate(x.getDate() + 1); x.setHours(h, 0, 0, 0); return x; };
    const toInput = x => { const p = n => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`; };
    document.getElementById('kcModal')?.remove();
    const o = document.createElement('div');
    o.id = 'kcModal'; o.className = 'modal-overlay open'; o.style.zIndex = 980;
    o.onclick = e => { if (e.target === o) o.remove(); };
    o.innerHTML = `<div class="modal modal-flex" style="max-width:520px">
      <div class="modal-header"><div class="modal-heading"><div class="modal-icon copper"><i class="fas fa-bolt"></i></div>
        <div><div class="modal-title">Keine Zeit: Kurz-Check</div><div class="modal-subtitle">${escHtml(lead.company || '')} · 3 Fragen, dann Rückruf</div></div></div>
        <button class="modal-x" onclick="document.getElementById('kcModal').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        <div class="form-group" style="margin:0"><label>1. Wo kommen Anfragen rein?</label>
          <div class="bd-chips" id="kcKanaele">${R.W.kanaele.map(([k, l]) => `<button type="button" class="qf-btn${sel.has(k) ? ' active' : ''}" data-v="${k}">${escHtml(l)}</button>`).join('')}</div></div>
        <div class="form-group" style="margin:0"><label>2. Wie viele Anfragen pro Woche?</label>
          <input type="number" id="kcAnfragen" class="form-control" min="0" inputmode="numeric" value="${escHtml(vorher.anfragen_pro_woche ?? '')}" placeholder="z. B. 8"></div>
        <div class="form-group" style="margin:0"><label>3. Was nervt am meisten?</label>
          <textarea id="kcProblem" class="form-control" rows="2" placeholder="Wörtlich mitschreiben">${escHtml(vorher.groesstes_problem || '')}</textarea></div>
        <div class="form-group" style="margin:0"><label>Rückruf <span class="bd-star">★</span></label>
          <div class="dl-chips">
            <button type="button" class="qf-btn" data-at="${toInput(morgen(10))}">Morgen 10 Uhr</button>
            <button type="button" class="qf-btn" data-at="${toInput(morgen(17))}">Morgen 17 Uhr</button>
          </div>
          <input type="datetime-local" id="kcAt" class="form-control"></div>
        <div id="kcVorschlag"></div>
        <div class="tr-err" id="kcErr"></div>
        <div class="modal-actions"><button class="btn btn-ghost btn-sm" onclick="document.getElementById('kcModal').remove()">Abbrechen</button>
          <button class="btn btn-primary btn-sm" id="kcSave"><i class="fas fa-check"></i> Speichern${opts.imAnrufmodus ? ' &amp; nächster Lead' : ''}</button></div>
      </div></div>`;
    document.body.appendChild(o);
    const live = () => {
      const v = R.vorschlag({ ...vorher, kanaele: [...sel], anfragen_pro_woche: o.querySelector('#kcAnfragen').value, groesstes_problem: o.querySelector('#kcProblem').value }, this.cfg);
      o.querySelector('#kcVorschlag').innerHTML = `<div class="bd-v-mini">Vorschlag: <b>${escHtml(v.name)}</b> · ${R.eur(v.einrichtung)} + ${R.eur(v.betreuung)}/Monat</div>`;
    };
    o.querySelector('#kcKanaele').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      sel.has(b.dataset.v) ? sel.delete(b.dataset.v) : sel.add(b.dataset.v);
      b.classList.toggle('active', sel.has(b.dataset.v)); live();
    });
    o.querySelectorAll('[data-at]').forEach(b => b.onclick = () => {
      o.querySelector('#kcAt').value = b.dataset.at;
      o.querySelectorAll('[data-at]').forEach(x => x.classList.toggle('active', x === b));
    });
    o.querySelector('#kcAnfragen').oninput = live;
    o.querySelector('#kcProblem').oninput = live;
    live();
    o.querySelector('#kcSave').onclick = async () => {
      const at = o.querySelector('#kcAt').value;
      if (!at) { o.querySelector('#kcErr').textContent = 'Wann rufst du zurück?'; return; }
      const btn = o.querySelector('#kcSave'); btn.disabled = true;
      try {
        const r = await api('POST', `/bedarf/lead/${lead.id}/kurzcheck`, {
          kanaele: [...sel], anfragen_pro_woche: o.querySelector('#kcAnfragen').value,
          groesstes_problem: o.querySelector('#kcProblem').value, rueckruf_at: at.replace('T', ' '),
          reminder: !opts.imAnrufmodus,
        });
        o.remove();
        if (typeof opts.onSaved === 'function') opts.onSaved(new Date(at), r.vorschlag);
        else showToast(`Kurz-Check gespeichert · Vorschlag ${r.vorschlag.name} · Rückruf eingetragen`);
      } catch (e) { btn.disabled = false; o.querySelector('#kcErr').textContent = e.message; }
    };
    setTimeout(() => o.querySelector('#kcAnfragen').focus(), 50);
  },

  // Kurzer Stand für Listen/Anrufmodus: „3/5 · Vorschlag M“
  async stand(leadId) {
    try {
      const r = await api('GET', `/bedarf/lead/${leadId}`);
      if (!r.id) return null;
      return { fragen_ok: r.pruefung.fragen_ok, gesamt: r.pruefung.fragen_gesamt, reif: r.pruefung.angebotsreif, paket: r.vorschlag.name,
        angefordert: r.angefordert_am };
    } catch (_) { return null; }
  },

  // ── Vertriebsregeln (Admin): Preise, Grenzen, Links ─────────
  async openRegeln() {
    this.cfg = null;
    const c = await this.config();
    const R = this.R();
    const pk = Object.entries(c.pakete), zs = Object.entries(c.zusatz);
    document.getElementById('vrModal')?.remove();
    const o = document.createElement('div');
    o.id = 'vrModal'; o.className = 'modal-overlay open'; o.style.zIndex = 990;
    o.onclick = e => { if (e.target === o) o.remove(); };
    const num = (id, v, w = 90) => `<input type="number" min="0" class="form-control" id="${id}" value="${escHtml(v)}" style="width:${w}px">`;
    o.innerHTML = `<div class="modal modal-flex" style="max-width:640px">
      <div class="modal-header"><div class="modal-heading"><div class="modal-icon"><i class="fas fa-sliders-h"></i></div>
        <div><div class="modal-title">Vertriebsregeln</div><div class="modal-subtitle">Preise, Grenzen und Fristen für Bedarfsanalyse und Angebote</div></div></div>
        <button class="modal-x" onclick="document.getElementById('vrModal').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        <div class="tr-sub">Pakete (netto)</div>
        <table class="vr-table"><tr><th></th><th>Einrichtung €</th><th>Betreuung €/Monat</th></tr>
          ${pk.map(([k, p]) => `<tr><td>${escHtml(p.name)}</td><td>${num('vr-p-' + k + '-e', p.einrichtung)}</td><td>${num('vr-p-' + k + '-b', p.betreuung)}</td></tr>`).join('')}
          ${zs.filter(([k]) => k !== 'automation').map(([k, p]) => `<tr><td>${escHtml(p.name)}</td><td>${num('vr-z-' + k + '-e', p.einrichtung)}</td><td>${num('vr-z-' + k + '-b', p.betreuung)}</td></tr>`).join('')}
        </table>
        <div class="tr-sub">Regeln</div>
        <div class="vr-grid">
          <label>Rabatt ohne Zustimmung bis</label><div>${num('vr-rabatt', c.rabatt_grenze, 70)} %</div>
          <label>Paket L ab Auftragswert</label><div>${num('vr-l-wert', c.regeln.l_auftragswert)} €</div>
          <label>Paket M ab … Kanälen</label><div>${num('vr-m-kan', c.regeln.m_kanaele, 70)}</div>
          <label>Paket M ab … Anfragen/Woche</label><div>${num('vr-m-anf', c.regeln.m_anfragen, 70)}</div>
          <label>Nachfassen nach dem Angebot (Tage)</label><div><input class="form-control" id="vr-tage" value="${escHtml((c.nachfass_tage || []).join(', '))}" style="width:140px"></div>
          <label>Hinweis, wenn Anfrage wartet seit</label><div>${num('vr-std', c.anfrage_warte_std, 70)} Std.</div>
          <label>Anfragen per E-Mail an</label><div><input class="form-control" id="vr-mail" type="email" value="${escHtml(c.admin_mail)}"></div>
          <label>Morgens um 7:41 eine Mail mit allem, was fällig ist</label><div><label class="vr-inline"><input type="checkbox" id="vr-faellig" ${c.faellig_mail !== false ? 'checked' : ''}> an diese Adresse schicken</label></div>
          <label>Live-Demo-Link</label><div><input class="form-control" id="vr-demo" value="${escHtml(c.demo_link)}"></div>
          <label>Gesundheitsbranche erkennen an</label><div><textarea class="form-control" id="vr-gesund" rows="2">${escHtml((c.gesundheit || []).join(', '))}</textarea></div>
        </div>
        <div class="tr-sub">Provision &amp; Bonus</div>
        <div class="vr-grid">
          <label>Provision vom Einmalpreis</label><div>${num('vr-pv-satz', c.provision.satz, 70)} %</div>
          <label>Provision mit Rabatt (vom reduzierten Preis)</label><div>${num('vr-pv-rabatt', c.provision.satz_rabatt, 70)} %</div>
          <label>Quick-Win-Upgrade zählt innerhalb von</label><div>${num('vr-pv-upgrade', c.provision.upgrade_tage, 70)} Tagen</div>
          <label>Provision fällig nach Zahlungseingang</label><div>${num('vr-pv-faellig', c.provision.faellig_tage, 70)} Tage</div>
          <label>USt-Aufschlag (wenn am Closer eingestellt)</label><div>${num('vr-pv-ust', c.provision.ust, 70)} %</div>
          <label>Bonus zählt bei</label><div class="vr-checks">${pk.filter(([k]) => k !== 'quickwin').map(([k, p]) =>
            `<label><input type="checkbox" class="vr-pv-paket" value="${k}"${c.provision.bonus_pakete.includes(k) ? ' checked' : ''}> ${escHtml(p.name)}</label>`).join('')}</div>
          <label>Bonus für den allerersten bezahlten Abschluss (einmalig)</label><div>${num('vr-pv-erster', c.provision.bonus_erster ?? 50, 70)} €</div>
          <label>Bonus pro Monat (ab Abschlüssen → €)</label><div><input class="form-control" id="vr-pv-bonus" value="${escHtml(c.provision.bonus.filter(b => b.ab > 1).map(b => `${b.ab}:${b.betrag}`).join(', '))}" style="width:200px" placeholder="5:150, 10:300"></div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" id="vrReset">Standard wiederherstellen</button>
          <button class="btn btn-primary btn-sm" id="vrSave"><i class="fas fa-check"></i> Speichern</button></div>
      </div></div>`;
    document.body.appendChild(o);
    const val = id => Number(o.querySelector('#' + id).value) || 0;
    const speichern = async wert => {
      try {
        await api('PATCH', '/settings/vertrieb_regeln', { value: JSON.stringify(wert) });
        this.cfg = null; o.remove(); showToast('Vertriebsregeln gespeichert ✓');
      } catch (e) { showToast(e.message, 'err'); }
    };
    o.querySelector('#vrReset').onclick = () => { if (confirm('Alle Vertriebsregeln auf Standard zurücksetzen?')) speichern({}); };
    o.querySelector('#vrSave').onclick = () => {
      const pakete = {}, zusatz = {};
      const stufen = o.querySelector('#vr-pv-bonus').value.split(/[,;]+/).map(t => t.split(/[:=→]/).map(x => Number(String(x).replace(/[^\d.]/g, ''))))
        .filter(([ab, b]) => ab > 1 && b >= 0).map(([ab, betrag]) => ({ ab, betrag }));
      pk.forEach(([k, p]) => { pakete[k] = { ...p, einrichtung: val(`vr-p-${k}-e`), betreuung: val(`vr-p-${k}-b`) }; });
      zs.forEach(([k, p]) => { zusatz[k] = k === 'automation' ? p : { ...p, einrichtung: val(`vr-z-${k}-e`), betreuung: val(`vr-z-${k}-b`) }; });
      speichern({
        pakete, zusatz, rabatt_grenze: val('vr-rabatt'),
        regeln: { l_auftragswert: val('vr-l-wert'), m_kanaele: val('vr-m-kan'), m_anfragen: val('vr-m-anf') },
        nachfass_tage: o.querySelector('#vr-tage').value.split(/[,; ]+/).map(Number).filter(n => n > 0),
        anfrage_warte_std: val('vr-std') || 24,
        admin_mail: o.querySelector('#vr-mail').value.trim() || R.STANDARD.admin_mail,
        faellig_mail: o.querySelector('#vr-faellig').checked,
        demo_link: o.querySelector('#vr-demo').value.trim() || R.STANDARD.demo_link,
        gesundheit: o.querySelector('#vr-gesund').value.split(',').map(s => s.trim()).filter(Boolean),
        provision: {
          satz: val('vr-pv-satz'), satz_rabatt: val('vr-pv-rabatt'), upgrade_tage: val('vr-pv-upgrade'),
          faellig_tage: val('vr-pv-faellig'), ust: val('vr-pv-ust'), bonus_erster: val('vr-pv-erster'),
          bonus_pakete: [...o.querySelectorAll('.vr-pv-paket:checked')].map(x => x.value),
          bonus: stufen.length ? stufen : R.STANDARD.provision.bonus,
        },
      });
    };
  },
};
window.addEventListener('pagehide', () => Bedarf._beacon());
