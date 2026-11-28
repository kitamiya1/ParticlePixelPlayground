// ハサミ集中モード・積み木の処理の重さ（Playwright の browser_run_code_unsafe の filename で実行）。eat_perf.js と同じ測り方：
// PC（1280×800）とスマホ相当（390×844・タッチ・CPU 4 倍遅く）で、1 フレームの処理（__aqua.step(1) の時間）と実際のフレーム間隔（rAF）を
//   spawn   = 通常モード・出発点（比べる基準）
//   area    = 検証エリアで集中モード・何も挟まない
//   carry   = 左右の鋏で別々の積み木を挟んで、左右へ振り続ける（挟んだ箱・まわりの箱が起きている）
//   tower   = 積み木 5 段を同時に置いた直後（全部の箱が起きて接している）
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
      for (const f of ['focus_helpers', 'blocks_test']) await fetch(`${h}/docs/aquarium/tools/${f}.js?${Date.now()}`).then((r) => r.text()).then(eval);
      window.__aqua.help?.close?.();
    }, host);
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    // （each = 毎フレームの前に呼ぶ入力。carry では鋏を左右へ振り続ける）
    const measure = (scene) => p.evaluate(async (scene) => {
      const A = window.__aqua, X = window.__focus;
      let f = 0;
      const each = () => {
        f++;
        if (scene === 'carry') {
          const s = Math.sin(f / 20);
          X.ctl('R', { mx: s, my: 0 });
          X.ctl('L', { mx: s, my: 0 });
        }
      };
      const ts = [];
      for (let k = 0; k < 6; k++) {
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) {
          each();
          A.freeze = false;
          A.step(1, 1 / 60);
        }
        A.freeze = true;
        ts.push((performance.now() - t0) / 20);
      }
      A.freeze = false;
      const gaps = [];
      let last = performance.now();
      await new Promise((res) => {
        const g = (now) => {
          gaps.push(now - last);
          last = now;
          each();
          if (gaps.length < 120) requestAnimationFrame(g);
          else res();
        };
        requestAnimationFrame(g);
      });
      gaps.sort((a, b) => a - b);
      const awake = A.props.props.filter((q) => q.awake && q.box).length;
      return { tickMs: +(ts.reduce((s, v) => s + v, 0) / ts.length).toFixed(2), tickMax: +Math.max(...ts).toFixed(2), frameAvg: +(gaps.reduce((s, v) => s + v, 0) / gaps.length).toFixed(1), frame95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1), awakeBoxes: awake };
    }, scene);
    const r = {};
    await p.evaluate(() => { const A = window.__aqua; A.goto('spawn'); A.freeze = false; A.step(30); });
    r.spawn = await measure('spawn');
    await p.evaluate(() => window.__focus.setup());
    r.area = await measure('area');
    r.carryGrab = await p.evaluate(() => {
      const X = window.__focus;
      // 左右で別々の積み木を挟んで持ち上げる（claw_focus_test の twoObjects と同じ）
      const B = X.blocks('block');
      const R = X.grab('R', B[2]), L = X.grab('L', B[3]);
      X.lift('R', 0.06, 30);
      X.lift('L', 0.06, 30);
      return { R: R.ok, L: L.ok };
    });
    r.carry = await measure('carry');
    await p.evaluate(() => { const X = window.__focus; X.release(); X.ctl('R', { close: 0 }); X.ctl('L', { close: 0 }); X.run(30); window.__aqua.setFocus(false); });
    await p.evaluate(() => {
      const B = window.__blocks, A = window.__aqua, P = A.props;
      B.reset();
      const bl = A.blocks.filter((b) => b.kind === 'block'), F = P.props.find((q) => q.fixed), T = F.p[1] + F.semi[1];
      for (let i = 0; i < 5; i++) P.place(bl[i], [F.p[0] - 0.15, T + 0.051 + i * 0.1015, F.p[2] + 0.25], [0, 0, 0, 1]);
    });
    r.tower = await measure('tower');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    out[name] = r;
    await ctx.close();
  }
  return JSON.stringify(out);
}
