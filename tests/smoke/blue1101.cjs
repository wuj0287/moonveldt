// v1.10.1 蓝标一致性测试（真实主进程 + 真实窗口）
//
// 针对用户反馈「蓝标位置不对」。根因不是算法，而是参照系混用：
//   v1.10.0 把**保存路径**改成「双栏下从 editor 比例推导锚点」，
//   而**显示路径**（蓝标高亮）仍用 preview 的滚动位置 —— 双栏下这两者
//   在比例映射非线性的情况下会指向不同标题，于是"看到的蓝标"和
//   "被记住/跳转到的位置"对不上。
//
// 本测试断言的核心不变量：
//   ① 显示蓝标 === 保存的锚点（同一标题，双栏与即时模式都成立）
//   ② 双栏下蓝标与 editor 参照系的实况测量一致
//   ③ 连续滚动结束后，侧栏高亮项仍在可视区内（不"消失"）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'main.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (w, c) => w.webContents.executeJavaScript(c);

const F = path.join(os.tmpdir(), 'mv-blue-consistency.md');
function makeDoc(sections) {
  const L = [];
  for (let i = 1; i <= sections; i++) {
    L.push('## 第 ' + i + ' 节 标题');
    L.push('');
    for (let j = 0; j < 4; j++) L.push('正文 ' + i + '-' + j + '：' + '内容填充用于撑高文档。'.repeat(8));
    L.push('');
    // 混入代码块与表格：它们在源码/预览里的高度比差异极大，
    // 正是"比例映射非线性"最容易暴露参照系混用的地方
    if (i % 3 === 0) { L.push('```js'); L.push('const x' + i + ' = ' + i + ';'); L.push('console.log(x' + i + ');'); L.push('```'); L.push(''); }
    if (i % 4 === 0) { L.push('| 列A | 列B |'); L.push('| --- | --- |'); L.push('| a' + i + ' | b' + i + ' |'); L.push(''); }
  }
  return L.join('\n');
}
fs.writeFileSync(F, makeDoc(40), 'utf8');

// 页面内探针：采样多个滚动位置，比对「显示蓝标 / 保存锚点 / 实况蓝标」
const PROBE = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rows = [];
  const host = scrollHost();

  // 实况蓝标（ground truth）：按模式选参照系，且直接量标题视觉位置——
  // 完全不依赖被验证的偏移缓存。
  //  · 双栏：文稿是 textarea，用户在左侧源码上滚动 → 以 editor 比例为参照
  //  · 即时/阅读：只有预览在滚（编辑器 display:none）→ 以 preview 滚动位置为参照
  function liveGroundTruth() {
    const heads = Array.from(preview.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    const pTop = preview.getBoundingClientRect().top;
    let st;
    if (scrollHost() === editor) {
      const max = Math.max(1, editor.scrollHeight - editor.clientHeight);
      const ratio = Math.max(0, Math.min(1, editor.scrollTop / max));
      const pmax = Math.max(1, previewWrap.scrollHeight - previewWrap.clientHeight);
      st = ratio * pmax + 90;
    } else {
      st = previewWrap.scrollTop + 90;
    }
    let idx = 0;
    for (let i = 0; i < heads.length; i++) {
      if ((heads[i].getBoundingClientRect().top - pTop) <= st) idx = i; else break;
    }
    return idx;
  }

  const hmax = host.scrollHeight - host.clientHeight;
  // 注意：隐藏窗口下 Chromium 把 rAF 节流到 ~1fps，而"滚动 → 同步 → 高亮更新"
  // 是一条 3 级 rAF 链，需要约 3 秒才能跑完。所以这里轮询等待收敛，
  // 而不是固定 sleep（固定 sleep 会测出"高亮滞后一步"的假象）。
  async function waitShown(targetIdx, capMs) {
    const t0 = Date.now();
    let shown = -1;
    while (Date.now() - t0 < capMs) {
      await sleep(250);
      const items = Array.from(document.querySelectorAll('#outline-list .out-item'));
      shown = items.findIndex(el => el.classList.contains('active'));
      if (shown === targetIdx) break;
    }
    return shown;
  }

  for (let k = 1; k <= 8; k++) {
    host.scrollTop = hmax * (k / 9);
    await sleep(200);
    // 先算出这次应该高亮哪个（marker 是同步的，不依赖 rAF）
    const expected = currentMarkerIndex();
    const shownIdx = await waitShown(expected, 6000);

    // 保存锚点：走真实保存路径取到的锚点，换算回索引
    const anchor = currentAnchor();
    const anchorIdx = anchor ? outlineHeads.findIndex(h => h.textContent.trim().slice(0,120) === anchor.text) : -1;

    rows.push({
      k,
      shownIdx,
      anchorIdx,
      liveIdx: liveGroundTruth(),
      marker: currentMarkerIndex(),
      eTop: Math.round(editor.scrollTop)
    });
  }

  // 侧栏跟随：连续快滚 30 次后，高亮项是否还在可视区
  for (let i = 0; i < 30; i++) {
    host.scrollTop = hmax * (i / 30);
    updateOutlineActive();
    await new Promise(r => requestAnimationFrame(r));
  }
  await sleep(1500);   // 等节流尾随执行（隐藏窗口下 rAF 慢，给足时间）
  const outEl = document.getElementById('outline-list');
  const items2 = Array.from(outEl.querySelectorAll('.out-item'));
  const act = items2[lastActiveIdx];
  let visible = false;
  if (act) {
    const ob = outEl.getBoundingClientRect(), ab = act.getBoundingClientRect();
    visible = ab.top >= ob.top - 1 && ab.bottom <= ob.bottom + 1;
  }
  return { rows, followVisible: visible, followIdx: lastActiveIdx, total: items2.length };
})()`;

app.whenReady().then(async () => {
  const out = { steps: {}, checks: {} };
  try {
    const win = new BrowserWindow({
      width: 1280, height: 860, show: false,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    await win.loadFile(path.join(ROOT, 'index.html'));
    await sleep(1500);

    await run(win, `applyMode('mode-split'); true`);
    await sleep(300);
    await run(win, `openExternal(${JSON.stringify(F)}, { silent: true })`);
    await sleep(900);
    out.steps.split = await run(win, PROBE);

    await run(win, `applyMode('mode-live'); true`);
    await sleep(1000);
    out.steps.live = await run(win, PROBE);
    win.destroy();

    const S = out.steps.split, L = out.steps.live;
    // ① 显示蓝标 == 保存锚点（核心不变量，这是"蓝标位置不对"的直接判据）
    const consistent = sec => sec.rows.every(r => r.shownIdx === r.anchorIdx && r.shownIdx >= 0);
    // ② 双栏下与 editor 参照实况一致
    const matchesLive = sec => sec.rows.every(r => Math.abs(r.marker - r.liveIdx) <= 1);

    out.checks = {
      split_displayEqAnchor: consistent(S),
      split_matchesEditorLive: matchesLive(S),
      live_displayEqAnchor: consistent(L),
      live_matchesEditorLive: matchesLive(L),
      // ③ 侧栏跟随：连续滚动后高亮项仍在可视区（不能"蓝标消失"）
      split_followsVisible: S.followVisible === true,
      live_followsVisible: L.followVisible === true
    };
    out.detail = {
      split: S.rows.map(r => [r.k, r.shownIdx, r.anchorIdx, r.liveIdx, r.marker]),
      live: L.rows.map(r => [r.k, r.shownIdx, r.anchorIdx, r.liveIdx, r.marker]),
      splitFollow: [S.followIdx, S.total, S.followVisible],
      liveFollow: [L.followIdx, L.total, L.followVisible]
    };
    out.pass = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.fail = String(e && e.stack || e);
  }
  console.log('BLUE_SMOKE ' + JSON.stringify({
    pass: out.pass,
    fail: out.fail,
    checks: out.checks,
    split: out.detail && out.detail.split,
    live: out.detail && out.detail.live,
    splitFollow: out.detail && out.detail.splitFollow,
    liveFollow: out.detail && out.detail.liveFollow
  }));
  app.exit(out.pass ? 0 : 3);
}).catch(e => { console.error('BOOT_ERROR', e); app.exit(1); });
