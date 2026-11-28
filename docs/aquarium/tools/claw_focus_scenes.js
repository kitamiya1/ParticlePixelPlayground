// ハサミ集中モードの場面の画像（Playwright の browser_run_code_unsafe の filename で実行。1280×800）。
// docs/aquarium/claw-focus/ へ：scene-1-tower（積み木 5 段と棒の橋）・scene-2-two-hands（両方の鋏で棒を持ち上げる）・
// scene-3-marks（狙う物の印：閉じると挟む物の点・鋏の下の影と高さの線）・scene-4-worm（ゴカイを左右の鋏で引き伸ばす）・
// scene-5-placed（鋏で 1 個を積んだ所）。globalThis.__over = { host, dir } で上書き
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: 'docs/aquarium/claw-focus' }, globalThis.__over ?? {});
  const ctx = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${O.host}/aquarium.html?nosave&${Date.now()}`, { timeout: 120000 });
  await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 240000 });
  await p.evaluate(async (h) => {
    for (const f of ['focus_helpers', 'blocks_test', 'claw_focus_test', 'claw_scheme_compare', 'worm_helpers']) await fetch(`${h}/docs/aquarium/tools/${f}.js?${Date.now()}`).then((r) => r.text()).then(eval);
    window.__aqua.help?.close?.();
  }, O.host);
  // （描画は実際のループで：止めた検証の後に 0.6 秒だけ動かしてから撮る。動かす間の入力は無し）
  const shot = async (name) => {
    await p.evaluate(() => { window.__aqua.freeze = false; });
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${O.dir}/${name}.jpg`, type: 'jpeg', quality: 82 });
  };
  const out = {};
  // 1. 積み木 5 段（1 段ずつ）と、石の台 2 つに渡した棒
  out.tower = await p.evaluate(() => {
    const A = window.__aqua, P = A.props, B = window.__blocks, X = window.__focus;
    X.setup();
    A.setFocus(false);
    B.reset();
    const bl = A.blocks.filter((b) => b.kind === 'block'), F = P.props.find((q) => q.fixed), T = F.p[1] + F.semi[1];
    const cx = A.crab.x + 0.25, cz = A.crab.z + 0.7;
    for (let i = 0; i < 5; i++) {
      P.place(bl[i], [cx, T + 0.051 + i * 0.1015, cz], [0, Math.sin(i * 0.12), 0, Math.cos(i * 0.12)]);
      B.run(90);
    }
    const [p1, p2] = A.blocks.filter((b) => b.kind === 'pillar'), [rod] = A.blocks.filter((b) => b.kind === 'rod');
    P.place(rod, [(p1.p[0] + p2.p[0]) / 2, p1.p[1] + p1.semi[1] + rod.semi[1] + 0.006, (p1.p[2] + p2.p[2]) / 2], [0, 0, 0, 1]);
    B.run(240);
    A.camera.placeBehind(A.crab);
    A.setFocus(true);
    X.run(40);
    return { top: +(bl[4].p[1] - T).toFixed(3), rodOn: +(rod.p[1] - (p1.p[1] + p1.semi[1])).toFixed(3) };
  });
  await shot('scene-1-tower');
  // 3. 印：右の鋏を積み木の手前へ寄せた所（閉じると挟む物の点・影と高さの線）
  out.marks = await p.evaluate(() => {
    const X = window.__focus, A = window.__aqua;
    X.setup();
    const b = X.blocks('block')[2];
    const g = X.grab('R', b, { squeeze: 0 });
    A.marks?.update?.();
    return { at: g.err, hint: A.grab.hint?.id ?? null };
  });
  await shot('scene-3-marks');
  // 5. 鋏で積み木を隣の積み木の上へ置いた所
  out.placed = await p.evaluate(() => JSON.parse(JSON.stringify(window.__schemeCompare.place('surface'))));
  await p.evaluate(() => { window.__aqua.camera.placeBehind(window.__aqua.crab); });
  await shot('scene-5-placed');
  // 4. ゴカイ：右で頭の近く・左で尾の近くを挟んで引き伸ばす（claw_focus_test の worm と同じ流れの途中で撮る。棒より先に：
  //    棒を両方で持ったままモードを切り替えても持ったままなので、その後ではゴカイを挟めない）
  out.worm = await p.evaluate(() => JSON.parse(JSON.stringify(window.__clawTest.worm({ hold: true }))));
  // （後ろからだと甲羅の陰になるので、横から）
  await p.evaluate(() => { window.__aqua.camera.adventure.yaw += 1.0; });
  await p.waitForTimeout(300);
  await shot('scene-4-worm');
  await p.evaluate(() => { const X = window.__focus; X.ctl('R', { close: 0 }); X.ctl('L', { close: 0 }); X.run(40); X.release(); });
  // 2. 両方の鋏で棒を持ち上げる（持ったまま撮る）
  out.rod = await p.evaluate(() => {
    const X = window.__focus, A = window.__aqua;
    X.setup();
    // （claw_focus_test の twoHands と同じ置き方・挟み方）
    const rod = X.blocks('rod')[1], F = A.props.props.find((q) => q.fixed), c = A.crab;
    A.props.place(rod, [c.x, F.p[1] + F.semi[1] + rod.semi[1] + 0.003, c.z + 0.34], [0, 0, 0, 1]);
    X.run(30);
    const R = X.grab('R', rod, { lat: 0.1, off: 0.03 }), L = X.grab('L', rod, { lat: -0.1, off: 0.03 });
    X.ctl('R', { lift: 1 });
    X.ctl('L', { lift: 1 });
    X.run(25);
    X.ctl('R', { lift: 0 });
    X.ctl('L', { lift: 0 });
    X.run(20);
    return { R: R.ok, L: L.ok, holders: rod.holders, y: +rod.p[1].toFixed(3) };
  });
  await shot('scene-2-two-hands');
  out.errors = errors;
  await ctx.close();
  return JSON.stringify(out);
}
