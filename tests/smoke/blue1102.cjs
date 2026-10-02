// v1.10.2 蓝标回归测试（真实主进程 + 真实窗口）
//
// 针对用户实测「蓝标位置不对」。关键教训：偏移缓存方案本身是错误来源——
// 它依赖"缓存永远及时失效"，而 Mermaid / KaTeX / 字体加载等异步渲染、
// 编辑重排、缩放、侧栏拖动都会让缓存在某一刻失真。
// 现改为**实时二分查找**（约 log2(N) 次布局读取，40 个标题≈6 次），永不 Speicher过期。
//
// 断言：
//   ① 即时/阅读模式：蓝标 == 实况测量（0 容差）
//   ② 双栏模式：蓝标 == 实况测量，且编辑器↔预览同步到位
//   ③ 显示蓝标 == 保存的锚点（同一标题）
//   ④ 存下来的位置能原样恢复（跳回同一标题）
// 文档刻意包含 Mermaid / KaTeX / 代码块 / 表格 —— 异步渲染最易让缓存失准。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'main.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (w, c) => w.webContents.executeJavaScript(c);

const F = path.join(os.tmpdir(), 'mv-blue1102.md');
function makeDoc(sections) {
  const L = [];
  for (let i = 1; i <= sections; i++) {
    L.push('## 第 ' + i + ' 节 标题');
    L.push('');
    for (let j = 0; j < 4; j++) L.push('正文 ' + i + '-' + j + '：' + '内容填充用于撑高文档。'.repeat(8));
    L.push('');
    if (i === 2 || i === 9 || i === 17) {          // 前/中/后都放异步图
      L.push('```mermaid');
      L.push('graph LR');
      L.push('  A[Query] --> B[Key 点积]');
      L.push('  B --> C[softmax]');
      L.push('  C --> D[Value 加权]');
      L.push('```');
      L.push('');
    }
    if (i === 5) { L.push('$$ E = mc^2 + \\sum_{i=1}^{n} x_i $$'); L.push(''); }
    if (i % 4 === 0) { L.push('```js'); L.push('const x' + i + ' = ' + i + ';'); L.push('console.log(x' + i + ');'); L.push('```'); L.push(''); }
    if (i % 6 === 0) { L.push('| 列A | 列B |'); L.push('| --- | --- |'); L.push('| a' + i + ' | b' + i + ' |'); L.push(''); }
  }
  return L.join('\n');
}
fs.writeFileSync(F, makeDoc(40), 'utf8');

// 页面内探针：以**预览实际滚动位置**为唯一真值（用户看到的就是预览）
const PROBE = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function truthAtPreview() {
    const heads = Array.from(preview.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    const pTop = preview.getBoundingClientRect().top;
    const st = previewWrap.scrollTop + 90;
    let idx = 0;
    for (let i = 0; i < heads.length; i++) {
      if ((heads[i].getBoundingClientRect().top - pTop) <= st) idx = i; else break;
    }
    return idx;
  }
  const host = scrollHost();
  const hmax = Math.max(1, host.scrollHeight - host.clientHeight);
  const rows = [];
  for (let k = 1; k <= 8; k++) {
    host.scrollTop = hmax * (k / 9);
    await sleep(1200);
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    const app = currentMarkerIndex();
    const truth = truthAtPreview();
    const anchor = currentAnchor();
    const anchorIdx = anchor ? outlineHeads.findIndex(h => h.textContent.trim().slice(0,120) === anchor.text) : -1;
    const er = editor.scrollHeight > editor.clientHeight
      ? editor.scrollTop / (editor.scrollHeight - editor.clientHeight) : 0;
    const pr = previewWrap.scrollHeight > previewWrap.clientHeight
      ? previewWrap.scrollTop / (previewWrap.scrollHeight - previewWrap.clientHeight) : 0;
    rows.push({ k, app, truth, d: app - truth, anchorIdx, syncGap: +(Math.abs(er - pr)).toFixed(3) });
  }
  return { rows, heads: outlineHeads.length };
})()`;

// 存档 → 重开 → 是否跳回同一标题
const ROUNDTRIP = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const host = scrollHost();
  const hmax = Math.max(1, host.scrollHeight - host.clientHeight);
  host.scrollTop = hmax * 0.62;
  await sleep(1200);
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
  flushPosition();
  await sleep(500);
  const savedAnchor = currentAnchor();
  return { savedAnchor, savedIdx: currentMarkerIndex() };
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

    // 即时模式（用户截图里的模式）
    await run(win, `applyMode('mode-live'); true`);
    await sleep(800);
    await run(win, `openExternal(${JSON.stringify(F)}, { silent: true })`);
    await sleep(3500);                        // 等 mermaid / katex 渲染完
    out.steps.live = await run(win, PROBE);

    // 双栏模式
    await run(win, `applyMode('mode-split'); true`);
    await sleep(1200);
    out.steps.split = await run(win, PROBE);

    // 存档必须在所有滚动采样之后：任何一个滚动采样都会顺带把位置刷成新值
    // （应用行为正确——恢复的总是"最近一次的位置"），先后顺序错了会测出假失败。
    out.steps.liveRT = await run(win, ROUNDTRIP);

    // 重开同一文件：必须先切到别的文档，否则 openExternal 会先把当前位置 flush
    // 再读回来（等于恢复刚存的值），测不出"重开是否跳回更早存的锚点"。
    const G = path.join(os.tmpdir(), 'mv-blue1102-other.md');
    fs.writeFileSync(G, makeDoc(20), 'utf8');
    await run(win, `openExternal(${JSON.stringify(G)}, { silent: true })`);
    await sleep(1200);
    await run(win, `openExternal(${JSON.stringify(F)}, { silent: true })`);
    out.steps.reopen = await run(win, `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      await sleep(1800);
      const a = currentAnchor();
      return { reopenedAnchor: a, reopenedIdx: currentMarkerIndex() };
    })()`);
    win.destroy();

    const L = out.steps.live, S = out.steps.split, RT = out.steps.liveRT, RO = out.steps.reopen;
    const allZero = sec => sec.rows.every(r => r.d === 0);
    const anchorConsistent = sec => sec.rows.every(r => r.anchorIdx === r.app);
    const sameAnchor = (a, b) => !!(a && b && a.text === b.text && (a.ord||0) === (b.ord||0));

    out.checks = {
      live_markerExact: allZero(L),
      live_anchorEqMarker: anchorConsistent(L),
      // 即时模式下编辑器是 display:none，编辑器↔预览同步无意义，只测双栏
      split_markerExact: allZero(S),
      split_anchorEqMarker: anchorConsistent(S),
      split_syncOk: S.rows.every(r => r.syncGap < 0.05),
      roundtrip_savedThenReopened: sameAnchor(RT.savedAnchor, RO.reopenedAnchor),
      roundtrip_sameIdx: Math.abs(RT.savedIdx - RO.reopenedIdx) <= 1
    };
    out.detail = {
      liveDiffs: L.rows.map(r => r.d),
      splitDiffs: S.rows.map(r => r.d),
      heads: L.heads,
      saved: RT.savedAnchor && RT.savedAnchor.text,
      reopened: RO.reopenedAnchor && RO.reopenedAnchor.text
    };
    out.pass = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.fail = String(e && e.stack || e);
  }
  console.log('BLUE1102 ' + JSON.stringify(out, null, 1));
  app.exit(out.pass ? 0 : 3);
}).catch(e => { console.error('BOOT_ERROR', e); app.exit(1); });
