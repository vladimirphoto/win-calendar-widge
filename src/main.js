const {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, nativeImage,
  safeStorage, systemPreferences, powerMonitor, Notification
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFile } = require('child_process');
const EMBEDDED = require('./google-client');
const { createUpdater } = require('./updater');
const UPDATE_CFG = require('./update-config');

// Идентификатор приложения для уведомлений Windows; название и значок для заголовка уведомления регистрируются в реестре (registerToastIdentity)
const APP_ID = 'CalendarWidget';
const APP_TITLE = 'Календарь';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const WIN_W = 420;
const WIN_H = 660;
const WIN_MIN_H = 300;
const CACHE_RANGES = 8;          // сколько периодов держать в офлайн-кэше
const NOTIFY_HORIZON = 7 * 24 * 3600 * 1000;

const DEFAULTS = {
  keywords: '', // ваше имя в названиях смен; пусто = чистый календарь без отметок смен
  clientId: '', // свой Client ID (старые настройки); пусто = используется вшитый
  autostart: true,
  alwaysOnTop: false,
  locked: false,
  onlyMine: false, // true = показывать только события, подходящие под ключевые слова
  opacity: 0.92,
  autoUpdate: true, // сам скачивать и ставить новые версии
  pinVersion: '',   // версия, на которой остаёмся (после отката или «Оставить эту версию»); новые не ставятся автоматически
  pinKept: false,   // true = пользователь подтвердил: новые версии в списке скрыты
  lastUpdateTry: 0, // когда последний раз пробовали автоустановку (защита от зацикливания)
  notify: true,    // уведомление Windows перед сменой
  notifyEve: '20:00', // для смен «на весь день»: во сколько напомнить накануне
  notifyHours: 2,  // за сколько часов
  dayPay: {},      // сумма за конкретный день и студию: { '2026-10-22|#0b8043': 12000 }, заменяет ставку по умолчанию
  rates: {},       // ставка за смену по студиям: { '#0b8043': 25000 }, ключ = цвет метки
  goalOn: false,   // панель «цель по заработку»
  goal: 0,         // цель на месяц, ₸ (0 = не задана)
  statsOn: false,  // панель «статистика по студиям»
  freeOn: false,   // подсветка серий свободных дней
  freeMin: 3,      // от скольких дней подряд считать серию
  advance: {},     // аванс по половинам месяца: { '2026-10|first': 50000, '2026-10|second': 30000 }, вычитается из заработка
  payPeriod: 'month', // за какой период показывать заработок: 'month' весь месяц | 'first' 1–15 | 'second' 16–конец
  theme: 'system', // 'system' | 'light' | 'dark' | 'glass'
  glassBlur: 20,   // размытие обоев под «Стеклом», px
  bounds: null
};

let settings = { ...DEFAULTS };
let customSecret = '';       // secret от своего Client ID (старые настройки), хранится зашифрованным
let secretPlain = false;     // true, если шифрование недоступно и secret остался в settings.json
let win = null;
let tray = null;
let quitting = false;
let accessToken = null;      // только в памяти
let accessExpiresAt = 0;
let refreshToken = null;     // хранится зашифрованным (DPAPI через safeStorage)
let loginInProgress = false;

app.setAppUserModelId(APP_ID); // без этого Windows не показывает уведомления от exe

const dataPath = name => path.join(app.getPath('userData'), name);
const settingsFile = () => dataPath('settings.json');
const tokenFile = () => dataPath('token.bin');
const secretFile = () => dataPath('secret.bin');
const cacheFile = () => dataPath('events-cache.bin');
const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
// значок для уведомлений: файл внутри asar системе недоступен, поэтому отдаём картинкой из памяти
const toastIcon = () => nativeImage.createFromPath(iconPath);

/* ---------- название и значок в заголовке уведомлений Windows ---------- */
const AUMID_KEY = 'HKCU\\Software\\Classes\\AppUserModelId\\' + APP_ID;
const regRun = args => new Promise(res => execFile('reg', args, { windowsHide: true, timeout: 8000 }, err => res(!err)));
async function registerToastIdentity() {
  if (process.platform !== 'win32') return;
  try {
    const icon = dataPath('icon.png');
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(icon, fs.readFileSync(iconPath));
    await regRun(['add', AUMID_KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', APP_TITLE, '/f']);
    await regRun(['add', AUMID_KEY, '/v', 'IconUri', '/t', 'REG_SZ', '/d', icon, '/f']);
  } catch (e) { console.error('toast identity failed', e); }
}
async function unregisterToastIdentity() {
  if (process.platform === 'win32') await regRun(['delete', AUMID_KEY, '/f']);
}

/* ---------- настройки ---------- */
function readSecret() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(fs.readFileSync(secretFile()));
  } catch { return ''; }
}
function writeSecret(value) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(secretFile(), safeStorage.encryptString(value));
    return true;
  } catch (e) { console.error('secret save failed', e); return false; }
}
function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch {}
  const { clientSecret: legacySecret, ...rest } = raw;
  settings = { ...DEFAULTS, ...rest };
  if (!settings.rates || typeof settings.rates !== 'object' || Array.isArray(settings.rates)) settings.rates = {};
  if (!['month', 'first', 'second'].includes(settings.payPeriod)) settings.payPeriod = 'month';
  if (typeof settings.pinVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(settings.pinVersion)) settings.pinVersion = '';
  settings.pinKept = !!settings.pinKept && !!settings.pinVersion;
  // фиксация действует только пока запущена эта версия: если exe заменили вручную, снимаем её
  if (settings.pinVersion && app.isPackaged && settings.pinVersion !== app.getVersion()) { settings.pinVersion = ''; settings.pinKept = false; }
  if (!settings.advance || typeof settings.advance !== 'object' || Array.isArray(settings.advance)) settings.advance = {};
  delete settings.scale; // убрано: размер виджета не настраивается
  delete settings.studioNames; // убрано: имя задаётся одним полем «Что считать сменой»
  if (!settings.dayPay || typeof settings.dayPay !== 'object' || Array.isArray(settings.dayPay)) settings.dayPay = {};
  customSecret = readSecret();
  // миграция: раньше secret лежал в settings.json открытым текстом
  if (legacySecret && typeof legacySecret === 'string') {
    if (!customSecret) customSecret = legacySecret;
    if (!writeSecret(customSecret)) secretPlain = true;
    saveSettings();
  }
}
function saveSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const out = secretPlain && customSecret ? { ...settings, clientSecret: customSecret } : settings;
    fs.writeFileSync(settingsFile(), JSON.stringify(out, null, 2));
  } catch (e) { console.error('settings save failed', e); }
}
function publicSettings() {
  const { clientId, ...rest } = settings;
  return { ...rest, customClient: !!clientId, packaged: app.isPackaged, canDeleteExe: !!process.env.PORTABLE_EXECUTABLE_FILE, version: app.getVersion() };
}
// какой OAuth-клиент использовать: свой из старых настроек, иначе вшитый
function creds() {
  if (settings.clientId) return { id: settings.clientId, secret: customSecret };
  return { id: EMBEDDED.clientId, secret: EMBEDDED.clientSecret };
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

// fetch, который при отсутствии сети бросает ошибку с кодом OFFLINE (тогда виджет покажет кэш)
async function net(url, opts) {
  try { return await fetch(url, opts); }
  catch { const e = new Error('Нет связи с интернетом'); e.code = 'OFFLINE'; throw e; }
}

async function tokenRequest(extra) {
  const c = creds();
  const body = new URLSearchParams({ client_id: c.id, ...extra });
  if (c.secret) body.set('client_secret', c.secret);
  const r = await net('https://oauth2.googleapis.com/token', {
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
  if (loginInProgress) throw new Error('Вход уже выполняется');
  loginInProgress = true;
  try {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { port, result: codePromise, cancel } = await startLoopback(state);
    const redirect = `http://127.0.0.1:${port}`;
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: creds().id,
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
  const r = await net(url, { headers: { Authorization: 'Bearer ' + token } });
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

/* ---------- офлайн-кэш событий (шифруется так же, как токен) ---------- */
let cache = { ranges: {} };
let cacheTimer = null;

function loadCache() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const c = JSON.parse(safeStorage.decryptString(fs.readFileSync(cacheFile())));
    if (c && typeof c.ranges === 'object') cache = c;
  } catch { cache = { ranges: {} }; }
}
function saveCacheSoon() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return;
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(cacheFile(), safeStorage.encryptString(JSON.stringify(cache)));
    } catch (e) { console.error('cache save failed', e); }
  }, 500);
}
function cacheStore(key, events) {
  cache.ranges[key] = { savedAt: Date.now(), events };
  const keys = Object.keys(cache.ranges).sort((a, b) => cache.ranges[b].savedAt - cache.ranges[a].savedAt);
  for (const k of keys.slice(CACHE_RANGES)) delete cache.ranges[k];
  saveCacheSoon();
}
function cacheLookup(key, fromMs, toMs) {
  const exact = cache.ranges[key];
  if (exact) return { events: exact.events, savedAt: exact.savedAt };
  // точного периода нет: собираем из сохранённых то, что попадает в запрошенный диапазон
  const map = new Map(); let newest = 0;
  for (const r of Object.values(cache.ranges)) {
    newest = Math.max(newest, r.savedAt);
    for (const e of r.events) {
      const s = Date.parse(e.start), en = Date.parse(e.end);
      if (en > fromMs && s < toMs) map.set(e.id + '|' + e.start, e);
    }
  }
  return map.size ? { events: [...map.values()], savedAt: newest } : null;
}

/* ---------- уведомления о сменах ---------- */
let shiftList = [];            // ближайшие смены от интерфейса: { id, title, start, end } в мс
let notifyTimers = [];
const notified = new Set();
const liveNotes = new Set();   // держим ссылки, иначе клик по уведомлению может потеряться

function setShiftList(list) {
  shiftList = (Array.isArray(list) ? list : []).slice(0, 200)
    .filter(e => e && typeof e.id === 'string' && Number.isFinite(e.start))
    .map(e => ({ id: e.id.slice(0, 200), title: String(e.title || '').slice(0, 120), start: e.start, allDay: e.allDay === true, calendar: String(e.calendar || '').slice(0, 120) }));
  rescheduleNotifications();
}
function rescheduleNotifications() {
  notifyTimers.forEach(clearTimeout); notifyTimers = [];
  if (!settings.notify || !Notification.isSupported()) return;
  const now = Date.now();
  for (const ev of shiftList) {
    if (ev.start <= now || ev.start - now > NOTIFY_HORIZON) continue;
    // смена «на весь день» не имеет времени начала: напоминаем накануне в заданное время (по умолчанию 20:00)
    let fireAt;
    if (ev.allDay) {
      const [h, m] = (settings.notifyEve || '20:00').split(':').map(Number);
      const d = new Date(ev.start); d.setDate(d.getDate() - 1); d.setHours(h, m, 0, 0);
      fireAt = d.getTime();
    } else fireAt = ev.start - settings.notifyHours * 3600 * 1000;
    const key = `${ev.id}|${ev.start}|${ev.allDay ? 'd' + settings.notifyEve : settings.notifyHours}`;
    if (notified.has(key)) continue;
    notifyTimers.push(setTimeout(() => fireNotification(ev, key), Math.max(0, fireAt - now)));
  }
}
// «В!Ф Алматы на Маркова» -> «Маркова»: в уведомлении только точка, без названия сети
const studioShort = cal => String(cal || '').replace(/^.*?\sна\s+/i, '').replace(/^В!Ф\s*(Алматы)?\s*/i, '').trim();
// «Завтра смена на Маркова» / «Прекрасного дня!»
function eveNote(ev) {
  const st = studioShort(ev.calendar);
  return { title: 'Завтра смена' + (st ? ' на ' + st : ''), body: 'Прекрасного дня!' };
}
function fireNotification(ev, key) {
  if (notified.has(key) || ev.start <= Date.now()) return;
  notified.add(key);
  if (notified.size > 500) notified.delete(notified.values().next().value); // не растёт бесконечно
  if (ev.allDay) { const n = eveNote(ev); return showNote(n.title, n.body); }
  const mins = Math.max(1, Math.round((ev.start - Date.now()) / 60000));
  const left = mins >= 60 ? `${Math.floor(mins / 60)} ч${mins % 60 ? ' ' + (mins % 60) + ' мин' : ''}` : `${mins} мин`;
  const at = new Date(ev.start).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const st = studioShort(ev.calendar);
  showNote(st ? 'Скоро смена на ' + st : 'Скоро смена: ' + (ev.title || 'без названия'), `Начало в ${at}, через ${left}`);
}
function showNote(title, body) {
  const n = new Notification({ title, body, icon: toastIcon() });
  if (liveNotes.size >= 20) liveNotes.delete(liveNotes.values().next().value);
  liveNotes.add(n);
  n.on('click', () => { win?.show(); win?.focus(); });
  n.on('close', () => liveNotes.delete(n));
  n.show();
}

/* ---------- обновления ---------- */
const updater = createUpdater({
  config: UPDATE_CFG,
  getVersion: () => app.getVersion(),
  // самообновление возможно только у собранного portable-exe
  getExePath: () => (app.isPackaged && /\.exe$/i.test(process.env.PORTABLE_EXECUTABLE_FILE || '') ? process.env.PORTABLE_EXECUTABLE_FILE : ''),
  send: st => send('update:state', st),
  getPin: () => ({ version: settings.pinVersion, kept: settings.pinKept }),
  // старую версию ставим «на пробу»: автообновление не вернёт новую, пока вы не решите; последнюю версию ставим без фиксации
  onApplied: ({ version, rollback }) => {
    settings.pinVersion = rollback ? version : ''; settings.pinKept = false; settings.lastUpdateTry = Date.now(); saveSettings();
  },
  onQuit: () => { quitting = true; setTimeout(() => app.exit(0), 300); }
});

async function checkForUpdates({ auto = false } = {}) {
  const st = await updater.check();
  if (st.state !== 'available') return st;
  if (auto && settings.autoUpdate && Date.now() - (settings.lastUpdateTry || 0) > 30 * 60 * 1000) {
    settings.lastUpdateTry = Date.now(); saveSettings();
    if (Notification.isSupported()) new Notification({ title: 'Обновление виджета', body: `Устанавливаю версию ${st.latest}, виджет перезапустится`, icon: toastIcon() }).show();
    return updater.install();
  }
  if (auto && Notification.isSupported()) {
    const n = new Notification({ title: 'Доступно обновление виджета', body: `Версия ${st.latest}. Установить можно в настройках ⚙.`, icon: toastIcon() });
    n.on('click', () => { win?.show(); win?.focus(); }); n.show();
  }
  return st;
}

/* ---------- полное удаление данных ---------- */
const batEsc = p => p.replace(/%/g, '%%');
// Скрипт ждёт, пока приложение закроется (на Windows открытые файлы не удалить), и повторяет удаление до 15 раз
function buildWipeScript(dataDir, exePath) {
  const L = ['@echo off', 'chcp 65001 >nul', 'set n=0', ':retry', 'ping -n 2 127.0.0.1 >nul'];
  L.push(`if exist "${batEsc(dataDir)}" rmdir /s /q "${batEsc(dataDir)}" 2>nul`);
  if (exePath) L.push(`if exist "${batEsc(exePath)}" del /f /q "${batEsc(exePath)}" 2>nul`);
  const cond = [`exist "${batEsc(dataDir)}"`].concat(exePath ? [`exist "${batEsc(exePath)}"`] : []);
  L.push('set /a n+=1', 'if %n% GEQ 15 goto done');
  for (const c of cond) L.push(`if ${c} goto retry`);
  L.push(':done', '(goto) 2>nul & del "%~f0"');
  return L.join('\r\n') + '\r\n';
}

async function wipeEverything(deleteExe) {
  const dataDir = app.getPath('userData');
  // защита: удаляем только папку самого виджета
  if (!/calendar/i.test(path.basename(dataDir)) || dataDir.length < 12 || /["\r\n]/.test(dataDir)) throw new Error('Небезопасный путь данных, удаление отменено');
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || '';
  const exeToDelete = deleteExe && app.isPackaged && exe && /\.exe$/i.test(exe) && !/["\r\n]/.test(exe) ? exe : '';

  // 1) отозвать доступ приложения в аккаунте Google (если не получится — не страшно)
  if (refreshToken) {
    try {
      await net('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refreshToken),
        { method: 'POST', signal: AbortSignal.timeout(5000) });
    } catch {}
  }
  // 2) убрать регистрацию названия/значка уведомлений в реестре и автозапуск
  await unregisterToastIdentity();
  try {
    const exePath = exe || process.execPath;
    app.setLoginItemSettings({ openAtLogin: false, path: exePath });
    app.setLoginItemSettings({ openAtLogin: false });
  } catch {}
  // 3) стереть данные из памяти и удалить файлы, сколько получится, пока приложение живо
  accessToken = null; refreshToken = null; customSecret = '';
  cache = { ranges: {} };
  clearTimeout(cacheTimer);
  notifyTimers.forEach(clearTimeout); notifyTimers = [];
  for (const f of [tokenFile(), secretFile(), cacheFile(), settingsFile()]) { try { fs.rmSync(f, { force: true }); } catch {} }
  // 4) после выхода внешний скрипт добивает всю папку (кэш Chromium и т.п.) и, по желанию, сам exe
  if (process.platform === 'win32') {
    const bat = path.join(os.tmpdir(), 'calendar-widget-cleanup-' + process.pid + '.bat');
    fs.writeFileSync(bat, buildWipeScript(dataDir, exeToDelete));
    spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn('sh', ['-c', 'sleep 3; rm -rf "$1"', 'sh', dataDir], { detached: true, stdio: 'ignore' }).unref();
  }
  quitting = true;
  setTimeout(() => app.exit(0), 300);
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
    if (settings.theme === 'glass') send('glass:geometry', glassGeometry());
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
// Тема «Стекло»: размытые обои под карточкой. Электрон не умеет размывать рабочий стол под прозрачным окном
// (родная акриловая подложка даёт прямые углы), поэтому обои читаем сами и размываем в интерфейсе.
const regQuery = name => new Promise(resolve => {
  execFile('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', name], { windowsHide: true, timeout: 4000 }, (err, out) => {
    if (err) return resolve('');
    const m = String(out).match(new RegExp(name + '\\s+REG_\\w+\\s+(.*)'));
    resolve(m ? m[1].trim() : '');
  });
});
let wallCache = { at: 0, value: null };
async function readWallpaper() {
  if (process.platform !== 'win32') return null;
  if (Date.now() - wallCache.at < 60 * 1000) return wallCache.value;
  let value = null;
  try {
    const files = [path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper')];
    const reg = await regQuery('WallPaper'); if (reg) files.push(reg);
    const [style, tile] = await Promise.all([regQuery('WallpaperStyle'), regQuery('TileWallpaper')]);
    for (const f of files) {
      try {
        const img = nativeImage.createFromBuffer(fs.readFileSync(f));
        if (img.isEmpty()) continue;
        const sz = img.getSize();
        // до 1920 px по ширине: при малом размытии обои видны почти чёткими, 640 px давали «лесенку» (дальше уменьшать нет смысла, память)
        const small = sz.width > 1920 ? img.resize({ width: 1920, quality: 'best' }) : img;
        const s2 = small.getSize();
        value = {
          url: 'data:image/jpeg;base64,' + small.toJPEG(86).toString('base64'), w: s2.width, h: s2.height,
          style: tile === '1' ? 'tile' : ({ '10': 'fill', '22': 'fill', '6': 'fit', '2': 'stretch', '0': 'center' }[style] || 'fill')
        };
        break;
      } catch {}
    }
  } catch (e) { console.error('wallpaper failed', e); }
  wallCache = { at: Date.now(), value };
  return value;
}
function glassGeometry() {
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b).bounds;
  return { win: { x: b.x, y: b.y }, disp: { x: d.x, y: d.y, width: d.width, height: d.height } };
}
function applyWindowBehavior() {
  if (!win) return;
  win.setAlwaysOnTop(!!settings.alwaysOnTop);
}

function updateSettings(patch) {
  const next = { ...settings };
  if (typeof patch.keywords === 'string') next.keywords = patch.keywords.slice(0, 200);
  for (const k of ['autostart', 'alwaysOnTop', 'locked', 'onlyMine', 'notify', 'autoUpdate', 'goalOn', 'statsOn', 'freeOn']) {
    if (typeof patch[k] === 'boolean') next[k] = patch[k];
  }
  if (typeof patch.opacity === 'number' && isFinite(patch.opacity)) {
    next.opacity = Math.min(1, Math.max(0.4, patch.opacity));
  }
  if (typeof patch.notifyHours === 'number' && isFinite(patch.notifyHours)) {
    next.notifyHours = Math.min(48, Math.max(1, Math.round(patch.notifyHours)));
  }
  if (['system', 'light', 'dark', 'glass'].includes(patch.theme)) next.theme = patch.theme;
  if (['month', 'first', 'second'].includes(patch.payPeriod)) next.payPeriod = patch.payPeriod;
  if (typeof patch.goal === 'number' && isFinite(patch.goal)) next.goal = Math.min(1e9, Math.max(0, Math.round(patch.goal)));
  if (typeof patch.freeMin === 'number' && isFinite(patch.freeMin)) next.freeMin = Math.min(7, Math.max(2, Math.round(patch.freeMin)));
  if (typeof patch.glassBlur === 'number' && isFinite(patch.glassBlur)) next.glassBlur = Math.min(40, Math.max(0, Math.round(patch.glassBlur)));
  if (typeof patch.notifyEve === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(patch.notifyEve)) next.notifyEve = patch.notifyEve;
  if (patch.rates && typeof patch.rates === 'object' && !Array.isArray(patch.rates)) {
    const rates = {};
    for (const [k, v] of Object.entries(patch.rates).slice(0, 50)) {
      const n = Math.round(Number(v));
      if (/^(#[0-9a-f]{3,8}|none)$/i.test(k) && isFinite(n) && n > 0 && n <= 1e9) rates[k.toLowerCase()] = n;
    }
    next.rates = rates;
  }
  if (patch.advance && typeof patch.advance === 'object' && !Array.isArray(patch.advance)) {
    const entries = [];
    for (const [k, v] of Object.entries(patch.advance)) {
      const n = Math.round(Number(v));
      if (/^\d{4}-(0[1-9]|1[0-2])\|(first|second)$/.test(k) && isFinite(n) && n > 0 && n <= 1e9) entries.push([k, n]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? 1 : -1)); // новые месяцы первыми
    next.advance = Object.fromEntries(entries.slice(0, 120));
  }
  if (patch.dayPay && typeof patch.dayPay === 'object' && !Array.isArray(patch.dayPay)) {
    const entries = [];
    for (const [k, v] of Object.entries(patch.dayPay)) {
      const n = Math.round(Number(v));
      if (/^\d{4}-\d{2}-\d{2}\|(#[0-9a-f]{3,8}|none)$/i.test(k) && isFinite(n) && n >= 0 && n <= 1e9) entries.push([k.toLowerCase(), n]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? 1 : -1)); // новые даты первыми
    next.dayPay = Object.fromEntries(entries.slice(0, 1500));
  }
  settings = next;
  saveSettings();
  applyAutostart();
  applyWindowBehavior();
  rescheduleNotifications();
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
    { label: 'Проверить обновления виджета', click: () => { win?.show(); checkForUpdates({ auto: false }); } },
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
      const key = from.toISOString() + '|' + to.toISOString();
      try {
        const events = await fetchEvents(from.toISOString(), to.toISOString());
        cacheStore(key, events);
        return { ok: true, events, savedAt: Date.now() };
      } catch (e) {
        // нет сети: показываем последние сохранённые данные
        if (e.code === 'OFFLINE' && refreshToken) {
          const c = cacheLookup(key, from.getTime(), to.getTime());
          if (c) return { ok: true, offline: true, events: c.events, savedAt: c.savedAt };
        }
        throw e;
      }
    } catch (e) {
      return { ok: false, code: e.code || 'ERR', message: e.message || String(e) };
    }
  });
  ipcMain.on('notify:shifts', (_e, list) => setShiftList(list));
  ipcMain.handle('notify:test', () => {
    if (!Notification.isSupported()) return { ok: false, message: 'Уведомления не поддерживаются в этой системе' };
    // если уже есть ближайшая смена, показываем уведомление по её настоящим данным, иначе образец
    const sample = shiftList[0] || { calendar: 'В!Ф Алматы на Маркова' };
    const n = eveNote(sample);
    showNote(n.title, n.body);
    return { ok: true };
  });
  ipcMain.handle('update:state', () => updater.getState());
  ipcMain.handle('update:check', () => checkForUpdates({ auto: false }));
  ipcMain.handle('update:install', async (_e, version) => {
    settings.lastUpdateTry = Date.now(); saveSettings();
    return updater.install(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : undefined);
  });
  ipcMain.handle('update:versions', () => updater.versions(3));
  // «Оставить эту версию» / «Снять фиксацию»
  ipcMain.handle('update:pin', async (_e, action) => {
    if (action === 'keep') {
      settings.pinVersion = app.getVersion(); settings.pinKept = true;
      // убираем недокачанное обновление рядом с exe
      const exe = process.env.PORTABLE_EXECUTABLE_FILE;
      if (exe) try { fs.rmSync(path.join(path.dirname(exe), 'CalendarWidget.update.exe'), { force: true }); } catch {}
    } else if (action === 'clear') { settings.pinVersion = ''; settings.pinKept = false; }
    else return { ok: false };
    saveSettings();
    send('settings:changed', publicSettings());
    return { ok: true };
  });
  ipcMain.handle('app:wipe', async (_e, opts) => {
    try { await wipeEverything(!!opts?.deleteExe); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message || String(e) }; }
  });
  ipcMain.handle('sys:accent', () => accentHex());
  ipcMain.handle('glass:info', async () => ({ wall: await readWallpaper(), ...(glassGeometry() || {}) }));
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
    registerToastIdentity();
    loadCache();
    registerIpc();
    createWindow();
    createTray();
    applyAutostart();

    try {
      systemPreferences.on('accent-color-changed', () => send('sys:accent', accentHex()));
    } catch {}
    // проверка обновлений: через 20 секунд после старта и затем каждые 6 часов
    setTimeout(() => checkForUpdates({ auto: true }), 20 * 1000);
    setInterval(() => checkForUpdates({ auto: true }), 6 * 3600 * 1000);
    powerMonitor.on('resume', () => setTimeout(() => send('app:refresh'), 4000));
    powerMonitor.on('unlock-screen', () => send('app:refresh'));
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* живём в трее */ });
}
