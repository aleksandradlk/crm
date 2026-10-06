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
  if (days >= 30) return `<span style="background:var(--red);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;white-space:nowrap;vertical-align:middle" title="${days} Tage keine Aktivität"><i class="fas fa-fire"></i> ${days}T</span>`;
  if (days >= 14) return `<span style="background:var(--amber);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;white-space:nowrap;vertical-align:middle" title="${days} Tage keine Aktivität"><i class="fas fa-clock"></i> ${days}T</span>`;
  return '';
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function fmtDateShort(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
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
