// 挟む（AquaGrab）の PC・スマホ相当の確認と撮影（Playwright。browser_run_code_unsafe の filename で実行）。
// - PC（1280×800・タッチなし）：本物のキー入力（E を押す・離す、WASD で歩く）で 挟む → 引く → 運ぶ → 離す を 3 回繰り返し、
//   届く物の案内「E 挟む」・HUD の表示・物の状態を調べて撮影する。重い石を引きずる・軽い物を持ち上げる・離して落ちた所も撮る。
// - スマホ（390×844 縦・844×390 横、タッチ）：CDP のタッチ入力で「挟む」ボタンを押したまま、左のスティックで歩き、
//   ボタンの上で指をずらして視点を回し、離す。ボタンどうしが重ならないか（矩形の交差）も調べる。
// 画像は globalThis.__over?.dir（既定 docs/aquarium/claw-grab）へ。?nosave で開く。
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: 'D:/AI-Projects/ParticlePixelPlayground/docs/aquarium/claw-grab' }, globalThis.__over ?? {});
  const out = {};
  const browser = page.context().browser();
  const open = async (p) => {
    await p.goto(`${O.host}/aquarium.html?nosave&${Date.now()}`);
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
    await p.evaluate(async (h) => {
      await fetch(h + '/docs/aquarium/tools/grab_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
      window.__aqua.help?.close?.();
      document.getElementById('help')?.classList.remove('show');
    }, O.host);
    await p.waitForTimeout(300);
  };
  const shot = (p, name) => p.screenshot({ path: `${O.dir}/${name}.png` });
  // 本物の時間で進める（requestAnimationFrame。凍結を解いて待つ）
  const run = async (p, ms) => {
    await p.evaluate(() => (window.__aqua.freeze = false));
    await p.waitForTimeout(ms);
  };
  const st = (p) => p.evaluate(() => {
    const A = window.__aqua, G = A.grab, pr = G.holding;
    return {
      grab: G.state, held: pr?.id ?? null, crab: A.crab.state, hud: document.getElementById('h-grab').classList.contains('off') ? null : document.getElementById('h-grab').textContent,
      hint: document.getElementById('grab-hint').classList.contains('show') ? document.getElementById('grab-hint').textContent : null,
      contact: pr ? +window.__aqua.props.surfaceDist(pr, ...A.rig.pinch).toFixed(3) : null,
      hGround: pr ? +(pr.p[1] - pr.semi[1] - A.world.contactSurfaceBelow(pr.p[0], pr.p[1], pr.p[2])).toFixed(3) : null,
      stats: { ...G.stats }, deep: A.props.stats.deep,
    };
  });

  // ---------------- PC ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await open(p);
    const pc = { touchUi: await p.evaluate(() => document.body.classList.contains('touch')) };
    // 小石の前へ（向き −x）、カメラは右前から
    await p.evaluate(() => { const g = window.__gr; g.reset(); g.settle(1); g.approach('pebble4', -Math.PI / 2); g.view(-0.9, 2.3, 0.3); });
    await run(p, 400);
    pc.hint = await st(p);
    await shot(p, 'pc-1-hint');
    const cycles = [];
    for (let i = 0; i < 3; i++) {
      await p.keyboard.down('KeyE');
      await run(p, 350);
      const grabbed = await st(p);
      if (i === 0) await shot(p, 'pc-2-grab');
      // 運ぶ：横へ歩く（D）→ 止まる
      await p.keyboard.down(i % 2 ? 'KeyA' : 'KeyD');
      await run(p, 900);
      const carrying = await st(p);
      if (i === 0) await shot(p, 'pc-3-carry');
      await p.keyboard.up(i % 2 ? 'KeyA' : 'KeyD');
      await run(p, 300);
      await p.keyboard.up('KeyE');
      await run(p, 1200);
      const released = await st(p);
      if (i === 0) await shot(p, 'pc-4-released');
      cycles.push({ grabbed: [grabbed.grab, grabbed.held, grabbed.contact], carrying: [carrying.crab, carrying.held, carrying.hGround, carrying.contact, carrying.hud], released: [released.grab, released.hint] });
      // 次へ：もう一度同じ小石の前へ
      await p.evaluate(() => { const g = window.__gr, pr = g.byId('pebble4'); const A = window.__aqua; pr.home.splice(0, 3, ...pr.p); g.approach('pebble4', -Math.PI / 2); g.view(-0.9, 2.3, 0.3); });
      await run(p, 300);
    }
    pc.cycles = cycles;
    // 重い石を引きずる
    await p.evaluate(() => { const g = window.__gr; g.reset(); g.settle(1); g.approach('stone5', -Math.PI / 2); g.view(-0.9, 2.6, 0.32); });
    await run(p, 300);
    await p.keyboard.down('KeyE');
    await run(p, 300);
    // 引きずる向きはワールドの +z（砂の平らな所。キーの向きはカメラ次第なので、移動だけ自動検証の入力で決める）
    const drag = await p.evaluate(() => window.__gr.walk(0, 1, 1.5));
    pc.stone = { ...(await st(p)), avgSpeed: drag.avgSpeed, max: drag.max };
    await p.evaluate(() => window.__gr.view(-0.9, 2.6, 0.3));
    await shot(p, 'pc-5-stone-drag');
    await p.keyboard.up('KeyE');
    await run(p, 300);
    // 何も挟まずに同じ向きへ歩いた速さ（比較）
    pc.freeSpeed = (await p.evaluate(() => window.__gr.walk(0, 1, 1.5))).avgSpeed;
    // 貝殻を持ち上げて泳ぐ
    await p.evaluate(() => { const g = window.__gr; g.reset(); g.settle(1); g.approach('shell0', -Math.PI / 2); g.view(-0.9, 2.6, 0.2); });
    await run(p, 300);
    await p.keyboard.down('KeyE');
    await run(p, 300);
    await p.keyboard.down('Space');
    await run(p, 900);
    pc.swim = await st(p);
    await shot(p, 'pc-6-shell-swim');
    await p.keyboard.up('Space');
    await p.keyboard.up('KeyE');
    pc.errors = await p.evaluate(() => window.__errs ?? null);
    out.pc = pc;
    await ctx.close();
  }

  // ---------------- スマホ ----------------
  for (const [name, w, h] of [['portrait', 390, 844], ['landscape', 844, 390]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await open(p);
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) });
    const r = { };
    // ボタンの矩形と重なり
    r.layout = await p.evaluate(() => {
      // （「調べる / 引っこ抜く」ボタン .act は引っこ抜き 2.0 で無くなった。あれば含める）
      const sel = ['.stick', '.run', '.jump', '.dig', '.cam', '.tool', '.grab', '.act'].filter((s) => document.querySelector('#touch-ui ' + s));
      const act = document.querySelector('#touch-ui .act');
      act?.classList.add('show');
      const R = sel.map((s) => { const e = document.querySelector('#touch-ui ' + s); const b = e.getBoundingClientRect(); return { s, l: b.left, t: b.top, r: b.right, b: b.bottom }; });
      act?.classList.remove('show');
      const overlaps = [];
      for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
        const a = R[i], b = R[j];
        if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) overlaps.push(a.s + '×' + b.s);
      }
      const g = R.find((q) => q.s === '.grab');
      return { grab: [Math.round(g.l), Math.round(g.t), Math.round(g.r - g.l)], overlaps, inView: g.l >= 0 && g.t >= 0 && g.r <= innerWidth && g.b <= innerHeight };
    });
    await p.evaluate(() => { const g = window.__gr; g.reset(); g.settle(1); g.approach('pebble4', -Math.PI / 2); g.view(-0.9, 2.6, 0.3); });
    await run(p, 300);
    r.ready = await p.evaluate(() => document.querySelector('#touch-ui .grab').classList.contains('ready'));
    const c = async (sel) => p.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, sel);
    const grabB = await c('#touch-ui .grab'), stickB = await c('#touch-ui .stick');
    const cycles = [];
    for (let i = 0; i < 3; i++) {
      // 右の指で挟むボタンを押す
      await touch('touchStart', [[grabB[0], grabB[1], 1]]);
      await run(p, 350);
      const grabbed = await st(p);
      // 左の指でスティックを横へ倒して歩く（挟んだまま）
      await touch('touchStart', [[grabB[0], grabB[1], 1], [stickB[0], stickB[1], 2]]);
      await touch('touchMove', [[grabB[0], grabB[1], 1], [stickB[0] + (i % 2 ? -40 : 40), stickB[1], 2]]);
      await run(p, 800);
      const carrying = await st(p);
      if (i === 0) await shot(p, `sp-${name}-carry`);
      // 挟むボタンの上で指を左へずらして視点を回す（挟んだまま）
      const yaw0 = await p.evaluate(() => window.__aqua.camera.yaw);
      for (let k = 1; k <= 6; k++) await touch('touchMove', [[grabB[0] - k * 12, grabB[1], 1], [stickB[0] + (i % 2 ? -40 : 40), stickB[1], 2]]);
      await run(p, 200);
      const yaw1 = await p.evaluate(() => window.__aqua.camera.yaw);
      const looking = await st(p);
      // スティックを離す → 挟むボタンを離す
      await touch('touchEnd', [[stickB[0], stickB[1], 2]]);
      await touch('touchEnd', [[grabB[0] - 72, grabB[1], 1]]);
      await run(p, 1000);
      const released = await st(p);
      const inp = await p.evaluate(() => ({ touchGrab: window.__aqua.input.touchGrab, move: window.__aqua.input.touchMove, ptrs: window.__aqua.input.activePointers }));
      cycles.push({ grabbed: [grabbed.grab, grabbed.held], carrying: [carrying.crab, carrying.held, carrying.contact], camYawDelta: +(yaw1 - yaw0).toFixed(3), stillHeld: looking.held, released: released.grab, inp });
      await p.evaluate(() => { const g = window.__gr, pr = g.byId('pebble4'); pr.home.splice(0, 3, ...pr.p); g.approach('pebble4', -Math.PI / 2); g.view(-0.9, 2.6, 0.3); });
      await run(p, 300);
    }
    r.cycles = cycles;
    await shot(p, `sp-${name}-ui`);
    out[name] = r;
    await ctx.close();
  }
  return JSON.stringify(out);
}
