// 第 10 段階：歩き方 A（従来）・B（接地主導）・ハイブリッドを同じ入力・同じカメラで撮る（Playwright。fetch + eval して page と O を渡す）。
// O = { host, tools, dir, w, h, touch, scenes: { 場所: [歩き始めてからのフレーム…] }, gaits }
// gait_test.js の場所で、歩き方ごとに毎回最初から同じ入力で動かし、指定のフレームで止めて撮る（連続の静止画）。
// 画像は O.dir/<場所>-<歩き方>-<n>.jpg。道具は O.tools（既定 http://localhost:5173）から読む
async (page, O = {}) => {
  const tools = O.tools ?? 'http://localhost:5173';
  const host = O.host ?? tools;
  const out = [];
  const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, hasTouch: !!O.touch, isMobile: !!O.touch });
  const p = await ctx.newPage();
  await p.goto(`${host}/aquarium.html?nosave&${Date.now()}`, { timeout: 120000 });
  await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  await p.evaluate(async (h) => {
    window.__aqua.help?.close?.();
    document.getElementById('help')?.classList.remove('show');
    for (const f of ['climb_helpers.js', 'ceiling_test.js', 'gait_test.js']) await fetch(h + '/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
  }, tools);
  for (const [scene, frames] of Object.entries(O.scenes ?? { flat: [20, 40, 60] })) {
    for (const gait of O.gaits ?? ['cycle', 'lead', 'hybrid']) {
      for (let s = 0; s < frames.length; s++) {
        await p.evaluate(([name, g, f]) => {
          const a = window.__aqua;
          const orig = a.step;
          let n = 0, go = false;
          a.step = (k, dt) => { if (go && n >= f) return; orig(k, dt); if (go) n++; };
          const h0 = window.__gtStartHook;
          window.__gtStartHook = () => { go = true; };
          try { __gt.run(name, g); } finally { a.step = orig; window.__gtStartHook = h0; }
          a.freeze = true;
          a.input.touchMove = { x: 0, y: 0 };
        }, [scene, gait, frames[s]]);
        await p.waitForTimeout(150);
        await p.screenshot({ path: `${O.dir}/${scene}-${gait}-${s + 1}.jpg`, type: 'jpeg', quality: 78 });
        await p.evaluate(() => { window.__aqua.freeze = false; });
      }
      out.push(`${scene} ${gait}`);
    }
  }
  await ctx.close();
  return out.join('\n');
}
