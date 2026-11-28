// ハサミ集中モード：本物の入力での確認と撮影（Playwright の browser_run_code_unsafe の filename で実行）。
// - PC（1280×800、タッチなし）：Tab で集中 → WASD で左の腕・マウスで右の腕・左 Shift / 左クリックで開閉・Q / E で左の高さ・
//   右ボタンのドラッグで右の高さ・中ボタンのドラッグで視点・Tab で戻る。通常モードの Q（左のハサミ）
// - ゲームパッド（仮想のパッド）：左右のスティックの同時押しで集中 → 左右のスティックで左右の腕・LT / RT の押し込み量で
//   開閉と握る強さ（アナログ）・押しているだけのトリガー（0 / 1）・B で戻る
// - スマホ（縦 390×844・横 844×390、タッチ）：右上の「集中」→ 左右のスティック・左右の開閉ボタンを 4 本の指で同時に
//   （押している間 / たたいて切り替え）・高さのつまみ・「通常へ」。通常モードの左の挟むスイッチ
// - 保存と再起動（?nosave なし）：積み木を積んで保存 → 開き直す → 同じ位置
// 位置合わせ（鋏を積み木の前へ）は検証の道具（focus_helpers.js）で行い、開閉・高さ・腕の動きは本物の入力で確かめる。
// 画像は globalThis.__over?.dir（既定 docs/aquarium/claw-focus）へ。既にある画像は上書きしない（out_guard.js）。
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: 'D:/AI-Projects/ParticlePixelPlayground/docs/aquarium/claw-focus' }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch(`${O.host}/docs/aquarium/tools/out_guard.js`)).text())(O);
  const browser = page.context().browser();
  const out = {};
  const open = async (p, q = '?nosave') => {
    await p.goto(`${O.host}/aquarium.html${q}${q ? '&' : '?'}${Date.now()}`, { timeout: 120000 });
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 240000 });
    await p.evaluate(async (h) => {
      for (const f of ['focus_helpers.js', 'claw_focus_test.js']) await fetch(`${h}/docs/aquarium/tools/${f}?${Date.now()}`).then((r) => r.text()).then(eval);
      window.__aqua.help?.close?.();
      document.getElementById('help')?.classList.remove('show');
    }, O.host);
    await p.waitForTimeout(300);
  };
  const shot = async (p, name) => p.screenshot({ path: await shotPath(`${O.dir}/${name}.jpg`), type: 'jpeg', quality: 88 });
  const run = async (p, ms) => {
    await p.evaluate(() => (window.__aqua.freeze = false));
    await p.waitForTimeout(ms);
  };
  const st = (p) => p.evaluate(() => {
    const A = window.__aqua, r3 = (v) => +(+v).toFixed(3);
    return { focus: A.focus.on, scheme: A.focus.scheme, R: A.focus.R.p.map(r3), L: A.focus.L.p.map(r3), liftR: r3(A.focus.R.lift), liftL: r3(A.focus.L.lift), rollR: r3(A.focus.R.roll), closeR: r3(A.grab.close), closeL: r3(A.grabL.close), stR: A.grab.state, stL: A.grabL.state, gripR: r3(A.grab.gripNow), gripL: r3(A.grabL.gripNow), heldR: A.grab.held?.name ?? null, heldL: A.grabL.held?.name ?? null, crab: [A.crab.x, A.crab.z].map(r3), yaw: r3(A.camera.yaw), fps: Math.round(A.fps) };
  });
  /** 検証エリアで集中モードへ（カメラは作業の所を斜め上から） */
  const setup = (p) => p.evaluate(() => {
    window.__focus.setup();
    window.__focus.release();
    window.__aqua.freeze = false;
  });
  const placeClaw = (p, side, kind, k) => p.evaluate(([s, kd, i]) => {
    const X = window.__focus, A = window.__aqua, pr = X.blocks(kd)[i], c = A.crab;
    const at = () => { const dx = pr.p[0] - c.x, dz = pr.p[2] - c.z, l = Math.hypot(dx, dz) || 1; const off = Math.min(pr.semi[0], pr.semi[2]) + 0.015; return [pr.p[0] - (dx / l) * off, 0, pr.p[2] - (dz / l) * off]; };
    const r = X.moveTo(s, at, { tol: 0.02, max: 300 });
    X.release();
    A.freeze = false;
    return r;
  }, [side, kind, k]);

  // ---------------- PC ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await open(p);
    await p.evaluate(() => { window.__aqua.goto('blocks'); window.__aqua.crab.heading = 0; window.__aqua.camera.placeBehind(window.__aqua.crab); });
    await run(p, 500);
    const pc = { touchUi: await p.evaluate(() => !!document.querySelector('#touch-ui')) };
    await p.mouse.move(640, 400);
    await p.keyboard.press('Tab');
    await run(p, 900);
    pc.afterTab = await st(p);
    await shot(p, 'pc-1-focus');
    // 左の腕：D を 0.5 秒（右の腕は動かない）
    const s0 = await st(p);
    await p.keyboard.down('KeyD');
    await run(p, 500);
    await p.keyboard.up('KeyD');
    const s1 = await st(p);
    pc.keyD = { leftMoved: +Math.hypot(s1.L[0] - s0.L[0], s1.L[2] - s0.L[2]).toFixed(3), rightMoved: +Math.hypot(s1.R[0] - s0.R[0], s1.R[2] - s0.R[2]).toFixed(3) };
    // 右の腕：マウスを右へ 120 px（左の腕は動かない）
    for (let k = 0; k < 12; k++) {
      await p.mouse.move(640 + (k + 1) * 10, 400);
      await p.waitForTimeout(16);
    }
    await run(p, 200);
    const s2 = await st(p);
    pc.mouse = { rightMoved: +Math.hypot(s2.R[0] - s1.R[0], s2.R[2] - s1.R[2]).toFixed(3), leftMoved: +Math.hypot(s2.L[0] - s1.L[0], s2.L[2] - s1.L[2]).toFixed(3) };
    // 開閉：左 Shift = 左だけ、左クリック = 右だけ
    await p.keyboard.down('ShiftLeft');
    await run(p, 300);
    pc.shift = { closeL: (await st(p)).closeL, closeR: (await st(p)).closeR };
    await p.keyboard.up('ShiftLeft');
    await p.mouse.down({ button: 'left' });
    await run(p, 300);
    pc.click = { closeL: (await st(p)).closeL, closeR: (await st(p)).closeR };
    await p.mouse.up({ button: 'left' });
    // 高さ：E を 0.4 秒で左が上がる・右ボタンを押したまま上へドラッグで右が上がる
    const h0 = await st(p);
    await p.keyboard.down('KeyE');
    await run(p, 400);
    await p.keyboard.up('KeyE');
    const h1 = await st(p);
    await p.mouse.move(760, 420);
    await p.mouse.down({ button: 'right' });
    for (let k = 0; k < 10; k++) {
      await p.mouse.move(760, 420 - (k + 1) * 6);
      await p.waitForTimeout(16);
    }
    await p.mouse.up({ button: 'right' });
    await run(p, 200);
    const h2 = await st(p);
    pc.height = { leftLiftE: +(h1.liftL - h0.liftL).toFixed(3), rightLiftDrag: +(h2.liftR - h1.liftR).toFixed(3) };
    // 中ボタンのドラッグで視点
    await p.mouse.move(640, 400);
    await p.mouse.down({ button: 'middle' });
    await p.mouse.move(760, 400, { steps: 8 });
    await p.mouse.up({ button: 'middle' });
    await run(p, 200);
    pc.middleYaw = +((await st(p)).yaw - h2.yaw).toFixed(3);
    // 積み木を右の鋏で：位置合わせ（道具）→ 左クリックを押している間挟む → 右ボタンのドラッグで持ち上げる
    pc.placeR = await placeClaw(p, 'R', 'block', 2);
    await p.mouse.down({ button: 'left' });
    await run(p, 500);
    pc.grabbed = await st(p);
    await p.mouse.move(760, 420);
    await p.mouse.down({ button: 'right' });
    for (let k = 0; k < 10; k++) {
      await p.mouse.move(760, 420 - (k + 1) * 8);
      await p.waitForTimeout(16);
    }
    await p.mouse.up({ button: 'right' });
    await run(p, 500);
    pc.lifted = await p.evaluate(() => { const A = window.__aqua, b = A.blocks.find((x) => x.id === 'area-block-2'), f = A.props.props.find((q) => q.fixed); return +(b.p[1] - f.p[1] - f.semi[1]).toFixed(3); });
    await shot(p, 'pc-2-lift');
    await p.mouse.up({ button: 'left' });
    await run(p, 600);
    pc.released = (await st(p)).stR;
    // Tab で通常へ。通常モードの Q（左のハサミ）
    await p.keyboard.press('Tab');
    await run(p, 600);
    pc.backToNormal = (await st(p)).focus;
    await p.evaluate(() => { const A = window.__aqua; A.goto('spawn'); A.freeze = false; A.step(20); });
    const pebble = await p.evaluate(() => {
      const A = window.__aqua, c = A.crab, pr = A.props.props.find((q) => q.kind === 'pebble' && !q.food);
      c.teleport(pr.p[0] - 0.42, pr.p[2], c.y + 0.3);
      c.heading = Math.PI / 2;
      A.step(30);
      // 左の鋏の構えが小石の上に来るよう、少しずらす
      for (let k = 0; k < 3; k++) {
        const an = A.rig.anchorL;
        c.teleport(c.x + (pr.p[0] - an[0]), c.z + (pr.p[2] - an[2]), c.y + 0.05);
        c.heading = Math.PI / 2;
        A.step(12);
      }
      return pr.id;
    });
    await p.keyboard.down('KeyQ');
    await run(p, 500);
    pc.qLeft = { pebble, ...(await st(p)) };
    await p.keyboard.up('KeyQ');
    pc.errors = errs;
    out.pc = pc;
    await ctx.close();
  }

  // ---------------- ゲームパッド ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await open(p);
    await p.evaluate(() => { window.__aqua.goto('blocks'); window.__aqua.crab.heading = 0; window.__aqua.camera.placeBehind(window.__aqua.crab); });
    await run(p, 400);
    await p.evaluate(() => {
      const pad = { index: 0, id: 'Virtual pad (STANDARD GAMEPAD)', connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })), timestamp: 0 };
      navigator.getGamepads = () => [pad];
      window.__pad = pad;
      window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad }));
    });
    const btn = (i, v) => p.evaluate(([k, x]) => { const b = window.__pad.buttons[k]; b.value = x; b.pressed = x > 0.5 || (k >= 6 && k <= 7 && x > 0.05); window.__pad.timestamp++; }, [i, v]);
    const axes = (a0, a1, a2, a3) => p.evaluate((v) => { window.__pad.axes = v; window.__pad.timestamp++; }, [a0, a1, a2, a3]);
    const gp = {};
    // 左右のスティックの押し込みを同時に → 集中
    await btn(10, 1);
    await btn(11, 1);
    await run(p, 150);
    await btn(10, 0);
    await btn(11, 0);
    await run(p, 700);
    gp.l3r3 = (await st(p)).focus;
    // 左スティックだけ右へ：左の腕だけ動く
    const s0 = await st(p);
    await axes(0.9, 0, 0, 0);
    await run(p, 400);
    await axes(0, 0, 0, 0);
    const s1 = await st(p);
    gp.leftStick = { leftMoved: +Math.hypot(s1.L[0] - s0.L[0], s1.L[2] - s0.L[2]).toFixed(3), rightMoved: +Math.hypot(s1.R[0] - s0.R[0], s1.R[2] - s0.R[2]).toFixed(3) };
    // 右スティック + RB で右の高さ
    await btn(5, 1);
    await axes(0, 0, 0, -0.9);
    await run(p, 400);
    await axes(0, 0, 0, 0);
    await btn(5, 0);
    gp.rbLift = +((await st(p)).liftR - s1.liftR).toFixed(3);
    // （下げて戻す：積み木を挟む高さへ）
    await btn(5, 1);
    await axes(0, 0, 0, 0.9);
    await run(p, 500);
    await axes(0, 0, 0, 0);
    await btn(5, 0);
    // RT のアナログ：空で 0.3 / 0.6 → 閉じ具合が押し込みに従う
    gp.rtEmpty = [];
    for (const v of [0.3, 0.6, 0]) {
      await btn(7, v);
      await run(p, 300);
      gp.rtEmpty.push({ rt: v, closeR: (await st(p)).closeR, closeL: (await st(p)).closeL });
    }
    // 積み木を右で挟む：触れた後は押し込むほど握る力が増える
    gp.place = await placeClaw(p, 'R', 'block', 2);
    gp.rtBlock = [];
    for (const v of [0.4, 0.6, 0.8, 1.0, 0.75]) {
      await btn(7, v);
      await run(p, 300);
      const s = await st(p);
      gp.rtBlock.push({ rt: v, state: s.stR, close: s.closeR, grip: s.gripR });
    }
    await btn(5, 1);
    await axes(0, 0, 0, -1);
    await run(p, 500);
    await axes(0, 0, 0, 0);
    await btn(5, 0);
    await shot(p, 'pad-1-analog-hold');
    await btn(7, 0);
    await run(p, 400);
    gp.released = (await st(p)).stR;
    // 押しているだけのトリガー（0 / 1）：同じ操作ができる
    gp.place2 = await placeClaw(p, 'R', 'block', 2);
    await p.evaluate(() => { const b = window.__pad.buttons[7]; b.pressed = true; b.value = 1; });
    await run(p, 400);
    gp.digitalTrigger = { state: (await st(p)).stR, grip: (await st(p)).gripR };
    await p.evaluate(() => { const b = window.__pad.buttons[7]; b.pressed = false; b.value = 0; });
    await run(p, 300);
    // B で戻る
    await btn(1, 1);
    await run(p, 100);
    await btn(1, 0);
    await run(p, 400);
    gp.bExit = (await st(p)).focus;
    gp.errors = errs;
    out.pad = gp;
    await ctx.close();
  }

  // ---------------- スマホ（縦・横） ----------------
  for (const [tag, vw, vh] of [['sp', 390, 844], ['spl', 844, 390]]) {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await open(p);
    await p.evaluate(() => { window.__aqua.goto('blocks'); window.__aqua.crab.heading = 0; window.__aqua.camera.placeBehind(window.__aqua.crab); });
    await run(p, 400);
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) });
    const ctr = (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width, b.height]; }, sel);
    const sp = {};
    // 通常モード：左の挟むスイッチ
    const gl = await ctr('#touch-ui .grabL');
    sp.grabLButton = gl;
    if (gl) {
      await touch('touchStart', [[gl[0], gl[1], 1]]);
      await touch('touchEnd', []);
      await run(p, 200);
      sp.grabLLatch = await p.evaluate(() => window.__aqua.input.touchGrabLatchL);
      await touch('touchStart', [[gl[0], gl[1], 1]]);
      await touch('touchEnd', []);
      await run(p, 200);
    }
    // 右上の「集中」
    const fb = await ctr('#menu .menu-btn.focus');
    await p.tap('#menu .menu-btn.focus');
    await run(p, 800);
    sp.focusOn = (await st(p)).focus;
    sp.focusButton = fb;
    const L = await ctr('#focus-touch .fstick.L'), R = await ctr('#focus-touch .fstick.R'), cL = await ctr('#focus-touch .fclose.L'), cR = await ctr('#focus-touch .fclose.R'), lL = await ctr('#focus-touch .flift.L');
    sp.layout = { L, R, cL, cR, lL, exit: await ctr('#focus-touch .fexit') };
    // 4 本の指：左右のスティックを倒しながら、左右の開閉ボタンを押す
    const s0 = await st(p);
    await touch('touchStart', [[L[0], L[1], 1]]);
    await touch('touchStart', [[L[0], L[1], 1], [R[0], R[1], 2]]);
    await touch('touchStart', [[L[0], L[1], 1], [R[0], R[1], 2], [cL[0], cL[1], 3]]);
    await touch('touchStart', [[L[0], L[1], 1], [R[0], R[1], 2], [cL[0], cL[1], 3], [cR[0], cR[1], 4]]);
    for (let k = 1; k <= 6; k++) await touch('touchMove', [[L[0] + k * 6, L[1] - k * 3, 1], [R[0] - k * 6, R[1] - k * 3, 2], [cL[0], cL[1], 3], [cR[0], cR[1], 4]]);
    await run(p, 500);
    const s1 = await st(p);
    sp.fourFingers = await p.evaluate(() => ({ pointers: window.__aqua.input.activePointers, stickL: window.__aqua.focusTouch.stick.L, stickR: window.__aqua.focusTouch.stick.R, close: { ...window.__aqua.focusTouch.close } }));
    sp.fourFingers.closeL = s1.closeL;
    sp.fourFingers.closeR = s1.closeR;
    sp.fourFingers.leftMoved = +Math.hypot(s1.L[0] - s0.L[0], s1.L[2] - s0.L[2]).toFixed(3);
    sp.fourFingers.rightMoved = +Math.hypot(s1.R[0] - s0.R[0], s1.R[2] - s0.R[2]).toFixed(3);
    await shot(p, `${tag}-1-four-fingers`);
    await touch('touchEnd', []);
    await run(p, 300);
    const s2 = await st(p);
    sp.afterRelease = { closeL: s2.closeL, closeR: s2.closeR, pointers: await p.evaluate(() => window.__aqua.input.activePointers) };
    // 高さのつまみ
    const lf0 = s2.liftL;
    await touch('touchStart', [[lL[0], lL[1], 5]]);
    for (let k = 1; k <= 6; k++) await touch('touchMove', [[lL[0], lL[1] - k * 6, 5]]);
    await run(p, 400);
    await touch('touchEnd', []);
    sp.liftPad = +((await st(p)).liftL - lf0).toFixed(3);
    // たたいて切り替え
    await p.evaluate(() => window.__aqua.uiPrefs.set({ focusToggle: 'toggle' }));
    await touch('touchStart', [[cL[0], cL[1], 6]]);
    await touch('touchEnd', []);
    await run(p, 400);
    sp.toggleClosed = (await st(p)).closeL;
    await touch('touchStart', [[cL[0], cL[1], 6]]);
    await touch('touchEnd', []);
    await run(p, 400);
    sp.toggleOpened = (await st(p)).closeL;
    await p.evaluate(() => window.__aqua.uiPrefs.set({ focusToggle: 'hold' }));
    // 積み木を右で挟んで、右の開閉ボタンを押している間持ち上げる（位置合わせは道具）
    sp.place = await placeClaw(p, 'R', 'block', 2);
    await touch('touchStart', [[cR[0], cR[1], 7]]);
    await run(p, 400);
    const lR = await ctr('#focus-touch .flift.R');
    await touch('touchStart', [[cR[0], cR[1], 7], [lR[0], lR[1], 8]]);
    for (let k = 1; k <= 6; k++) await touch('touchMove', [[cR[0], cR[1], 7], [lR[0], lR[1] - k * 6, 8]]);
    await run(p, 500);
    sp.hold = await st(p);
    await shot(p, `${tag}-2-hold-lift`);
    await touch('touchEnd', []);
    await run(p, 400);
    sp.releasedOnLift = (await st(p)).stR;
    // 「通常へ」
    await p.tap('#focus-touch .fexit');
    await run(p, 500);
    sp.exit = (await st(p)).focus;
    sp.errors = errs;
    out[tag] = sp;
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
      const A = window.__aqua, P = A.props, B = A.blocks.filter((b) => b.kind === 'block'), f = P.props.find((q) => q.fixed), top = f.p[1] + f.semi[1];
      // 3 段に積み、棒を台に渡す
      for (let i = 0; i < 3; i++) {
        P.place(B[i], [f.p[0] - 0.2, top + 0.051 + i * 0.1015, f.p[2] + 0.3], [0, Math.sin(i * 0.1), 0, Math.cos(i * 0.1)]);
        A.freeze = false;
        A.step(90);
      }
      const [p1, p2] = A.blocks.filter((b) => b.kind === 'pillar'), rod = A.blocks.find((b) => b.kind === 'rod');
      P.place(rod, [(p1.p[0] + p2.p[0]) / 2, p1.p[1] + p1.semi[1] + rod.semi[1] + 0.006, (p1.p[2] + p2.p[2]) / 2], [0, 0, 0, 1]);
      A.step(240);
      const ok = await A.save.saver.flush();
      return { ok, blocks: A.blocks.map((b) => [b.id, ...b.p.map((v) => +v.toFixed(4))]) };
    });
    await p.reload();
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 240000 });
    await p.evaluate(() => window.__aqua.help?.close?.());
    await p.waitForTimeout(1500);
    const after = await p.evaluate(() => ({ restored: window.__aqua.save.restore.blocks, version: window.__aqua.save.loaded?.data?.version ?? null, blocks: window.__aqua.blocks.map((b) => [b.id, ...b.p.map((v) => +v.toFixed(4))]) }));
    const maxDiff = Math.max(...before.blocks.map((b, i) => Math.hypot(b[1] - after.blocks[i][1], b[2] - after.blocks[i][2], b[3] - after.blocks[i][3])));
    await p.evaluate(() => { const A = window.__aqua, f = A.props.props.find((q) => q.fixed); A.setView('classic'); A.camera.adventure.yaw = 2.6; A.camera.adventure.pitch = 0.45; A.camera.adventure.zoom = 2.6; A.crab.teleport(f.p[0] + 0.6, f.p[2] - 0.6, A.crab.y + 0.3); A.freeze = false; });
    await p.waitForTimeout(1500);
    await shot(p, 'save-restored');
    out.save = { saved: before.ok, restored: after.restored, version: after.version, maxDiff: +maxDiff.toFixed(5), errors: errs };
    await ctx.close();
  }
  return out;
}
