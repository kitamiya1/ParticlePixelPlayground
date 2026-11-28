// ハサミ集中モードの場面の検証（開発用ページ ?nosave で fetch + eval。先に focus_helpers.js（__focus）を読み込む）。window.__clawTest：
//   independent()   … 右の腕だけ動かす間、左の腕・カニは動かない／右だけ閉じる間、左は開いたまま（逆も）
//   analog()        … 閉じる量を 0 → 1 へ少しずつ：触れる前は閉じ具合が押し込みに比例・触れた後は握る強さが増える
//   weakStrong()    … 平たい石（0.5）を弱く（触れた所 + 10%）・強く（100%）挟んで持ち上げて揺する：滑った距離・落ちたか
//   twoHands()      … 細長い棒の両端を左右で挟み、持ち上げて左右へ動かす：震え（角速度の最大）・飛んだか・高さ
//   twoObjects()    … 左右で別々の積み木を挟んで持ち上げる
//   switchHold()    … 集中モードで挟んだまま通常へ（入力なし 1 秒：落とさない）→ E を押して離すと離す。通常で E で挟んだまま集中へ（同じ）
//   worm()          … 抜けたゴカイの頭の近くを右・尾の近くを左で挟んで、左右へ引き伸ばす：伸び（節の伸びの最大）・発散
//   tear()          … ちぎれる株の下を右・上を左で挟んで、上下に引き離す：ちぎれたか・上のかけらを左が持っているか
//   heavyPillar()   … 石の台（2.4）：1 本では持ち上がらない・両方なら浮く
//   all()
(() => {
  const a = window.__aqua, X = window.__focus, F = a.focus;
  const r3 = (v) => +(+v).toFixed(3);
  const top = () => {
    const f = a.props.props.find((p) => p.fixed);
    return f.p[1] + f.semi[1];
  };
  const independent = () => {
    X.setup();
    const L0 = [...F.L.p], c0 = [a.crab.x, a.crab.z];
    X.ctl('R', { mx: 1, my: 0 });
    X.run(30);
    X.ctl('R', { mx: 0 });
    const movedR = Math.hypot(F.R.p[0] - L0[0], F.R.p[2] - L0[2]);
    const dL = Math.hypot(F.L.p[0] - L0[0], F.L.p[1] - L0[1], F.L.p[2] - L0[2]);
    X.ctl('R', { close: 1 });
    X.run(20);
    const closeR = a.grab.close, closeL = a.grabL.close;
    X.ctl('R', { close: 0 });
    X.ctl('L', { close: 1, mx: -1 });
    X.run(20);
    const closeR2 = a.grab.close, closeL2 = a.grabL.close;
    X.release();
    return { leftMovedWhileRightMoved: r3(dL), rightMoved: r3(movedR), crabMoved: r3(Math.hypot(a.crab.x - c0[0], a.crab.z - c0[1])), rightClosedLeftOpen: [r3(closeR), r3(closeL)], leftClosedRightOpen: [r3(closeR2), r3(closeL2)] };
  };
  const analog = () => {
    X.setup();
    const B = X.blocks('block');
    // 物の前へ（開いたまま）
    X.grab('R', B[2], { squeeze: 0 });
    const rows = [];
    for (let v = 0; v <= 1.0001; v += 0.1) {
      X.ctl('R', { close: v });
      X.run(12);
      rows.push({ in: r3(v), close: r3(a.grab.close), state: a.grab.state, grip: r3(a.grab.gripNow) });
    }
    X.release();
    return { c0: r3(a.grab.c0), rows };
  };
  const weakStrong = () => {
    const one = (v) => {
      X.setup();
      const [s] = X.blocks('slab');
      // 平たい石を左の鋏の前へ置き直す（向きは横長）
      const c = a.crab;
      a.props.place(s, [c.x + 0.16, top() + s.semi[1] + 0.003, c.z + 0.42], [0, 0, 0, 1]);
      X.run(30);
      const g = X.grab('L', s, { squeeze: 1 });
      if (!g.ok) return { held: false };
      const G = a.grabL;
      X.ctl('L', { close: v === 'weak' ? G.c0 + 0.1 * (1 - G.c0) : 1 });
      X.run(30);
      const s0 = G.slid;
      X.lift('L', 0.12, 40);
      // 揺する（左右）
      for (let k = 0; k < 4; k++) {
        X.ctl('L', { mx: k % 2 ? -1 : 1 });
        X.run(12);
      }
      X.ctl('L', { mx: 0 });
      X.run(30);
      const out = { grip: r3(G.gripNow), slid: r3(G.slid - s0), held: G.state === 'holding', liftedY: r3(s.p[1] - top()), slips: G.stats.slips };
      X.release();
      return out;
    };
    return { weak: one('weak'), strong: one('strong') };
  };
  const twoHands = () => {
    X.setup();
    const rod = X.blocks('rod')[1];
    // 棒を正面へ置き直す（カニの前 0.33、横向き）
    const c = a.crab;
    a.props.place(rod, [c.x, top() + rod.semi[1] + 0.003, c.z + 0.34], [0, 0, 0, 1]);
    X.run(30);
    const gR = X.grab('R', rod, { lat: 0.1, off: 0.03 });
    const gL = X.grab('L', rod, { lat: -0.1, off: 0.03 });
    let maxW = 0, maxV = 0;
    const watch = () => {
      maxW = Math.max(maxW, Math.hypot(...rod.w));
      maxV = Math.max(maxV, Math.hypot(...rod.v));
    };
    X.ctl('R', { lift: 1 });
    X.ctl('L', { lift: 1 });
    X.run(40, watch);
    X.ctl('R', { lift: 0, mx: 1 });
    X.ctl('L', { lift: 0, mx: 1 });
    X.run(30, watch);
    X.ctl('R', { mx: -1 });
    X.ctl('L', { mx: -1 });
    X.run(30, watch);
    X.ctl('R', { mx: 0 });
    X.ctl('L', { mx: 0 });
    X.run(60, watch);
    const out = { gripR: gR.ok, gripL: gL.ok, bothHolding: a.grab.holding === rod && a.grabL.holding === rod, holders: rod.holders, liftedY: r3(rod.p[1] - top()), maxW: r3(maxW), maxV: r3(maxV), stillW: r3(Math.hypot(...rod.w)) };
    X.release();
    return out;
  };
  const twoObjects = () => {
    X.setup();
    const B = X.blocks('block');
    const gR = X.grab('R', B[2]), gL = X.grab('L', B[3]);
    X.lift('R', 0.1, 40);
    X.lift('L', 0.1, 40);
    const out = { R: gR.ok, L: gL.ok, R_y: r3(B[2].p[1] - top()), L_y: r3(B[3].p[1] - top()), R_held: a.grab.holding?.id, L_held: a.grabL.holding?.id };
    X.release();
    return out;
  };
  const switchHold = () => {
    X.setup();
    const B = X.blocks('block');
    const g = X.grab('R', B[2]);
    X.lift('R', 0.05, 20);
    // 集中 → 通常（何も押さない）
    X.ctl('R', { close: 0 });
    a.setFocus(false);
    X.run(60);
    const afterToNormal = a.grab.state;
    const jump = r3(Math.hypot(B[2].v[0], B[2].v[1], B[2].v[2]));
    // E を押して離す → 離す（スマホの画面では、戻したときに「挟む」スイッチが閉じた状態になる：たたいて開く）
    const latched = a.input.touchGrabLatch;
    a.hold = true;
    X.run(10);
    a.hold = false;
    a.touchUi?.setGrabLatched(false);
    X.run(10);
    const afterPressRelease = a.grab.state;
    // 通常で挟む → 集中へ（トリガー・ボタンは押していない）
    X.release();
    a.goto('blocks');
    a.crab.heading = 0;
    a.freeze = false;
    a.step(20);
    a.hold = true;
    X.run(40);
    const heldNormal = a.grab.state;
    a.hold = false;
    a.setFocus(true);
    X.run(60);
    const afterToFocus = a.grab.state;
    X.ctl('R', { close: 1 });
    X.run(10);
    X.ctl('R', { close: 0 });
    X.run(20);
    const afterSqueezeRelease = a.grab.state;
    X.release();
    return { grabbed: g.ok, afterToNormal, touchLatchClosedOnReturn: latched, maxSpeedAfterSwitch: jump, afterPressRelease, heldNormal, afterToFocus, afterSqueezeRelease };
  };
  const worm = () => {
    // 砂の広い所（スタート地点）で：カニの前 0.38 に横向きに横たえる（体長 約 0.9。積み木の検証エリアは狭い）
    X.release();
    a.setFocus(false);
    a.goto('spawn');
    a.crab.heading = 0;
    a.freeze = false;
    a.step(20);
    a.camera.placeBehind(a.crab);
    a.step(10);
    const c = a.crab, h = c.heading, W = a.worms.worms.find((w) => !w.gone) ?? a.worms.worms[0];
    const gy = a.world.contactSurfaceBelow(c.x, c.y + 0.5, c.z + 0.38);
    W.layFree(c.x, gy + 0.04, c.z + 0.38, h + Math.PI / 2);
    W.found = true;
    a.setFocus(true);
    X.run(40);
    // 体の中ほどから左右へ 0.15 の所（体の向きの点を、節の並びから求める）
    const mid = Math.floor(W.N / 2), P = (i) => [W.x[i * 3], W.x[i * 3 + 1], W.x[i * 3 + 2]];
    const dir = [W.x[(W.N - 1) * 3] - W.x[0], 0, W.x[(W.N - 1) * 3 + 2] - W.x[2]], dl = Math.hypot(dir[0], dir[2]) || 1;
    const m = P(mid);
    const e1 = [m[0] + (dir[0] / dl) * 0.15, 0, m[2] + (dir[2] / dl) * 0.15], e2 = [m[0] - (dir[0] / dl) * 0.15, 0, m[2] - (dir[2] / dl) * 0.15];
    // 右の鋏（体の −x 側）に近い方を右へ
    const rx = -Math.cos(h), rz = Math.sin(h);
    const pR = (e1[0] - c.x) * rx + (e1[2] - c.z) * rz > (e2[0] - c.x) * rx + (e2[2] - c.z) * rz ? e1 : e2;
    const pL = pR === e1 ? e2 : e1;
    X.moveTo('R', pR, { tol: 0.015, max: 200 });
    X.ctl('R', { close: 1 });
    X.run(20);
    const r1 = a.grab.holdingCreature === W;
    X.moveTo('L', pL, { tol: 0.015, max: 200 });
    X.ctl('L', { close: 1 });
    X.run(20);
    const r2 = a.grabL.holdingCreature === W.grip2;
    const s0 = W.stats.maxStrain;
    W.stats.maxStrain = 0;
    // 左右へ引き伸ばす（右は右へ、左は左へ）
    const dx = pR[0] - pL[0], dz = pR[2] - pL[2], l = Math.hypot(dx, dz) || 1;
    const sep0 = Math.hypot(a.grab.gripAt()?.[0] - (a.grabL.gripAt()?.[0] ?? 0), a.grab.gripAt()?.[2] - (a.grabL.gripAt()?.[2] ?? 0));
    const aR = X.axisFor(dx / l, dz / l), aL = X.axisFor(-dx / l, -dz / l);
    X.ctl('R', { mx: aR.x, my: aR.y });
    X.ctl('L', { mx: aL.x, my: aL.y });
    X.run(40);
    X.ctl('R', { mx: 0, my: 0 });
    X.ctl('L', { mx: 0, my: 0 });
    X.run(30);
    const g1 = a.grab.gripAt(), g2 = a.grabL.gripAt();
    const out = { rightGrabbed: r1, leftGrabbed2: r2, g2On: W.g2On, gripSpanBefore: r3(sep0), gripSpanAfter: g1 && g2 ? r3(Math.hypot(g1[0] - g2[0], g1[2] - g2[2])) : null, maxStrain: r3(W.stats.maxStrain), maxStrainBefore: r3(s0), diverge: W.stats.diverge, finite: W.x.every(Number.isFinite), stillHeld: a.grab.holdingCreature === W && a.grabL.holdingCreature === W.grip2 };
    // 右を離す：左が 1 本目になる
    X.ctl('R', { close: 0 });
    X.run(20);
    out.handoff = W.grip2.primary && W.held;
    X.ctl('L', { close: 0 });
    X.run(20);
    out.releasedAll = !W.held;
    X.release();
    return out;
  };
  const tear = () => {
    X.release();
    a.setFocus(false);
    a.goto('spawn');
    a.freeze = false;
    a.step(10);
    const PF = a.plantField, T = PF.table, c = a.crab;
    // スタート地点の近くの、ちぎれる種類（テープ状の葉・有茎草）で、まわり 0.5 にほかの株が無い株（カニの前に立てる）
    let best = -1, bd = 1e9;
    for (let i = 0; i < T.kind.length; i++) {
      if (PF.removed[i] || (T.kind[i] !== 0 && T.kind[i] !== 1) || T.height[i] < 0.32 || T.root[i * 3 + 1] > 5) continue;
      const d = Math.hypot(T.root[i * 3] - c.x, T.root[i * 3 + 2] - c.z);
      if (d >= bd) continue;
      let crowded = false;
      for (let j = 0; j < T.kind.length && !crowded; j++) if (j !== i && !PF.removed[j] && Math.hypot(T.root[j * 3] - T.root[i * 3], T.root[j * 3 + 2] - T.root[i * 3 + 2]) < 0.25) crowded = true;
      if (crowded) continue;
      bd = d;
      best = i;
    }
    if (best < 0) return { plant: null };
    // 株の前へカニを移す（株を正面 0.42 に。近いとカニの体（脚の広がり 0.42）が株を押しのけて曲げる）
    const rx = T.root[best * 3], rz = T.root[best * 3 + 2];
    a.crab.teleport(rx, rz - 0.42, T.root[best * 3 + 1] + 0.6);
    a.crab.heading = 0;
    a.freeze = false;
    a.step(30);
    a.camera.placeBehind(a.crab);
    a.step(10);
    a.setFocus(true);
    X.run(40);
    a.uiPrefs.set({ focusScheme: 'ground' });
    const ry = T.root[best * 3 + 1], H = T.height[best];
    // 茎のいまの位置（曲がり・揺れ・下がり）を毎フレーム追って、その鋏で挟める所（案内）になったら閉じる
    const go = (side, y0) => {
      const S = side === 'R' ? F.R : F.L, G = side === 'R' ? a.grab : a.grabL, PG = side === 'R' ? a.plantGrabR : a.plantGrabL;
      for (let k = 0; k < 240; k++) {
        const o = PF.offsetAt(best, y0);
        const tx = rx + o[0] + (side === 'R' ? -0.025 : 0.025), tz = rz + o[2] - 0.025, ty = y0 + o[1];
        const dx = tx - S.p[0], dz = tz - S.p[2], d = Math.hypot(dx, dz);
        const ax = X.axisFor(d > 1e-6 ? dx / d : 0, d > 1e-6 ? dz / d : 0), kk = Math.min(1, d / 0.05);
        X.ctl(side, { mx: ax.x * kk, my: ax.y * kk, lift: Math.max(-1, Math.min(1, (ty - S.p[1]) / 0.04)) });
        X.run(1);
        if (G.hint === PG && d < 0.03) break;
      }
      X.ctl(side, { mx: 0, my: 0, lift: 0, close: 1 });
      X.run(25);
    };
    // （上を先に挟む：下を先に引くと、長い株は上の方ほど大きく曲がって、もう 1 本の鋏が届かなくなる。上は腕の長い右）
    go('R', ry + Math.min(H * 0.85, 0.28));
    const r1 = a.grab.holdingCreature === a.plantGrabR;
    go('L', ry + 0.1);
    const r2 = a.grabL.holdingCreature === a.plantGrabL;
    const sec = a.plantGrabL.secondary || a.plantGrabR.secondary;
    const t0 = a.plantGrabR.stats.tears + a.plantGrabL.stats.tears;
    // 引き離す（右を上へ、左を下へ）
    X.ctl('R', { lift: 1 });
    X.ctl('L', { lift: -1 });
    X.run(50);
    X.ctl('L', { lift: 0 });
    X.ctl('R', { lift: 0 });
    X.run(30);
    const out = { plant: best, kind: T.kind[best], height: r3(H), rightOnPlant: r1, leftOnPlant: r2, secondary: sec, tears: a.plantGrabR.stats.tears + a.plantGrabL.stats.tears - t0, upperHoldsPiece: !!a.grab.holding && a.grab.holding.kind === 'weed', lowerStillOnStem: a.grabL.holdingCreature === a.plantGrabL };
    a.uiPrefs.set({ focusScheme: 'surface' });
    X.release();
    return out;
  };
  const heavyPillar = () => {
    X.setup();
    const [p1] = X.blocks('pillar');
    const c = a.crab;
    a.props.place(p1, [c.x, top() + p1.semi[1] + 0.003, c.z + 0.36], [0, 0, 0, 1]);
    X.run(30);
    const y0 = p1.p[1];
    const g1 = X.grab('R', p1);
    X.lift('R', 0.12, 60);
    X.run(30);
    const one = { grabbed: g1.ok, rose: r3(p1.p[1] - y0) };
    const g2 = X.grab('L', p1, { lat: 0.05 });
    X.lift('L', 0.12, 60);
    X.lift('R', 0.06, 30);
    X.run(30);
    const two = { grabbed: g2.ok, holders: p1.holders, rose: r3(p1.p[1] - y0) };
    X.release();
    return { one, two };
  };
  /**
   * 引き裂きの仕組みだけを確かめる（鋏の操作を使わずに、窓口 PlantGrab へ直接）：右で株の上・左で同じ株の下を挟んだ状態にして、
   * 2 本の構えを離していく：何 cm 広げたところでちぎれたか・上のかけらが右の鋏に渡ったか・左は根の付いた方を持ったままか
   */
  const tearLogic = () => {
    X.release();
    a.setFocus(false);
    a.goto('spawn');
    a.freeze = false;
    a.step(10);
    const PF = a.plantField, T = PF.table, c = a.crab;
    let best = -1, bd = 1e9;
    for (let i = 0; i < T.kind.length; i++) {
      if (PF.removed[i] || (T.kind[i] !== 0 && T.kind[i] !== 1) || T.height[i] < 0.5 || T.root[i * 3 + 1] > 5) continue;
      const d = Math.hypot(T.root[i * 3] - c.x, T.root[i * 3 + 2] - c.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const R = a.plantGrabR, L = a.plantGrabL, H = T.height[best], ry = T.root[best * 3 + 1];
    const at = (f) => [T.root[best * 3], ry + f * H, T.root[best * 3 + 2]];
    // 上（右）・下（左）
    R.nearest(at(0.3));
    R.aim(at(0.3));
    R.onGrab();
    L.nearest(at(0.1));
    L.aim(at(0.1));
    L.onGrab();
    const sec = L.secondary;
    let tornAt = null, doneR = false;
    for (let k = 0; k <= 30; k++) {
      const pull = k * 0.005;
      const gr = R.gripPoint(), gl = L.gripPoint();
      const aR = [gr[0], gr[1] + pull, gr[2]], aL = [gl[0], gl[1] - pull, gl[2]];
      const rl = L.stepHeld(1 / 60, aL, aL);
      const rr = R.stepHeld(1 / 60, aR, aR);
      if (rr.done || rl.done) {
        tornAt = Math.round(pull * 2 * 1000) / 1000;
        doneR = rr.done;
        break;
      }
    }
    const tears = R.stats.tears + L.stats.tears;
    // 鋏の側で離した（pop）ことにして、かけらを渡す
    let pieceTo = null;
    if (doneR) {
      R.onRelease('pop');
      const n0 = a.weeds.list.length;
      R.flush();
      pieceTo = a.weeds.list.length > n0 ? 'right' : null;
    }
    const lowerKeeps = L.holding && !L.secondary;
    const cutH = PF.cutH[best];
    L.onRelease('release');
    return { plant: best, height: r3(H), secondary: sec, tornAtSpreadM: tornAt, tears, upperReceivedPiece: pieceTo, lowerTakesOverStem: lowerKeeps, cutHeightAfter: r3(cutH), cutBetween: cutH > 0.1 * H && cutH < 0.3 * H };
  };
  const all = () => ({ independent: independent(), analog: analog(), weakStrong: weakStrong(), twoHands: twoHands(), twoObjects: twoObjects(), switchHold: switchHold(), heavyPillar: heavyPillar(), worm: worm(), tear: tear() });
  window.__clawTest = { independent, analog, weakStrong, twoHands, twoObjects, switchHold, worm, tear, tearLogic, heavyPillar, all };
})();
