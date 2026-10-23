// ============================================================
// Telefonnummern je Mitarbeiter (nur Admin): Nummern aus dem Twilio-Konto
// zuteilen oder direkt eine neue holen. Eingebunden in admin.html
// (Benutzer bearbeiten → „Telefonnummer“).
// ============================================================
const Lines = {
  data: null, user: null, onChange: null,

  async load(force) {
    if (this.data && !force) return this.data;
    try { this.data = await api('GET', '/voice/numbers'); }
    catch (e) { this.data = { enabled: true, numbers: [], error: e.message }; }
    return this.data;
  },

  fmt(n) { return fmtPhoneDE(n); },

  // Feld im Benutzer-Dialog
  async renderField(el, user, onChange) {
    if (!el) return;
    this.user = user; this.onChange = onChange;
    if (!user) { el.innerHTML = '<div class="line-hint">Nach dem Anlegen kannst du hier eine Nummer zuteilen.</div>'; return; }
    const d = await this.load();
    if (!d.enabled) {
      el.innerHTML = '<div class="line-hint"><i class="fas fa-info-circle"></i> Telefonie ist noch nicht eingerichtet (Twilio-Zugangsdaten fehlen).</div>';
      return;
    }
    const n = user.phone_line;
    el.innerHTML = n
      ? `<div class="line-current"><span class="line-ic"><i class="fas fa-phone-volume"></i></span>
          <div class="line-main"><b class="mono">${escHtml(this.fmt(n))}</b><span>Kunden sehen diese Nummer, Anrufe darauf klingeln bei ${escHtml(user.full_name.split(' ')[0])} im CRM</span></div>
          <button type="button" class="btn btn-ghost btn-sm" onclick="Lines.open()">Ändern</button></div>`
      : `<button type="button" class="line-add" onclick="Lines.open()"><i class="fas fa-plus"></i> Nummer zuteilen
          <span>Eigene Nummer für Anrufe im Browser und auf dem Handy – ohne Bestätigung</span></button>`;
  },

  async open() {
    const u = this.user;
    document.getElementById('linesModal')?.remove();
    const o = document.createElement('div');
    o.id = 'linesModal'; o.className = 'modal-overlay open'; o.style.zIndex = 950;
    o.innerHTML = `<div class="modal modal-flex" style="max-width:560px">
      <div class="modal-header"><div class="modal-heading"><span class="modal-icon"><i class="fas fa-phone-volume"></i></span>
        <div><div class="modal-title">Nummer für ${escHtml(u.full_name)}</div><div class="modal-subtitle">Gilt sofort, ${escHtml(u.full_name.split(' ')[0])} muss nichts bestätigen</div></div></div>
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body" id="linesBody"><div class="line-hint"><i class="fas fa-spinner fa-spin"></i> Nummern werden geladen …</div></div>
    </div>`;
    o.addEventListener('mousedown', e => { if (e.target === o) o.remove(); });
    document.body.appendChild(o);
    await this.load(true);
    this.renderModal();
  },

  renderModal() {
    const body = document.getElementById('linesBody');
    if (!body) return;
    const u = this.user, d = this.data;
    const eigene = d.numbers.map(n => {
      const mine = n.user && n.user.id === u.id;
      const status = mine ? 'Aktuell zugeteilt' : n.user ? `bei ${escHtml(n.user.name)}` : n.company ? 'Firmennummer' : 'frei';
      return `<button type="button" class="line-card${mine ? ' on' : ''}${!n.user && !n.company ? ' free' : ''}" ${mine ? 'disabled' : ''}
          onclick="Lines.assign('${escHtml(n.sid)}', ${n.user ? `'${escHtml(n.user.name.replace(/'/g, ''))}'` : 'null'})">
        <b class="mono">${escHtml(this.fmt(n.number))}</b><span>${status}</span></button>`;
    }).join('');
    body.innerHTML = `
      ${d.error ? `<div class="line-err"><i class="fas fa-exclamation-triangle"></i> ${escHtml(d.error)}</div>` : ''}
      <div class="modal-section-label">Nummern in deinem Konto</div>
      <div class="line-grid">${eigene || '<div class="line-hint">Noch keine Nummern im Konto – hol dir unten eine.</div>'}</div>
      ${u.phone_line ? `<button type="button" class="btn btn-ghost btn-sm line-free" onclick="Lines.release()"><i class="fas fa-unlink"></i> Nummer von ${escHtml(u.full_name.split(' ')[0])} freigeben</button>` : ''}
      <div class="modal-section-label" style="margin-top:6px">Neue Nummer holen</div>
      <form class="line-search" onsubmit="event.preventDefault();Lines.search()">
        <div class="kb-search line-search-box"><i class="fas fa-search"></i><input id="linesVorwahl" inputmode="numeric" placeholder="Vorwahl, z. B. 030 für Berlin oder 089 für München"></div>
        <button class="btn btn-primary" type="submit">Suchen</button>
      </form>
      <div id="linesResults"></div>`;
  },

  async search() {
    const el = document.getElementById('linesResults');
    el.innerHTML = '<div class="line-hint"><i class="fas fa-spinner fa-spin"></i> Suche freie Nummern …</div>';
    try {
      const r = await api('GET', '/voice/numbers/search?vorwahl=' + encodeURIComponent(document.getElementById('linesVorwahl').value));
      el.innerHTML = r.numbers.length
        ? `<div class="line-grid">${r.numbers.map(n => `<button type="button" class="line-card buy" onclick="Lines.buy('${escHtml(n.number)}')">
            <b class="mono">${escHtml(this.fmt(n.number))}</b><span>${escHtml(n.ort || 'Deutschland')} · holen &amp; zuteilen</span></button>`).join('')}</div>`
        : '<div class="line-hint">Für diese Vorwahl gibt es gerade keine freien Nummern. Probier eine andere.</div>';
    } catch (e) { el.innerHTML = `<div class="line-err"><i class="fas fa-exclamation-triangle"></i> ${escHtml(e.message)}</div>`; }
  },

  async buy(number) {
    const u = this.user;
    if (!await customConfirm(`${this.fmt(number)} wird in deinem Twilio-Konto gekauft (monatliche Gebühr bei Twilio) und ${u.full_name} zugeteilt.`, { title: 'Nummer holen?', okLabel: 'Holen & zuteilen' })) return;
    try {
      const r = await api('POST', '/voice/numbers/buy', { number, userId: u.id });
      this.done(r.number);
    } catch (e) { showToast(e.message, 'err'); }
  },

  async assign(sid, fromName) {
    const u = this.user;
    if (fromName && !await customConfirm(`Die Nummer ist gerade bei ${fromName}. ${u.full_name} übernimmt sie, ${fromName} hat danach keine eigene Nummer mehr.`, { title: 'Nummer übernehmen?', okLabel: 'Übernehmen' })) return;
    try {
      const r = await api('PUT', `/voice/numbers/${encodeURIComponent(sid)}`, { userId: u.id });
      this.done(r.number);
    } catch (e) { showToast(e.message, 'err'); }
  },

  async release() {
    const u = this.user;
    const n = this.data.numbers.find(x => x.user && x.user.id === u.id);
    if (!n) return;
    try {
      await api('PUT', `/voice/numbers/${encodeURIComponent(n.sid)}`, { userId: null });
      this.done(null);
    } catch (e) { showToast(e.message, 'err'); }
  },

  done(number) {
    this.user.phone_line = number;
    document.getElementById('linesModal')?.remove();
    showToast(number ? `${this.fmt(number)} zugeteilt ✓` : 'Nummer freigegeben');
    this.data = null;
    if (this.onChange) this.onChange(number);
  },
};
