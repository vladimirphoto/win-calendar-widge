const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('widget', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getEvents: range => ipcRenderer.invoke('events:get', range),
  getAccent: () => ipcRenderer.invoke('sys:accent'),
  hide: () => ipcRenderer.send('window:hide'),
  onAccent: cb => on('sys:accent', cb),
  onRefresh: cb => on('app:refresh', cb),
  onLogin: cb => on('app:login', cb),
  onAuthChanged: cb => on('app:authChanged', cb),
  onSettings: cb => on('settings:changed', cb)
});
