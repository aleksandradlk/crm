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
    if (!this.getToken()) { window.location.href = '/login.html'; return false; }
    return true;
  },
  requireAdmin() {
    if (!this.requireAuth()) return false;
    if (!this.isAdmin()) { window.location.href = '/closer.html'; return false; }
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
    window.location.href = '/login.html';
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

  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function absUrl(s) {
  const v = String(s || '').trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

function statusBadge(status) {
  const labels = {
    neu: 'Neu', kontaktiert: 'Kontaktiert', nicht_erreicht: 'Nicht erreicht',
    kein_interesse: 'Kein Interesse', rueckruf: 'Rückruf', kunde: 'Kunde'
  };
  return `<span class="status-badge s-${status}">${labels[status] || status}</span>`;
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
    const results = await Promise.allSettled(ids.map(id => cfg.statusRequest(id, status)));
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
const INACTIVITY_MS = (window.INACTIVITY_TIMEOUT || 5) * 60 * 1000;

function resetInactiveTimer() {
  clearTimeout(_inactiveTimer);
  _inactiveTimer = setTimeout(async () => {
    showToast('Automatisch abgemeldet (5 Min. Inaktivität)', 'info');
    try { await api('POST', '/auth/logout', { reason: 'inactivity' }); } catch {}
    Auth.clear();
    setTimeout(() => window.location.href = '/login.html', 1500);
  }, INACTIVITY_MS);
}

function startActivityTracking() {
  if (!Auth.getToken()) return;

  document.addEventListener('click',     () => { _clickCount++; resetInactiveTimer(); });
  document.addEventListener('mousemove', resetInactiveTimer);
  document.addEventListener('keydown',   resetInactiveTimer);
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
  window.location.href = '/login.html';
}

function initTheme() {
  if (localStorage.getItem('lh_theme') === 'dark') document.body.classList.add('dark');
  updateThemeBtn();
}
function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('lh_theme', isDark ? 'dark' : 'light');
  updateThemeBtn();
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
        <div class="tpl-tags">${t.category ? `<span class="tpl-tag cat">${escHtml(t.category)}</span>` : ''}${inactive ? '<span class="tpl-tag off">Inaktiv</span>' : ''}</div>
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

function renderWikiFiles(files, containerId, isAdmin) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!files.length) {
    container.innerHTML = `<div class="wiki-empty"><i class="fas fa-folder-open"></i>${isAdmin ? 'Noch keine Dateien hochgeladen. Nutze das Formular rechts.' : 'Noch keine Dateien vorhanden'}</div>`;
    return;
  }
  const jsStr = s => String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  const cats = [...new Set(files.map(f => f.category))];
  container.innerHTML = cats.map(cat => {
    const catFiles = files.filter(f => f.category === cat);
    const cards = catFiles.map(f => {
      const fn = f.filename || '';
      const isImage  = f.mimetype?.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(fn);
      const isPdf    = f.mimetype === 'application/pdf' || /\.pdf$/i.test(fn);
      const isOffice = /\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(fn);
      const ext  = (fn.includes('.') ? fn.split('.').pop() : '').toUpperCase();
      const size = f.size ? (f.size >= 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB') : '';
      const kind = isPdf ? 'pdf' : isImage ? 'img' : isOffice ? 'doc' : '';
      const icon = isPdf ? 'file-pdf' : isImage ? 'file-image' : /\.xlsx?$/i.test(fn) ? 'file-excel' : /\.pptx?$/i.test(fn) ? 'file-powerpoint' : isOffice ? 'file-word' : 'file-alt';
      const meta = [ext, size, fmtDateShort(f.created_at)].filter(Boolean).join(' · ');
      const safeFile = escHtml(jsStr(fn));
      const encName  = encodeURIComponent(f.name || '');
      const actions = [
        `<button class="btn btn-ghost btn-sm btn-icon" title="Vorschau" onclick="wikiFileOpen('${safeFile}','${encName}')"><i class="fas fa-eye"></i></button>`,
        `<button class="btn btn-ghost btn-sm btn-icon" title="Download" onclick="wikiFileOpen('${safeFile}','${encName}',true)"><i class="fas fa-download"></i></button>`,
        isAdmin ? `<button class="btn btn-ghost btn-sm btn-icon" title="Notiz bearbeiten" onclick="openWikiNoteModal(${f.id},'${escHtml(jsStr(f.note))}')"><i class="fas fa-pen"></i></button>` : '',
        isAdmin ? `<button class="btn btn-ghost btn-sm btn-icon" title="Datei austauschen" onclick="openWikiReplaceModal(${f.id},'${escHtml(jsStr(f.name))}')"><i class="fas fa-retweet"></i></button>` : '',
        isAdmin ? `<button class="btn btn-ghost btn-sm btn-icon" title="Löschen" style="color:var(--red)" onclick="deleteWikiFile(${f.id})"><i class="fas fa-trash"></i></button>` : '',
      ].join('');
      return `<div class="file-card">
        <div class="file-icon ${kind}"><i class="fas fa-${icon}"></i></div>
        <div class="file-main">
          <div class="file-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
          <div class="file-meta">${meta}</div>
          ${f.note ? `<div class="file-note"><i class="fas fa-info-circle"></i>${escHtml(f.note)}</div>` : ''}
        </div>
        <div class="file-actions">${actions}</div>
      </div>`;
    }).join('');
    return `<div class="wiki-cat">
      <div class="wiki-cat-head"><i class="fas fa-folder"></i><span class="wiki-cat-name">${escHtml(cat)}</span><span class="badge">${catFiles.length}</span></div>
      <div class="file-grid">${cards}</div>
    </div>`;
  }).join('');
}

// ── Rücksprachen: gemeinsame Renderer ─────────────────────────
function renderChatListItems(chats, emptyText) {
  if (!chats.length) return `<div class="wiki-empty"><i class="fas fa-comments"></i>${emptyText}</div>`;
  return '<div class="chat-list">' + chats.map(c => {
    const initial = escHtml((c.title || '?').trim().charAt(0).toUpperCase() || '?');
    const n = Number(c.msg_count || 0);
    return `<div class="chat-item ${c.is_closed ? 'closed' : ''}" onclick="openChat(${c.id})">
      <div class="chat-avatar">${initial}</div>
      <div class="chat-main">
        <div class="chat-title"><span class="t">${escHtml(c.title)}</span>${c.is_closed ? '<span class="chat-closed-tag">Geschlossen</span>' : ''}</div>
        <div class="chat-meta">${c.participants ? `<span class="t"><i class="fas fa-users" style="margin-right:5px"></i>${escHtml(c.participants)}</span>` : (c.created_by_name ? `<span>von ${escHtml(c.created_by_name)}</span>` : '')}</div>
      </div>
      <div class="chat-side-meta">
        <span class="chat-count"><i class="fas fa-comment"></i> ${n}</span>
        <span class="chat-when">${fmtDate(c.last_msg_at || c.created_at)}</span>
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
const FB_TAGS = {
  offen:          { label: 'Offen',         cls: 'fb-offen' },
  in_planung:     { label: 'In Planung',    cls: 'fb-planung' },
  erledigt:       { label: 'Erledigt',      cls: 'fb-erledigt' },
  nicht_moeglich: { label: 'Nicht möglich', cls: 'fb-nein' },
};
function renderFeedbackCard(f, o = {}) {
  const tag = FB_TAGS[f.tag] || { label: f.tag || '—', cls: '' };
  const isBug = f.type === 'bug';
  let side = '';
  if (o.admin) {
    side = `<div class="fb-admin">
      <select class="form-control" onchange="updateFeedbackTag(${f.id},this.value)">${Object.entries(FB_TAGS).map(([v, t]) => `<option value="${v}"${f.tag === v ? ' selected' : ''}>${t.label}</option>`).join('')}</select>
      <input type="text" class="form-control" placeholder="Antwort / Admin-Notiz …" value="${escHtml(f.admin_note || '')}" onblur="updateFeedbackNote(${f.id},this.value)" onkeydown="if(event.key==='Enter')this.blur()">
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteFeedback(${f.id})"><i class="fas fa-trash"></i> Löschen</button>
    </div>`;
  } else if (o.deleteFn) {
    side = `<div class="fb-admin" style="width:auto"><button class="btn btn-ghost btn-sm btn-icon" title="Löschen" style="color:var(--red)" onclick="${o.deleteFn}(${f.id})"><i class="fas fa-trash"></i></button></div>`;
  }
  return `<div class="fb-card ${tag.cls}">
    <div class="fb-type ${isBug ? 'bug' : 'wunsch'}"><i class="fas fa-${isBug ? 'bug' : 'lightbulb'}"></i></div>
    <div class="fb-main">
      <div class="fb-head">
        <span class="fb-tag ${tag.cls}">${escHtml(tag.label)}</span>
        <span class="fb-kind">${isBug ? 'Bug' : 'Wunsch'}</span>
        <span class="fb-meta">${f.author_name ? escHtml(f.author_name) + ' · ' : ''}${fmtDateShort(f.created_at)}</span>
      </div>
      <div class="fb-title">${escHtml(f.title)}</div>
      ${f.description ? `<div class="fb-desc">${escHtml(f.description)}</div>` : ''}
      ${f.admin_note ? `<div class="fb-note"><i class="fas fa-reply"></i><b>Antwort:</b> ${escHtml(f.admin_note)}</div>` : ''}
    </div>
    ${side}
  </div>`;
}

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
    device.on('error', err => showToast('Telefonie: ' + (err.message || err), 'err'));
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
  const cfg = await Softphone.loadConfig();
  if (!cfg.enabled) {
    el.innerHTML = `<div class="callerid-hint"><i class="fas fa-info-circle"></i> Telefonie im Browser ist noch nicht eingerichtet. Bis dahin wird über dein Telefon gewählt.</div>`;
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

// ── Angebotstool: Wert je Lead (Pipeline-Badges) ─────────────
const fmtEuro = n => (Number(n) || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const LeadWerte = {
  map: {},
  enabled: false,
  _loaded: null,
  load(force) {
    if (this._loaded && !force) return this._loaded;
    this._loaded = api('GET', '/angebote/werte')
      .then(r => { this.enabled = !!r.enabled; this.map = r.werte || {}; return this.map; })
      .catch(() => { this.enabled = false; return this.map; });
    return this._loaded;
  },
  get(leadId) { return this.map[leadId] || null; },
  // Kleines Badge für Karten/Zeilen: offene Angebote bzw. Umsatz
  badge(leadId) {
    const w = this.get(leadId);
    if (!w) return '';
    const parts = [];
    if (w.umsatzGesamt) parts.push(`Umsatz ${fmtEuro(w.umsatzGesamt)}`);
    if (w.angeboteOffen) parts.push(`Angebot offen ${fmtEuro(w.angeboteOffen)}`);
    if (w.monatlich) parts.push(`${fmtEuro(w.monatlich)}/Monat`);
    if (!parts.length) return '';
    const main = w.umsatzGesamt || w.angeboteOffen ? fmtEuro(w.umsatzGesamt || w.angeboteOffen) : `${fmtEuro(w.monatlich)}/M`;
    const cls = w.umsatzGesamt ? 'won' : 'open';
    return `<span class="value-badge ${cls}" title="${escHtml(parts.join(' · '))}"><i class="fas fa-euro-sign"></i>${escHtml(main.replace(/\s?€/, ''))}</span>`;
  },
};

// ── Angebotstool: Bereich „Angebote & Umsatz“ im Lead ────────
const ANGEBOT_STATUS = { entwurf: 'Entwurf', versendet: 'Versendet', angenommen: 'Angenommen', abgelehnt: 'Abgelehnt', abgelaufen: 'Abgelaufen', offen: 'Offen', bezahlt: 'Bezahlt', ueberfaellig: 'Überfällig', storniert: 'Storniert', storno: 'Storno' };
const AngebotsInfo = {
  // Platzhalter, wird nach dem Öffnen des Leads asynchron befüllt
  placeholder(leadId) {
    return `<div class="panel-section" id="angeboteSection-${leadId}" style="display:none">
      <div class="panel-section-title">Angebote &amp; Umsatz</div>
      <div id="angeboteBody-${leadId}"><div class="panel-empty"><i class="fas fa-spinner fa-spin"></i> Lade aus dem Angebotstool …</div></div>
    </div>`;
  },
  async load(lead) {
    const sec = document.getElementById(`angeboteSection-${lead.id}`);
    const body = document.getElementById(`angeboteBody-${lead.id}`);
    if (!sec || !body) return;
    let r;
    try { r = await api('GET', `/angebote/lead/${lead.id}`); }
    catch (e) {
      sec.style.display = '';
      body.innerHTML = `<div class="panel-empty" style="color:var(--red)">${escHtml(e.message)}</div>`;
      return;
    }
    if (!r.enabled) return; // Anbindung nicht eingerichtet → Bereich bleibt unsichtbar
    sec.style.display = '';
    body.innerHTML = this.render(lead, r);
  },
  render(lead, r) {
    const isAdmin = Auth.isAdmin();
    const k = r.kunde;
    if (!k) {
      return `<div class="panel-empty">Noch kein Kunde im Angebotstool.</div>` + (isAdmin
        ? `<div class="panel-row" style="margin-top:8px"><button class="btn btn-primary btn-sm" onclick="AngebotsInfo.uebernehmen(${lead.id}, this)"><i class="fas fa-file-signature"></i> Als Kunde anlegen &amp; Angebot erstellen</button></div>`
        : '');
    }
    const w = k.werte || {};
    const tile = (label, value, cls) => `<div class="av-tile ${cls || ''}"><div class="av-label">${label}</div><div class="av-value">${value}</div></div>`;
    const tiles = [
      tile('Angebote offen', fmtEuro(w.angeboteOffen) + (w.angeboteOffenMonatlich ? `<small> + ${fmtEuro(w.angeboteOffenMonatlich)}/M</small>` : ''), w.angeboteOffen ? 'open' : ''),
      tile('Umsatz bezahlt', fmtEuro(w.umsatzBezahlt), w.umsatzBezahlt ? 'won' : ''),
      tile('Rechnung offen', fmtEuro(w.offenerBetrag), w.ueberfaellig ? 'late' : ''),
      tile('Monatlich', fmtEuro(w.monatlich), w.monatlich ? 'won' : ''),
    ].join('');
    const docRow = (nr, title, date, amount, status) => `<div class="av-doc">
      <div class="av-doc-main"><span class="mono">${escHtml(nr)}</span> ${escHtml(title || '')}<div class="av-doc-sub">${fmtDateOnly(date)}</div></div>
      <div class="av-doc-side"><b>${amount}</b><span class="av-chip s-${escHtml(status)}">${escHtml(ANGEBOT_STATUS[status] || status)}</span></div>
    </div>`;
    const angebote = (k.angebote || []).slice(0, 5).map(a => docRow(a.nummer, a.betreff, a.datum, fmtEuro(a.brutto) + (a.monatlich ? ` + ${fmtEuro(a.monatlich)}/M` : ''), a.status)).join('');
    const rechnungen = (k.rechnungen || []).slice(0, 5).map(x => docRow(x.nummer, x.titel, x.datum, fmtEuro(x.brutto), x.status)).join('');
    const links = r.links;
    return `
      <div class="av-kunde"><i class="fas fa-building"></i> ${escHtml(k.nummer)} · ${escHtml(k.firma)}</div>
      <div class="av-tiles">${tiles}</div>
      ${angebote ? `<div class="av-head">Angebote</div>${angebote}` : ''}
      ${rechnungen ? `<div class="av-head">Rechnungen</div>${rechnungen}` : ''}
      ${!angebote && !rechnungen ? '<div class="panel-empty">Noch keine Angebote oder Rechnungen.</div>' : ''}
      ${links ? `<div class="panel-row" style="margin-top:10px;flex-wrap:wrap">
        <a class="btn btn-primary btn-sm" href="${escHtml(links.neuesAngebot)}" target="_blank" rel="noopener"><i class="fas fa-plus"></i> Neues Angebot</a>
        <a class="btn btn-ghost btn-sm" href="${escHtml(links.angebote)}" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i> Im Angebotstool öffnen</a>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="AngebotsInfo.load(_panelLead)" title="Aktualisieren"><i class="fas fa-sync"></i></button>
      </div>` : ''}`;
  },
  async uebernehmen(leadId, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', `/angebote/lead/${leadId}/kunde`);
      showToast(r.neu ? `Kunde ${r.kunde.nummer} im Angebotstool angelegt ✓` : `Mit Kunde ${r.kunde.nummer} verknüpft ✓`);
      const lead = (typeof _panelLead !== 'undefined' && _panelLead && _panelLead.id === leadId) ? _panelLead : { id: leadId };
      document.getElementById(`angeboteBody-${leadId}`).innerHTML = this.render(lead, { enabled: true, kunde: r.kunde, links: r.links });
      LeadWerte.load(true);
      if (r.links && r.links.neuesAngebot) window.open(r.links.neuesAngebot, '_blank', 'noopener');
    } catch (e) {
      showToast(e.message, 'err');
      if (btn) btn.disabled = false;
    }
  },
};
function fmtDateOnly(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return day && m && y ? `${day}.${m}.${y}` : escHtml(d);
}

// ── Push-Benachrichtigungen (Anrufe, Erinnerungen) aufs Handy ─
// iPhone: nur möglich, wenn das CRM über „Teilen → Zum Home-Bildschirm“ als App
// installiert ist (ab iOS 16.4). Android/Desktop: direkt im Browser.
const PushNotify = {
  supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
  isIos() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); },
  isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; },
  async registration() {
    if (!('serviceWorker' in navigator)) return null;
    return navigator.serviceWorker.register('/sw.js');
  },
  async current() {
    if (!this.supported()) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
  },
  _key(base64) {
    const pad = '='.repeat((4 - base64.length % 4) % 4);
    const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  },
  async enable() {
    const cfg = await api('GET', '/push/config');
    if (!cfg.enabled) throw new Error('Push ist auf dem Server nicht verfügbar');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt (Browser-/Handy-Einstellungen prüfen)');
    const reg = await this.registration();
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this._key(cfg.public_key) });
    await api('POST', '/push/subscribe', { subscription: sub.toJSON() });
  },
  async disable() {
    const sub = await this.current();
    if (sub) {
      await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  },
  // Bereits erlaubte Geräte bei jedem Start beim Server auffrischen
  async refresh() {
    try {
      if (!this.supported() || Notification.permission !== 'granted') return;
      await this.registration();
      const sub = await this.current();
      if (sub) await api('POST', '/push/subscribe', { subscription: sub.toJSON() });
    } catch (_) {}
  },
};

async function renderPushSettings(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!PushNotify.supported()) {
    el.innerHTML = PushNotify.isIos() && !PushNotify.isStandalone()
      ? `<div class="callerid-hint"><i class="fas fa-info-circle"></i> Auf dem iPhone: CRM in Safari öffnen → <b>Teilen</b> → <b>Zum Home-Bildschirm</b>. Danach das CRM über das neue App-Symbol öffnen und hier aktivieren.</div>`
      : `<div class="callerid-hint"><i class="fas fa-info-circle"></i> Dieser Browser unterstützt keine Push-Benachrichtigungen.</div>`;
    return;
  }
  const sub = await PushNotify.current().catch(() => null);
  const on = !!sub && Notification.permission === 'granted';
  el.innerHTML = `
    <div style="font-size:12px;color:var(--text2);margin-bottom:8px">Ruft ein Kunde an, erscheint auf diesem Gerät sofort, wer es ist – mit Status, Zuständigem und offenen Angeboten. Auch Erinnerungen und verpasste Anrufe kommen hier an.</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      ${on
        ? `<span class="callerid-ok"><i class="fas fa-check-circle"></i> Auf diesem Gerät aktiv</span>
           <button class="btn btn-ghost btn-sm" onclick="testPush(this)"><i class="fas fa-bell"></i> Test senden</button>
           <button class="btn btn-ghost btn-sm" onclick="togglePush('${containerId}', false, this)">Deaktivieren</button>`
        : `<button class="btn btn-primary btn-sm" onclick="togglePush('${containerId}', true, this)"><i class="fas fa-mobile-alt"></i> Auf diesem Gerät aktivieren</button>`}
    </div>`;
}
async function togglePush(containerId, on, btn) {
  if (btn) btn.disabled = true;
  try {
    if (on) { await PushNotify.enable(); showToast('Benachrichtigungen aktiviert ✓'); }
    else    { await PushNotify.disable(); showToast('Benachrichtigungen deaktiviert'); }
  } catch (e) { showToast(e.message, 'err'); }
  renderPushSettings(containerId);
}
async function testPush(btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/push/test');
    showToast(r.sent ? `Test an ${r.sent} Gerät(e) gesendet ✓` : 'Kein Gerät erreicht – bitte neu aktivieren', r.sent ? 'ok' : 'err');
  } catch (e) { showToast(e.message, 'err'); }
  if (btn) btn.disabled = false;
}

// Link aus Benachrichtigung: …html?lead=123 → Lead direkt öffnen
function openLeadFromUrl(openFn) {
  const id = parseInt(new URLSearchParams(location.search).get('lead'));
  if (!id) return;
  history.replaceState(null, '', location.pathname);
  openFn(id);
}
// Klick auf Benachrichtigung, während das CRM schon offen ist
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'open-lead' && e.data.leadId && typeof window.__openLeadById === 'function') {
      window.__openLeadById(e.data.leadId);
    }
  });
}
