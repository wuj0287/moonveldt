/* wwj Python 运行通道 - 纯逻辑（主进程 require / 渲染层 <script> / node 单测 三端共用） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PyRunCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* pip 镜像源 */
  var MIRRORS = {
    tsinghua: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    aliyun: 'https://mirrors.aliyun.com/pypi/simple/',
    official: 'https://pypi.org/simple'
  };
  function mirrorUrl(key) { return MIRRORS[key] || MIRRORS.tsinghua; }

  /* 从 traceback 里提取缺失模块的"顶级包名"（'a.b.c' -> 'a'），去重保序 */
  function parseMissingModules(text) {
    var re = /ModuleNotFoundError: No module named '([A-Za-z0-9_.-]+)'/g;
    var seen = {}, out = [], m;
    while ((m = re.exec(text))) {
      var top = m[1].split('.')[0];
      if (!seen[top]) { seen[top] = 1; out.push(top); }
    }
    return out;
  }

  /* import 名 -> pip 包名差异映射（仅高频项，其余透传） */
  var IMPORT_TO_PKG = {
    cv2: 'opencv-python', PIL: 'pillow', sklearn: 'scikit-learn',
    bs4: 'beautifulsoup4', yaml: 'pyyaml', dotenv: 'python-dotenv',
    fitz: 'pymupdf', Crypto: 'pycryptodome', docx: 'python-docx',
    pptx: 'python-pptx', serial: 'pyserial', win32com: 'pywin32',
    matplotlib: 'matplotlib', dateutil: 'python-dateutil'
  };
  function pipNameFor(importName) { return IMPORT_TO_PKG[importName] || importName; }

  /* 包名白名单校验（spawn 数组参数本无 shell 注入，这里挡误输入） */
  function sanitizePkg(pkg) {
    if (typeof pkg !== 'string') return null;
    pkg = pkg.trim();
    if (!pkg || pkg.length > 200) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*(\[[A-Za-z0-9_,.-]+\])?([=<>!~]+[A-Za-z0-9_.*+,<>=!~]*)?$/.test(pkg)) return null;
    return pkg;
  }

  /* venv 自带 pip 安装参数 */
  function buildPipInstallArgs(pkg, mirrorKey) {
    return ['-m', 'pip', 'install', pkg, '--disable-pip-version-check', '--no-input', '-i', mirrorUrl(mirrorKey)];
  }
  /* uv 加速安装参数（uv pip install --python <venvPython>） */
  function buildUvInstallArgs(pkg, venvPython, mirrorKey) {
    return ['pip', 'install', '--python', venvPython, '--index-url', mirrorUrl(mirrorKey), '--no-progress', pkg];
  }
  function buildPipUninstallArgs(pkg) { return ['-m', 'pip', 'uninstall', '-y', pkg]; }

  /* 稳定字符串 hash（输出面板与代码块关联用） */
  function djb2(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  return {
    MIRRORS: MIRRORS,
    mirrorUrl: mirrorUrl,
    parseMissingModules: parseMissingModules,
    pipNameFor: pipNameFor,
    sanitizePkg: sanitizePkg,
    buildPipInstallArgs: buildPipInstallArgs,
    buildUvInstallArgs: buildUvInstallArgs,
    buildPipUninstallArgs: buildPipUninstallArgs,
    djb2: djb2
  };
});
