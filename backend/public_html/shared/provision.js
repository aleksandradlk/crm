// ============================================================
// Provision und Bonus: Kasten im Deal, Bonus-Leiste über den Deals
// (Closer), „Meine Provision“ und die Team-Übersicht im Tracking (Admin).
// Daten: GET /api/provision/deal/:id, /provision/mein, /provision/team
// ============================================================
const Provision = {
  eur(v) { return Number(v || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 }); },
  datum(iso) { return iso ? new Date(iso + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''; },
  monatName(m) { return new Date(m + '-15T12:00:00').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }); },
  monat(versatz = 0) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + versatz); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; },

  teilName(t) {
    return { anzahlung: 'Anzahlung', rate: `Rate ${t.nr} von ${t.von}`, rest: 'Restzahlung' }[t.art] || 'Zahlung';
  },
  teilStatus(t) {
    if (t.status === 'faellig') return ['ok', `Kunde hat am ${this.datum(t.kunde_bezahlt_am)} bezahlt · fällig seit ${this.datum(t.faellig_am)}`];
    if (t.status === 'bezahlt') return ['ok', `Kunde hat am ${this.datum(t.kunde_bezahlt_am)} bezahlt · fällig am ${this.datum(t.faellig_am)}`];
    if (t.status === 'offen') return t.rechnung_status === 'entwurf' ? ['', 'Rechnung noch nicht verschickt'] : ['warn', 'wartet auf die Zahlung des Kunden'];
    return ['', 'noch keine Rechnung'];
  },
  ustText(p) {
    if (p.ust.aktiv) return `inkl. ${p.ust.satz} % USt (${this.eur(p.netto)} netto)`;
    if (p.ust.ausland) return 'ohne USt (Sitz im Ausland)';
    return '';
  },

  // ── Kasten im Deal-Dialog ───────────────────────────────────
  async dealBox(elId, deal, { admin = false } = {}) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = '';
    if (!deal || deal.status === 'lost') return;
    let p;
    try { p = await api('GET', `/provision/deal/${deal.id}`); } catch (_) { return; }
    if (p.keine || document.getElementById(elId) !== el) return;
    const rechnung = p.upgrade
      ? `${p.satz} % von ${this.eur(p.basis)} · Upgrade nach Quick-Win: ${this.eur(p.basis_preis)} − ${this.eur(p.upgrade.abzug)}`
      : `${p.satz} % von ${this.eur(p.basis)} Einmalpreis${p.rabatt ? ' (mit Rabatt)' : ''}`;
    const quelle = { bedarf: 'Geschätzt aus der Bedarfsanalyse – die genaue Zahl steht, sobald das Angebot erstellt ist.',
      deal: 'Geschätzt aus dem Deal-Wert – die genaue Zahl steht, sobald das Angebot erstellt ist.' }[p.quelle];
    el.innerHTML = `<div class="pv-box">
      <div class="pv-head"><span class="pv-label"><i class="fas fa-coins"></i> ${admin ? `Provision für ${escHtml(deal.owner_name || 'den Closer')}` : 'Deine Provision'}</span>
        ${p.geschaetzt ? '<span class="pv-tag">Schätzung</span>' : p.angebot ? `<span class="pv-tag is-ok">Angebot ${escHtml(p.angebot.nummer)}</span>` : ''}</div>
      <div class="pv-sum"><b>${this.eur(p.auszahlung)}</b>${this.ustText(p) ? `<span>${this.ustText(p)}</span>` : ''}</div>
      <div class="pv-calc">${rechnung} · Betreuung und Hosting zählen nicht</div>
      ${p.teile.length > 1 || p.teile.some(t => t.status !== 'geplant') ? `<div class="pv-plan">${escHtml(p.text)}</div>
        <div class="pv-teile">${p.teile.map(t => { const [cls, txt] = this.teilStatus(t); return `
          <div class="pv-teil"><span>${this.teilName(t)}${t.rechnung ? ` · ${escHtml(t.rechnung)}` : ''}</span><b>${this.eur(t.auszahlung)}</b><em class="${cls}">${txt}</em></div>`; }).join('')}</div>`
        : `<div class="pv-plan">${escHtml(p.text)} · fällig 14 Tage nach Zahlungseingang</div>`}
      ${quelle ? `<div class="pv-hint">${quelle}</div>` : ''}
    </div>`;
  },

  // ── Bonus-Leiste über den Deals (Closer) ───────────────────
  bonusText(b) {
    if (!b.naechste) return 'Alle Bonus-Stufen erreicht';
    if (!b.anzahl) return `Dein erster bezahlter Abschluss bringt ${this.eur(b.naechste.betrag)}`;
    return `${b.anzahl} von ${b.naechste.ab} bis zum Bonus`;
  },
  async bonusLeiste(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    let d;
    try { d = await api('GET', '/provision/mein'); } catch (_) { el.innerHTML = ''; return; }
    const b = d.bonus;
    const max = b.stufen.length ? b.stufen[b.stufen.length - 1].ab : 1;
    el.innerHTML = `<div class="pv-bonus" onclick="Provision.meinModal()" title="Meine Provision ansehen">
      <div class="pv-bonus-top">
        <span class="pv-label"><i class="fas fa-medal"></i> Bonus ${escHtml(this.monatName(b.monat).split(' ')[0])}</span>
        <b>${this.bonusText(b)}</b>
        <span class="dc-spacer"></span>
        ${b.summe ? `<span class="pv-tag is-ok">${this.eur(b.summe)} sicher</span>` : ''}
        <span class="pv-bonus-go">Meine Provision <i class="fas fa-arrow-right"></i></span>
      </div>
      <div class="pv-steps">
        <div class="zl-bar"><div class="${b.naechste ? '' : 'is-done'}" style="width:${Math.min(100, Math.round(b.anzahl / max * 100))}%"></div></div>
        ${b.stufen.map(s => { const pct = Math.round(s.ab / max * 100);
          const lage = pct >= 100 ? 'right:0' : pct < 15 ? 'left:0' : `left:${pct}%;transform:translateX(-50%)`;
          return `<span class="pv-step${b.anzahl >= s.ab ? ' is-done' : ''}" style="${lage}">${s.ab} · ${this.eur(s.betrag)}</span>`; }).join('')}
      </div>
      <div class="pv-bonus-sub">Zählt: Autopilot S, M, L und individuelle Software – im Monat der Unterschrift, sobald die erste Zahlung da ist.
        ${b.wartet.length ? `<b>${b.wartet.length} ${b.wartet.length === 1 ? 'Abschluss wartet' : 'Abschlüsse warten'} noch auf die erste Zahlung.</b>` : ''}
        ${d.faellig_monat ? `Provision fällig im ${escHtml(this.monatName(d.monat).split(' ')[0])}: <b>${this.eur(d.faellig_monat)}</b>` : ''}</div>
    </div>`;
  },

  // ── „Meine Provision“ (Closer) ──────────────────────────────
  async meinModal(monat) {
    monat = monat || this.monat();
    let d;
    try { d = await api('GET', `/provision/mein?monat=${monat}`); } catch (e) { showToast(e.message, 'err'); return; }
    document.getElementById('pvModal')?.remove();
    const o = document.createElement('div');
    o.id = 'pvModal'; o.className = 'modal-overlay open'; o.style.zIndex = 990;
    o.onclick = e => { if (e.target === o) o.remove(); };
    const chips = [-1, 0, 1].map(v => this.monat(v)).map(m =>
      `<button class="qf-btn ${m === monat ? 'active' : ''}" onclick="Provision.meinModal('${m}')">${escHtml(this.monatName(m))}</button>`).join('');
    o.innerHTML = `<div class="modal modal-flex" style="max-width:640px">
      <div class="modal-header"><div class="modal-heading"><div class="modal-icon"><i class="fas fa-coins"></i></div>
        <div><div class="modal-title">Meine Provision</div><div class="modal-subtitle">${d.user?.ust ? 'Beträge inkl. 19 % USt' : 'Beträge ohne USt'} · fällig 14 Tage nach Zahlungseingang beim Kunden</div></div></div>
        <button class="modal-x" onclick="document.getElementById('pvModal').remove()"><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        <div class="zl-nav au-nav">${chips}</div>
        <div class="au-kpis pv-kpis">
          <div><b>${this.eur(d.faellig_monat)}</b><span>fällig im ${escHtml(this.monatName(monat).split(' ')[0])}</span></div>
          <div><b>${this.eur(d.verdient)}</b><span>Kunde hat bezahlt</span></div>
          <div><b>${this.eur(d.ausstehend)}</b><span>wartet auf Zahlung</span></div>
          <div><b>${this.eur(d.bonus.summe)}</b><span>Bonus · ${escHtml(this.bonusText(d.bonus))}</span></div>
        </div>
        ${d.deals.length ? d.deals.map(x => `
          <div class="pv-deal" onclick="document.getElementById('pvModal').remove();Deals.open(${x.id})">
            <div class="pv-deal-top"><b>${escHtml(x.company || x.title)}</b>${x.geschaetzt ? '<span class="pv-tag">Schätzung</span>' : ''}<span class="dc-spacer"></span><b>${this.eur(x.auszahlung)}</b></div>
            <div class="pv-calc">${escHtml(x.text)} · gewonnen am ${fmtDate(x.won_at)}</div>
            <div class="pv-teile">${x.teile.map(t => { const [cls, txt] = this.teilStatus(t); return `<div class="pv-teil"><span>${this.teilName(t)}</span><b>${this.eur(t.auszahlung)}</b><em class="${cls}">${txt}</em></div>`; }).join('')}</div>
          </div>`).join('') : '<div class="au-empty">Noch keine gewonnenen Deals in den letzten 12 Monaten.</div>'}
      </div></div>`;
    document.body.appendChild(o);
  },

  // ── Team-Übersicht im Tracking (Admin) ──────────────────────
  teamMonat: null,
  async team(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    const monat = this.teamMonat || this.monat();
    let d;
    try { d = await api('GET', `/provision/team?monat=${monat}`); } catch (e) { el.innerHTML = ''; return; }
    const chips = [-1, 0, 1].map(v => this.monat(v)).map(m =>
      `<button class="qf-btn ${m === monat ? 'active' : ''}" onclick="Provision.teamMonat='${m}';Provision.team('${elId}')">${escHtml(this.monatName(m))}</button>`).join('');
    const summe = d.team.reduce((s, c) => s + c.faellig_monat + c.bonus.summe, 0);
    el.innerHTML = `<div class="card au-card"><div class="au-h">Provision &amp; Bonus</div>
      <div class="zl-nav au-nav">${chips}</div>
      ${d.abrechnung ? '' : '<div class="au-empty">Die Abrechnung läuft nicht – Provision wird nur geschätzt.</div>'}
      ${d.team.length ? `<table class="au-table"><thead><tr><th>Closer</th><th>Fällig im Monat</th><th>Bonus</th><th>Wartet auf Zahlung</th><th>USt</th></tr></thead><tbody>
        ${d.team.map(c => `<tr><td><b>${escHtml(c.full_name)}</b>${c.deals.filter(x => x.teile.length).map(x =>
            `<div class="pv-sub">${escHtml(x.company || x.title)}: ${x.teile.map(t => `${this.teilName(t)} ${this.eur(t.auszahlung)} am ${this.datum(t.faellig_am)}`).join(', ')}</div>`).join('')}</td>
          <td data-l="Fällig im Monat"><b>${this.eur(c.faellig_monat)}</b></td>
          <td data-l="Bonus">${c.bonus.summe ? `<b>${this.eur(c.bonus.summe)}</b> ` : ''}<span class="au-muted">${c.bonus.anzahl}${c.bonus.naechste ? ` von ${c.bonus.naechste.ab}` : ''}${c.bonus.wartet ? ` · ${c.bonus.wartet} warten` : ''}</span></td>
          <td data-l="Wartet auf Zahlung">${this.eur(c.ausstehend)}</td>
          <td data-l="USt">${c.ust ? 'zzgl. 19 %' : '<span class="au-muted">ohne</span>'}</td></tr>`).join('')}
      </tbody></table>
      <div class="au-muted" style="font-size:12px;margin-top:8px">Auszuzahlen für ${escHtml(this.monatName(monat))}: <b>${this.eur(summe)}</b> (Provision + Bonus)</div>` : '<div class="au-empty">Noch keine Closer angelegt.</div>'}
    </div>`;
  },
};
