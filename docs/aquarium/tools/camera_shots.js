// 冒険カメラの撮影と計測（Playwright。browser_run_code_unsafe で実行）。
// 設定は開発サーバーから camera_config.json（{ dir, tag, w, h, touch, only, shots }）を読む（dir = 保存先、tag = ファイル名の頭）。
// 場所ごとに カニを置く → 視点（yaw / pitch / zoom）を決める → ゲームのループと同じ処理を進める → 画面を撮る。
// 計測：カメラとカニの距離（希望の距離に対して）・視線がカニまで通るか・カメラが固体の中か・
//       1 周回したときの距離の 1 フレームの最大変化（急に寄るか）・勝手に回り込む量・カメラ更新の時間。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/camera_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  // 画像を保存する前に、同じ名前の画像が既に無いか確かめる（out_guard.js。過去の報告の画像を上書きしない）
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js?' + Date.now())).text())(O);
  await cfgPage.close();
  const W = O.w ?? 960, H = O.h ?? 600;
  const ctx = await page.context().browser().newContext({ viewport: { width: W, height: H }, hasTouch: !!O.touch, isMobile: !!O.touch, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto((O.host ?? 'http://localhost:5173') + '/aquarium.html?nosave&' + Date.now());
  await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
  await p.evaluate(() => {
    const a = window.__aqua;
    a.freeze = true;
    document.getElementById('help')?.classList.add('fade');
    // カメラ更新の時間を測る
    const cam = a.camera, orig = cam.update.bind(cam);
    a.camMs = { n: 0, sum: 0, max: 0 };
    cam.update = (...args) => { const t0 = performance.now(); orig(...args); const ms = performance.now() - t0; a.camMs.n++; a.camMs.sum += ms; a.camMs.max = Math.max(a.camMs.max, ms); };
    const run = (n, fn) => { a.freeze = false; for (let i = 0; i < n; i++) { fn?.(i); a.step(1, 1 / 60); } a.freeze = true; };
    // 視線（カメラ → カニの体の中心）が固体（不透明）で遮られているか
    const blocked = () => {
      const w = a.world, c = a.crab, P = a.camera.pose.pos;
      const C = [c.x, c.y + c.radius, c.z];
      const L = Math.hypot(C[0] - P[0], C[1] - P[1], C[2] - P[2]);
      for (let s = 0.05; s < L - 0.3; s += 0.04) {
        const t = s / L;
        if (w.viewSolid(P[0] + (C[0] - P[0]) * t, P[1] + (C[1] - P[1]) * t, P[2] + (C[2] - P[2]) * t, a.camera.region) < 0) return true;
      }
      return false;
    };
    const camDist = () => { const c = a.crab, P = a.camera.pose.pos; return Math.hypot(c.x - P[0], c.y + 0.3 - P[1], c.z - P[2]); };
    window.__cam = {
      place(s) {
        const c = a.crab;
        if (s.goto) a.goto(s.goto);
        if (s.at) c.teleport(s.at[0], s.at[2], s.at[1] ?? undefined);
        if (s.heading !== undefined) c.heading = s.heading;
        a.input.touchMove = { x: 0, y: 0 };
        a.dig = false;
        run(30);
        const o = a.camera.adventure;
        if (a.camera.mode !== 'adventure') a.camera.toggle();
        a.camera.placeBehind(c);
        if (s.yaw !== undefined) o.yaw = s.yawAbs ? s.yaw : c.heading + Math.PI + s.yaw;
        if (s.pitch !== undefined) o.pitch = s.pitch;
        if (s.zoom !== undefined) o.zoom = s.zoom;
        a.resetDiscovery();
        a.camMs.n = a.camMs.sum = a.camMs.max = 0;
        run(s.frames ?? 120);
        const st = a.camera;
        return { region: a.crab.region, dist: +camDist().toFixed(2), zoom: +o.zoom.toFixed(2), blocked: blocked(), camInSolid: a.world.cameraSolid(...st.pose.pos, st.region) < 0, swing: +(st.yaw - o.yaw).toFixed(3), lookUp: +(st.lookUp ?? 0).toFixed(2), camMs: +(a.camMs.sum / Math.max(1, a.camMs.n)).toFixed(3) };
      },
      // その場で視点を 1 周（frames フレーム）回し、距離の変化・遮られた割合・回り込みを測る
      sweep(frames = 240, pitch) {
        const o = a.camera.adventure;
        if (pitch !== undefined) o.pitch = pitch;
        let prev = camDist(), maxJump = 0, minD = Infinity, blockedN = 0, maxSwing = 0, inSolid = 0;
        a.camMs.n = a.camMs.sum = a.camMs.max = 0;
        run(frames, () => {
          o.yaw += (Math.PI * 2) / frames;
          const d = camDist();
          maxJump = Math.max(maxJump, Math.abs(d - prev));
          prev = d;
          minD = Math.min(minD, d);
          if (blocked()) blockedN++;
          if (a.world.cameraSolid(...a.camera.pose.pos, a.camera.region) < 0) inSolid++;
          maxSwing = Math.max(maxSwing, Math.abs(a.camera.yaw - o.yaw));
        });
        return { maxJumpPerFrame: +maxJump.toFixed(3), minDist: +minD.toFixed(2), zoom: +o.zoom.toFixed(2), blockedPct: Math.round((blockedN / frames) * 100), inSolidFrames: inSolid, maxSwing: +maxSwing.toFixed(2), camMs: +(a.camMs.sum / Math.max(1, a.camMs.n)).toFixed(3), camMaxMs: +a.camMs.max.toFixed(2) };
      },
      // 前へ掘り進める（seconds 秒。カメラはカニの真後ろ）。掘った区画はすべて作り直す
      dig(at, heading, seconds, opt = {}) {
        const c = a.crab;
        c.teleport(at[0], at[1]);
        c.heading = heading;
        run(20);
        const o = a.camera.adventure;
        o.yaw = heading + Math.PI;
        a.input.touchMove = { x: 0, y: 1 };
        a.dig = true;
        a.input.touchJump = !!opt.up;
        run(Math.round(seconds * 60), (i) => { o.yaw = c.heading + Math.PI; if (opt.turn) c.heading += opt.turn / 60; });
        a.dig = false;
        a.input.touchMove = { x: 0, y: 0 };
        a.input.touchJump = false;
        run(30);
        a.view.digFx.flushAll();
        return { crab: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)], ground: +a.world.groundAt(c.x, c.z).toFixed(2), prims: a.world.dig.count };
      },
    };
  });
  const shots = O.shots ?? [];
  const out = [];
  for (const s of shots) {
    if (O.only && !O.only.includes(s.name)) continue;
    if (s.prep) out.push({ name: s.name, prep: await p.evaluate((q) => window.__cam.dig(q.at, q.heading, q.seconds, q.opt), s.prep) });
    const r = await p.evaluate((q) => window.__cam.place(q), s);
    if (O.dir && !s.noShot) await p.screenshot({ path: await shotPath(`${O.dir}/${O.tag}-${s.name}.jpg`), type: 'jpeg', quality: 82 });
    const sw = s.sweep ? await p.evaluate((q) => window.__cam.sweep(q.sweep, q.sweepPitch), s) : null;
    out.push({ name: s.name, ...r, sweep: sw });
  }
  await ctx.close();
  return { errors, out: out.map((r) => JSON.stringify(r)) };
}
