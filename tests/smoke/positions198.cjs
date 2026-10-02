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
      // ★ 复刻用户的真实编辑状态：把光标放到文末。
      // 即时模式下 editor.value = ... 会把 selectionStart 重置到文末，
      // 双栏下用户编辑完光标也常停在深处。恢复时若错误地 setSelectionRange，
      // 视图会被拽到文末——这就是"每次打开都跳到末尾"的复现路径。
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      // 真实应用的 flush 是 400ms 去抖的：等预览同步完成再落盘。
      // 同步立即 flush 会读到尚未跟上的预览位置（测试时序问题，非应用缺陷）。
      await sleep(450);
      flushPosition();
      await sleep(600);
      const h2 = scrollHost();
      return {
        max,
        want: target,
        top: Math.round(h2.scrollTop),
        got: +currentScrollRatio().toFixed(3),
        savedAnchor: currentAnchor()
      };
    };
    const readRatio = async () => {
      await sleep(900);
      return {
        top: Math.round(scrollHost().scrollTop),
        max: Math.round(scrollHost().scrollHeight - scrollHost().clientHeight),
        got: +currentScrollRatio().toFixed(3),
        anchorNow: currentAnchor(),
        atEnd: currentScrollRatio() > 0.9
      };
    };

    // 打开 A 并滚到 60%（光标故意停在文末）
    await openExternal(${JSON.stringify(FILE_A)}, { silent: true });
    await sleep(500);
    out.aA = await setRatio(0.60);

    // 打开 B 并滚到 25%（A 的位置必须被独立保留）
    await openExternal(${JSON.stringify(FILE_B)}, { silent: true });
    await sleep(500);
    out.aB = await setRatio(0.25);

    // 回到 A —— 应当跳回蓝标标题，而不是文末、也不是 B 的位置
    await openExternal(${JSON.stringify(FILE_A)}, { silent: true });
    out.aRestored = await readRatio();
    out.aPathOk = currentPath === ${JSON.stringify(FILE_A)};

    // 再切到 B —— 应当回到 B 自己的蓝标
    await openExternal(${JSON.stringify(FILE_B)}, { silent: true });
    out.bRestored = await readRatio();
    out.bPathOk = currentPath === ${JSON.stringify(FILE_B)};

    return out;
  })()`;
  const r = await run(win, script);
  win.destroy();
  return r;
}

// —— 阶段 E：编辑保存后位置依然恢复 ——
// 这是用户实测"依旧没有实现"的根因路径：打开 → 读到一半 → 编辑 → Ctrl+S →
// 继续读 → 切走 → 切回来。Ctrl+S 改变 mtime，旧实现里 currentFileTag 不刷新，
// 存储的指纹与磁盘指纹从此永久不匹配 → 位置记忆被一次保存永久打死。
async function phaseE_afterSaveRestore() {
  const win = freshWindow();
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(1500);
  const r = await run(win, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    applyMode('mode-split');
    await sleep(300);

    // 1) 打开 A，读到 60%
    await openExternal(${JSON.stringify(FILE_A)}, { silent: true });
    await sleep(500);

    // 2) 用户编辑 + Ctrl+S（mtime 变了——旧实现在这里断链）
    editor.value = editor.value + '\\n\\n用户后来追加的一段内容。\\n';
    editor.dispatchEvent(new Event('input'));
    await saveCurrent(false);
    await sleep(500);

    // 3) 保存后继续读到 60%
    const h = scrollHost();
    h.scrollTop = (h.scrollHeight - h.clientHeight) * 0.60;
    await sleep(450);   // 等编辑器→预览同步（真实 flush 是 400ms 去抖）
    flushPosition();
    await sleep(600);
    const anchorBefore = currentAnchor();
    const tagAfterSave = currentFileTag;

    // 4) 切走再切回来
    await openExternal(${JSON.stringify(FILE_B)}, { silent: true });
    await sleep(600);
    await openExternal(${JSON.stringify(FILE_A)}, { silent: true });
    await sleep(900);

    return {
      anchorBefore,
      anchorNow: currentAnchor(),
      ratio: +currentScrollRatio().toFixed(3),
      atEnd: currentScrollRatio() > 0.9,
      restored: currentScrollRatio() > 0.2,
      // 磁盘指纹必须与保存后指纹一致（不再被误判"外部改动"）
      tagMatches: String(tagAfterSave) === String(await fileTagOf(${JSON.stringify(FILE_A)}))
    };
  })()`);
  win.destroy();
  return r;
}

// —— 阶段 F：蓝标快速滚动性能 ——
// 隐藏窗口下 Chromium 会把 rAF 节流到 1fps，所以不能靠"帧耗时"判断卡顿。
// 真正该量的是：缓存生效后，快速滚动过程中**每帧的布局读取次数**
// （旧实现每帧对全部标题 getBoundingClientRect；新实现应为 0）。
async function phaseF_outlinePerf() {
  const win = freshWindow();
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(1500);
  const r = await run(win, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    applyMode('mode-split');
    await sleep(300);
    await openExternal(${JSON.stringify(FILE_A)}, { silent: true });
    await sleep(600);

    // 实时二分查找：每帧约 log2(N) 次布局读取（40 个标题 ≈ 6 次），
    // 相比"每帧遍历全部标题"（40 次）少一个量级，且不存在缓存过期问题。
    // 测量窗口内暂停"保存去抖链"：真实窗口里 flush 受 400ms 去抖限制（≤2.5 次/秒，
    // 60fps 下 ≈ 0.04 次/帧）；而隐藏窗口 rAF 被节流到 ~1s/帧，去抖会每帧都触发，
    // 把保存路径（锚点换算 + 诊断日志）的开销算进来，扭曲"每帧布局读取"的度量。
    // 本项指标针对**蓝标查找路径**；保存路径由阶段 B/D/E 的断言覆盖。
    const origFlush = flushPosition;
    flushPosition = () => {};
    let gbcrCalls = 0;
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { gbcrCalls++; return orig.call(this); };
    const host = scrollHost();
    const hmax = host.scrollHeight - host.clientHeight;
    for (let i = 0; i < 120; i++) {
      host.scrollTop = hmax * (i / 120);
      updateOutlineActive();
      await new Promise(r => requestAnimationFrame(r));
    }
    Element.prototype.getBoundingClientRect = orig;
    flushPosition = origFlush;

    // 蓝标查找本身的开销
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) blueMarkerIndexAtVisual(90);
    const perCallMs = (performance.now() - t0) / 2000;

    return {
      frames: 120,
      gbcrDuringScroll: gbcrCalls,
      heads: outlineHeads.length,
      naiveWouldBe: outlineHeads.length * 120,
      blueMarkerPerCallMs: +perCallMs.toFixed(3)
    };
  })()`);
  win.destroy();
  return r;
}
// —— 阶段 C：session.json 结构（每文件一条） ——
function phaseC_storeShape() {
  const s = readSession();
  const pa = s && s.positions ? s.positions['file:' + FILE_A] : null;
  return {
    hasLast: !!(s && s.last),
    lastPath: s && s.last ? s.last.path : null,
    keys: s && s.positions ? Object.keys(s.positions).length : 0,
    hasA: !!pa,
    hasB: !!(s && s.positions && s.positions['file:' + FILE_B]),
    tagsPresent: !!(pa && pa.tag),
    // cursor 字段必须彻底消失（它是"跳到末尾"的根源）
    hasCursor: !!(pa && typeof pa.cursor === 'number' && pa.cursor > 0)
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
    out.steps.E = await phaseE_afterSaveRestore();
    out.steps.F = await phaseF_outlinePerf();

    const A = out.steps.A, S = out.steps.B_split, L = out.steps.B_live, C = out.steps.C, D = out.steps.D;
    const E = out.steps.E, F = out.steps.F;
    const near = (a, b, tol) => Math.abs(a - b) < (tol || 0.08);
    // 蓝标断言：恢复后视口顶部的标题 == 保存时的蓝标标题
    const anchorMatch = (saved, now) =>
      !!(saved && now && saved.text === now.text && (saved.ord || 0) === (now.ord || 0));

    out.checks = {
      // Bug1：打开的文件不能被示例文档顶掉
      bug1_fileNotClobbered: A.currentPath === FILE_A && A.isSample === false && A.len > 1000,

      // Bug3（"跳到末尾"）：光标停在文末时重开，绝不能跳到末尾
      // 且恢复后的蓝标 == 保存时的蓝标
      split_noEndJump: S.aPathOk && S.aRestored.atEnd === false && S.bRestored.atEnd === false,
      split_anchorRestored: anchorMatch(S.aA.savedAnchor, S.aRestored.anchorNow),
      split_bAnchorRestored: anchorMatch(S.aB.savedAnchor, S.bRestored.anchorNow),
      split_positionsIndependent: Math.abs(S.aRestored.got - S.bRestored.got) > 0.15,

      // 即时模式同样要求
      live_noEndJump: L.aPathOk && L.aRestored.atEnd === false && L.bRestored.atEnd === false,
      live_anchorRestored: anchorMatch(L.aA.savedAnchor, L.aRestored.anchorNow),
      live_bAnchorRestored: anchorMatch(L.aB.savedAnchor, L.bRestored.anchorNow),
      live_positionsIndependent: Math.abs(L.aRestored.got - L.bRestored.got) > 0.15,

      // Bug4（本轮核心）：编辑 + Ctrl+S 之后位置依然恢复
      // ——指纹必须跟着保存刷新（tagMatches），且蓝标还在、不在末尾
      afterSave_tagRefreshed: E.tagMatches === true,
      afterSave_positionRestored: E.restored === true && E.atEnd === false,
      afterSave_anchorKept: anchorMatch(E.anchorBefore, E.anchorNow),

      // 存储结构：每个文件一条，带指纹，且不含 cursor 字段
      storePerFile: C.hasA && C.hasB && C.keys >= 2 && C.tagsPresent && !C.hasCursor,
      // 文件被外部改过 → 不跳转
      staleFileNoJump: D.after.scrollTop === 0 && D.after.len < 200,

      // 蓝标性能：实时二分查找每帧只读 log2(N) 次布局，
      // 总量应远低于"每帧遍历全部标题"（heads × 120）；单次查找亚毫秒
      outlineFastEnough: F.gbcrDuringScroll < F.naiveWouldBe / 2 &&
                         F.blueMarkerPerCallMs < 1
    };
    out.pass = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.fail = String(e && e.stack || e);
  }
  console.log('POSITIONS_SMOKE ' + JSON.stringify(out, null, 2));
  // 注意：主进程自己那个窗口还活着，删文件会让它报 ENOENT——所以放到 exit 之前的最小窗口里
  app.exit(out.pass ? 0 : 3);
}).catch(e => { console.error('BOOT_ERROR', e); app.exit(1); });
