// v1.9.0 冒烟：Python 代码块运行（端到端真实 main.js + 真实 venv + 真实 pip 安装）
// 场景：① print(1+1) 输出 2 ② 中文输出 UTF-8 ③ 缺包(six) → 一键安装 → 自动重跑成功
// 注意：必须 env -u ELECTRON_RUN_AS_NODE 运行；WWJ_PYENV_DIR 指向临时目录避免污染真实 userData
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const pyenvDir = path.join(os.tmpdir(), 'wwj-smoke-pyenv-' + Date.now());
process.env.WWJ_PYENV_DIR = pyenvDir;

const mdPath = path.join(os.tmpdir(), 'wwj-smoke-190-' + Date.now() + '.md');
fs.writeFileSync(mdPath, [
  '# smoke190',
  '',
  '```python',
  'print(1+1)',
  '```',
  '',
  '```python',
  'print("中文OK")',
  '```',
  '',
  '```python',
  'import six',
  'print("six", six.__version__)',
  '```',
  ''
].join('\n'), 'utf8');

require(path.join(__dirname, '..', '..', 'main.js'));

function poll(desc, checkFn, timeoutMs, intervalMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try {
        if (await checkFn()) return resolve(true);
      } catch (e) { /* keep polling */ }
      if (Date.now() - t0 > timeoutMs) return reject(new Error('POLL_TIMEOUT: ' + desc));
      setTimeout(tick, intervalMs || 400);
    };
    tick();
  });
}

app.whenReady().then(() => {
  setTimeout(async () => {
    let failed = false;
    const fail = (msg) => { failed = true; console.log('SMOKE190_FAIL ' + msg); };
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) { fail('no window'); return app.exit(2); }
      await new Promise(r => setTimeout(r, 800));
      // 打开含三个 python 块的 md
      win.webContents.send('open-file', mdPath);
      await new Promise(r => setTimeout(r, 1200));

      const prep = await win.webContents.executeJavaScript(`(async()=>{
        const out = {};
        out.pywrapCount = document.querySelectorAll('.py-wrap').length;
        out.btnCount = document.querySelectorAll('.py-run-btn').length;
        // 点击第一个代码块的运行按钮
        const btns = document.querySelectorAll('.py-run-btn');
        if (btns.length) btns[0].click();
        return out;
      })()`);
      console.log('SMOKE190_PREP ' + JSON.stringify(prep));
      if (prep.pywrapCount !== 3 || prep.btnCount !== 3) { fail('py-wrap/btn count=' + prep.pywrapCount + '/' + prep.btnCount); return app.exit(3); }

      // ① 等第一个块输出完成（venv 首次创建可能耗时 1-2 分钟）
      let run1 = null;
      try {
        await poll('run1 done', async () => {
          run1 = await win.webContents.executeJavaScript(`(async()=>{
            const outs = document.querySelectorAll('.py-out');
            const o = outs[0];
            if (!o) return null;
            const done = !o.textContent.includes('运行中');
            return { done, text: o.textContent, meta: (o.querySelector('.py-meta')||{}).textContent || '' };
          })()`);
          return run1 && run1.done;
        }, 240 * 1000, 500);
      } catch (e) { fail('run1 ' + e.message); return app.exit(4); }
      if (!/▶ .+python/i.test(run1.meta)) fail('run1 meta missing interpreter: ' + run1.meta);
      if (!run1.text.includes('2')) fail('run1 output missing 2: ' + run1.text);
      console.log('SMOKE190_RUN1_OK ' + JSON.stringify(run1));

      // ② 中文输出块
      await win.webContents.executeJavaScript(`document.querySelectorAll('.py-run-btn')[1].click()`);
      let run2 = null;
      try {
        await poll('run2 done', async () => {
          run2 = await win.webContents.executeJavaScript(`(async()=>{
            const o = document.querySelectorAll('.py-out')[1];
            if (!o) return null;
            return { done: !o.textContent.includes('运行中'), text: o.textContent };
          })()`);
          return run2 && run2.done;
        }, 60 * 1000, 400);
      } catch (e) { fail('run2 ' + e.message); return app.exit(5); }
      if (!run2.text.includes('中文OK')) fail('run2 中文乱码/缺失: ' + run2.text);
      console.log('SMOKE190_RUN2_OK ' + JSON.stringify(run2));

      // ③ 缺包块：import six → 应出现「安装 six」按钮
      await win.webContents.executeJavaScript(`document.querySelectorAll('.py-run-btn')[2].click()`);
      let run3 = null;
      try {
        await poll('run3 missing-btn', async () => {
          run3 = await win.webContents.executeJavaScript(`(async()=>{
            const o = document.querySelectorAll('.py-out')[2];
            if (!o) return null;
            const btn = o.querySelector('.py-mini-btn[data-pyact="install"]');
            return { btn: !!btn, pkg: btn ? btn.dataset.pkg : null, text: o.textContent.slice(0, 200) };
          })()`);
          return run3 && run3.btn;
        }, 60 * 1000, 400);
      } catch (e) { fail('run3 ' + e.message + ' text=' + (run3 && run3.text)); return app.exit(6); }
      if (run3.pkg !== 'six') { fail('run3 pkg=' + run3.pkg); return app.exit(7); }
      console.log('SMOKE190_RUN3_MISSING_OK');

      // 点击「安装 six」→ pip 装包 → 自动重跑 → 输出版本号
      await win.webContents.executeJavaScript(`document.querySelectorAll('.py-out')[2].querySelector('.py-mini-btn[data-pyact="install"]').click()`);
      let run3b = null;
      try {
        await poll('install+rerun', async () => {
          run3b = await win.webContents.executeJavaScript(`(async()=>{
            const o = document.querySelectorAll('.py-out')[2];
            if (!o) return null;
            const installing = !!o.querySelector('.py-install-log') || o.textContent.includes('安装中');
            return { installing, text: o.textContent };
          })()`);
          return run3b && !run3b.installing && /six\s+\d+\.\d+/.test(run3b.text);
        }, 300 * 1000, 800);
      } catch (e) { fail('install+rerun ' + e.message + ' text=' + (run3b && run3b.text)); return app.exit(8); }
      console.log('SMOKE190_RUN3_RERUN_OK ' + JSON.stringify(run3b.text.slice(0, 150)));

      // 环境面板打开
      const panel = await win.webContents.executeJavaScript(`(async()=>{
        document.getElementById('mi-pyenv').click();
        await new Promise(r=>setTimeout(r,3000));
        const open = document.getElementById('pyenv-mask').classList.contains('open');
        const info = document.getElementById('pyenv-info').textContent;
        const rows = document.querySelectorAll('.pyenv-pkg-row').length;
        return { open, info: info.slice(0,220), rows };
      })()`);
      if (!panel.open) fail('panel not open');
      if (panel.rows < 2) fail('panel rows=' + panel.rows + '（至少有 pip/setuptools）');
      console.log('SMOKE190_PANEL ' + JSON.stringify(panel));

      if (failed) { console.log('SMOKE190_RESULT FAIL'); return app.exit(9); }
      console.log('SMOKE190_RESULT PASS');
      app.exit(0);
    } catch (e) { console.error('SMOKE190_ERR', e); app.exit(1); }
  }, 1500);
});
