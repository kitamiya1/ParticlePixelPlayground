// 第 3 段階：水草をかき分ける の検証（開発用ページ ?nosave で fetch + eval。climb_helpers.js（__ct）を先に読み込む）。
// window.__pp：
//   blockedRays() … カメラ → カニの体の中心（と上下左右 0.12 ずらした 4 本）の線のうち、水草の円盤（いまの曲がりを足した位置、
//                   半径 = 直径 × 0.5）に遮られる割合
//   walk(mode, place) … 方式（dyn / gpu / off）で、場所（forest = 水草の森の通路を横切る / stems = 有茎草の茂み / room = 森の小部屋）を
//                   3 秒歩かせ、遮られる割合の平均・かき分けた植物の数・1 フレームの計算時間を返す
//   hold() … 森の中で止まって 2 秒：体と重なった草が分かれたままか（押された量 / 必要な量）
//   release() … 森の中から外へ出て、かき分けた草が戻る（動きが止まる）までの時間と、行き過ぎ（反対側へ振れた量）
//   dash() … 歩きとダッシュで分け入ったときの、草の速さの最大（勢いよく揺れるか）
//   carry() … 小石を挟んで運んだとき、挟んだ物に押された草の数
(() => {
  const a = window.__aqua, c = a.crab, cam = a.camera, inp = a.input, pf = a.plantField, S = a.plantSet;
  const r2 = (v) => +v.toFixed(2), r3 = (v) => +v.toFixed(3);
  const T = pf.table;
  const world = (wx, wz) => { inp.touchMove = __ct.axisFor(wx, wz); };
  const stick = (x, y) => { inp.touchMove = { x, y }; };
  const places = {
    forest: { at: [-11.0, -6.6], dir: [1, 0.15], yaw: -1.2 },
    stems: { at: [-15.9, -5.3], dir: [1, 0.2], yaw: -1.3 },
    room: { at: [a.world.landmarks.forestRoom[0] + 0.2, a.world.landmarks.forestRoom[2] + 1.6], dir: [0, -1], yaw: 0 },
  };
  /** 線 P → Q が円盤（候補 [x, y, z, 半径]）に遮られるか（カニの手前 0.3 までは見ない） */
  const rayBlocked = (P, Q, cand) => {
    const ex = Q[0] - P[0], ey = Q[1] - P[1], ez = Q[2] - P[2];
    const L = Math.hypot(ex, ey, ez);
    for (const [x, y, z, r] of cand) {
      const t = ((x - P[0]) * ex + (y - P[1]) * ey + (z - P[2]) * ez) / (L * L);
      if (t <= 0.02 || t * L > L - 0.3) continue;
      const px = P[0] + ex * t - x, py = P[1] + ey * t - y, pz = P[2] + ez * t - z;
      if (px * px + py * py + pz * pz < r * r) return true;
    }
    return false;
  };
  let pid = null;
  const plantIdOf = () => {
    if (pid) return pid;
    // main の plants.plants.plantId は PlantField.table.plantId
    pid = T.plantId;
    return pid;
  };
  const blockedRays = () => {
    const P = cam.pose.pos, q = [c.x, c.y + c.radius, c.z];
    const id = plantIdOf();
    // 線のまわりの円盤だけを候補に（線の外接箱 + 0.4）
    const mn = [Math.min(P[0], q[0]) - 0.6, Math.min(P[1], q[1]) - 0.6, Math.min(P[2], q[2]) - 0.6];
    const mx = [Math.max(P[0], q[0]) + 0.6, Math.max(P[1], q[1]) + 0.6, Math.max(P[2], q[2]) + 0.6];
    const cand = [];
    for (let i = 0; i < S.count; i++) {
      const k = id[i];
      if (k < 0) continue;
      let x = S.pos[i * 3], y = S.pos[i * 3 + 1], z = S.pos[i * 3 + 2];
      if (x < mn[0] || x > mx[0] || y < mn[1] || y > mx[1] || z < mn[2] || z > mx[2]) continue;
      const o = pf.offsetAt(k, y);
      x += o[0]; y += o[1]; z += o[2];
      cand.push([x, y, z, S.size[i] * 0.5]);
    }
    let n = 0;
    for (const [dx, dy] of [[0, 0], [0.12, 0], [-0.12, 0], [0, 0.12], [0, -0.12]]) {
      const Q = [q[0] + dx * Math.cos(cam.yaw), q[1] + dy, q[2] - dx * Math.sin(cam.yaw)];
      if (rayBlocked(P, Q, cand)) n++;
    }
    return n / 5;
  };
  const place = (name) => {
    const p = places[name];
    a.freeze = true;
    c.teleport(p.at[0], p.at[1]);
    cam.mode = 'adventure';
    cam.adventure.yaw = p.yaw;
    cam.adventure.pitch = 0.3;
    cam.adventure.zoom = 3;
    cam.placeBehind(c);
    cam.adventure.yaw = p.yaw;
    a.freeze = false;
    stick(0, 0);
    a.step(40);
    return p;
  };
  const walk = (mode, name = 'forest', secs = 3, run = false) => {
    // mode 'dyn-body' = ばねだけ（見通しの線ではよけない）
    pf.sightOn = mode !== 'dyn-body';
    pf.setMode(mode === 'dyn-body' ? 'dyn' : mode);
    const p = place(name);
    let bsum = 0, bn = 0, touched = 0, ms = 0, msMax = 0;
    inp.touchRun = run;
    for (let i = 0; i < secs * 60; i++) {
      world(p.dir[0], p.dir[1]);
      a.step(1);
      touched = Math.max(touched, pf.stats.touched);
      ms += pf.stats.ms;
      msMax = Math.max(msMax, pf.stats.ms);
      if (i % 10 === 0) { bsum += blockedRays(); bn++; }
    }
    inp.touchRun = false;
    stick(0, 0);
    pf.sightOn = true;
    return { mode, place: name, blocked: r2(bsum / bn), touchedMax: touched, active: pf.stats.active, msAvg: r3(ms / (secs * 60)), msMax: r3(msMax) };
  };
  const hold = () => {
    pf.setMode('dyn');
    const p = place('forest');
    for (let i = 0; i < 70; i++) { world(p.dir[0], p.dir[1]); a.step(1); }
    stick(0, 0);
    a.step(120);
    // 体と重なっている草：必要な押し出し量と、いまの押された量
    const out = [];
    const P = { x: c.x, y: c.y + c.radius * 0.7, z: c.z, r: c.radius * 1.75, vx: 0, vy: 0, vz: 0 };
    for (let i = 0; i < pf.n; i++) {
      const dx = T.root[i * 3] - P.x, dz = T.root[i * 3 + 2] - P.z;
      if (dx * dx + dz * dz > 0.5) continue;
      const need = pf['pushOf'](i, P);
      if (!need) continue;
      const b = pf.bendOf(i);
      out.push(r2(Math.hypot(b[0], b[1]) / Math.max(1e-3, Math.hypot(need[0], need[1]))));
    }
    return { overlapping: out.length, ratioMin: out.length ? Math.min(...out) : null, ratioAvg: out.length ? r2(out.reduce((s, v) => s + v, 0) / out.length) : null };
  };
  const release = () => {
    pf.setMode('dyn');
    const p = place('forest');
    for (let i = 0; i < 90; i++) { world(p.dir[0], p.dir[1]); a.step(1); }
    // 止まって押した草を覚え、カニを森の外へ瞬間移動して、草が戻るのを見る
    stick(0, 0);
    a.step(10);
    const watch = [...Array(pf.n).keys()].filter((i) => Math.hypot(...pf.bendOf(i)) > 0.05);
    const dir0 = new Map(watch.map((i) => [i, pf.bendOf(i)]));
    a.freeze = true;
    c.teleport(a.world.spawn.x, a.world.spawn.z);
    a.freeze = false;
    let t = 0, over = 0, half = null;
    const m0 = Math.max(...watch.map((i) => Math.hypot(...pf.bendOf(i))));
    for (; t < 600; t++) {
      a.step(1);
      let m = 0;
      for (const i of watch) {
        const b = pf.bendOf(i), d = dir0.get(i);
        m = Math.max(m, Math.hypot(b[0], b[1]));
        const dot = b[0] * d[0] + b[1] * d[1];
        if (dot < 0) over = Math.max(over, Math.hypot(b[0], b[1]) / Math.max(1e-3, Math.hypot(d[0], d[1])));
      }
      if (half === null && m < m0 * 0.5) half = t;
      if (pf.stats.active === 0) break;
    }
    return { plants: watch.length, maxBend: r2(m0), halfS: half === null ? null : r2(half / 60), settleS: r2(t / 60), overshoot: r2(over) };
  };
  const dash = () => {
    const out = {};
    for (const run of [false, true]) {
      pf.setMode('dyn');
      const p = place('forest');
      let vmax = 0, flMax = 0;
      inp.touchRun = run;
      for (let i = 0; i < 90; i++) {
        world(p.dir[0], p.dir[1]);
        a.step(1);
        for (let k = 0; k < pf.n; k++) {
          const v = Math.hypot(pf['V'][k * 2], pf['V'][k * 2 + 1]);
          if (v > vmax) vmax = v;
          if (pf['fl'][k] > flMax) flMax = pf['fl'][k];
        }
      }
      inp.touchRun = false;
      stick(0, 0);
      out[run ? 'dash' : 'walk'] = { crabSpeed: r2(Math.hypot(c.vx, c.vz)), plantSpeedMax: r2(vmax), flutterMax: r2(flMax) };
    }
    return out;
  };
  const carry = () => {
    pf.setMode('dyn');
    // 小石を挟んで（__gr の補助）森へ運ぶ
    if (!window.__gr) return { skipped: 'grab_helpers.js が無い' };
    __gr.reset(); __gr.settle(1);
    __gr.approach('pebble4', -Math.PI / 2);
    __gr.hold(true, 30);
    a.freeze = false;
    const held = a.grab.held?.name ?? null;
    const p = places.forest;
    a.freeze = true;
    const pr = a.grab.held;
    const dx = p.at[0] - c.x, dz = p.at[1] - c.z;
    c.teleport(p.at[0], p.at[1]);
    if (pr) { pr.p[0] += dx; pr.p[2] += dz; pr.p[1] = c.y + 0.3; }
    a.freeze = false;
    let byProp = 0;
    for (let i = 0; i < 90; i++) {
      world(p.dir[0], p.dir[1]);
      a.step(1);
      byProp = Math.max(byProp, a.pushers.length > 1 ? 1 : 0);
    }
    stick(0, 0);
    const stillHeld = a.grab.held?.name ?? null;
    __gr.hold(false, 30);
    a.freeze = false;
    return { held, stillHeld, propPusher: byProp === 1 };
  };
  window.__pp = { blockedRays, walk, hold, release, dash, carry, places, place };
})();
