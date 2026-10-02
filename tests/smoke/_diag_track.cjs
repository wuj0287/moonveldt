// 微探针：验证 preview.rect.top 是否 1:1 跟随 scrollTop（排查坐标系统失配）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
app.setPath('userData', path.join(os.tmpdir(), 'mv-diag-userdata'));
require(path.join(ROOT, 'main.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (w, c) => w.webContents.executeJavaScript(c);

const SRC = 'C:\\Users\\62702\\Desktop\\快速阅读笔记.md';
const DOC = path.join(os.tmpdir(), 'mv-geom-doc.md');
fs.copyFileSync(SRC, DOC);

const PROBE = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let last = -1, stableSince = Date.now();
  for (let i = 0; i < 80; i++) {
    const h = previewWrap.scrollHeight;
    if (h !== last) { last = h; stableSince = Date.now(); }
    if (Date.now() - stableSince > 900) break;
    await sleep(220);
  }
  const rows = [];
  const snap = tag => rows.push({ tag,
    st: Math.round(previewWrap.scrollTop),
    pTop: Math.round(preview.getBoundingClientRect().top),
    wTop: Math.round(previewWrap.getBoundingClientRect().top),
    sh: previewWrap.scrollHeight, ch: previewWrap.clientHeight });
  previewWrap.scrollTop = 0;
  await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
  snap('at0');
  previewWrap.scrollTop = 1000; snap('set1000-imm');
  await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
  snap('set1000-2raf');
  previewWrap.scrollTop = 5000; snap('set5000-imm');
  await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
  snap('set5000-2raf');
  await sleep(1200); snap('set5000-1.2s');
  // 再取另一个位置
  previewWrap.scrollTop = 9000; snap('set9000-imm');
  await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
  snap('set9000-2raf');
  previewWrap.scrollTop = 0;
  await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
  snap('at0-again');
  return rows;
})()`;

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1280, height: 860, show: false,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(ROOT, 'index.html'));
    await sleep(1500);
    await run(win, `(async()=>{ applyMode('mode-read'); await new Promise(r=>setTimeout(r,300)); return true; })()`);
    await run(win, `openExternal(${JSON.stringify(DOC)}, {silent:true})`);
    await sleep(4000);
    const r = await run(win, PROBE);
    console.log('TRACK ' + JSON.stringify(r));
    win.destroy();
  } catch (e) { console.log('TRACK_FAIL ' + String(e && e.stack || e)); }
  app.exit(0);
}).catch(e => { console.error('BOOT_ERR', e); app.exit(1); });
