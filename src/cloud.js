// Облако: личные данные (ставки, суммы по дням, аванс, цель, имя для смен и т.д.) хранятся в скрытой папке приложения
// в Google Drive самого сотрудника (scope drive.appdata). У каждого сотрудника свой аккаунт = свои данные;
// на другом компьютере после входа тем же аккаунтом всё подтягивается. Ни сервера, ни оплаты не нужно.
// Модуль не зависит от Electron: сеть и токен передаются снаружи, поэтому его можно проверять заглушками.

const FILE_NAME = 'calendar-widget-data.json';

// какие настройки личные (едут в облако); остальное (положение окна, тема, прозрачность, автозапуск) остаётся на компьютере
const PERSONAL = [
  'keywords', 'onlyMine', 'notify', 'notifyHours', 'notifyEve',
  'rates', 'dayPay', 'advanceOn', 'advance', 'payPeriod',
  'goalOn', 'goal', 'statsOn', 'freeOn', 'freeMin', 'surprise', 'surpriseTime'
];

function pick(settings) {
  const o = {};
  for (const k of PERSONAL) if (settings[k] !== undefined) o[k] = settings[k];
  return o;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// есть ли у человека что терять (чтобы не заливать пустоту поверх чужого)
function hasData(settings, defaults) {
  return !same(pick(settings), pick(defaults));
}

/**
 * Что делать при синхронизации.
 * local: { at, acct, dirty, hasData }, remote: { at, data } | null, email: аккаунт, под которым вошли
 * Возвращает 'pull' | 'push' | 'replace' | 'none'
 *  replace = локальные данные чужие (другой аккаунт): стереть их и взять облако этого аккаунта (или пустоту), ничего не заливать
 */
function decide({ local, remote, email }) {
  if (local.acct && local.acct !== email) return 'replace';
  if (!remote) return local.hasData || local.dirty ? 'push' : 'none';
  if (local.dirty && local.at >= remote.at) return 'push';
  if (remote.at > (local.at || 0)) return 'pull';
  if ((local.at || 0) > remote.at) return 'push';
  return 'none';
}

function createCloud({ getToken, fetchFn }) {
  async function call(url, opts = {}) {
    const token = await getToken();
    let r;
    try {
      r = await fetchFn(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
    } catch { const e = new Error('Нет связи с интернетом'); e.code = 'OFFLINE'; throw e; }
    if (!r.ok) {
      let body = null; try { body = await r.json(); } catch {}
      const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
      const msg = String(body?.error?.message || '');
      const e = new Error('Drive: HTTP ' + r.status);
      e.status = r.status;
      if (r.status === 403 && (/accessNotConfigured|SERVICE_DISABLED/i.test(reason + msg) || /has not been used|is disabled/i.test(msg))) e.code = 'API_OFF';
      else if (r.status === 403 || r.status === 401) e.code = 'SCOPE';
      throw e;
    }
    return r;
  }

  async function whoami() {
    const r = await call('https://www.googleapis.com/calendar/v3/calendars/primary?fields=id');
    const j = await r.json();
    return String(j.id || '').toLowerCase();
  }
  async function find() {
    const q = new URLSearchParams({
      spaces: 'appDataFolder', q: `name='${FILE_NAME}' and trashed=false`, fields: 'files(id)', pageSize: '1'
    });
    const j = await (await call('https://www.googleapis.com/drive/v3/files?' + q)).json();
    return (j.files && j.files[0] && j.files[0].id) || null;
  }
  async function download(id) {
    const j = await (await call(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json();
    if (!j || typeof j !== 'object' || typeof j.at !== 'number' || !j.data || typeof j.data !== 'object') return null;
    return { at: j.at, data: j.data };
  }
  async function upload(id, doc) {
    const body = JSON.stringify({ v: 1, at: doc.at, data: doc.data });
    if (id) {
      await call(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body
      });
      return id;
    }
    const boundary = 'cw' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const r = await call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart
    });
    return (await r.json()).id;
  }
  return { whoami, find, download, upload };
}

module.exports = { FILE_NAME, PERSONAL, pick, same, hasData, decide, createCloud };
