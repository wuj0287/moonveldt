// v1.8.1 冒烟：侧边栏单栏 tab 切换（默认大纲；切换文件→同目录蓝+最近5紫）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj181app-'));
const a = path.join(tmp, 'alpha.md');
const b = path.join(tmp, 'beta.md');
fs.writeFileSync(a, '# Alpha\n## Sec\n正文 alpha', 'utf8');
fs.writeFileSync(b, '# Beta\n正文 beta', 'utf8');
const aSlash = a.replace(/\\/g, '/');

require(path.join(__dirname, '..', '..', 'main.js'));

app.whenReady().then(() => {
  setTimeout(async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) { console.log('APP181_NO_WINDOW'); app.exit(2); return; }
      win.webContents.send('open-file', aSlash);
      await new Promise(r => setTimeout(r, 900));
      const res = await win.webContents.executeJavaScript(`(async()=>{
        const out={};
        const sb = document.getElementById('sidebar');
        out.sidebarWidth = sb.offsetWidth;
        out.defaultOutline = !sb.classList.contains('show-files')
          && document.getElementById('tab-outline').classList.contains('active')
          && getComputedStyle(document.getElementById('files-pane')).display === 'none';
        // 点击「切换文件」→ 显示文件区，大纲区隐藏
        document.getElementById('tab-files').click();
        await new Promise(r=>setTimeout(r,300));
        out.showFilesOn = sb.classList.contains('show-files')
          && getComputedStyle(document.getElementById('files-pane')).display !== 'none';
        const dirs=[...document.querySelectorAll('#side-dir-list .side-file')];
        out.dirCount = dirs.length;
        out.dirHasAlpha = dirs.some(x=>x.textContent.includes('alpha'));
        out.dirHasBeta = dirs.some(x=>x.textContent.includes('beta'));
        out.dirActOnAlpha = dirs.some(x=>x.classList.contains('active') && x.textContent.includes('alpha'));
        const blue = dirs.find(x=>x.textContent.includes('beta'));
        out.dirIsBlue = blue ? /(47, 111, 228|111, 155, 255)/.test(getComputedStyle(blue).color) : false;
        const recs=[...document.querySelectorAll('#side-recent-list .side-file')];
        out.recentHasAlpha = recs.some(x=>x.textContent.includes('alpha'));
        const ra = recs.find(x=>x.textContent.includes('alpha'));
        out.recentIsPurple = ra ? /(138, 79, 216|180, 138, 232)/.test(getComputedStyle(ra).color) : false;
        out.outlineGoneInFiles = getComputedStyle(document.getElementById('outline-list')).display === 'none';
        // 切回大纲
        document.getElementById('tab-outline').click();
        await new Promise(r=>setTimeout(r,100));
        out.backToOutline = !sb.classList.contains('show-files')
          && getComputedStyle(document.getElementById('files-pane')).display === 'none';
        out.pass = out.sidebarWidth >= 210 && out.sidebarWidth <= 250
          && out.defaultOutline && out.showFilesOn
          && out.dirHasAlpha && out.dirHasBeta && out.dirActOnAlpha && out.dirIsBlue
          && out.recentHasAlpha && out.recentIsPurple && out.outlineGoneInFiles
          && out.backToOutline;
        return out;
      })()`);
      console.log('APP181_RESULT ' + JSON.stringify(res, null, 2));
      app.exit(res && res.pass ? 0 : 3);
    } catch (e) { console.error('APP181_ERR', e); app.exit(1); }
  }, 1500);
});
