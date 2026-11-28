// ハサミ集中モード（AquaClawFocus）の検証の道具（開発用ページ ?nosave で fetch(url).then(r => r.text()).then(eval)）。window.__focus：
// 入力は実際の入力と同じ道（main.ts の focusCtls に足される debug.focusCtl：スティックの倒し量・高さ・ひねり・閉じる量）で与える。
//   setup(o)              … 検証エリアへ移して並べ直し、カメラを後ろへ、集中モードへ（o.scheme = 腕の動かし方）
//   ctl(side, c)          … その鋏の入力を決める（{ mx, my, lift, roll, close }。スティックはカメラから見た向き）
//   moveTo(side, p, o)    … 鋏の目標を世界の点 p（x, z。o.y があれば高さも）へスティックで動かす（倒し量は残りの距離に比例）。返り値：届いた距離・フレーム数
//   squeeze(side, v, n)   … 閉じる量 v のまま n フレーム
//   grab(side, prop, o)   … 物の手前の面へ鋏を寄せて閉じる（o.squeeze = 閉じる量）：挟めたか
//   lift(side, dy, n)     … 高さを足す（面に沿う：自動の高さ + dy）
//   placeOn(side, base)   … 挟んだ物を base の上へ運んで下ろして離す：載ったか
//   run(n)                … n フレーム（実際のループと同じ処理）
//   st()                  … 状態
(() => {
  const a = window.__aqua, F = a.focus;
  const r3 = (v) => +(+v).toFixed(3);
  const D = (a.focusCtl = a.focusCtl ?? null);
  void D;
  const ctlState = { R: {}, L: {} };
  const apply = () => (a.focusCtl = { R: ctlState.R, L: ctlState.L });
  const run = (n, fn) => {
    for (let i = 0; i < n; i++) {
      fn?.(i);
      apply();
      a.freeze = false;
      a.step(1, 1 / 60);
    }
    a.freeze = true;
  };
  const G = (s) => (s === 'R' ? a.grab : a.grabL);
  const S = (s) => (s === 'R' ? F.R : F.L);
  /** 世界の向き（dx, dz）→ スティック（カメラから見た右・前） */
  const axisFor = (wx, wz) => {
    const yaw = a.camera.yaw;
    return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
  };
  const ctl = (side, c) => {
    ctlState[side] = { ...ctlState[side], ...c };
    apply();
  };
  const stopMove = (side) => ctl(side, { mx: 0, my: 0, lift: 0, roll: 0 });
  const setup = (o = {}) => {
    ctlState.R = {};
    ctlState.L = {};
    a.focusCtl = null;
    a.setFocus(false);
    a.resetBlocks();
    a.goto('blocks');
    a.crab.heading = 0;
    a.freeze = false;
    a.step(20);
    a.camera.placeBehind(a.crab);
    a.uiPrefs.set({ focusScheme: o.scheme ?? 'surface' });
    a.step(20);
    a.setFocus(true);
    run(60);
    return st();
  };
  const moveTo = (side, p0, o = {}) => {
    const T = S(side);
    let f = 0;
    let p = typeof p0 === 'function' ? p0() : p0;
    for (; f < (o.max ?? 240); f++) {
      if (typeof p0 === 'function') p = p0();
      const dx = p[0] - T.p[0], dz = p[2] - T.p[2], dy = o.y === undefined ? 0 : o.y - T.p[1];
      const d = Math.hypot(dx, dz);
      if (d < (o.tol ?? 0.008) && Math.abs(dy) < 0.01) break;
      const k = Math.min(1, d / 0.06), ax = axisFor(d > 1e-6 ? dx / d : 0, d > 1e-6 ? dz / d : 0);
      ctl(side, { mx: ax.x * k, my: ax.y * k, lift: o.y === undefined ? 0 : Math.max(-1, Math.min(1, dy / 0.04)) });
      run(1);
    }
    stopMove(side);
    return { side, err: r3(Math.hypot(p[0] - T.p[0], p[2] - T.p[2])), frames: f };
  };
  const squeeze = (side, v, n = 30) => {
    ctl(side, { close: v });
    run(n);
    return { state: G(side).state, grip: r3(G(side).gripNow), held: G(side).held?.name ?? null };
  };
  /** 物の手前（カニの側）の面の少し外へ鋏を寄せて閉じる */
  const grab = (side, pr, o = {}) => {
    const c = a.crab;
    const half = Math.min(...[pr.semi[0], pr.semi[2]]);
    const off = o.off ?? half + 0.015;
    const side0 = o.lat ?? 0;
    // （物の今の位置を毎フレーム追う：開いた鋏の先は物を押して動かすので）
    const at = () => {
      const dx = pr.p[0] - c.x, dz = pr.p[2] - c.z, l = Math.hypot(dx, dz) || 1;
      return [pr.p[0] - (dx / l) * off - (dz / l) * side0, 0, pr.p[2] - (dz / l) * off + (dx / l) * side0];
    };
    ctl(side, { close: 0 });
    run(5);
    // 途中の物を引っかけないよう、鋏を上げて近づき、近くで下ろす（o.high）
    if (o.high) {
      lift(side, 0.16, 40);
      const p = at();
      moveTo(side, [p[0], 0, p[2]], { max: o.max ?? 300, tol: 0.03 });
      lift(side, -0.2, 50);
    }
    // （2 cm まで寄ったら閉じる）
    const mv = moveTo(side, at, { max: o.max ?? 300, tol: o.tol ?? 0.02 });
    const sq = squeeze(side, o.squeeze ?? 1, 40);
    return { ...mv, ...sq, ok: G(side).holding === pr };
  };
  const lift = (side, dy, n = 60) => {
    ctl(side, { lift: Math.sign(dy) });
    let k = 0;
    const T = S(side), l0 = F.scheme === 'surface' ? T.lift : T.p[1];
    run(n, () => {
      const now = F.scheme === 'surface' ? T.lift : T.p[1];
      if (Math.abs(now - l0) >= Math.abs(dy)) ctlState[side].lift = 0;
      k++;
    });
    stopMove(side);
    return { lift: r3(T.lift), y: r3(T.p[1]) };
  };
  /** 挟んだ物を base の上へ：持ち上げる → 真上へ → 下げる（面に沿う：自動で base の上に載る高さ）→ 開く */
  const placeOn = (side, base, o = {}) => {
    const pr = G(side).holding;
    if (!pr) return { ok: false, why: 'not holding' };
    lift(side, 0.08, 40);
    // 物の中心が base の真上へ来るように鋏を動かす（毎フレーム、物の今の位置から：ぶら下がり方で中心とつかみ点のずれが変わる）
    const T = S(side);
    const want = () => [T.p[0] + base.p[0] + (o.dx ?? 0) - pr.p[0], 0, T.p[2] + base.p[2] + (o.dz ?? 0) - pr.p[2]];
    let mv = null;
    for (let k = 0; k < 4; k++) {
      mv = moveTo(side, want(), { max: 120, tol: 0.004 });
      run(15);
      if (Math.hypot(pr.p[0] - base.p[0] - (o.dx ?? 0), pr.p[2] - base.p[2] - (o.dz ?? 0)) < 0.012) break;
    }
    run(15);
    // 少しずつ下げる（ていねいに置く人の操作：下げては位置を直し、物が触れたら止める）
    const off = () => Math.hypot(pr.p[0] - base.p[0] - (o.dx ?? 0), pr.p[2] - base.p[2] - (o.dz ?? 0));
    for (let k = 0; k < 30 && !pr.contact; k++) {
      ctl(side, { lift: -0.5 });
      run(6);
      stopMove(side);
      if (off() > 0.01 && !pr.contact) moveTo(side, want(), { max: 30, tol: 0.004 });
    }
    stopMove(side);
    run(20);
    ctl(side, { close: 0 });
    run(90);
    const top = base.p[1] + base.semi[1];
    const bottom = pr.p[1] - pr.semi[1];
    return { ok: Math.abs(bottom - top) < 0.012 && Math.hypot(pr.p[0] - base.p[0], pr.p[2] - base.p[2]) < Math.max(base.semi[0], base.semi[2]), gap: r3(bottom - top), off: r3(Math.hypot(pr.p[0] - base.p[0], pr.p[2] - base.p[2])), mv };
  };
  const st = () => ({
    focus: F.snapshot(),
    R: { state: a.grab.state, held: a.grab.held?.name ?? null, grip: r3(a.grab.gripNow), close: r3(a.grab.close) },
    L: { state: a.grabL.state, held: a.grabL.held?.name ?? null, grip: r3(a.grabL.gripNow), close: r3(a.grabL.close) },
    crab: [a.crab.x, a.crab.y, a.crab.z].map(r3),
  });
  const release = () => {
    ctlState.R = {};
    ctlState.L = {};
    a.focusCtl = null;
  };
  window.__focus = { setup, ctl, moveTo, squeeze, grab, lift, placeOn, run, st, release, axisFor, blocks: (k) => a.blocks.filter((b) => b.kind === k) };
})();
