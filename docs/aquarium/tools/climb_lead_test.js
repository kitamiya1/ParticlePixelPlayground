// 第 8 段階：接地主導の壁登り・天井への移りの検証（開発用ページ ?nosave で fetch + eval。climb_helpers.js（__ct）・
// ceiling_test.js（__ceil。掘ったトンネル）を先に読み込む）。window.__cl：
//   run(name, gait) … 場所で同じ入力を与えて、次を返す（gait = 'cycle'（従来）/ 'ik'（接地 IK・移動は従来）/ 'lead'（接地主導））：
//     planted … 接地している脚の最小・平均（接地 / 張り付いている間）
//     foot    … 接地している足先と面の距離：浮き（外）の最大・めり込み（中）の最大（接地のつもりの足先。踏み替え中を除く）
//     stretch … 脚の伸びの最大（1 を超えると伸びきり）
//     steps   … 踏み替えの数・止まっている間の不要な踏み替え（idle）・止まっている間の足先の滑り（1 フレームで 2 mm より動いた接地の足先）
//     surf    … 床 / 壁 / 天井の切り替えの回数と、0.6 秒以内に元へ戻った（行き来した）回数（足先の組の面の向き。cycle / ik は体の面）
//     rot     … 体（CrabRig.root）の 1 フレームの最大の回転（度）
//     start   … 移り始めたときに次の面に掛かっていた脚の数の平均（接地主導だけ。xfer = 床 → 壁・壁 → 天井、ledge = 崖を降りる）
//     body    … 胴体のめり込み（中心の距離関数 < 半径 − 0.03 のフレーム）・空中のフレーム（接地も張り付きもしない）・支えを失った / 落ちた回数
//     stuck   … 押しているのに 0.5 秒以上ほとんど進まなかった回数
//     ms      … 1 フレームの更新（a.step(1)。描画の命令を含む）の平均・最大、脚の計算の最大
//     reach   … 壁に張り付いた時刻・天井（法線の y < −0.85）に着いた時刻・最も上の高さ・終わりの状態
//     hold    … 最後に止まっている間の体のずれ・足先の滑り・踏み替え
//     face    … CrabController.faceStats の差
//     track   … 0.25 秒ごとの [秒, 高さ, 状態, 床 / 壁 / 天井, 手がかり, 進み具合, 次の面の脚, 接地]
//   places … 場所の一覧
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input;
  const r2 = (v) => +v.toFixed(2), r3 = (v) => +v.toFixed(3);
  const world = (wx, wz) => { inp.touchMove = __ct.axisFor(wx, wz); };
  const stick = (x, y) => { inp.touchMove = { x, y }; };
  const L = w.landmarks, A = L.logA, B = L.logB;
  const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  const ax = Math.atan2(B[0] - A[0], B[2] - A[2]);
  const perp = [Math.cos(ax), -Math.sin(ax)];
  const hole = (x, y, z, r) => w.dig.add([x, y, z], [x, y - 0.01, z], r);
  const steps = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.step(1); } };
  // walk：[秒, wx, wz, 'ceil'?]（ワールドの水平の向き。'ceil' = 天井（法線の y < −0.85）に着いたら 0.15 秒後に次へ）・[秒, 's', x, y]（スティックそのまま。天井の上の前後左右）・[秒, 0, 0]（離す）
  const places = {
    '平地から垂直な壁へ': { at: [13.3, -1.6], y: 12, camYaw: -Math.PI / 2, walk: [[3, 1, 0], [1.5, 0, 0]] },
    '岩の凹凸を登る（水中の岩の柱）': { at: [-3.3, -4.0], camYaw: 0.2, heading: Math.PI / 2, walk: [[4, 0, -1], [1.5, 0, 0]] },
    '流木の側面から裏側へ': { at: [m[0], m[2]], y: m[1] - 0.3, camYaw: ax + Math.PI, walk: [[4, perp[0], perp[1], 'ceil'], [1.5, 0, 0]] },
    '洞窟の壁から天井へ': { at: [-11.8, -1.45], y: 2.4, camYaw: -Math.PI / 2, walk: [[3, 0, 1, 'ceil'], [1.5, 0, 0]] },
    '掘ったトンネルの天井を移動': { at: [-4.6, 8.3], camYaw: -Math.PI / 2, heading: Math.PI / 2, prep: 'tunnel', walk: [[3, 0, -1, 'ceil'], [1, 0, 0], [1, 's', 0, 1], [1, 's', 0, -1], [1, 's', 1, 0], [1.5, 0, 0]] },
    '天井を掘って足場を消す': { at: [-4.6, 8.3], camYaw: -Math.PI / 2, heading: Math.PI / 2, prep: 'tunnel', mid: 'digCeiling', walk: [[3, 0, -1, 'ceil'], [2.5, 0, 0]] },
    '狭い所から後退して脱出': { at: [-4.6, 8.3], camYaw: -Math.PI / 2, heading: Math.PI / 2, prep: 'tunnel', walk: [[0.9, 0, -1], [0.5, 0, 1], [1.5, 0, 0]] },
    '接地できない面から落下': { at: [13.3, -1.6], y: 12, camYaw: -Math.PI / 2, patch: 'glassTop', walk: [[4, 1, 0], [1.5, 0, 0]] },
    'ガラスへ押す（張り付かない）': { at: [-6, 9.0], camYaw: Math.PI, walk: [[3, 0, 1], [1, 0, 0]] },
  };
  // 掘ったトンネル：最初の 1 回だけ掘り、その中の位置（掘り終えて少し戻った所）を覚えておく。2 回目からはそこへ置く
  let tunnelAt = null;
  const prepare = (S) => {
    if (S.prep !== 'tunnel') return;
    if (!tunnelAt) {
      __ceil.digTunnel(Math.PI / 2, 5)();
      tunnelAt = [c.x, c.y, c.z];
    } else {
      c.teleport(tunnelAt[0], tunnelAt[2], tunnelAt[1] + 0.02);
      steps(20);
    }
    c.heading = S.heading;
  };
  const run = (name, gait = 'lead') => {
    const S = places[name];
    const cs0f = w.climbSolid, sm0 = w.surfaceMaterial;
    // 岩の垂直面の上の方（高さ 7.6 より上）を、登れない面（ガラスと同じ扱い）にする：体の張り付き（climbSolid）も脚の足場（材質）も
    const inGlass = (x, y, z) => y > 7.6 && Math.hypot(x - 14.3, z + 1.6) < 1.6;
    if (S.patch === 'glassTop') {
      w.climbSolid = (x, y, z) => (inGlass(x, y, z) ? 5 : cs0f.call(w, x, y, z));
      w.surfaceMaterial = (x, y, z) => (inGlass(x, y, z) && sm0.call(w, x, y, z) === 'rock' ? 'glass' : sm0.call(w, x, y, z));
    }
    try { return run0(name, gait, S); } finally { w.climbSolid = cs0f; w.surfaceMaterial = sm0; }
  };
  const rotDeg = (A, B) => {
    const e = A.elements; let tr = 0;
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += e[i * 4 + k] * B[i * 4 + k];
    return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
  };
  const surfOf = (gait) => {
    // （第 8 段階より前の版（main）には c.surf が無いので、体の面から決める）
    if (gait === 'lead' && c.surf) return c.surf;
    const ny = c.climbing ? c.climbN[1] : c.groundN[1];
    return ny > 0.74 ? 'floor' : ny < -0.6 ? 'ceil' : 'wall';
  };
  const run0 = (name, gait, S) => {
    a.view.digFx.budgetMs = 1e9;
    a.rig.gait = gait;
    a.rig.feet.reset();
    a.freeze = true;
    c.teleport(S.at[0], S.at[1], S.y !== undefined ? w.contactSurfaceBelow(S.at[0], S.y, S.at[1]) + 0.02 : undefined);
    c.heading = S.heading ?? 0;
    cam.mode = 'adventure';
    cam.adventure.yaw = S.camYaw;
    cam.adventure.pitch = 0.3;
    cam.placeBehind(c);
    cam.adventure.yaw = S.camYaw;
    a.freeze = false;
    stick(0, 0); inp.touchJump = false; inp.touchRun = false; a.dig = false; a.digAim = null;
    steps(30);
    prepare(S);
    if (S.prep === 'tunnel') { a.rig.feet.reset(); steps(30); }
    const F = a.rig.feet;
    const st0 = { ...F.stats }, cs0 = { ...c.climbStats }, ls0 = { ...c.ledgeStats }, fs0 = { ...c.faceStats };
    const R = { frames: 0, pMin: 8, pSum: 0, pN: 0, float: 0, sink: 0, stretch: 0, pen: 0, air: 0, stuck: 0, msSum: 0, msMax: 0, feetMs: 0, rot: 0, surfN: 0, flips: 0, track: [], slips: 0 };
    let stuckT = 0, stuckOn = false, t = 0, dug = false;
    let prevRoot = [...a.rig.root.elements];
    let surf = surfOf(gait), surfPrev = null, surfT = 0;
    let grabT = null, ceilT = null, maxY = c.y;
    const y0 = c.y;
    const prevFoot = F.feet.map((f) => [...f.pos]);
    // （前のフレームも接地していた足先だけ：踏み替えで着いたフレームは滑りに数えない）
    const prevOk = F.feet.map((f) => f.valid && !f.swing);
    const tick = (pushing, holdPhase) => {
      R.frames++;
      t += 1 / 60;
      const gr = c.grounded || c.climbing;
      if (gr && a.rig.ikW > 0.9 && gait !== 'cycle') {
        const n = F.support.planted;
        R.pMin = Math.min(R.pMin, n); R.pSum += n; R.pN++;
        for (const f of F.feet) {
          if (!f.valid || f.swing) continue;
          const d = w.contactSolid(f.pos[0], f.pos[1], f.pos[2]);
          if (d > R.float) R.float = d;
          if (-d > R.sink) R.sink = -d;
        }
        R.stretch = Math.max(R.stretch, F.support.maxStretch);
        if (holdPhase) {
          F.feet.forEach((f, k) => { if (f.valid && !f.swing && prevOk[k] && Math.hypot(f.pos[0] - prevFoot[k][0], f.pos[1] - prevFoot[k][1], f.pos[2] - prevFoot[k][2]) > 0.002) R.slips++; });
        }
      }
      F.feet.forEach((f, k) => { prevFoot[k][0] = f.pos[0]; prevFoot[k][1] = f.pos[1]; prevFoot[k][2] = f.pos[2]; prevOk[k] = f.valid && !f.swing; });
      if (!gr) R.air++;
      const d = w.contactSolid(c.x, c.y + c.radius, c.z);
      if (d < c.radius - 0.03) R.pen++;
      R.rot = Math.max(R.rot, rotDeg(a.rig.root, prevRoot));
      prevRoot = [...a.rig.root.elements];
      if (c.climbing && grabT === null) grabT = r2(t);
      if (c.climbing && c.climbN[1] < -0.85 && ceilT === null) ceilT = r2(t);
      maxY = Math.max(maxY, c.y);
      const s = surfOf(gait);
      if (s !== surf) {
        R.surfN++;
        if (s === surfPrev && t - surfT < 0.6) R.flips++;
        surfPrev = surf; surf = s; surfT = t;
      }
      const moved = Math.hypot(c.x - R.px, c.y - R.py, c.z - R.pz);
      if (pushing && moved < 0.002) { stuckT += 1 / 60; if (stuckT > 0.5 && !stuckOn) { R.stuck++; stuckOn = true; } } else { stuckT = 0; stuckOn = false; }
      R.px = c.x; R.py = c.y; R.pz = c.z;
      R.feetMs = Math.max(R.feetMs, F.stats.ms);
      if (R.frames % 15 === 0) R.track.push([r2(t), r2(c.y), c.state, s, c.faceHint ? c.faceHint.kind + ':' + c.faceHint.phase : '-', c.xfer ? r2(c.xfer.p) : '', F.support.next, F.support.planted].join(' '));
      // 天井で止まっている間に、接地している足先の下（天井）を掘る
      if (S.mid === 'digCeiling' && !dug && holdPhase && c.climbing && c.climbN[1] < -0.7 && hold && t - hold.t > 0.8) {
        for (const f of F.feet) if (f.valid) hole(f.pos[0] - f.n[0] * 0.08, f.pos[1] - f.n[1] * 0.08, f.pos[2] - f.n[2] * 0.08, 0.2);
        a.view.digFx.flushAll();
        dug = true;
        R.dugAt = r2(t);
      }
    };
    R.px = c.x; R.py = c.y; R.pz = c.z;
    const one = (pushing, holdPhase) => { const t0 = performance.now(); a.step(1); const ms = performance.now() - t0; R.msSum += ms; R.msMax = Math.max(R.msMax, ms); tick(pushing, holdPhase); };
    window.__clStartHook?.();
    let hold = null;
    S.walk.forEach((seg, si) => {
      const [secs] = seg;
      const n = Math.round(secs * 60);
      const isStick = seg[1] === 's';
      const idle = !isStick && !seg[1] && !seg[2];
      const last = si === S.walk.length - 1;
      if (idle && last) hold = { t, p: [c.x, c.y, c.z], steps: F.stats.steps, idle: F.stats.idleSteps, slips: R.slips };
      let ceilAt = -1;
      for (let i = 0; i < n; i++) {
        if (seg[3] === 'ceil' && !isStick) { if (ceilAt < 0 && c.climbing && c.climbN[1] < -0.85) ceilAt = i; if (ceilAt >= 0 && i - ceilAt > 9) break; }
        if (isStick) stick(seg[2], seg[3]); else if (!idle) world(seg[1], seg[2]); else stick(0, 0);
        one(!idle, idle && last && i > 30);
      }
    });
    stick(0, 0);
    const cs = {}, ls = {}, fs = {};
    for (const k in c.climbStats) cs[k] = c.climbStats[k] - cs0[k];
    for (const k in c.ledgeStats) ls[k] = r2(c.ledgeStats[k] - ls0[k]);
    for (const k in c.faceStats) fs[k] = r2(c.faceStats[k] - fs0[k]);
    return {
      place: name, gait,
      planted: { min: R.pN ? R.pMin : null, avg: R.pN ? r2(R.pSum / R.pN) : null },
      foot: { float: r3(R.float), sink: r3(R.sink) },
      stretch: r2(R.stretch),
      steps: { all: F.stats.steps - st0.steps, idle: F.stats.idleSteps - st0.idleSteps, faceSeeks: F.stats.faceSeeks - st0.faceSeeks, faceHits: F.stats.faceHits - st0.faceHits },
      surf: { switches: R.surfN, flips: R.flips },
      rot: r2(R.rot),
      start: { xfer: fs.starts ? r2(fs.startNext / fs.starts) : null, planted: fs.starts ? r2(fs.startPlanted / fs.starts) : null, n: fs.starts },
      body: { pen: R.pen, air: R.air, lost: cs.lost + cs.drops + cs.supportLost, aborts: fs.aborts },
      stuck: R.stuck,
      ms: { avg: r2(R.msSum / R.frames), max: r2(R.msMax), feet: r2(R.feetMs) },
      reach: { grab: grabT, ceil: ceilT, maxDy: r2(maxY - y0), endState: c.state, endNy: r2(c.climbing ? c.climbN[1] : c.groundN[1]), climbing: c.climbing },
      hold: hold ? { drift: r3(Math.hypot(c.x - hold.p[0], c.y - hold.p[1], c.z - hold.p[2])), steps: F.stats.steps - hold.steps, idle: F.stats.idleSteps - hold.idle, slips: R.slips - hold.slips } : null,
      face: fs, climb: cs, ledge: { climbs: ls.climbs, steps: ls.steps },
      dugAt: R.dugAt,
      track: R.track,
    };
  };
  window.__cl = { places, run, names: () => Object.keys(places) };
  return 'ok';
})();
