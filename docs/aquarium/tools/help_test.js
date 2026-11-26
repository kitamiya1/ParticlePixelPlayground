// 操作の説明の欄（AquaHelp.ts）の検証。スマホ（390×844 の縦・844×390 の横、タッチ）と PC（1280×800）。
// - 初回：スマホは短い案内、PC は詳しい説明。「×」ですぐ閉じ、localStorage に覚える → 読み込み直しても出ない
// - 「？」で詳しい説明を開く・閉じる。PC は H キーでも
// - 欄の中の 1 本指のスクロールで、欄がスクロールし、カメラ・カニは動かない。欄の上のピンチでページもカメラも拡大しない
// - スティックを押したまま欄をスクロールしても、スティックは効いたまま
// - 縦横どちらでも欄が画面に収まる
// ?nosave で開く。globalThis.__over = { dir, tag } で画像の保存先
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: null, tag: 'help' }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js')).text())(O);
  const out = [];
  const ok = (label, cond, extra) => out.push(`${cond ? 'OK ' : 'NG '} ${label}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`);
  const open = async (p) => {
    await p.goto(`${O.host}/aquarium.html?nosave&${Date.now()}`);
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 120000 });
    await p.waitForTimeout(300);
  };
  const st = (p) => p.evaluate(() => {
    const h = document.getElementById('help'), r = h.getBoundingClientRect(), b = h.querySelector('.help-body');
    const vis = getComputedStyle(h).display !== 'none';
    return { state: window.__aqua.help.state, vis, rect: vis ? [r.left, r.top, r.right, r.bottom].map(Math.round) : null, vw: innerWidth, vh: innerHeight, key: localStorage.getItem('ppp-aquarium:help'), scrollTop: Math.round(b.scrollTop), scrollable: b.scrollHeight > b.clientHeight + 2 };
  });
  const inView = (s) => !!s.rect && s.rect[0] >= 0 && s.rect[1] >= 0 && s.rect[2] <= s.vw && s.rect[3] <= s.vh;
  const shot = async (p, name) => { if (O.dir) await p.screenshot({ path: await shotPath(`${O.dir}/${O.tag}_${name}.jpg`), type: 'jpeg', quality: 80 }); };
  const errors = [];

  // ---------------- スマホ ----------------
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await open(p);
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) });
  let s = await st(p);
  ok('スマホ 初回は短い案内', s.state === 'brief' && s.vis && inView(s), s);
  await shot(p, 'portrait_brief');
  // 「詳しい説明を見る」→ 詳しい説明
  await p.locator('#help .help-more').tap();
  s = await st(p);
  ok('「詳しい説明を見る」で詳しい説明', s.state === 'full' && inView(s), s);
  await shot(p, 'portrait_full');
  // 欄の中を 1 本指で上へなぞる（スクロール）：カメラ・カニは動かない
  const game0 = await p.evaluate(() => { const a = window.__aqua; return { yaw: a.camera.adventure.yaw, pitch: a.camera.adventure.pitch, zoom: a.camera.adventure.zoom, x: a.crab.x, z: a.crab.z }; });
  const hb = await p.evaluate(() => { const r = document.querySelector('#help .help-body').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height * 0.7]; });
  await touch('touchStart', [[hb[0], hb[1], 1]]);
  for (let k = 1; k <= 8; k++) { await touch('touchMove', [[hb[0] + k * 2, hb[1] - k * 18, 1]]); await p.waitForTimeout(16); }
  await touch('touchEnd', []);
  await p.waitForTimeout(400);
  const game1 = await p.evaluate(() => { const a = window.__aqua; return { yaw: a.camera.adventure.yaw, pitch: a.camera.adventure.pitch, zoom: a.camera.adventure.zoom, x: a.crab.x, z: a.crab.z, pointers: a.input.activePointers, viewTouches: a.input.viewTouchCount }; });
  s = await st(p);
  const still = Math.abs(game1.yaw - game0.yaw) < 1e-4 && Math.abs(game1.pitch - game0.pitch) < 1e-4 && Math.abs(game1.zoom - game0.zoom) < 1e-4 && Math.hypot(game1.x - game0.x, game1.z - game0.z) < 0.01;
  ok('縦：欄の中のスクロールはゲームの視点・移動にならない', still && game1.pointers === 0 && game1.viewTouches === 0, { scrollTop: s.scrollTop, scrollable: s.scrollable, game0, game1 });
  // 欄の上でピンチ：ページもカメラも拡大しない
  await touch('touchStart', [[hb[0] - 20, hb[1] - 60, 2], [hb[0] + 20, hb[1] - 20, 3]]);
  for (let k = 1; k <= 6; k++) { await touch('touchMove', [[hb[0] - 20 - k * 10, hb[1] - 60 - k * 10, 2], [hb[0] + 20 + k * 10, hb[1] - 20 + k * 10, 3]]); await p.waitForTimeout(16); }
  await touch('touchEnd', []);
  await p.waitForTimeout(300);
  const pz = await p.evaluate(() => ({ scale: visualViewport.scale, zoom: window.__aqua.camera.adventure.zoom, blocked: window.__aqua.viewport.stats.touchmoveBlocked }));
  ok('欄の上のピンチでページもカメラも拡大しない', pz.scale === 1 && Math.abs(pz.zoom - game0.zoom) < 1e-4, pz);
  // スティックを押したまま、欄をスクロール：スティックは効いたまま
  const stick = await p.evaluate(() => { const r = document.querySelector('#touch-ui .stick').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await touch('touchStart', [[stick[0], stick[1], 4]]);
  await touch('touchMove', [[stick[0], stick[1] - 40, 4]]);
  await touch('touchStart', [[stick[0], stick[1] - 40, 4], [hb[0], hb[1], 5]]);
  for (let k = 1; k <= 5; k++) await touch('touchMove', [[stick[0], stick[1] - 40, 4], [hb[0], hb[1] - k * 15, 5]]);
  const mv = await p.evaluate(() => ({ ...window.__aqua.input.touchMove }));
  await touch('touchEnd', []);
  await p.waitForTimeout(200);
  const mv2 = await p.evaluate(() => ({ ...window.__aqua.input.touchMove, pointers: window.__aqua.input.activePointers }));
  ok('スティックを押したまま欄をスクロールしてもスティックが効く・離すと戻る', mv.y > 0.5 && mv2.x === 0 && mv2.y === 0 && mv2.pointers === 0, { mv, mv2 });
  // 横画面：詳しい説明が画面に収まる（はみ出す分は中でスクロール）
  await p.setViewportSize({ width: 844, height: 390 });
  await p.waitForTimeout(600);
  s = await st(p);
  ok('横：詳しい説明が画面に収まる（収まらない分は中でスクロール）', inView(s), s);
  await shot(p, 'landscape_full');
  // 背の低い横画面（iPhone SE の横＋ブラウザのバー：667×320）：欄の中でスクロールし、ゲームは動かない
  await p.setViewportSize({ width: 667, height: 320 });
  await p.waitForTimeout(600);
  s = await st(p);
  const g2 = await p.evaluate(() => { const a = window.__aqua; return [a.camera.adventure.yaw, a.camera.adventure.pitch, a.camera.adventure.zoom, a.crab.x, a.crab.z]; });
  const hb2 = await p.evaluate(() => { const r = document.querySelector('#help .help-body').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height * 0.8]; });
  await touch('touchStart', [[hb2[0], hb2[1], 6]]);
  for (let k = 1; k <= 8; k++) { await touch('touchMove', [[hb2[0], hb2[1] - k * 22, 6]]); await p.waitForTimeout(16); }
  await touch('touchEnd', []);
  await p.waitForTimeout(500);
  const s2 = await st(p);
  const g3 = await p.evaluate(() => { const a = window.__aqua; return [a.camera.adventure.yaw, a.camera.adventure.pitch, a.camera.adventure.zoom, a.crab.x, a.crab.z]; });
  ok('背の低い横画面：欄の中でスクロールでき、ゲームは動かない', inView(s) && s.scrollable && s2.scrollTop > 20 && g2.every((v, i) => Math.abs(v - g3[i]) < 1e-3), { before: s, scrollTop: s2.scrollTop });
  await shot(p, 'se_landscape_scrolled');
  await p.setViewportSize({ width: 844, height: 390 });
  await p.waitForTimeout(400);
  // 「×」で閉じる → 覚える
  await p.locator('#help .help-close').tap();
  s = await st(p);
  ok('「×」ですぐ閉じ、閉じたことを覚える', s.state === 'closed' && !s.vis && s.key === 'closed', s);
  await shot(p, 'landscape_closed');
  // 読み込み直す → 自動で出ない、「？」で開ける
  await open(p);
  s = await st(p);
  ok('次の起動：自動で出ない', s.state === 'closed' && !s.vis, s);
  await p.locator('#menu .help-btn').tap();
  s = await st(p);
  ok('「？」で詳しい説明を開く（横）', s.state === 'full' && inView(s), s);
  await p.locator('#menu .help-btn').tap();
  s = await st(p);
  ok('「？」をもう一度押すと閉じる', s.state === 'closed' && !s.vis, s);
  // 横画面の初回の短い案内
  await p.evaluate(() => localStorage.removeItem('ppp-aquarium:help'));
  await open(p);
  s = await st(p);
  ok('横：初回の短い案内が画面に収まる', s.state === 'brief' && inView(s), s);
  await shot(p, 'landscape_brief');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(400);
  await p.locator('#menu .help-btn').tap();
  await p.locator('#menu .help-btn').tap();
  await open(p);
  s = await st(p);
  ok('縦：閉じた後の画面（「？」だけ）', s.state === 'closed', s);
  await shot(p, 'portrait_closed');
  await ctx.close();

  // ---------------- PC ----------------
  const pc = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  const q = await pc.newPage();
  q.on('pageerror', (e) => errors.push(String(e)));
  await open(q);
  s = await st(q);
  // （第 6 段階：PC も初回は短い案内。以前は詳しい説明）
  ok('PC 初回は短い案内', s.state === 'brief' && inView(s), s);
  await shot(q, 'pc_brief');
  await q.keyboard.press('KeyH');
  s = await st(q);
  ok('PC：H で閉じる（覚える）', s.state === 'closed' && s.key === 'closed', s);
  await q.keyboard.press('KeyH');
  s = await st(q);
  ok('PC：H で開く', s.state === 'full', s);
  // 欄の上でホイール：カメラのズームにしない
  const z0 = await q.evaluate(() => window.__aqua.camera.adventure.zoom);
  const hc = await q.evaluate(() => { const r = document.querySelector('#help .help-body').getBoundingClientRect(); return [r.left + 40, r.top + 30]; });
  await q.mouse.move(hc[0], hc[1]);
  await q.mouse.wheel(0, 300);
  await q.waitForTimeout(300);
  ok('PC：欄の上のホイールはカメラのズームにならない', Math.abs((await q.evaluate(() => window.__aqua.camera.adventure.zoom)) - z0) < 1e-4);
  await q.locator('#help .help-close').click();
  await open(q);
  s = await st(q);
  ok('PC：閉じた後の起動で出ない', s.state === 'closed', s);
  await pc.close();
  out.push(`errors ${JSON.stringify(errors)}`);
  return out.join('\n');
}
