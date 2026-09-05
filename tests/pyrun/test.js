/* Moonveldt v1.9.0 pyrun-core 纯逻辑单测（node 直接跑，无 Electron 依赖） */
'use strict';
const Py = require('../../pyrun-core');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

console.log('== parseMissingModules ==');
ok(JSON.stringify(Py.parseMissingModules(
  "Traceback (most recent call last):\n  File \"t.py\", line 1, in <module>\n    import pandas\nModuleNotFoundError: No module named 'pandas'"
)) === JSON.stringify(['pandas']), '单包提取');
ok(JSON.stringify(Py.parseMissingModules(
  "ModuleNotFoundError: No module named 'a.b.c'\nModuleNotFoundError: No module named 'pandas'\nModuleNotFoundError: No module named 'a.x'"
)) === JSON.stringify(['a', 'pandas']), '子模块取顶级+去重');
ok(Py.parseMissingModules('some random error text').length === 0, '无匹配返回空');
ok(JSON.stringify(Py.parseMissingModules(
  "ModuleNotFoundError: No module named 'langchain_core'"
)) === JSON.stringify(['langchain_core']), '下划线包名');

console.log('== pipNameFor ==');
ok(Py.pipNameFor('cv2') === 'opencv-python', 'cv2 -> opencv-python');
ok(Py.pipNameFor('PIL') === 'pillow', 'PIL -> pillow');
ok(Py.pipNameFor('sklearn') === 'scikit-learn', 'sklearn -> scikit-learn');
ok(Py.pipNameFor('pandas') === 'pandas', '普通名透传');

console.log('== sanitizePkg ==');
ok(Py.sanitizePkg('requests') === 'requests', '合法包名');
ok(Py.sanitizePkg('pandas==2.2.3') === 'pandas==2.2.3', '带版本');
ok(Py.sanitizePkg('langchain>=0.2,<1.0') === 'langchain>=0.2,<1.0', '版本区间');
ok(Py.sanitizePkg('uvicorn[standard]') === 'uvicorn[standard]', 'extras');
ok(Py.sanitizePkg('a-b_c.d1') === 'a-b_c.d1', '合法字符组合');
ok(Py.sanitizePkg('x; rm -rf /') === null, '拒绝分号注入');
ok(Py.sanitizePkg('x && calc') === null, '拒绝 &&');
ok(Py.sanitizePkg('../evil') === null, '拒绝路径穿越');
ok(Py.sanitizePkg('') === null, '拒绝空串');
ok(Py.sanitizePkg(' x ') === 'x', 'trim 空白');
ok(Py.sanitizePkg('x y') === null, '拒绝空格');
ok(Py.sanitizePkg('-lead') === null, '拒绝前导连字符');
ok(Py.sanitizePkg(123) === null, '拒绝非字符串');

console.log('== buildPipInstallArgs ==');
const pipArgs = Py.buildPipInstallArgs('pandas', 'tsinghua');
ok(Array.isArray(pipArgs) && pipArgs[0] === '-m' && pipArgs[1] === 'pip' && pipArgs[2] === 'install', 'pip 参数结构');
ok(pipArgs.includes('https://pypi.tuna.tsinghua.edu.cn/simple'), '清华镜像');
ok(pipArgs[pipArgs.length - 1] === 'https://pypi.tuna.tsinghua.edu.cn/simple' && pipArgs[pipArgs.length - 2] === '-i', '-i 镜像位于末尾');
const pipOff = Py.buildPipInstallArgs('x', 'official');
ok(pipOff.includes('https://pypi.org/simple'), '官方源');
const pipAli = Py.buildPipInstallArgs('x', 'aliyun');
ok(pipAli.includes('https://mirrors.aliyun.com/pypi/simple/'), '阿里云镜像');

console.log('== buildUvInstallArgs ==');
const uvArgs = Py.buildUvInstallArgs('six', 'C:/venv/Scripts/python.exe', 'tsinghua');
ok(uvArgs[0] === 'pip' && uvArgs[1] === 'install', 'uv 参数结构');
ok(uvArgs.includes('C:/venv/Scripts/python.exe'), '--python 指向 venv');
ok(uvArgs.includes('https://pypi.tuna.tsinghua.edu.cn/simple'), 'uv 走镜像');
ok(uvArgs[uvArgs.length - 1] === 'six', '包名在末尾');

console.log('== buildPipUninstallArgs ==');
const unArgs = Py.buildPipUninstallArgs('six');
ok(unArgs.join(' ') === '-m pip uninstall -y six', '卸载参数');

console.log('== djb2 ==');
ok(Py.djb2('abc') === Py.djb2('abc'), '同串同 hash');
ok(Py.djb2('abc') !== Py.djb2('abd'), '异串异 hash');
ok(/^[0-9a-z]+$/.test(Py.djb2('中文测试')), '中文可 hash 且 base36');

console.log('== mirrorUrl ==');
ok(Py.mirrorUrl('unknown') === Py.MIRRORS.tsinghua, '未知 key 回落清华');

console.log('\n结果: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
