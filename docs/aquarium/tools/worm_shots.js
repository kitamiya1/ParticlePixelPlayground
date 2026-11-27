// ゴカイの PC・スマホ相当の確認と撮影（Playwright の browser_run_code_unsafe の filename で実行）。
// - PC（1280×800、キー）：口のそばに置く（__worm.approach。置くだけ）→ 本物のキー入力で E（挟む）→ S（下がる。暴れている・滑りそうな間は離す）
//   → 抜ける瞬間を続けて撮る → E を押したまま W で運ぶ → E を離して落とす → 地面で這う。ページのエラーを数える。
// - スマホ縦（390×844）・横（844×390）：CDP のタッチで「挟む」を押したまま左のスティックを下へ（2 本の指）。抜けるまで・運ぶ。
// 画像は globalThis.__over?.dir（既定 docs/aquarium/gokai）へ。既にある画像は上書きしない（out_guard.js）。
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: 'D:/AI-Projects/ParticlePixelPlayground/docs/aquarium/gokai' }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch(`${O.host}/docs/aquarium/tools/out_guard.js`)).text())(O);
  const browser = page.context().browser();
  const out = {};
  const open = async (p) => {
    await p.goto(`${O.host}/aquarium.html?nosave&${Date.now()}`, { timeout: 120000 });
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 240000 });
    await p.evaluate(async (h) => {
      for (const f of ['worm_helpers.js']) await fetch(`${h}/docs/aquarium/tools/${f}?${Date.now()}`).then((r) => r.text()).then(eval);
      window.__aqua.help?.close?.();
      document.getElementById('help')?.classList.remove('show');
    }, O.host);
    await p.waitForTimeout(300);
  };
  const shot = async (p, name) => p.screenshot({ path: await shotPath(`${O.dir}/${name}.jpg`), type: 'jpeg', quality: 85 });
  const run = async (p, ms) => { await p.evaluate(() => (window.__aqua.freeze = false)); await p.waitForTimeout(ms); };
  const st = (p) => p.evaluate(() => {
    const A = window.__aqua, w = window.__worm.w, G = A.grab;
    return { grab: G.state, held: w.held, anchored: w.anchored, nb: w.nb, ext: +w.ext.toFixed(3), stage: w.stage, life: w.life, load: +G.load.toFixed(2), warn: +G.warn.toFixed(2), found: w.found, tumbles: A.crab.tumbles, slips: G.stats.creatureSlips, fps: Math.round(A.fps) };
  });
  const place = (p) => p.evaluate(() => { const W = window.__worm; W.pick(0); W.reset(); const r = W.approach(0.5, 0.4); window.__aqua.freeze = false; document.getElementById('place-banner')?.classList.remove('show'); return r; });
  /** 抜けるまで引く（暴れている・滑りそうな間は下がるのを止める）。down / up = 下がる入力の開始・終了 */
  const pullUntilPop = async (p, down, up, name, onMid) => {
    const t0 = Date.now();
    let on = false, mid = false, late = false;
    while (Date.now() - t0 < 16000) {
      const s = await p.evaluate(() => ({ env: window.__worm.w.env, warn: window.__aqua.grab.warn, held: window.__worm.w.held, anchored: window.__worm.w.anchored, ext: window.__worm.w.ext, stage: window.__worm.w.stage }));
      if (!s.anchored || !s.held) break;
      const want = !(s.env > 0.45 || s.warn > 0.25);
      if (want && !on) await down();
      if (!want && on) await up();
      on = want;
      if (!mid && s.ext > 0.4) { mid = true; await onMid?.('mid'); await shot(p, `${name}-3-pulling`); }
      if (!late && s.stage === 'late') { late = true; await shot(p, `${name}-4-late`); }
      await p.waitForTimeout(30);
    }
    if (on) await up();
    return Date.now() - t0;
  };

  // ---------------- PC ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await open(p);
    const pc = {};
    pc.place = await place(p);
    await run(p, 500);
    pc.peek = await st(p);
    await shot(p, 'pc-1-peek');
    await p.keyboard.down('KeyE');
    await run(p, 500);
    pc.grabbed = await st(p);
    await shot(p, 'pc-2-grab');
    await run(p, 2000);
    pc.holdOnly2s = await st(p);
    pc.pullMs = await pullUntilPop(p, () => p.keyboard.down('KeyS'), () => p.keyboard.up('KeyS'), 'pc');
    // 抜けた瞬間から続けて
    for (let i = 0; i < 6; i++) { await shot(p, `pc-5-pop-${i}`); await p.waitForTimeout(60); }
    pc.popped = await st(p);
    // 挟んだまま運ぶ（W）
    await p.keyboard.down('KeyW');
    await run(p, 1200);
    await p.keyboard.up('KeyW');
    pc.carried = await st(p);
    await shot(p, 'pc-6-carry');
    await p.keyboard.up('KeyE');
    await run(p, 1500);
    pc.dropped = await st(p);
    await shot(p, 'pc-7-dropped');
    await run(p, 3000);
    pc.crawl = await st(p);
    await shot(p, 'pc-8-crawl');
    pc.errors = errs;
    out.pc = pc;
    await ctx.close();
  }

  // ---------------- スマホ ----------------
  for (const [name, w, h] of [['portrait', 390, 844], ['landscape', 844, 390]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await open(p);
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) });
    const r = {};
    r.place = await place(p);
    await run(p, 500);
    r.peek = await st(p);
    r.ready = await p.evaluate(() => document.querySelector('#touch-ui .grab')?.classList.contains('ready') ?? null);
    const c = async (sel) => p.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, sel);
    const grabB = await c('#touch-ui .grab'), stickB = await c('#touch-ui .stick');
    const sp = `sp-${name}`;
    await shot(p, `${sp}-1-peek`);
    await touch('touchStart', [[grabB[0], grabB[1], 1]]);
    await run(p, 500);
    r.grabbed = await st(p);
    await touch('touchStart', [[grabB[0], grabB[1], 1], [stickB[0], stickB[1], 2]]);
    r.pullMs = await pullUntilPop(p, () => touch('touchMove', [[grabB[0], grabB[1], 1], [stickB[0], stickB[1] + 44, 2]]), () => touch('touchMove', [[grabB[0], grabB[1], 1], [stickB[0], stickB[1], 2]]), sp);
    await shot(p, `${sp}-5-pop`);
    r.popped = await st(p);
    // 運ぶ：スティックを上へ
    await touch('touchMove', [[grabB[0], grabB[1], 1], [stickB[0], stickB[1] - 44, 2]]);
    await run(p, 1000);
    await touch('touchEnd', [[stickB[0], stickB[1], 2]]);
    r.carried = await st(p);
    await shot(p, `${sp}-6-carry`);
    await touch('touchEnd', [[grabB[0], grabB[1], 1]]);
    await run(p, 300);
    // 「挟む」はスイッチ（たたくと閉じ、もう一度で開く）：まだ挟んでいれば、もう一度たたいて離す
    if ((await st(p)).held) {
      await touch('touchStart', [[grabB[0], grabB[1], 1]]);
      await p.waitForTimeout(80);
      await touch('touchEnd', [[grabB[0], grabB[1], 1]]);
    }
    await run(p, 1500);
    r.dropped = await st(p);
    await shot(p, `${sp}-7-dropped`);
    r.errors = errs;
    out[name] = r;
    await ctx.close();
  }
  return out;
}
