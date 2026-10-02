// 只读探针：显式指定【真实 userData】= %APPDATA%\Moonveldt，读 localStorage
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
app.setPath('userData', path.join(process.env.APPDATA, 'Moonveldt'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 900, height: 700, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(ROOT, 'index.html'));
    await sleep(350);
    const keys = await win.webContents.executeJavaScript(`(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k);
        out[k] = (v && v.length > 400) ? v.slice(0, 200) + ' ...[' + v.length + ']' : v;
      }
      return out;
    })()`);
    console.log('LS2 ' + JSON.stringify(keys, null, 1));
    win.destroy();
  } catch (e) { console.log('LS2_FAIL ' + String(e && e.stack || e)); }
  app.exit(0);
}).catch(e => { console.error('BOOT_ERR', e); app.exit(1); });
