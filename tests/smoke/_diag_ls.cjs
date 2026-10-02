// 只读探针：用【真实 userData】加载 index.html，读取 localStorage 实际值（不写）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 不 require main.js —— 保持最小干扰，仅读 file:// 源的 localStorage
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 900, height: 700, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    await win.loadFile(path.join(ROOT, 'index.html'));
    await sleep(400);
    const keys = await win.webContents.executeJavaScript(`(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k);
        out[k] = (v && v.length > 300) ? v.slice(0, 120) + '...[' + v.length + ']' : v;
      }
      return out;
    })()`);
    console.log('LS_KEYS ' + JSON.stringify(keys));
    win.destroy();
  } catch (e) { console.log('LS_FAIL ' + String(e && e.stack || e)); }
  app.exit(0);
}).catch(e => { console.error('BOOT_ERR', e); app.exit(1); });
