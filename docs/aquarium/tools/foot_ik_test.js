// 第 4 段階：接地 IK とプロシージャル歩行 の検証（開発用ページ ?nosave で fetch + eval。climb_helpers.js（__ct）・
// ceiling_test.js（__ceil）を先に読み込む）。window.__fk：
//   run(name, gait) … 場所で同じ入力を与えて歩かせ、次を返す：
//     speed     … カニの平均の速さ（入力どおり進めたか。支えが足りないと遅くなる）
//     slide     … 接地している足先の、1 フレームの最大の移動（足が滑らない = 0）
//     stretch   … 脚の伸びの最大（届く長さに対する割合。1 を超えると伸びきり）
//     planted   … 接地（+ 踏み替え中）の脚の最小の本数・全部が接地を失ったフレーム
//     steps / emergency … 踏み替えの回数・急ぎの踏み替え（伸びきり・足場が消えた）
//     invalid   … 足場が消えて外れた回数
//     onSurface … 接地している足先が面の上にある割合（足先の所の距離関数が ±0.03 以内）
//     ms        … 足場の探索を含む 1 フレームの最大の計算時間
//     climb     … 壁 / 天井に張り付いた・支えを失って離れた回数、最後の状態
//   all(gait) … 全部の場所
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input;
  const r2 = (v) => +v.toFixed(2), r3 = (v) => +v.toFixed(3);
  const world = (wx, wz) => { inp.touchMove = __ct.axisFor(wx, wz); };
  const stick = (x, y) => { inp.touchMove = { x, y }; };
  const L = w.landmarks, A = L.logA, B = L.logB;
  const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  const ax = Math.atan2(B[0] - A[0], B[2] - A[2]);
  const perp = [Math.cos(ax), -Math.sin(ax)];
  const sp = w.spawn;
  // 場所：at, y?（探し始める高さ）, camYaw, walk: [[秒, wx, wz, run?]], prep?
  const places = {
    '平らな砂地': { at: [sp.x, sp.z], camYaw: 0.6, walk: [[1.5, 1, 0], [1.2, 1, 0, true], [1, 0, 1]] },
    '凹凸のある岩（洞窟の床）': { at: [-12.6, -1.45], y: 2.4, camYaw: -Math.PI / 2, walk: [[2.5, 1, 0.1]] },
    '急斜面（岸辺の斜面）': { at: [-4.0, 8.3], camYaw: -Math.PI / 2, walk: [[2.5, 1, 0], [1.5, -1, 0]] },
    '崖の上り下り（滝の上）': { at: [14.5, L.tunnelIn[2] + 2.5], y: L.tunnelIn[1] + 3, camYaw: -Math.PI / 2, walk: [[2.5, -1, 0], [2.5, 1, 0]] },
    '流木の表面と裏側': { at: [m[0], m[2]], y: m[1] - 0.3, camYaw: ax + Math.PI, walk: [[3.5, perp[0], perp[1]], [1.5, Math.sin(ax), Math.cos(ax)]] },
    '洞窟の床・壁・天井': { at: [-11.8, -1.45], y: 2.4, camYaw: -Math.PI / 2, walk: [[4, 0, 1], [1.5, 0.6, 0]] },
    '掘った狭いトンネル': { at: [-4.6, 8.3], camYaw: -Math.PI / 2, heading: Math.PI / 2, prep: 'tunnel', walk: [[2, 1, 0], [1.5, -1, 0], [1.5, 0, -1]] },
    '盛った砂山': { at: [sp.x + 1.2, sp.z], camYaw: 0.6, prep: 'mound', walk: [[2.5, -1, 0], [2, 1, 0]] },
    '足場を掘って消す': { at: [sp.x, sp.z], camYaw: 0.6, prep: 'digUnder', walk: [[1, 0, 0]] },
  };
  const steps = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.step(1); } };
  let dug = false, mound = false;
  const prepare = (S) => {
    if (S.prep === 'tunnel' && !dug) { __ceil.digTunnel(Math.PI / 2, 5)(); dug = true; }
    if (S.prep === 'mound' && !mound) {
      // 手持ちの砂を増やして、スタート地点の右に砂山を盛る
      c.sandHeld = 4;
      c.tool = 'fill';
      c.heading = Math.PI / 2;
      a.dig = true; a.digAim = { x: 0, y: -0.3 };
      steps(140);
      a.dig = false; a.digAim = null; c.tool = 'dig';
      a.view.digFx.flushAll();
      mound = true;
    }
  };
  const run = (name, gait = 'ik') => {
    const S = places[name];
    a.view.digFx.budgetMs = 1e9;
    a.rig.gait = gait;
    a.rig.feet.reset();
    a.freeze = true;
    c.teleport(S.at[0], S.at[1], S.y !== undefined ? w.contactSurfaceBelow(S.at[0], S.y, S.at[1]) + 0.02 : undefined);
    if (S.heading !== undefined) c.heading = S.heading;
    cam.mode = 'adventure';
    cam.adventure.yaw = S.camYaw;
    cam.placeBehind(c);
    cam.adventure.yaw = S.camYaw;
    a.freeze = false;
    stick(0, 0); inp.touchJump = false; inp.touchRun = false; a.dig = false; a.digAim = null;
    steps(40);
    prepare(S);
    const F = a.rig.feet;
    const st0 = { ...F.stats }, cs0 = { ...c.climbStats };
    const r = { frames: 0, dsum: 0, slide: 0, stretch: 0, plantedMin: 8, allLost: 0, onS: 0, onN: 0, ms: 0 };
    const prev = F.feet.map((f) => [...f.pos]);
    const was = F.feet.map((f) => !f.swing && f.valid);
    let px = c.x, py = c.y, pz = c.z;
    const tick = () => {
      r.frames++;
      r.dsum += Math.hypot(c.x - px, c.y - py, c.z - pz);
      px = c.x; py = c.y; pz = c.z;
      if (gait !== 'ik') return;
      F.feet.forEach((f, k) => {
        const planted = !f.swing && f.valid;
        if (planted && was[k]) r.slide = Math.max(r.slide, Math.hypot(f.pos[0] - prev[k][0], f.pos[1] - prev[k][1], f.pos[2] - prev[k][2]));
        if (planted) {
          r.onN++;
          if (Math.abs(w.contactSolid(f.pos[0], f.pos[1], f.pos[2])) < 0.03) r.onS++;
        }
        prev[k] = [...f.pos];
        was[k] = planted;
      });
      const grounded = c.grounded || c.climbing;
      if (grounded && a.rig.ikW > 0.9) {
        const n = F.support.planted + F.feet.filter((f) => f.swing).length;
        r.plantedMin = Math.min(r.plantedMin, F.support.planted);
        if (F.support.planted === 0) r.allLost++;
        r.stretch = Math.max(r.stretch, F.support.maxStretch);
      }
      r.ms = Math.max(r.ms, F.stats.ms);
    };
    if (S.prep === 'digUnder') {
      // 立ったまま、足元の前の砂を下へ掘り続けて足場を消す（足場が消えた脚が踏み替えるか・面の上に足を置き続けるか）
      const inv0 = F.stats.invalid, p0 = F.feet.map((f) => [...f.pos]);
      a.dig = true; a.digAim = { x: 0, y: -1 };
      steps(90, () => { stick(0, 0); tick(); });
      a.dig = false; a.digAim = null;
      steps(30, tick);
      const moved = F.feet.filter((f, k) => Math.hypot(f.pos[0] - p0[k][0], f.pos[1] - p0[k][1], f.pos[2] - p0[k][2]) > 0.03).length;
      // 宙に残った足先（接地のつもりで、足先の所が空いている）
      const floating = F.feet.filter((f) => f.valid && !f.swing && w.contactSolid(f.pos[0], f.pos[1], f.pos[2]) > 0.05).length;
      return { place: name, gait, invalidAfterDig: F.stats.invalid - inv0, feetMoved: moved, floating, onSurface: r.onN ? r2(r.onS / r.onN) : null, state: c.state, carves: a.world.dig.count };
    }
    for (const [secs, wx, wz, run] of S.walk) {
      inp.touchRun = !!run;
      steps(Math.round(secs * 60), () => { world(wx, wz); tick(); });
    }
    inp.touchRun = false;
    stick(0, 0);
    steps(60, tick);
    const cs = {};
    for (const k in c.climbStats) cs[k] = c.climbStats[k] - cs0[k];
    return {
      place: name, gait,
      speed: r2((r.dsum / r.frames) * 60),
      slide: r3(r.slide), stretch: r2(r.stretch), plantedMin: r.plantedMin, allLost: r.allLost,
      steps: F.stats.steps - st0.steps, emergency: F.stats.emergency - st0.emergency, invalid: F.stats.invalid - st0.invalid,
      onSurface: r.onN ? r2(r.onS / r.onN) : null, ms: r3(r.ms),
      climb: { grabs: cs.grabs, supportLost: cs.supportLost, drops: cs.drops, state: c.state, ny: r2(c.climbing ? c.climbN[1] : c.groundN[1]) },
    };
  };
  const all = async (gait = 'ik') => {
    const out = [];
    for (const name of Object.keys(places)) {
      try { out.push(run(name, gait)); } catch (e) { out.push({ place: name, gait, error: String(e) }); }
      await new Promise((r) => setTimeout(r, 0));
    }
    a.rig.gait = 'ik';
    return out;
  };
  window.__fk = { places, run, all };
})();
