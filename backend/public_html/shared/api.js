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
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(7,32,73,0.35);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px';
      overlay.innerHTML = `
        <div id="_customConfirmBox" style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.28);width:100%;max-width:420px;padding:28px 28px 24px;display:flex;flex-direction:column;gap:0">
          <div id="_customConfirmTitle" style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:12px"></div>
          <div id="_customConfirmMsg"   style="font-size:13px;color:var(--text2);line-height:1.6;margin-bottom:22px;white-space:pre-line"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
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
  if (days >= 30) return `<span style="background:#ef4444;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;white-space:nowrap;vertical-align:middle" title="${days} Tage keine Aktivität"><i class="fas fa-fire"></i> ${days}T</span>`;
  if (days >= 14) return `<span style="background:#f59e0b;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;white-space:nowrap;vertical-align:middle" title="${days} Tage keine Aktivität"><i class="fas fa-clock"></i> ${days}T</span>`;
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
  banner.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:#d97706;color:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.25);padding:14px 20px;display:flex;align-items:center;gap:14px;font-size:14px;font-weight:500;max-width:90vw;white-space:nowrap';
  banner.innerHTML = `
    <i class="fas fa-clock" style="font-size:18px;flex-shrink:0"></i>
    <span>Deine Session läuft in <strong>${remaining} Minuten</strong> ab.</span>
    <button onclick="logout()" style="background:#fff;color:#92400e;border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">Jetzt neu anmelden</button>
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

// ── Browser-Telefonie (Twilio Voice SDK) ───────────────────────
let _voiceEnabledCache = null;
let _twilioDevice       = null;
let _activeTwilioCall   = null;
let _softphoneTimer     = null;

async function voiceIsEnabled() {
  if (_voiceEnabledCache !== null) return _voiceEnabledCache;
  try {
    const r = await api('GET', '/voice/status');
    _voiceEnabledCache = !!r.enabled;
  } catch { _voiceEnabledCache = false; }
  return _voiceEnabledCache;
}

async function ensureTwilioDevice() {
  if (_twilioDevice) return _twilioDevice;
  if (typeof Twilio === 'undefined' || !Twilio.Device)
    throw new Error('Telefonie-Modul konnte nicht geladen werden');
  const { token } = await api('GET', '/voice/token');
  _twilioDevice = new Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'] });
  _twilioDevice.on('tokenWillExpire', async () => {
    try { const r = await api('GET', '/voice/token'); _twilioDevice.updateToken(r.token); } catch {}
  });
  _twilioDevice.on('error', e => showToast('Telefonie-Fehler: ' + (e.message || e), 'err'));
  return _twilioDevice;
}

// Startet einen Anruf im Browser. Löst mit { durationSeconds } auf, sobald das Gespräch
// beendet ist. Wirft einen Error, wenn kein Browser-Anruf möglich ist — der Aufrufer soll
// in dem Fall auf die bisherige manuelle Anruf-Dokumentation zurückfallen.
async function softphoneStartCall(phoneNumber) {
  const me = Auth.getUser();
  if (!me?.caller_number)
    throw new Error('Keine Absender-Rufnummer eingestellt (Einstellungen → Anrufen im Browser)');
  const device = await ensureTwilioDevice();
  if (device.state !== 'registered') await device.register();
  const call = await device.connect({ params: { To: phoneNumber, CallerId: me.caller_number } });
  _activeTwilioCall = call;
  _showSoftphoneBar(phoneNumber);

  const startedAt = Date.now();
  return new Promise(resolve => {
    const finish = () => {
      _activeTwilioCall = null;
      _hideSoftphoneBar();
      resolve({ durationSeconds: Math.round((Date.now() - startedAt) / 1000) });
    };
    call.on('accept',     () => _setSoftphoneStatus('Verbunden'));
    call.on('disconnect', finish);
    call.on('cancel',     finish);
    call.on('reject',     finish);
    call.on('error', e => { showToast('Anruf-Fehler: ' + (e.message || e), 'err'); finish(); });
  });
}

function softphoneHangup() {
  if (_activeTwilioCall) _activeTwilioCall.disconnect();
}

function softphoneToggleMute() {
  if (!_activeTwilioCall) return;
  const muted = !_activeTwilioCall.isMuted();
  _activeTwilioCall.mute(muted);
  const btn = document.getElementById('_softphoneMuteBtn');
  if (btn) btn.innerHTML = muted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
}

function _setSoftphoneStatus(text) {
  const el = document.getElementById('_softphoneStatus');
  if (el) el.textContent = text;
}

function _showSoftphoneBar(phoneNumber) {
  let bar = document.getElementById('_softphoneBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = '_softphoneBar';
    bar.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99999;background:var(--bg2);border:1px solid var(--border2);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.3);padding:12px 18px;display:flex;align-items:center;gap:14px;font-size:14px';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <i class="fas fa-phone-volume" style="color:var(--green)"></i>
    <div>
      <div style="font-weight:700" id="_softphoneStatus">Rufe an…</div>
      <div style="font-size:12px;color:var(--text3);font-family:'JetBrains Mono',monospace">${escHtml(phoneNumber)} · <span id="_softphoneTime">00:00</span></div>
    </div>
    <button id="_softphoneMuteBtn" onclick="softphoneToggleMute()" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;width:36px;height:36px;cursor:pointer;color:var(--text2)" title="Stummschalten"><i class="fas fa-microphone"></i></button>
    <button onclick="softphoneHangup()" style="background:var(--red);border:none;border-radius:8px;width:36px;height:36px;cursor:pointer;color:#fff" title="Auflegen"><i class="fas fa-phone-slash"></i></button>
  `;
  bar.style.display = 'flex';
  const start = Date.now();
  clearInterval(_softphoneTimer);
  _softphoneTimer = setInterval(() => {
    const el = document.getElementById('_softphoneTime');
    if (!el) return;
    const s = Math.round((Date.now() - start) / 1000);
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function _hideSoftphoneBar() {
  clearInterval(_softphoneTimer);
  const bar = document.getElementById('_softphoneBar');
  if (bar) bar.style.display = 'none';
}

// ── Absender-Rufnummer (Caller ID) — Einstellungen ─────────────
async function loadCallerIdOptions(selectEl, currentValue) {
  selectEl.innerHTML = '<option value="">Lädt…</option>';
  try {
    const list = await api('GET', '/voice/caller-ids');
    const opts = ['<option value="">— keine ausgewählt —</option>'];
    if (currentValue && !list.some(n => n.phone_number === currentValue)) {
      opts.push(`<option value="${escHtml(currentValue)}" selected>${escHtml(currentValue)}</option>`);
    }
    opts.push(...list.map(n =>
      `<option value="${escHtml(n.phone_number)}" ${n.phone_number === currentValue ? 'selected' : ''}>${escHtml(n.phone_number)} (${escHtml(n.type)})</option>`
    ));
    selectEl.innerHTML = opts.join('');
  } catch {
    selectEl.innerHTML = '<option value="">Nummern konnten nicht geladen werden</option>';
  }
}

async function startCallerIdVerification(phoneInputId, resultElId) {
  const input    = document.getElementById(phoneInputId);
  const resultEl = document.getElementById(resultElId);
  const phone    = input.value.trim();
  if (!phone) return;
  resultEl.textContent = 'Starte Verifizierung…';
  try {
    const r = await api('POST', '/voice/caller-ids/verify', { phone_number: phone });
    resultEl.innerHTML = `Twilio ruft dich jetzt unter <b>${escHtml(r.phone_number)}</b> an. Abnehmen und den vorgelesenen Code über die Tastatur bestätigen: <b style="font-size:16px;letter-spacing:2px">${escHtml(r.validation_code)}</b>`;
    showToast('Verifizierungsanruf gestartet ✓');
  } catch(e) {
    resultEl.textContent = e.message;
  }
}
