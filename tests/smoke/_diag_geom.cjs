// 几何诊断：用用户的真实文档测量
//  ① 不同窗口宽度下标题"1.3"/"2.3"的比例位置（定位用户 env 与测试 env 的布局差异）
//  ② preview.rect.top 是否与 scrollTop 1:1 跟随（单位一致性硬检查）
//  ③ idxApp（现行算法）vs idxScreen（纯视口测量的独立真值）是否一致
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
  // 等布局稳定（mermaid 异步渲染）
  let last = -1, stableSince = Date.now();
  for (let i = 0; i < 80; i++) {
    const h = previewWrap.scrollHeight;
    if (h !== last) { last = h; stableSince = Date.now(); }
    if (Date.now() - stableSince > 1000) break;
    await sleep(220);
  }
  const heads = Array.from(preview.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  const pmax = previewWrap.scrollHeight - previewWrap.clientHeight;
  const pTop0 = preview.getBoundingClientRect().top;
  const offs = heads.map(h => h.getBoundingClientRect().top - pTop0);
  const rs = offs.map(o => +(o / pmax).toFixed(4));
  const probe = {};
  for (const i of [0, 3, 6, 8, 11, 14, 17, 20, 25, 30, 45, 60, 86]) {
    probe[i] = { t: heads[i] ? heads[i].textContent.trim().slice(0, 24) : null,
                 off: Math.round(offs[i] || 0), r: rs[i] };
  }
  // 单位一致性：preview.top 的位移是否等于 scrollTop 的变化
  const s0 = previewWrap.scrollTop;
  const step = async s => { previewWrap.scrollTop = s;
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r)); };
  await step(5000);
  const impl1 = pTop0 - preview.getBoundingClientRect().top;
  await step(9000);
  const impl2 = pTop0 - preview.getBoundingClientRect().top;
  previewWrap.scrollTop = s0;

  // idxApp（现行） vs idxScreen（纯视口独立真值）
  const marks = [];
  const fracs = [0.1715, 0.2575, +(offs[20] / pmax).toFixed(4), +(offs[11] / pmax).toFixed(4), 0.5];
  for (const frac of fracs) {
    await step(pmax * frac);
    const wTop = previewWrap.getBoundingClientRect().top;
    let idxScreen = 0;
    for (let i = 0; i < heads.length; i++) {
      if ((heads[i].getBoundingClientRect().top - wTop) <= 90) idxScreen = i; else break;
    }
    const idxApp = currentMarkerIndex();
    const top = previewWrap.scrollTop;
    const gap = +(top - (offs[idxScreen] || 0)).toFixed(0);   // top 与"屏幕顶部那个标题"的偏移差
    marks.push({ frac: +frac.toFixed(4), top: Math.round(top), idxApp, idxScreen, d: idxApp - idxScreen, gap });
  }
  return {
    innerW: window.innerWidth, innerH: window.innerHeight, dpr: devicePixelRatio,
    clientW: previewWrap.clientWidth, clientH: previewWrap.clientHeight,
    max: Math.round(pmax), heads: heads.length,
    previewFont: getComputedStyle(preview).fontSize,
    previewMaxW: getComputedStyle(preview).maxWidth,
    previewW: Math.round(preview.getBoundingClientRect().width),
    track1: Math.round(impl1), track2: Math.round(impl2),
    probe, marks
  };
})()`;

app.whenReady().then(async () => {
  const out = { steps: {} };
  try {
    const win = new BrowserWindow({
      width: 1280, height: 860, show: false,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    await win.loadFile(path.join(ROOT, 'index.html'));
    await sleep(1500);
    await run(win, `(async()=>{ applyMode('mode-read'); await new Promise(r=>setTimeout(r,400)); return true; })()`);
    await run(win, `openExternal(${JSON.stringify(DOC)}, {silent:true})`);
    await sleep(4500);
    out.steps.at1280 = await run(win, PROBE);
    for (const w of [1600, 1000, 900, 820, 760, 720]) {
      win.setContentSize(w, 840);
      await sleep(1500);
      out.steps['at' + w] = await run(win, PROBE);
    }
    console.log('GEOM ' + JSON.stringify(out));
  } catch (e) {
    out.fail = String(e && e.stack || e);
    console.log('GEOM ' + JSON.stringify(out));
  }
  app.exit(0);
}).catch(e => { console.error('BOOT_ERR', e); app.exit(1); });
