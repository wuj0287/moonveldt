// v1.8.2 冒烟：侧边栏拖拽调宽（最窄=230 默认，最宽=460=2x），记忆恢复
const { app, BrowserWindow } = require('electron');
const path = require('path');

require(path.join(__dirname, '..', '..', 'main.js'));

app.whenReady().then(() => {
  setTimeout(async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) { console.log('APP182_NO_WINDOW'); app.exit(2); return; }
      await new Promise(r => setTimeout(r, 800));
      const res = await win.webContents.executeJavaScript(`(async()=>{
        const out={};
        const sleep=ms=>new Promise(r=>setTimeout(r,ms));
        const sb=document.getElementById('sidebar');
        const rz=document.getElementById('side-resizer');
        out.resizerExists = !!rz;
        out.defWidth = sb.offsetWidth; // 默认 230
        // 模拟拖拽：mousedown 在把手，mousemove +120px，mouseup
        const startX=rz.getBoundingClientRect().left, startW=sb.offsetWidth;
        rz.dispatchEvent(new MouseEvent('mousedown',{clientX:startX,bubbles:true}));
        window.dispatchEvent(new MouseEvent('mousemove',{clientX:startX+120}));
        window.dispatchEvent(new MouseEvent('mouseup',{clientX:startX+120}));
        await sleep(50);
        out.dragTo350 = sb.offsetWidth; // ≈ 230+120=350
        out.dragWithinRange = out.dragTo350>=230 && out.dragTo350<=460;
        // 拖到极限远（+5000）→ 应被钳制到 460
        const sx=rz.getBoundingClientRect().left;
        rz.dispatchEvent(new MouseEvent('mousedown',{clientX:sx,bubbles:true}));
        window.dispatchEvent(new MouseEvent('mousemove',{clientX:sx+5000}));
        window.dispatchEvent(new MouseEvent('mouseup',{clientX:sx+5000}));
        await sleep(50);
        out.clampMax = sb.offsetWidth; // 应=460
        out.maxOk = out.clampMax===460;
        // 拖到极小（-5000）→ 应被钳制到 230
        const sx2=rz.getBoundingClientRect().left;
        rz.dispatchEvent(new MouseEvent('mousedown',{clientX:sx2,bubbles:true}));
        window.dispatchEvent(new MouseEvent('mousemove',{clientX:sx2-5000}));
        window.dispatchEvent(new MouseEvent('mouseup',{clientX:sx2-5000}));
        await sleep(50);
        out.clampMin = sb.offsetWidth; // 应=230
        out.minOk = out.clampMin===230;
        // 记忆持久化
        out.saved = localStorage.getItem('wwj.sidew');
        out.pass = out.resizerExists && out.defWidth===230
          && out.dragWithinRange && out.maxOk && out.minOk
          && !!out.saved;
        return out;
      })()`);
      console.log('APP182_RESULT ' + JSON.stringify(res, null, 2));
      app.exit(res && res.pass ? 0 : 3);
    } catch (e) { console.error('APP182_ERR', e); app.exit(1); }
  }, 1500);
});
