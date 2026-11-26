// 天井歩き（M2 第 1 段階）の自動検証。開発用ページ（?nosave）で fetch(url).then(r => r.text()).then(eval) で読み込み、
// await __ceil.all() → 場所ごとの結果を返す。climb_helpers.js（__ct）を先に読み込む。
// 場所ごとの流れ：
//   1. 押す向き（ワールドの水平の向き）を押し続け、天井（張り付いた面の法線の y < −0.85）へ着くまで（最大 maxT 秒）
//   2. 離して 1.5 秒：張り付いたまま止まっているか（ずれ）
//   3. 天井の上でスティックの前・後・左・右を 0.8 秒ずつ：それぞれ動いた距離と、張り付いたままか
//   4. ジャンプで離れる：0.6 秒後の状態（落下・沈降・遊泳）と、体が起き上がったか（frameMode が戻ったか）
// 全体を通して：体の向き（CrabRig.root）の 1 フレームの最大の回転（度）・カメラの 1 フレームの最大の移動・カメラが固体の中にいた
// フレーム数・カメラからカニが隠れていた割合・カメラの上下（見る向きの上が下を向いた）フレーム数
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input;
  const r2 = (v) => +v.toFixed(2);
  const stick = (x, y) => { inp.touchMove = { x, y }; };
  const world = (wx, wz) => { inp.touchMove = __ct.axisFor(wx, wz); };
  const rot = (A, B) => {
    // 2 つの回転行列（Matrix4 の左上 3×3）の間の角度（度）
    const a = A.elements, b = B;
    let tr = 0;
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += a[i * 4 + k] * b[i * 4 + k];
    return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
  };
  const monitor = () => {
    const m = { frames: 0, maxRotDeg: 0, camJump: 0, camInSolid: 0, hidden: 0, samples: 0, camFlip: 0 };
    let prevRoot = [...a.rig.root.elements], prevCam = [...cam.pose.pos];
    m.tick = () => {
      m.frames++;
      m.maxRotDeg = Math.max(m.maxRotDeg, rot(a.rig.root, prevRoot));
      prevRoot = [...a.rig.root.elements];
      const P = cam.pose.pos;
      m.camJump = Math.max(m.camJump, Math.hypot(P[0] - prevCam[0], P[1] - prevCam[1], P[2] - prevCam[2]));
      prevCam = [...P];
      if (w.cameraSolid(P[0], P[1], P[2], c.region) < 0) m.camInSolid++;
      // カメラは傾かない（上 = ワールドの上）。見る向きが真上・真下を越えていないか（越えると画面の上下が反転する）
      const T = cam.pose.target, dy = T[1] - P[1], dh = Math.hypot(T[0] - P[0], T[2] - P[2]);
      if (dh < 1e-3 && Math.abs(dy) > 0) m.camFlip++;
      if (m.frames % 6 === 0) { m.samples++; if (__ct.blocker()) m.hidden++; }
    };
    m.done = () => ({ frames: m.frames, maxRotDeg: r2(m.maxRotDeg), camJump: r2(m.camJump), camInSolid: m.camInSolid, hiddenFrac: r2(m.hidden / Math.max(1, m.samples)), camFlip: m.camFlip });
    return m;
  };
  const steps = (n, mon, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.step(1); mon?.tick(); } };
  const pos = () => [c.x, c.y + c.radius, c.z];
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

  /**
   * site = { name, at: [x, z], y?（探し始める高さ）, heading?, camYaw, camPitch?, push: [wx, wz], maxT?, prep?: () => void（掘る等）}
   */
  const site = (S) => {
    a.view.digFx.budgetMs = 1e9;
    a.freeze = true;
    c.teleport(S.at[0], S.at[1], S.y !== undefined ? w.contactSurfaceBelow(S.at[0], S.y, S.at[1]) + 0.02 : undefined);
    if (S.heading !== undefined) c.heading = S.heading;
    cam.mode = 'adventure';
    cam.adventure.yaw = S.camYaw;
    cam.adventure.pitch = S.camPitch ?? 0.3;
    cam.adventure.zoom = S.zoom ?? 3;
    cam.placeBehind(c);
    cam.adventure.yaw = S.camYaw;
    a.freeze = false;
    stick(0, 0); inp.touchJump = false; a.dig = false; a.digAim = null;
    steps(30);
    if (S.prep) S.prep();
    const st0 = { ...c.climbStats }, ce0 = { ...c.ceilStats };
    const mon = monitor();
    // 1. 天井まで
    let reachT = null;
    const maxT = S.maxT ?? 6;
    for (let i = 0; i < maxT * 60; i++) {
      world(S.push[0], S.push[1]);
      a.step(1); mon.tick();
      if (c.climbing && c.climbN[1] < -0.85) { reachT = r2(i / 60); break; }
    }
    // 押したまま少し進んでから離す（天井の真ん中へ）
    steps(Math.round((S.extra ?? 0.25) * 60), mon, () => world(S.push[0], S.push[1]));
    const res = { name: S.name, reachT, at: pos().map(r2), material: w.surfaceMaterial(c.x - c.climbN[0] * 0.3, c.y + c.radius - c.climbN[1] * 0.3, c.z - c.climbN[2] * 0.3), region: c.region, under: c.submerged > 0.5 };
    // 2. 離して止まる
    stick(0, 0);
    const p0 = pos();
    steps(90, mon);
    res.hold = { drift: r2(dist(p0, pos())), climbing: c.climbing, ny: r2(c.climbN[1]) };
    // 3. 天井の上で前後左右（前・後のあとは天井の上に居るはず。左右はトンネルの横の壁へ回り込んで床へ戻ることがある）
    res.moves = {};
    for (const [k, x, y] of [['前', 0, 1], ['後', 0, -1], ['左', -1, 0], ['右', 1, 0]]) {
      const q0 = pos();
      let minNy = 1, maxNy = -1;
      steps(48, mon, () => { stick(x, y); if (c.climbing) { minNy = Math.min(minNy, c.climbN[1]); maxNy = Math.max(maxNy, c.climbN[1]); } });
      stick(0, 0); steps(12, mon);
      res.moves[k] = { d: r2(dist(q0, pos())), climbing: c.climbing, ny: [r2(minNy), r2(maxNy)] };
      if (!c.climbing) break;
    }
    // 4. もう一度天井へ戻ってから、ジャンプで離れる（S.holdJump = 押したまま：水中なら遊泳へ）
    for (let i = 0; i < 6 * 60 && !(c.climbing && c.climbN[1] < -0.85); i++) { world(S.push[0], S.push[1]); a.step(1); mon.tick(); }
    stick(0, 0); steps(20, mon);
    const wasCeil = c.climbing && c.climbN[1] < -0.85;
    const y0 = c.y;
    inp.touchJump = true; steps(1, mon); inp.touchJump = !!S.holdJump;
    steps(30, mon);
    res.jump = { fromCeiling: wasCeil, state: c.state, climbing: c.climbing, frameMode: c.frameMode, ny: r2(c.groundN[1]), dy: r2(c.y - y0) };
    steps(60, mon);
    inp.touchJump = false;
    steps(60, mon);
    res.after = { state: c.state, grounded: c.grounded, frameMode: c.frameMode, ny: r2(c.groundN[1]), dy: r2(c.y - y0) };
    const st = {};
    for (const k in c.climbStats) st[k] = c.climbStats[k] - st0[k];
    res.stats = st;
    res.ceil = { invertedT: r2(c.ceilStats.invertedT - ce0.invertedT), grabsAir: c.ceilStats.grabsAir - ce0.grabsAir };
    res.monitor = mon.done();
    stick(0, 0);
    return res;
  };

  /** 横へ掘ったトンネル（水平に secs 秒）を作る */
  const digTunnel = (heading, secs) => () => {
    const hx = Math.sin(heading), hz = Math.cos(heading);
    c.heading = heading;
    a.dig = true; a.digAim = { x: 0, y: 0 };
    steps(Math.round(secs * 60), null, () => world(hx, hz));
    a.dig = false; a.digAim = null; stick(0, 0);
    steps(10);
    a.view.digFx.flushAll();
    // トンネルの途中まで戻る
    steps(50, null, () => world(-hx, -hz));
    stick(0, 0); steps(20);
  };

  /** ガラスへ押し付けても張り付かない・ガラスの近くの天井から先へ回り込まない（ガラスの手前で止まるか落ちる） */
  const glass = () => {
    const out = {};
    // 手前のガラス（z = maxZ）へ、水中の砂の広場から押す
    a.freeze = true; c.teleport(-6, 9.0); cam.mode = 'adventure'; cam.adventure.yaw = Math.PI; cam.adventure.pitch = 0.3; a.freeze = false;
    stick(0, 0); steps(30);
    const g0 = { ...c.climbStats };
    steps(180, null, () => world(0, 1));
    out.pushFront = { grabs: c.climbStats.grabs - g0.grabs, climbing: c.climbing, z: r2(c.z), state: c.state };
    // 陸地のガラス（x = maxX）
    a.freeze = true; c.teleport(16.6, 2.0); cam.adventure.yaw = -Math.PI / 2; a.freeze = false;
    stick(0, 0); steps(30);
    const g1 = { ...c.climbStats };
    steps(180, null, () => world(1, 0));
    out.pushLand = { grabs: c.climbStats.grabs - g1.grabs, climbing: c.climbing, x: r2(c.x), state: c.state };
    // 給水管の縦の管（アクリルの管）へ
    const col = w.stand.columns[0];
    if (col) {
      a.freeze = true; c.teleport(col.x + col.r + 0.7, col.z); cam.adventure.yaw = -Math.PI / 2; a.freeze = false;
      stick(0, 0); steps(30);
      const g2 = { ...c.climbStats };
      steps(150, null, () => world(-1, 0));
      out.pushPipe = { grabs: c.climbStats.grabs - g2.grabs, climbing: c.climbing, d: r2(Math.hypot(c.x - col.x, c.z - col.z) - col.r), state: c.state };
    }
    stick(0, 0);
    return out;
  };

  const sites = () => {
    const L = w.landmarks, A = L.logA, B = L.logB;
    const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
    const ax = Math.atan2(B[0] - A[0], B[2] - A[2]);
    const perp = [Math.cos(ax), -Math.sin(ax)];
    return [
      // 中空の倒木の中（水中）：横の壁 → 天井（流木の裏）
      { name: '倒木の中（水中・流木）', at: [m[0], m[2]], y: m[1] - 0.3, camYaw: ax + Math.PI, push: perp },
      // 洞窟のトンネル（水中・岩）：横の壁 → 天井
      { name: '洞窟のトンネル（水中・岩）', at: [-11.8, -1.45], y: 2.4, camYaw: -Math.PI / 2, push: [0, 1] },
      // 岸辺の斜面の砂に掘ったトンネル（水中・砂）：横の壁 → 天井
      { name: '掘ったトンネル（水中・砂）', at: [-4.6, 8.3], camYaw: -Math.PI / 2, push: [0, -1], prep: digTunnel(Math.PI / 2, 5), heading: Math.PI / 2 },
      // 陸の土に掘ったトンネル（陸上・土）
      { name: '掘ったトンネル（陸上・土）', at: [12.0, 8.2], camYaw: -Math.PI / 2, push: [0, -1], prep: digTunnel(Math.PI / 2, 4.5), heading: Math.PI / 2 },
      // 崖の抜け道（陸上・岩のトンネル）：入口から少し入った所で、崖の内側（+z）の壁へ
      { name: '崖の抜け道（陸上・岩）', at: [14.5, L.tunnelIn[2]], y: L.tunnelIn[1] + 0.6, camYaw: -Math.PI / 2, push: [0, 1], maxT: 6 },
      // 水中の倒木の中で、ジャンプを押したまま離れる（遊泳へ移る）
      { name: '倒木の中・押したまま離れる', at: [m[0] + 0.6 * Math.sin(ax), m[2] + 0.6 * Math.cos(ax)], y: m[1] - 0.3, camYaw: ax + Math.PI, push: [-perp[0], -perp[1]], holdJump: true },
    ];
  };

  const all = async () => {
    const out = [];
    for (const S of sites()) {
      try { out.push(site(S)); } catch (e) { out.push({ name: S.name, error: String(e) }); }
      await new Promise((r) => setTimeout(r, 0));
    }
    out.push({ name: 'ガラス・管', glass: glass() });
    return out;
  };

  window.__ceil = { site, sites, all, glass, digTunnel, monitor, steps, world, stick };
  return 'ok';
})();
