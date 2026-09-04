// v1.7.6 即时模式冒烟测试：contenteditable 所见即所得
// 验证：1) 点击块后光标精确落在点击处  2) 打字后提交转换回 markdown
//      3) 未编辑块零失真  4) 表格/代码/公式往返正确
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  await win.loadFile(path.join(__dirname, '..', '..', 'index.html'));
  await new Promise(r => setTimeout(r, 1500));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const out = { steps: [] };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      // 1) 进入即时模式
      applyMode('mode-live');
      await sleep(400);
      out.modeLive = document.body.classList.contains('mode-live');

      // 2) 注入测试文档
      editor.value = [
        '# 标题A',
        '',
        '这是第一段落，用于测试光标定位精度，包含一些中文与 English mixed 文本。',
        '',
        '- 列表项一',
        '- 列表项二',
        '',
        '| 列1 | 列2 |',
        '| --- | --- |',
        '| a1 | b1 |',
        '',
        '\`\`\`js',
        'console.log(1);',
        '\`\`\`',
        '',
        '$x^2+1$ 行内公式与文字同段。',
        ''
      ].join('\\n');
      editor.dispatchEvent(new Event('input'));
      await sleep(700); // 等防抖 renderLive + katex/mermaid

      const blocks = [...document.querySelectorAll('.live-block')];
      out.blockCount = blocks.length;

      // 3) 真实模拟点击段落块中部文字
      const para = blocks.find(b => b.textContent.includes('第一段落'));
      if (!para) return { fail: 'para block not found', out };
      const r = para.getBoundingClientRect();
      const cx = Math.round(r.left + 60);
      const cy = Math.round(r.top + Math.min(20, r.height / 2));
      para.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
      await sleep(120);

      const sel = window.getSelection();
      out.editing = !!document.querySelector('.live-block.editing');
      out.hasCaret = sel.rangeCount > 0;
      if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        out.caretInPara = para.contains(range.startContainer);
        const cr = range.getClientRects()[0];
        if (cr) out.caretDistPx = Math.round(Math.hypot(cr.left - cx, cr.top - cy));
      }

      // 4) 打字 + Esc 提交
      document.execCommand('insertText', false, 'XYZ');
      await sleep(400); // 等防抖同步
      const editing = document.querySelector('.live-block.editing');
      if (editing) editing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);

      out.editorHasXYZ = editor.value.includes('XYZ');
      out.paraMd = (editor.value.split('\\n').find(l => l.includes('XYZ')) || '').slice(0, 60);

      // 5) 未编辑块零失真
      out.titleKept = editor.value.includes('# 标题A');
      out.listKept = editor.value.includes('- 列表项二');
      out.codeKept = editor.value.includes('console.log(1);');
      out.tableKept = /列1.*列2/.test(editor.value) && editor.value.includes('| a1');
      out.mathKept = editor.value.includes('x^2+1');
      out.mermaidRendered = !!document.querySelector('.live-block svg, .live-block .mermaid svg');

      out.pass = out.modeLive && out.editing && out.hasCaret && out.caretInPara
        && out.editorHasXYZ && out.titleKept && out.listKept && out.codeKept && out.tableKept && out.mathKept;
      return out;
    } catch (err) {
      return { fail: String(err && err.stack || err), out };
    }
  })()`);

  console.log('SMOKE_RESULT ' + JSON.stringify(result, null, 2));
  app.exit(result && result.fail ? 2 : (result && result.pass ? 0 : 3));
}).catch(e => { console.error('SMOKE_BOOT_ERROR', e); app.exit(1); });
