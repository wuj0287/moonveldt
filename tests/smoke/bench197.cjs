// v1.9.7 性能基准（修正版）
// 关键修正：
//   · 全量渲染是同步的，但 blockCount 要等 DOM 落盘后再读
//   · 滚动场景必须用真正的渲染完后的布局；上一版在空 preview 上循环 60 帧，
//     每帧都在等 rAF 但页面无可滚动内容，导致耗时统计失真
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT_ARG = process.argv.find(a => a.startsWith('--root='));
const ROOT = ROOT_ARG ? path.resolve(ROOT_ARG.split('=')[1]) : path.join(__dirname, '..', '..');
const LABEL = (process.argv.find(a => a.startsWith('--label=')) || '--label=unknown').split('=')[1];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 真实规模的课程笔记：60 节、含 12 个代码块、12 个表格、大量列表
function makeDoc(paragraphs, codeBlocks) {
  const L = [];
  for (let i = 1; i <= paragraphs; i++) {
    L.push('## 第 ' + i + ' 节 主题标题');
    L.push('');
    L.push('这是一段用于压测的正文，覆盖常见的中文写作场景。' + '内容重复充当真实段落。'.repeat(6));
    L.push('');
    if (i % 3 === 0 && codeBlocks-- > 0) {
      L.push('```python');
      L.push('def process_' + i + '(data):');
      L.push('    total = sum(x ** 2 for x in data)');
      L.push('    return {"index": ' + i + ', "total": total}');
      L.push('```');
      L.push('');
    }
    if (i % 5 === 0) {
      L.push('| 列A | 列B | 列C |');
      L.push('| --- | --- | --- |');
      L.push('| a' + i + ' | b' + i + ' | c' + i + ' |');
      L.push('');
    }
    L.push('- 要点一：' + i);
    L.push('- 要点二：' + i);
    L.push('');
  }
  return L.join('\n');
}

async function bench(doc) {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(1800);

  const r = await win.webContents.executeJavaScript(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const out = {};

    // v1.9.6 没有 scrollHost()：兼容取法，保证两版跑的是同一套度量
    const hostOf = () => (typeof scrollHost === 'function')
      ? scrollHost()
      : (document.body.classList.contains('mode-split') ? editor : previewWrap);

    // —— 场景 1：大文档首次全量渲染 ——
    const doc = ${JSON.stringify(doc)};
    editor.value = doc;
    renderMode = 'full';
    const t0 = performance.now();
    renderPreview();
    out.firstRenderMs = +(performance.now() - t0).toFixed(1);
    await sleep(1000);
    out.blockCount = document.querySelectorAll('.md-block').length;
    out.docChars = doc.length;

    // —— 场景 2：连续输入 25 个字符（增量渲染路径）——
    // 模拟用户的真实节奏：每键触发一次渲染管线（含 marked + 高亮 + outline + 状态栏）
    renderMode = 'incremental';
    editor.setSelectionRange(300, 300);
    const perKey = [];
    for (let i = 0; i < 25; i++) {
      const s = editor.selectionStart;
      editor.value = editor.value.slice(0, s) + 'x' + editor.value.slice(s);
      editor.setSelectionRange(s + 1, s + 1);
      const k0 = performance.now();
      renderPreview();
      updateStatus();
      updateOutline();
      perKey.push(performance.now() - k0);
    }
    perKey.sort((a, b) => a - b);
    out.keyAvgMs = +(perKey.reduce((a, b) => a + b, 0) / perKey.length).toFixed(2);
    out.keyP50Ms = +perKey[Math.floor(perKey.length * 0.5)].toFixed(2);
    out.keyP95Ms = +perKey[Math.floor(perKey.length * 0.95)].toFixed(2);
    out.keyMaxMs = +perKey[perKey.length - 1].toFixed(2);

    // —— 场景 3：大纲重建 30 次（标题未变，应命中缓存短路）——
    const t1 = performance.now();
    for (let i = 0; i < 30; i++) updateOutline();
    out.outline30xMs = +(performance.now() - t1).toFixed(1);

    // —— 场景 4：滚动 40 个位置，测每次高亮更新的同步开销（不掺 rAF 等待）——
    const host = hostOf();
    const hmax = host.scrollHeight - host.clientHeight;
    out.scrollable = hmax > 0;
    const t2 = performance.now();
    for (let i = 0; i < 40; i++) {
      host.scrollTop = hmax * (i / 40);
      updateOutlineActive();
      // 强制读一次布局，把延迟到下一帧的成本算进来
      void host.getBoundingClientRect().top;
    }
    out.scroll40Ms = +(performance.now() - t2).toFixed(1);
    out.scrollPerUpdateMs = +(out.scroll40Ms / 40).toFixed(3);
    return out;
  })()`);

  win.destroy();
  return { label: LABEL, ...r };
}

app.whenReady().then(async () => {
  const doc = makeDoc(60, 12);
  const res = await bench(doc);
  console.log('BENCH ' + JSON.stringify(res, null, 2));
  try {
    fs.mkdirSync(path.join(ROOT, 'tar_build'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'tar_build', 'bench_' + res.label + '.json'), JSON.stringify(res, null, 2));
  } catch (e) {}
  app.exit(0);
}).catch(e => { console.error('BENCH_ERROR', e); app.exit(1); });
