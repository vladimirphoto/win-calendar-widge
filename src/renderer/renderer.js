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
let advance = {};          // аванс: 'YYYY-MM|first|second' -> ₸
let advTimer = 0;
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

const hasAnyNames = () => (settings?.keywords || '').trim() !== '';
const isClean = () => !hasAnyNames(); // «чистый календарь»: ни смен, ни списка дня
function isShift(title) {
  const keys = (settings?.keywords || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  // имя не заполнено: чистый календарь без отметок смен
  if (!keys.length) return false;
  const t = String(title).toLowerCase();
  return keys.some(k => t.includes(k));
}

function visibleEvents(key) {
  const list = events[key] || [];
  return settings?.onlyMine && hasAnyNames() ? list.filter(e => e.shift) : list;
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
    map[k].sort((a, b) => (b.shift - a.shift) || (b.allDay - a.allDay) || (a.start - b.start)); // мои смены первыми
  }
  return map;
}

// примеров нет: пока вы не вошли в Google, календарь пустой и чистый
function demoEvents() { return []; }

let syncQueued = false;
let loaded = null;        // за какой период загружены события: { from, to } (мс)
let loadFailed = false;
// данные для открытого месяца (с соседними неделями сетки) ещё не пришли
function dataPending() {
  if (!loggedIn || demo || loadFailed || !loaded) return false;
  const a = new Date(view.getFullYear(), view.getMonth(), 1).getTime() - 7 * 864e5;
  const b = new Date(view.getFullYear(), view.getMonth() + 1, 1).getTime() + 7 * 864e5;
  return a < loaded.from || b > loaded.to;
}
async function sync() {
  if (!loggedIn) return;
  if (syncing) { syncQueued = true; return; } // быстрые клики по стрелкам: догружаем последний открытый месяц
  syncing = true;
  setStatus('busy', 'Синхронизация…');
  const from = new Date(view.getFullYear(), view.getMonth() - 1, 1);
  const to = new Date(view.getFullYear(), view.getMonth() + 2, 1);
  let res;
  try { res = await api.getEvents({ from: from.toISOString(), to: to.toISOString() }); }
  catch (e) { res = { ok: false, code: 'ERR', message: e?.message }; }
  syncing = false;
  loadFailed = !res.ok;
  if (res.ok) loaded = { from: from.getTime(), to: to.getTime() };
  if (syncQueued) { syncQueued = false; if (dataPendingFor(from, to)) { sync(); return; } }
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
    renderNotifyWhen();
  } else if (res.code === 'NOT_AUTH') {
    loggedIn = false; demo = true; upcoming = [];
    events = indexEvents(demoEvents());
    setStatus('', 'Нужен вход в Google');
    updateButtons(); render(); updateNext(true);
  } else {
    setStatus(res.code === 'OFFLINE' ? 'off' : 'err', res.code === 'OFFLINE' ? 'Нет интернета' : 'Ошибка: ' + (res.message || 'не удалось обновить'));
  }
}

function dataPendingFor(from, to) { // открытый сейчас месяц вышел за границы только что загруженного?
  const a = new Date(view.getFullYear(), view.getMonth(), 1).getTime() - 7 * 864e5;
  const b = new Date(view.getFullYear(), view.getMonth() + 1, 1).getTime() + 7 * 864e5;
  return a < from.getTime() || b > to.getTime();
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
    ? 'Вы вошли. Доступ только на чтение.'
    : (settings?.customClient
      ? 'Используется ваш Client ID.'
      : 'Откроется браузер. Доступ только на чтение.');
}

const colorOrder = [];
function render() {
  $('title').innerHTML = `${esc(view.toLocaleDateString('ru', { month: 'long' }))}<small>${view.getFullYear()}</small>`;
  $('dows').innerHTML = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(n => `<div class="dow">${n}</div>`).join('');

  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const todayK = ymd(new Date()), selK = ymd(sel);
  const clean = isClean(); // имя не заполнено: никаких отметок смен и точек
  const pending = dataPending(); // месяц ещё подгружается: не рисуем «свободные» дни по пустым данным
  const freeSet = settings?.freeOn && !clean && !pending ? new Set(freeRuns().flat().map(ymd)) : null;
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = ymd(d), evs = visibleEvents(k);
    const cls = ['day'];
    if (d.getMonth() !== view.getMonth()) cls.push('other');
    if (evs.some(e => e.shift)) cls.push('shift');
    else if (freeSet && freeSet.has(k)) cls.push('free');
    if (k === todayK) cls.push('today');
    if (k === selK) cls.push('sel');
    // цвета студий (смен) за день без повторов
    const sc = [...new Set(evs.filter(e => e.shift).map(e => e.color || '#0f7b6c'))].slice(0, 3);
    // по точке на каждую студию (цвет) за день, в одном и том же порядке во всех днях
    const dcs = clean ? [] : [...new Set(evs.map(e => e.color || ''))];
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
  const pc = isClean() ? '' : payCountdown();
  if (pc) sub += (sub ? ' · ' : '') + pc;
  $('sub').textContent = sub;
  document.getElementById('card').classList.toggle('loading', pending);
  if (!pending) { updateEarn(); renderInsights(); }
  renderAdv();
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

// сколько дней до ближайшей ЗП (1 и 15 числа) в открытом месяце; в прошедшем месяце ничего
function payCountdown() {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const y = view.getFullYear(), m = view.getMonth();
  const next = [new Date(y, m, 1), new Date(y, m, 15)].find(d => d >= t);
  if (!next) {
    if (!sameMonth(view, t)) return ''; // месяц уже прошёл
    // в этом месяце выплат больше нет: считаем до первого числа следующего
    const n1 = new Date(y, m + 1, 1), n = Math.round((n1 - t) / 864e5);
    return `ЗП через ${n} ${plural(n, 'день', 'дня', 'дней')}`;
  }
  const n = Math.round((next - t) / 864e5);
  return n === 0 ? 'ЗП сегодня' : `ЗП через ${n} ${plural(n, 'день', 'дня', 'дней')}`;
}

const PAY_POS = { month: 0, first: 1, second: 2 };
const payPeriod = () => (settings?.payPeriod in PAY_POS ? settings.payPeriod : 'month');

const pad2 = n => String(n).padStart(2, '0');
const advKey = half => `${view.getFullYear()}-${pad2(view.getMonth() + 1)}|${half}`;
const advFor = half => advance[advKey(half)] || 0;

function updateEarn() {
  const period = payPeriod();
  const list = monthShifts().filter(e => period === 'month' || (period === 'first') === (e.start.getDate() <= 15));
  const earn = list.reduce((sum, e) => sum + payFor(e), 0);
  const adv = !settings?.advanceOn ? 0 : period === 'month' ? advFor('first') + advFor('second') : advFor(period);
  const earnEl = $('earn');
  const showEarn = (list.length > 0 && earn > 0) || adv > 0;
  const lastDay = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const label = period === 'first' ? 'Заработок 1–15' : period === 'second' ? `Заработок 16–${lastDay}` : 'Заработок';
  if (showEarn) {
    const main = document.createElement('span'); main.textContent = label + ': ' + money(earn);
    const kids = [main];
    if (adv > 0) {
      const line = document.createElement('span'); line.className = 'adv';
      line.textContent = `аванс −${money(adv)} · к выплате ${money(Math.max(0, earn - adv))}`;
      kids.push(line);
    } else if (settings?.advanceOn && period !== 'month' && advFor(period === 'first' ? 'second' : 'first') > 0) {
      const line = document.createElement('span'); line.className = 'adv';
      line.textContent = `аванс ${period === 'first' ? '1–15' : `16–${lastDay}`} не указан`;
      kids.push(line);
    }
    const sig = kids.map(k => k.textContent).join('\n');
    if (earnEl.dataset.sig !== sig) { earnEl.replaceChildren(...kids); earnEl.dataset.sig = sig; }
  }
  if (earnEl.hidden === showEarn) earnEl.hidden = !showEarn;
  fitTitle();
}

// поля аванса в настройках показывают открытый сейчас месяц
function renderAdv() {
  $('advMonth').textContent = view.toLocaleDateString('ru', { month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
  for (const half of ['first', 'second']) {
    const inp = $(half === 'first' ? 'fAdvFirst' : 'fAdvSecond');
    if (document.activeElement === inp) continue;
    const v = advFor(half); inp.value = v ? String(v) : '';
  }
}

/* ---------- панели под сеткой: цель, студии, свободные дни ---------- */
const mk = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };

// серии подряд идущих дней без моих смен (в сетке месяца, от сегодняшнего дня), не короче settings.freeMin
function freeRuns() {
  const min = Math.min(7, Math.max(2, settings?.freeMin || 3));
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const todayK = ymd(new Date());
  const runs = []; let cur = [];
  const flush = () => { if (cur.length >= min) runs.push(cur); cur = []; };
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = ymd(d);
    if (k >= todayK && !(events[k] || []).some(e => e.shift)) cur.push(d); else flush();
  }
  flush();
  return runs;
}
const shortDate = d => d.toLocaleDateString('ru', { day: 'numeric', month: 'short' }).replace('.', '');
function runLabel(run) {
  const a = run[0], b = run[run.length - 1], n = run.length;
  const span = sameMonth(a, b) ? `${a.getDate()}–${shortDate(b)}` : `${shortDate(a)} – ${shortDate(b)}`;
  return `${span} (${n} ${plural(n, 'день', 'дня', 'дней')})`;
}

function renderInsights() {
  const box = $('ins');
  const kids = [];
  if (!isClean()) {
    const list = monthShifts();
    const per = payPeriod();
    const plist = list.filter(e => per === 'month' || (per === 'first') === (e.start.getDate() <= 15));
    const goal = settings?.goal; // цель на месяц
    if (settings?.goalOn && goal > 0) {
      const now = Date.now();
      const planned = list.reduce((s, e) => s + payFor(e), 0);
      const done = list.filter(e => e.end.getTime() <= now).reduce((s, e) => s + payFor(e), 0);
      const wrap = mk('div');
      const gt = mk('div', 'gt');
      const l = mk('span'); l.append('Заработано ', mk('b', '', money(done)), ' из ' + money(goal));
      gt.append(l, mk('span', '', done >= goal ? 'цель достигнута' : 'осталось ' + money(goal - done)));
      const bar = mk('div', 'gbar');
      bar.title = `С запланированными сменами: ${money(planned)}`;
      const gp = mk('i', 'gp'); gp.style.width = Math.min(100, planned / goal * 100) + '%';
      const gd = mk('i', 'gd'); gd.style.width = Math.min(100, done / goal * 100) + '%';
      bar.append(gp, gd);
      wrap.append(gt, bar);
      kids.push(wrap);
    }
    if (settings?.statsOn) {
      const names = new Map(studiosList().map(s => [s.key, s]));
      const by = new Map();
      for (const e of plist) {
        const k = rateKey(e.color);
        const it = by.get(k) || { k, n: 0, sum: 0 };
        it.n++; it.sum += payFor(e); by.set(k, it);
      }
      const rows = [...by.values()].sort((a, b) => b.sum - a.sum || b.n - a.n);
      if (rows.length) {
        const wrap = mk('div');
        const lastD = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
        wrap.append(mk('div', 'sh', per === 'first' ? 'По студиям за 1–15' : per === 'second' ? `По студиям за 16–${lastD}` : 'По студиям за месяц'));
        for (const r of rows) {
          const st = names.get(r.k);
          const row = mk('div', 'st');
          const dot = mk('i'); if (st?.color) dot.style.background = st.color;
          const nm = mk('span', 'n', st?.name || 'Без названия'); nm.title = nm.textContent;
          row.append(dot, nm, mk('span', 'c', `${r.n} ${plural(r.n, 'смена', 'смены', 'смен')}`), mk('span', 'm', r.sum > 0 ? money(r.sum) : '—'));
          wrap.append(row);
        }
        kids.push(wrap);
      }
    }
    const monthEnd = new Date(view.getFullYear(), view.getMonth() + 1, 0, 23, 59, 59);
    if (settings?.freeOn && monthEnd >= new Date()) {
      const runs = freeRuns().filter(r => r.some(d => sameMonth(d, view)));
      const p = mk('div', 'fr2');
      if (runs.length) {
        p.append(mk('b', '', 'Серия выходных: '), runs.slice(0, 3).map(runLabel).join(' · ') + (runs.length > 3 ? ' …' : ''));
      } else p.textContent = `Серий выходных от ${settings.freeMin || 3} дн. нет`;
      kids.push(p);
    }
  }
  const sig = kids.map(k => k.outerHTML).join('');
  if (box.dataset.sig !== sig) { box.replaceChildren(...kids); box.dataset.sig = sig; }
  if (box.hidden === (kids.length > 0)) box.hidden = !kids.length;
}

// заголовок дня: длинный день недели, а если заработок рядом не помещается в строку, сокращённый («Вс, 25 октября»)
function fitTitle() {
  const h = $('agTitle'), e = $('earn');
  const text = short => sel.toLocaleDateString('ru', { weekday: short ? 'short' : 'long', day: 'numeric', month: 'long' });
  const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
  const over = () => h.scrollWidth > h.clientWidth + 1;
  h.textContent = cap(text(false));
  if (over()) h.textContent = cap(text(true));
  if (over()) h.textContent = sel.toLocaleDateString('ru', { day: 'numeric', month: 'numeric' });
}

function renderAgenda() {
  const sec = document.querySelector('.agenda');
  sec.hidden = isClean();
  if (isClean()) { agEvs = []; return; }
  fitTitle();
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

/* тема: «Светлая» / «Тёмная» / «Стекло»; пока человек не выбрал, следуем теме Windows */
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
const THEME_POS = { light: 0, dark: 1, glass: 2 };
function effectiveTheme(s) {
  const t = s?.theme;
  return t === 'light' || t === 'dark' || t === 'glass' ? t : t === 'ios' ? 'glass' : (darkMQ.matches ? 'dark' : 'light');
}
function applyTheme(s) {
  const t = effectiveTheme(s);
  document.documentElement.dataset.theme = t;
  const glassy = t === 'glass';
  $('glassField').hidden = !glassy;
  $('opacityField').hidden = glassy; // в «Стекле» вместо обычной прозрачности свой ползунок
  if (glassy) refreshGlass(); else $('glassbg').hidden = true;
  const seg = $('themeSeg');
  if (!seg.dataset.ready) { // первый показ без анимации
    seg.classList.add('noanim'); seg.dataset.ready = '1';
    requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('noanim')));
  }
  seg.dataset.pos = String(THEME_POS[t]);
  seg.querySelectorAll('button').forEach(b => {
    const on = b.dataset.theme === t;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
}
darkMQ.addEventListener('change', () => { if (settings) { applyTheme(settings); fitWindow(); } });

/* ---- «Стекло»: размытые обои под карточкой, выровненные по экрану ---- */
const GLASS_PAD = 60; // запас вокруг карточки, чтобы края размытия не выцветали
let glass = null;
let glassRaf = 0;
async function refreshGlass() {
  try { glass = await api.glassInfo(); } catch { glass = null; }
  layoutGlass();
}
function layoutGlass() {
  const root = $('glassbg'), gw = $('gw');
  if (effectiveTheme(settings) !== 'glass' || !glass?.wall || !glass.disp || !glass.win) { root.hidden = true; return; }
  const { wall, disp, win: wp } = glass;
  const iw = wall.w, ih = wall.h, dw = disp.width, dh = disp.height;
  let bw = dw, bh = dh;
  if (wall.style === 'fill' || wall.style === 'center' || wall.style === 'tile') { const k = Math.max(dw / iw, dh / ih); bw = iw * k; bh = ih * k; }
  else if (wall.style === 'fit') { const k = Math.min(dw / iw, dh / ih); bw = iw * k; bh = ih * k; }
  const bx = (dw - bw) / 2, by = (dh - bh) / 2;
  const r = $('card').getBoundingClientRect();
  const sx = wp.x + r.left - GLASS_PAD - disp.x, sy = wp.y + r.top - GLASS_PAD - disp.y;
  if (gw.dataset.url !== wall.url) { gw.style.backgroundImage = `url("${wall.url}")`; gw.dataset.url = wall.url; }
  gw.style.backgroundSize = `${bw}px ${bh}px`;
  gw.style.backgroundPosition = `${bx - sx}px ${by - sy}px`;
  root.hidden = false;
}
api.onGlassGeometry(g => {
  if (!glass || !g) return;
  glass = { ...glass, ...g };
  cancelAnimationFrame(glassRaf);
  glassRaf = requestAnimationFrame(layoutGlass);
});
setInterval(() => { if (effectiveTheme(settings) === 'glass' && !document.hidden) refreshGlass(); }, 5 * 60 * 1000); // обои могли смениться

function renderPaySeg() {
  const seg = $('paySeg'), p = payPeriod();
  if (!seg.dataset.ready) { // первый показ без анимации
    seg.classList.add('noanim'); seg.dataset.ready = '1';
    requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('noanim')));
  }
  seg.dataset.pos = String(PAY_POS[p]);
  seg.querySelectorAll('button').forEach(b => {
    const on = b.dataset.period === p;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
}

function applySettings(s) {
  settings = s;
  fitFloor = 0;
  applyTheme(s);
  const gb = sliderBusy('fBlur') ? Number($('fBlur').value) : (s.glassBlur ?? 20);
  document.documentElement.style.setProperty('--glass-blur', gb + 'px');
  // чем резче стекло, тем ближе цвета к настоящим обоям; насыщенность растёт вместе с размытием
  document.documentElement.style.setProperty('--glass-sat', String(+(1 + 0.8 * Math.min(1, gb / 20)).toFixed(2)));
  if (!sliderBusy('fBlur')) $('fBlur').value = s.glassBlur ?? 20;
  renderPaySeg();
  if (!advTimer) advance = { ...(s.advance || {}) };
  if (!payTimer) dayPay = { ...(s.dayPay || {}) }; // пока человек вводит сумму, локальные значения главнее
  if (!sliderBusy('fOpacity')) document.documentElement.style.setProperty('--alpha', String(s.opacity));
  document.body.classList.toggle('locked', !!s.locked);
  $('fKeys').value = s.keywords;
  if (!sliderBusy('fOpacity')) $('fOpacity').value = Math.round(s.opacity * 100);
  renderCloud(s.cloud);
  $('tAuto').checked = !!s.autostart;
  $('tTop').checked = !!s.alwaysOnTop;
  $('tLock').checked = !!s.locked;
  $('tOnly').checked = !!s.onlyMine;
  $('devNote').hidden = !!s.packaged;
  $('tGoal').checked = !!s.goalOn; $('rGoal').hidden = !s.goalOn;
  $('tStats').checked = !!s.statsOn;
  $('tFree').checked = !!s.freeOn; $('rFree').hidden = !s.freeOn;
  $('tFun').checked = s.surprise !== false; $('rFun').hidden = s.surprise === false;
  if (document.activeElement !== $('fFunTime')) $('fFunTime').value = s.surpriseTime || '10:00';
  $('tAdv').checked = !!s.advanceOn; $('advBox').hidden = !s.advanceOn;
  if (document.activeElement !== $('fGoal')) $('fGoal').value = s.goal > 0 ? String(s.goal) : '';
  if (document.activeElement !== $('fFreeMin')) $('fFreeMin').value = s.freeMin || 3;
  $('tNotify').checked = !!s.notify;
  $('tAutoUpd').checked = !!s.autoUpdate;
  renderUpdate();
  if (document.activeElement !== $('fNotifyH')) $('fNotifyH').value = s.notifyHours;
  if (document.activeElement !== $('fNotifyEve')) $('fNotifyEve').value = s.notifyEve || '20:00';
  // ключевые слова могли поменяться — пересобрать подсветку из уже загруженных данных
  const namesSig = s.keywords;
  if (namesSig !== lastKeys) {
    lastKeys = namesSig;
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
  renderNotifyWhen();
}

// подсказка: когда придёт напоминание (считаем от ближайшей смены, если её нет, от 10:00)
function renderNotifyWhen() {
  const el = $('notifyWhen'); if (!el || !settings) return;
  const nxt = upcoming.filter(e => e.shift && !e.allDay && e.start > new Date()).sort((a, b) => a.start - b.start)[0];
  const h = nxt ? nxt.start.getHours() : 10, m = nxt ? nxt.start.getMinutes() : 0;
  const lead = Math.max(1, Number(settings.notifyHours) || 1);
  const at = new Date(2000, 0, 5, h, m) - lead * 3600e3;
  const d = new Date(at), prev = d.getDate() !== 5;
  const hhmm = `${pad(h)}:${pad(m)}`;
  el.textContent = `Смена в ${hhmm}: напомню ${prev ? 'накануне ' : ''}в ${fmtT(d)}.`;
}

/* ---------- ставки по студиям ---------- */
// студия определяется цветом метки; подпись — самое частое название события этого цвета
function studiosList() {
  const info = new Map();
  const add = e => {
    const k = rateKey(e.color);
    const it = info.get(k) || { key: k, color: e.color || '', names: new Map() };
    const nm = e.calendar || e.title;
    it.names.set(nm, (it.names.get(nm) || 0) + 1);
    info.set(k, it);
  };
  if (!demo) {
    const seen = new Set();
    for (const e of Object.values(events).flat()) {
      const id = e.id + '|' + e.start.getTime();
      if (!seen.has(id)) { seen.add(id); add(e); }
    }
  }
  for (const k of Object.keys(settings?.rates || {})) {
    if (!info.has(k)) info.set(k, { key: k, color: k === 'none' ? '' : k, names: new Map() });
  }
  return [...info.values()].map(it => {
    const top = [...it.names.entries()].sort((a, b) => b[1] - a[1])[0];
    return { key: it.key, color: it.color, name: top ? top[0] : (it.color ? 'Студия ' + it.color : 'Без цвета') };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
function renderRates() {
  const box = $('rates');
  if (box.contains(document.activeElement)) return; // не перерисовывать, пока человек вводит сумму
  const list = studiosList();
  $('ratesEmpty').hidden = list.length > 0;
  box.textContent = '';
  const mine = (settings?.keywords || '').trim(); // ваше имя из поля «Что считать сменой»
  for (const st of list) {
    const row = document.createElement('div'); row.className = 'studio';
    const label = document.createElement('label'); label.className = 'nm';
    const dot = document.createElement('b'); if (st.color) dot.style.background = st.color;
    const text = document.createElement('div'); text.className = 'txt';
    const name = document.createElement('span'); name.className = 'sn'; name.textContent = st.name; name.title = st.name;
    text.append(name);
    if (mine) { const who = document.createElement('span'); who.className = 'who'; who.textContent = mine; text.append(who); }
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.step = '500'; input.inputMode = 'numeric';
    input.placeholder = '0'; input.dataset.k = st.key;
    input.id = 'rate-' + st.key.replace(/[^a-z0-9]/gi, '');
    const v = settings?.rates?.[st.key]; if (v) input.value = String(v);
    label.htmlFor = input.id; label.append(dot, text);
    const fld = document.createElement('span'); fld.className = 'fld';
    const suf = document.createElement('i'); suf.className = 'suf'; suf.textContent = '₸';
    fld.append(input, suf);
    row.append(label, fld);
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
    const rateIn = [...$('rates').querySelectorAll('input[data-k]')];
    rateIn.forEach(i => { const n = Number(i.value); if (n > 0) rates[i.dataset.k] = n; });
    // студии, которых сейчас нет на экране, не теряем
    const shown = new Set(rateIn.map(i => i.dataset.k));
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
    // смены на весь день уведомляют накануне вечером; без слов в «Что считать сменой» «сменой» считается всё подряд, поэтому их не шлём
    const hasKeys = hasAnyNames();
    api.setShifts(shifts.filter(e => e.start > now && (!e.allDay || hasKeys)).slice(0, 100)
      .map(e => ({ id: e.id, title: e.title, start: e.start.getTime(), allDay: !!e.allDay, calendar: e.calendar || '' })));
  }
}

function openPanel() { renderRates(); $('panel').hidden = false; document.body.classList.add('panel-open'); api.fit(10000); }
function closePanel() { $('panel').hidden = true; document.body.classList.remove('panel-open'); hideCfgErr(); fitWindow(); }

function renderSeg() {
  const mine = !!settings?.onlyMine;
  const seg = $('seg');
  if (!seg.dataset.ready) { // первый показ без анимации, чтобы подложка не «ездила» при запуске
    seg.classList.add('noanim'); seg.dataset.pos = mine ? '0' : '1'; seg.dataset.ready = '1';
    requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('noanim')));
  } else seg.dataset.pos = mine ? '0' : '1';
  $('segMine').classList.toggle('on', mine);
  $('segAll').classList.toggle('on', !mine);
  $('segMine').setAttribute('aria-pressed', String(mine));
  $('segAll').setAttribute('aria-pressed', String(!mine));
}

// окно подгоняется под содержимое, чтобы не оставалось пустого места
let fitRaf = 0;
let fitFloor = 0; // при листании месяцев окно не сжимается, чтобы не прыгало
let lastFit = 0;
function fitWindow() {
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    if (!$('panel').hidden) return;
    const card = $('card'), list = $('agList');
    // меряем без ограничений по высоте окна, иначе при ещё не выросшем окне высота занижается и часть блоков (аванс) обрезается
    const mh = card.style.maxHeight; card.style.maxHeight = 'none';
    const natural = card.offsetHeight - list.clientHeight + list.scrollHeight;
    card.style.maxHeight = mh;
    lastFit = Math.max(natural + 32, fitFloor); // 32 = внешние отступы body
    api.fit(lastFit);
  });
}
// после реального изменения размера окна пересчитываем ещё раз
let resizeT = 0;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if ($('panel').hidden) fitWindow(); }, 120); });
function showCfgErr(m) { const el = $('cfgErr'); el.textContent = m; el.hidden = false; }
function hideCfgErr() { $('cfgErr').hidden = true; }

/* ---------- события интерфейса ---------- */
function shiftMonth(delta) {
  fitFloor = Math.max(fitFloor, lastFit);
  view = new Date(view.getFullYear(), view.getMonth() + delta, 1);
  render(); sync();
}
$('btnPrev').onclick = () => shiftMonth(-1);
$('btnNext').onclick = () => shiftMonth(1);
function goToday() { fitFloor = 0; view = new Date(); view.setDate(1); view.setHours(0, 0, 0, 0); sel = new Date(); render(); sync(); }
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
function renderCloud(c) {
  const el = $('cloudHint'); if (!el) return;
  const st = c && c.state;
  const hhmm = c && c.at ? new Date(c.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
  const T = {
    syncing: 'Облако: синхронизирую…',
    ok: 'Облако: данные сохранены в вашем Google-аккаунте' + (hhmm ? ' · ' + hhmm : ''),
    reauth: 'Облако выключено: нажмите «Войти через Google» ещё раз и разрешите доступ к Drive',
    api: 'Облако недоступно: администратору нужно включить Google Drive API',
    offline: 'Облако: нет интернета, отправлю позже',
    error: 'Облако: не удалось синхронизировать'
  };
  el.textContent = T[st] || '';
  el.hidden = !T[st];
  el.classList.toggle('bad', st === 'reauth' || st === 'api' || st === 'error');
}
// ползунки: пока ползунок зажат, ответ от main не должен возвращать его на старое место
const sliderDown = new Set();
function sliderBusy(id) { return sliderDown.has(id) || document.activeElement === $(id); }
for (const id of ['fOpacity', 'fBlur']) {
  const el = $(id);
  el.addEventListener('pointerdown', () => sliderDown.add(id));
  for (const ev of ['pointerup', 'pointercancel', 'blur']) el.addEventListener(ev, () => setTimeout(() => sliderDown.delete(id), 300));
}
let sliderSaveT;
function saveSliderSoon(patch) { clearTimeout(sliderSaveT); sliderSaveT = setTimeout(() => api.setSettings(patch), 60); }
$('fOpacity').addEventListener('input', () => {
  const v = Number($('fOpacity').value) / 100;
  document.documentElement.style.setProperty('--alpha', String(v)); // видно сразу
  saveSliderSoon({ opacity: v });
});
$('tAuto').onchange = () => api.setSettings({ autostart: $('tAuto').checked });
$('segAll').onclick = () => api.setSettings({ onlyMine: false });
$('segMine').onclick = () => {
  if (!hasAnyNames()) { openPanel(); $('fKeys').focus(); return; }
  api.setSettings({ onlyMine: true });
};
$('fBlur').addEventListener('input', () => saveSliderSoon({ glassBlur: Number($('fBlur').value) }));
$('themeSeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-theme]');
  if (b) api.setSettings({ theme: b.dataset.theme });
});
function flushAdv() {
  clearTimeout(advTimer); advTimer = 0;
  api.setSettings({ advance });
}
for (const id of ['fAdvFirst', 'fAdvSecond']) {
  $(id).addEventListener('input', () => {
    const inp = $(id), key = advKey(inp.dataset.half);
    const n = Math.max(0, Math.min(1e9, Math.round(Number(inp.value) || 0)));
    if (n > 0) advance[key] = n; else delete advance[key];
    updateEarn();
    clearTimeout(advTimer);
    advTimer = setTimeout(flushAdv, 600);
  });
  $(id).addEventListener('change', () => { if (advTimer) flushAdv(); });
}
$('paySeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-period]');
  if (b) api.setSettings({ payPeriod: b.dataset.period });
});
$('tOnly').onchange =() => api.setSettings({ onlyMine: $('tOnly').checked });
$('tTop').onchange = () => api.setSettings({ alwaysOnTop: $('tTop').checked });
$('tLock').onchange = () => api.setSettings({ locked: $('tLock').checked });

/* ---------- обновления ---------- */
let upd = { state: 'idle' };
function renderUpdate() {
  const v = settings?.version || upd.current || '';
  const st = upd.state, btn = $('btnUpd'), txt = $('updText');
  btn.disabled = false;
  let t = `Версия ${v}`, tail = '';
  btn.textContent = 'Проверить';
  if (st === 'checking') { tail = 'проверяю…'; btn.disabled = true; btn.textContent = 'Проверяю…'; }
  else if (st === 'available') { tail = `доступна ${upd.latest}`; btn.textContent = `Установить ${upd.latest}`; }
  else if (st === 'downloading') { tail = `скачиваю ${upd.latest}: ${upd.progress || 0}%`; btn.disabled = true; btn.textContent = 'Скачиваю…'; }
  else if (st === 'installing') { tail = 'перезапуск…'; btn.disabled = true; btn.textContent = 'Перезапуск…'; }
  else if (st === 'uptodate') tail = 'последняя';
  else if (st === 'error') { tail = upd.message || 'не удалось проверить'; btn.textContent = 'Повторить'; }
  else if (st === 'unsupported') { tail = upd.message || ''; btn.disabled = true; }
  txt.textContent = tail ? `${t} · ${tail}` : t;
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
$('btnNotifyTest').onclick = async () => {
  const msg = $('notifyMsg');
  const r = await api.notifyTest();
  msg.textContent = r?.ok ? 'Отправлено. Не видно? Проверьте «Не беспокоить».' : (r?.message || 'Не удалось');
  setTimeout(() => { msg.textContent = ''; }, 8000);
};
let clearArmed = 0;
$('btnClearPay').onclick = async () => {
  const b = $('btnClearPay');
  if (!clearArmed) {
    b.textContent = 'Точно очистить?';
    clearArmed = setTimeout(() => { clearArmed = 0; b.textContent = 'Очистить заработок'; }, 4000);
    return;
  }
  clearTimeout(clearArmed); clearArmed = 0; b.textContent = 'Очистить заработок';
  clearTimeout(payTimer); payTimer = 0;
  dayPay = {};
  clearTimeout(advTimer); advTimer = 0; advance = {};
  await api.setSettings({ rates: {}, dayPay: {}, advance: {} });
  renderRates();
  render();
};
$('tGoal').onchange = () => api.setSettings({ goalOn: $('tGoal').checked });
$('tStats').onchange = () => api.setSettings({ statsOn: $('tStats').checked });
$('tAdv').onchange = () => api.setSettings({ advanceOn: $('tAdv').checked });
let advClearArmed = 0;
$('btnClearAdv').onclick = async () => {
  const b = $('btnClearAdv');
  if (!advClearArmed) {
    b.textContent = 'Точно очистить?';
    advClearArmed = setTimeout(() => { advClearArmed = 0; b.textContent = 'Очистить аванс'; }, 4000);
    return;
  }
  clearTimeout(advClearArmed); advClearArmed = 0; b.textContent = 'Очистить аванс';
  clearTimeout(advTimer); advTimer = 0; advance = {};
  await api.setSettings({ advance: {} });
  renderAdv(); updateEarn();
};
$('tFun').onchange = () => api.setSettings({ surprise: $('tFun').checked });
$('tFree').onchange = () => api.setSettings({ freeOn: $('tFree').checked });
let panelsTimer;
$('fGoal').addEventListener('input', () => {
  clearTimeout(panelsTimer);
  panelsTimer = setTimeout(() => api.setSettings({ goal: Math.max(0, Number($('fGoal').value) || 0) }), 500);
});
$('fFunTime').addEventListener('change', () => { if ($('fFunTime').value) api.setSettings({ surpriseTime: $('fFunTime').value }); });
$('fFreeMin').addEventListener('input', () => {
  clearTimeout(panelsTimer);
  panelsTimer = setTimeout(() => { const n = Number($('fFreeMin').value); if (n >= 2) api.setSettings({ freeMin: n }); }, 500);
});
$('tNotify').onchange = () => api.setSettings({ notify: $('tNotify').checked });
$('fNotifyEve').addEventListener('change', () => { if ($('fNotifyEve').value) api.setSettings({ notifyEve: $('fNotifyEve').value }); });
let notifyTimer;
$('fNotifyH').addEventListener('input', () => {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => { const n = Number($('fNotifyH').value); if (n >= 1) api.setSettings({ notifyHours: n }); }, 500);
});

/* ---------- события от main ---------- */
api.onAccent(applyAccent);
api.onRefresh(() => sync());
api.onPayday(() => paydayConfetti());
api.onLogin(() => doLogin());
api.onSettings(applySettings);
api.onAuthChanged(v => { loggedIn = v; if (!v) { demo = true; upcoming = []; events = indexEvents(demoEvents()); setStatus('', 'Не подключено'); } updateButtons(); render(); updateNext(true); });

/* ---------- старт ---------- */
/* ---------- сюрприз: конфетти ---------- */
// в день выплаты (1 и 15 число) при первом показе за день, а также если быстро кликнуть 5 раз на строку с датой под календарём
let fxBusy = false;
function confetti() {
  if (fxBusy || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  fxBusy = true;
  const card = $('card');
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:30;border-radius:inherit';
  const w = cv.width = card.clientWidth, h = cv.height = card.clientHeight;
  card.append(cv);
  const ctx = cv.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const colors = [cs.getPropertyValue('--accent').trim() || '#0067c0', cs.getPropertyValue('--shift').trim() || '#0b6f61', '#f7b500', '#e5484d', '#8e5cf0', '#2bb6a3'];
  const parts = Array.from({ length: 110 }, () => ({
    x: w * (0.15 + Math.random() * 0.7), y: -10 - Math.random() * h * 0.35,
    vx: (Math.random() - 0.5) * 3.2, vy: 1.6 + Math.random() * 2.6,
    s: 4 + Math.random() * 5, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0]
  }));
  const t0 = performance.now(), DUR = 2600;
  let raf = 0;
  const stop = () => { cancelAnimationFrame(raf); cv.remove(); fxBusy = false; };
  const tick = now => {
    const k = (now - t0) / DUR;
    if (k >= 1 || !cv.isConnected) return stop();
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.035; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
let titleClicks = [];
$('agTitle').addEventListener('click', () => {
  if (settings?.surprise === false) return;
  const now = Date.now();
  titleClicks = titleClicks.filter(t => now - t < 2000).concat(now);
  if (titleClicks.length >= 5) { titleClicks = []; confetti(); }
});
function paydayConfetti() {
  if (settings?.surprise === false) return;
  if (document.visibilityState !== 'visible') return; // окно скрыто в трей: покажем, когда его откроют
  const d = new Date(); if (d.getDate() !== 1 && d.getDate() !== 15) return;
  const [fh, fm] = (settings?.surpriseTime || '10:00').split(':').map(Number);
  if (d.getHours() * 60 + d.getMinutes() < fh * 60 + fm) return; // ещё рано: покажем в выбранное время
  const k = ymd(d);
  try { if (localStorage.getItem('payday-fx') === k) return; localStorage.setItem('payday-fx', k); } catch {}
  setTimeout(confetti, 700);
}

document.addEventListener('visibilitychange', paydayConfetti);

(async function init() {
  applyAccent(await api.getAccent());
  events = indexEvents(demoEvents());
  applySettings(await api.getSettings());
  loggedIn = (await api.authStatus()).loggedIn;
  updateButtons();
  render();
  api.updateState().then(s => { upd = s; renderUpdate(); });
  paydayConfetti();
  if (loggedIn) { await sync(); }
  else setStatus('', 'Не подключено');
  // автообновление данных раз в 10 минут
  setInterval(() => { if (loggedIn) sync(); }, 10 * 60 * 1000);
  // раз в минуту: смена даты после полуночи, «Следующая смена», возврат на сегодня после бездействия
  let lastDay = ymd(new Date());
  setInterval(() => {
    const k = ymd(new Date());
    if (k !== lastDay) { lastDay = k; render(); paydayConfetti(); if (loggedIn) sync(); }
    updateNext(false);
    paydayConfetti();
    const away = !isToday(sel) || !sameMonth(view, new Date());
    if (away && $('panel').hidden && Date.now() - lastActivity >= IDLE_RETURN_MS) goToday();
  }, 30 * 1000);
})();
