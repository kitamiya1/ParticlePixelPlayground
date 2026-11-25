// ガラス際の巣穴の検証（Playwright。browser_run_code_unsafe の filename で実行。設定は glass_burrow_config.json）。
// 場所ごとに新しいページで：ガラスへ向かって掘る → ガラスに沿って掘る（climb_helpers の digGlass）→
// 1. 断面の検査（glassCheck：外からガラスへ垂直な光線で、三角形と当たり判定の砂を比べる。辺ごと）
// 2. ガラスへ押し付け続けても越えない（ガラスの内面からの距離・区画）
// 3. ガラス際の穴から、掘ってきたトンネルを通って地表へ戻れる（掘った向きの逆へ歩く）・また戻ってこられる
// 4. ガラス越しのカメラ：カメラが水槽の外（ガラスの外面から離れている）・カニが見えるか
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/glass_burrow_config.json?' + Date.now());
  // 実行する側で globalThis.__over に入れた値は設定を上書きする（例：{ host: 'http://localhost:5174' } で変更前と比べる）
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  await cfgPage.close();
  const ctx = await page.context().browser().newContext({ viewport: { width: 640, height: 400 } });
  const out = [];
  for (const site of O.sites) {
    if (O.only && !O.only.includes(site.name)) continue;
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(O.host + '/aquarium.html?nosave&' + Date.now());
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    const r = await p.evaluate(async (site) => {
      await fetch('http://localhost:5173/docs/aquarium/tools/climb_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
      const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, ct = window.__ct;
      const gd = () => Math.min(c.x + 18, 18 - c.x, c.z + 10, 10 - c.z);
      const res = { name: site.name };
      // 区画の作り直しの時間（ガラスに接する区画 / それ以外）
      const fx = a.view.digFx, b0 = fx.build.bind(fx), bt = { edge: [], inner: [] };
      fx.build = (id) => { const t = performance.now(); b0(id); const i = id % w.dig.ncx, j = Math.floor(id / w.dig.ncx); (i === 0 || j === 0 || i === w.dig.ncx - 1 || j === w.dig.ncz - 1 ? bt.edge : bt.inner).push(performance.now() - t); };
      res.dig = ct.digGlass({ ...site, observe: false });
      const sm = (l) => ({ n: l.length, avg: +(l.reduce((x, y) => x + y, 0) / Math.max(1, l.length)).toFixed(2), max: +Math.max(0, ...l).toFixed(2) });
      res.buildMs = { edge: sm(bt.edge), inner: sm(bt.inner) };
      res.check = site.sides.map((sd) => ct.glassCheck(sd));
      // ガラス越しのカメラ
      cam.mode = 'observe'; cam.faceNearestGlass(c);
      a.freeze = false; a.step(20); a.freeze = true;
      const P = cam.pose.pos;
      res.observe = { camOutside: !w.insideTank(P[0], P[2], -0.22 - 0.3), camGlassGap: +Math.max(P[0] - 18.22, -18.22 - P[0], P[2] - 10.22, -10.22 - P[2]).toFixed(2), crabHidden: cam.crabHidden };
      cam.mode = 'adventure';
      // ガラスへ押し付ける（いちばん近いガラスの外向き）
      const ds = [c.x + 18, 18 - c.x, c.z + 10, 10 - c.z], k = ds.indexOf(Math.min(...ds));
      const outDir = k === 0 ? [-1, 0] : k === 1 ? [1, 0] : k === 2 ? [0, -1] : [0, 1];
      let minGd = gd();
      const push = ct.run({ steps: [{ t: 2.5, dir: outDir, run: true }] });
      minGd = Math.min(minGd, gd());
      res.push = { minGlassDist: +minGd.toFixed(3), region: c.region, state: c.state, grabs: push.stats.grabs };
      // 掘ってきたトンネルを通って地表へ（掘った向きの逆）→ もう一度ガラス際へ
      const hx = Math.sin(site.heading), hz = Math.cos(site.heading);
      const depth = () => w.groundAt(c.x, c.z) - c.y - c.radius;
      let outAt = null;
      // ガラスに沿って掘った分を戻ってから（ガラスに着いた所 = 掘ってきたトンネルとのつなぎ目へ向かって歩く）
      const J = res.dig.atGlass.pos;
      for (let i = 0; i < 40 && Math.hypot(c.x - J[0], c.z - J[2]) > 0.35; i++) ct.run({ steps: [{ t: 0.25, dir: [J[0] - c.x, J[2] - c.z] }] });
      res.junction = +Math.hypot(c.x - J[0], c.z - J[2]).toFixed(2);
      for (let i = 0; i < 12 * 60 && outAt === null; i += 30) {
        ct.run({ steps: [{ t: 0.5, dir: [-hx, -hz] }] });
        if (depth() < -0.1) outAt = (i + 30) / 60;
      }
      res.backToSurface = { outAt, end: [c.x, c.y + c.radius, c.z].map((v) => +v.toFixed(2)), depth: +depth().toFixed(2) };
      let backAt = null;
      for (let i = 0; i < 14 * 60 && backAt === null; i += 30) {
        ct.run({ steps: [{ t: 0.5, dir: [hx, hz] }] });
        if (gd() < 0.45 && depth() > 0.3) backAt = (i + 30) / 60;
      }
      res.backToGlass = { backAt, glassDist: +gd().toFixed(2), depth: +depth().toFixed(2), region: c.region };
      res.digStats = { prims: w.dig.count, chunks: a.view.digFx.stats.chunks, maxBuildMs: +a.view.digFx.stats.maxMs.toFixed(1), rebuilds: a.view.digFx.stats.rebuilds, avgBuildMs: +(a.view.digFx.stats.totalMs / Math.max(1, a.view.digFx.stats.rebuilds)).toFixed(2) };
      return res;
    }, site);
    r.errors = errs;
    out.push(r);
    await p.close();
  }
  await ctx.close();
  return out;
}
