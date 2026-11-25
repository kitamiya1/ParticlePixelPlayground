// スマホの操作で、移動（左のスティック）と掘る向き（掘るボタンを押したまま指をずらす）が別々に効くかの検証
// （Playwright + CDP Input.dispatchTouchEvent。設定は freedig_config.json { host, base, dir }。390×844 のタッチ端末）。
// 岸の斜面の前（体の向き +x、カメラは体の後ろ）で、実際のタッチの指を動かして 1 秒進める：
//   1. 掘る指を上へ + スティックを前へ → 上を掘りながら前へ
//   2. 掘る指を右へ + スティックを左へ → 右を掘りながら左へ
//   3. スティックを離して、掘る指だけ左 → 右へずらす → その場で掘る向きだけ変わる
// 動いた向き（カメラ基準：前 = 0、右 = +π/2）・動いた距離・掘る向き（押したときからの方位の変化・仰角）を、host と base で返す。
// dir があれば、各項目の終わりの画面を `${dir}/touch-indep-${build}-${n}.jpg` に撮る。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/freedig_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  // 画像を保存する前に、同じ名前の画像が既に無いか確かめる（out_guard.js。過去の報告の画像を上書きしない）
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js?' + Date.now())).text())(O);
  await cfgPage.close();
  const out = {};
  for (const [name, host] of [['after', O.host], ...(O.base ? [['before', O.base]] : [])]) {
    const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(host + '/aquarium.html?nosave&' + Date.now());
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    await p.evaluate(() => document.getElementById('help')?.classList.add('fade'));
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) });
    const rect = async (sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
    const stick = await rect('#touch-ui .stick');
    const dig = await rect('#touch-ui .dig');
    const place = () => p.evaluate(() => { const a = window.__aqua, c = a.crab; a.freeze = true; c.teleport(-4.6, 8.3); c.heading = Math.PI / 2; a.camera.placeBehind(c); a.camera.adventure.yaw = c.heading + Math.PI; a.camera.adventure.pitch = 0.3; a.freeze = false; a.step(30); a.freeze = true; window.__s0 = { x: c.x, z: c.z, cam: a.camera.yaw }; });
    // n フレーム進めて、押したときからの変化を読む
    const step = async (n) => { await p.waitForTimeout(40); return p.evaluate((n) => {
      const a = window.__aqua, c = a.crab, s = window.__s0;
      a.freeze = false; a.step(n, 1 / 60); a.freeze = true;
      if (s.yaw0 === undefined) s.yaw0 = c.digYaw;
      const mx = c.x - s.x, mz = c.z - s.z, moved = Math.hypot(mx, mz);
      const fx = -Math.sin(s.cam), fz = -Math.cos(s.cam), rx = Math.cos(s.cam), rz = -Math.sin(s.cam);
      const w = (v) => +Math.atan2(Math.sin(v), Math.cos(v)).toFixed(2);
      return { moved: +moved.toFixed(2), moveDirCam: moved > 0.05 ? +Math.atan2(mx * rx + mz * rz, mx * fx + mz * fz).toFixed(2) : null, digYawFromPress: w(c.digYaw - s.yaw0), digPitch: +c.digPitch.toFixed(2), state: c.state };
    }, n); };
    const res = {};
    const shot = async (n) => { if (O.dir) await p.screenshot({ path: await shotPath(`${O.dir}/touch-indep-${name}-${n}.jpg`), type: 'jpeg', quality: 80 }); };
    // 1. 上を掘りながら前へ
    await place();
    await touch('touchStart', [[dig[0], dig[1], 1]]);
    await step(1);
    await touch('touchMove', [[dig[0], dig[1] - 60, 1]]);
    await touch('touchStart', [[dig[0], dig[1] - 60, 1], [stick[0], stick[1], 2]]);
    await touch('touchMove', [[dig[0], dig[1] - 60, 1], [stick[0], stick[1] - 45, 2]]);
    res['1. 上を掘りながら前へ'] = await step(60);
    await shot(1);
    await touch('touchEnd', []);
    await p.waitForTimeout(120);
    // 2. 右を掘りながら左へ
    await place();
    await touch('touchStart', [[dig[0], dig[1], 1]]);
    await step(1);
    await touch('touchMove', [[dig[0] + 60, dig[1], 1]]);
    await touch('touchStart', [[dig[0] + 60, dig[1], 1], [stick[0], stick[1], 2]]);
    await touch('touchMove', [[dig[0] + 60, dig[1], 1], [stick[0] - 45, stick[1], 2]]);
    res['2. 右を掘りながら左へ'] = await step(60);
    await shot(2);
    await touch('touchEnd', []);
    await p.waitForTimeout(120);
    // 3. その場で掘る向きだけ（左 → 右）
    await place();
    await touch('touchStart', [[dig[0], dig[1], 1]]);
    await step(1);
    await touch('touchMove', [[dig[0] - 60, dig[1], 1]]);
    const left = await step(30);
    await touch('touchMove', [[dig[0] + 60, dig[1], 1]]);
    const right = await step(30);
    await shot(3);
    res['3. その場で向きだけ（左 → 右）'] = { left, right };
    await touch('touchEnd', []);
    await p.waitForTimeout(120);
    res.afterRelease = await p.evaluate(() => { const i = window.__aqua.input; return { dig: i.isDigHeld(), move: i.moveAxis(), aim: i.digAim() }; });
    res.errors = errors;
    out[name] = res;
    await ctx.close();
  }
  return out;
}
