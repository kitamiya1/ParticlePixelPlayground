// 第 7 段階：接地主導の移動（崖・段差を降りる）の検証（開発用ページ ?nosave で fetch + eval。climb_helpers.js（__ct）・
// ceiling_test.js（__ceil。掘ったトンネル）を先に読み込む）。window.__lg：
//   run(name, gait) … 場所で同じ入力を与えて、次を返す（gait = 'ik'（従来の移動・脚は接地 IK）/ 'lead'（接地主導））：
//     planted  … 接地している脚の最小・平均（接地 / 張り付いている間）
//     airFeet  … 宙に浮いた足先（足場の無い脚。踏み替え中を除く）の最大・平均。float = 接地のつもりで面から 0.03 より離れた足先
//     stretch  … 脚の伸びの最大（1 を超えると伸びきり）
//     idle     … 止まっている間の不要な踏み替え（CrabFeet.stats.idleSteps）
//     body     … 胴体が地形にめり込んだフレーム（中心の距離関数 < 半径 − 0.03）・最も深いめり込み・空中（接地も張り付きもしない）の
//                フレーム・胴体が下がった速さの最大（/ 秒）
//     stuck    … 押しているのに 0.5 秒以上ほとんど進まなかった回数
//     cam      … カメラの位置の 1 フレームの最大の移動・最大の加速（跳ね）
//     ms       … 1 フレームの更新（a.step(1)。描画の命令を含む）の平均・最大、脚の計算の最大
//     ledge    … 縁の数え（CrabController.ledgeStats の差）・壁登り・最後の状態と高さ（下りたか）
//     track    … 0.25 秒ごとの [秒, 高さ, 状態]
//   all(gait) … 全部の場所
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input;
  const r2 = (v) => +v.toFixed(2), r3 = (v) => +v.toFixed(3);
  const world = (wx, wz) => { inp.touchMove = __ct.axisFor(wx, wz); };
  const stick = (x, y) => { inp.touchMove = { x, y }; };
  const L = w.landmarks, A = L.logA, B = L.logB;
  // 掘る（空洞の球。DigField の内部の add を直接使う：自動検証用）
  const hole = (x, y, z, r) => w.dig.add([x, y, z], [x, y - 0.01, z], r);
  const steps = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.step(1); } };
  // 場所：at, y?（探し始める高さ）, heading?, camYaw, walk: [[秒, wx, wz, run?]], prep?, mid?（途中で足場を消す）
  const places = {
    // 陸地の低い岩（ledge1）の西の縁：上（7.3〜7.5）から西の地面（6.6）へ。約 0.6
    '低い段差（陸の岩の縁）': { at: [10.2, -0.6], y: 9, camYaw: Math.PI * 0.75, walk: [[2.2, -1, 0], [0.8, 0, 0]] },
    // 陸地の段々の岩（ledge3）の北の縁：上（9.8）から北の地面（6.8）へ。約 3
    '高い崖（陸の段々の岩）': { at: [15.9, -1.4], y: 11, camYaw: Math.PI, walk: [[5, 0, -1], [0.8, 0, 0]] },
    // 水中の低い平らな岩（step）の北の縁を斜めに：上（2.25）から北の砂（1.1）へ
    '斜めの岩の縁（水中）': { at: [-14.2, 5.4], y: 4, camYaw: Math.PI * 0.85, walk: [[4, 0.6, -1], [0.8, 0, 0]] },
    // 中空の倒木の上から側面へ
    '流木の上から側面へ': { at: [(A[0] + B[0]) / 2, (A[2] + B[2]) / 2], y: A[1] + 1.2, camYaw: 0, walk: [[4.5, 0, 1], [0.8, 0, 0]] },
    // スタート地点の右に盛った砂山の上から急斜面へ
    '砂山の急斜面': { at: [w.spawn.x + 1.2, w.spawn.z], camYaw: 0.6, prep: 'mound', walk: [[2.5, 1, 0], [2.5, -1, 0], [0.8, 0, 0]] },
    // 掘ったトンネルの中の段差（トンネルの出口の床を一段掘り下げる）
    'トンネルの段差': { at: [-4.6, 8.3], camYaw: -Math.PI / 2, heading: Math.PI / 2, prep: 'tunnelStep', walk: [[3, 1, 0], [0.8, 0, 0]] },
    // 低い段差を降りている途中で、下の足場（先頭の脚の下）を掘って消す
    '足場が途中で消える': { at: [10.2, -0.6], y: 9, camYaw: Math.PI * 0.75, mid: 'digLanding', walk: [[2.5, -1, 0], [0.8, 0, 0]] },
    // 脚が届かない（張り出した岩の下へ沈む縁）：浅瀬の高台の西の縁から水中へ
    // 浅瀬の高台の西の縁から水中の砂へ（水面をまたぐ高い崖）
    '高台の縁から水中へ': { at: [2.0, 3.6], y: 8, camYaw: Math.PI / 2, walk: [[4, -1, 0], [0.8, 0, 0]] },
    // 脚が届かない崖：段々の岩の北の縁を、脚を掛けられない面（ガラス・管と同じ扱い）にして（水槽の中には登れない高い崖が無いので、
    // 自動検証では、その場所の登れる面の距離関数を遠くにする）。押し続ける → 縁で待ってから踏み出して落ちる
    '届かない崖で落ちる': { at: [15.9, -1.4], y: 11, camYaw: Math.PI, patch: 'noClimb', walk: [[3, 0, -1], [0.8, 0, 0]] },
    // 同じ所で、縁まで歩いて少し押してから離す → 縁で立ち止まったまま
    '届かない崖で立ち止まる': { at: [15.9, -1.4], y: 11, camYaw: Math.PI, patch: 'noClimb', walk: [[1.6, 0, -1], [1.5, 0, 0]] },
  };
  let mound = false, tunnel = false;
  const prepare = (S) => {
    if (S.prep === 'mound' && !mound) {
      c.sandHeld = 4; c.tool = 'fill'; c.heading = Math.PI / 2;
      a.dig = true; a.digAim = { x: 0, y: -0.3 };
      steps(140);
      a.dig = false; a.digAim = null; c.tool = 'dig';
      a.view.digFx.flushAll();
      mound = true;
    }
    if (S.prep === 'tunnelStep' && !tunnel) {
      __ceil.digTunnel(Math.PI / 2, 5)();
      // トンネルの奥（東）の床を一段（約 0.45）掘り下げる
      const x0 = c.x, z0 = c.z;
      c.teleport(-4.6, 8.3);
      const g = w.contactSurfaceBelow(-4.6 + 1.6, c.y + 0.6, 8.3);
      for (let k = 0; k < 6; k++) hole(-4.6 + 1.8 + k * 0.25, g - 0.2, 8.3, 0.45);
      a.view.digFx.flushAll();
      c.teleport(x0, z0);
      tunnel = true;
    }
  };
  const run = (name, gait = 'lead') => {
    const S = places[name];
    const cs0f = w.climbSolid;
    if (S.patch === 'noClimb') w.climbSolid = (x, y, z) => (Math.hypot(x - 15.9, z + 2.6) < 2.2 ? 5 : cs0f.call(w, x, y, z));
    try { return run0(name, gait, S); } finally { w.climbSolid = cs0f; }
  };
  const run0 = (name, gait, S) => {
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
    if (S.prep === 'tunnelStep') { c.teleport(S.at[0], S.at[1]); c.heading = S.heading; steps(40); }
    const F = a.rig.feet;
    const st0 = { ...F.stats }, cs0 = { ...c.climbStats }, ls0 = { ...c.ledgeStats };
    const R = { frames: 0, pMin: 8, pSum: 0, pN: 0, airMax: 0, airSum: 0, float: 0, stretch: 0, pen: 0, penMax: 0, air: 0, fallV: 0, stuck: 0, camV: 0, camA: 0, msSum: 0, msMax: 0, feetMs: 0, track: [] };
    let py = c.y, stuckT = 0, stuckOn = false, t = 0, dug = false;
    let cp = [...cam.pose.pos], cv = [0, 0, 0];
    const y0 = c.y;
    const tick = (pushing) => {
      R.frames++;
      t += 1 / 60;
      const gr = c.grounded || c.climbing;
      if (gr && a.rig.ikW > 0.9) {
        const n = F.support.planted;
        R.pMin = Math.min(R.pMin, n); R.pSum += n; R.pN++;
        const airF = F.feet.filter((f) => !f.valid && !f.swing).length;
        R.airMax = Math.max(R.airMax, airF); R.airSum += airF;
        R.float = Math.max(R.float, F.feet.filter((f) => f.valid && !f.swing && Math.abs(w.contactSolid(f.pos[0], f.pos[1], f.pos[2])) > 0.03).length);
        R.stretch = Math.max(R.stretch, F.support.maxStretch);
      }
      if (!gr) R.air++;
      const d = w.contactSolid(c.x, c.y + c.radius, c.z);
      if (d < c.radius - 0.03) { R.pen++; R.penMax = Math.max(R.penMax, c.radius - d); }
      if ((py - c.y) * 60 > R.fallV) { R.fallV = (py - c.y) * 60; R.fallAt = [r2(t), c.state, c.ledge ? c.ledge.kind + (c.ledge.lowering ? 'L' : '') : '-']; }
      // 押しているのに進まない
      const moved = Math.hypot(c.x - R.px, c.z - R.pz, c.y - py);
      if (pushing && moved < 0.002) { stuckT += 1 / 60; if (stuckT > 0.5 && !stuckOn) { R.stuck++; stuckOn = true; } } else { stuckT = 0; stuckOn = false; }
      R.px = c.x; R.pz = c.z; py = c.y;
      const p = cam.pose.pos, v = [p[0] - cp[0], p[1] - cp[1], p[2] - cp[2]];
      R.camV = Math.max(R.camV, Math.hypot(...v));
      const ca = Math.hypot(v[0] - cv[0], v[1] - cv[1], v[2] - cv[2]);
      if (ca > R.camA) { R.camA = ca; R.camAt = [r2(t), c.state, c.ledge ? c.ledge.kind + (c.ledge.lowering ? 'L' : '') : '-']; }
      cp = [...p]; cv = v;
      R.feetMs = Math.max(R.feetMs, F.stats.ms);
      if (R.frames % 15 === 0) R.track.push([r2(t), r2(c.y), c.state, c.ledge ? c.ledge.kind[0] + (c.ledge.lowering ? 'L' : c.ledge.stepOff ? 'X' : c.ledge.holdT > 0 ? 'H' : '') : '-', F.support.down]);
      // 途中で足場を消す：脚で支えて下ろしている間に、先頭の脚の下を掘る
      if (S.mid === 'digLanding' && !dug && c.ledge && c.ledge.lowering) {
        for (const f of F.feet) if (f.down) hole(f.pos[0], f.pos[1] - 0.1, f.pos[2], 0.32);
        a.view.digFx.flushAll();
        dug = true;
      }
    };
    R.px = c.x; R.pz = c.z;
    const one = (pushing) => { const t0 = performance.now(); a.step(1); const ms = performance.now() - t0; R.msSum += ms; R.msMax = Math.max(R.msMax, ms); tick(pushing); };
    // （撮影：ledge_shots.js が歩き始めからのフレームを数える）
    window.__lgStartHook?.();
    for (const [secs, wx, wz, run] of S.walk) {
      inp.touchRun = !!run;
      const n = Math.round(secs * 60);
      for (let i = 0; i < n; i++) { if (wx || wz) world(wx, wz); else stick(0, 0); one(!!(wx || wz)); }
    }
    inp.touchRun = false;
    stick(0, 0);
    for (let i = 0; i < 60; i++) one(false);
    const cs = {}, ls = {};
    for (const k in c.climbStats) cs[k] = c.climbStats[k] - cs0[k];
    for (const k in c.ledgeStats) ls[k] = r2(c.ledgeStats[k] - ls0[k]);
    return {
      place: name, gait,
      planted: { min: R.pMin, avg: R.pN ? r2(R.pSum / R.pN) : null }, airFeet: { max: R.airMax, avg: R.pN ? r2(R.airSum / R.pN) : null, float: R.float },
      stretch: r2(R.stretch), idle: F.stats.idleSteps - st0.idleSteps, steps: F.stats.steps - st0.steps, seeks: F.stats.seeks - st0.seeks, seekHits: F.stats.seekHits - st0.seekHits,
      body: { pen: R.pen, penMax: r3(R.penMax), air: R.air, fallV: r2(R.fallV), fallAt: R.fallAt },
      stuck: R.stuck, cam: { v: r3(R.camV), a: r3(R.camA), at: R.camAt },
      ms: { avg: r2(R.msSum / R.frames), max: r2(R.msMax), feet: r2(R.feetMs) },
      ledge: ls, climb: { grabs: cs.grabs, exits: cs.exits, lost: cs.lost, drops: cs.drops, supportLost: cs.supportLost },
      end: { state: c.state, dy: r2(c.y - y0) },
      track: R.track,
    };
  };
  const all = async (gait = 'lead') => {
    const out = [];
    for (const name of Object.keys(places)) {
      try { out.push(run(name, gait)); } catch (e) { out.push({ place: name, gait, error: String(e && e.stack || e) }); }
      await new Promise((r) => setTimeout(r, 0));
    }
    a.rig.gait = 'lead';
    return out;
  };
  window.__lg = { places, run, all };
})();
