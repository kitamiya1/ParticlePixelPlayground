// スマホの掘るボタンの照準（押したまま指をずらす）の操作テスト（Playwright + CDP Input.dispatchTouchEvent）。
// 設定は freedig_config.json（{ host }）。390×844 のタッチ端末で、
// 1. 掘るボタンを押して 8 方向・遠くまでずらす → Input.digAim() とカニの掘る向き（方位・仰角）
// 2. スティック + 掘るボタンを同時に押してずらす → 移動・照準の両方が効くか、カニが掘る向きへ進むか
// 3. 指をボタンの外（画面の反対側）までずらしても続くか、離したら照準・掘る・移動が残らないか
// 4. 照準をずらしたまま指を離した通知が失われた（WebKit の取りこぼしの模擬）→ 照合で戻るか
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/freedig_config.json?' + Date.now());
  const O = JSON.parse(await cfgPage.evaluate(() => document.body.innerText));
  await cfgPage.close();
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    window.__dropN = 0;
    const f = (e) => { if (e.pointerType === 'touch' && window.__dropN > 0) { window.__dropN--; e.stopImmediatePropagation(); } };
    window.addEventListener('pointerup', f, true);
    window.addEventListener('pointercancel', f, true);
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto((O.host ?? 'http://localhost:5173') + '/aquarium.html?' + Date.now());
  await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) });
  const rect = async (sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
  const stick = await rect('#touch-ui .stick');
  const dig = await rect('#touch-ui .dig');
  // 掘れる場所（岸の斜面の前）に置いて、ゲームは止める（検査のときだけ進める）
  await p.evaluate(() => { const a = window.__aqua, c = a.crab; a.freeze = true; c.teleport(-4.6, 8.3); c.heading = Math.PI / 2; a.camera.placeBehind(c); a.camera.adventure.yaw = c.heading + Math.PI; a.freeze = false; a.step(30); a.freeze = true; });
  // pointermove は次のフレームにまとめて届くので、読む前に少し待つ
  const read = async (n = 0) => { await p.waitForTimeout(40); return p.evaluate((n) => {
    const a = window.__aqua, i = a.input, c = a.crab;
    const x0 = c.x, z0 = c.z;
    if (n) { a.freeze = false; a.step(n, 1 / 60); a.freeze = true; }
    const aim = i.digAim();
    const mark = document.querySelector('#touch-ui .dig .aim');
    return { aim: [+aim.x.toFixed(2), +aim.y.toFixed(2)], dig: i.isDigHeld(), move: [+i.touchMove.x.toFixed(2), +i.touchMove.y.toFixed(2)], digYaw: +c.digYaw.toFixed(2), digPitch: +c.digPitch.toFixed(2), state: c.state, moved: +Math.hypot(c.x - x0, c.z - z0).toFixed(3), mark: mark ? mark.style.transform || '-' : null, btnOn: document.querySelector('#touch-ui .dig').classList.contains('on') };
  }, n); };
  const out = [];
  // 1. 8 方向 + 遠く（画面の外寄り）
  const dirs = [['上', 0, -1], ['右上', 1, -1], ['右', 1, 0], ['右下', 1, 1], ['下', 0, 1], ['左下', -1, 1], ['左', -1, 0], ['左上', -1, -1]];
  for (const [name, sx, sy] of dirs) {
    const L = Math.hypot(sx, sy);
    await touch('touchStart', [[dig[0], dig[1], 1]]);
    const r0 = await read(12);
    await touch('touchMove', [[dig[0] + (sx / L) * 30, dig[1] + (sy / L) * 30, 1]]);
    const rHalf = await read();
    await touch('touchMove', [[dig[0] + (sx / L) * 60, dig[1] + (sy / L) * 60, 1]]);
    await touch('touchMove', [[dig[0] + (sx / L) * 200, dig[1] + (sy / L) * 200, 1]]);
    const rFar = await read(30);
    await touch('touchEnd', []);
    await p.waitForTimeout(120);
    const rEnd = await read(10);
    out.push({ test: `1. ${name}`, press: r0.aim, half: rHalf.aim, far: rFar.aim, farPitch: rFar.digPitch, farYawFromPress: +Math.atan2(Math.sin(rFar.digYaw - r0.digYaw), Math.cos(rFar.digYaw - r0.digYaw)).toFixed(2), mark: rFar.mark, afterRelease: { aim: rEnd.aim, dig: rEnd.dig, state: rEnd.state, btnOn: rEnd.btnOn } });
  }
  // 2. スティック（前）+ 掘るボタンを右上へずらす → 0.6 秒
  await touch('touchStart', [[stick[0], stick[1], 2]]);
  await touch('touchMove', [[stick[0], stick[1] - 45, 2]]);
  await touch('touchStart', [[stick[0], stick[1] - 45, 2], [dig[0], dig[1], 3]]);
  await touch('touchMove', [[stick[0], stick[1] - 45, 2], [dig[0] + 25, dig[1] - 25, 3]]);
  const both = await read(36);
  // 3. 掘る指をボタンの外（画面の左上）まで動かしても続く
  await touch('touchMove', [[stick[0], stick[1] - 45, 2], [40, 120, 3]]);
  const outside = await read(6);
  await touch('touchEnd', [[40, 120, 3]]);
  await p.waitForTimeout(120);
  const digReleased = await read(6);
  await touch('touchEnd', []);
  await p.waitForTimeout(120);
  const allReleased = await read(10);
  out.push({ test: '2. スティック前 + 掘る右上', aim: both.aim, move: both.move, dig: both.dig, state: both.state, moved: both.moved, digPitch: both.digPitch });
  out.push({ test: '3a. 掘る指を画面の左上（ボタンの外）まで', aim: outside.aim, dig: outside.dig, move: outside.move });
  out.push({ test: '3b. 掘る指だけ離す', aim: digReleased.aim, dig: digReleased.dig, move: digReleased.move, state: digReleased.state });
  out.push({ test: '3c. 全部離す', aim: allReleased.aim, dig: allReleased.dig, move: allReleased.move, moved: allReleased.moved, state: allReleased.state });
  // 4. 照準をずらしたまま、掘る指の離した通知が失われた → タッチの一覧との照合で戻る
  await touch('touchStart', [[dig[0], dig[1], 4]]);
  await touch('touchMove', [[dig[0] + 40, dig[1] - 40, 4]]);
  await p.evaluate(() => { window.__dropN = 1; });
  await touch('touchEnd', []);
  await p.evaluate(() => { window.__dropN = 0; });
  await p.waitForTimeout(250);
  const lost = await read(10);
  out.push({ test: '4. 照準中に離した通知が失われた', aim: lost.aim, dig: lost.dig, state: lost.state, btnOn: lost.btnOn, moved: lost.moved });
  const recovered = await p.evaluate(() => window.__aqua.input.recovered);
  await ctx.close();
  return { out, recovered, errors };
}
