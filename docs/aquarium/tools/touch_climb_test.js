// スマホの仮想スティック（実ブラウザのタッチ入力。CDP Input.dispatchTouchEvent）で壁登り：
// 岩の垂直面の下に置き、スティックを上（= カメラの前 = 壁へ）に倒して登る → 離して止まる → 下へ倒して降りる → 左右で横へ。
async (page) => {
  const host = 'http://localhost:5173';
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const logs = [];
  p.on('pageerror', (e) => logs.push(String(e)));
  await p.goto(host + '/aquarium.html?nosave&' + Date.now());
  await p.waitForFunction(() => window.__aqua, null, { timeout: 120000 });
  const cdp = await ctx.newCDPSession(p);
  // スティックの状態はページ側で次の描画フレームに反映されるので、送ったあと少し待つ
  const touch = async (type, pts) => { await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) }); await p.waitForTimeout(80); };
  const stick = await p.evaluate(() => { const r = document.querySelector('#touch-ui .stick').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await p.evaluate(() => {
    const a = window.__aqua, c = a.crab;
    a.freeze = true;
    c.teleport(13.3, -1.6, a.world.contactSurfaceBelow(13.3, 12, -1.6) + 0.02);
    c.heading = 0;
    a.camera.adventure.yaw = -Math.PI / 2;
    a.camera.adventure.pitch = 0.3;
    a.freeze = false; a.step(30); a.freeze = true;
  });
  const go = (n, label) => p.evaluate(([n, label]) => {
    const a = window.__aqua, c = a.crab;
    const y0 = c.y + c.radius, x0 = c.x, z0 = c.z;
    a.freeze = false; a.step(n); a.freeze = true;
    return { label, move: [+a.input.touchMove.x.toFixed(2), +a.input.touchMove.y.toFixed(2)], state: c.state, climbing: c.climbing, dy: +(c.y + c.radius - y0).toFixed(3), dxz: +Math.hypot(c.x - x0, c.z - z0).toFixed(3), y: +(c.y + c.radius).toFixed(2) };
  }, [n, label]);
  const out = [];
  await touch('touchStart', [[stick[0], stick[1], 1]]);
  await touch('touchMove', [[stick[0], stick[1] - 45, 1]]);
  out.push(await go(90, 'スティック上（壁へ）1.5 秒'));
  await touch('touchEnd', []);
  out.push(await go(60, '離す 1 秒'));
  await touch('touchStart', [[stick[0], stick[1], 2]]);
  await touch('touchMove', [[stick[0] + 45, stick[1], 2]]);
  out.push(await go(45, 'スティック右（横）0.75 秒'));
  await touch('touchMove', [[stick[0] - 45, stick[1], 2]]);
  out.push(await go(45, 'スティック左（横）0.75 秒'));
  await touch('touchMove', [[stick[0], stick[1] + 45, 2]]);
  out.push(await go(150, 'スティック下（手前＝降りる）2.5 秒'));
  await touch('touchEnd', []);
  out.push(await go(10, '離す'));
  await ctx.close();
  return { out, logs };
}
