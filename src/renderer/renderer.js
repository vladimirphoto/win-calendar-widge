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
let offline = false;
let upcoming = [];        // события от сегодняшнего дня (не зависят от того, какой месяц листают)
let lastKeys = null;
let lastActivity = Date.now();
const IDLE_RETURN_MS = 2 * 60 * 1000; // через 2 минуты без действий вернуться на сегодня

/* ---------- утилиты ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = d => d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
const localDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

let dayPay = {};          // сумма за конкретный день: 'YYYY-MM-DD|цвет' -> ₸ (заменяет ставку студии)
let payTimer = 0;
let agEvs = [];
const money = n => Math.round(n).toLocaleString('ru-RU') + ' ₸';
const rateKey = c => (c || 'none').toLowerCase();
const isToday = d => ymd(d) === ymd(new Date());

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
function parseEv(raw) {
  let start, end;
  if (raw.allDay) { start = localDate(raw.start); end = localDate(raw.end); }
  else { start = new Date(raw.start); end = new Date(raw.end); }
  return { ...raw, start, end, shift: isShift(raw.title) };
}

function indexEvents(list) {
  const map = {};
  for (const raw of list) {
    const ev = parseEv(raw);
    const { start, end } = ev;
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
    offline = !!res.offline;
    events = indexEvents(res.events);
    lastSync = new Date(res.savedAt || Date.now());
    if (offline) setStatus('off', 'Офлайн · данные от ' + fmtT(lastSync));
    else setStatus('on', 'Обновлено ' + fmtT(lastSync));
    const now = Date.now();
    if (from.getTime() <= now && now < to.getTime()) upcoming = res.events.map(parseEv);
    render();
    renderRates();
    updateNext(true);
  } else if (res.code === 'NOT_AUTH') {
    loggedIn = false; demo = true; upcoming = [];
    events = indexEvents(demoEvents());
    setStatus('', 'Нужен вход в Google');
    updateButtons(); render(); updateNext(true);
  } else {
    setStatus(res.code === 'OFFLINE' ? 'off' : 'err', res.code === 'OFFLINE' ? 'Нет интернета' : 'Ошибка: ' + (res.message || 'не удалось обновить'));
  }
}

async function doLogin() {
  setStatus('busy', 'Ожидаю вход в браузере…');
  const res = await api.login();
  if (res.ok) {
    loggedIn = true; demo = false;
    updateButtons(); hideCfgErr();
    await sync();
  } else {
    setStatus('err', 'Вход не выполнен');
    if (!$('panel').hidden) showCfgErr(res.message);
    else setStatus('err', 'Вход не выполнен: ' + (res.message || 'ошибка'));
  }
}

/* ---------- отрисовка ---------- */
function setStatus(kind, text) {
  $('status').className = 'status' + (kind ? ' ' + kind : '') + (loggedIn ? '' : ' login');
  $('statusText').textContent = text;
}
function updateButtons() {
  $('status').classList.toggle('login', !loggedIn);
  $('btnLogout').hidden = !loggedIn;
  $('btnLogin').hidden = loggedIn;
  $('authHint').textContent = loggedIn
    ? 'Вы вошли. Доступ только на чтение календаря.'
    : (settings?.customClient
      ? 'Используется ваш Client ID из прежних настроек.'
      : 'Откроется браузер, разрешите доступ «только чтение». Пароль виджету не передаётся.');
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

  // счётчик смен в отображаемом месяце
  const n = monthShifts().length;
  let sub = n ? `${n} ${plural(n, 'смена', 'смены', 'смен')}` : '';
  if (n && demo) sub += ' (пример)';
  $('sub').textContent = sub;
  updateEarn();
  renderAgenda();
  renderSeg();
  fitWindow();
}

// сумма за смену: введённая для этого дня и студии, иначе ставка студии по умолчанию
const payKey = e => ymd(e.start) + '|' + rateKey(e.color);
const defaultRate = e => (settings?.rates || {})[rateKey(e.color)] || 0;
const payFor = e => { const v = dayPay[payKey(e)]; return v === undefined ? defaultRate(e) : v; };

function monthShifts() {
  const seen = new Set(); const out = [];
  for (const [k, list] of Object.entries(events)) {
    if (!sameMonth(localDate(k), view)) continue;
    for (const e of list) {
      if (!e.shift) continue;
      const id = e.id + '|' + e.start.getTime();
      if (!seen.has(id)) { seen.add(id); out.push(e); }
    }
  }
  return out;
}

function updateEarn() {
  const list = monthShifts();
  const earn = list.reduce((sum, e) => sum + payFor(e), 0);
  const earnEl = $('earn');
  const showEarn = list.length > 0 && earn > 0;
  if (showEarn) earnEl.textContent = 'Заработок: ' + money(earn);
  if (earnEl.hidden === showEarn) earnEl.hidden = !showEarn;
}

function renderAgenda() {
  $('agTitle').textContent = sel.toLocaleDateString('ru', { weekday: 'long', day: 'numeric', month: 'long' });
  const evs = visibleEvents(ymd(sel));
  const list = $('agList');
  if (list.contains(document.activeElement)) return; // не перерисовываем, пока вводят сумму
  agEvs = evs;
  if (!evs.length) { list.innerHTML = '<div class="empty">Нет событий</div>'; return; }
  list.innerHTML = evs.map((e, i) => {
    const time = e.allDay ? 'Весь день' : `${fmtT(e.start)}–${fmtT(e.end)}`;
    return `<div class="ev${e.shift ? ' s' : ''}" data-i="${i}"><div class="bar"></div>
      <div class="t">${esc(time)}</div>
      <div><div class="n">${esc(e.title)}${e.shift ? '<span class="tag">смена</span>' : ''}</div>
      ${e.calendar ? `<div class="c">${esc(e.calendar)}</div>` : ''}</div>
      ${e.shift ? `<label class="pay" title="Сколько вы заработали в этот день (заменяет ставку студии)"><input type="number" min="0" max="1000000000" step="1000" inputmode="numeric" data-i="${i}" placeholder="${defaultRate(e) || 0}" value="${dayPay[payKey(e)] ?? ''}"><span class="cur">₸</span></label>` : ''}</div>`;
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
  if (!payTimer) dayPay = { ...(s.dayPay || {}) }; // пока человек вводит сумму, локальные значения главнее
  document.documentElement.style.setProperty('--alpha', String(s.opacity));
  document.body.classList.toggle('locked', !!s.locked);
  $('fKeys').value = s.keywords;
  $('fOpacity').value = Math.round(s.opacity * 100);
  $('tAuto').checked = !!s.autostart;
  $('tTop').checked = !!s.alwaysOnTop;
  $('tLock').checked = !!s.locked;
  $('tOnly').checked = !!s.onlyMine;
  $('devNote').hidden = !!s.packaged;
  $('tNotify').checked = !!s.notify;
  $('tAutoUpd').checked = !!s.autoUpdate;
  renderUpdate();
  if (document.activeElement !== $('fNotifyH')) $('fNotifyH').value = s.notifyHours;
  // ключевые слова могли поменяться — пересобрать подсветку из уже загруженных данных
  if (s.keywords !== lastKeys) {
    lastKeys = s.keywords;
    const flat = new Map();
    Object.values(events).flat().forEach(e => flat.set(e.id + '|' + e.start.getTime(), e));
    const raw = [...flat.values()].map(e => ({ ...e, start: e.allDay ? ymd(e.start) : e.start.toISOString(), end: e.allDay ? ymd(e.end) : e.end.toISOString() }));
    events = indexEvents(raw);
    upcoming = upcoming.map(e => ({ ...e, shift: isShift(e.title) }));
  }
  updateButtons();
  renderRates();
  render();
  updateNext(true);
}

/* ---------- ставки по студиям ---------- */
// студия определяется цветом метки; подпись — самое частое название события этого цвета
function studiosList() {
  const info = new Map();
  const add = e => {
    const k = rateKey(e.color);
    const it = info.get(k) || { key: k, color: e.color || '', titles: new Map() };
    it.titles.set(e.title, (it.titles.get(e.title) || 0) + 1);
    info.set(k, it);
  };
  if (!demo) {
    const seen = new Set();
    for (const e of Object.values(events).flat()) {
      const id = e.id + '|' + e.start.getTime();
      if (e.shift && !seen.has(id)) { seen.add(id); add(e); }
    }
  }
  for (const k of Object.keys(settings?.rates || {})) {
    if (!info.has(k)) info.set(k, { key: k, color: k === 'none' ? '' : k, titles: new Map() });
  }
  return [...info.values()].map(it => {
    const top = [...it.titles.entries()].sort((a, b) => b[1] - a[1])[0];
    return { key: it.key, color: it.color, name: top ? top[0] : (it.color ? 'Студия ' + it.color : 'Без цвета') };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function renderRates() {
  const box = $('rates');
  if (box.contains(document.activeElement)) return; // не перерисовывать, пока человек вводит сумму
  const list = studiosList();
  $('ratesEmpty').hidden = list.length > 0;
  box.textContent = '';
  for (const st of list) {
    const row = document.createElement('div'); row.className = 'rate';
    const label = document.createElement('label'); label.className = 'nm';
    const dot = document.createElement('b'); if (st.color) dot.style.background = st.color;
    const name = document.createElement('span'); name.textContent = st.name;
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.step = '500'; input.inputMode = 'numeric';
    input.placeholder = '0'; input.dataset.k = st.key;
    input.id = 'rate-' + st.key.replace(/[^a-z0-9]/gi, '');
    const v = settings?.rates?.[st.key]; if (v) input.value = String(v);
    label.htmlFor = input.id; label.append(dot, name);
    const cur = document.createElement('span'); cur.className = 'cur'; cur.textContent = '₸';
    row.append(label, input, cur);
    box.append(row);
  }
}

function flushPay() {
  clearTimeout(payTimer); payTimer = 0;
  api.setSettings({ dayPay });
}
$('agList').addEventListener('input', ev => {
  const inp = ev.target.closest('.pay input');
  if (!inp) return;
  const e = agEvs[Number(inp.dataset.i)];
  if (!e) return;
  if (inp.value === '') delete dayPay[payKey(e)];
  else dayPay[payKey(e)] = Math.max(0, Math.min(1e9, Math.round(Number(inp.value) || 0)));
  updateEarn();
  clearTimeout(payTimer);
  payTimer = setTimeout(flushPay, 600);
});
$('agList').addEventListener('change', () => { if (payTimer) flushPay(); });

let ratesTimer;
$('rates').addEventListener('input', () => {
  clearTimeout(ratesTimer);
  ratesTimer = setTimeout(() => {
    const rates = {};
    $('rates').querySelectorAll('input').forEach(i => { const n = Number(i.value); if (n > 0) rates[i.dataset.k] = n; });
    // ставки студий, которых сейчас нет на экране, не теряем
    const shown = new Set([...$('rates').querySelectorAll('input')].map(i => i.dataset.k));
    for (const [k, v] of Object.entries(settings?.rates || {})) if (!shown.has(k)) rates[k] = v;
    api.setSettings({ rates });
  }, 400);
});

/* ---------- следующая смена и уведомления ---------- */
function dayWord(d) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t) / 864e5);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === 2) return 'послезавтра';
  return d.toLocaleDateString('ru', { weekday: 'short', day: 'numeric', month: 'short' });
}

function updateNext(pushToMain) {
  const now = new Date();
  const shifts = (loggedIn && !demo ? upcoming : []).filter(e => e.shift && e.end > now);
  shifts.sort((a, b) => a.start - b.start);
  if (pushToMain) {
    api.setShifts(shifts.filter(e => !e.allDay && e.start > now).slice(0, 100)
      .map(e => ({ id: e.id, title: e.title, start: e.start.getTime() })));
  }
}

function openPanel() { renderRates(); $('panel').hidden = false; document.body.classList.add('panel-open'); api.fit(10000); }
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
function goToday() { view = new Date(); view.setDate(1); view.setHours(0, 0, 0, 0); sel = new Date(); render(); sync(); }
$('btnToday').onclick = goToday;
$('btnHide').onclick = () => api.hide();
$('btnCfg').onclick = openPanel;
$('btnDone').onclick = closePanel;
$('status').onclick = () => { if (!loggedIn) doLogin(); };
$('btnLogin').onclick = () => doLogin();
$('btnLogout').onclick = async () => { await api.logout(); loggedIn = false; demo = true; upcoming = []; events = indexEvents(demoEvents()); updateButtons(); setStatus('', 'Не подключено'); render(); updateNext(true); };
$('days').addEventListener('click', e => {
  const el = e.target.closest('.day');
  if (!el) return;
  sel = localDate(el.dataset.k);
  if (!sameMonth(sel, view)) { view = new Date(sel.getFullYear(), sel.getMonth(), 1); sync(); }
  render();
});
// любое действие сбрасывает таймер «вернуться на сегодня»
for (const t of ['pointerdown', 'wheel', 'keydown']) document.addEventListener(t, () => { lastActivity = Date.now(); }, true);

$('days').addEventListener('wheel', e => { e.preventDefault(); shiftMonth(e.deltaY > 0 ? 1 : -1); }, { passive: false });
document.addEventListener('keydown', e => {
  if (!$('panel').hidden) { if (e.key === 'Escape') closePanel(); return; }
  if (e.target?.closest?.('input')) return; // стрелки в поле ввода не листают месяц
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

/* ---------- обновления ---------- */
let upd = { state: 'idle' };
function renderUpdate() {
  const v = settings?.version || upd.current || '';
  const st = upd.state, btn = $('btnUpd'), txt = $('updText');
  btn.disabled = false;
  let t = `Версия ${v}. `;
  if (st === 'checking') { t += 'Проверяю…'; btn.disabled = true; btn.textContent = 'Проверяю…'; }
  else if (st === 'available') { t += `Доступна версия ${upd.latest}.`; btn.textContent = `Установить ${upd.latest} и перезапустить`; }
  else if (st === 'downloading') { t += `Скачиваю ${upd.latest}: ${upd.progress || 0}%`; btn.disabled = true; btn.textContent = 'Скачиваю…'; }
  else if (st === 'installing') { t += 'Перезапускаю…'; btn.disabled = true; btn.textContent = 'Перезапуск…'; }
  else if (st === 'uptodate') { t += 'У вас последняя версия.'; btn.textContent = 'Проверить обновления'; }
  else if (st === 'error') { t += upd.message || 'Не удалось проверить обновления.'; btn.textContent = 'Проверить ещё раз'; }
  else if (st === 'unsupported') { t += upd.message || ''; btn.textContent = 'Проверить обновления'; btn.disabled = true; }
  else { btn.textContent = 'Проверить обновления'; }
  txt.textContent = t.trim();
  txt.classList.toggle('bad', st === 'error');
}
$('btnUpd').onclick = () => (upd.state === 'available' ? api.updateInstall() : api.updateCheck());
$('tAutoUpd').onchange = () => api.setSettings({ autoUpdate: $('tAutoUpd').checked });
api.onUpdate(s => { upd = s; renderUpdate(); });

$('btnWipe').onclick = () => { $('wipeExeRow').hidden = !settings?.canDeleteExe; $('wipeBox').hidden = false; $('btnWipe').hidden = true; $('wipeBox').scrollIntoView({ block: 'nearest' }); };
$('btnWipeNo').onclick = () => { $('wipeBox').hidden = true; $('btnWipe').hidden = false; };
$('btnWipeYes').onclick = async () => {
  $('btnWipeYes').disabled = true;
  const r = await api.wipe({ deleteExe: !!settings?.canDeleteExe && $('tWipeExe').checked });
  if (!r.ok) { $('btnWipeYes').disabled = false; showCfgErr(r.message || 'Не удалось удалить данные'); }
};
$('tNotify').onchange = () => api.setSettings({ notify: $('tNotify').checked });
let notifyTimer;
$('fNotifyH').addEventListener('input', () => {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => { const n = Number($('fNotifyH').value); if (n >= 1) api.setSettings({ notifyHours: n }); }, 500);
});

/* ---------- события от main ---------- */
api.onAccent(applyAccent);
api.onRefresh(() => sync());
api.onLogin(() => doLogin());
api.onSettings(applySettings);
api.onAuthChanged(v => { loggedIn = v; if (!v) { demo = true; upcoming = []; events = indexEvents(demoEvents()); setStatus('', 'Не подключено'); } updateButtons(); render(); updateNext(true); });

/* ---------- старт ---------- */
(async function init() {
  applyAccent(await api.getAccent());
  events = indexEvents(demoEvents());
  applySettings(await api.getSettings());
  loggedIn = (await api.authStatus()).loggedIn;
  updateButtons();
  render();
  api.updateState().then(s => { upd = s; renderUpdate(); });
  if (loggedIn) { await sync(); }
  else setStatus('', 'Показаны примеры — войдите в Google');
  // автообновление данных раз в 10 минут
  setInterval(() => { if (loggedIn) sync(); }, 10 * 60 * 1000);
  // раз в минуту: смена даты после полуночи, «Следующая смена», возврат на сегодня после бездействия
  let lastDay = ymd(new Date());
  setInterval(() => {
    const k = ymd(new Date());
    if (k !== lastDay) { lastDay = k; render(); if (loggedIn) sync(); }
    updateNext(false);
    const away = !isToday(sel) || !sameMonth(view, new Date());
    if (away && $('panel').hidden && Date.now() - lastActivity >= IDLE_RETURN_MS) goToday();
  }, 30 * 1000);
})();
