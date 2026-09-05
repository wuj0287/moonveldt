const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('wwj', {
  onOpenFile: (cb) => ipcRenderer.on('open-file', (e, p) => cb(p)),
  readText: (p) => ipcRenderer.invoke('read-text', p),
  listDirMd: (dir, excludePath) => ipcRenderer.invoke('list-dir-md', dir, excludePath),
  readImageData: (p) => ipcRenderer.invoke('read-image-data', p),
  writeText: (p, c) => ipcRenderer.invoke('write-text', p, c),
  readBase64: (p) => ipcRenderer.invoke('read-base64', p),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  saveDialog: (n) => ipcRenderer.invoke('save-dialog', n),
  exportPdf: (n) => ipcRenderer.invoke('export-pdf', n),
  onZoomStep: (cb) => ipcRenderer.on('zoom-step', (e, s) => cb(s)),
  pyInfo: (override) => ipcRenderer.invoke('py-info', override),
  pyRun: (code, override) => ipcRenderer.invoke('py-run', code, override),
  pyStop: () => ipcRenderer.invoke('py-stop'),
  pyInstall: (pkg, mirror, override) => ipcRenderer.invoke('py-install', pkg, mirror, override),
  pyUninstall: (pkg, override) => ipcRenderer.invoke('py-uninstall', pkg, override),
  pyList: (override) => ipcRenderer.invoke('py-list', override),
  onPyLog: (cb) => ipcRenderer.on('py-log', (e, chunk) => cb(chunk)),
  onPyEnvProgress: (cb) => ipcRenderer.on('py-env-progress', (e, info) => cb(info)),
  pathForFile: (f) => {
    try { return webUtils.getPathForFile(f); }
    catch (e) { return f && f.path ? f.path : null; }
  }
});
