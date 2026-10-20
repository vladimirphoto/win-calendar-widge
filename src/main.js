const {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, nativeImage,
  safeStorage, systemPreferences, powerMonitor
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const WIN_W = 420;
const WIN_H = 660;
const WIN_MIN_H = 360;

const DEFAULTS = {
  keywords: '', // пусто = все события календаря считаются сменами и красятся цветом студии
  clientId: '',
  clientSecret: '',
  autostart: true,
  alwaysOnTop: false,
  locked: false,
  onlyMine: false, // true = показывать только события, подходящие под ключевые слова
  opacity: 0.92,
  bounds: null
};

let settings = { ...DEFAULTS };
let win = null;
let tray = null;
let quitting = false;
let accessToken = null;      // только в памяти
let accessExpiresAt = 0;
let refreshToken = null;     // хранится зашифрованным (DPAPI через safeStorage)
let loginInProgress = false;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const tokenFile = () => path.join(app.getPath('userData'), 'token.bin');
const iconPath = path.join(__dirname, '..', 'build', 'icon.png');

/* ---------- настройки ---------- */
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...DEFAULTS, ...raw };
  } catch { settings = { ...DEFAULTS }; }
}
function saveSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) { console.error('settings save failed', e); }
}
function publicSettings() {
  const { clientSecret, ...rest } = settings;
  return { ...rest, hasSecret: !!clientSecret, packaged: app.isPackaged };
}

/* ---------- токен ---------- */
function loadRefreshToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    refreshToken = safeStorage.decryptString(fs.readFileSync(tokenFile()));
  } catch { refreshToken = null; }
}
function persistRefreshToken() {
  try {
    if (!refreshToken) { fs.rmSync(tokenFile(), { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable()) return; // без шифрования на диск не пишем
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(tokenFile(), safeStorage.encryptString(refreshToken));
  } catch (e) { console.error('token save failed', e); }
}
function clearAuth() {
  accessToken = null; accessExpiresAt = 0; refreshToken = null;
  persistRefreshToken();
  refreshTray();
}

/* ---------- Google OAuth (loopback + PKCE) ---------- */
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function tokenRequest(extra) {
  const body = new URLSearchParams({ client_id: settings.clientId, ...extra });
  if (settings.clientSecret) body.set('client_secret', settings.clientSecret);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error_description || j.error || ('HTTP ' + r.status));
    err.code = j.error;
    throw err;
  }
  accessToken = j.access_token;
  accessExpiresAt = Date.now() + (j.expires_in || 3600) * 1000;
  if (j.refresh_token) { refreshToken = j.refresh_token; persistRefreshToken(); }
}

// Поднимает одноразовый локальный сервер, который ловит ответ Google с кодом.
// Возвращает порт, промис с кодом и функцию отмены.
function startLoopback(expectedState) {
  return new Promise((resolveStart, rejectStart) => {
    let finish, fail, timer;
    const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    result.catch(() => {}); // не считать необработанным, если вход отменили раньше

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404).end(); return; }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      const ok = !!code && u.searchParams.get('state') === expectedState;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Календарь</title>
<body style="font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f3f3f3;color:#1b1b1b">
<div style="text-align:center"><h2>${ok ? 'Готово ✓' : 'Не удалось войти'}</h2>
<p>${ok ? 'Можно закрыть эту вкладку и вернуться к виджету.' : 'Закройте вкладку и попробуйте снова.'}</p></div></body>`);
      clearTimeout(timer);
      server.close();
      if (ok) finish(code); else fail(new Error(err || 'Вход отменён'));
    });

    const cancel = () => { clearTimeout(timer); server.close(); };
    server.on('error', e => { rejectStart(e); fail(e); });
    server.listen(0, '127.0.0.1', () => {
      timer = setTimeout(() => { server.close(); fail(new Error('Время ожидания входа истекло')); }, 3 * 60 * 1000);
      resolveStart({ port: server.address().port, result, cancel });
    });
  });
}

async function login() {
  if (!settings.clientId) throw new Error('Сначала укажите Client ID в настройках');
  if (loginInProgress) throw new Error('Вход уже выполняется');
  loginInProgress = true;
  try {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { port, result: codePromise, cancel } = await startLoopback(state);
    const redirect = `http://127.0.0.1:${port}`;
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: settings.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent'
    });
    try { await shell.openExternal(authUrl); }
    catch (e) { cancel(); throw e; }
    const code = await codePromise;
    await tokenRequest({
      code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code'
    });
    refreshTray();
  } finally { loginInProgress = false; }
}

async function getAccessToken() {
  if (accessToken && accessExpiresAt - 60000 > Date.now()) return accessToken;
  if (!refreshToken) { const e = new Error('Нужен вход'); e.code = 'NOT_AUTH'; throw e; }
  try {
    await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  } catch (e) {
    if (e.code === 'invalid_grant') { clearAuth(); const ne = new Error('Сессия истекла, войдите снова'); ne.code = 'NOT_AUTH'; throw ne; }
    throw e;
  }
  return accessToken;
}

async function gget(url, retry = true) {
  const token = await getAccessToken();
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401 && retry) { accessToken = null; return gget(url, false); }
  if (!r.ok) throw new Error('Google API: HTTP ' + r.status);
  return r.json();
}

async function fetchEvents(timeMin, timeMax) {
  const cl = await gget('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader');
  const cals = (cl.items || []).filter(c => c.selected !== false);
  // палитра цветов событий («метки» Google): colorId -> hex
  let eventPalette = {};
  try { eventPalette = (await gget('https://www.googleapis.com/calendar/v3/colors')).event || {}; } catch {}
  const out = [];
  await Promise.all(cals.map(async c => {
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({
        singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeMin, timeMax
      });
      if (pageToken) q.set('pageToken', pageToken);
      const data = await gget(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${q}`);
      for (const ev of data.items || []) {
        if (ev.status === 'cancelled' || !ev.start || !ev.end) continue;
        if ((ev.attendees || []).some(a => a.self && a.responseStatus === 'declined')) continue;
        out.push({
          id: ev.id,
          title: ev.summary || '(без названия)',
          allDay: !!ev.start.date,
          start: ev.start.dateTime || ev.start.date,
          end: ev.end.dateTime || ev.end.date,
          // цвет метки события, если задан, иначе цвет самого календаря
          color: (ev.colorId && eventPalette[ev.colorId]?.background) || c.backgroundColor || null,
          calendar: c.summaryOverride || c.summary || ''
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
  }));
  return out;
}

/* ---------- окно ---------- */
function visibleOnSomeDisplay(x, y) {
  return screen.getAllDisplays().some(d => {
    const b = d.workArea;
    return x + 80 > b.x && x < b.x + b.width - 80 && y + 80 > b.y && y < b.y + b.height - 80;
  });
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  let x = wa.x + wa.width - WIN_W - 8;
  let y = wa.y + 8;
  if (settings.bounds && visibleOnSomeDisplay(settings.bounds.x, settings.bounds.y)) {
    x = settings.bounds.x; y = settings.bounds.y;
  }

  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, x, y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  let moveTimer;
  win.on('move', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [bx, by] = win.getPosition();
      settings.bounds = { x: bx, y: by };
      saveSettings();
    }, 400);
  });
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); refreshTray(); } });
  win.on('show', refreshTray);
  win.on('hide', refreshTray);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------- автозапуск / поведение ---------- */
function applyAutostart() {
  if (!app.isPackaged) return; // из исходников не регистрируем голый electron.exe
  try {
    // у portable-версии execPath указывает во временную папку, настоящий путь к exe лежит в этой переменной
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({ openAtLogin: !!settings.autostart, path: exe });
  } catch (e) { console.error('autostart failed', e); }
}
function applyWindowBehavior() {
  if (!win) return;
  win.setAlwaysOnTop(!!settings.alwaysOnTop);
}

function updateSettings(patch) {
  const next = { ...settings };
  let authReset = false;
  if (typeof patch.keywords === 'string') next.keywords = patch.keywords.slice(0, 200);
  if (typeof patch.clientId === 'string') {
    const v = patch.clientId.trim().slice(0, 300);
    if (v !== next.clientId) authReset = true;
    next.clientId = v;
  }
  if (typeof patch.clientSecret === 'string') {
    const v = patch.clientSecret.trim().slice(0, 300);
    if (v !== next.clientSecret) authReset = true;
    next.clientSecret = v;
  }
  for (const k of ['autostart', 'alwaysOnTop', 'locked', 'onlyMine']) {
    if (typeof patch[k] === 'boolean') next[k] = patch[k];
  }
  if (typeof patch.opacity === 'number' && isFinite(patch.opacity)) {
    next.opacity = Math.min(1, Math.max(0.4, patch.opacity));
  }
  settings = next;
  saveSettings();
  if (authReset) clearAuth();
  applyAutostart();
  applyWindowBehavior();
  refreshTray();
  send('settings:changed', publicSettings());
}

/* ---------- трей ---------- */
function refreshTray() {
  if (!tray) return;
  const visible = win && win.isVisible();
  const menu = Menu.buildFromTemplate([
    { label: visible ? 'Скрыть виджет' : 'Показать виджет', click: toggleWindow },
    { label: 'Обновить события', click: () => send('app:refresh') },
    { type: 'separator' },
    {
      label: 'Запускать при старте Windows', type: 'checkbox', checked: !!settings.autostart,
      click: i => updateSettings({ autostart: i.checked })
    },
    {
      label: 'Поверх всех окон', type: 'checkbox', checked: !!settings.alwaysOnTop,
      click: i => updateSettings({ alwaysOnTop: i.checked })
    },
    {
      label: 'Закрепить положение', type: 'checkbox', checked: !!settings.locked,
      click: i => updateSettings({ locked: i.checked })
    },
    { type: 'separator' },
    refreshToken
      ? { label: 'Выйти из Google', click: () => { clearAuth(); send('app:authChanged', false); } }
      : { label: 'Войти в Google', click: () => { win?.show(); send('app:login'); } },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 });
  tray = new Tray(img);
  tray.setToolTip('Календарь');
  tray.on('click', toggleWindow);
  refreshTray();
}

/* ---------- IPC ---------- */
function accentHex() {
  try {
    const c = systemPreferences.getAccentColor(); // RRGGBBAA
    if (c && c.length >= 6) return '#' + c.slice(0, 6);
  } catch {}
  return '#0067c0';
}

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    if (patch && typeof patch === 'object') updateSettings(patch);
    return publicSettings();
  });
  ipcMain.handle('auth:status', () => ({ loggedIn: !!refreshToken }));
  ipcMain.handle('auth:login', async () => {
    try { await login(); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message || String(e) }; }
  });
  ipcMain.handle('auth:logout', () => { clearAuth(); return { ok: true }; });
  ipcMain.handle('events:get', async (_e, range) => {
    try {
      const from = new Date(range?.from), to = new Date(range?.to);
      if (isNaN(from) || isNaN(to) || to - from > 1000 * 3600 * 24 * 200) throw new Error('Некорректный период');
      const events = await fetchEvents(from.toISOString(), to.toISOString());
      return { ok: true, events };
    } catch (e) {
      return { ok: false, code: e.code || 'ERR', message: e.message || String(e) };
    }
  });
  ipcMain.handle('sys:accent', () => accentHex());
  ipcMain.on('window:hide', () => win?.hide());
  ipcMain.on('window:fit', (_e, h) => {
    if (!win || win.isDestroyed() || typeof h !== 'number' || !isFinite(h)) return;
    const height = Math.round(Math.min(WIN_H, Math.max(WIN_MIN_H, h)));
    const b = win.getBounds();
    if (b.height === height) return;
    const wa = screen.getDisplayMatching(b).workArea;
    const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - height));
    win.setBounds({ x: b.x, y, width: WIN_W, height });
  });
}

/* ---------- запуск ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(() => {
    loadSettings();
    loadRefreshToken();
    registerIpc();
    createWindow();
    createTray();
    applyAutostart();

    try {
      systemPreferences.on('accent-color-changed', () => send('sys:accent', accentHex()));
    } catch {}
    powerMonitor.on('resume', () => setTimeout(() => send('app:refresh'), 4000));
    powerMonitor.on('unlock-screen', () => send('app:refresh'));
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* живём в трее */ });
}
