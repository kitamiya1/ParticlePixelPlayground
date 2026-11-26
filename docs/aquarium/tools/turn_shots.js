// 第 9 段階：方向転換の比較の撮影。場面 × 方式ごとに、3 フレームに 1 枚（20 枚 / 秒）キャンバスを JPEG にして受け取りサーバー（:5199）へ送る
async (page) => {
  const O = globalThis.__cap ?? {};
  const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 480, height: O.h ?? 300 } });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:5173/aquarium.html?nosave&${Date.now()}`, { timeout: 120000 });
  await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  await p.evaluate(async () => {
    window.__aqua.help?.close?.();
    document.getElementById('help')?.classList.remove('show');
    for (const f of ['climb_helpers.js', 'turn_test.js']) await fetch('/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
  });
  const names = await p.evaluate(() => Object.keys(__tn.scenes));
  const out = [];
  for (const idx of O.scenes ?? names.map((_, i) => i)) {
    for (const mode of O.modes ?? ['A', 'B', 'C', 'D']) {
      const n = await p.evaluate(async ([name, mode, idx, every, maxF]) => {
        const cv = document.querySelector('canvas');
        const frames = [];
        const res = __tn.run(name, mode, { onFrame: (i) => { if (i % every === 0 && frames.length < maxF) frames.push(cv.toDataURL('image/jpeg', 0.86)); } });
        for (let i = 0; i < frames.length; i++) await fetch(`http://127.0.0.1:5199/save?f=s${idx}/${mode}/${String(i).padStart(3, '0')}.jpg`, { method: 'POST', body: frames[i] });
        await fetch(`http://127.0.0.1:5199/save?f=s${idx}/${mode}/metrics.json`, { method: 'POST', body: 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify(res)))) });
        return frames.length;
      }, [names[idx], mode, idx, O.every ?? 3, O.maxF ?? 9999]);
      out.push(`${idx} ${names[idx]} ${mode} ${n}`);
    }
  }
  await ctx.close();
  return out.join('\n');
}
