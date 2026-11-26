// 第 2 段階：スマホの「挟む」スイッチの検証（Playwright + CDP のタッチ。Chromium のスマホの模擬 390×844。iOS Safari ではない）。
// 1 回たたくと閉じる・もう一度で開く／閉じたままジャンプ・ダッシュ・移動・視点／指の取り消し・releaseAll（アプリの切り替え）・
// 画面の回転で状態がずれない／滑った・瞬間移動で開いたらスイッチも開く。globalThis.__over = { dir, tag } で画像の保存先
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: null, tag: 'touch', shots: true }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch(`${O.host}/docs/aquarium/tools/out_guard.js`)).text())(O);
  const out = [];
  const errs = [];
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${O.host}/aquarium.html?nosave&t=${Date.now()}`);
  await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 120000 });
  await p.evaluate(() => { __aqua.help.close(); });
  await p.waitForTimeout(300);
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2] ?? 1, radiusX: 4, radiusY: 4, force: 1 })) });
  const center = (sel) => p.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
  const st = () => p.evaluate(() => {
    const a = __aqua, b = document.querySelector('#touch-ui .grab');
    return { latch: a.input.touchGrabLatch, on: b.classList.contains('on'), label: b.querySelector('span:not(.face)')?.textContent || b.getAttribute('aria-label'), aria: b.getAttribute('aria-pressed'), grab: a.grab.state, pointers: a.input.activePointers, run: a.input.touchRun, jump: a.input.touchJump, move: { ...a.input.touchMove } };
  });
  const tap = async (sel, id = 1) => { const c = await center(sel); await touch('touchStart', [[c[0], c[1], id]]); await touch('touchEnd', []); await p.waitForTimeout(120); };
  const check = (name, ok, info) => out.push({ name, ok: !!ok, info });
  const shot = async (name) => { if (O.shots && O.dir) await p.screenshot({ path: await shotPath(`${O.dir}/${O.tag}_${name}.jpg`), type: 'jpeg', quality: 80 }); };

  // スタート地点の貝殻の前へ（挟む物がある所）
  await p.evaluate(() => { const a = __aqua, pr = a.props.props.find((q) => q.id === 'shell0'); a.crab.teleport(pr.p[0] - 0.5, pr.p[2] - 0.3); a.crab.heading = Math.PI / 2; a.camera.placeBehind(a.crab); });
  await p.waitForTimeout(400);
  // 1. 1 回たたく：閉じる
  await tap('#touch-ui .grab');
  await p.waitForTimeout(300);
  const s1 = await st();
  check('1 回たたくとスイッチが閉じ（明るい・離す・aria-pressed）、ハサミが閉じる', s1.latch && s1.on && s1.label === '離す' && s1.aria === 'true' && s1.grab !== 'idle' && s1.pointers === 0, s1);
  await shot('latched');
  // 2. 閉じたまま、別の指でジャンプ
  const y0 = await p.evaluate(() => __aqua.crab.y);
  await tap('#touch-ui .jump', 2);
  await p.waitForTimeout(250);
  const s2 = await st();
  const dy = await p.evaluate((y0) => __aqua.crab.y - y0, y0);
  check('閉じたままジャンプできる（スイッチは閉じたまま）', s2.latch && s2.on && dy > 0.05, { ...s2, dy });
  await p.waitForTimeout(600);
  // 3. 閉じたまま、スティック + ダッシュ（2 本指）
  const sc = await center('#touch-ui .stick'), rc = await center('#touch-ui .run');
  const x0 = await p.evaluate(() => [__aqua.crab.x, __aqua.crab.z]);
  await touch('touchStart', [[sc[0], sc[1], 1]]);
  await touch('touchMove', [[sc[0] + 40, sc[1], 1]]);
  await touch('touchStart', [[sc[0] + 40, sc[1], 1], [rc[0], rc[1], 2]]);
  await p.waitForTimeout(500);
  const s3 = await st();
  const moved = await p.evaluate((x0) => Math.hypot(__aqua.crab.x - x0[0], __aqua.crab.z - x0[1]), x0);
  check('閉じたまま移動 + ダッシュ（2 本指）', s3.latch && s3.run && s3.move.x > 0.5 && moved > 0.3, { ...s3, moved });
  // 4. 指の取り消し（touchcancel）：指は終わり、スイッチは閉じたまま
  await touch('touchCancel', []);
  await p.waitForTimeout(200);
  const s4 = await st();
  check('指の取り消しで指は離れ、スイッチは閉じたまま', s4.latch && s4.on && !s4.run && s4.move.x === 0 && s4.pointers === 0, s4);
  // 5. 閉じたまま画面のドラッグ（視点）
  const yaw0 = await p.evaluate(() => __aqua.camera.yaw);
  await touch('touchStart', [[200, 300, 3]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[200 + i * 20, 300, 3]]);
  await touch('touchEnd', []);
  await p.waitForTimeout(150);
  const dyaw = await p.evaluate((yaw0) => __aqua.camera.yaw - yaw0, yaw0);
  check('閉じたまま視点を回せる', Math.abs(dyaw) > 0.05 && (await st()).latch, { dyaw });
  // 6. アプリの切り替え（releaseAll）・画面の回転
  await p.evaluate(() => { __aqua.input.releaseAll(); });
  await p.setViewportSize({ width: 844, height: 390 });
  await p.waitForTimeout(900);
  const s6 = await st();
  check('releaseAll（アプリの切り替え等）・横へ回転しても、スイッチとハサミがそろったまま', s6.latch && s6.on && s6.grab !== 'idle', s6);
  await shot('latched_landscape');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(700);
  // 7. もう一度たたく：開く
  await tap('#touch-ui .grab');
  await p.waitForTimeout(250);
  const s7 = await st();
  check('もう一度たたくと開く（挟むに戻る・ハサミが開く）', !s7.latch && !s7.on && s7.label === '挟む' && s7.grab === 'idle', s7);
  // 8. 挟んでいる間に滑った・瞬間移動：スイッチも開く
  await p.evaluate(() => { const a = __aqua, pr = a.props.props.find((q) => q.id === 'pebble2'); a.props.reset(pr); a.crab.teleport(pr.p[0] - 0.55, pr.p[2]); a.crab.heading = Math.PI / 2; });
  await p.waitForTimeout(500);
  await tap('#touch-ui .grab');
  await p.waitForTimeout(1500);
  const s8a = await st();
  await p.evaluate(() => { __aqua.goto('spawn'); });
  await p.waitForTimeout(300);
  const s8 = await st();
  check('瞬間移動でハサミが開いたら、スイッチも開く', s8a.latch && !s8.latch && !s8.on && s8.grab === 'idle', { before: s8a, after: s8 });
  await ctx.close();
  return { pass: out.filter((o) => o.ok).length + '/' + out.length, out, errs };
}
