// 地下から上へ掘って地表へ脱出できるかの検証（Playwright。browser_run_code_unsafe で実行。設定は exit_sites_config.json）。
// { hosts: { 名前: URL }, budget, sites: [{ name, at: [x, z], heading }], aims: [照準の上下], flat: 秒, up: 秒, walk: 秒 }
// 各地点で：その場に置き、照準 0（自動：斜め下 → 十分深くなったら水平）で flat 秒掘り進めて地下へ入る →
// 照準を上（x = 0, y = aim）にして、スティックを掘る向きへ倒したまま最大 up 秒掘る（地表へ出たら止める）→ 掘るのを離して walk 秒歩く。
// 返す値：地下で一番深かった所（元の地表から体の中心まで）、地表へ出た時刻（出なければ null）、最後の深さ（−0.24 なら地表の上）、
// 1 フレームのカメラの最大の動き。budget を大きくすると区画の作り直しが実時間に左右されない。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/exit_sites_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  await cfgPage.close();
  const out = {};
  for (const [hn, host] of Object.entries(O.hosts)) {
    out[hn] = [];
    const ctx = await page.context().browser().newContext({ viewport: { width: 640, height: 400 } });
    for (const site of O.sites) for (const aim of O.aims) {
      const p = await ctx.newPage();
      await p.goto(host + '/aquarium.html?nosave&' + Date.now());
      await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
      const r = await p.evaluate(([O, site, aim]) => {
        const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input;
        if (O.budget) a.view.digFx.budgetMs = O.budget;
        const depth = () => w.groundAt(c.x, c.z) - c.y - c.radius;
        a.freeze = true;
        c.teleport(site.at[0], site.at[1]);
        c.heading = site.heading;
        cam.adventure.yaw = c.heading + Math.PI;
        cam.adventure.pitch = 0.3;
        a.freeze = false; a.step(40); a.freeze = true;
        // スティックを掘る向き（掘っていないときは体の向き）へ倒す
        inp.moveAxis = () => {
          const hd = c.state === 'dig' ? c.digYaw : c.heading, yaw = cam.yaw, wx = Math.sin(hd), wz = Math.cos(hd);
          return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
        };
        let jump = 0, jumpAt = null, prev = [...cam.pose.pos], maxDepth = -9, outAt = null, phase = 'flat', fi = 0;
        const frame = () => { a.step(1); fi++; const P = cam.pose.pos; const j = Math.hypot(P[0] - prev[0], P[1] - prev[1], P[2] - prev[2]); if (j > jump) { jump = j; jumpAt = { phase, t: +(fi / 60).toFixed(2), tunnel: +cam.tunnel.toFixed(2), depth: +depth().toFixed(2), region: cam.region, recovered: cam.recovered }; } prev = [...P]; };
        a.freeze = false;
        a.dig = true; a.digAim = { x: 0, y: 0 };
        for (let i = 0; i < O.flat * 60; i++) { frame(); maxDepth = Math.max(maxDepth, depth()); }
        a.digAim = { x: 0, y: aim }; phase = 'up';
        let t = 0;
        for (; t < O.up * 60; t++) { frame(); maxDepth = Math.max(maxDepth, depth()); if (depth() < -0.15 && c.grounded) { outAt = +(t / 60).toFixed(2); break; } }
        const blockedBy = outAt === null ? c.digAim.material : null;
        a.dig = false; a.digAim = null; phase = 'walk';
        for (let i = 0; i < O.walk * 60; i++) frame();
        a.freeze = true;
        const r = { site: site.name, aim, maxDepth: +maxDepth.toFixed(2), outAt, blockedBy, finalDepth: +depth().toFixed(2), state: c.state, end: [c.x, c.z].map((v) => +v.toFixed(1)), camJump: +jump.toFixed(3), jumpAt, climbs: c.climbs };
        return r;
      }, [O, site, aim]);
      out[hn].push(r);
      await p.close();
    }
    await ctx.close();
  }
  return out;
}
