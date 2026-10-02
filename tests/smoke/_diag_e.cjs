// 诊断：phase E（编辑+保存后恢复）与 phase F（蓝标滚动性能）的逐步状态
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'main.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (w, c) => w.webContents.executeJavaScript(c);

const F = path.join(os.tmpdir(), 'mv-diagE.md');
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
fs.writeFileSync(F, makeDoc('A', 40), 'utf8');

const PROBE = `(function(){
  return {
    mode: currentMode(),
    eTop: Math.round(editor.scrollTop),
    eMax: Math.round(editor.scrollHeight - editor.clientHeight),
    pTop: Math.round(previewWrap.scrollTop),
    pMax: Math.round(previewWrap.scrollHeight - previewWrap.clientHeight),
    ratio: +currentScrollRatio().toFixed(3),
    anchor: currentAnchor(),
    dirty: headOffsetsDirty,
    heads: outlineHeads.length,
    offsets: headOffsets.length,
    lock: startupLock
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(1500);

  const log = [];
  const probe = async (label) => {
    const r = await run(win, PROBE);
    log.push({ label, ...r });
  };

  await run(win, `applyMode('mode-split'); true`);
  await sleep(300);
  await probe('after-applyMode');

  await run(win, `openExternal(${JSON.stringify(F)}, { silent: true })`);
  await sleep(600);
  await probe('after-open');

  // 编辑（模拟用户追加内容）
  await run(win, `editor.value = editor.value + '\\n\\n追加内容。\\n'; editor.dispatchEvent(new Event('input')); true`);
  await sleep(100);
  await probe('after-edit+100ms');
  await sleep(300);
  await probe('after-edit+400ms');

  // 保存
  await run(win, `saveCurrent(false)`);
  await sleep(300);
  await probe('after-save+300ms');
  await sleep(400);
  await probe('after-save+700ms');

  // 滚到 60%
  await run(win, `const h=scrollHost(); h.scrollTop=(h.scrollHeight-h.clientHeight)*0.6; true`);
  await probe('scroll-set+0ms');
  await sleep(200);
  await probe('scroll-set+200ms');
  await sleep(500);
  await probe('scroll-set+700ms');

  // flush + 再读
  await run(win, `flushPosition(); true`);
  await probe('after-flush');

  // 模拟快速滚动 40 帧，计时
  const perf = await run(win, `(async () => {
    const host = scrollHost();
    const hmax = host.scrollHeight - host.clientHeight;
    const marks = [];
    for (let i = 0; i < 40; i++) {
      host.scrollTop = hmax * (i / 40);
      const t1 = performance.now();
      updateOutlineActive();
      await new Promise(r => requestAnimationFrame(r));
      marks.push(+(performance.now() - t1).toFixed(1));
    }
    return { marks, dirty: headOffsetsDirty, offsets: headOffsets.length, heads: outlineHeads.length };
  })()`);
  log.push({ label: 'perf-40frames', ...perf });

  console.log('DIAGE ' + JSON.stringify(log, null, 1));
  win.destroy();
  app.exit(0);
}).catch(e => { console.error('ERR', e); app.exit(1); });
