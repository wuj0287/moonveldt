// v1.9.8 冷启动恢复冒烟测试（真实主进程 + 真实窗口）
//
// 专门覆盖「关掉应用、重新打开」这条路径：主进程在 did-finish-load 时发
// restore-session {last}，渲染层据此打开上次的文档，并按文档 key 找回位置。
//
// 与上一版实现的区别：位置不再是一个全局值，而是 per-file；主进程只负责告诉我们
// 「上次看的是哪个文档」，具体读到哪由该文档自己的记录决定。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
// 真实主进程：拿到真 IPC（read-text / save-position / get-position / file-tag）
require(path.join(ROOT, 'main.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (w, code) => w.webContents.executeJavaScript(code);
const sessionPath = () => path.join(app.getPath('userData'), 'session.json');
const readSession = () => {
  try { return JSON.parse(fs.readFileSync(sessionPath(), 'utf8')); } catch (e) { return null; }
};

const DOC = path.join(os.tmpdir(), 'mv-coldstart.md');
const L = [];
for (let i = 1; i <= 40; i++) {
  L.push('## 章节 ' + i);
  L.push('');
  for (let j = 0; j < 5; j++) L.push('第 ' + i + ' 章正文 ' + (j + 1) + '：' + '填充内容用于撑高文档。'.repeat(4));
  L.push('');
}
const DOC_TEXT = L.join('\n');

function freshWindow() {
  return new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
}

// 阶段一：像用户一样打开文档、读到 62%、关闭
async function phaseSave() {
  const win = freshWindow();
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(1500);
  const r = await run(win, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    applyMode('mode-split');
    await sleep(300);
    await openExternal(${JSON.stringify(DOC)}, { silent: true });
    await sleep(500);
    const h = scrollHost();
    h.scrollTop = (h.scrollHeight - h.clientHeight) * 0.62;
    // 复刻真实路径：用户滚动后关闭窗口 → pagehide → 强制保存
    // （普通的 flushPosition() 在文档打开后的"布局稳定窗口"内会被推迟，
    //   这是有意的：异步渲染期间保存会存下过渡态的错误位置）
    await sleep(600);
    flushPosition(true);
    await sleep(800);
    return { ratio: +currentScrollRatio().toFixed(3), len: editor.value.length, path: currentPath };
  })()`);
  win.destroy();
  return r;
}

// 阶段二：模拟冷启动 —— 复刻 main.js 在 did-finish-load 时发的那条事件
async function phaseColdStart() {
  const s = readSession();
  if (!s || !s.last) throw new Error('session.json 未记录 last（主进程没存下上次文档）');
  const win = freshWindow();
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(300);
  win.webContents.send('restore-session', { last: s.last });   // ← 与 main.js 同一份 payload
  await sleep(2000);
  const r = await run(win, `({
    currentPath,
    len: editor.value.length,
    ratio: +currentScrollRatio().toFixed(3),
    scrollTop: Math.round(scrollHost().scrollTop),
    isSample: editor.value.indexOf('欢迎使用 Moonveldt') >= 0
  })`);
  win.destroy();
  return r;
}

app.whenReady().then(async () => {
  const out = { steps: {}, checks: {} };
  try {
    fs.writeFileSync(DOC, DOC_TEXT, 'utf8');
    try { fs.unlinkSync(sessionPath()); } catch (e) {}

    out.steps.save = await phaseSave();
    out.steps.cold = await phaseColdStart();

    const S = out.steps.save, C = out.steps.cold;
    const sess = readSession();
    out.checks = {
      wroteLastDoc: !!(sess && sess.last && sess.last.path === DOC),
      docReopened: C.currentPath === DOC && C.isSample === false,
      contentIntact: C.len === S.len && C.len > 1000,
      // 核心断言：位置真的回到 62% 附近
      positionRestored: Math.abs(C.ratio - S.ratio) < 0.08 && C.scrollTop > 100
    };
    out.pass = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.fail = String(e && e.stack || e);
  }
  console.log('COLDSTART_SMOKE ' + JSON.stringify(out, null, 2));
  app.exit(out.pass ? 0 : 3);
}).catch(e => { console.error('BOOT_ERROR', e); app.exit(1); });
