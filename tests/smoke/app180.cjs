// v1.8.0 端到端冒烟：启动真实 main.js（含全部 IPC），注入验证侧边栏
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj180app-'));
const a = path.join(tmp, 'alpha.md');
const b = path.join(tmp, 'beta.md');
fs.writeFileSync(a, '# Alpha\n## Sec\n正文 alpha', 'utf8');
fs.writeFileSync(b, '# Beta\n正文 beta', 'utf8');
const aSlash = a.replace(/\\/g, '/');

require(path.join(__dirname, '..', '..', 'main.js'));

app.whenReady().then(() => {
  setTimeout(async () => {
    try {
      const wins = BrowserWindow.getAllWindows();
      const win = wins[0];
      if (!win) { console.log('APP180_NO_WINDOW'); app.exit(2); return; }
      win.webContents.send('open-file', aSlash);
      await new Promise(r => setTimeout(r, 900));
      const res = await win.webContents.executeJavaScript(`(async()=>{
        const out={};
        out.hasCols = !!document.querySelector('#side-cols #outline-col')
          && !!document.querySelector('#side-cols #files-col');
        const dirs=[...document.querySelectorAll('#side-dir-list .side-file')];
        out.dirCount = dirs.length;
        out.dirHasBeta = dirs.some(x=>x.textContent.includes('beta'));
        out.dirActOnAlpha = dirs.some(x=>x.classList.contains('active'));
        const blue = dirs.find(x=>x.textContent.includes('beta'));
        out.dirIsBlue = blue ? /(47, 111, 228|111, 155, 255)/.test(getComputedStyle(blue).color) : false;
        const recs=[...document.querySelectorAll('#side-recent-list .side-file')];
        out.recentCount = recs.length;
        out.recentHasAlpha = recs.some(x=>x.textContent.includes('alpha'));
        const ra = recs.find(x=>x.textContent.includes('alpha'));
        out.recentIsPurple = ra ? /(138, 79, 216|180, 138, 232)/.test(getComputedStyle(ra).color) : false;
        out.outlineHasSec = (document.getElementById('outline-list').textContent||'').includes('Sec');
        out.pass = out.hasCols && out.dirHasBeta && out.dirActOnAlpha && out.dirIsBlue
          && out.recentHasAlpha && out.recentIsPurple && out.outlineHasSec;
        return out;
      })()`);
      console.log('APP180_RESULT ' + JSON.stringify(res, null, 2));
      app.exit(res && res.pass ? 0 : 3);
    } catch (e) { console.error('APP180_ERR', e); app.exit(1); }
  }, 1500);
});
