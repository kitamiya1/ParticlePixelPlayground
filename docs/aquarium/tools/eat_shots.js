// 食事（AquaEat）の本物の入力での確認と撮影（Playwright の browser_run_code_unsafe の filename で実行）。
// - PC（1280×800、キー）：カニの前にゴカイ（抜けた後の体）を横たえ、E で挟む → F で食べる → F を離して中断 → F で続き → 食べ切る
// - ゲームパッド（仮想のパッド：navigator.getGamepads を差し替え）：LT（左のハサミ）で挟む → X / □ で食べる
// - スマホ縦（390×844、タッチ）：「挟む」をたたく → 「掘る」ボタンが「食べる」の絵になる → 押している間 食べる → 離して中断 → 「挟む」で落とす
// - 保存と再起動（?nosave なし・新しい文脈）：エビを途中まで食べて落とす・ゴカイを食べ切る → 保存 → 開き直す → 栄養・食べかけ・消えた個体
// - 撮影：種類ごとに口元へ運んで噛んでいる所（斜め前から）。1 口の中の顎脚の開閉の連続
// 画像は globalThis.__over?.dir（既定 docs/aquarium/eat）へ。既にある画像は上書きしない（out_guard.js）。
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: 'D:/AI-Projects/ParticlePixelPlayground/docs/aquarium/eat' }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch(`${O.host}/docs/aquarium/tools/out_guard.js`)).text())(O);
  const browser = page.context().browser();
  const out = {};
  const open = async (p, q = '?nosave') => {
    await p.goto(`${O.host}/aquarium.html${q}${q ? '&' : '?'}${Date.now()}`, { timeout: 120000 });
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 240000 });
    await p.evaluate(async (h) => {
      for (const f of ['eat_helpers.js']) await fetch(`${h}/docs/aquarium/tools/${f}?${Date.now()}`).then((r) => r.text()).then(eval);
      window.__aqua.help?.close?.();
      document.getElementById('help')?.classList.remove('show');
      window.__aqua.uiPrefs.set({ footDiag: false, gait: 'hybrid' });
    }, O.host);
    await p.waitForTimeout(300);
  };
  const shot = async (p, name) => p.screenshot({ path: await shotPath(`${O.dir}/${name}.jpg`), type: 'jpeg', quality: 88 });
  const run = async (p, ms) => {
    await p.evaluate(() => (window.__aqua.freeze = false));
    await p.waitForTimeout(ms);
  };
  const st = (p) => p.evaluate(() => {
    const A = window.__aqua, E = A.eat, f = E.food;
    return { phase: E.phase, side: E.side, food: f?.name ?? null, left: f ? +f.left.toFixed(2) : null, feedW: +E.feedW.toFixed(2), nutrition: +E.nutrition.total.toFixed(2), R: A.grab.state, L: A.grabL.state, held: A.grab.held?.name ?? A.grabL.held?.name ?? null, bites: E.stats.bites, fps: Math.round(A.fps) };
  });
  /** カニの前にゴカイを横たえる（抜けた後の体）。カメラは斜め前から */
  const layWorm = (p, i = 0) => p.evaluate((k) => {
    const A = window.__aqua, c = A.crab;
    A.goto('spawn');
    A.freeze = false;
    A.step(30);
    // （食べられていない個体。隙間の中なら外へ出して横たえる）
    const W = A.worms.worms.find((w) => !w.gone && w.life !== 'dead' && w.nb === 0) ?? A.worms.worms.find((w) => !w.gone && w.life !== 'dead') ?? A.worms.worms[k];
    const h = c.heading, fx = Math.sin(h), fz = Math.cos(h);
    W.layFree(c.x + fx * 0.42 - Math.cos(h) * 0.06, c.y + 0.3, c.z + fz * 0.42 + Math.sin(h) * 0.06, h + Math.PI / 2);
    W.found = true;
    A.step(10);
    return W.id;
  }, i);
  const front = (p, off = 0.55, zoom = 1.4, pitch = 0.1) => p.evaluate(([o, z, pt]) => {
    const A = window.__aqua, cam = A.camera;
    A.setView('classic');
    cam.adventure.yaw = A.crab.heading + o;
    cam.adventure.zoom = z;
    cam.adventure.pitch = pt;
    document.getElementById('place-banner')?.classList.remove('show');
    document.getElementById('view-toast')?.classList.remove('show');
  }, [off, zoom, pitch]);

  // ---------------- PC（キー） ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await open(p);
    const pc = {};
    pc.worm = await layWorm(p);
    await front(p);
    await run(p, 300);
    await p.keyboard.down('KeyE');
    await run(p, 700);
    pc.grabbed = await st(p);
    await shot(p, 'pc-1-grab');
    await p.keyboard.down('KeyF');
    await run(p, 450);
    pc.bring = await st(p);
    await shot(p, 'pc-2-bring');
    // 1 口の中の連続（顎脚が開く → 噛み取る → ちぎる）
    for (let i = 0; i < 6; i++) {
      await p.waitForTimeout(90);
      await shot(p, `pc-3-chew-${i}`);
    }
    await run(p, 1500);
    pc.chew = await st(p);
    await p.keyboard.up('KeyF');
    await run(p, 700);
    pc.stopped = await st(p);
    await shot(p, 'pc-4-stopped');
    await p.keyboard.down('KeyF');
    await run(p, 300);
    pc.resumed = await st(p);
    const t0 = Date.now();
    let mid = false;
    while (Date.now() - t0 < 14000) {
      const s = await st(p);
      if (!mid && s.left !== null && s.left < 0.45) {
        mid = true;
        await shot(p, 'pc-5-half');
      }
      if (s.phase === 'idle' || s.phase === 'back') break;
      await p.waitForTimeout(100);
    }
    pc.resumeMs = Date.now() - t0;
    await run(p, 400);
    pc.finished = await st(p);
    await shot(p, 'pc-6-finished');
    await p.keyboard.up('KeyF');
    await p.keyboard.up('KeyE');
    await run(p, 400);
    pc.hud = await p.evaluate(() => ({ nut: document.getElementById('h-nutn')?.textContent, shown: !document.getElementById('h-nutc')?.classList.contains('off') }));
    pc.errors = errs;
    out.pc = pc;

    // ---------------- ゲームパッド（同じページ。仮想のパッド） ----------------
    const gp = {};
    await p.evaluate(() => {
      const pad = { index: 0, id: 'Virtual pad (STANDARD GAMEPAD)', connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })), timestamp: 0 };
      navigator.getGamepads = () => [pad];
      window.__pad = pad;
      window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad }));
    });
    const btn = (i, on) => p.evaluate(([k, v]) => { const b = window.__pad.buttons[k]; b.pressed = v; b.value = v ? 1 : 0; window.__pad.timestamp++; }, [i, on]);
    // 左のハサミの構えの先にゴカイを置く
    gp.worm = await layWorm(p);
    await p.evaluate((id) => {
      const A = window.__aqua, c = A.crab, W = A.worms.worms.find((w) => w.id === id);
      A.freeze = false;
      A.step(2);
      const an = A.rig.left.anchor;
      W.layFree(an[0], c.y + 0.3, an[2], c.heading + Math.PI / 2);
      A.step(5);
    }, gp.worm);
    await front(p, -0.6);
    await btn(6, true);
    await run(p, 700);
    gp.grabbed = await st(p);
    await btn(2, true);
    await run(p, 2200);
    gp.eating = await st(p);
    await shot(p, 'pad-1-left-claw');
    await btn(2, false);
    await run(p, 500);
    gp.stopped = await st(p);
    await btn(6, false);
    await run(p, 500);
    gp.dropped = await st(p);
    gp.pad = await p.evaluate(() => window.__aqua.pad.describe());
    out.pad = gp;
    await ctx.close();
  }

  // ---------------- スマホ縦（タッチ） ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await open(p);
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) });
    const ctr = (sel) => p.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, sel);
    const digCls = () => p.evaluate(() => ({ cls: document.querySelector('#touch-ui .dig')?.className, label: document.querySelector('#touch-ui .dig')?.dataset.label }));
    const sp = {};
    sp.worm = await layWorm(p);
    await front(p, 0.55, 1.6, 0.15);
    await run(p, 300);
    sp.digBefore = await digCls();
    const grabB = await ctr('#touch-ui .grab'), digB = await ctr('#touch-ui .dig');
    await touch('touchStart', [[grabB[0], grabB[1], 1]]);
    await p.waitForTimeout(60);
    await touch('touchEnd', [[grabB[0], grabB[1], 1]]);
    await run(p, 700);
    sp.grabbed = await st(p);
    sp.digHolding = await digCls();
    await touch('touchStart', [[digB[0], digB[1], 3]]);
    await run(p, 2500);
    sp.eating = await st(p);
    await shot(p, 'sp-1-eating');
    await touch('touchEnd', [[digB[0], digB[1], 3]]);
    await run(p, 600);
    sp.stopped = await st(p);
    await touch('touchStart', [[grabB[0], grabB[1], 1]]);
    await p.waitForTimeout(60);
    await touch('touchEnd', [[grabB[0], grabB[1], 1]]);
    await run(p, 600);
    sp.dropped = await st(p);
    sp.digAfter = await digCls();
    await shot(p, 'sp-2-dropped');
    sp.errors = errs;
    out.sp = sp;
    await ctx.close();
  }

  // ---------------- 保存と再起動 ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await open(p, '');
    const before = await p.evaluate(async () => {
      const A = window.__aqua, E = window.__eat;
      // エビを途中まで食べて落とす
      let s = E.setup('shrimp', 'R');
      for (let t = 0; t < 2 && !s.held; t++) s = E.setup('shrimp', 'R');
      const b = A.lifeGrabR.held?.c;
      E.eat(2.2);
      E.release(120);
      const shrimp = b ? { i: A.life.shrimp.indexOf(b), left: +b.eat.left.toFixed(3), x: +b.x.toFixed(2), y: +b.y.toFixed(2), z: +b.z.toFixed(2) } : null;
      // ゴカイを 1 匹食べ切る・もう 1 匹を途中まで
      E.setup('worm', 'R');
      const W1 = E.setups.W;
      E.eat(14);
      E.setup('worm', 'R');
      const W2 = E.setups.W;
      E.eat(3);
      E.release(60);
      const n = A.eat.nutrition.toSave();
      const ok = await A.save.saver.flush();
      return { ok, shrimp, w1: { id: W1.id, gone: W1.gone }, w2: { id: W2.id, left: +W2.left.toFixed(3), life: W2.life, x: +W2.x[0].toFixed(2), z: +W2.x[2].toFixed(2) }, n: { total: +n.total.toFixed(3), eaten: n.eaten } };
    });
    await open(p, '');
    const after = await p.evaluate((B) => {
      const A = window.__aqua, n = A.eat.nutrition.toSave();
      const b = B.shrimp ? A.life.shrimp[B.shrimp.i] : null;
      const w1 = A.worms.worms.find((w) => w.id === B.w1.id), w2 = A.worms.worms.find((w) => w.id === B.w2.id);
      return {
        status: A.save.loaded.status, version: A.save.loaded.data?.version, n: { total: +n.total.toFixed(3), eaten: n.eaten },
        shrimp: b?.eat ? { left: +b.eat.left.toFixed(3), gone: b.eat.gone, x: +b.x.toFixed(2), y: +b.y.toFixed(2), z: +b.z.toFixed(2) } : null,
        w1: w1 ? { gone: w1.gone } : null, w2: w2 ? { left: +w2.left.toFixed(3), life: w2.life, x: +w2.x[0].toFixed(2), z: +w2.x[2].toFixed(2), grabbable: w2.grabbable() } : null,
        hud: document.getElementById('h-nutn')?.textContent,
      };
    }, before);
    // 残りを拾って食べ切れるか（読み込み直した食べかけのゴカイ）
    after.resumeWorm = await p.evaluate((id) => {
      const A = window.__aqua, W = A.worms.worms.find((w) => w.id === id);
      if (!W) return null;
      const G = A.grab;
      A.hold = true;
      G.release();
      G.state = 'holding';
      G.creature = W;
      G.close = 1;
      W.gS = 1;
      W.gF = 0.5;
      W.onGrab();
      const r = window.__eat.eat(10);
      A.hold = false;
      return { bites: r.bites, gone: W.gone };
    }, before.w2.id);
    out.save = { before, after, errors: errs };
    await ctx.close();
  }

  // ---------------- 撮影：種類ごと ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await open(p);
    const g = {};
    for (const [k, sd, off] of [['algae', 'R', 0.6], ['plant', 'R', 0.6], ['shrimp', 'R', 0.55], ['fish', 'L', -0.55], ['worm', 'R', 0.55], ['pebble', 'R', 0.55]]) {
      const r = await p.evaluate(([kk, s]) => {
        const E = window.__eat;
        let x = E.setup(kk, s);
        for (let t = 0; t < 2 && !x.held; t++) x = E.setup(kk, s);
        window.__aqua.dig = true;
        window.__aqua.freeze = false;
        window.__aqua.step(kk === 'pebble' ? 26 : 50);
        return x.held;
      }, [k, sd]);
      await front(p, off);
      await p.evaluate(() => { window.__aqua.freeze = false; window.__aqua.step(12); window.__aqua.freeze = true; });
      g[k] = { held: r, ...(await st(p)) };
      await shot(p, `kind-${k}`);
      await p.evaluate(() => { window.__aqua.dig = false; window.__eat.reset(); });
    }
    out.gallery = g;
    await ctx.close();
  }
  return JSON.stringify(out);
}
