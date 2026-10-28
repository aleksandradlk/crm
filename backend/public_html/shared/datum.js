// ============================================================
// Datumsauswahl im NovaFlow-Stil statt Browser-Kalender.
// Verbessert automatisch jedes <input type="date"> und
// <input type="datetime-local"> (auch später eingefügte):
// Das Original bleibt versteckt im DOM und behält Wert, id und
// onchange; sichtbar ist ein Feld „TT.MM.JJJJ“ mit eigenem Kalender.
// Tippen geht auch (20.11.2026, 20.11.26, 20.11. → aktuelles Jahr).
// ============================================================
(function () {
  if (window.NfDatum) return;
  const WT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const MON = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const NATIV = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ausIso = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };

  const css = `
.nf-dt-orig { display: none !important; }
.nf-dt-feld { cursor: pointer; padding-right: 34px !important;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%23c2691e' stroke-width='1.8' stroke-linecap='round' viewBox='0 0 24 24'%3E%3Crect x='3' y='5' width='18' height='16' rx='3'/%3E%3Cpath d='M3 10h18M8 3v4M16 3v4'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 11px center; }
.nf-dt-feld:disabled { cursor: not-allowed; opacity: .6; }
.nf-dt-pop { position: fixed; z-index: 100000; width: 288px; padding: 14px; border-radius: 14px;
  background: var(--bg2, var(--flaeche, var(--white, #fff))); color: var(--text, #1a2330); border: 1px solid var(--border, #e2e8f0);
  box-shadow: 0 18px 40px -12px rgba(19,26,36,.35), 0 2px 6px rgba(19,26,36,.08);
  font-family: var(--font-sans, 'Montserrat', 'Segoe UI', system-ui, sans-serif); font-size: 13px; user-select: none; }
.nf-dt-kopf { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.nf-dt-kopf b { font-size: 14px; font-weight: 700; letter-spacing: .01em; }
.nf-dt-nav { width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border, #e2e8f0); background: transparent;
  color: inherit; cursor: pointer; font: inherit; font-size: 15px; line-height: 1; }
.nf-dt-nav:hover { border-color: var(--copper, #c2691e); color: var(--copper, #c2691e); }
.nf-dt-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
.nf-dt-wt { text-align: center; font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text3, var(--muted, #737c8b)); padding: 2px 0 6px; }
.nf-dt-tag { height: 34px; border: 0; border-radius: 9px; background: transparent; color: inherit; font: inherit; font-weight: 500; cursor: pointer; }
.nf-dt-tag:hover:not(:disabled) { background: var(--bg3, var(--paper-card, #eef2f7)); }
.nf-dt-tag.is-anders { color: var(--text3, var(--muted, #9aa5b4)); opacity: .7; }
.nf-dt-tag.is-we:not(.is-wahl):not(.is-anders) { color: var(--text2, var(--muted, #59616e)); }
.nf-dt-tag.is-heute { box-shadow: inset 0 0 0 1.5px var(--copper, #c2691e); font-weight: 700; }
.nf-dt-tag.is-wahl { background: var(--copper, #c2691e); color: #fff; font-weight: 700; }
.nf-dt-tag:disabled { opacity: .3; cursor: not-allowed; }
.nf-dt-zeit { display: flex; align-items: center; gap: 6px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border, #e2e8f0); }
.nf-dt-zeit span { color: var(--text2, var(--muted, #59616e)); font-weight: 600; margin-right: auto; }
.nf-dt-zeit select { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border, #e2e8f0); background: var(--bg2, var(--flaeche, var(--white, #fff))); color: inherit; font: inherit; }
.nf-dt-fuss { display: flex; gap: 6px; margin-top: 12px; }
.nf-dt-fuss button { flex: 1; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--border, #e2e8f0); background: transparent;
  color: inherit; font: inherit; font-weight: 600; font-size: 12.5px; cursor: pointer; }
.nf-dt-fuss button:hover { border-color: var(--copper, #c2691e); color: var(--copper, #c2691e); }
.nf-dt-fuss .nf-dt-ok { background: var(--accent, var(--copper, #2c3a55)); border-color: transparent; color: var(--accent-fg, #fff); }
.nf-dt-fuss .nf-dt-ok:hover { color: var(--accent-fg, #fff); filter: brightness(1.1); }
`;

  let pop = null, aktiv = null;

  function anzeige(orig) {
    const v = NATIV.get.call(orig);
    const d = ausIso(v);
    if (!d) return '';
    const t = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
    return orig.dataset.nfZeit ? `${t} ${(/T(\d{2}:\d{2})/.exec(v) || [, '09:00'])[1]}` : t;
  }

  // Getippte Eingabe lesen: 20.11.2026, 20.11.26, 20.11. (dieses Jahr), optional „14:30“
  function lesen(text, mitZeit) {
    const m = /^\s*(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?(?:\s+(\d{1,2})[:.](\d{2}))?\s*$/.exec(text || '');
    if (!m) return null;
    let j = m[3] ? +m[3] : new Date().getFullYear();
    if (j < 100) j += 2000;
    const d = new Date(j, +m[2] - 1, +m[1]);
    if (d.getMonth() !== +m[2] - 1) return null;
    return mitZeit ? `${iso(d)}T${pad(m[4] != null ? +m[4] : 9)}:${pad(m[5] != null ? +m[5] : 0)}` : iso(d);
  }

  function setzen(orig, wert) {
    if (NATIV.get.call(orig) === wert) return;
    NATIV.set.call(orig, wert);
    orig._nfFeld.value = anzeige(orig);
    orig.dispatchEvent(new Event('input', { bubbles: true }));
    orig.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function schliessen() {
    if (pop) pop.remove();
    pop = null; aktiv = null;
  }

  function oeffnen(orig) {
    if (orig.disabled) return;
    schliessen();
    aktiv = orig;
    const mitZeit = !!orig.dataset.nfZeit;
    const wert = NATIV.get.call(orig);
    let wahl = ausIso(wert);                       // gewählter Tag (bei Datum + Uhrzeit erst mit „Übernehmen“ gespeichert)
    const ansicht = wahl ? new Date(wahl) : new Date();
    ansicht.setDate(1);
    const zeit = (/T(\d{2}):(\d{2})/.exec(wert) || [, '09', '00']).slice(1);
    const min = ausIso(orig.min), max = ausIso(orig.max);
    pop = document.createElement('div');
    pop.className = 'nf-dt-pop';
    pop.addEventListener('mousedown', e => { if (e.target.tagName !== 'SELECT') e.preventDefault(); });

    const merkeZeit = () => { const h = pop.querySelector('[data-z="h"]'), m = pop.querySelector('[data-z="m"]'); if (h && m) { zeit[0] = h.value; zeit[1] = m.value; } };
    const zeichnen = () => {
      const heute = iso(new Date());
      const start = new Date(ansicht); start.setDate(1 - ((start.getDay() + 6) % 7));
      const tage = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        if (i % 7 === 0 && i >= 28 && d.getMonth() !== ansicht.getMonth()) break;
        const k = iso(d);
        const cls = ['nf-dt-tag', d.getMonth() !== ansicht.getMonth() ? 'is-anders' : '', k === heute ? 'is-heute' : '',
          wahl && k === iso(wahl) ? 'is-wahl' : '', i % 7 > 4 ? 'is-we' : ''].filter(Boolean).join(' ');
        const aus = (min && d < min) || (max && d > max);
        tage.push(`<button type="button" class="${cls}" data-tag="${k}" ${aus ? 'disabled' : ''}>${d.getDate()}</button>`);
      }
      const opt = (n, schritt, akt) => [...new Set(Array.from({ length: Math.ceil(n / schritt) }, (_, i) => pad(i * schritt)).concat(akt ? [akt] : []))].sort()
        .map(v => `<option ${v === akt ? 'selected' : ''}>${v}</option>`).join('');
      pop.innerHTML = `
        <div class="nf-dt-kopf"><button type="button" class="nf-dt-nav" data-nav="-1" aria-label="Monat zurück">‹</button>
          <b>${MON[ansicht.getMonth()]} ${ansicht.getFullYear()}</b>
          <button type="button" class="nf-dt-nav" data-nav="1" aria-label="Monat vor">›</button></div>
        <div class="nf-dt-grid">${WT.map(w => `<div class="nf-dt-wt">${w}</div>`).join('')}${tage.join('')}</div>
        ${mitZeit ? `<div class="nf-dt-zeit"><span>Uhrzeit</span><select data-z="h">${opt(24, 1, zeit[0])}</select>:<select data-z="m">${opt(60, 15, zeit[1])}</select></div>` : ''}
        <div class="nf-dt-fuss"><button type="button" data-akt="heute">Heute</button><button type="button" data-akt="leer">Leeren</button>
          ${mitZeit ? '<button type="button" class="nf-dt-ok" data-akt="ok">Übernehmen</button>' : ''}</div>`;
    };
    const uebernehmen = tag => {
      if (!tag) setzen(orig, '');
      else { merkeZeit(); setzen(orig, mitZeit ? `${iso(tag)}T${zeit[0]}:${zeit[1]}` : iso(tag)); }
      schliessen();
      orig._nfFeld.blur();
    };
    pop.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.nav) { merkeZeit(); ansicht.setMonth(ansicht.getMonth() + +b.dataset.nav); zeichnen(); return; }
      if (b.dataset.tag) {
        wahl = ausIso(b.dataset.tag);
        if (!mitZeit) return uebernehmen(wahl);
        merkeZeit(); ansicht.setFullYear(wahl.getFullYear(), wahl.getMonth(), 1); zeichnen(); return;
      }
      if (b.dataset.akt === 'heute') return uebernehmen(new Date());
      if (b.dataset.akt === 'leer') return uebernehmen(null);
      if (b.dataset.akt === 'ok') return uebernehmen(wahl || new Date());
    });
    zeichnen();
    document.body.appendChild(pop);
    const r = orig._nfFeld.getBoundingClientRect();
    const h = pop.offsetHeight, w = pop.offsetWidth;
    const unten = r.bottom + 6 + h <= window.innerHeight || r.top - 6 - h < 0;
    pop.style.top = `${Math.max(8, unten ? r.bottom + 6 : r.top - 6 - h)}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  }

  function verbessern(orig) {
    if (orig._nfFeld || !(orig.type === 'date' || orig.type === 'datetime-local') || orig.dataset.nativ !== undefined) return;
    const feld = document.createElement('input');
    feld.type = 'text';
    feld.className = (orig.className ? orig.className + ' ' : '') + 'nf-dt-feld';
    if (orig.getAttribute('style')) feld.setAttribute('style', orig.getAttribute('style'));
    if (orig.type === 'datetime-local') orig.dataset.nfZeit = '1';
    feld.placeholder = orig.dataset.nfZeit ? 'TT.MM.JJJJ hh:mm' : 'TT.MM.JJJJ';
    feld.autocomplete = 'off';
    feld.inputMode = 'numeric';
    // Handy: nur Kalender, keine Tastatur. Die Zifferntastatur hat am iPhone keinen Punkt,
    // und beim Öffnen scrollt iOS das Fenster – das schloss den Kalender sofort wieder.
    if (window.matchMedia && matchMedia('(pointer: coarse)').matches) feld.readOnly = true;
    if (orig.title) feld.title = orig.title;
    feld.disabled = orig.disabled;
    orig._nfFeld = feld;
    orig.classList.add('nf-dt-orig');
    orig.insertAdjacentElement('afterend', feld);
    // Werte, die der Code später setzt (el.value = …), auch im sichtbaren Feld zeigen
    Object.defineProperty(orig, 'value', {
      configurable: true,
      get() { return NATIV.get.call(this); },
      set(v) { NATIV.set.call(this, v); feld.value = anzeige(this); },
    });
    feld.value = anzeige(orig);
    feld.addEventListener('focus', () => oeffnen(orig));
    feld.addEventListener('click', () => { if (aktiv !== orig) oeffnen(orig); });
    feld.addEventListener('keydown', e => {
      if (e.key === 'Escape') { schliessen(); feld.blur(); }
      if (e.key === 'Enter') { e.preventDefault(); feld.blur(); }
    });
    feld.addEventListener('blur', () => {
      setTimeout(() => { if (aktiv === orig && document.activeElement !== feld && !(pop && pop.contains(document.activeElement))) schliessen(); }, 120);
      const t = feld.value.trim();
      if (!t) { if (NATIV.get.call(orig)) setzen(orig, ''); return; }
      if (t === anzeige(orig)) return;
      const neu = lesen(t, !!orig.dataset.nfZeit);
      if (neu) setzen(orig, neu); else feld.value = anzeige(orig);
    });
    // disabled am Original wird mitgezogen
    new MutationObserver(() => { feld.disabled = orig.disabled; }).observe(orig, { attributes: true, attributeFilter: ['disabled'] });
  }

  function alle(wurzel) {
    if (wurzel.matches && wurzel.matches('input[type="date"], input[type="datetime-local"]')) verbessern(wurzel);
    if (wurzel.querySelectorAll) wurzel.querySelectorAll('input[type="date"], input[type="datetime-local"]').forEach(verbessern);
  }

  function start() {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    alle(document.body);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) alle(n); })))
      .observe(document.body, { childList: true, subtree: true });
    document.addEventListener('mousedown', e => { if (pop && !pop.contains(e.target) && (!aktiv || e.target !== aktiv._nfFeld)) schliessen(); });
    window.addEventListener('resize', schliessen);
    document.addEventListener('scroll', e => { if (pop && !pop.contains(e.target)) schliessen(); }, true);
  }

  window.NfDatum = { verbessern, schliessen };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
