// 壁登り・ガラス際の巣穴の自動検証の道具（開発用ページで fetch(url).then(r => r.text()).then(eval) で読み込む）。
// window.__ct.run(シナリオ) → 0.25 秒ごとの記録と集計を返す。
// シナリオ：{ at: [x, z], y?: 探し始める高さ, heading?, cam?: { yaw, pitch, zoom, mode }, steps: [{ t: 秒, dir?: [wx, wz] | 'keys:WASD の組' | null, run?, jump?, dig?, aim? }] }
// - dir：ワールドの水平の向き（カメラの向きから移動の入力へ直す = スマホの仮想スティックと同じ経路 input.touchMove）。
//   'keys:W' のように書くと、キーボード（input.keys）で押す（PC の WASD と同じ経路）。
// - 記録：位置・状態・張り付き・面の法線・カメラの位置の 1 フレームの最大の動き・カメラからカニが見えるか（遮る物の材質）
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input;
  const axisFor = (wx, wz) => {
    const yaw = cam.yaw, l = Math.hypot(wx, wz) || 1;
    wx /= l; wz /= l;
    return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
  };
  const r3 = (v) => +v.toFixed(3);
  /** カメラの位置からカニの体の中心までに、遮る物があるか（カメラの遮蔽と同じ viewSolid）。あれば材質 */
  const blocker = () => {
    const P = cam.pose.pos, q = [c.x, c.y + c.radius, c.z];
    const L = Math.hypot(q[0] - P[0], q[1] - P[1], q[2] - P[2]);
    for (let s = 0.1; s < L - c.radius - 0.05; s += 0.05) {
      const f = s / L, x = P[0] + (q[0] - P[0]) * f, y = P[1] + (q[1] - P[1]) * f, z = P[2] + (q[2] - P[2]) * f;
      if (w.viewSolid(x, y, z, c.region) < 0) return w.surfaceMaterial ? w.surfaceMaterial(x, y, z) : 'solid';
    }
    return null;
  };
  const setInput = (st) => {
    inp.keys.clear();
    inp.touchMove = { x: 0, y: 0 };
    inp.touchRun = !!st.run;
    inp.touchJump = !!st.jump;
    a.dig = !!st.dig;
    a.digAim = st.aim ? { x: st.aim[0], y: st.aim[1] } : null;
    if (typeof st.dir === 'string' && st.dir.startsWith('keys:')) for (const k of st.dir.slice(5)) inp.keys.add('Key' + k);
  };
  const run = (S) => {
    a.freeze = true;
    // at が無ければ、いまの位置から続ける
    if (S.at) c.teleport(S.at[0], S.at[1], S.y !== undefined ? w.contactSurfaceBelow(S.at[0], S.y, S.at[1]) + 0.02 : undefined);
    if (S.heading !== undefined) c.heading = S.heading;
    if (S.cam?.mode) cam.mode = S.cam.mode;
    const o = cam.mode === 'observe' ? cam.observe : cam.adventure;
    if (S.cam?.yaw !== undefined) o.yaw = S.cam.yaw;
    if (S.cam?.pitch !== undefined) o.pitch = S.cam.pitch;
    if (S.cam?.zoom !== undefined) o.zoom = S.cam.zoom;
    a.freeze = false;
    setInput({});
    if (S.at) a.step(30);
    const out = [];
    const s0 = { ...(c.climbStats ?? {}) };
    let t = 0, prev = [...cam.pose.pos], camJump = 0, camJumpAt = null, hidden = 0, frames = 0, maxNy = -2, minNy = 2;
    const blockers = {};
    for (const st of S.steps) {
      setInput(st);
      const n = Math.round(st.t * 60);
      for (let i = 0; i < n; i++) {
        if (st.dir && typeof st.dir !== 'string') inp.touchMove = axisFor(st.dir[0], st.dir[1]);
        a.step(1);
        t += 1 / 60;
        frames++;
        const P = cam.pose.pos;
        const j = Math.hypot(P[0] - prev[0], P[1] - prev[1], P[2] - prev[2]);
        if (j > camJump) { camJump = j; camJumpAt = { t: +t.toFixed(2), st: c.state, crab: [r3(c.x), r3(c.y + c.radius), r3(c.z)], occluded: cam.occluded }; }
        prev = [...P];
        if (c.climbing) { maxNy = Math.max(maxNy, c.climbN[1]); minNy = Math.min(minNy, c.climbN[1]); }
        if (frames % 6 === 0) {
          const b = blocker();
          if (b) { hidden++; blockers[b] = (blockers[b] ?? 0) + 1; }
        }
        const cn = c.climbN ?? [0, 1, 0];
        if (frames % 15 === 0) out.push({ t: +t.toFixed(2), p: [r3(c.x), r3(c.y + c.radius), r3(c.z)], depth: r3(w.groundAt(c.x, c.z) - c.y - c.radius), st: c.state, cl: !!c.climbing, n: cn.map((v) => +v.toFixed(2)), mat: w.surfaceMaterial ? w.surfaceMaterial(c.x - cn[0] * 0.3, c.y + c.radius - cn[1] * 0.3, c.z - cn[2] * 0.3) : '-', rg: c.region });
      }
    }
    setInput({});
    const s1 = c.climbStats ?? {}, d = {};
    for (const k of Object.keys(s1)) d[k] = s1[k] - s0[k];
    return { trace: out, stats: d, camJump: r3(camJump), camJumpAt, hiddenFrac: +(hidden / Math.max(1, Math.floor(frames / 6))).toFixed(2), blockers, climbNy: [r3(minNy), r3(maxNy)], end: [r3(c.x), r3(c.y + c.radius), r3(c.z)], state: c.state, recovered: cam.recovered };
  };
  /**
   * 掘ったトンネルを掘らずに登り直す：site = { at: [x, z], heading, flat: 秒, aim: 照準の上（0..1）, walk: 秒 }。
   * 水平に flat 秒掘り → 照準を上へ向けて地表へ出るまで掘る（最大 14 秒）→ 全区画を作り直す →
   * 坂の下（水平に掘った所の終わりの少し手前）へ戻し、掘るボタンなしで掘った向きへ walk 秒歩く。地表へ出た時刻を返す
   */
  const tunnelReclimb = (site) => {
    a.view.digFx.budgetMs = 1e9;
    const depth = () => w.groundAt(c.x, c.z) - c.y - c.radius;
    const hx = Math.sin(site.heading), hz = Math.cos(site.heading);
    a.freeze = true; c.teleport(site.at[0], site.at[1]); c.heading = site.heading;
    cam.mode = 'adventure'; cam.adventure.yaw = site.heading + Math.PI; cam.adventure.pitch = 0.3;
    a.freeze = false; setInput({}); a.step(30);
    const mv = inp.moveAxis;
    inp.moveAxis = () => axisFor(hx, hz);
    a.dig = true; a.digAim = { x: 0, y: 0 };
    a.step(Math.round((site.flat ?? 5) * 60));
    const bottom = [c.x, c.y, c.z];
    a.digAim = { x: 0, y: site.aim ?? 1 };
    let outAt = null;
    for (let i = 0; i < 14 * 60; i++) { a.step(1); if (depth() < -0.15 && c.grounded) { outAt = +(i / 60).toFixed(2); break; } }
    a.dig = false; a.digAim = null; inp.moveAxis = () => ({ x: 0, y: 0 }); a.step(10); a.view.digFx.flushAll();
    a.freeze = true; c.teleport(bottom[0] - hx * 0.4, bottom[2] - hz * 0.4, bottom[1] + 0.05); a.freeze = false; a.step(20);
    const s0 = { ...(c.climbStats ?? {}) }, climbs0 = c.climbs;
    inp.moveAxis = () => axisFor(hx, hz);
    let out = null, maxD = depth(), prev = [...cam.pose.pos], camJump = 0, hidden = 0, n = 0;
    const tr = [];
    for (let i = 0; i < (site.walk ?? 8) * 60; i++) {
      a.step(1);
      const P = cam.pose.pos;
      camJump = Math.max(camJump, Math.hypot(P[0] - prev[0], P[1] - prev[1], P[2] - prev[2]));
      prev = [...P];
      if (i % 6 === 0) { n++; if (blocker()) hidden++; }
      if (site.detail ? i / 60 >= site.detail[0] && i / 60 <= site.detail[1] && i % 3 === 0 : i % 30 === 0) tr.push(`${(i / 60).toFixed(2)} ${[c.x, c.y + c.radius, c.z].map((v) => v.toFixed(2)).join(',')} d=${depth().toFixed(2)} ${c.state}${c.climbing ? ' n=' + c.climbN.map((v) => v.toFixed(2)).join(',') : ''} v=${[c.vx, c.vy, c.vz].map((v) => v.toFixed(1)).join(',')}`);
      if (out === null && depth() < -0.15 && (c.grounded || c.climbing)) out = +(i / 60).toFixed(2);
    }
    inp.moveAxis = mv;
    setInput({});
    const st = {};
    for (const k in c.climbStats ?? {}) st[k] = c.climbStats[k] - s0[k];
    return { site: site.name, digOutAt: outAt, startDepth: +maxD.toFixed(2), reclimbOutAt: out, endDepth: +depth().toFixed(2), state: c.state, climb: st, digClimbs: c.climbs - climbs0, camJump: r3(camJump), hiddenFrac: +(hidden / Math.max(1, n)).toFixed(2), tr };
  };
  /**
   * 地下の壁を横へ：site = { at, heading, flat } で水平のトンネルを掘り、全区画を作り直してから、トンネルの途中で
   * 横の壁へ押し付け（side 秒）、壁に張り付いたままトンネルに沿って前へ（along 秒）・後ろへ動かす。
   */
  const tunnelLateral = (site) => {
    a.view.digFx.budgetMs = 1e9;
    const hx = Math.sin(site.heading), hz = Math.cos(site.heading);
    a.freeze = true; c.teleport(site.at[0], site.at[1]); c.heading = site.heading;
    cam.mode = 'adventure'; cam.adventure.yaw = site.heading + Math.PI; cam.adventure.pitch = 0.3;
    a.freeze = false; setInput({}); a.step(30);
    const mv = inp.moveAxis;
    inp.moveAxis = () => axisFor(hx, hz);
    a.dig = true; a.digAim = { x: 0, y: 0 };
    a.step(Math.round((site.flat ?? 6) * 60));
    a.dig = false; a.digAim = null; inp.moveAxis = mv; a.step(10); a.view.digFx.flushAll();
    // トンネルの途中まで戻る
    const back = run({ steps: [{ t: 1.0, dir: [-hx, -hz] }, { t: 0.3, dir: null }] });
    const depth = +(w.groundAt(c.x, c.z) - c.y - c.radius).toFixed(2);
    // 右の壁へ（掘った向きの右 = (hz, -hx)）
    const r = run({ steps: [{ t: site.side ?? 1.0, dir: [hz, -hx] }, { t: site.along ?? 1.2, dir: [hx, hz] }, { t: site.along ?? 1.2, dir: [-hx, -hz] }, { t: 0.8, dir: null }] });
    return { site: site.name, depth, start: back.end, stats: r.stats, end: r.end, state: r.state, climbNy: r.climbNy, camJump: r.camJump, path: r.trace.filter((e, i) => i % 2 === 1).map((e) => `${e.t} ${e.p.join(',')} d=${e.depth} ${e.st}${e.cl ? ' n=' + e.n.join(',') + ' ' + e.mat : ''}`) };
  };
  /**
   * ガラス際まで掘る：site = { at: [x, z], heading（ガラスへ向かう向き）, toGlass: 秒, along?: 秒, alongSign?: ±1, observe?: true }。
   * 照準 0（自動：地表では斜め下 → 深くなったら水平）でガラスへ向かって掘り進め、ガラスに着いても toGlass 秒まで掘り続ける
   * （掘れない物に当たって止まったら打ち切り）→ 向きを 90°（alongSign）変えて along 秒、ガラスに沿って掘る → 全区画を作り直す。
   * observe なら、カメラをガラス越しにして、いちばん近いガラスの正面から見る
   */
  const digGlass = (site) => {
    a.view.digFx.budgetMs = 1e9;
    const g0 = (x, z) => Math.min(x - (-18), 18 - x, z - (-10), 10 - z);
    a.freeze = true; c.teleport(site.at[0], site.at[1]); c.heading = site.heading;
    cam.mode = 'adventure'; cam.adventure.yaw = site.heading + Math.PI; cam.adventure.pitch = 0.3;
    a.freeze = false; setInput({}); a.step(30);
    const mv = inp.moveAxis;
    const dig = (hd, secs, aim) => {
      a.dig = false; a.digAim = null; a.step(3);
      c.heading = hd;
      const hx = Math.sin(hd), hz = Math.cos(hd);
      inp.moveAxis = () => axisFor(hx, hz);
      a.dig = true; a.digAim = { x: 0, y: aim ?? 0 };
      a.step(Math.round(secs * 60));
      a.dig = false; a.digAim = null;
      inp.moveAxis = () => ({ x: 0, y: 0 });
      a.step(3);
    };
    dig(site.heading, site.toGlass ?? 8, site.aim);
    const atGlass = { pos: [r3(c.x), r3(c.y + c.radius), r3(c.z)], glassDist: r3(g0(c.x, c.z)), depth: r3(w.groundAt(c.x, c.z) - c.y - c.radius), material: c.digAim.material };
    if (site.along) dig(site.heading + (site.alongSign ?? 1) * Math.PI / 2, site.along, site.alongAim);
    inp.moveAxis = mv;
    a.view.digFx.flushAll();
    a.step(2);
    const end = [r3(c.x), r3(c.y + c.radius), r3(c.z)];
    if (site.observe) { cam.mode = 'observe'; cam.faceNearestGlass(c); a.step(10); }
    return { site: site.name, atGlass, end, glassDist: r3(g0(c.x, c.z)), depth: r3(w.groundAt(c.x, c.z) - c.y - c.radius), region: c.region, prims: w.dig.count, chunks: a.view.digFx.stats.chunks, hidden: cam.crabHidden };
  };
  /**
   * ガラス際の断面の検査：水槽の外からガラスへ垂直に光線を飛ばし、見えている三角形（掘った区画 + 高さ場の網・断面）の
   * 最初の面と、当たり判定の砂（sandSolid）の最初の面を比べる。opts = { side: 'minX'|'maxX'|'minZ'|'maxZ', from, to（辺に沿った範囲）, step }。
   * - void：砂の断面があるはずの所で三角形に当たらない（外の空間が透ける）。rim：奥の穴の壁に当たる（穴の縁の丸め）
   * - covered：穴が開いているはずの所が三角形で塞がれている（穴が見えない）
   * - late / back：三角形がずっと奥・裏面に先に当たる
   */
  const glassCheck = (opts) => {
    const fx = a.view.digFx, dig = w.dig, terr = fx.d.terrain;
    const T = { minX: -18, maxX: 18, minZ: -10, maxZ: 10 };
    const S = opts.side, out = S === 'minX' ? [-1, 0] : S === 'maxX' ? [1, 0] : S === 'minZ' ? [0, -1] : [0, 1];
    const plane = S === 'minX' ? T.minX : S === 'maxX' ? T.maxX : S === 'minZ' ? T.minZ : T.maxZ;
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
    const castMesh = (o, d, maxT) => {
      const ids = new Set();
      for (let s = 0; s <= maxT; s += 0.2) {
        const x = o[0] + d[0] * s, z = o[2] + d[2] * s;
        if (!w.insideTank(x, z, -0.3)) continue;
        for (const dx of [-0.25, 0, 0.25]) for (const dz of [-0.25, 0, 0.25]) ids.add(dig.chunkId(dig.ci(x + dx), dig.cj(z + dz)));
      }
      const best = { t: maxT, back: false };
      for (const id of ids) {
        const m = fx.meshes.get(id);
        if (m) tri(m.geometry.getAttribute('position').array, m.geometry.getIndex().array, 0, m.geometry.getIndex().count, o, d, best);
        else tri(terr.geo.getAttribute('position').array, terr.geo.getIndex().array, terr.chunks.start[id], terr.chunks.start[id] + terr.chunks.count[id], o, d, best);
      }
      return best;
    };
    // 砂（ガラスの内側の面で切る）の最初の面。光線は面の外 0.5 から内向き
    const castSdf = (o, d, maxT) => {
      let t = 0.5 + 0.03;
      for (let i = 0; i < 400 && t < maxT; i++) {
        const v = w.sandSolid(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t);
        if (v < 0.002) return t;
        t += Math.max(v * 0.8, 0.01);
      }
      return Infinity;
    };
    const d = [-out[0], 0, -out[1]];
    const st = { rays: 0, face: 0, open: 0, void: 0, rim: 0, covered: 0, late: 0, back: 0 };
    const ex = [];
    const step = opts.step ?? 0.05, maxT = 3.5;
    for (let s = opts.from; s <= opts.to; s += step) {
      const fxz = out[0] !== 0 ? [plane, s] : [s, plane];
      const top = w.groundAt(fxz[0] - out[0] * 0.03, fxz[1] - out[1] * 0.03);
      for (let y = 0.05; y < top + 0.25; y += step) {
        const o = [fxz[0] + out[0] * 0.5, y, fxz[1] + out[1] * 0.5];
        const o3 = [o[0], o[1], o[2]];
        const ts = castSdf(o3, d, maxT), m = castMesh(o3, d, maxT);
        st.rays++;
        const faceSand = ts < 0.5 + 0.06;
        if (faceSand) st.face++; else st.open++;
        let bad = null;
        if (m.back && Math.abs(m.t - ts) > 0.15) bad = 'back';
        // 断面があるはずの所：三角形に当たらない = 外の空間が透ける（void）。奥の穴の壁に当たる = 穴の縁の丸め（rim。格子より細かい形）
        else if (faceSand && m.t >= maxT - 1e-3) bad = 'void';
        else if (faceSand && m.t > 0.5 + 0.15) bad = 'rim';
        else if (!faceSand && ts < maxT && m.t < ts - 0.2) bad = 'covered';
        else if (!faceSand && ts < maxT && m.t > ts + 0.25) bad = 'late';
        // 例は、透ける・塞がる・裏面を優先して残す（縁の丸め・奥は 3 つまで）
        const minor = bad === 'rim' || bad === 'late';
        if (bad) { st[bad]++; if (ex.length < 16 && (!minor || ex.filter((e) => e.bad === bad).length < 3)) ex.push({ bad, s: +s.toFixed(2), y: +y.toFixed(2), sdf: +ts.toFixed(2), mesh: +m.t.toFixed(2), back: m.back }); }
      }
    }
    return { side: S, ...st, examples: ex };
  };
  window.__ct = { run, axisFor, blocker, tunnelReclimb, tunnelLateral, digGlass, glassCheck };
  return 'ok';
})();
