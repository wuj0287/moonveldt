// v1.9.1 冒烟：健壮性重构端到端验证
// 场景：① 非阅读模式按钮不可见/阅读模式可见 ② 首次运行进度事件到达（环境阶段推送）
//       ③ 运行输出正常 ④ 面板未关时点运行被拒绝 ⑤ × 关闭后可重跑
//       ⑥ 运行中修改代码 → 自动 stop + 面板清除 + 无孤儿状态 ⑦ 环境面板正常
// 注意：必须 env -u ELECTRON_RUN_AS_NODE；WWJ_PYENV_DIR 指向临时目录
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const pyenvDir = path.join(os.tmpdir(), 'wwj-smoke-pyenv191-' + Date.now());
process.env.WWJ_PYENV_DIR = pyenvDir;

const mdPath = path.join(os.tmpdir(), 'wwj-smoke-191-' + Date.now() + '.md');
fs.writeFileSync(mdPath, [
  '# smoke191',
  '',
  '```python',
  'print(1+1)',
  '```',
  '',
  '```python',
  'import time',
  'print("start")',
  'time.sleep(8)',
  'print("slow done")',
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
      let v = null;
      try { v = await checkFn(); } catch (e) {}
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('POLL_TIMEOUT: ' + desc));
      setTimeout(tick, intervalMs || 400);
    };
    tick();
  });
}

app.whenReady().then(() => {
  setTimeout(async () => {
    const fails = [];
    const fail = (m) => { fails.push(m); console.log('SMOKE191_FAIL ' + m); };
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) { fail('no window'); return app.exit(2); }
      await new Promise(r => setTimeout(r, 800));
      win.webContents.send('open-file', mdPath);
      await new Promise(r => setTimeout(r, 1000));

      // ① 模式限制：强制从 split 开始（防上轮 localStorage 污染），按钮不可见；切阅读模式可见
      const mode = await win.webContents.executeJavaScript(`(async()=>{
        const out = {};
        applyMode('mode-split');
        await new Promise(r=>setTimeout(r,300));
        const btn = document.querySelector('.py-run-btn');
        out.btnExists = !!btn;
        out.splitHidden = getComputedStyle(btn).display === 'none';
        applyMode('mode-read');
        await new Promise(r=>setTimeout(r,300));
        out.readVisible = getComputedStyle(document.querySelector('.py-run-btn')).display !== 'none';
        out.bodyIsRead = document.body.classList.contains('mode-read');
        return out;
      })()`);
      console.log('SMOKE191_MODE ' + JSON.stringify(mode));
      if (!mode.splitHidden) fail('split mode: button not hidden');
      if (!mode.readVisible || !mode.bodyIsRead) fail('read mode: button not visible');

      // 挂进度事件收集器（venv 首次创建应推 detecting/creating）
      await win.webContents.executeJavaScript(`(async()=>{
        window.__stages = [];
        window.wwj.onPyEnvProgress(info => window.__stages.push(info.stage));
      })()`);

      // ②③ 运行块 1（含首次 venv 创建，可能较久）
      await win.webContents.executeJavaScript(`document.querySelectorAll('.py-run-btn')[0].click()`);
      let run1 = null;
      try {
        await poll('run1', async () => {
          run1 = await win.webContents.executeJavaScript(`(async()=>{
            const o = document.querySelectorAll('.py-out')[0];
            if (!o) return null;
            return { done: !o.querySelector('.py-progress'), text: o.textContent };
          })()`);
          return run1 && run1.done;
        }, 240 * 1000, 400);
      } catch (e) { fail('run1 ' + e.message); return app.exit(4); }
      if (!run1.text.includes('2')) fail('run1 output: ' + run1.text);
      console.log('SMOKE191_RUN1_OK');

      const stages = await win.webContents.executeJavaScript(`window.__stages`);
      console.log('SMOKE191_STAGES ' + JSON.stringify(stages));
      if (!stages.includes('starting')) fail('progress stages missing starting: ' + JSON.stringify(stages));

      // ④ 面板未关时再点运行 → 被拒绝（不出现第二个面板/不重跑）
      const rej = await win.webContents.executeJavaScript(`(async()=>{
        const before = document.querySelectorAll('.py-out').length;
        document.querySelectorAll('.py-run-btn')[0].click();
        await new Promise(r=>setTimeout(r,500));
        const after = document.querySelectorAll('.py-out').length;
        const mapSize = pyOutMap.size;
        return { before, after, mapSize };
      })()`);
      console.log('SMOKE191_REJECT ' + JSON.stringify(rej));
      if (rej.after !== 1 || rej.mapSize !== 1) fail('reject-rerun: outs=' + rej.after + ' map=' + rej.mapSize);

      // ⑤ × 关闭 → 面板消失 → 状态清零 → 可重跑
      const close = await win.webContents.executeJavaScript(`(async()=>{
        document.querySelector('.py-out .py-close').click();
        await new Promise(r=>setTimeout(r,200));
        const outs = document.querySelectorAll('.py-out').length;
        const mapSize = pyOutMap.size;
        // 重跑
        document.querySelectorAll('.py-run-btn')[0].click();
        return { outs, mapSize };
      })()`);
      console.log('SMOKE191_CLOSE ' + JSON.stringify(close));
      if (close.outs !== 0 || close.mapSize !== 0) fail('close: outs=' + close.outs + ' map=' + close.mapSize);
      try {
        await poll('rerun after close', async () => {
          const r = await win.webContents.executeJavaScript(`(async()=>{
            const o = document.querySelectorAll('.py-out')[0];
            if (!o) return null;
            return { done: !o.querySelector('.py-progress'), text: o.textContent };
          })()`);
          return r && r.done && r.text.includes('2');
        }, 30 * 1000, 300);
      } catch (e) { fail('rerun after close ' + e.message); return app.exit(5); }
      console.log('SMOKE191_RERUN_OK');

      // ⑥ 运行中修改代码 → 自动 stop + 面板清除 + 无孤儿
      const dbg = await win.webContents.executeJavaScript(`(async()=>{
        const c = document.querySelector('.py-out .py-close');
        const info = { closed: !!c };
        if (c) c.click();
        const btns = document.querySelectorAll('.py-run-btn');
        info.btnCount = btns.length;
        btns[1].click();
        await new Promise(r=>setTimeout(r,800));
        info.mapSize = pyOutMap.size;
        info.outs = document.querySelectorAll('.py-out').length;
        info.outsCls = Array.from(document.querySelectorAll('.py-out')).map(o=>o.dataset.pyhash);
        info.btn2Running = btns[1].classList.contains('running');
        return info;
      })()`);
      console.log('SMOKE191_DBG ' + JSON.stringify(dbg));
      try {
        await poll('run2 running', async () => {
          const r = await win.webContents.executeJavaScript(`(async()=>{
            const outs = document.querySelectorAll('.py-out');
            const o = outs[outs.length-1];
            if (!o) return null;
            return { running: !!o.querySelector('.py-progress') };
          })()`);
          return r && r.running;
        }, 15 * 1000, 200);
      } catch (e) { fail('run2 not running: ' + e.message + ' dbg=' + JSON.stringify(dbg)); return app.exit(6); }
      // 修改块 2 的代码（触发增量重渲 → prune → 自动 stop）
      await win.webContents.executeJavaScript(`(async()=>{
        const ed = document.getElementById('editor');
        ed.value = ed.value.replace('time.sleep(8)', 'time.sleep(1)');
        ed.dispatchEvent(new Event('input'));
      })()`);
      await new Promise(r => setTimeout(r, 1200));
      const orphan = await win.webContents.executeJavaScript(`(async()=>{
        return {
          outs: document.querySelectorAll('.py-out').length,
          mapSize: pyOutMap.size,
          runningStates: Array.from(pyOutMap.values()).filter(s=>s.status==='running').length
        };
      })()`);
      console.log('SMOKE191_ORPHAN ' + JSON.stringify(orphan));
      if (orphan.outs !== 0 || orphan.mapSize !== 0 || orphan.runningStates !== 0) {
        fail('orphan after edit: ' + JSON.stringify(orphan));
      }
      // 等一会让被 stop 的进程退出，确认主进程解锁（再跑一次不 busy）
      await new Promise(r => setTimeout(r, 1500));
      const busy = await win.webContents.executeJavaScript(`(async()=>{
        document.querySelectorAll('.py-run-btn')[0].click();
        await new Promise(r=>setTimeout(r,800));
        const o = document.querySelectorAll('.py-out')[0];
        return o ? o.textContent.slice(0,120) : 'no-out';
      })()`);
      if (/已有代码在运行/.test(busy)) fail('main proc still busy after prune-stop');
      console.log('SMOKE191_UNBUSY_OK');

      // ⑦ 缺包一键安装：运行块 3（import six）→ 出「安装 six」→ 点击 → 自动重跑输出版本
      const lastOut = `document.querySelectorAll('.py-out')[document.querySelectorAll('.py-out').length-1]`;
      const inst = await win.webContents.executeJavaScript(`(async()=>{
        const c = document.querySelector('.py-out .py-close');
        if (c) c.click();
        document.querySelectorAll('.py-run-btn')[2].click();
        await new Promise(r=>setTimeout(r,4000));
        const o = ${lastOut};
        if (!o) return { btn:false, pkg:null, text:'no-out' };
        const btn = o.querySelector('.py-mini-btn[data-pyact="install"]');
        return { btn: !!btn, pkg: btn ? btn.dataset.pkg : null, text: o.textContent.slice(0,150) };
      })()`);
      console.log('SMOKE191_MISSING ' + JSON.stringify(inst));
      if (!inst.btn || inst.pkg !== 'six') { fail('missing-pkg btn=' + inst.btn + ' pkg=' + inst.pkg); return app.exit(7); }
      try {
        await poll('install six + rerun', async () => {
          const r = await win.webContents.executeJavaScript(`(async()=>{
            const o = ${lastOut};
            if (!o) return null;
            const busy = !!o.querySelector('.py-progress') || !!o.querySelector('.py-install-log');
            return { busy, text: o.textContent };
          })()`);
          return r && !r.busy && /six\s+\d+\.\d+/.test(r.text);
        }, 300 * 1000, 800);
      } catch (e) { fail('install six: ' + e.message); return app.exit(8); }
      console.log('SMOKE191_INSTALL_RERUN_OK');

      // ⑧ 环境面板
      const panel = await win.webContents.executeJavaScript(`(async()=>{
        document.getElementById('mi-pyenv').click();
        await new Promise(r=>setTimeout(r,2500));
        return {
          open: document.getElementById('pyenv-mask').classList.contains('open'),
          rows: document.querySelectorAll('.pyenv-pkg-row').length
        };
      })()`);
      if (!panel.open || panel.rows < 1) fail('panel open=' + panel.open + ' rows=' + panel.rows);
      console.log('SMOKE191_PANEL ' + JSON.stringify(panel));

      if (fails.length) { console.log('SMOKE191_RESULT FAIL(' + fails.length + ')'); return app.exit(9); }
      console.log('SMOKE191_RESULT PASS');
      app.exit(0);
    } catch (e) { console.error('SMOKE191_ERR', e); app.exit(1); }
  }, 1500);
});
