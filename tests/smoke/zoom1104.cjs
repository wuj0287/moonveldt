// v1.10.4 缩放矩阵回归（真实主进程 + 真实窗口）
// 背景：v1.10.3 及以前，蓝标/锚点在 UI 缩放 ≠100%（CSS zoom）下系统性错误——
//   rect 坐标（视觉，×Z）与 scrollTop（布局，×1）混用 → 蓝标指向"阅读深度的 1/Z"。
// 本测试在 zoom ∈ {100, 150, 200} 下验证：
//   ① 单位自检：preview 的 rect 位移 == scrollTop 增量 × Z
//   ② 显示蓝标 == 纯视口独立真值（逐点、0 容差）
//   ③ 保存的锚点 == 真值标题（不是半深度标题）
//   ④ 保存 → 切走 → 切回：恢复 == 保存的锚点
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
app.setPath('userData', path.join(os.tmpdir(), 'mv-zoom1104-userdata'));
require(path.join(ROOT, 'main.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (w, c) => w.webContents.executeJavaScript(c);

const SRC = 'C:\\Users\\62702\\Desktop\\快速阅读笔记.md';
const DOC = path.join(os.tmpdir(), 'mv-zoom1104.md');
fs.copyFileSync(SRC, DOC);
const OTHER = path.join(os.tmpdir(), 'mv-zoom1104-other.md');
fs.writeFileSync(OTHER, '# 别的文档\n\n' + '内容填充句子。'.repeat(300) + '\n\n## 小节\n' + 'abc '.repeat(400), 'utf8');

const SETTLE = `
  let lastH = -1, stableSince = Date.now();
  for (let i = 0; i < 80; i++) {
    const h = previewWrap.scrollHeight;
    if (h !== lastH) { lastH = h; stableSince = Date.now(); }
    if (Date.now() - stableSince > 900) break;
    await sleep(220);
  }`;

const PROBE = Z => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const raf2 = async () => { await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r)); };
  uiZoom = ${Z}; applyZoom();
  await sleep(800);
  ${SETTLE}
  const heads = Array.from(preview.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  const out = { Z: ${Z}, heads: heads.length, zoomStyle: document.getElementById('split').style.zoom };
  // ① 单位自检
  previewWrap.scrollTop = 0; await raf2();
  const p0 = preview.getBoundingClientRect().top;
  previewWrap.scrollTop = 1000; await raf2();
  const p1 = preview.getBoundingClientRect().top;
  out.unit = Math.round(p0 - p1);
  out.unitExpect = 1000 * ${Z} / 100;
  previewWrap.scrollTop = 0; await raf2();
  // ② 蓝标逐点
  const pmax = previewWrap.scrollHeight - previewWrap.clientHeight;
  out.rows = [];
  for (const frac of [0.12, 0.2575, 0.4, 0.55, 0.75]) {
    previewWrap.scrollTop = Math.round(pmax * frac);
    await raf2();
    out.rows.push({ frac, app: currentMarkerIndex(), truth: screenMarkerIndex() });
  }
  // ③ 滚到"2.x 区"（真值索引 >= 20）保存
  previewWrap.scrollTop = 0; await raf2();
  let target = -1;
  for (let t = 0; t < 400; t++) {
    previewWrap.scrollTop += 120;
    await new Promise(r => requestAnimationFrame(r));
    if (screenMarkerIndex() >= 20) { target = screenMarkerIndex(); break; }
  }
  out.target = target;
  out.targetText = target >= 0 ? heads[target].textContent.trim().slice(0, 30) : null;
  const a = currentAnchor();
  out.savedTitle = a ? a.text.slice(0, 30) : null;
  flushPosition(true);
  await sleep(500);
  return out;
})()`;

const ROUNDTRIP = Z => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  uiZoom = ${Z}; applyZoom();
  await openExternal(${JSON.stringify(OTHER)}, { silent: true });
  await sleep(900);
  await openExternal(${JSON.stringify(DOC)}, { silent: true });
  await sleep(2200);
  const a = currentAnchor();
  return { reopenedTitle: a ? a.text.slice(0, 30) : null, idx: currentMarkerIndex(), truth: screenMarkerIndex() };
})()`;

app.whenReady().then(async () => {
  const out = { checks: {}, steps: {} };
  try {
    const win = new BrowserWindow({
      width: 1280, height: 860, show: false,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    await win.loadFile(path.join(ROOT, 'index.html'));
    await sleep(1500);
    await run(win, `(async()=>{ applyMode('mode-read'); await new Promise(r=>setTimeout(r,300)); return true; })()`);
    await run(win, `openExternal(${JSON.stringify(DOC)}, {silent:true})`);
    await sleep(4000);
    for (const Z of [100, 150, 200]) {
      out.steps['z' + Z] = await run(win, PROBE(Z));
      out.steps['rt' + Z] = await run(win, ROUNDTRIP(Z));
      await sleep(400);
    }
    win.destroy();

    const c = out.checks;
    for (const Z of [100, 150, 200]) {
      const s = out.steps['z' + Z], rt = out.steps['rt' + Z];
      c['unit_z' + Z] = Math.abs(s.unit - s.unitExpect) <= 3;
      c['marker_z' + Z] = s.rows.every(r => r.app === r.truth);
      c['saved_z' + Z] = !!s.savedTitle && s.savedTitle === s.targetText;
      c['roundtrip_z' + Z] = !!rt.reopenedTitle && rt.reopenedTitle === s.savedTitle;
    }
    out.pass = Object.values(c).every(Boolean);
  } catch (e) { out.fail = String(e && e.stack || e); }
  console.log('ZOOM1104 ' + JSON.stringify(out));
  app.exit(out.pass ? 0 : 3);
}).catch(e => { console.error('BOOT_ERR', e); app.exit(1); });
