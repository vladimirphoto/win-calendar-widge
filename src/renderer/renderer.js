'use strict';

const $ = id => document.getElementById(id);
const api = window.widget;

let settings = null;
let view = new Date(); view.setDate(1); view.setHours(0, 0, 0, 0);
let sel = new Date();
let events = {};          // 'YYYY-MM-DD' -> [event]
let loggedIn = false;
let demo = true;
let syncing = false;
let lastSync = null;

/* ---------- утилиты ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = d => d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
const localDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function isShift(title) {
  const keys = (settings?.keywords || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!keys.length) return true; // список слов пуст: все события считаются сменами
  const t = title.toLowerCase();
  return keys.some(k => t.includes(k));
}

function visibleEvents(key) {
  const list = events[key] || [];
  const hasKeys = (settings?.keywords || '').trim() !== '';
  return settings?.onlyMine && hasKeys ? list.filter(e => e.shift) : list;
}

/* ---------- данные ---------- */
function indexEvents(list) {
  const map = {};
  for (const raw of list) {
    let start, end;
    if (raw.allDay) { start = localDate(raw.start); end = localDate(raw.end); }
    else { start = new Date(raw.start); end = new Date(raw.end); }
    const ev = { ...raw, start, end, shift: isShift(raw.title) };
    // последний день: для «весь день» и для событий, заканчивающихся ровно в полночь, конец не включаем
    const last = new Date(end.getTime() - 1);
    const stop = last < start ? start : last;
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= stop; d.setDate(d.getDate() + 1)) {
      (map[ymd(d)] ??= []).push(ev);
    }
  }
  for (const k of Object.keys(map)) {
    map[k].sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
  }
  return map;
}

function demoEvents() {
  const t = new Date();
  const list = [];
  const studios = ['#0b8043', '#8e24aa', '#f4511e'];
  [0, 1, 4, 5, 8, 9, 12, 13, 16, 17, 20, 21].forEach((n, i) => {
    const s = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n, 9);
    const e = new Date(s); e.setHours(21);
    list.push({ id: 'd' + n, title: 'Студия ' + (Math.floor(i / 2) % 3 + 1) + ' (пример)', allDay: false, start: s.toISOString(), end: e.toISOString(), color: studios[Math.floor(i / 2) % 3], calendar: 'Демо' });
  });
  const s = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 2, 18);
  const e = new Date(s); e.setHours(19, 30);
  list.push({ id: 'dx', title: 'Встреча (пример)', allDay: false, start: s.toISOString(), end: e.toISOString(), color: '#8764b8', calendar: 'Демо' });
  return list;
}

async function sync() {
  if (!loggedIn) return;
  if (syncing) return;
  syncing = true;
  setStatus('busy', 'Синхронизация…');
  const from = new Date(view.getFullYear(), view.getMonth() - 1, 1);
  const to = new Date(view.getFullYear(), view.getMonth() + 2, 1);
  const res = await api.getEvents({ from: from.toISOString(), to: to.toISOString() });
  syncing = false;
  if (res.ok) {
    demo = false;
    events = indexEvents(res.events);
    lastSync = new Date();
    setStatus('on', 'Обновлено ' + fmtT(lastSync));
    render();
  } else if (res.code === 'NOT_AUTH') {
    loggedIn = false; demo = true;
    events = indexEvents(demoEvents());
    setStatus('', 'Нужен вход в Google');
    updateButtons(); render();
  } else {
    setStatus('err', 'Ошибка: ' + (res.message || 'не удалось обновить'));
  }
}

async function doLogin() {
  if (!settings.clientId) { openPanel(); showCfgErr('Сначала укажите Client ID и Client secret.'); return; }
  setStatus('busy', 'Ожидаю вход в браузере…');
  const res = await api.login();
  if (res.ok) {
    loggedIn = true; demo = false;
    updateButtons(); hideCfgErr();
    await sync();
  } else {
    setStatus('err', 'Вход не выполнен');
    if (!$('panel').hidden) showCfgErr(res.message);
  }
}

/* ---------- отрисовка ---------- */
function setStatus(kind, text) {
  $('status').className = 'status' + (kind ? ' ' + kind : '');
  $('statusText').textContent = text;
}
function updateButtons() {
  $('btnSync').textContent = loggedIn ? 'Обновить' : 'Войти в Google';
  $('btnLogout').disabled = !loggedIn;
}

const colorOrder = [];
function render() {
  $('title').innerHTML = `${esc(view.toLocaleDateString('ru', { month: 'long' }))}<small>${view.getFullYear()}</small>`;
  $('dows').innerHTML = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(n => `<div class="dow">${n}</div>`).join('');

  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const todayK = ymd(new Date()), selK = ymd(sel);
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = ymd(d), evs = visibleEvents(k);
    const cls = ['day'];
    if (d.getMonth() !== view.getMonth()) cls.push('other');
    if (evs.some(e => e.shift)) cls.push('shift');
    if (k === todayK) cls.push('today');
    if (k === selK) cls.push('sel');
    // цвета студий (смен) за день без повторов
    const sc = [...new Set(evs.filter(e => e.shift).map(e => e.color || '#0f7b6c'))].slice(0, 3);
    // по точке на каждую студию (цвет) за день, в одном и том же порядке во всех днях
    const dcs = [...new Set(evs.map(e => e.color || ''))];
    dcs.forEach(c => { if (!colorOrder.includes(c)) colorOrder.push(c); });
    dcs.sort((x, y) => colorOrder.indexOf(x) - colorOrder.indexOf(y));
    const dots = dcs.slice(0, 6).map(c => `<span class="dot"${c ? ` data-c="${esc(c)}"` : ''}></span>`).join('');
    html += `<div class="${cls.join(' ')}" data-k="${k}"${sc.length ? ` data-sc="${esc(sc.join(','))}"` : ''}>${d.getDate()}<div class="dots">${dots}</div></div>`;
  }
  const grid = $('days');
  grid.innerHTML = html;
  grid.querySelectorAll('.dot[data-c]').forEach(el => { el.style.background = el.dataset.c; });
  grid.querySelectorAll('.day[data-sc]').forEach(el => {
    const cs = el.dataset.sc.split(',');
    el.style.setProperty('--sc', cs[0]);
    if (cs.length > 1) {
      const step = 100 / cs.length;
      el.style.setProperty('--sg', `linear-gradient(90deg, ${cs.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`).join(', ')})`);
    }
  });
  grid.querySelectorAll('.day').forEach(el => {
    el.onclick = () => { sel = localDate(el.dataset.k); if (!sameMonth(sel, view)) { view = new Date(sel.getFullYear(), sel.getMonth(), 1); sync(); } render(); };
  });

  // счётчик смен в отображаемом месяце
  const seen = new Set(); let n = 0;
  for (const [k, list] of Object.entries(events)) {
    if (!sameMonth(localDate(k), view)) continue;
    for (const e of list) {
      if (!e.shift) continue;
      const id = e.id + '|' + e.start.getTime();
      if (!seen.has(id)) { seen.add(id); n++; }
    }
  }
  $('sub').textContent = n ? `${n} ${plural(n, 'смена', 'смены', 'смен')} в этом месяце${demo ? ' (пример)' : ''}` : '';
  renderAgenda();
  renderSeg();
  fitWindow();
}

function renderAgenda() {
  $('agTitle').textContent = sel.toLocaleDateString('ru', { weekday: 'long', day: 'numeric', month: 'long' });
  const evs = visibleEvents(ymd(sel));
  const list = $('agList');
  if (!evs.length) { list.innerHTML = '<div class="empty">Нет событий</div>'; return; }
  list.innerHTML = evs.map((e, i) => {
    const time = e.allDay ? 'Весь день' : `${fmtT(e.start)}–${fmtT(e.end)}`;
    return `<div class="ev${e.shift ? ' s' : ''}" data-i="${i}"><div class="bar"></div>
      <div class="t">${esc(time)}</div>
      <div><div class="n">${esc(e.title)}${e.shift ? '<span class="tag">смена</span>' : ''}</div>
      ${e.calendar ? `<div class="c">${esc(e.calendar)}</div>` : ''}</div></div>`;
  }).join('');
  list.querySelectorAll('.ev').forEach(el => {
    const e = evs[Number(el.dataset.i)];
    if (e.color) el.style.setProperty('--ec', e.color);
  });
}

/* ---------- тема / настройки ---------- */
function applyAccent(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--on-accent', lum > 0.62 ? '#000' : '#fff');
}

function applySettings(s) {
  settings = s;
  document.documentElement.style.setProperty('--alpha', String(s.opacity));
  document.body.classList.toggle('locked', !!s.locked);
  $('fKeys').value = s.keywords;
  $('fOpacity').value = Math.round(s.opacity * 100);
  $('tAuto').checked = !!s.autostart;
  $('tTop').checked = !!s.alwaysOnTop;
  $('tLock').checked = !!s.locked;
  $('tOnly').checked = !!s.onlyMine;
  $('devNote').hidden = !!s.packaged;
  if (document.activeElement !== $('fClient')) $('fClient').value = s.clientId || '';
  $('fSecret').placeholder = s.hasSecret ? '•••••••• (сохранён)' : 'GOCSPX-…';
  // ключевые слова могли поменяться — пересобрать подсветку из уже загруженных данных
  const flat = new Map();
  Object.values(events).flat().forEach(e => flat.set(e.id + '|' + e.start.getTime(), e));
  const raw = [...flat.values()].map(e => ({ ...e, start: e.allDay ? ymd(e.start) : e.start.toISOString(), end: e.allDay ? ymd(e.end) : e.end.toISOString() }));
  events = indexEvents(raw);
  render();
}

function openPanel() { $('panel').hidden = false; document.body.classList.add('panel-open'); api.fit(10000); }
function closePanel() { $('panel').hidden = true; document.body.classList.remove('panel-open'); hideCfgErr(); fitWindow(); }

function renderSeg() {
  const mine = !!settings?.onlyMine;
  $('segMine').classList.toggle('on', mine);
  $('segAll').classList.toggle('on', !mine);
  $('segMine').setAttribute('aria-pressed', String(mine));
  $('segAll').setAttribute('aria-pressed', String(!mine));
}

// окно подгоняется под содержимое, чтобы не оставалось пустого места
let fitRaf = 0;
function fitWindow() {
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    if (!$('panel').hidden) return;
    const list = $('agList');
    const natural = $('card').offsetHeight - list.clientHeight + list.scrollHeight;
    api.fit(natural + 32); // 32 = внешние отступы body
  });
}
function showCfgErr(m) { const el = $('cfgErr'); el.textContent = m; el.hidden = false; }
function hideCfgErr() { $('cfgErr').hidden = true; }

/* ---------- события интерфейса ---------- */
function shiftMonth(delta) {
  view = new Date(view.getFullYear(), view.getMonth() + delta, 1);
  render(); sync();
}
$('btnPrev').onclick = () => shiftMonth(-1);
$('btnNext').onclick = () => shiftMonth(1);
$('btnToday').onclick = () => { view = new Date(); view.setDate(1); sel = new Date(); render(); sync(); };
$('btnHide').onclick = () => api.hide();
$('btnCfg').onclick = openPanel;
$('btnDone').onclick = closePanel;
$('btnSync').onclick = () => (loggedIn ? sync() : doLogin());
$('btnLogout').onclick = async () => { await api.logout(); loggedIn = false; demo = true; events = indexEvents(demoEvents()); updateButtons(); setStatus('', 'Не подключено'); render(); };

$('days').addEventListener('wheel', e => { e.preventDefault(); shiftMonth(e.deltaY > 0 ? 1 : -1); }, { passive: false });
document.addEventListener('keydown', e => {
  if (!$('panel').hidden) { if (e.key === 'Escape') closePanel(); return; }
  if (e.key === 'ArrowLeft') shiftMonth(-1);
  if (e.key === 'ArrowRight') shiftMonth(1);
});

let keysTimer;
$('fKeys').addEventListener('input', () => { clearTimeout(keysTimer); keysTimer = setTimeout(() => api.setSettings({ keywords: $('fKeys').value }), 300); });
$('fOpacity').addEventListener('input', () => api.setSettings({ opacity: Number($('fOpacity').value) / 100 }));
$('tAuto').onchange = () => api.setSettings({ autostart: $('tAuto').checked });
$('segAll').onclick = () => api.setSettings({ onlyMine: false });
$('segMine').onclick = () => {
  if (!(settings?.keywords || '').trim()) { openPanel(); $('fKeys').focus(); return; }
  api.setSettings({ onlyMine: true });
};
$('tOnly').onchange = () => api.setSettings({ onlyMine: $('tOnly').checked });
$('tTop').onchange = () => api.setSettings({ alwaysOnTop: $('tTop').checked });
$('tLock').onchange = () => api.setSettings({ locked: $('tLock').checked });

$('btnSaveG').onclick = async () => {
  hideCfgErr();
  const patch = { clientId: $('fClient').value };
  if ($('fSecret').value.trim()) patch.clientSecret = $('fSecret').value;
  const s = await api.setSettings(patch);
  $('fSecret').value = '';
  if (!s.clientId) { showCfgErr('Укажите Client ID.'); return; }
  loggedIn = false; updateButtons();
  await doLogin();
  if (loggedIn) closePanel();
};

/* ---------- события от main ---------- */
api.onAccent(applyAccent);
api.onRefresh(() => sync());
api.onLogin(() => doLogin());
api.onSettings(applySettings);
api.onAuthChanged(v => { loggedIn = v; if (!v) { demo = true; events = indexEvents(demoEvents()); setStatus('', 'Не подключено'); } updateButtons(); render(); });

/* ---------- старт ---------- */
(async function init() {
  applyAccent(await api.getAccent());
  events = indexEvents(demoEvents());
  applySettings(await api.getSettings());
  loggedIn = (await api.authStatus()).loggedIn;
  updateButtons();
  render();
  if (loggedIn) { await sync(); }
  else setStatus('', settings.clientId ? 'Войдите в Google' : 'Показаны примеры — настройте Google в ⚙');
  setInterval(() => { if (loggedIn) sync(); }, 10 * 60 * 1000);
  // дата сменилась после полуночи — перерисовать «сегодня»
  let lastDay = ymd(new Date());
  setInterval(() => { const k = ymd(new Date()); if (k !== lastDay) { lastDay = k; render(); } }, 60 * 1000);
})();
