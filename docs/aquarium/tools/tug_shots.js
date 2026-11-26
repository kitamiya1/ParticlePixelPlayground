// 引っこ抜き 2.0 の PC・スマホ相当の確認と撮影（Playwright。browser_run_code_unsafe の filename、または
// fetch(url).then(r => r.text()) を eval した関数に page を渡して実行）。
// - PC（1280×800・タッチなし）：本物のキー入力で、E を押すだけ（3 秒。抜けない）→ E を押したまま S で下がる → 途中で E を離す
//   （穴へ戻る）→ W で近づいて E で挟み直す → S で最後まで引いて抜く、を確かめ、段階ごとに撮る。
// - スマホ（390×844 縦・844×390 横、タッチ）：CDP のタッチ入力で「挟む」ボタンを押したまま、左のスティックを下へ倒して下がる
//   （2 本の指を同時に）。抜けるまで・仲間になるまでを確かめる。ボタンどうしが重ならないかも調べる。
// - 保存：?nosave を付けずに別の（新しい）文脈で開き、抜いて仲間にした後に保存 → 読み込み直して仲間のまま戻るかを確かめる。
// 画像は globalThis.__over?.dir（既定 docs/aquarium/burrow-pull）へ。既にある画像は上書きしない（out_guard.js）。
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: 'D:/AI-Projects/ParticlePixelPlayground/docs/aquarium/burrow-pull' }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch(`${O.host}/docs/aquarium/tools/out_guard.js`)).text())(O);
  const out = {};
  const browser = page.context().browser();
  const open = async (p, nosave = true) => {
    await p.goto(`${O.host}/aquarium.html?${nosave ? 'nosave&' : ''}${Date.now()}`);
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
    await p.evaluate(async (h) => {
      await fetch(h + '/docs/aquarium/tools/tug_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
      window.__aqua.help?.close?.();
      document.getElementById('help')?.classList.remove('show');
    }, O.host);
    await p.waitForTimeout(300);
  };
  const shot = async (p, name) => p.screenshot({ path: await shotPath(`${O.dir}/${name}.jpg`), type: 'jpeg', quality: 85 });
  const run = async (p, ms) => {
    await p.evaluate(() => (window.__aqua.freeze = false));
    await p.waitForTimeout(ms);
  };
  const st = (p) => p.evaluate(() => {
    const A = window.__aqua, B = A.buddy, T = B.tug, G = A.grab;
    const cue = document.getElementById('tug-cue');
    const pr = document.getElementById('act-prompt');
    return {
      grab: G.state, creature: G.holdingCreature ? 'tug' : null, ext: +T.ext.toFixed(3), stage: T.stage, load: +G.load.toFixed(2), warn: +G.warn.toFixed(2),
      buddy: B.state, found: B.found, examined: B.examined, crab: A.crab.state, tumbles: A.crab.tumbles, distToHole: +Math.hypot(A.crab.x - B.burrow[0], A.crab.z - B.burrow[2]).toFixed(3),
      cue: cue.classList.contains('show') ? `${cue.dataset.level}:${cue.querySelector('.say').textContent}` : null,
      prompt: pr.classList.contains('show') ? pr.textContent : null,
      hud: document.getElementById('h-grab').classList.contains('off') ? null : document.getElementById('h-grab').textContent,
      slips: G.stats.creatureSlips, pops: G.stats.pops,
    };
  });
  // 巣穴の前へ（鋏が届く所）。カメラは後ろ斜め（S = 穴から離れる・W = 近づく）
  const place = (p, d = 0.47) => p.evaluate((dd) => { window.__tug.reset(); window.__tug.approach(dd, 0); document.getElementById('place-banner').classList.remove('show'); }, d);
  const waitFor = async (p, fn, ms, arg) => {
    const t0 = Date.now();
    await p.evaluate(() => (window.__aqua.freeze = false));
    while (Date.now() - t0 < ms) {
      if (await p.evaluate(fn, arg)) return Date.now() - t0;
      await p.waitForTimeout(50);
    }
    return null;
  };

  // ---------------- PC ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await open(p);
    const pc = { touchUi: await p.evaluate(() => document.body.classList.contains('touch')) };
    await place(p);
    await run(p, 600);
    pc.peek = await st(p);
    await shot(p, 'pc-1-peek');
    // E を押すだけ（3 秒）：挟めるが抜けない
    await p.keyboard.down('KeyE');
    await run(p, 400);
    pc.grabbed = await st(p);
    await shot(p, 'pc-2-grab');
    await run(p, 2600);
    pc.holdOnly3s = await st(p);
    // E を押したまま S で下がる（約 1.6 秒）→ 途中
    await p.keyboard.down('KeyS');
    await run(p, 1600);
    pc.pulling = await st(p);
    await shot(p, 'pc-3-pulling');
    // E を離す（S も離す）：穴へ戻っていく
    await p.keyboard.up('KeyS');
    await p.keyboard.up('KeyE');
    await run(p, 600);
    pc.released = await st(p);
    // 近づいて（W）E で挟み直す（押したまま近づけば、届いた所で挟む）
    await p.keyboard.down('KeyE');
    await p.keyboard.down('KeyW');
    pc.regrabMs = await waitFor(p, () => !!window.__aqua.grab.holdingCreature, 3000);
    await p.keyboard.up('KeyW');
    pc.regrabbed = await st(p);
    // S で最後まで（暴れている・滑りそうな間は S を離す）
    const t0 = Date.now();
    let lateShot = false;
    let sDown = false;
    while (Date.now() - t0 < 15000) {
      const s = await p.evaluate(() => ({ env: window.__aqua.buddy.tug.env, warn: window.__aqua.grab.warn, held: !!window.__aqua.grab.holdingCreature, found: window.__aqua.buddy.found, stage: window.__aqua.buddy.tug.stage }));
      if (s.found || !s.held) break;
      const want = !(s.env > 0.4 || s.warn > 0.2);
      if (want && !sDown) await p.keyboard.down('KeyS');
      if (!want && sDown) await p.keyboard.up('KeyS');
      sDown = want;
      if (!lateShot && s.stage === 'late') {
        lateShot = true;
        await shot(p, 'pc-4-late');
        pc.late = await st(p);
      }
      await p.waitForTimeout(40);
    }
    if (sDown) await p.keyboard.up('KeyS');
    pc.pullMs = Date.now() - t0;
    await p.waitForTimeout(120);
    pc.popped = await st(p);
    await shot(p, 'pc-5-pop');
    await p.keyboard.up('KeyE');
    await run(p, 2200);
    pc.joined = await st(p);
    await shot(p, 'pc-6-joined');
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
    r.layout = await p.evaluate(() => {
      const sel = ['.stick', '.run', '.jump', '.dig', '.cam', '.tool', '.grab'];
      const R = sel.map((s) => { const e = document.querySelector('#touch-ui ' + s); const b = e.getBoundingClientRect(); return { s, l: b.left, t: b.top, r: b.right, b: b.bottom }; });
      const overlaps = [];
      for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
        const a = R[i], b = R[j];
        if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) overlaps.push(a.s + '×' + b.s);
      }
      return { overlaps, actButton: !!document.querySelector('#touch-ui .act') };
    });
    await place(p);
    await run(p, 600);
    r.peek = await st(p);
    r.ready = await p.evaluate(() => document.querySelector('#touch-ui .grab').classList.contains('ready'));
    if (name === 'portrait') await shot(p, `sp-${name}-1-peek`);
    const c = async (sel) => p.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, sel);
    const grabB = await c('#touch-ui .grab'), stickB = await c('#touch-ui .stick');
    // 右の指で「挟む」を押したまま
    await touch('touchStart', [[grabB[0], grabB[1], 1]]);
    await run(p, 400);
    r.grabbed = await st(p);
    // 長押しだけ（2 秒）：抜けない
    await run(p, 2000);
    r.holdOnly2s = await st(p);
    // 左の指でスティックを下へ（下がる）。暴れている・滑りそうな間は指を中央へ戻す
    await touch('touchStart', [[grabB[0], grabB[1], 1], [stickB[0], stickB[1], 2]]);
    const t0 = Date.now();
    let down = false, shotMid = false;
    while (Date.now() - t0 < 15000) {
      const s = await p.evaluate(() => ({ env: window.__aqua.buddy.tug.env, warn: window.__aqua.grab.warn, held: !!window.__aqua.grab.holdingCreature, found: window.__aqua.buddy.found, ext: window.__aqua.buddy.tug.ext }));
      if (s.found || !s.held) break;
      const want = !(s.env > 0.4 || s.warn > 0.2);
      if (want !== down) await touch('touchMove', [[grabB[0], grabB[1], 1], [stickB[0], stickB[1] + (want ? 44 : 0), 2]]);
      down = want;
      if (!shotMid && s.ext > 0.45) {
        shotMid = true;
        r.mid = await st(p);
        await shot(p, `sp-${name}-2-pulling`);
      }
      await p.waitForTimeout(40);
    }
    r.pullMs = Date.now() - t0;
    await touch('touchEnd', [[stickB[0], stickB[1], 2]]);
    await p.waitForTimeout(100);
    r.popped = await st(p);
    await touch('touchEnd', [[grabB[0], grabB[1], 1]]);
    await run(p, 2200);
    r.joined = await st(p);
    if (name === 'portrait') await shot(p, `sp-${name}-3-joined`);
    r.inp = await p.evaluate(() => ({ touchGrab: window.__aqua.input.touchGrab, move: window.__aqua.input.touchMove }));
    r.errors = errs;
    out[name] = r;
    await ctx.close();
  }

  // ---------------- 保存・復元（?nosave なし・新しい文脈 = 空の保存） ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const p = await ctx.newPage();
    await open(p, false);
    const sv = {};
    sv.before = await p.evaluate(() => ({ found: window.__aqua.buddy.found, examined: window.__aqua.buddy.examined, status: window.__aqua.save.loaded.status }));
    await place(p);
    await p.evaluate(() => {
      const t = window.__tug, a = window.__aqua;
      t.grab();
      t.run(20, (tt, s) => { if (s.env > 0.4 || s.warn > 0.2) return null; const [x, z] = t.awayDir(); return { x, z }; }, { until: () => a.buddy.found });
      a.hold = false;
      a.freeze = false;
      a.step(200);
      a.toggleBuddy();
    });
    sv.afterPop = await p.evaluate(() => ({ found: window.__aqua.buddy.found, mode: window.__aqua.buddy.mode, state: window.__aqua.buddy.state }));
    sv.flush = await p.evaluate(async () => { await window.__aqua.save.saver.flush(); return window.__aqua.save.saver.state; });
    await p.reload();
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
    await p.waitForTimeout(300);
    sv.restored = await p.evaluate(() => {
      const B = window.__aqua.buddy, A = window.__aqua;
      return { status: A.save.loaded.status, found: B.found, examined: B.examined, mode: B.mode, state: B.state, tugPopped: B.tug.popped, grabbable: B.tug.grabbable(), menuBtn: document.querySelector('#menu .menu-btn.buddy')?.style.display !== 'none' };
    });
    out.save = sv;
    await ctx.close();
  }
  return JSON.stringify(out);
}
