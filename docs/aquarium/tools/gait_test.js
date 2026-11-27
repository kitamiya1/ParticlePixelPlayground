// 第 10 段階：歩き方 A（従来 'cycle'）・B（接地主導 'lead'）・ハイブリッド（'hybrid'）を同じ入力で比べる（開発用ページ ?nosave で
// fetch + eval。climb_helpers.js（__ct）・ceiling_test.js（__ceil）を先に読み込む）。描いた脚の先（ボーンから求めた指節の先）で測る。window.__gt：
//   run(scene, gait) … 場所に置いて同じ入力を与え、次を返す：
//     slip   … 地面に着いて見える足先（面から 0.012 以内）が 2 フレーム続けて着いている間の、1 フレームの動きの平均・最大（mm）
//     float  … 胴体が接地している間に、面から 0.06 より浮いて見える足先のフレームの割合（踏み替えで上げている足先も含む）
//     pen    … 面に 0.03 より深くめり込んで見える足先のフレームの割合
//     jump   … 足先が 1 フレームで 15 cm より動いた回数（瞬間移動。踏み替えの振りは 1 フレーム 10 cm ほど）
//     jitter … 足先の動きの向きが 1 フレームごとに逆になった（1 mm より大きく）回数（細かい震え）
//     tilt   … 体（CrabRig.root）の 1 フレームの最大の回転（度）
//     dv     … 速さの 1 フレームの最大の変化（/ 秒）
//     hy     … ハイブリッドの切り替え（B へ・A へ）の回数・B で過ごした割合
//     end    … 終わりの状態・高さの差・空中のフレーム（意図しない落下の目安）
//   all(gaits) … 全部の場所 × 歩き方
//   scenes … 場所の一覧（walk：[秒, wx, wz, run?] ワールドの水平の向き、[秒, 'rot', 角速度（rad / 秒）, 初めの向き] 向きを回しながら押す）
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input, rig = a.rig;
  const r2 = (v) => +v.toFixed(2), r3 = (v) => +v.toFixed(3);
  const L = w.landmarks, A = L.logA, B = L.logB;
  const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  const ax = Math.atan2(B[0] - A[0], B[2] - A[2]);
  const perp = [Math.cos(ax), -Math.sin(ax)];
  const S0 = w.spawn;
  const scenes = {
    // （平らで開けた所：水槽の手前の左（x −9.5〜−6、z −8.5 付近）。scan で、5 × 3 の範囲の高さの差が 0.1 ほど・まわりに物が無い所）
    flat: { label: '平地の横歩き', at: [-9.8, -8.0], camYaw: Math.PI, cam: [1.5, 0.75], walk: [[1.5, 1, 0], [0.8, 0, 0]] },
    turnInPlace: { label: 'その場で方向転換', at: [-8.6, -8.1], camYaw: Math.PI, cam: [1.6, 0.8], walk: [[0.5, 1, 0], [0.15, 0, 0], [0.5, 0, 1], [0.15, 0, 0], [0.6, -1, 0], [0.8, 0, 0]] },
    turnWalk: { label: '方向転換しながら歩く', at: [-8.6, -8.3], camYaw: Math.PI, cam: [1.6, 0.8], walk: [[2.1, 'rot', 3.0, 0], [0.8, 0, 0]] },
    steep: { label: '急斜面（岸の斜面を登る）', at: [-4.6, 8.3], camYaw: -Math.PI / 2, heading: Math.PI / 2, walk: [[3, 1, 0], [0.8, 0, 0]] },
    rockEdge: { label: '岩の凸角（陸の低い岩の縁を降りる）', at: [10.2, -0.6], y: 9, camYaw: Math.PI * 0.75, walk: [[2.5, -1, 0], [0.8, 0, 0]] },
    logOver: { label: '流木の凸角・凹角（倒木の上を横切る）', at: [m[0] - perp[0] * 1.4, m[2] - perp[1] * 1.4], camYaw: ax + Math.PI, walk: [[4, perp[0], perp[1]], [0.8, 0, 0]] },
    cliff: { label: '崖を降りる（陸の段々の岩）', at: [15.9, -1.4], y: 11, camYaw: Math.PI, walk: [[5, 0, -1], [0.8, 0, 0]] },
    wallStart: { label: '壁へ登り始める', at: [13.3, -1.6], y: 12, camYaw: -Math.PI / 2, walk: [[3, 1, 0], [0.8, 0, 0]] },
    wallCeil: { label: '壁から天井へ（洞窟）', at: [-11.8, -1.45], y: 2.4, camYaw: -Math.PI / 2, walk: [[3, 0, 1], [0.8, 0, 0]] },
    tunnel: { label: '掘ったトンネル', at: [-4.6, 8.3], camYaw: -Math.PI / 2, heading: Math.PI / 2, prep: 'tunnel', walk: [[3, 1, 0], [0.8, 0, 0]] },
  };
  const steps = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.step(1); } };
  let tunnelAt = null;
  // 描いた足先（世界）：根 × 下の節のボーン × 指節の先（下の節の座標：外 = sx·u, 上 = v）
  // （crabModel.ts の LEGS の a, b, bend と同じ）
  const LEGS = [{ a: 0.15, b: 0.1, bend: 0.45 }, { a: 0.17, b: 0.11, bend: 0.45 }, { a: 0.17, b: 0.11, bend: 0.45 }, { a: 0.15, b: 0.1, bend: 0.5 }];
  const tips = () => {
    const out = [];
    const M = new rig.root.constructor();
    for (const sx of [1, -1]) for (let i = 0; i < 4; i++) {
      const lo = rig.bones[7 + (sx === 1 ? 0 : 8) + i * 2 + 1];
      M.multiplyMatrices(rig.root, lo);
      const e = M.elements, Lg = LEGS[i];
      const u = Lg.a + Lg.b * Math.cos(Lg.bend), vv = -Lg.b * Math.sin(Lg.bend);
      const x = sx * u, y = vv;
      out.push([e[0] * x + e[4] * y + e[12], e[1] * x + e[5] * y + e[13], e[2] * x + e[6] * y + e[14]]);
    }
    return out;
  };
  const rotDeg = (A, Bm) => {
    const e = A.elements; let tr = 0;
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += e[i * 4 + k] * Bm[i * 4 + k];
    return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
  };
  const run = (name, gait) => {
    const S = scenes[name];
    a.view.digFx.budgetMs = 1e9;
    rig.gait = gait;
    rig.feet.reset();
    a.freeze = true;
    c.teleport(S.at[0], S.at[1], S.y !== undefined ? w.contactSurfaceBelow(S.at[0], S.y, S.at[1]) + 0.02 : undefined);
    c.heading = S.heading ?? 0;
    cam.mode = 'adventure';
    cam.adventure.yaw = S.camYaw;
    // （近くから見下ろす：[ズーム, 仰角]。足先が水草に隠れない）
    cam.adventure.zoom = S.cam ? S.cam[0] : 3.2;
    cam.adventure.pitch = S.cam ? S.cam[1] : 0.3;
    cam.placeBehind(c);
    a.freeze = false;
    inp.touchMove = { x: 0, y: 0 }; inp.touchJump = false; inp.touchRun = false; a.dig = false; a.digAim = null;
    steps(30);
    if (S.prep === 'tunnel') {
      if (!tunnelAt) { __ceil.digTunnel(Math.PI / 2, 5)(); tunnelAt = [c.x, c.y, c.z]; }
      else { c.teleport(tunnelAt[0], tunnelAt[2], tunnelAt[1] + 0.02); }
      c.heading = S.heading; rig.feet.reset(); steps(40);
    }
    const hy0 = { ...(rig.hyStats ?? {}) };
    const R = { n: 0, blendN: 0, bSlipSum: 0, bSlipN: 0, bSlipMax: 0, slipSum: 0, slipN: 0, slipMax: 0, floatN: 0, penN: 0, footN: 0, jump: 0, jitter: 0, tilt: 0, dv: 0, air: 0 };
    let prev = tips(), prevD = prev.map(() => [0, 0, 0]), prevOn = prev.map(() => false);
    let prevRoot = rig.root.elements.slice(), prevSp = c.speed;
    const y0 = c.y;
    const tick = () => {
      const T = tips();
      const gr = c.grounded || c.climbing;
      if (!gr) R.air++;
      // （ハイブリッドで A と B を混ぜている途中）
      const blending = rig.footW !== undefined && rig.gait === 'hybrid' && rig.footW > 0.05 && rig.footW < 0.95;
      if (blending) R.blendN++;
      T.forEach((p, k) => {
        const d = w.contactSolid(p[0], p[1], p[2]);
        const q = prev[k], dp = [p[0] - q[0], p[1] - q[1], p[2] - q[2]], mv = Math.hypot(...dp);
        const on = d < 0.012 && d > -0.03;
        if (gr) {
          R.footN++;
          if (d > 0.06) R.floatN++;
          if (d < -0.03) R.penN++;
          if (on && prevOn[k]) { R.slipSum += mv; R.slipN++; R.slipMax = Math.max(R.slipMax, mv); if (blending) { R.bSlipSum += mv; R.bSlipN++; R.bSlipMax = Math.max(R.bSlipMax, mv); } }
        }
        if (mv > 0.15) R.jump++;
        const pd = prevD[k];
        if (mv > 0.001 && Math.hypot(...pd) > 0.001 && dp[0] * pd[0] + dp[1] * pd[1] + dp[2] * pd[2] < 0) R.jitter++;
        prevD[k] = dp; prevOn[k] = on;
      });
      prev = T;
      R.tilt = Math.max(R.tilt, rotDeg(rig.root, prevRoot));
      prevRoot = rig.root.elements.slice();
      R.dv = Math.max(R.dv, Math.abs(c.speed - prevSp) * 60);
      prevSp = c.speed;
      R.n++;
    };
    window.__gtStartHook?.(name, gait);
    let t = 0;
    for (const seg of S.walk) {
      const [secs] = seg, n = Math.round(secs * 60);
      for (let i = 0; i < n; i++) {
        if (seg[1] === 'rot') { const ang = seg[3] + seg[2] * (i / 60); inp.touchMove = __ct.axisFor(Math.cos(ang), Math.sin(ang)); }
        else if (seg[1] || seg[2]) inp.touchMove = __ct.axisFor(seg[1], seg[2]);
        else inp.touchMove = { x: 0, y: 0 };
        inp.touchRun = !!seg[3] && seg[1] !== 'rot';
        a.step(1); tick(); t++;
        window.__gtFrameHook?.(t);
      }
    }
    inp.touchMove = { x: 0, y: 0 }; inp.touchRun = false;
    const hy = rig.hyStats ? { toB: rig.hyStats.toB - (hy0.toB ?? 0), toA: rig.hyStats.toA - (hy0.toA ?? 0), bShare: r2((rig.hyStats.bT - (hy0.bT ?? 0)) / Math.max(1e-6, rig.hyStats.t - (hy0.t ?? 0))) } : null;
    return {
      scene: name, gait,
      slip: { avg: r2((R.slipSum / Math.max(1, R.slipN)) * 1000), max: r2(R.slipMax * 1000) },
      float: r3(R.floatN / Math.max(1, R.footN)), pen: r3(R.penN / Math.max(1, R.footN)),
      jump: R.jump, jitter: R.jitter, tilt: r2(R.tilt), blend: { frames: R.blendN, slipAvg: r2((R.bSlipSum / Math.max(1, R.bSlipN)) * 1000), slipMax: r2(R.bSlipMax * 1000) }, dv: r2(R.dv), hy: gait === 'hybrid' ? hy : null,
      end: { state: c.state, dy: r2(c.y - y0), air: R.air },
    };
  };
  const all = async (gaits = ['cycle', 'lead', 'hybrid'], names = Object.keys(scenes)) => {
    const out = [];
    for (const nm of names) for (const g of gaits) {
      try { out.push(run(nm, g)); } catch (e) { out.push({ scene: nm, gait: g, error: String(e && e.stack || e) }); }
      await new Promise((r) => setTimeout(r, 0));
    }
    rig.gait = 'hybrid';
    return out;
  };
  window.__gt = { scenes, run, all, tips };
})();
