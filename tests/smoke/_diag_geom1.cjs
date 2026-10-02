// 最小几何探针（单窗口 1280×860）：拿基线数字，用于与用户环境对比
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
  const heads = Array.from(preview.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  const pmax = previewWrap.scrollHeight - previewWrap.clientHeight;
  const pTop0 = preview.getBoundingClientRect().top;
  const offs = heads.map(h => h.getBoundingClientRect().top - pTop0);
  const step = async s => { previewWrap.scrollTop = s;
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r)); };
  await step(5000);
  const impl1 = pTop0 - preview.getBoundingClientRect().top;
  previewWrap.scrollTop = 0;
  const pick = {};
  for (const i of [6, 11, 20, 25]) {
    pick[i] = { t: heads[i] ? heads[i].textContent.trim().slice(0, 22) : null,
                off: Math.round(offs[i] || 0), r: +(offs[i] / pmax).toFixed(4) };
  }
  const marks = [];
  for (const frac of [0.1715, 0.2575, +(offs[20] / pmax).toFixed(4)]) {
    await step(pmax * frac);
    const wTop = previewWrap.getBoundingClientRect().top;
    let idxScreen = 0;
    for (let i = 0; i < heads.length; i++) {
      if ((heads[i].getBoundingClientRect().top - wTop) <= 90) idxScreen = i; else break;
    }
    marks.push({ frac: +frac.toFixed(4), idxApp: currentMarkerIndex(), idxScreen });
  }
  return { innerW: window.innerWidth, innerH: window.innerHeight, dpr: devicePixelRatio,
           clientH: previewWrap.clientHeight, max: Math.round(pmax), heads: heads.length,
           font: getComputedStyle(preview).fontSize, previewW: Math.round(preview.getBoundingClientRect().width),
           track1: Math.round(impl1), pick, marks };
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
    console.log('GEOM1 ' + JSON.stringify(r));
    win.destroy();
  } catch (e) { console.log('GEOM1_FAIL ' + String(e && e.stack || e)); }
  app.exit(0);
}).catch(e => { console.error('BOOT_ERR', e); app.exit(1); });
