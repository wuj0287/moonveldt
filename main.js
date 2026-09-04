const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

let win = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const EXTS = ['.md', '.markdown', '.mdown', '.mkd', '.txt'];

function fileFromArgv(argv) {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (!a || a.startsWith('-')) continue;
    try {
      if (EXTS.includes(path.extname(a).toLowerCase()) && fs.existsSync(a)) {
        return path.resolve(a);
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

function createWindow(fileToOpen) {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 500,
    title: 'wwj',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  // 防止拖拽文件导致页面跳转
  win.webContents.on('will-navigate', e => e.preventDefault());

  // Ctrl+滚轮兜底：Electron 原生 zoom-changed 事件，抵消原生缩放并转发给渲染层
  win.webContents.on('zoom-changed', (e, dir) => {
    win.webContents.setZoomLevel(0);
    win.webContents.send('zoom-step', dir === 'in' ? 10 : -10);
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (fileToOpen) win.webContents.send('open-file', fileToOpen);
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', (e, argv) => {
  const f = fileFromArgv(argv);
  if (win) {
    if (f) win.webContents.send('open-file', f);
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  app.setAppUserModelId('com.wwj.editor');
  Menu.setApplicationMenu(null);
  createWindow(fileFromArgv(process.argv));
});

app.on('window-all-closed', () => app.quit());

/* ---------- IPC ---------- */
ipcMain.handle('read-text', (e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('write-text', (e, p, c) => { fs.writeFileSync(p, c, 'utf8'); return true; });
ipcMain.handle('read-base64', (e, p) => {
  const b = fs.readFileSync(p);
  if (b.length > 15 * 1024 * 1024) return { ok: false, reason: 'too-large', size: b.length };
  return { ok: true, data: b.toString('base64'), size: b.length };
});

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '打开 Markdown 文件',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }],
    properties: ['openFile']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('save-dialog', async (e, name) => {
  const r = await dialog.showSaveDialog(win, {
    title: '保存 Markdown 文件',
    defaultPath: (name || '未命名') + '.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('export-pdf', async (e, name) => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出 PDF',
    defaultPath: (name || '未命名') + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled) return null;
  const buf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
  });
  fs.writeFileSync(r.filePath, buf);
  return r.filePath;
});
