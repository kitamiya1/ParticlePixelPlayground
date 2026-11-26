// 第 2 段階：冒険カメラの方式（classic / tps / close / free）の比較（開発用ページ ?nosave で fetch + eval。
// climb_helpers.js（__ct）・ceiling_test.js（__ceil）を先に読み込む）。
// window.__cs.run(場所の番号, 方式) → 同じ場所・同じ入力で歩かせ、次を集計して返す（最後の姿勢のまま止めるので、そのまま撮影できる）：
//   visible   … カニの体の中心が「見えている」割合（間に固体が無い、または描画で抜いている：抜く範囲が砂も含む・薄い物を抜く）
//   blocked   … 間に固体がある割合（描画で抜いているかを問わない）
//   bigFrac   … カニ（半径 0.32 の球。甲羅と脚の付け根）の画面上の大きさが画面の高さの 45% を超えた（体が画面を覆う）割合
//   dist      … カメラ ↔ カニの体の中心の距離（平均・最小）
//   jump      … カメラの位置の 1 フレームの最大の動き（カニの動きを除く）
//   turnDeg   … 見る向きの 1 フレームの最大の回転（度）
//   inSolid   … カメラが固体の中にいたフレーム（free・腕の最短で抜いている間は想定どおり）
//   flip      … 見る向きが真上・真下を越えたフレーム（画面の上下の反転）
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input, view = a.view;
  const r2 = (v) => +v.toFixed(2);
  const world = (wx, wz) => { inp.touchMove = __ct.axisFor(wx, wz); };
  const stick = (x, y) => { inp.touchMove = { x, y }; };
  const L = w.landmarks, A = L.logA, B = L.logB;
  const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  const ax = Math.atan2(B[0] - A[0], B[2] - A[2]);
  const perp = [Math.cos(ax), -Math.sin(ax)];
  // 場所：at, y?, camYaw, camPitch?, zoom?, prep?, walk: [[秒, wx, wz] ...]（ワールドの向きへ押す）
  const places = [
    { name: '平らな砂地', at: [world_spawn().x, world_spawn().z], camYaw: 0.6, walk: [[2, 1, 0], [1.5, 0, 1], [1, -1, -0.3]] },
    { name: '洞窟の床・壁・天井', at: [-11.8, -1.45], y: 2.4, camYaw: -Math.PI / 2, walk: [[4, 0, 1], [1.5, 0.6, 0]] },
    { name: '倒木の中', at: [m[0], m[2]], y: m[1] - 0.3, camYaw: ax + Math.PI, walk: [[3.5, perp[0], perp[1]], [1.5, Math.sin(ax), Math.cos(ax)]] },
    { name: '掘った狭いトンネル', at: [-4.6, 8.3], camYaw: -Math.PI / 2, heading: Math.PI / 2, prep: 'tunnel', walk: [[2, 1, 0], [1.5, -1, 0], [1.2, 0, -1]] },
    { name: '岩の間・張り出し（崖の抜け道）', at: [14.5, L.tunnelIn[2]], y: L.tunnelIn[1] + 0.6, camYaw: -Math.PI / 2, walk: [[2, -1, 0], [3, 0, 1]] },
  ];
  function world_spawn() { return w.spawn; }
  const steps = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.step(1); } };

  /** カニの画面上の大きさ（画面の高さに対する割合） */
  const screenFrac = () => {
    const P = cam.pose.pos, d = Math.hypot(P[0] - c.x, P[1] - (c.y + c.radius), P[2] - c.z);
    const fov = (cam.pose.fov * Math.PI) / 180;
    return (2 * Math.atan(0.32 / Math.max(d, 0.05))) / fov;
  };
  const run = (idx, style) => {
    const S = places[idx];
    a.view.digFx.budgetMs = 1e9;
    a.freeze = true;
    cam.setStyle(style);
    cam.closeW = style === 'close' ? 1 : 0;
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
    steps(40);
    for (const [secs, wx, wz] of S.walk) {
      steps(Math.round(secs * 60), () => {
        world(wx, wz);
      });
    }
    stick(0, 0);
  };
  // 集計付きの run（毎フレーム記録する）
  const runStats = (idx, style) => {
    const S = places[idx];
    const st = { frames: 0, vis: 0, blk: 0, big: 0, dsum: 0, dmin: 99, jump: 0, turn: 0, inSolid: 0, flip: 0 };
    const origStep = a.step;
    let prevP = null, prevC = null, prevF = null;
    let settle = 40;
    a.step = (n, dt) => {
      origStep(n, dt);
      // 瞬間移動した直後の落ち着くまで（run の最初の 40 フレーム）は数えない
      if (settle-- > 0) return;
      const P = cam.pose.pos, T = cam.pose.target;
      const q = [c.x, c.y + c.radius, c.z];
      const f = [T[0] - P[0], T[1] - P[1], T[2] - P[2]], fl = Math.hypot(...f) || 1;
      const fn = f.map((v) => v / fl);
      if (prevP) {
        const mv = Math.hypot(P[0] - prevP[0] - (c.x - prevC[0]), P[1] - prevP[1] - (c.y - prevC[1]), P[2] - prevP[2] - (c.z - prevC[2]));
        st.jump = Math.max(st.jump, mv);
        const dot = fn[0] * prevF[0] + fn[1] * prevF[1] + fn[2] * prevF[2];
        st.turn = Math.max(st.turn, (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI);
      }
      prevP = [...P]; prevC = [c.x, c.y, c.z]; prevF = fn;
      st.frames++;
      const d = Math.hypot(P[0] - q[0], P[1] - q[1], P[2] - q[2]);
      st.dsum += d; st.dmin = Math.min(st.dmin, d);
      if (screenFrac() > 0.45) st.big++;
      if (w.cameraSolid(P[0], P[1], P[2], c.region) < 0) st.inSolid++;
      if (Math.hypot(fn[0], fn[2]) < 1e-3) st.flip++;
      if (st.frames % 4 === 0) {
        const b = __ct.blocker();
        if (b) st.blk++;
        // 描画で抜いているか：抜く強さが十分で、遮る物が砂なら砂も抜く範囲（cut.sand）
        const cutting = cam.cut.on > 0.5 && (b !== 'sand' && b !== 'soil' ? true : cam.cut.sand > 0.5);
        if (!b || cutting) st.vis++;
      }
    };
    try { run(idx, style); } finally { a.step = origStep; }
    const n4 = Math.max(1, Math.floor(st.frames / 4));
    return { place: S.name, style, frames: st.frames, visible: r2(st.vis / n4), blocked: r2(st.blk / n4), bigFrac: r2(st.big / st.frames), dist: [r2(st.dsum / st.frames), r2(st.dmin)], jump: r2(st.jump), turnDeg: r2(st.turn), inSolid: st.inSolid, flip: st.flip, raise: r2(cam.raise), cutThrough: cam.cutThrough };
  };
  /** 掘ったトンネルを先に作る（集計に掘る時間を入れない） */
  const prep = () => {
    if (__cs.dug) return;
    const S = places[3];
    a.freeze = true;
    c.teleport(S.at[0], S.at[1]);
    c.heading = S.heading;
    cam.adventure.yaw = S.camYaw;
    a.freeze = false;
    steps(30);
    __ceil.digTunnel(Math.PI / 2, 5)();
    __cs.dug = true;
  };
  const all = async (styles = ['classic', 'tps', 'close', 'free']) => {
    prep();
    const out = [];
    for (let i = 0; i < places.length; i++) for (const s of styles) {
      try { out.push(runStats(i, s)); } catch (e) { out.push({ place: places[i].name, style: s, error: String(e) }); }
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  };
  window.__cs = { places, run, runStats, all, prep, screenFrac, dug: false };
})();
