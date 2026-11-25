// 掘った穴の三角形の検査（Playwright。browser_run_code_unsafe で実行。設定は mesh_config.json { host, rays, plans, budget, shotDir }。
// 実行する側で globalThis.__over に入れた値は設定を上書きする）。shotDir があれば、不一致の光線ごとに始点から光線の向きを見た画面を撮る
// （mismatch-<番号>.jpg。画面の中心 = 距離関数の壁）。
// ゲームのループと同じ処理（__aqua.step）でトンネルを掘ってから、すべての区画を作り直し、
// カニが通った道（空洞の中）の点から全方向へ光線を飛ばして、見えている三角形（掘った区画 + 高さ場の網）と
// 当たり判定の距離関数（solid）を比べる：
//   hole = 距離関数ではすぐ先（8 以内）に壁があるのに、三角形に当たらない・裏面に先に当たる・ずっと奥で当たる
//   （ただし厚さ 0.12 未満の薄皮＝格子より細かい形は三角形にならないので thinSkipped として別に数える）
// hole が 0 なら、どの向きから見ても壁が抜けない（区画の継ぎ目・三角形の欠け・表裏の誤りが無い）。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/mesh_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  // 画像を保存する前に、同じ名前の画像が既に無いか確かめる（out_guard.js。過去の報告の画像を上書きしない）
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js?' + Date.now())).text())(O);
  await cfgPage.close();
  const ctx = await page.context().browser().newContext({ viewport: { width: 640, height: 400 } });
  const p = await ctx.newPage();
  await p.goto((O.host ?? 'http://localhost:5173') + '/aquarium.html?nosave&' + Date.now());
  await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
  const r = await p.evaluate((O) => {
    const a = window.__aqua, c = a.crab, w = a.world, dig = w.dig, fx = a.view.digFx;
    // budget：区画の作り直しの 1 フレームの時間の上限（ms）。大きくすると実時間に左右されず毎回同じ結果になる（比較用）
    if (O.budget) fx.budgetMs = O.budget;
    a.freeze = true;
    const run = (n, fn) => { a.freeze = false; for (let i = 0; i < n; i++) { fn?.(i); a.step(1, 1 / 60); } a.freeze = true; };
    const path = [];
    const plans = O.plans ?? [{ at: [3.6, 0], heading: Math.PI / 2, seconds: 8 }];
    for (const pl of plans) {
      // continue = 直前の計画の続き（置き直さない）。aim = 照準 [x, y]（aimRamp なら 0 から少しずつ）。照準の無いビルドでは無視される
      if (!pl.continue) {
        c.teleport(pl.at[0], pl.at[1]);
        c.heading = pl.heading;
        run(20);
        a.camera.adventure.yaw = pl.heading + Math.PI;
      }
      a.dig = true;
      const n = Math.round(pl.seconds * 60);
      run(n, (i) => {
        const k = pl.aimRamp ? i / n : 1;
        // turn（rad/s）= 照準の左右で掘る向きを少しずつ曲げる（照準 x = −1 で基準から +90°。移動と掘る向きが別々なので、
        // スティックでは曲がらない）。up = 後半はジャンプ（上へ掘る）
        const tx = pl.turn ? Math.max(-1, Math.min(1, -(pl.turn * (i / 60)) / (Math.PI / 2))) : 0;
        a.digAim = pl.aim || pl.turn ? { x: (pl.aim ? pl.aim[0] * k : 0) + tx, y: pl.aim ? pl.aim[1] * k : 0 } : null;
        // スティックは掘っている向きへ倒す（掘る向きの世界の向きを、カメラ基準の入力に直す）
        const hd = c.state === 'dig' ? c.digYaw : pl.continue ? a.camera.yaw - Math.PI : pl.heading;
        const yaw = a.camera.yaw, fxx = -Math.sin(yaw), fzz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const wx = Math.sin(hd), wz = Math.cos(hd);
        a.input.touchMove = { x: wx * rx + wz * rz, y: wx * fxx + wz * fzz };
        a.input.touchJump = !!pl.up && i > pl.seconds * 30;
        if (i % 6 === 0) path.push([c.x, c.y + c.radius, c.z, plans.indexOf(pl)]);
      });
      a.dig = false;
      a.digAim = null;
      a.input.touchMove = { x: 0, y: 0 };
      a.input.touchJump = false;
      if (!plans[plans.indexOf(pl) + 1]?.continue) run(30);
    }
    fx.flushAll();
    const terr = fx.d.terrain;
    const tri = (pos, idx, i0, i1, o, d, best) => {
      for (let i = i0; i < i1; i += 3) {
        const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
        if (ia === ib) continue;
        const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2];
        const e1x = pos[ib] - ax, e1y = pos[ib + 1] - ay, e1z = pos[ib + 2] - az;
        const e2x = pos[ic] - ax, e2y = pos[ic + 1] - ay, e2z = pos[ic + 2] - az;
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det, tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-4 && t < best.t) { best.t = t; best.back = det < 0; }
      }
    };
    const chunkOf = (x, z) => dig.chunkId(dig.ci(x), dig.cj(z));
    const castMesh = (o, d, maxT) => {
      const ids = new Set();
      for (let s = 0; s <= maxT; s += 0.2) {
        const x = o[0] + d[0] * s, z = o[2] + d[2] * s;
        for (const dx of [-0.25, 0, 0.25]) for (const dz of [-0.25, 0, 0.25]) ids.add(chunkOf(x + dx, z + dz));
      }
      const best = { t: maxT, back: false };
      for (const id of ids) {
        const m = fx.meshes.get(id);
        if (m) tri(m.geometry.getAttribute('position').array, m.geometry.getIndex().array, 0, m.geometry.getIndex().count, o, d, best);
        else {
          const st = terr.chunks.start[id], n = terr.chunks.count[id];
          tri(terr.geo.getAttribute('position').array, terr.geo.getIndex().array, st, st + n, o, d, best);
        }
      }
      return best;
    };
    // 距離関数（砂だけ：掘った空洞と高さ場。岩・流木・ガラスは別のメッシュなので除く）での最初の壁
    const castSdf = (o, d, maxT) => {
      let t = 0.02;
      for (let i = 0; i < 400 && t < maxT; i++) {
        const v = w.sandSolid(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t);
        if (v < 0.002) return t;
        t += Math.max(v * 0.8, 0.01);
      }
      return Infinity;
    };
    let thin = 0, rays = 0, holes = 0, backFirst = 0, miss = 0, late = 0, glassZone = 0;
    const examples = [];
    // 計画ごとの穴の数（path の 4 番目 = 計画の番号）
    const perPlan = {};
    const N = O.rays ?? 120;
    // 空洞の中の点（カニが通った道）。砂の中・地表より上は除く
    const pts = path.filter((q) => w.sandSolid(q[0], q[1], q[2]) > 0.05 && q[1] < w.groundAt(q[0], q[2]) - 0.1);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const o of pts) {
      for (let k = 0; k < N; k++) {
        // 球面上の一様な向き
        const zc = rnd() * 2 - 1, ph = rnd() * Math.PI * 2, s = Math.sqrt(1 - zc * zc);
        const d = [s * Math.cos(ph), zc, s * Math.sin(ph)];
        const ts = castSdf(o, d, 8);
        if (!Number.isFinite(ts)) continue;
        // 水槽の外（ガラスの向こう）の砂は描かない（高さ場を水槽の縁で延ばした値なので数えない）
        if (!w.insideTank(o[0] + d[0] * ts, o[2] + d[2] * ts)) continue;
        // ガラスの内側の面から 0.05 以内に当たった光線は別に数える（ガラス際まで掘った穴の縁。見た目の断面はガラスの面の
        // 0.015 内側にあり、そこより薄い所の形は格子では表せない。そこに見えるのはガラス）
        if (!w.insideTank(o[0] + d[0] * ts, o[2] + d[2] * ts, 0.05)) { glassZone++; continue; }
        // 岩・流木などが先にある向きは数えない（そちらは別のメッシュ）
        let other = false;
        for (let t = 0.05; t < ts; t += 0.1) if (w.solid(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t) < 0) { other = true; break; }
        if (other) continue;
        // 壁の厚み：格子（0.1）より薄い膜は三角形にならない（地表のすぐ下を掘ったときの薄皮）。別に数える
        let th = 0;
        for (let t = ts + 0.02; t < ts + 0.3; t += 0.02) { if (w.sandSolid(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t) > 0) break; th = t - ts; }
        if (th < 0.12) { thin++; continue; }
        rays++;
        const m = castMesh(o, d, ts + 1.0);
        let bad = '';
        if (m.t >= ts + 1.0) { miss++; bad = 'miss'; }
        else if (m.back) { backFirst++; bad = 'back'; }
        else if (m.t > ts + 0.3) { late++; bad = 'late'; }
        if (bad) {
          holes++;
          perPlan[o[3]] = (perPlan[o[3]] ?? 0) + 1;
          if (examples.length < 16) examples.push({ plan: o[3], bad, o: o.slice(0, 3).map((v) => +v.toFixed(2)), d: d.map((v) => +v.toFixed(2)), tSdf: +ts.toFixed(2), tMesh: +m.t.toFixed(2) });
        }
      }
    }
    return { points: pts.length, thinSkipped: thin, glassZone, rays, holes, miss, backFirst, late, perPlan, prims: dig.count, chunks: fx.stats.chunks, examples };
  }, O);
  // 不一致の光線ごとに、光線の始点から光線の向きを見た画面（画角 60°、中心 = 距離関数の壁）と、カニの体がそこを通れるか
  if (O.shotDir) {
    r.visual = [];
    await p.evaluate(() => { const a = window.__aqua; a.freeze = true; a.__camOrig = a.camera.update.bind(a.camera); a.camera.update = (...x) => { if (!a.__pose) return a.__camOrig(...x); const P = a.camera.pose; P.pos = a.__pose.pos; P.target = a.__pose.target; P.fov = 60; a.camera.crabFade = 1; }; const st = document.createElement('style'); st.textContent = 'body > div:not(#app) { visibility: hidden !important; } #help { display: none !important; }'; document.head.appendChild(st); });
    for (let k = 0; k < r.examples.length; k++) {
      const e = r.examples[k];
      const info = await p.evaluate((e) => {
        const a = window.__aqua, w = a.world, c = a.crab;
        const hit = [e.o[0] + e.d[0] * e.tSdf, e.o[1] + e.d[1] * e.tSdf, e.o[2] + e.d[2] * e.tSdf];
        a.__pose = { pos: [e.o[0] - e.d[0] * 0.3, e.o[1] - e.d[1] * 0.3, e.o[2] - e.d[2] * 0.3], target: hit };
        c.teleport(-16, -8);
        a.freeze = false; a.step(3); a.freeze = true;
        const P = a.camera.pose; P.pos = a.__pose.pos; P.target = a.__pose.target; P.fov = 60;
        // 当たった所の近くで、カニの体（半径 0.24）の中心を置ける点が、膜の反対側（光線の先）にあるか
        const far = [hit[0] + e.d[0] * 0.3, hit[1] + e.d[1] * 0.3, hit[2] + e.d[2] * 0.3];
        let depthMin = 0;
        for (let t = e.tSdf - 0.05; t < e.tSdf + 0.4; t += 0.01) depthMin = Math.min(depthMin, w.sandSolid(e.o[0] + e.d[0] * t, e.o[1] + e.d[1] * t, e.o[2] + e.d[2] * t));
        return { hit: hit.map((v) => +v.toFixed(2)), filmDepth: +depthMin.toFixed(3), farSide: +w.contactSolid(...far).toFixed(2), groundAtHit: +w.groundAt(hit[0], hit[2]).toFixed(2) };
      }, e);
      await p.waitForTimeout(150);
      await p.screenshot({ path: await shotPath(`${O.shotDir}/mismatch-${k}.jpg`), type: 'jpeg', quality: 85 });
      r.visual.push({ k, ...e, ...info });
    }
  }  await ctx.close();
  return r;
}
