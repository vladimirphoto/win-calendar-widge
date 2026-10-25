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

function createUpdater(deps) {
  const { config, getVersion, getExePath, send, fetchFn = fetch, onQuit, spawnFn = spawn } = deps;
  let state = { state: 'idle', current: getVersion() };
  let busy = false;
  let found = null; // { version, asset }

  const set = patch => { state = { ...state, ...patch, current: getVersion() }; send(state); return state; };
  const supported = () => !!getExePath();

  async function check() {
    if (busy) return state;
    busy = true;
    try {
      if (!supported()) return set({ state: 'unsupported', message: process.platform === 'darwin' ? 'На Mac обновляйте вручную: скачайте новый архив из Releases' : 'Автообновление работает только в собранном exe' });
      set({ state: 'checking', message: '' });
      let r;
      try {
        r = await fetchFn(`https://api.github.com/repos/${config.repo}/releases/tags/${config.tag}`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CalendarWidget-updater' },
          signal: AbortSignal.timeout(15000)
        });
      } catch { return set({ state: 'error', code: 'OFFLINE', message: 'Нет связи с интернетом' }); }
      if (r.status === 404) return set({ state: 'error', code: 'NOT_FOUND', message: 'Релиз не найден или репозиторий приватный' });
      if (r.status === 403 || r.status === 429) return set({ state: 'error', code: 'LIMIT', message: 'GitHub временно ограничил запросы, попробуйте позже' });
      if (!r.ok) return set({ state: 'error', code: 'HTTP', message: 'Ошибка GitHub: HTTP ' + r.status });
      const rel = await r.json();
      const latest = parseVersion(rel.name) || parseVersion(rel.body);
      const asset = (rel.assets || []).find(a => a.name === config.asset && a.state === 'uploaded');
      if (!latest || !asset) return set({ state: 'error', code: 'BAD_RELEASE', message: 'В релизе нет версии или файла exe' });
      const cur = parseVersion(getVersion()) || [0, 0, 0];
      if (cmpVersion(latest, cur) <= 0) { found = null; return set({ state: 'uptodate', latest: latest.join('.'), message: '' }); }
      found = { version: latest.join('.'), asset };
      return set({ state: 'available', latest: found.version, message: '' });
    } finally { busy = false; }
  }

  async function install() {
    if (busy) return state;
    if (!found) return set({ state: 'error', code: 'NONE', message: 'Сначала проверьте обновления' });
    const target = getExePath();
    if (!target) return set({ state: 'unsupported', message: process.platform === 'darwin' ? 'На Mac обновляйте вручную: скачайте новый архив из Releases' : 'Автообновление работает только в собранном exe' });
    busy = true;
    const { asset, version } = found;
    const tmp = path.join(path.dirname(target), 'CalendarWidget.update.exe');
    try {
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

  return { check, install, getState: () => state, isFound: () => !!found };
}

module.exports = { createUpdater, parseVersion, cmpVersion, buildSwapScript };
