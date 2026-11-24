// 探索ルートと箱庭カメラの回帰（Playwright。browser_run_code_unsafe で実行。設定は route_config.json { hosts, dir }）。
// 各ビルドで：
// 1. 名前の付いた場所（AquariumSpots の全 30 か所）へ順にカニを置き、ゲームのループと同じ処理を進めて、
//    発見（DiscoveryTracker）されるか・カニが床を抜けて落ちないか（区画が保たれるか）を調べる。
// 2. 縦穴の排水口から遊泳して吸い込まれ、排水管 → 濾過槽へ落ちる一続きの道（区画の移り変わり）を実際の操作で通す。
// 3. 部屋の床から壁沿いに歩く・ジャンプする（部屋の区画の当たり判定）。
// 4. 箱庭カメラに切り替えたときの視点（位置・注視点・画角）と画面。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/route_config.json?' + Date.now());
  const O = JSON.parse(await cfgPage.evaluate(() => document.body.innerText));
  await cfgPage.close();
  const out = {};
  for (const host of O.hosts) {
    const ctx = await page.context().browser().newContext({ viewport: { width: 960, height: 600 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(host + '/aquarium.html?' + Date.now());
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    const r = await p.evaluate(() => {
      const a = window.__aqua, c = a.crab, w = a.world;
      a.freeze = true;
      document.getElementById('help')?.classList.add('fade');
      const run = (n, fn) => { a.freeze = false; for (let i = 0; i < n; i++) { fn?.(i); a.step(1, 1 / 60); } a.freeze = true; };
      // 1. 全部の場所
      a.resetDiscovery();
      const missed = [];
      let fellOut = 0;
      for (const sp of a.spots) {
        const y = sp.shape === 'tube' ? sp.c[1] : sp.c[1] + Math.min(sp.r[1] * 0.5, 0.6);
        c.teleport(sp.c[0], sp.c[2], y);
        run(45);
        if (!a.tracker.visited.has(sp.id) && !(sp.parent && a.tracker.visited.has(sp.id))) missed.push(sp.id);
        if (!Number.isFinite(c.y) || c.y < -40) fellOut++;
      }
      const found = a.tracker.visited.size;
      // 2. 排水口から濾過槽へ（遊泳で水面直下まで上がり、渦に吸われる）
      a.goto('mouth');
      run(20);
      const regions = [c.region];
      const [ax, az] = w.stand.drainAxis;
      run(60 * 12, () => {
        const yaw = a.camera.yaw, dx = ax - c.x, dz = az - c.z, L = Math.hypot(dx, dz) || 1;
        const wx = dx / L, wz = dz / L;
        a.input.touchMove = L > 0.2 ? { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) } : { x: 0, y: 0 };
        a.input.touchJump = true;
        if (regions[regions.length - 1] !== c.region) regions.push(c.region);
      });
      a.input.touchMove = { x: 0, y: 0 };
      a.input.touchJump = false;
      run(120, () => { if (regions[regions.length - 1] !== c.region) regions.push(c.region); });
      // 3. 部屋の床を歩いてジャンプ
      a.goto('room');
      run(30);
      const y0 = c.y;
      run(120, (i) => { a.input.touchMove = { x: 0.6, y: 0.8 }; a.input.touchJump = i % 40 < 5; });
      a.input.touchMove = { x: 0, y: 0 };
      a.input.touchJump = false;
      run(60);
      const room = { region: c.region, y0: +y0.toFixed(2), y1: +c.y.toFixed(2), grounded: c.grounded };
      // 4. 箱庭カメラ
      if (a.camera.mode !== 'diorama') a.camera.toggle();
      a.camera.diorama.yaw = 0.42; a.camera.diorama.pitch = 0.3; a.camera.diorama.zoom = 68;
      run(10);
      const P = a.camera.pose;
      const diorama = { pos: P.pos.map((v) => +v.toFixed(2)), target: P.target.map((v) => +v.toFixed(2)), fov: P.fov };
      return { found, total: a.tracker.total, missed, fellOut, drainRoute: regions, room, diorama };
    });
    if (O.dir) await p.screenshot({ path: `${O.dir}/${host === O.hosts[0] ? 'before' : 'after'}-20-diorama.jpg`, type: 'jpeg', quality: 82 });
    // 箱庭カメラから冒険カメラへ戻したとき
    r.backToAdventure = await p.evaluate(() => {
      const a = window.__aqua;
      a.camera.toggle();
      a.camera.placeBehind(a.crab);
      a.freeze = false;
      a.step(60, 1 / 60);
      a.freeze = true;
      const P = a.camera.pose.pos, c = a.crab;
      return { mode: a.camera.mode, dist: +Math.hypot(P[0] - c.x, P[1] - c.y, P[2] - c.z).toFixed(2) };
    });
    r.errors = errors;
    out[host] = r;
    await ctx.close();
  }
  return out;
}
