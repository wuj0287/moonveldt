// v1.9.8 阅读位置记忆冒烟测试（真实主进程 + 真实窗口）
//
// 针对两个已确认的线上 bug：
//   Bug1 「打开任何文档都会进入示例文档」
//        —— 启动兜底定时器只认 restore-session 有没有跑过，不认 open-file，
//           于是「双击打开一个 .md」时它照样触发，把文件换成了示例文档。
//   Bug2 「恢复上次关闭位置依旧没实现」
//        —— 启动脚本里 applyMode() 顺手写了一次位置，在默认（空）状态下把
//           session.json 里的真实位置覆盖掉，主进程随后读到的是垃圾。
//
// 外加新需求验证：每个 .md 文件各自独立记忆阅读位置。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
// 加载真实主进程：拿到真 IPC（read-text / save-position / get-position / file-tag）
require(path.join(ROOT, 'main.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (w, code) => w.webContents.executeJavaScript(code);
const sessionPath = () => path.join(app.getPath('userData'), 'session.json');
const readSession = () => {
  try { return JSON.parse(fs.readFileSync(sessionPath(), 'utf8')); } catch (e) { return null; }
};

// 三份内容长度不同的文档，保证滚动比例的区分度
function makeDoc(tag, sections) {
  const L = [];
  for (let i = 1; i <= sections; i++) {
    L.push('## ' + tag + ' 第 ' + i + ' 节');
    L.push('');
    for (let j = 0; j < 5; j++) L.push(tag + ' 正文 ' + i + '-' + j + '：' + '内容填充用于撑高文档。'.repeat(4));
    L.push('');
  }
  return L.join('\n');
}
const FILE_A = path.join(os.tmpdir(), 'mv-pos-A.md');
const FILE_B = path.join(os.tmpdir(), 'mv-pos-B.md');
const FILE_C = path.join(os.tmpdir(), 'mv-pos-C.md');

function freshWindow() {
  return new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
}

// —— 阶段 A：复现 Bug1 ——
// 在兜底定时器触发之前发 open-file，越过后检查文件有没有被示例文档顶掉
async function phaseA_openFileNotClobbered() {
  const win = freshWindow();
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(250);                                  // 脚本已注册好事件，兜底(900ms)还没触发
  win.webContents.send('open-file', FILE_A);         // 复刻 createWindow({file}) 的 did-finish-load 分支
  await sleep(1700);                                 // 越过 900ms 兜底
  const r = await run(win, `({
    currentPath,
    isSample: editor.value.indexOf('欢迎使用 Moonveldt') >= 0,
    len: editor.value.length
  })`);
  win.destroy();
  return r;
}

// —— 阶段 B：每个文件独立记忆 ——
// 诊断要点：把 mode/max/ratio 一起报出来，否则「位置没恢复」既可能是逻辑错，
// 也可能是隐藏窗口布局还没稳定（max=0）导致设置 scrollTop 无效。
async function phaseB_perFileMemory(mode) {
  const win = freshWindow();
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(1500);                                 // 让兜底跑完，startupLock 放开

  const script = `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const out = { mode: ${JSON.stringify(mode)} };
    applyMode(${JSON.stringify(mode)});      // 固定模式，保证跨运行可比
    await sleep(300);
    out.modeActive = currentMode();

    const setRatio = async (target) => {
      const h = scrollHost();
      const max = h.scrollHeight - h.clientHeight;
      h.scrollTop = max * target;
      flushPosition();
      await sleep(600);
      const h2 = scrollHost();
      return {
        max,
        want: target,
        top: Math.round(h2.scrollTop),
        got: +currentScrollRatio().toFixed(3)
      };
    };
    const readRatio = async () => {
      await sleep(800);
      return { top: Math.round(scrollHost().scrollTop), got: +currentScrollRatio().toFixed(3) };
    };

    // 打开 A 并滚到 60%
    await openExternal(${JSON.stringify(FILE_A)}, { silent: true });
    await sleep(500);
    out.aA = await setRatio(0.60);

    // 打开 B 并滚到 25%（A 的位置必须被独立保留）
    await openExternal(${JSON.stringify(FILE_B)}, { silent: true });
    await sleep(500);
    out.aB = await setRatio(0.25);

    // 回到 A —— 应当自动回到 60%，而不是 0 也不是 B 的 25%
    await openExternal(${JSON.stringify(FILE_A)}, { silent: true });
    out.aRestored = await readRatio();
    out.aPathOk = currentPath === ${JSON.stringify(FILE_A)};

    // 再切到 B —— 应当回到 25%
    await openExternal(${JSON.stringify(FILE_B)}, { silent: true });
    out.bRestored = await readRatio();
    out.bPathOk = currentPath === ${JSON.stringify(FILE_B)};

    return out;
  })()`;
  const r = await run(win, script);
  win.destroy();
  return r;
}

// —— 阶段 C：session.json 结构（每文件一条） ——
function phaseC_storeShape() {
  const s = readSession();
  return {
    hasLast: !!(s && s.last),
    lastPath: s && s.last ? s.last.path : null,
    keys: s && s.positions ? Object.keys(s.positions).length : 0,
    hasA: !!(s && s.positions && s.positions['file:' + FILE_A]),
    hasB: !!(s && s.positions && s.positions['file:' + FILE_B]),
    aRatio: s && s.positions && s.positions['file:' + FILE_A] ? +s.positions['file:' + FILE_A].scrollRatio.toFixed(3) : null,
    bRatio: s && s.positions && s.positions['file:' + FILE_B] ? +s.positions['file:' + FILE_B].scrollRatio.toFixed(3) : null,
    tagsPresent: !!(s && s.positions && s.positions['file:' + FILE_A] && s.positions['file:' + FILE_A].tag)
  };
}

// 阶段 D：文件被外部改动过 → 只打开，不跳转
async function phaseD_staleFile() {
  fs.writeFileSync(FILE_C, makeDoc('C', 30), 'utf8');
  const win = freshWindow();
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(1500);

  const r = await run(win, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    applyMode('mode-split');
    await sleep(300);
    // 先正常打开并记录一个位置（带指纹）
    await openExternal(${JSON.stringify(FILE_C)}, { silent: true });
    await sleep(500);
    const h = scrollHost();
    h.scrollTop = (h.scrollHeight - h.clientHeight) * 0.7;
    flushPosition();
    await sleep(700);
    return { set: +currentScrollRatio().toFixed(3) };
  })()`);

  // 外部把文件改短 → 指纹失效
  await sleep(300);
  fs.writeFileSync(FILE_C, '# C 被外部改过了\n\n短了很多。\n', 'utf8');
  await sleep(150);

  const after = await run(win, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await openExternal(${JSON.stringify(FILE_A)}, { silent: true });   // 先切走
    await sleep(600);
    await openExternal(${JSON.stringify(FILE_C)}, { silent: true });   // 再打开被改过的 C
    await sleep(900);
    return { scrollTop: Math.round(scrollHost().scrollTop), len: editor.value.length };
  })()`);
  win.destroy();
  return { ...r, after };
}

app.whenReady().then(async () => {
  const out = { steps: {}, checks: {} };
  try {
    // 准备文档
    fs.writeFileSync(FILE_A, makeDoc('A', 40), 'utf8');
    fs.writeFileSync(FILE_B, makeDoc('B', 40), 'utf8');
    fs.writeFileSync(FILE_C, makeDoc('C', 30), 'utf8');
    try { fs.unlinkSync(sessionPath()); } catch (e) {}   // 干净起点

    out.steps.A = await phaseA_openFileNotClobbered();
    out.steps.B_split = await phaseB_perFileMemory('mode-split');
    out.steps.C = phaseC_storeShape();
    out.steps.B_live = await phaseB_perFileMemory('mode-live');
    out.steps.D = await phaseD_staleFile();

    const A = out.steps.A, S = out.steps.B_split, L = out.steps.B_live, C = out.steps.C, D = out.steps.D;
    const near = (a, b, tol) => Math.abs(a - b) < (tol || 0.08);

    out.checks = {
      // Bug1：打开的文件不能被示例文档顶掉
      bug1_fileNotClobbered: A.currentPath === FILE_A && A.isSample === false && A.len > 1000,

      // Bug2 + 新需求（双栏）：每个文件各自的位置都要能还原
      split_aRestored: S.aPathOk && near(S.aA.got, S.aA.want) && S.aA.got > 0.4,
      split_bRestored: S.bPathOk && near(S.aB.got, S.aB.want) && S.aB.got > 0.1,
      split_positionsIndependent: Math.abs(S.aRestored.got - S.bRestored.got) > 0.2,
      // 同一份实测（即时模式也要能还原）
      live_aRestored: L.aPathOk && near(L.aA.got, L.aA.want) && L.aA.got > 0.4,
      live_bRestored: L.bPathOk && near(L.aB.got, L.aB.want) && L.aB.got > 0.1,
      live_positionsIndependent: Math.abs(L.aRestored.got - L.bRestored.got) > 0.2,

      // 存储结构：每个文件一条，带指纹
      storePerFile: C.hasA && C.hasB && C.keys >= 2 && C.tagsPresent,
      // 文件被外部改过 → 不跳转
      staleFileNoJump: D.after.scrollTop === 0 && D.after.len < 200
    };
    out.pass = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.fail = String(e && e.stack || e);
  }
  console.log('POSITIONS_SMOKE ' + JSON.stringify(out, null, 2));
  // 注意：主进程自己那个窗口还活着，删文件会让它报 ENOENT——所以放到 exit 之前的最小窗口里
  app.exit(out.pass ? 0 : 3);
}).catch(e => { console.error('BOOT_ERROR', e); app.exit(1); });
