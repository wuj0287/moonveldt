// 决定性验证：UI zoom=200% 下复现用户现象
// 假设：getBoundingClientRect（视觉坐标）在 CSS zoom 下被放大 ×2，
//       而 scrollTop/scrollHeight（布局坐标）不变 → 所有"rect ↔ scrollTop"混用处全部错 2 倍
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

const MEASURE = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const heads = Array.from(preview.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  const pmax = previewWrap.scrollHeight - previewWrap.clientHeight;
  const pTop = preview.getBoundingClientRect().top;
  const off11 = Math.round(heads[11].getBoundingClientRect().top - pTop);
  const off20 = Math.round(heads[20].getBoundingClientRect().top - pTop);
  // 单位检查：rect 位移 vs scrollTop 位移
  previewWrap.scrollTop = 0;
  await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
  const r0 = preview.getBoundingClientRect().top;
  previewWrap.scrollTop = 1000;
  await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
  const r1 = preview.getBoundingClientRect().top;
  const wDisp = Math.round(r0 - r1);          // preview 内容 rect 位移（视觉）
  const rectDisp = Math.round(preview.getBoundingClientRect().top - pTop); // 无效了,随便
  // 用标题实测：scrollTo 一个位置，看 idxApp vs idxScreen
  previewWrap.scrollTop = Math.round(pmax * 0.2575);
  await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
  const wTop = previewWrap.getBoundingClientRect().top;
  let idxScreen = 0;
  for (let i = 0; i < heads.length; i++) {
    if ((heads[i].getBoundingClientRect().top - wTop) <= 90) idxScreen = i; else break;
  }
  const idxApp = currentMarkerIndex();
  // 完整场景：在 idxScreen==20 的位置（用户"正在读 2.3"）执行保存 → 读回锚点
  let anchorAt20 = null, restoreLanded = null;
  for (let t = 0; t < 60; t++) {
    previewWrap.scrollTop = previewWrap.scrollTop + 200;
    await new Promise(r => requestAnimationFrame(r));
    const wt = previewWrap.getBoundingClientRect().top;
    let s = 0;
    for (let i = 0; i < heads.length; i++) { if ((heads[i].getBoundingClientRect().top - wt) <= 90) s = i; else break; }
    if (s >= 20) { anchorAt20 = currentAnchor(); break; }
  }
  const posSaved = { scrollRatio: currentScrollRatio(), anchor: anchorAt20 };
  const scrollBeforeRestore = previewWrap.scrollTop;
  await applyStoredPosition(posSaved, true);
  await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
  const wt2 = previewWrap.getBoundingClientRect().top;
  let idxAfter = 0;
  for (let i = 0; i < heads.length; i++) { if ((heads[i].getBoundingClientRect().top - wt2) <= 90) idxAfter = i; else break; }
  const ratioAfter = +currentScrollRatio().toFixed(4);
  return {
    zoomStyle: document.getElementById('split').style.zoom,
    pmax: Math.round(pmax),
    off11, off20, r11: +(off11 / pmax).toFixed(4), r20: +(off20 / pmax).toFixed(4),
    unitCheck: { scrollTopSet: 1000, wrapperRectDisplacement: wDisp },
    at0275: { idxApp, idxScreen, top: Math.round(previewWrap.scrollTop) },
    scenario: {
      savedAnchorText: anchorAt20 ? anchorAt20.text.slice(0, 24) : null,
      savedRatio: +posSaved.scrollRatio.toFixed(4),
      scrollBeforeRestore: Math.round(scrollBeforeRestore),
      idxAfterRestore: idxAfter, ratioAfter
    }
  };
})()`;

app.whenReady().then(async () => {
  const out = {};
  try {
    const win = new BrowserWindow({ width: 1280, height: 860, show: false,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(ROOT, 'index.html'));
    await sleep(1500);
    await run(win, `(async()=>{ applyMode('mode-read'); await new Promise(r=>setTimeout(r,300)); return true; })()`);
    await run(win, `openExternal(${JSON.stringify(DOC)}, {silent:true})`);
    await sleep(4000);
    out.at100 = await run(win, MEASURE);
    await run(win, `(async()=>{ uiZoom = 200; applyZoom(); await new Promise(r=>setTimeout(r,500)); return true; })()`);
    await sleep(2500);
    out.at200 = await run(win, MEASURE);
    console.log('ZOOMREP ' + JSON.stringify(out));
  } catch (e) { console.log('ZOOMREP_FAIL ' + String(e && e.stack || e)); }
  app.exit(0);
}).catch(e => { console.error('BOOT_ERR', e); app.exit(1); });
