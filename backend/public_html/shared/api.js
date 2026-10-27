/* ============================================================
   LeadHunter Pro — Shared JS (api.js)
   ============================================================ */

const API_BASE = '/api';

// ── Token storage ─────────────────────────────────────────────
const Auth = {
  getToken()  { return localStorage.getItem('lh_token'); },
  getUser()   { try { return JSON.parse(localStorage.getItem('lh_user')); } catch { return null; } },
  setSession(token, user) {
    localStorage.setItem('lh_token', token);
    localStorage.setItem('lh_user', JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem('lh_token');
    localStorage.removeItem('lh_user');
  },
  isAdmin() { return this.getUser()?.role === 'admin'; },
  can(perm) {
    const user = this.getUser();
    if (!user) return false;
    if (user.role === 'admin') return true;
    return !!user[perm];
  },
  requireAuth() {
    if (!this.getToken()) { window.location.href = '/login'; return false; }
    return true;
  },
  requireAdmin() {
    if (!this.requireAuth()) return false;
    if (!this.isAdmin()) { window.location.href = '/closer'; return false; }
    return true;
  },
};

// ── API fetch wrapper ─────────────────────────────────────────
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = Auth.getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    if (path === '/auth/login') throw new Error(data.error || 'Ungültige Zugangsdaten');
    Auth.clear();
    window.location.href = '/login';
    throw new Error('Session abgelaufen');
  }

  // Wartungsmodus: Overlay sofort anzeigen statt generischer Fehlermeldung
  if (res.status === 503 && data.error === 'maintenance') {
    const overlay = document.getElementById('maintenanceOverlay');
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.style.flexDirection = 'column';
      const untilEl = document.getElementById('maintUntilInfo');
      const untilTimeEl = document.getElementById('maintUntilTime');
      if (data.until && untilEl && untilTimeEl) {
        untilTimeEl.textContent = new Date(data.until).toLocaleString('de-DE', {
          day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'
        });
        untilEl.style.display = 'block';
      } else if (untilEl) {
        untilEl.style.display = 'none';
      }
    }
    throw new Error('maintenance');
  }

  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;   // z.B. data.duplicates bei 409 (mögliche Dublette)
    throw err;
  }
  return data;
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, type = 'ok') {
  let t = document.getElementById('globalToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'globalToast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  const icon = type === 'ok' ? '✓' : type === 'err' ? '✕' : 'ℹ';
  const color = type === 'ok' ? 'var(--green)' : type === 'err' ? 'var(--red)' : 'var(--accent)';
  t.innerHTML = `<span style="color:${color};font-weight:700">${icon}</span> ${escHtml(msg)}`;
  t.style.display = 'flex';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = 'none'; }, 3500);
}

// ── Custom Confirm Dialog ─────────────────────────────────────
function customConfirm(message, { title = 'Bitte bestätigen', okLabel = 'Bestätigen', cancelLabel = 'Abbrechen', danger = false } = {}) {
  return new Promise(resolve => {
    let overlay = document.getElementById('_customConfirmOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = '_customConfirmOverlay';
      overlay.className = 'modal-overlay open';
      overlay.style.cssText = 'z-index:9999';
      overlay.innerHTML = `
        <div id="_customConfirmBox" class="modal" style="max-width:420px;padding:24px 26px 22px">
          <div id="_customConfirmTitle" class="modal-title" style="margin-bottom:10px;padding-right:0"></div>
          <div id="_customConfirmMsg" style="font-size:13px;color:var(--text2);line-height:1.6;margin-bottom:20px;white-space:pre-line"></div>
          <div class="modal-actions" style="margin-top:0">
            <button id="_customConfirmCancel" class="btn btn-ghost btn-sm"></button>
            <button id="_customConfirmOk"     class="btn btn-sm"></button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }
    document.getElementById('_customConfirmTitle').textContent  = title;
    document.getElementById('_customConfirmMsg').textContent    = message;
    const okBtn     = document.getElementById('_customConfirmOk');
    const cancelBtn = document.getElementById('_customConfirmCancel');
    okBtn.textContent     = okLabel;
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.display = cancelLabel ? '' : 'none';
    okBtn.className = danger ? 'btn btn-sm' : 'btn btn-primary btn-sm';
    okBtn.style.background    = danger ? 'var(--red)'  : '';
    okBtn.style.borderColor   = danger ? 'var(--red)'  : '';
    okBtn.style.color         = danger ? '#fff'        : '';
    const cleanup = (result) => {
      overlay.style.display = 'none';
      okBtn.onclick = null; cancelBtn.onclick = null;
      resolve(result);
    };
    okBtn.onclick     = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    overlay.onclick   = (e) => { if (e.target === overlay) cleanup(false); };
    overlay.style.display = 'flex';
    setTimeout(() => okBtn.focus(), 30);
  });
}

// ── Helpers ───────────────────────────────────────────────────
// Deutsche Nummer lesbar: +49 30 5555555, +49 171 2345678 (Vorwahl geschätzt)
function fmtPhoneDE(n) {
  const m = String(n || '').match(/^\+49(\d+)$/);
  if (!m) return n || '';
  const d = m[1], len = /^(30|40|69|89)/.test(d) ? 2 : 3;
  return `+49 ${d.slice(0, len)} ${d.slice(len)}`;
}
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function absUrl(s) {
  const v = String(s || '').trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

// Lead-Status an einer Stelle (Reihenfolge = Anzeige)
const LEAD_STATUS = [['neu', 'Neu'], ['kontaktiert', 'Kontaktiert'], ['nicht_erreicht', 'Nicht erreicht'], ['rueckruf', 'Rückruf'],
  ['kein_interesse', 'Kein Interesse'], ['passt_nicht', 'Passt nicht'], ['keine_anrufe', 'Keine Anrufe mehr'], ['kunde', 'Kunde']];
const LEAD_STATUS_LABEL = Object.fromEntries(LEAD_STATUS);
const LEAD_STATUS_ZU = ['kunde', 'kein_interesse', 'passt_nicht', 'keine_anrufe'];   // ohne nächsten Schritt
function statusBadge(status) {
  return `<span class="status-badge s-${status}">${LEAD_STATUS_LABEL[status] || status}</span>`;
}
function statusOptionen(current, leer) {
  return (leer ? `<option value="">${leer}</option>` : '') + LEAD_STATUS.map(([v, l]) => `<option value="${v}"${current === v ? ' selected' : ''}>${l}</option>`).join('');
}

// „Passt nicht“ nur mit Grund: fragt den Grund ab, gibt {grund, grund_text} zurück (null = abgebrochen)
function statusGrund(status, titel) {
  if (status !== 'passt_nicht') return Promise.resolve({});
  const gruende = (window.BedarfRegeln && BedarfRegeln.GRUENDE) || ['Sonstiges'];
  return new Promise(resolve => {
    document.getElementById('grundModal')?.remove();
    const o = document.createElement('div');
    o.id = 'grundModal'; o.className = 'modal-overlay open'; o.style.zIndex = 1200;
    let gewaehlt = null;
    o.innerHTML = `<div class="modal modal-flex" style="max-width:460px">
      <div class="modal-header"><div class="modal-heading"><div class="modal-icon"><i class="fas fa-ban"></i></div>
        <div><div class="modal-title">${titel || 'Warum passt der Lead nicht?'}</div><div class="modal-subtitle">Pflicht – hilft bei der Auswertung</div></div></div>
        <button class="modal-x" data-x><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        <div class="dl-chips" id="grundChips">${gruende.map(g => `<button type="button" class="qf-btn" data-g="${escHtml(g)}">${escHtml(g)}</button>`).join('')}</div>
        <input class="form-control" id="grundText" placeholder="Kurz beschreiben (bei „Sonstiges“ Pflicht)">
        <div class="tr-err" id="grundErr"></div>
        <div class="modal-actions"><button class="btn btn-ghost btn-sm" data-x>Abbrechen</button><button class="btn btn-primary btn-sm" data-ok>Speichern</button></div>
      </div></div>`;
    const fertig = v => { o.remove(); resolve(v); };
    o.querySelectorAll('[data-x]').forEach(b => b.onclick = () => fertig(null));
    o.querySelector('#grundChips').onclick = e => {
      const b = e.target.closest('[data-g]'); if (!b) return;
      gewaehlt = b.dataset.g;
      o.querySelectorAll('#grundChips .qf-btn').forEach(x => x.classList.toggle('active', x === b));
    };
    o.querySelector('[data-ok]').onclick = () => {
      const t = o.querySelector('#grundText').value.trim();
      if (!gewaehlt) return (o.querySelector('#grundErr').textContent = 'Bitte einen Grund wählen.');
      if (gewaehlt === 'Sonstiges' && !t) return (o.querySelector('#grundErr').textContent = 'Bitte kurz beschreiben, warum.');
      fertig({ grund: gewaehlt, grund_text: t });
    };
    document.body.appendChild(o);
  });
}
// Status setzen (mit Grund-Abfrage). false = abgebrochen
async function statusSetzen(id, status, extra) {
  const g = extra || await statusGrund(status);
  if (g === null) return false;
  await api('PATCH', `/leads/${id}/status`, { status, ...g });
  return true;
}

function confBar(val) {
  const w = Math.round(val || 0);
  const color = w >= 75 ? 'var(--green)' : w >= 50 ? 'var(--amber)' : 'var(--red)';
  return `<div class="conf-wrap">
    <div class="conf-bar-bg"><div class="conf-bar-fill" style="width:${w}%;background:${color}"></div></div>
    <span class="conf-val">${w}%</span>
  </div>`;
}

function ageBadge(dateStr) {
  if (!dateStr) return '';
  const days = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
  if (days >= 30) return `<span class="age-badge hot" title="${days} Tage keine Aktivität"><i class="fas fa-fire"></i> ${days}T</span>`;
  if (days >= 14) return `<span class="age-badge warm" title="${days} Tage keine Aktivität"><i class="fas fa-clock"></i> ${days}T</span>`;
  return '';
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
// Gesprächsdauer: "45 Sek" bzw. "3:07 Min"
function fmtCallDuration(sec) {
  sec = parseInt(sec) || 0;
  if (sec < 60) return `${sec} Sek`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} Min`;
}
// "Nächster Schritt" einer Lead-Zeile: offene Wiedervorlage (rot = überfällig,
// kupfer = heute) oder Warnhinweis, wenn ein offener Lead keinen nächsten Schritt hat.
function nextStepCell(l) {
  const last = l.last_call_at ? `<div class="cell-sub">Anruf ${fmtDateShort(l.last_call_at)}</div>` : '';
  if (l.next_reminder_at) {
    const d = new Date(l.next_reminder_at);
    const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
    const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    let cls = 'ns-future', label = `${fmtDateShort(d)} ${time}`;
    if (d.getTime() < Date.now()) { cls = 'ns-overdue'; label = `überfällig · ${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}`; }
    else if (d <= endToday) { cls = 'ns-today'; label = `heute ${time}`; }
    return `<span class="next-step ${cls}"><i class="fas fa-bell"></i>${label}</span>${last}`;
  }
  if (LEAD_STATUS_ZU.includes(l.status)) return `<span class="cell-sub">${l.status === 'keine_anrufe' ? '⛔ gesperrt' : '—'}</span>${last}`;
  return `<span class="next-step ns-none" title="Kein nächster Schritt geplant"><i class="fas fa-exclamation-triangle"></i>nicht geplant</span>${last}`;
}

function fmtDateShort(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
}

// ── Mehrfachauswahl für Lead-Tabellen (Admin + Closer) ───────
// Ganze Zeile klickbar, Umschalt+Klick für Bereiche, Sammelaktionen
// (Zuweisen, Status setzen, Archivieren) je nach Konfiguration.
function makeLeadSelection(cfg) {
  const S = { ids: new Set(), mode: false, last: null };
  const $ = id => document.getElementById(id);
  const containers = [].concat(cfg.cardIds || cfg.cardId || []);
  const boards = [].concat(cfg.boardIds || []);
  const setCls = (cls, on) => containers.forEach(id => $(id)?.classList.toggle(cls, on));
  S.visible = () => cfg.visible();
  S.updateBar = () => {
    const n = S.ids.size;
    setCls('has-selection', n > 0);
    const bar = $(cfg.barId); if (bar) bar.style.display = n > 0 ? 'flex' : 'none';
    const c = $(cfg.countId); if (c) c.textContent = n + ' ausgewählt';
  };
  S.sync = () => {
    const nodes = [...document.querySelectorAll(`#${cfg.bodyId} tr.lead-row`)];
    boards.forEach(b => nodes.push(...document.querySelectorAll(`#${b} .pipeline-card[data-id]`)));
    nodes.forEach(el => {
      const on = S.ids.has(parseInt(el.dataset.id));
      el.classList.toggle('is-selected', on);
      const cb = el.querySelector('.lead-cb'); if (cb) cb.checked = on;
    });
    const all = $(cfg.allCbId);
    if (all) { const vis = S.visible(); all.checked = vis.length > 0 && vis.every(l => S.ids.has(l.id)); }
  };
  S.toggle = (id, checked) => { if (checked) S.ids.add(id); else S.ids.delete(id); S.last = id; S.updateBar(); S.sync(); };
  S.toggleAll = (checked) => { S.visible().forEach(l => checked ? S.ids.add(l.id) : S.ids.delete(l.id)); S.updateBar(); S.sync(); };
  S.clear = () => { S.ids.clear(); S.last = null; S.updateBar(); S.sync(); };
  S.toggleMode = (on) => {
    S.mode = typeof on === 'boolean' ? on : !S.mode;
    const btn = $(cfg.modeBtnId);
    if (btn) {
      btn.classList.toggle('is-on', S.mode);
      btn.innerHTML = S.mode ? '<i class="fas fa-check-square"></i> Auswahl beenden' : '<i class="fas fa-check-square"></i> Auswählen';
    }
    const hint = $(cfg.hintId); if (hint) hint.style.display = S.mode ? '' : 'none';
    setCls('select-mode', S.mode);
    if (!S.mode && S.ids.size) S.clear();
  };
  S.rowClick = (e, id) => {
    const selecting = S.mode || S.ids.size > 0 || e.ctrlKey || e.metaKey || e.shiftKey;
    if (!selecting) { cfg.open(id); return; }
    if (e.shiftKey && S.last != null && S.last !== id) {
      const ids = S.visible().map(l => l.id);
      const a = ids.indexOf(S.last), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => S.ids.add(x));
      else S.ids.add(id);
    } else if (S.ids.has(id)) {
      S.ids.delete(id);
    } else {
      S.ids.add(id);
    }
    S.last = id; S.updateBar(); S.sync();
  };
  S.checkCell = (e, id) => {
    e.stopPropagation();
    if (e.target && e.target.tagName === 'INPUT') return; // onchange der Checkbox übernimmt
    S.toggle(id, !S.ids.has(id));
  };
  // Pipeline-Karte: Klick wählt aus, Umschalt+Klick einen Bereich innerhalb der Spalte
  S.cardClick = (e, id) => {
    const selecting = S.mode || S.ids.size > 0 || e.ctrlKey || e.metaKey || e.shiftKey;
    if (!selecting) { cfg.open(id); return; }
    const col = e.currentTarget && e.currentTarget.closest ? e.currentTarget.closest('.pipeline-col-body') : null;
    const order = col ? [...col.querySelectorAll('.pipeline-card[data-id]')].map(c => parseInt(c.dataset.id)) : [];
    const a = order.indexOf(S.last), b = order.indexOf(id);
    if (e.shiftKey && S.last != null && S.last !== id && a >= 0 && b >= 0) {
      order.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => S.ids.add(x));
    } else if (S.ids.has(id)) {
      S.ids.delete(id);
    } else {
      S.ids.add(id);
    }
    S.last = id; S.updateBar(); S.sync();
  };
  // Beim Ziehen einer markierten Karte wandern alle markierten mit
  S.dragIds = (draggedId) => S.ids.has(draggedId) ? [...S.ids] : [draggedId];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  S.assign = async () => {
    const closerId = $(cfg.assignSelectId)?.value;
    if (!closerId) { showToast('Bitte einen Closer auswählen', 'err'); return; }
    if (!S.ids.size) return;
    const n = S.ids.size;
    try {
      await Promise.all([...S.ids].map(id => api('PATCH', `/leads/${id}`, { assigned_to: closerId })));
      showToast(`${plural(n, 'Lead', 'Leads')} zugewiesen ✓`);
      S.clear(); cfg.afterChange();
    } catch(e) { showToast(e.message, 'err'); }
  };
  S.setStatus = async () => {
    const status = $(cfg.statusSelectId)?.value;
    if (!status) { showToast('Bitte einen Status auswählen', 'err'); return; }
    const ids = [...S.ids];
    if (!ids.length) return;
    const grund = await statusGrund(status);          // „passt nicht“: Grund einmal für alle
    if (grund === null) return;
    const results = await Promise.allSettled(ids.map(id => cfg.statusRequest(id, status, grund)));
    const failed = results.filter(r => r.status === 'rejected').length;
    const done = ids.length - failed;
    if (done) showToast(`Status für ${plural(done, 'Lead', 'Leads')} gesetzt ✓`);
    if (failed) showToast(`${plural(failed, 'Lead konnte', 'Leads konnten')} nicht geändert werden`, 'err');
    const sel = $(cfg.statusSelectId); if (sel) sel.value = '';
    S.clear(); cfg.afterChange();
  };
  S.claim = async () => {
    const all = [...S.ids];
    const ids = cfg.claimable ? all.filter(id => cfg.claimable(id)) : all;
    const skipped = all.length - ids.length;
    if (!ids.length) { showToast(skipped ? 'Die ausgewählten Leads sind bereits vergeben' : 'Keine Leads ausgewählt', 'err'); return; }
    const results = await Promise.allSettled(ids.map(id => cfg.claimRequest(id)));
    const failed = results.filter(r => r.status === 'rejected').length;
    const done = ids.length - failed;
    if (done) showToast(`${plural(done, 'Lead', 'Leads')} übernommen ✓${skipped ? ` · ${skipped} bereits vergeben` : ''}`);
    if (failed) showToast(`${plural(failed, 'Lead konnte', 'Leads konnten')} nicht übernommen werden`, 'err');
    S.clear(); cfg.afterChange();
  };
  // Generische Sammelaktion: request(id) pro Lead, optional mit Bestätigung
  S.bulk = async ({ request, confirm, done, failed: failedMsg, filter, nothing }) => {
    const all = [...S.ids];
    const ids = filter ? all.filter(filter) : all;
    const skipped = all.length - ids.length;
    if (!ids.length) { if (all.length) showToast(nothing ? nothing(skipped) : 'Für die Auswahl ist diese Aktion nicht möglich', 'err'); return; }
    if (confirm) {
      const ok = await customConfirm(confirm.message(ids.length, skipped), confirm.opts || {});
      if (!ok) return;
    }
    const results = await Promise.allSettled(ids.map(id => request(id)));
    const failed = results.filter(r => r.status === 'rejected').length;
    const okN = ids.length - failed;
    if (okN && done) showToast(done(okN, skipped));
    if (failed) showToast(failedMsg ? failedMsg(failed) : `${plural(failed, 'Eintrag konnte', 'Einträge konnten')} nicht verarbeitet werden`, 'err');
    S.clear(); cfg.afterChange();
  };
  S.archive = async () => {
    const ids = [...S.ids];
    if (!ids.length) return;
    const ok = await customConfirm(
      `${plural(ids.length, 'Lead', 'Leads')} archivieren?\nDie Leads werden aus der Datenbank ausgeblendet. Kommentare und Erinnerungen bleiben erhalten, im Archiv können sie jederzeit wiederhergestellt werden.`,
      { title: 'Leads archivieren', okLabel: 'Archivieren', danger: true }
    );
    if (!ok) return;
    const results = await Promise.allSettled(ids.map(id => api('DELETE', `/leads/${id}`)));
    const failed = results.filter(r => r.status === 'rejected').length;
    const done = ids.length - failed;
    if (done) showToast(`${plural(done, 'Lead', 'Leads')} archiviert ✓`);
    if (failed) showToast(`${plural(failed, 'Lead konnte', 'Leads konnten')} nicht archiviert werden`, 'err');
    if (cfg.onArchived) cfg.onArchived(ids);
    S.clear(); cfg.afterChange();
  };
  return S;
}

// ── Activity Heartbeat (Closer-Tracking) ─────────────────────
let _clickCount = 0;
let _inactiveTimer = null;
// 30 Minuten: Closer telefonieren oft länger, ohne zu klicken, und Admins arbeiten parallel in sipgate & Co.
const INACTIVITY_MIN = window.INACTIVITY_TIMEOUT || 30;
const INACTIVITY_MS = INACTIVITY_MIN * 60 * 1000;

function resetInactiveTimer() {
  clearTimeout(_inactiveTimer);
  _inactiveTimer = setTimeout(async () => {
    // Im Anrufmodus nie abmelden (Gespräch läuft gerade)
    if (document.getElementById('dialer')?.classList.contains('open')) { resetInactiveTimer(); return; }
    showToast(`Automatisch abgemeldet (${INACTIVITY_MIN} Min. ohne Aktivität)`, 'info');
    try { await api('POST', '/auth/logout', { reason: 'inactivity' }); } catch {}
    Auth.clear();
    setTimeout(() => window.location.href = '/login', 1500);
  }, INACTIVITY_MS);
}

function startActivityTracking() {
  if (!Auth.getToken()) return;

  document.addEventListener('click',     () => { _clickCount++; resetInactiveTimer(); });
  document.addEventListener('mousemove', resetInactiveTimer);
  document.addEventListener('keydown',   resetInactiveTimer);
  document.addEventListener('scroll',    resetInactiveTimer, { passive: true, capture: true });
  // Zurück in den Tab (z. B. aus sipgate): zählt als Aktivität
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resetInactiveTimer(); });
  resetInactiveTimer();

  // Heartbeat every 30s
  setInterval(async () => {
    if (!Auth.getToken()) return;
    try {
      await api('POST', '/auth/heartbeat', { clicks: _clickCount });
      _clickCount = 0;
    } catch {}
  }, 30_000);

  startSessionExpiryWarning();
}

// ── Session expiry warning ────────────────────────────────────
function startSessionExpiryWarning() {
  const token = Auth.getToken();
  if (!token) return;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    if (!payload.exp) return;
    const expiresAt = payload.exp * 1000;
    const delay = expiresAt - 10 * 60 * 1000 - Date.now();
    if (delay > 0) setTimeout(() => _showSessionWarningBanner(expiresAt), delay);
  } catch {}
}

function _showSessionWarningBanner(expiresAt) {
  if (document.getElementById('_sessionWarningBanner')) return;
  const remaining = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
  const banner = document.createElement('div');
  banner.id = '_sessionWarningBanner';
  banner.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:var(--copper);color:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.25);padding:14px 20px;display:flex;align-items:center;gap:14px;font-size:14px;font-weight:500;max-width:90vw;white-space:nowrap';
  banner.innerHTML = `
    <i class="fas fa-clock" style="font-size:18px;flex-shrink:0"></i>
    <span>Deine Session läuft in <strong>${remaining} Minuten</strong> ab.</span>
    <button onclick="logout()" style="background:#fff;color:var(--copper-deep);border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">Jetzt neu anmelden</button>
    <button onclick="document.getElementById('_sessionWarningBanner').remove()" style="background:rgba(255,255,255,0.2);color:#fff;border:none;border-radius:8px;width:28px;height:28px;font-size:16px;cursor:pointer;flex-shrink:0">&times;</button>
  `;
  document.body.appendChild(banner);
}

// ── Sidebar helper ────────────────────────────────────────────
function renderSidebarUser() {
  const user = Auth.getUser();
  if (!user) return;
  const el = document.getElementById('sidebarUser');
  if (el) {
    el.innerHTML = `
      <div class="avatar">${escHtml(user.full_name?.[0]||'?')}</div>
      <div class="sidebar-user-info">
        <div class="sidebar-user-name">${escHtml(user.full_name)}</div>
        <div class="sidebar-user-role">${user.role === 'admin' ? 'Administrator' : 'Closer'}</div>
      </div>
      <div class="sidebar-user-actions">
        <button class="sidebar-icon-btn" id="themeBtn" title="Design wechseln" onclick="toggleTheme()"><i class="fas fa-moon"></i></button>
        <button class="sidebar-icon-btn" title="Einstellungen" onclick="openSettingsModal()"><i class="fas fa-cog"></i></button>
        <button class="sidebar-icon-btn logout-btn" title="Abmelden" onclick="logout()"><i class="fas fa-sign-out-alt"></i></button>
      </div>
    `;
    updateThemeBtn();
  }
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch {}
  Auth.clear();
  window.location.href = '/login';
}

// Hell/Dunkel wird je Benutzer auf dem Server gespeichert und gilt damit auf
// jedem Gerät und nach jeder Anmeldung, bis der Benutzer es wieder umstellt.
function applyTheme(theme) {
  document.body.classList.toggle('dark', theme === 'dark');
  localStorage.setItem('lh_theme', theme === 'dark' ? 'dark' : 'light');
  updateThemeBtn();
}
function initTheme() {
  applyTheme(Auth.getUser()?.theme || localStorage.getItem('lh_theme') || 'light');
  if (!Auth.getToken()) return;
  api('GET', '/auth/me').then(me => {
    if (!me) return;
    const u = Auth.getUser() || {};
    if (me.theme) {
      u.theme = me.theme;
      localStorage.setItem('lh_user', JSON.stringify(u));
      applyTheme(me.theme);
    } else {
      // Noch nichts gespeichert: bisherige Wahl dieses Geräts übernehmen
      api('PATCH', '/auth/theme', { theme: localStorage.getItem('lh_theme') || 'light' }).catch(() => {});
    }
  }).catch(() => {});
}
function toggleTheme() {
  const theme = document.body.classList.contains('dark') ? 'light' : 'dark';
  applyTheme(theme);
  const u = Auth.getUser();
  if (u) { u.theme = theme; localStorage.setItem('lh_user', JSON.stringify(u)); }
  api('PATCH', '/auth/theme', { theme }).catch(() => {});
}
function updateThemeBtn() {
  const btn = document.getElementById('themeBtn');
  if (!btn) return;
  const isDark = document.body.classList.contains('dark');
  btn.title = isDark ? 'Hellmodus' : 'Dunkelmodus';
  const icon = btn.querySelector('i');
  if (icon) {
    icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
  } else {
    btn.textContent = isDark ? '☀️' : '🌙';
  }
}

// ── Pipeline: automatisches Scrollen beim Ziehen an den Rand ──
// Browser scrollen innere Scroll-Bereiche beim nativen Drag & Drop nicht
// zuverlässig mit. Bei schmalen Fenstern liegen Spalten der Pipeline
// außerhalb des sichtbaren Bereichs; hier wird das Board (horizontal) bzw.
// die Spalte (vertikal) nachgeschoben, sobald die Karte nahe am Rand ist.
(function () {
  const EDGE = 64, STEP = 18;
  document.addEventListener('dragover', (e) => {
    if (!e.target || !e.target.closest) return;
    const board = e.target.closest('.pipeline-board');
    if (!board) return;
    if (board.scrollWidth > board.clientWidth) {
      const r = board.getBoundingClientRect();
      if (e.clientX < r.left + EDGE)       board.scrollLeft -= STEP;
      else if (e.clientX > r.right - EDGE) board.scrollLeft += STEP;
    }
    const body = e.target.closest('.pipeline-col-body');
    if (body && body.scrollHeight > body.clientHeight) {
      const b = body.getBoundingClientRect();
      if (e.clientY < b.top + EDGE)         body.scrollTop -= STEP;
      else if (e.clientY > b.bottom - EDGE) body.scrollTop += STEP;
    }
  }, { passive: true });
})();

// ── Wissensdatenbank: gemeinsame Renderer ─────────────────────
function renderTemplateCard(t, a) {
  const inactive = t.is_active !== undefined && !t.is_active;
  const preview = String(t.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return `<div class="tpl-card ${inactive ? 'inactive' : ''}">
    <div class="tpl-card-head">
      <div class="tpl-icon"><i class="fas fa-envelope-open-text"></i></div>
      <div class="tpl-meta">
        <div class="tpl-name">${escHtml(t.name)}</div>
        <div class="tpl-tags">${t.category ? `<span class="tpl-tag cat">${escHtml(t.category)}</span>` : ''}${t.trigger_outcome && typeof MailVorschlag !== 'undefined' ? `<span class="tpl-tag trigger" title="Wird nach diesem Anrufergebnis vorgeschlagen"><i class="fas fa-bolt"></i> ${escHtml(MailVorschlag.label(t.trigger_outcome))}</span>` : ''}${inactive ? '<span class="tpl-tag off">Inaktiv</span>' : ''}</div>
      </div>
    </div>
    <div class="tpl-subject" title="${escHtml(t.subject || '')}">${escHtml(t.subject || '—')}</div>
    <div class="tpl-preview">${preview ? escHtml(preview) : '<span style="color:var(--text3)">Kein Text</span>'}</div>
    ${a ? `<div class="tpl-actions">
      <button class="btn btn-ghost btn-sm" onclick="${a.edit}"><i class="fas fa-edit"></i> Bearbeiten</button>
      <span class="spacer"></span>
      ${a.toggle ? `<button class="btn btn-ghost btn-sm btn-icon" title="${inactive ? 'Aktivieren' : 'Deaktivieren'}" onclick="${a.toggle}"><i class="fas fa-${inactive ? 'eye' : 'eye-slash'}"></i></button>` : ''}
      ${a.remove ? `<button class="btn btn-ghost btn-sm btn-icon" title="Löschen" style="color:var(--red)" onclick="${a.remove}"><i class="fas fa-trash"></i></button>` : ''}
    </div>` : ''}
  </div>`;
}

// ── Angebote & Rechnungen eines Leads (für den betreuenden Closer, nur lesen) ──
const DOK_STATUS = { entwurf: 'In Arbeit', versendet: 'Versendet', angenommen: 'Angenommen', abgelehnt: 'Abgelehnt', abgelaufen: 'Abgelaufen',
  offen: 'Offen', bezahlt: 'Bezahlt', ueberfaellig: 'Überfällig', finalisiert: 'Offen', storniert: 'Storniert', storno: 'Storno' };
async function renderLeadDokumente(leadId, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  try {
    const d = await api('GET', `/lead-dokumente/${leadId}`);
    const eur = v => Number(v || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    const zeile = (art, x, icon, nr, text, betrag, st) => `<button type="button" class="deal-mini" onclick="oeffneLeadPdf(${leadId}, '${art}', '${escHtml(x.id)}')" title="PDF öffnen">
        <span class="deal-mini-main"><b><i class="fas ${icon}" style="color:var(--text3);margin-right:6px"></i>${escHtml(nr)}</b>
        <span class="cell-sub">${escHtml(text || '')}</span><span class="abr-chip s-${escHtml(st)}">${escHtml(DOK_STATUS[st] || st)}</span></span>
        <span class="deal-mini-val">${betrag} <i class="fas fa-file-pdf" style="color:var(--text3);margin-left:4px"></i></span></button>`;
    el.innerHTML = d.angebote.map(a => zeile('angebote', a, 'fa-file-signature', a.nummer, a.betreff, eur(a.brutto) + (a.monatlich ? ` <small>+ ${eur(a.monatlich)}/Mon.</small>` : ''), a.status)).join('')
      + d.rechnungen.map(r => zeile('rechnungen', r, 'fa-file-invoice', r.nummer, r.titel, eur(r.brutto), r.zahlungsstatus || 'offen')).join('')
      || '<div class="panel-empty">Noch kein Angebot. Schieb den Deal auf „Angebot anfordern“, dann schreibt Aleksandra es.</div>';
  } catch (e) { el.innerHTML = `<div class="panel-empty">${escHtml(e.message)}</div>`; }
}
async function oeffneLeadPdf(leadId, art, docId) {
  try {
    const r = await fetch(`/api/lead-dokumente/${leadId}/${art}/${encodeURIComponent(docId)}/pdf`, { headers: { Authorization: 'Bearer ' + Auth.getToken() } });
    if (!r.ok) throw new Error('PDF nicht verfügbar');
    const url = URL.createObjectURL(await r.blob());
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { showToast(e.message, 'err'); }
}

// ── Rücksprachen: gemeinsame Renderer ─────────────────────────
function renderChatListItems(chats, emptyText) {
  if (!chats.length) return `<div class="chat-welcome">
      <div class="chat-welcome-art"><span><i class="fas fa-comment"></i></span><span><i class="fas fa-comment-dots"></i></span></div>
      <h3>Noch keine Rücksprachen</h3>
      <p>${escHtml(emptyText)}</p>
      <button class="btn btn-primary" onclick="openCreateChat()"><i class="fas fa-plus"></i> Neues Gespräch</button>
    </div>`;
  const rel = d => {
    if (!d) return '';
    const min = Math.round((Date.now() - new Date(d)) / 60000);
    if (min < 1) return 'gerade eben';
    if (min < 60) return `vor ${min} Min.`;
    if (min < 1440 && new Date(d).toDateString() === new Date().toDateString()) return new Date(d).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (min < 2880) return 'gestern';
    return fmtDateShort(d);
  };
  const avatars = names => names.slice(0, 3).map((n, i) =>
    `<span class="chat-av c${i}" title="${escHtml(n)}">${escHtml(n.split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase())}</span>`).join('')
    + (names.length > 3 ? `<span class="chat-av more">+${names.length - 3}</span>` : '');
  return '<div class="chat-list">' + chats.map(c => {
    const names = String(c.participants || c.created_by_name || '').split(', ').filter(Boolean);
    const n = Number(c.msg_count || 0);
    const preview = c.last_msg
      ? `<b>${escHtml((c.last_msg_by || '').split(' ')[0])}:</b> ${escHtml(String(c.last_msg).replace(/\s+/g, ' '))}`
      : '<i>Noch keine Nachricht</i>';
    return `<div class="chat-item ${c.is_closed ? 'closed' : ''}" onclick="openChat(${c.id})">
      <div class="chat-avs">${avatars(names.length ? names : ['?'])}</div>
      <div class="chat-main">
        <div class="chat-title"><span class="t">${escHtml(c.title)}</span>${c.is_closed ? '<span class="chat-closed-tag">Beendet</span>' : ''}</div>
        <div class="chat-preview">${preview}</div>
      </div>
      <div class="chat-side-meta">
        <span class="chat-when">${rel(c.last_msg_at || c.created_at)}</span>
        <span class="chat-count" title="${n} Nachrichten"><i class="fas fa-comment"></i> ${n}</span>
      </div>
      <i class="fas fa-chevron-right chat-chevron"></i>
    </div>`;
  }).join('') + '</div>';
}

function renderChatLeadContext(c, openFn) {
  const row = (icon, html) => `<div class="lead-ctx-row"><i class="fas fa-${icon}"></i><span>${html}</span></div>`;
  return `<div class="lead-ctx">
    <div class="lead-ctx-eyebrow">Lead-Kontext</div>
    <div class="lead-ctx-company">${escHtml(c.lead_company || '—')}</div>
    ${c.lead_ceo ? row('user', escHtml(c.lead_ceo)) : ''}
    ${c.lead_phone ? row('phone', `<a href="tel:${escHtml(c.lead_phone)}" class="mono">${escHtml(c.lead_phone)}</a>`) : ''}
    ${c.lead_email ? row('envelope', `<a href="mailto:${escHtml(c.lead_email)}">${escHtml(c.lead_email)}</a>`) : ''}
    ${statusBadge(c.lead_status || 'neu')}
    <button class="btn btn-ghost btn-sm" onclick="${openFn}(${c.lead_id})"><i class="fas fa-external-link-alt"></i> Lead öffnen</button>
  </div>`;
}

function renderChatMessages(msgs, myId) {
  if (!msgs.length) return '<div class="chat-empty"><i class="fas fa-comments"></i>Noch keine Nachrichten. Schreib die erste.</div>';
  return msgs.map(m => {
    const own = m.user_id === myId;
    const initial = escHtml((m.full_name || '?').trim().charAt(0).toUpperCase() || '?');
    return `<div class="msg ${own ? 'own' : ''}">
      <div class="msg-avatar">${initial}</div>
      <div class="msg-body">
        <div class="msg-meta"><b>${escHtml(m.full_name)}</b> · ${fmtDate(m.created_at)}</div>
        <div class="msg-bubble">${escHtml(m.text)}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Filter-Chips (steuern ein verstecktes Select) ─────────────
function chipFilter(btn, selectId, cb) {
  const sel = document.getElementById(selectId);
  if (sel) sel.value = btn.dataset.value || '';
  btn.parentElement.querySelectorAll('.qf-btn').forEach(b => b.classList.toggle('active', b === btn));
  if (typeof cb === 'function') cb();
}
function setChipCounts(containerId, counts) {
  const c = document.getElementById(containerId);
  if (!c) return;
  c.querySelectorAll('.qf-btn').forEach(b => {
    const v = b.dataset.value || '';
    const s = b.querySelector('.qf-count');
    if (s) s.textContent = v ? (counts[v] || 0) : (counts._all || 0);
  });
}

// ── Feedback-Board: gemeinsamer Renderer ──────────────────────
// ── E-Mail: Verlauf + Posteingang (Admin + Closer) ───────────
// Trennt den zitierten Verlauf ("Am … schrieb …", "> …") von der eigentlichen Antwort
function splitQuotedEmail(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const markers = [
    /^\s*Am .{4,120}(schrieb|wrote).{0,120}:\s*$/m,
    /^\s*On .{4,120}wrote:\s*$/m,
    /^\s*-{2,}\s*(Original Message|Ursprüngliche Nachricht|Originalnachricht)\s*-{2,}/mi,
    /^\s*(Von|From):\s.+\n(.*\n){0,3}\s*(Gesendet|Sent|Datum|Date):/mi,
    /^\s*>.*$/m,
  ];
  let cut = -1;
  for (const re of markers) {
    const m = re.exec(t);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut <= 0) return { main: t.trim(), quoted: '' };
  return { main: t.slice(0, cut).trim(), quoted: t.slice(cut).trim() };
}

// Gemeinsamer Renderer für den E-Mail-Verlauf im Lead-Panel.
// replyFn: Name einer globalen Funktion (emailId) → öffnet das Antwort-Fenster
function renderEmailThread(emails, replyFn) {
  if (!emails || !emails.length) return '<div class="mail-empty">Noch keine E-Mails mit diesem Lead.</div>';
  return '<div class="mail-thread">' + emails.map(m => {
    const isOut  = m.direction === 'outbound';
    const date   = m.received_at || m.created_at;
    const who    = isOut ? (m.from_name || 'Gesendet') : (m.from_name ? `${m.from_name} <${m.from_address}>` : (m.from_address || 'Kunde'));
    const { main, quoted } = splitQuotedEmail(m.body_text);
    const unread = !isOut && m.is_read === 0;
    return `<div class="mail-item ${isOut ? 'out' : 'in'} ${unread ? 'unread' : ''}">
      <div class="mail-head">
        <span class="mail-dir"><i class="fas ${isOut ? 'fa-arrow-up' : 'fa-arrow-down'}"></i> ${isOut ? 'Gesendet' : 'Empfangen'}</span>
        ${unread ? '<span class="mail-new">Neu</span>' : ''}
        <span class="mail-when">${fmtDate(date)}</span>
      </div>
      <div class="mail-subject">${escHtml(m.subject || '(kein Betreff)')}</div>
      <div class="mail-from">${isOut ? `von ${escHtml(who)} an ${escHtml(m.to_address || '')}` : `von ${escHtml(who)}`}</div>
      <div class="mail-body">${escHtml(main || '(kein Text)')}</div>
      ${quoted ? `<details class="mail-quoted"><summary>Verlauf anzeigen</summary><div class="mail-body">${escHtml(quoted)}</div></details>` : ''}
      ${!isOut && replyFn ? `<div class="mail-actions"><button class="btn btn-ghost btn-sm" onclick="${replyFn}(${parseInt(m.id)})"><i class="fas fa-reply"></i> Antworten</button></div>` : ''}
    </div>`;
  }).join('') + '</div>';
}

// "Re: …"-Betreff ohne doppeltes Präfix; [NF-…] bleibt erhalten (Zuordnung)
function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^(re|aw|antw)\s*:/i.test(s) ? s : `Re: ${s}`;
}

// Text der Kundenmail als Zitat unter die Antwort setzen
function replyQuoteHtml(mail) {
  const { main } = splitQuotedEmail(mail.body_text);
  const head = `Am ${fmtDate(mail.received_at || mail.created_at)} schrieb ${mail.from_name || mail.from_address}:`;
  return `<div><br></div><div><br></div><div style="color:#59616e">${escHtml(head)}</div>` +
    `<blockquote style="margin:0 0 0 6px;padding-left:10px;border-left:2px solid #cdd5e0;color:#59616e">` +
    escHtml(main).split('\n').map(l => `<div>${l || '<br>'}</div>`).join('') + '</blockquote>';
}

function renderInboxList(rows, emptyText) {
  if (!rows.length) return `<div class="wiki-empty"><i class="fas fa-inbox"></i>${emptyText}</div>`;
  return '<div class="chat-list">' + rows.map(m => {
    const initial = escHtml((m.company || m.from_name || m.from_address || '?').trim().charAt(0).toUpperCase() || '?');
    const unread  = m.is_read === 0;
    const preview = splitQuotedEmail(m.preview).main.replace(/\s+/g, ' ').slice(0, 160);
    return `<div class="chat-item inbox-item ${unread ? 'unread' : ''}" onclick="openInboxMail(${parseInt(m.lead_id)})">
      <div class="chat-avatar">${initial}</div>
      <div class="chat-main">
        <div class="chat-title"><span class="t">${escHtml(m.company || m.from_address || '')}</span>${unread ? '<span class="mail-new">Neu</span>' : ''}</div>
        <div class="inbox-subject">${escHtml(m.subject || '(kein Betreff)')}</div>
        <div class="chat-meta"><span class="t">${escHtml(preview)}</span></div>
      </div>
      <div class="chat-side-meta">
        <span class="chat-when">${fmtDate(m.received_at || m.created_at)}</span>
        <span class="chat-count" title="Absender">${escHtml(m.from_name || m.from_address || '')}</span>
        ${m.assigned_name ? `<span class="chat-count" title="Zuständig"><i class="fas fa-user"></i> ${escHtml(m.assigned_name)}</span>` : ''}
      </div>
      <i class="fas fa-chevron-right chat-chevron"></i>
    </div>`;
  }).join('') + '</div>';
}

// Ungelesen-Badge in der Navigation; meldet neue Mails per Toast
const Inbox = {
  _latest: null,
  _timer: null,
  async refreshBadge() {
    try {
      const r = await api('GET', '/emails/unread-count');
      const badge = document.getElementById('inboxBadge');
      if (badge) {
        badge.textContent = r.unread > 99 ? '99+' : r.unread;
        badge.style.display = r.unread > 0 ? '' : 'none';
      }
      if (this._latest !== null && r.latest_id > this._latest && r.unread > 0) {
        showToast('📩 Neue Kunden-E-Mail im Posteingang');
        if (typeof onInboxChanged === 'function') onInboxChanged();
      }
      this._latest = r.latest_id || 0;
      return r.unread;
    } catch (_) { return 0; }
  },
  start() {
    this.refreshBadge();
    clearInterval(this._timer);
    this._timer = setInterval(() => this.refreshBadge(), 60 * 1000);
  },
  // Beim Öffnen eines Leads: ungelesene Mails als gelesen markieren
  async markLeadRead(lead) {
    if (!lead || !(lead.email_thread || []).some(m => m.direction === 'inbound' && m.is_read === 0)) return;
    try { await api('POST', `/emails/lead/${lead.id}/read`); } catch (_) {}
    this.refreshBadge();
  },
};

// ── Telefonie im Browser (Twilio Voice) ──────────────────────
// Ist Twilio nicht eingerichtet, fallen die Seiten auf den bisherigen Ablauf zurück
// (Nummer per tel:-Link wählen, Anruf danach dokumentieren).
// ── Telefonie über sipgate (Click-to-Dial) ───────────────────
// Der Anruf startet im CRM, klingelt zuerst am sipgate-Telefon des Vertrieblers
// (App, Web-Telefon oder Tischtelefon) und verbindet dann mit dem Kunden.
const Sipgate = {
  config: null,
  async loadConfig() {
    try { this.config = await api('GET', '/sipgate/config'); }
    catch (_) { this.config = { aktiv: false }; }
    return this.config;
  },
  bereit() { return !!(this.config && this.config.aktiv && this.config.bereit); },
  // Eigene Nummer eingetragen: „Anrufen“ öffnet die Telefon-App (Handy, am PC z. B. Smartphone-Link)
  eigen() { return (this.config && this.config.eigen) || null; },
  async anrufen(leadId, label) {
    const r = await api('POST', '/sipgate/anrufen', { leadId });
    showToast(`Dein sipgate-Telefon klingelt – nimm ab, dann wird ${label || 'der Kunde'} angerufen.`);
    return r.id;
  },
};

const Softphone = {
  config: null,
  device: null,
  call: null,
  _timer: null,
  _sdkPromise: null,

  async loadConfig() {
    try { this.config = await api('GET', '/voice/config'); }
    catch (_) { this.config = { enabled: false }; }
    return this.config;
  },
  isEnabled() { return !!(this.config && this.config.enabled); },
  hasCallerId() { return !!(this.config && this.config.effective_caller_id); },
  // Aus dem Browser anrufen geht erst mit Absendernummer. Solange Twilio die
  // Nummern noch prüft, wählen alle über ihr Telefon – der Anruf wird trotzdem erfasst.
  canDial() {
    // Ist sipgate eingerichtet, telefoniert der Vertriebler darüber – nicht über Twilio
    if (typeof Sipgate !== 'undefined' && (Sipgate.bereit() || Sipgate.eigen())) return false;
    return this.isEnabled() && this.hasCallerId();
  },
  hinweisOhneNummer() {
    if (typeof Sipgate !== 'undefined' && Sipgate.eigen()) {
      if (!this._hinweisGezeigt) showToast(`Anruf über dein eigenes Telefon – Kunden sehen ${fmtPhoneDE(Sipgate.eigen())}. Der Anruf wird erfasst.`);
      this._hinweisGezeigt = true;
      return;
    }
    if (typeof Sipgate !== 'undefined' && Sipgate.config && Sipgate.config.aktiv && !Sipgate.config.bereit && !this._hinweisGezeigt) {
      this._hinweisGezeigt = true;
      showToast('Dir ist noch kein sipgate-Telefon zugeordnet – der Anruf läuft über dein Telefon und wird trotzdem erfasst.');
      return;
    }
    if (!this.isEnabled() || this.hasCallerId() || this._hinweisGezeigt) return;
    this._hinweisGezeigt = true;
    showToast('Noch keine Nummer im CRM – der Anruf läuft über dein Telefon und wird trotzdem erfasst.');
  },

  _loadSdk() {
    if (window.Twilio && window.Twilio.Device) return Promise.resolve();
    if (!this._sdkPromise) {
      this._sdkPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/twilio-voice/twilio.min.js';
        s.onload = resolve;
        s.onerror = () => { this._sdkPromise = null; reject(new Error('Telefonie-Modul konnte nicht geladen werden')); };
        document.head.appendChild(s);
      });
    }
    return this._sdkPromise;
  },

  async _ensureDevice() {
    await this._loadSdk();
    if (this.device) return this.device;
    const { token } = await api('POST', '/voice/token');
    const device = new Twilio.Device(token, {
      edge: ['frankfurt', 'dublin'],
      codecPreferences: ['opus', 'pcmu'],
      closeProtection: 'Es läuft noch ein Anruf. Seite wirklich verlassen?',
      logLevel: 'error',
    });
    device.on('tokenWillExpire', async () => {
      try { const r = await api('POST', '/voice/token'); device.updateToken(r.token); } catch (_) {}
    });
    // Fehler nur während eines Gesprächs anzeigen – Verbindungsprobleme im Leerlauf
    // (z.B. Anmeldung für eingehende Anrufe) sollen nicht bei jedem Seitenaufruf stören
    device.on('error', err => {
      if (this.call || this._incoming) showToast('Telefonie: ' + (err.message || err), 'err');
      else console.warn('Telefonie:', err.message || err);
    });
    this.device = device;
    return device;
  },

  // Startet den Anruf. onEnd({ callLogId, answered, durationSec }) wird nach dem Auflegen aufgerufen.
  async dial({ leadId, phone, label, onEnd }) {
    if (this.call) { showToast('Es läuft bereits ein Anruf', 'err'); return; }
    if (!this.hasCallerId()) {
      showToast('Bitte zuerst in den Einstellungen deine Anrufnummer hinterlegen', 'err');
      if (typeof openSettingsModal === 'function') openSettingsModal();
      return;
    }
    let callLogId;
    try {
      const r = await api('POST', `/leads/${leadId}/calls/start`);
      callLogId = r.id;
    } catch (e) { showToast(e.message, 'err'); return; }

    this._showBar(label, phone);
    this._setState('Verbinde …');
    let answeredAt = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const durationSec = answeredAt ? Math.round((Date.now() - answeredAt) / 1000) : 0;
      this.call = null;
      clearInterval(this._timer);
      this._hideBar();
      if (typeof onEnd === 'function') onEnd({ callLogId, answered: !!answeredAt, durationSec });
    };

    try {
      const device = await this._ensureDevice();
      const call = await device.connect({ params: { callLogId: String(callLogId) } });
      this.call = call;
      call.on('ringing', () => this._setState('Klingelt …'));
      call.on('accept', () => {
        // answerOnBridge: "accept" kommt erst, wenn der Kunde abnimmt
        answeredAt = Date.now();
        this._setState('Verbunden', true);
        this._timer = setInterval(() => {
          const s = Math.round((Date.now() - answeredAt) / 1000);
          this._setState(`Verbunden · ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, true);
        }, 1000);
      });
      call.on('disconnect', finish);
      call.on('cancel', finish);
      call.on('reject', finish);
      call.on('error', err => { showToast('Anruf-Fehler: ' + (err.message || err), 'err'); finish(); });
    } catch (e) {
      const msg = /permission|NotAllowed/i.test(String(e && (e.name || e.message)))
        ? 'Mikrofon-Zugriff wurde verweigert. Bitte im Browser erlauben.'
        : (e.message || 'Anruf konnte nicht gestartet werden');
      showToast(msg, 'err');
      finish();
    }
  },

  // ── Eingehende Anrufe (Firmennummer klingelt im Browser) ──
  // onStart(leadId) beim Annehmen, onEnd({ leadId, callLogId, answered, durationSec, phone }) nach dem Auflegen
  async initIncoming({ onStart, onEnd } = {}) {
    if (!this.isEnabled() || this._incomingReady) return;
    this._incomingReady = true;
    this._onIncomingStart = onStart;
    this._onIncomingEnd = onEnd;
    try {
      const device = await this._ensureDevice();
      device.on('incoming', call => this._onIncoming(call));
      await device.register();
    } catch (e) {
      this._incomingReady = false;
      console.warn('Eingehende Anrufe nicht verfügbar:', e.message || e);
    }
  },

  _onIncoming(call) {
    if (this.call) { call.reject(); return; }  // läuft schon ein Gespräch → Team übernimmt
    const p = call.customParameters || new Map();
    const info = {
      callLogId: parseInt(p.get('callLogId')) || null,
      leadId: parseInt(p.get('leadId')) || null,
      company: p.get('company') || '',
      phone: call.parameters?.From || '',
    };
    this._incoming = call;
    let box = document.getElementById('incomingCall');
    if (!box) {
      box = document.createElement('div');
      box.id = 'incomingCall';
      box.className = 'incoming-call';
      document.body.appendChild(box);
    }
    box.innerHTML = `
      <div class="ic-pulse"><i class="fas fa-phone-alt"></i></div>
      <div class="ic-info">
        <div class="ic-eyebrow">Eingehender Anruf</div>
        <div class="ic-name">${escHtml(info.company || info.phone || 'Unbekannt')}</div>
        <div class="ic-phone mono">${escHtml(info.phone)}</div>
      </div>
      <button class="ic-btn ic-reject" onclick="Softphone.rejectIncoming()" title="Ablehnen"><i class="fas fa-phone-slash"></i></button>
      <button class="ic-btn ic-accept" onclick="Softphone.acceptIncoming()" title="Annehmen"><i class="fas fa-phone-alt"></i> Annehmen</button>`;
    box.classList.add('open');
    const close = () => { box.classList.remove('open'); if (this._incoming === call) this._incoming = null; };
    call.on('cancel', close);   // Kollege hat abgenommen oder Anrufer hat aufgelegt
    call.on('reject', close);
    call.on('disconnect', close);
    this._incomingInfo = info;
  },

  async acceptIncoming() {
    const call = this._incoming, info = this._incomingInfo || {};
    if (!call) return;
    document.getElementById('incomingCall')?.classList.remove('open');
    this._incoming = null;
    call.accept();
    this.call = call;
    const startedAt = Date.now();
    this._showBar(info.company, info.phone);
    this._setState('Verbunden', true);
    this._timer = setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      this._setState(`Verbunden · ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, true);
    }, 1000);
    let leadId = info.leadId;
    if (info.callLogId) {
      try { leadId = (await api('POST', '/voice/incoming/accept', { callLogId: info.callLogId })).lead_id || leadId; }
      catch (e) { showToast(e.message, 'err'); }
    }
    if (leadId && typeof this._onIncomingStart === 'function') this._onIncomingStart(leadId);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.call = null;
      clearInterval(this._timer);
      this._hideBar();
      if (typeof this._onIncomingEnd === 'function') {
        this._onIncomingEnd({ leadId, callLogId: info.callLogId, answered: true,
          durationSec: Math.round((Date.now() - startedAt) / 1000), phone: info.phone });
      }
    };
    call.on('disconnect', finish);
    call.on('error', finish);
  },

  rejectIncoming() {
    if (this._incoming) this._incoming.reject();
    document.getElementById('incomingCall')?.classList.remove('open');
    this._incoming = null;
  },

  hangup() {
    if (this.call) this.call.disconnect();
  },
  toggleMute() {
    if (!this.call) return;
    const muted = !this.call.isMuted();
    this.call.mute(muted);
    const btn = document.getElementById('sp-mute');
    if (btn) {
      btn.classList.toggle('active', muted);
      btn.innerHTML = muted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
    }
  },
  toggleKeypad() {
    document.getElementById('sp-keypad')?.classList.toggle('open');
  },
  digit(d) {
    if (this.call) this.call.sendDigits(d);
  },

  _showBar(label, phone) {
    let bar = document.getElementById('softphoneBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'softphoneBar';
      bar.className = 'softphone';
      document.body.appendChild(bar);
    }
    const keys = ['1','2','3','4','5','6','7','8','9','*','0','#'];
    bar.innerHTML = `
      <div class="sp-main">
        <div class="sp-icon"><i class="fas fa-phone-alt"></i></div>
        <div class="sp-info">
          <div class="sp-label">${escHtml(label || phone || '')}</div>
          <div class="sp-sub"><span class="mono">${escHtml(phone || '')}</span> · <span id="sp-state"></span></div>
        </div>
        <button class="sp-btn" id="sp-mute" onclick="Softphone.toggleMute()" title="Stummschalten"><i class="fas fa-microphone"></i></button>
        <button class="sp-btn" onclick="Softphone.toggleKeypad()" title="Tastenfeld"><i class="fas fa-th"></i></button>
        <button class="sp-btn sp-hangup" onclick="Softphone.hangup()" title="Auflegen"><i class="fas fa-phone-slash"></i></button>
      </div>
      <div class="sp-keypad" id="sp-keypad">${keys.map(k => `<button onclick="Softphone.digit('${k}')">${k}</button>`).join('')}</div>`;
    bar.classList.add('open');
  },
  _setState(text, live) {
    const el = document.getElementById('sp-state');
    if (el) el.textContent = text;
    document.getElementById('softphoneBar')?.classList.toggle('live', !!live);
  },
  _hideBar() {
    document.getElementById('softphoneBar')?.classList.remove('open');
  },
};

// ── Einstellungen: eigene Anrufnummer (Caller-ID) ────────────
async function renderCallerIdSettings(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const [cfg, sg] = await Promise.all([Softphone.loadConfig(), Sipgate.loadConfig()]);
  // Mit eigenem Telefon anrufen: gilt vor allem anderen
  const eigen = sg.eigen || '';
  const eigenHtml = `<div class="eigen-tel">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;margin-bottom:8px">
        <input type="checkbox" id="eigenTelAn" ${eigen ? 'checked' : ''} style="accent-color:var(--accent);width:16px;height:16px"
          onchange="document.getElementById('eigenTelBox').style.display=this.checked?'':'none';if(!this.checked)saveEigenesTelefon('${containerId}')">
        <span>Mit meinem eigenen Telefon anrufen</span>
      </label>
      <div id="eigenTelBox" style="${eigen ? '' : 'display:none'}">
        <div style="display:flex;gap:8px;margin-bottom:6px">
          <input type="tel" id="eigenTelNr" class="form-control" placeholder="Meine Nummer, z. B. 0171 1234567" value="${escHtml(eigen ? fmtPhoneDE(eigen) : '')}">
          <button class="btn btn-primary btn-sm" onclick="saveEigenesTelefon('${containerId}')" style="white-space:nowrap"><i class="fas fa-check"></i> Übernehmen</button>
        </div>
        <div class="callerid-hint"><i class="fas fa-info-circle"></i> „Anrufen“ öffnet die Telefon-App: am Handy direkt, am PC z. B. über Smartphone-Link (Windows) oder dein iPhone (Mac). Kunden sehen diese Nummer. Der Anruf wird im CRM erfasst, das Ergebnis trägst du danach ein.</div>
      </div>
    </div>`;
  if (eigen || !cfg.enabled) {
    el.innerHTML = eigenHtml + (eigen ? '' : `<div class="callerid-hint" style="margin-top:8px"><i class="fas fa-info-circle"></i> Telefonie im Browser ist noch nicht eingerichtet. Bis dahin wird über dein Telefon gewählt.</div>`);
    return;
  }
  el.innerHTML = eigenHtml;
  el.insertAdjacentHTML('beforeend', '<div id="' + containerId + '-tw" style="margin-top:12px"></div>');
  renderTwilioSettings(containerId, cfg);
}
async function saveEigenesTelefon(containerId) {
  const an = document.getElementById('eigenTelAn')?.checked;
  const nr = an ? (document.getElementById('eigenTelNr')?.value || '').trim() : '';
  if (an && !nr) return showToast('Bitte deine Nummer eintragen', 'err');
  try {
    await api('PUT', '/users/me/eigenes-telefon', { nummer: nr || null });
    showToast(nr ? 'Gespeichert ✓ – „Anrufen“ läuft jetzt über dein Telefon' : 'Aus – „Anrufen“ läuft wieder über das CRM');
    Softphone._hinweisGezeigt = false;
    renderCallerIdSettings(containerId);
  } catch (e) { showToast(e.message, 'err'); }
}
// Absendernummer für Twilio (Telefonie im Browser), unter dem Block „eigenes Telefon“
async function renderTwilioSettings(containerId, cfg) {
  const el = document.getElementById(containerId + '-tw');
  if (!el) return;
  // Vom Admin zugeteilte NovaFlow-Nummer: nichts einzurichten
  if (cfg.phone_line) {
    el.innerHTML = `<div class="line-current"><span class="line-ic"><i class="fas fa-phone-volume"></i></span>
      <div class="line-main"><b class="mono">${escHtml(fmtPhoneDE(cfg.phone_line))}</b>
      <span>Deine NovaFlow-Nummer: Kunden sehen sie bei deinen Anrufen, Anrufe darauf klingeln bei dir im CRM – im Browser und auf dem Handy.</span></div></div>`;
    return;
  }
  const status = cfg.caller_id
    ? (cfg.caller_id_verified
        ? `<span class="callerid-ok"><i class="fas fa-check-circle"></i> Bestätigt – Kunden sehen diese Nummer</span>`
        : `<span class="callerid-pending"><i class="fas fa-hourglass-half"></i> Noch nicht bestätigt</span>`)
    : (cfg.company_caller_id
        ? `<span class="callerid-hint-inline">Ohne eigene Nummer wird die Firmennummer <span class="mono">${escHtml(cfg.company_caller_id)}</span> angezeigt.</span>`
        : `<span class="callerid-pending">Noch keine Nummer hinterlegt – Anrufe sind erst danach möglich.</span>`);
  el.innerHTML = `
    <div class="form-group" style="margin-bottom:6px">
      <label>Meine Anrufnummer <span style="font-size:11px;color:var(--text3);font-weight:400">— wird beim Kunden angezeigt</span></label>
      <div style="display:flex;gap:8px">
        <input type="tel" id="callerIdInput" class="form-control" placeholder="+49 171 1234567" value="${escHtml(cfg.caller_id || '')}">
        <button class="btn btn-primary btn-sm" id="callerIdSaveBtn" onclick="saveCallerId('${containerId}')" style="white-space:nowrap"><i class="fas fa-check"></i> Übernehmen</button>
      </div>
    </div>
    <div style="font-size:12px;margin-bottom:4px">${status}</div>
    <div id="callerIdVerify"></div>`;
}

let _callerIdPoll = null;
async function saveCallerId(containerId) {
  const input = document.getElementById('callerIdInput');
  const btn = document.getElementById('callerIdSaveBtn');
  const number = input?.value.trim();
  if (!number) { showToast('Bitte eine Nummer eingeben', 'err'); return; }
  btn.disabled = true;
  try {
    const r = await api('PUT', '/voice/caller-id', { number });
    if (r.verified) {
      showToast('Anrufnummer gespeichert ✓');
      await renderCallerIdSettings(containerId);
      return;
    }
    // Einmalige Bestätigung: Twilio ruft die Nummer an, Code am Telefon eintippen
    document.getElementById('callerIdVerify').innerHTML = `
      <div class="callerid-code">
        <div>Dein Telefon <b class="mono">${escHtml(r.number)}</b> klingelt gleich. Nimm ab und tippe diesen Code ein:</div>
        <div class="callerid-digits mono">${escHtml(r.validation_code)}</div>
        <div class="callerid-wait"><i class="fas fa-spinner fa-spin"></i> Warte auf Bestätigung …</div>
      </div>`;
    clearInterval(_callerIdPoll);
    const started = Date.now();
    _callerIdPoll = setInterval(async () => {
      if (Date.now() - started > 3 * 60 * 1000) {
        clearInterval(_callerIdPoll);
        const w = document.querySelector('#callerIdVerify .callerid-wait');
        if (w) w.innerHTML = 'Keine Bestätigung erhalten. Bitte erneut auf „Übernehmen“ klicken.';
        return;
      }
      try {
        const s = await api('GET', '/voice/caller-id/status');
        if (s.verified) {
          clearInterval(_callerIdPoll);
          showToast('Nummer bestätigt ✓ – du kannst jetzt telefonieren');
          await renderCallerIdSettings(containerId);
        }
      } catch (_) {}
    }, 4000);
  } catch (e) {
    showToast(e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Suchfelder vor dem Ausfüllen durch den Browser schützen ──────────────
// Passwort-Manager (Chrome, Safari, iPhone) tragen den gespeicherten
// Benutzernamen gern ins erste Textfeld ein – bei uns das Suchfeld. Deshalb:
// Suchfelder als Suche kennzeichnen, für Passwort-Manager sperren, bis zur
// ersten Berührung schreibgeschützt halten und den eigenen Benutzernamen
// wieder herausnehmen, falls der Browser ihn trotzdem einsetzt.
(function suchfelderSchuetzen() {
  const istSuche = el => el.tagName === 'INPUT' && (el.matches('.search-bar input, .kb-search input, input[type=search]') || /search|suche/i.test(el.id || ''));
  const eigeneNamen = () => {
    try {
      const u = JSON.parse(localStorage.getItem('lh_user') || '{}');
      return [u.username, u.email, u.full_name].filter(Boolean).map(s => String(s).trim().toLowerCase());
    } catch (_) { return []; }
  };
  function schuetze(el) {
    if (el.hasAttribute('data-af-schutz')) return;
    el.setAttribute('data-af-schutz', '');
    if (el.type === 'text') el.type = 'search';
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('name', 'suche-' + Math.random().toString(36).slice(2, 8));
    ['data-lpignore', 'data-1p-ignore', 'data-bwignore', 'data-form-type'].forEach(a => el.setAttribute(a, a === 'data-form-type' ? 'other' : 'true'));
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.spellcheck = false;
    if (!el.readOnly && document.activeElement !== el) {
      el.readOnly = true;
      const frei = () => { el.readOnly = false; };
      ['touchstart', 'mousedown', 'focus', 'keydown'].forEach(ev => el.addEventListener(ev, frei, { once: true, passive: true }));
    }
  }
  function leeren() {
    const namen = eigeneNamen();
    document.querySelectorAll('[data-af-schutz]').forEach(el => {
      if (el.value && document.activeElement !== el && namen.includes(el.value.trim().toLowerCase())) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }
  function alle(root) { (root.querySelectorAll ? root.querySelectorAll('input') : []).forEach(el => { if (istSuche(el)) schuetze(el); }); }
  function start() {
    alle(document);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.tagName === 'INPUT' && istSuche(n)) schuetze(n); else alle(n);
    }))).observe(document.body, { childList: true, subtree: true });
    [300, 1000, 2500, 5000].forEach(ms => setTimeout(leeren, ms));
    window.addEventListener('pageshow', () => setTimeout(leeren, 300));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
