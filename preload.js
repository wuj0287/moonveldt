const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('wwj', {
  onOpenFile: (cb) => ipcRenderer.on('open-file', (e, p) => cb(p)),
  readText: (p) => ipcRenderer.invoke('read-text', p),
  writeText: (p, c) => ipcRenderer.invoke('write-text', p, c),
  readBase64: (p) => ipcRenderer.invoke('read-base64', p),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  saveDialog: (n) => ipcRenderer.invoke('save-dialog', n),
  exportPdf: (n) => ipcRenderer.invoke('export-pdf', n),
  onZoomStep: (cb) => ipcRenderer.on('zoom-step', (e, s) => cb(s)),
  pathForFile: (f) => {
    try { return webUtils.getPathForFile(f); }
    catch (e) { return f && f.path ? f.path : null; }
  }
});
