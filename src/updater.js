'use strict';
// Самообновление portable-exe из GitHub Releases.
// Схема: проверить версию -> скачать рядом с exe -> проверить размер/sha256/заголовок ->
// закрыться; внешний bat-скрипт дожидается выхода, подменяет файл и запускает новую версию.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOST_OK = /(^|\.)(github\.com|githubusercontent\.com)$/i;

function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
const batEsc = p => p.replace(/%/g, '%%');

function buildSwapScript(newFile, target) {
  const n = batEsc(newFile), t = batEsc(target);
  return [
    '@echo off', 'set n=0', ':retry', 'ping -n 2 127.0.0.1 >nul',
    `move /y "${n}" "${t}" >nul 2>nul`,
    `if not exist "${n}" goto launch`,
    'set /a n+=1', 'if %n% GEQ 40 goto fail', 'goto retry',
    ':fail', `if exist "${n}" del /f /q "${n}" 2>nul`,
    ':launch', `start "" "${t}"`,
    '(goto) 2>nul & del "%~f0"'
  ].join('\r\n') + '\r\n';
}

const VER_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'CalendarWidget-updater' };
class UErr extends Error { constructor(code, message) { super(message); this.code = code; } }
const asErr = e => (e instanceof UErr ? e : new UErr('HTTP', String(e?.message || e)));

function createUpdater(deps) {
  const {
    config, getVersion, getExePath, send, fetchFn = fetch, onQuit, spawnFn = spawn,
    getPin = () => ({ version: '', kept: false }), // зафиксированная версия: { version, kept }
    onApplied = () => {}                           // перед подменой exe: { version, rollback }
  } = deps;
  let state = { state: 'idle', current: getVersion() };
  let busy = false;
  let found = null; // { version, asset }
  let vcache = { at: 0, list: null };

  const set = patch => { state = { ...state, ...patch, current: getVersion() }; send(state); return state; };
  const supported = () => !!getExePath();
  const errState = e => { const x = asErr(e); return set({ state: 'error', code: x.code, message: x.message }); };

  // GET к GitHub API с понятными ошибками
  async function api(url) {
    let r;
    try { r = await fetchFn(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) }); }
    catch { throw new UErr('OFFLINE', 'Нет связи с интернетом'); }
    if (r.status === 404) throw new UErr('NOT_FOUND', 'Релиз не найден или репозиторий приватный');
    if (r.status === 403 || r.status === 429) throw new UErr('LIMIT', 'GitHub временно ограничил запросы, попробуйте позже');
    if (!r.ok) throw new UErr('HTTP', 'Ошибка GitHub: HTTP ' + r.status);
    return r.json();
  }

  // версии: отдельные релизы с тегами v1.0.N (тег `latest` не считается), новые первыми
  async function fetchVersions(force) {
    if (!force && vcache.list && Date.now() - vcache.at < 30000) return vcache.list;
    const arr = await api(`https://api.github.com/repos/${config.repo}/releases?per_page=30`);
    const list = [];
    for (const rel of Array.isArray(arr) ? arr : []) {
      if (rel.draft || rel.prerelease) continue;
      const m = VER_TAG.exec(String(rel.tag_name || ''));
      if (!m) continue;
      const asset = (rel.assets || []).find(a => a.name === config.asset && a.state === 'uploaded');
      if (!asset) continue;
      const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
      list.push({ version: parts.join('.'), parts, date: rel.published_at || rel.created_at || '', asset });
    }
    list.sort((a, b) => cmpVersion(b.parts, a.parts));
    vcache = { at: Date.now(), list };
    return list;
  }

  // старая схема: один релиз `latest` (пока нет релизов по версиям)
  async function fetchLegacy() {
    const rel = await api(`https://api.github.com/repos/${config.repo}/releases/tags/${config.tag}`);
    const parts = parseVersion(rel.name) || parseVersion(rel.body);
    const asset = (rel.assets || []).find(a => a.name === config.asset && a.state === 'uploaded');
    if (!parts || !asset) throw new UErr('BAD_RELEASE', 'В релизе нет версии или файла exe');
    return { version: parts.join('.'), parts, date: rel.published_at || '', asset };
  }

  async function check() {
    if (busy) return state;
    busy = true;
    try {
      if (!supported()) return set({ state: 'unsupported', message: 'Автообновление работает только в собранном exe' });
      set({ state: 'checking', message: '' });
      let newest;
      try {
        const list = await fetchVersions(true);
        newest = list[0] || await fetchLegacy();
      } catch (e) { return errState(e); }
      const cur = parseVersion(getVersion()) || [0, 0, 0];
      const pin = getPin() || {};
      // фиксация действует, только пока запущена именно эта версия
      if (pin.version && pin.version === cur.join('.')) { found = null; return set({ state: 'pinned', latest: newest.version, message: '' }); }
      if (cmpVersion(newest.parts, cur) <= 0) { found = null; return set({ state: 'uptodate', latest: newest.version, message: '' }); }
      found = { version: newest.version, asset: newest.asset };
      return set({ state: 'available', latest: found.version, message: '' });
    } finally { busy = false; }
  }

  // последние `limit` версий для списка в настройках (после «Оставить эту версию» более новые скрыты)
  async function versions(limit = 3) {
    let list;
    try { list = await fetchVersions(false); } catch (e) { const x = asErr(e); return { ok: false, code: x.code, message: x.message }; }
    const cur = (parseVersion(getVersion()) || [0, 0, 0]).join('.');
    const pin = getPin() || {};
    const kept = !!(pin.kept && pin.version && pin.version === cur);
    const pinParts = kept ? parseVersion(pin.version) : null;
    const shown = (pinParts ? list.filter(v => cmpVersion(v.parts, pinParts) <= 0) : list).slice(0, limit);
    return {
      ok: true, current: cur, newest: list[0]?.version || '', canInstall: supported(), kept,
      items: shown.map(v => ({ version: v.version, date: v.date, current: v.version === cur, newest: v.version === list[0].version }))
    };
  }

  async function install(version) {
    if (busy) return state;
    const target = getExePath();
    if (!target) return set({ state: 'unsupported', message: 'Автообновление работает только в собранном exe' });
    busy = true;
    const tmp = path.join(path.dirname(target), 'CalendarWidget.update.exe');
    try {
      let pick = found, rollback = false;
      if (version) { // конкретная версия из списка (в том числе более старая)
        let list;
        try { list = await fetchVersions(false); } catch (e) { return errState(e); }
        const v = list.find(x => x.version === version);
        if (!v) return set({ state: 'error', code: 'NONE', message: 'Такой версии нет в списке' });
        pick = { version: v.version, asset: v.asset };
        rollback = cmpVersion(v.parts, list[0].parts) < 0;
      }
      if (!pick) return set({ state: 'error', code: 'NONE', message: 'Сначала проверьте обновления' });
      const { asset } = pick;
      version = pick.version;
      set({ state: 'downloading', latest: version, progress: 0, message: '' });
      let r;
      try { r = await fetchFn(asset.browser_download_url, { headers: { 'User-Agent': 'CalendarWidget-updater' }, redirect: 'follow' }); }
      catch { return set({ state: 'error', code: 'OFFLINE', message: 'Нет связи с интернетом' }); }
      if (!r.ok || !r.body) return set({ state: 'error', code: 'HTTP', message: 'Не удалось скачать: HTTP ' + r.status });
      let host = ''; try { host = new URL(r.url || asset.browser_download_url).hostname; } catch {}
      if (!HOST_OK.test(host)) return set({ state: 'error', code: 'HOST', message: 'Файл отдаёт неизвестный сервер, обновление отменено' });

      const hash = crypto.createHash('sha256');
      let got = 0, last = 0, head = null;
      try {
        const out = fs.createWriteStream(tmp);
        const done = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
        const reader = r.body.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          if (!head) head = Buffer.from(value.subarray(0, 2));
          hash.update(value); got += value.length;
          if (!out.write(value)) await new Promise(res => out.once('drain', res));
          const pct = asset.size ? Math.floor(got / asset.size * 100) : 0;
          if (pct !== last) { last = pct; set({ progress: pct }); }
        }
        out.end(); await done;
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        return set({ state: 'error', code: 'WRITE', message: 'Не удалось сохранить файл рядом с exe: ' + (e.code || e.message) });
      }
      const bad = (msg) => { try { fs.rmSync(tmp, { force: true }); } catch {} return set({ state: 'error', code: 'VERIFY', message: msg }); };
      if (asset.size && got !== asset.size) return bad('Файл скачался не полностью, попробуйте ещё раз');
      if (!head || head.toString('latin1') !== 'MZ') return bad('Скачанный файл не похож на программу Windows');
      const want = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
      if (want && hash.digest('hex') !== want[1].toLowerCase()) return bad('Контрольная сумма не совпала, обновление отменено');

      try { onApplied({ version, rollback }); } catch {}
      set({ state: 'installing', message: 'Перезапуск…' });
      const bat = path.join(os.tmpdir(), 'calendar-widget-update-' + process.pid + '.bat');
      fs.writeFileSync(bat, buildSwapScript(tmp, target));
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (/^PORTABLE_EXECUTABLE/i.test(k)) delete env[k];
      spawnFn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
      onQuit();
      return state;
    } finally { busy = false; }
  }

  return { check, install, versions, getState: () => state, isFound: () => !!found };
}

module.exports = { createUpdater, parseVersion, cmpVersion, buildSwapScript };
