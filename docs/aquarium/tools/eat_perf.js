// 食事（AquaEat）の処理の重さ（Playwright の browser_run_code_unsafe の filename で実行）。
// PC（1280×800）とスマホ相当（390×844・タッチ・CPU 4 倍遅く）で、1 フレームの処理（__aqua.step(1) の時間）を 3 つの場面で測る：
//   idle = 何も挟まずに止まっている、chew = ゴカイを食べている（口元へ運ぶ・顎脚・手伝う鋏・食べかす）、
//   regrow = 藻を 3 か所むしった後（生え戻りの待ち）でエビを食べている。あわせて実際のフレーム間隔（rAF）の平均 / 95%
async (page) => {
  const host = (globalThis.__over ?? {}).host ?? 'http://localhost:5173';
  const browser = page.context().browser();
  const out = {};
  for (const [name, opt, rate] of [['pc', { viewport: { width: 1280, height: 800 } }, 1], ['sp', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }, 4]]) {
    const ctx = await browser.newContext(opt);
    const p = await ctx.newPage();
    await p.goto(`${host}/aquarium.html?nosave&${Date.now()}`, { timeout: 120000 });
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 240000 });
    await p.evaluate(async (h) => {
      await fetch(`${h}/docs/aquarium/tools/eat_helpers.js?${Date.now()}`).then((r) => r.text()).then(eval);
      window.__aqua.help?.close?.();
      window.__aqua.uiPrefs.set({ footDiag: false, gait: 'hybrid' });
    }, host);
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    const measure = () => p.evaluate(async () => {
      const A = window.__aqua;
      // 処理（tick）の時間：20 フレーム × 6 回
      const ts = [];
      for (let k = 0; k < 6; k++) {
        const t0 = performance.now();
        A.freeze = false;
        A.step(20);
        A.freeze = true;
        ts.push((performance.now() - t0) / 20);
      }
      // 実際のフレーム間隔（2 秒）
      A.freeze = false;
      const gaps = [];
      let last = performance.now();
      await new Promise((res) => {
        const f = (now) => {
          gaps.push(now - last);
          last = now;
          if (gaps.length < 120) requestAnimationFrame(f);
          else res();
        };
        requestAnimationFrame(f);
      });
      gaps.sort((a, b) => a - b);
      return { tickMs: +(ts.reduce((s, v) => s + v, 0) / ts.length).toFixed(2), frameAvg: +(gaps.reduce((s, v) => s + v, 0) / gaps.length).toFixed(1), frame95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1), phase: A.eat.phase };
    });
    const r = {};
    await p.evaluate(() => { window.__eat.reset(); window.__aqua.goto('spawn'); window.__aqua.freeze = false; window.__aqua.step(30); });
    r.idle = await measure();
    await p.evaluate(() => { window.__eat.setup('worm', 'R'); window.__aqua.dig = true; window.__aqua.freeze = false; window.__aqua.step(40); });
    r.chew = await measure();
    await p.evaluate(() => {
      const E = window.__eat, A = window.__aqua;
      for (let i = 0; i < 3; i++) { E.setup('algae', 'R'); E.eat(3); }
      let s = E.setup('shrimp', 'R');
      for (let t = 0; t < 2 && !s.held; t++) s = E.setup('shrimp', 'R');
      A.dig = true;
      A.freeze = false;
      A.step(40);
      return A.algae.pending;
    });
    r.regrow = await measure();
    r.algaePending = await p.evaluate(() => window.__aqua.algae.pending);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    out[name] = r;
    await ctx.close();
  }
  return JSON.stringify(out);
}
