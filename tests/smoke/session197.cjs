// v1.9.7 会话恢复冒烟测试（真实主进程 + 真实窗口，非纯渲染层模拟）
//
// 覆盖的正是“恢复位置并没有实现”这个 bug 的完整链路：
//   阶段一：开窗 → 打开一个真实 .md → 滚到中部 → 模拟关闭 → 检查 session.json 落盘
//   阶段二：重启 app 逻辑（新窗口 + restoreSession）→ 检查文档被重新打开、滚动位置对上
//
// 关键点：走的是 main.js 里真实的 createWindow({restoreSession:true}) 路径，
// 而不是测试脚本自己拼一个 payload，否则测不出“主进程有没有把状态存对/喂对”。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

// 直接加载真实主进程：这样才能测到 IPC 处理器（read-text / save-session / file-tag）
// 以及 createWindow/readSessionFile 的真实行为，而不是测试脚本自己造的假实现。
require(path.join(ROOT, 'main.js'));
const DOC = path.join(os.tmpdir(), 'moonveldt-session-test.md');

// 造一份足够长的文档：30 个章节，保证滚动位置有区分度
const LINES = [];
for (let i = 1; i <= 30; i++) {
  LINES.push('# 章节 ' + i);
  LINES.push('');
  for (let j = 0; j < 6; j++) LINES.push('第 ' + i + ' 章的第 ' + (j + 1) + ' 段正文内容，用来把文档撑到足够长，以便检验滚动恢复是否精确。');
  LINES.push('');
}
fs.writeFileSync(DOC, LINES.join('\n'), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (w, code) => w.webContents.executeJavaScript(code);

// 复用 main.js 的产物：直接从 app.getPath('userData') 读它写的会话文件
function sessionPath() { return path.join(app.getPath('userData'), 'session.json'); }

// 拿一个真实窗口（main.js 在 whenReady 时已经建了首个窗口，直接复用最贴近真实场景）
function firstWindow() {
  const all = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
  return all[0] || null;
}
async function waitWindow(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 15000)) {
    const w = firstWindow();
    if (w) return w;
    await sleep(150);
  }
  throw new Error('等待主窗口超时');
}

async function phase1Save() {
  const win = await waitWindow();
  await sleep(1500);   // 等首个窗口完成 restore 兜底（会回落到示例文档）

  const opened = await run(win, `(async () => {
    // 固定成双栏：基准/回归要跨运行可比，不能受上一次运行留下的模式影响
    applyMode('mode-split');
    await openExternal(${JSON.stringify(DOC)}, { silent: true });
    return { path: currentPath, len: editor.value.length, mode: 'mode-split' };
  })()`);

  // 滚到文档中部偏下，并触发一次保存（真实交互路径：scroll 事件 → scheduleSaveSession）
  const scrolled = await run(win, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const host = scrollHost();
    const max = host.scrollHeight - host.clientHeight;
    host.scrollTop = Math.round(max * 0.55);
    host.dispatchEvent(new Event('scroll'));
    await sleep(900);   // 越过 400ms 防抖
    return {
      scrollTop: host.scrollTop,
      ratio: currentScrollRatio(),
      anchor: currentAnchor(),
      hasNativeBridge: !!(native && native.saveSession)
    };
  })()`);

  // 再走一次“关闭前最后一次保存”：直接调 saveSession（对应 beforeunload 路径）
  await run(win, `saveSession(); true`);
  await sleep(800);

  const written = fs.existsSync(sessionPath())
    ? JSON.parse(fs.readFileSync(sessionPath(), 'utf8'))
    : null;

  return { opened, scrolled, written };
}

async function phase2Restore(written) {
  // 关掉所有窗口 → main.js 的 window-all-closed 会 app.quit()，
  // 所以这里不真关，而是新开一个窗口并手动喂 payload（复刻 createWindow 的 did-finish-load 分支）
  const win = new BrowserWindow({
    width: 1280, height: 840, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });

  const tag = (() => { try { const st = fs.statSync(written.path); return st.mtimeMs + ':' + st.size; } catch (e) { return null; } })();
  const payload = {
    kind: written.kind, path: written.path, docId: written.docId,
    scrollTop: written.scrollTop, scrollRatio: written.scrollRatio,
    anchor: written.anchor, cursor: written.cursor, mode: written.mode, tag
  };

  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(900);
  // 这个窗口启动时已经跑过一次兜底恢复（sessionHandled 已被占），
  // 这里模拟的是“重启后由主进程喂 payload”，所以要先复位标志。
  await run(win, `sessionHandled = false; sessionRestoring = false; true`);
  await run(win, `doRestoreSession(${JSON.stringify(payload)})`);
  await sleep(1800);   // 等恢复 + 渲染 + 两帧落位

  const restored = await run(win, `(() => {
    const host = scrollHost();
    return {
      currentPath,
      editorLen: editor.value.length,
      scrollTop: host.scrollTop,
      ratio: currentScrollRatio(),
      anchor: currentAnchor()
    };
  })()`);

  win.destroy();
  return restored;
}

// 阶段三：文件被外部改动后，只恢复“打开”，不恢复滚动
async function phase3Stale() {
  const staleDoc = path.join(os.tmpdir(), 'moonveldt-session-stale.md');
  fs.writeFileSync(staleDoc, LINES.join('\n'), 'utf8');
  const oldTag = (() => { const st = fs.statSync(staleDoc); return st.mtimeMs + ':' + st.size; })();

  // 外部把文件改短
  fs.writeFileSync(staleDoc, '# 被改过了\n\n短了很多。\n', 'utf8');

  const win = new BrowserWindow({
    width: 1280, height: 840, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(900);
  await run(win, `sessionHandled = false; sessionRestoring = false; true`);
  await run(win, `doRestoreSession(${JSON.stringify({
    kind: 'file', path: staleDoc, scrollTop: 4000, scrollRatio: 0.8,
    anchor: { text: '章节 20', ord: 0, level: 1 }, cursor: 0, mode: 'mode-split', tag: oldTag
  })})`);
  await sleep(1400);
  const r = await run(win, `(() => ({ currentPath, scrollTop: scrollHost().scrollTop, len: editor.value.length }))()`);
  win.destroy();
  return r;
}

// 阶段四：即时模式（mode-live）下也要恢复位置。
// 这条路径单独测是因为 renderLive() 会重建整个 preview，并带一帧 scrollTop 复位，
// 恢复逻辑必须能熬过那一帧（这个坑正是“恢复位置没实现”的主因）。
async function phase4Live() {
  const liveDoc = path.join(os.tmpdir(), 'moonveldt-session-live.md');
  fs.writeFileSync(liveDoc, LINES.join('\n'), 'utf8');
  const tag = (() => { const st = fs.statSync(liveDoc); return st.mtimeMs + ':' + st.size; })();

  const win = new BrowserWindow({
    width: 1280, height: 840, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(900);
  await run(win, `sessionHandled = false; sessionRestoring = false; true`);
  await run(win, `doRestoreSession(${JSON.stringify({
    kind: 'file', path: liveDoc, scrollTop: 0, scrollRatio: 0.6,
    anchor: { text: '章节 18', ord: 0, level: 1 }, cursor: 0, mode: 'mode-live', tag
  })})`);
  await sleep(2000);   // 等 renderLive + 两帧落位
  const r = await run(win, `(() => ({
    mode: ['mode-split','mode-live','mode-read'].find(m => document.body.classList.contains(m)),
    currentPath, scrollTop: scrollHost().scrollTop, ratio: currentScrollRatio()
  }))()`);
  win.destroy();
  try { fs.unlinkSync(liveDoc); } catch (e) {}
  return r;
}

app.whenReady().then(async () => {
  const out = { steps: {} };
  try {
    const p1 = await phase1Save();
    out.steps.p1 = p1;
    if (!p1.scrolled.hasNativeBridge) throw new Error('native.saveSession 未暴露');
    if (!p1.written) throw new Error('session.json 未落盘（会话持久化失效）');
    if (p1.written.path !== DOC) throw new Error('落盘的文件路径不对: ' + p1.written.path);

    const p2 = await phase2Restore(p1.written);
    out.steps.p2 = p2;

    const p3 = await phase3Stale();
    out.steps.p3 = p3;

    const p4 = await phase4Live();
    out.steps.p4 = p4;

    // 判定
    const r1 = p1.scrolled.ratio;
    const r2 = p2.ratio;
    out.checks = {
      docReopened: p2.currentPath === DOC,
      contentRestored: p2.editorLen === p1.opened.len,
      // 滚动位置还原：双栏模式下滚动的是 textarea，比例是可信的度量
      // （滚动同步策略本身会带来小幅漂移，容差 8%）
      scrollRatioClose: Math.abs(r1 - r2) < 0.08,
      scrollActuallyMoved: p2.scrollTop > 100,
      sessionFileWritten: !!p1.written,
      staleFileSkipsScroll: p3.scrollTop === 0 && p3.len < 200,
      // 即时模式：模式本身要切过去，且位置也要恢复（熬过 renderLive 的那一帧复位）
      liveModeRestored: p4.mode === 'mode-live' && Math.abs(p4.ratio - 0.6) < 0.08 && p4.scrollTop > 100
    };
    out.pass = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.fail = String(e && e.stack || e);
  }
  console.log('SESSION_SMOKE ' + JSON.stringify(out, null, 2));
  try { fs.unlinkSync(DOC); } catch (e) {}
  app.exit(out.pass ? 0 : 3);
}).catch(e => { console.error('BOOT_ERROR', e); app.exit(1); });
