// 掘りながら視点を回したときの壁の表示の検査（Playwright。browser_run_code_unsafe で実行）。
// 設定は開発サーバーから dig_config.json（{ dir, tag, throttle, w, h, shotEvery }）を読む。
// - CPU を throttle 倍遅くして（スマホ相当）、実時間のループ（requestAnimationFrame）で掘り進める。
// - カニとカメラがトンネルの中にいる毎フレーム：見えている三角形（掘った区画 + 高さ場の網）へ画面の 15 方向から
//   光線を当て、最初に裏面に当たる・何にも当たらない向きを数える（その向きでは壁が抜けて向こう側が見えている）。
//   staleFrames = 1 本でもあったフレーム、losBack = その本数の合計、camInside = 8 本以上（カメラが見た目では固体の中）。
// - 視点はゆっくり回し続ける。shotEvery フレームごとに画面を撮る。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/dig_config.json?' + Date.now());
  const O = JSON.parse(await cfgPage.evaluate(() => document.body.innerText));
  await cfgPage.close();
  const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto((O.host ?? 'http://localhost:5173') + '/aquarium.html?' + Date.now());
  await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
  await p.evaluate(() => document.getElementById('help')?.classList.add('fade'));
  const cdp = await ctx.newCDPSession(p);
  // 掘り始めの場所へ（止めたまま置いて、カメラを落ち着かせる）
  await p.evaluate(() => {
    const a = window.__aqua, c = a.crab;
    a.freeze = true;
    c.teleport(3.6, 0);
    c.heading = Math.PI / 2;
    a.freeze = false;
    a.camera.placeBehind(c);
    a.camera.adventure.yaw = c.heading + Math.PI;
    a.camera.adventure.pitch = 0.3;
    a.camera.adventure.zoom = 3.2;
    a.step(60);
    // 毎フレームの検査：見えている三角形（掘った区画のメッシュ + 高さ場の網）に対して光線を飛ばし、
    // ・カメラが「見た目では固体の中」か（上・前後左右の 5 本のうち 3 本以上が、最初に裏面に当たる）
    // ・カメラからカニへの視線が、カニより手前で裏面を通り抜けるか（＝裏面が抜けて向こう側が透けている）
    // を数える。当たり判定（solid）ではカメラが空洞の中（自由な所）にいるフレームだけを対象にする。
    a.__dig = { frames: 0, stale: 0, camInside: 0, losBack: 0, checked: 0, maxPending: 0, frameMs: [] };
    const w = a.world, dig = w.dig, fx = a.view.digFx;
    const terr = fx.d.terrain;
    const tri = (pos, idx, i0, i1, o, d, best) => {
      for (let i = i0; i < i1; i += 3) {
        const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
        if (ia === ib) continue; // 潰した三角形
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
        if (t > 1e-4 && t < best.t) { best.t = t; best.back = det < 0; } // 表（反時計回り）なら det > 0
      }
    };
    const cast = (o, d, maxT, ids) => {
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
    const around = (x, z) => { const ids = []; const i = dig.ci(x), j = dig.cj(z); for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii >= 0 && jj >= 0 && ii < dig.ncx && jj < dig.ncz) ids.push(dig.chunkId(ii, jj)); } return ids; };
    const origRender = a.view.render.bind(a.view);
    let last = performance.now();
    a.view.render = (...args) => {
      origRender(...args);
      const now = performance.now();
      a.__dig.frameMs.push(now - last);
      const S = a.__dig, cam = a.camera.pose.pos, cr = a.crab;
      S.frames++;
      S.maxPending = Math.max(S.maxPending, fx.stats.pending);
      // カニとカメラがトンネルの中（元の地表より下の空洞）にいる間、画面の 5×3 の向きへ光線を飛ばし、最初に当たる
      // 三角形が裏面、または 10 以内に何も無ければ「その向きでは壁が抜けて向こう側が見えている」とする
      if (cr.y + 0.3 < w.groundAt(cr.x, cr.z) && cam[1] < w.groundAt(cam[0], cam[2]) - 0.15 && w.solid(cam[0], cam[1], cam[2]) > 0) {
        S.checked++;
        const T = a.camera.pose.target, f = [T[0] - cam[0], T[1] - cam[1], T[2] - cam[2]];
        const fl = Math.hypot(...f); f[0] /= fl; f[1] /= fl; f[2] /= fl;
        let r = [f[2], 0, -f[0]]; const rl = Math.hypot(...r) || 1; r = r.map((v) => v / rl);
        const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
        const vc = a.view.camera, th = Math.tan((vc.fov * Math.PI) / 360) * 0.85, tw = th * vc.aspect;
        let backRays = 0;
        for (let iy = -1; iy <= 1; iy++) for (let ix = -2; ix <= 2; ix++) {
          const d = [0, 1, 2].map((k) => f[k] + r[k] * (ix / 2) * tw + u[k] * iy * th);
          const dl = Math.hypot(...d); for (let k = 0; k < 3; k++) d[k] /= dl;
          const ids = new Set();
          for (let s2 = 0; s2 <= 10; s2 += 0.25) for (const id of around(cam[0] + d[0] * s2, cam[2] + d[2] * s2).slice(4, 5)) ids.add(id);
          const hit = cast(cam, d, 10, [...ids]);
          // 裏面に当たる・何にも当たらない（トンネルの中なのに壁が無い）＝その向きは透けている
          if (hit.back) { backRays++; S.backHit = (S.backHit ?? 0) + 1; } else if (hit.t >= 10) { backRays++; S.noHit = (S.noHit ?? 0) + 1; }
        }
        if (backRays > 0) S.stale++;
        S.losBack += backRays;
        if (backRays >= 8) S.camInside++;
      }
      last = performance.now();
    };
  });
  if (O.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: O.throttle });
  // 実時間で掘る：前へ進みながら掘る（F 長押し相当）。視点はゆっくり回す
  await p.evaluate(() => {
    const a = window.__aqua;
    a.input.touchMove = { x: 0, y: 1 };
    a.dig = true;
    // 掘る向きは世界の +x に固定（移動入力はカメラ基準なので、カメラの向きから毎回求め直す）
    a.__spin = setInterval(() => {
      a.camera.adventure.yaw += 0.035;
      const yaw = a.camera.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      a.input.touchMove = { x: rx, y: fx };
    }, 8);
  });
  const shots = [];
  const total = O.seconds ?? 10;
  for (let t = 0; t < total; t += O.shotEvery ?? 1) {
    await p.waitForTimeout((O.shotEvery ?? 1) * 1000);
    if (O.dir) {
      const name = `${O.dir}/${O.tag}-dig-${String(Math.round(t * 10)).padStart(3, '0')}.jpg`;
      await p.screenshot({ path: name, type: 'jpeg', quality: 80 });
      shots.push(name.split('/').pop());
    }
  }
  if (O.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const r = await p.evaluate(() => {
    const a = window.__aqua;
    clearInterval(a.__spin);
    a.dig = false;
    a.input.touchMove = { x: 0, y: 0 };
    const S = a.__dig, f = S.frameMs.slice(5).sort((x, y) => x - y);
    const fs = a.view.digFx.stats;
    return { frames: S.frames, checked: S.checked, staleFrames: S.stale, camInside: S.camInside, rays: S.losBack, backHit: S.backHit ?? 0, noHit: S.noHit ?? 0, batches: fs.batches, lastBatchMs: +(fs.lastBatchMs ?? 0).toFixed(0), maxBatchMs: +(fs.maxBatchMs ?? 0).toFixed(0), maxPending: S.maxPending, prims: a.world.dig.count, chunks: fs.chunks, rebuilds: fs.rebuilds, rebuildAvgMs: +(fs.totalMs / Math.max(1, fs.rebuilds)).toFixed(2), rebuildMaxMs: +fs.maxMs.toFixed(1), frameMedMs: +f[Math.floor(f.length / 2)].toFixed(1), frameP95Ms: +f[Math.floor(f.length * 0.95)].toFixed(1), crab: [a.crab.x, a.crab.y, a.crab.z].map((v) => +v.toFixed(2)) };
  });
  await ctx.close();
  return { errors, r, shots };
}
