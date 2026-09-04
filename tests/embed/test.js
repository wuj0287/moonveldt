const fs = require('fs');

// 复刻 index.html 的 embedLocalImages（loader 换成 fs）
const IMG_MIME = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', bmp:'image/bmp', ico:'image/x-icon', avif:'image/avif' };
function isAbsWinPath(p){ return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p); }
async function embed(src, dir){
  let embedded = 0; const skipped = [];
  const re = /!\[([^\]]*)\]\(([^)]*)\)/g;
  const jobs = []; let m;
  while ((m = re.exec(src)) && jobs.length < 60) jobs.push({ alt:m[1], raw:m[2].trim(), idx:m.index, len:m[0].length });
  let out = '', last = 0;
  for (const j of jobs) {
    out += src.slice(last, j.idx); last = j.idx + j.len;
    const orig = src.slice(j.idx, last);
    let t = j.raw;
    if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) || (t.startsWith("'") && t.endsWith("'") && t.length > 1)) t = t.slice(1, -1);
    else { const tm = /^(.*?)\s+["'][^"']*["']\s*$/.exec(t); if (tm) t = tm[1].trim(); }
    if (/^(data:|https?:|\/\/)/i.test(t)) { out += orig; continue; }
    let p = t;
    if (!isAbsWinPath(p)) {
      if (!dir) { skipped.push(t + '（无基准目录）'); out += orig; continue; }
      p = dir.replace(/[\\/]$/, '') + '/' + p.replace(/\\/g, '/');
    }
    const ext = (p.split('.').pop() || '').toLowerCase();
    const mi = IMG_MIME[ext];
    if (!mi) { skipped.push(t); out += orig; continue; }
    try {
      const b = fs.readFileSync(p);
      if (b.length > 15 * 1024 * 1024) { skipped.push(t); out += orig; continue; }
      embedded++;
      out += '![' + j.alt + '](data:' + mi + ';base64,' + b.toString('base64') + ')';
    } catch (e) { skipped.push(t); out += orig; }
  }
  out += src.slice(last);
  return { text: out, embedded, skipped };
}

(async () => {
  const dir = __dirname;
  const src = [
    '![绝对反斜杠](D:\\pics\\a.png)',
    '![绝对正斜杠](D:/pics/b.png)',
    '![相对路径](red.png)',
    '![带空格相对](green.png)',
    '![http](https://example.com/x.png)',
    '![data](data:image/png;base64,AAAA)',
    '![缺失文件](nope.png)',
    '![带标题](red.png "标题")',
    '![带引号空格]("green.png")'
  ].join('\n\n');
  const r = await embed(src, dir);
  console.log('--- 转换后各行(前90字符) ---');
  r.text.split('\n\n').forEach((l, i) => console.log(i + ':', l.slice(0, 90)));
  console.log('--- skipped ---', JSON.stringify(r.skipped));
  const checks = {
    '相对路径已内嵌': /!\[相对路径\]\(data:image\/png;base64,/.test(r.text),
    '带空格相对已内嵌': /!\[带空格相对\]\(data:image\/png;base64,/.test(r.text),
    '带标题已内嵌': /!\[带标题\]\(data:image\/png;base64,/.test(r.text),
    '带引号空格已内嵌': /!\[带引号空格\]\(data:image\/png;base64,/.test(r.text),
    '假绝对路径保留原样': /D:\\pics/.test(r.text) || /D:\\pics/.test(r.text),
    'http 引用保留': /https:\/\/example\.com/.test(r.text),
    'data URI 保留': /;base64,AAAA/.test(r.text),
    '缺失文件引用保留': /nope\.png/.test(r.text)
  };
  let all = true;
  Object.keys(checks).forEach(k => { const v = checks[k]; if (!v) all = false; console.log((v ? 'OK ' : 'ERR') + ' ' + k); });
  const ok = r.embedded === 4 && all;
  console.log(ok ? '\n✅ 单元测试通过' : '\n❌ 单元测试失败');
  process.exit(ok ? 0 : 1);
})();
