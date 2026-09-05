const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const PyCore = require('./pyrun-core');

let win = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const EXTS = ['.md', '.markdown', '.mdown', '.mkd', '.txt'];
const IMAGE_MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
};

function fileFromArgv(argv) {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (!a || a.startsWith('-')) continue;
    try {
      if (EXTS.includes(path.extname(a).toLowerCase()) && fs.existsSync(a)) {
        return path.resolve(a);
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

function createWindow(fileToOpen) {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 500,
    title: 'wwj',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  // 防止拖拽文件导致页面跳转
  win.webContents.on('will-navigate', e => e.preventDefault());

  // Ctrl+滚轮兜底：Electron 原生 zoom-changed 事件，抵消原生缩放并转发给渲染层
  win.webContents.on('zoom-changed', (e, dir) => {
    win.webContents.setZoomLevel(0);
    win.webContents.send('zoom-step', dir === 'in' ? 10 : -10);
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', () => {
    // 打开文件默认最大化（加载完成后再最大化，避免布局闪现）
    win.maximize();
    if (fileToOpen) win.webContents.send('open-file', fileToOpen);
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', (e, argv) => {
  const f = fileFromArgv(argv);
  if (win) {
    if (f) win.webContents.send('open-file', f);
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  app.setAppUserModelId('com.wwj.editor');
  Menu.setApplicationMenu(null);
  createWindow(fileFromArgv(process.argv));
});

app.on('window-all-closed', () => app.quit());

/* ---------- IPC ---------- */
ipcMain.handle('read-text', (e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('list-dir-md', (e, dir, excludePath) => {
  const dirMd = ['.md', '.markdown', '.mdown', '.mkd', '.txt'];
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => !d.isDirectory() && dirMd.includes(path.extname(d.name).toLowerCase()))
      .map(d => ({
        name: d.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, ''),
        file: d.name,
        path: path.join(dir, d.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return items;
  } catch (e) { return []; }
});
ipcMain.handle('read-image-data', (e, p) => {
  const ext = path.extname(p).toLowerCase();
  const mime = IMAGE_MIMES[ext];
  if (!mime) throw new Error('不支持的图片格式: ' + ext);
  return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
});
ipcMain.handle('write-text', (e, p, c) => { fs.writeFileSync(p, c, 'utf8'); return true; });
ipcMain.handle('read-base64', (e, p) => {
  const b = fs.readFileSync(p);
  if (b.length > 15 * 1024 * 1024) return { ok: false, reason: 'too-large', size: b.length };
  return { ok: true, data: b.toString('base64'), size: b.length };
});

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '打开 Markdown 文件',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }],
    properties: ['openFile']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('save-dialog', async (e, name) => {
  const r = await dialog.showSaveDialog(win, {
    title: '保存 Markdown 文件',
    defaultPath: (name || '未命名') + '.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('export-pdf', async (e, name) => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出 PDF',
    defaultPath: (name || '未命名') + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled) return null;
  const buf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
  });
  fs.writeFileSync(r.filePath, buf);
  return r.filePath;
});

/* ---------- Python 代码块运行通道（wwj 专属 venv，独立进程，块间隔离） ----------
   注意：主进程内禁止 spawnSync（会阻塞事件循环导致窗口假死），全部走异步 execFileAsync */
const PYRUN_TIMEOUT_MS = 30 * 1000;
const PYINSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const pyState = { runProc: null, installing: false };

function pyEnvDir() {
  return process.env.WWJ_PYENV_DIR || path.join(app.getPath('userData'), 'pyenv');
}
function venvPythonPath() {
  return process.platform === 'win32'
    ? path.join(pyEnvDir(), 'Scripts', 'python.exe')
    : path.join(pyEnvDir(), 'bin', 'python');
}
function venvReady() { try { return fs.existsSync(venvPythonPath()); } catch (e) { return false; } }
function pyEnvProgress(stage, message) {
  try { if (win && win.webContents) win.webContents.send('py-env-progress', { stage, message }); } catch (e) {}
}

/* 异步执行外部命令（替代 spawnSync，不阻塞主进程） */
function execFileAsync(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    let proc;
    try { proc = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { return resolve({ status: -1, stdout: '', stderr: String(e) }); }
    const timer = timeoutMs ? setTimeout(() => { try { proc.kill(); } catch (e2) {} }, timeoutMs) : null;
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
    proc.on('error', (e) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: stderr + String(e), error: e });
    });
    proc.on('close', (code) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

/* 探测系统 Python：优先渲染层设置路径，其次 py launcher，最后 PATH 上的 python/python3 */
async function detectSystemPython(override) {
  const probe = async (cmd, args) => {
    const r = await execFileAsync(cmd, args.concat(['-c', 'import sys; print(sys.executable)']), 15 * 1000);
    if (r.status !== 0) return null;
    const p = (r.stdout || '').trim().split(/\r?\n/).pop().trim();
    return (p && fs.existsSync(p)) ? p : null;
  };
  if (override && String(override).trim()) {
    const p = await probe(String(override).trim(), []);
    if (p) return p;
  }
  const p1 = await probe('py', ['-3']);
  if (p1) return p1;
  const p2 = await probe('python', []);
  if (p2) return p2;
  return probe('python3', []);
}

async function ensureVenv(override) {
  if (venvReady()) return { ok: true, venvPython: venvPythonPath() };
  pyEnvProgress('detecting', '正在探测系统 Python…');
  const sysPy = await detectSystemPython(override);
  if (!sysPy) return { ok: false, reason: 'no-python', message: '未检测到系统 Python，请安装 Python 3.8+ 后重试' };
  pyEnvProgress('creating', '正在创建 wwj 专属 Python 环境（首次约 10-40 秒，仅此一次）…');
  try { fs.mkdirSync(pyEnvDir(), { recursive: true }); } catch (e) {}
  const r = await execFileAsync(sysPy, ['-m', 'venv', pyEnvDir()], 180 * 1000);
  if (!venvReady()) {
    return { ok: false, reason: 'venv-failed', message: 'venv 创建失败: ' + ((r.stderr || r.stdout || '').slice(-400) || ('exit ' + r.status)) };
  }
  pyEnvProgress('ready', '环境就绪');
  return { ok: true, venvPython: venvPythonPath() };
}

let uvCache; // undefined=未检测 / null=无 / 'uv'=有
async function detectUv(force) {
  if (uvCache !== undefined && !force) return uvCache;
  const r = await execFileAsync('uv', ['--version'], 8 * 1000);
  uvCache = (r.status === 0) ? 'uv' : null;
  return uvCache;
}

ipcMain.handle('py-info', async (e, override) => {
  return {
    venvDir: pyEnvDir(),
    venvPython: venvPythonPath(),
    venvReady: venvReady(),
    systemPython: await detectSystemPython(override),
    uv: await detectUv(),
    mirrors: Object.keys(PyCore.MIRRORS)
  };
});

ipcMain.handle('py-run', async (e, code, override) => {
  if (typeof code !== 'string' || !code.trim()) return { ok: false, reason: 'empty', message: '代码为空' };
  if (pyState.runProc) return { ok: false, reason: 'busy', message: '已有代码在运行，请先停止或等待完成' };
  const v = await ensureVenv(override);
  if (!v.ok) return v;
  return await new Promise((resolve) => {
    const tmp = path.join(require('os').tmpdir(), 'wwj-pyrun-' + process.pid + '-' + Date.now() + '.py');
    try { fs.writeFileSync(tmp, code, 'utf8'); } catch (err) {
      return resolve({ ok: false, reason: 'tmp-failed', message: '临时文件写入失败: ' + err.message });
    }
    pyEnvProgress('starting', '正在启动 Python…');
    const t0 = Date.now();
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const proc = spawn(v.venvPython, [tmp], {
      env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }),
      windowsHide: true
    });
    pyState.runProc = proc;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch (err) {} }, PYRUN_TIMEOUT_MS);
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      pyState.runProc = null;
      try { fs.unlinkSync(tmp); } catch (e2) {}
      resolve({ ok: false, reason: 'spawn-failed', message: 'Python 启动失败: ' + err.message });
    });
    proc.on('close', (exitCode) => {
      if (settled) return; settled = true; clearTimeout(timer);
      pyState.runProc = null;
      try { fs.unlinkSync(tmp); } catch (e2) {}
      resolve({
        ok: true, code: exitCode, stdout, stderr, timedOut,
        interpreter: v.venvPython, durationMs: Date.now() - t0
      });
    });
  });
});

ipcMain.handle('py-stop', () => {
  if (!pyState.runProc) return { ok: false, message: '没有正在运行的代码' };
  try { pyState.runProc.kill(); } catch (e) { return { ok: false, message: e.message }; }
  return { ok: true };
});

ipcMain.handle('py-install', async (e, pkg, mirrorKey, override) => {
  const clean = PyCore.sanitizePkg(pkg);
  if (!clean) return { ok: false, message: '非法包名: ' + pkg };
  if (pyState.installing) return { ok: false, message: '已有安装任务在进行，请等待完成' };
  const v = await ensureVenv(override);
  if (!v.ok) return v;
  pyState.installing = true;
  const send = (chunk) => { try { if (win && win.webContents) win.webContents.send('py-log', String(chunk)); } catch (e2) {} };
  const uv = await detectUv();
  const args = uv
    ? PyCore.buildUvInstallArgs(clean, v.venvPython, mirrorKey)
    : PyCore.buildPipInstallArgs(clean, mirrorKey);
  send((uv ? '[uv] ' : '[pip] ') + (uv ? 'uv ' : v.venvPython + ' ') + args.join(' ') + '\r\n');
  return await new Promise((resolve) => {
    const proc = spawn(uv ? 'uv' : v.venvPython, args, {
      env: Object.assign({}, process.env, { PYTHONUTF8: '1' }), windowsHide: true
    });
    let output = '', settled = false;
    const timer = setTimeout(() => { try { proc.kill(); } catch (e2) {} }, PYINSTALL_TIMEOUT_MS);
    proc.stdout.on('data', d => { output += d.toString('utf8'); send(d.toString('utf8')); });
    proc.stderr.on('data', d => { output += d.toString('utf8'); send(d.toString('utf8')); });
    proc.on('error', (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      pyState.installing = false;
      resolve({ ok: false, message: '安装进程启动失败: ' + err.message, output });
    });
    proc.on('close', (exitCode) => {
      if (settled) return; settled = true; clearTimeout(timer);
      pyState.installing = false;
      resolve({ ok: exitCode === 0, exitCode, output });
    });
  });
});

ipcMain.handle('py-uninstall', async (e, pkg, override) => {
  const clean = PyCore.sanitizePkg(pkg);
  if (!clean) return { ok: false, message: '非法包名: ' + pkg };
  const v = await ensureVenv(override);
  if (!v.ok) return v;
  return await new Promise((resolve) => {
    const proc = spawn(v.venvPython, PyCore.buildPipUninstallArgs(clean), {
      env: Object.assign({}, process.env, { PYTHONUTF8: '1' }), windowsHide: true
    });
    let output = '', settled = false;
    proc.stdout.on('data', d => { output += d.toString('utf8'); });
    proc.stderr.on('data', d => { output += d.toString('utf8'); });
    proc.on('error', (err) => { if (!settled) { settled = true; resolve({ ok: false, message: err.message }); } });
    proc.on('close', (exitCode) => {
      if (settled) return; settled = true;
      resolve({ ok: exitCode === 0, exitCode, output });
    });
  });
});

ipcMain.handle('py-list', async (e, override) => {
  const v = await ensureVenv(override);
  if (!v.ok) return { ok: false, message: v.message, packages: [] };
  const r = await execFileAsync(
    v.venvPython, ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'], 120 * 1000
  );
  try {
    const arr = JSON.parse((r.stdout || '[]').trim());
    return { ok: true, packages: arr.map(p => ({ name: p.name, version: p.version })) };
  } catch (err) {
    return { ok: false, message: '解析包列表失败: ' + (r.stderr || err.message), packages: [] };
  }
});
