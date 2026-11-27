// 第 10 段階：崖の縁で意図しない落下が起きる条件を探す（開発用ページ ?nosave で fetch + eval。climb_helpers.js（__ct）を先に読み込む）。
// window.__cs：
//   run(site, angDeg, opt) … 縁の上に置き、縁へ向かう向きを angDeg 度回した向きへ secs 秒押し続ける（離さない）。返り値：
//     fall … 接地も張り付きもしない状態で 0.25 以上下がった（意図しない落下。ジャンプはしていない）
//     air  … 空中のフレーム・dy = 終わりの高さの差・state・ledge の数え（stepOffs / climbs / falls）
//     first … 初めて空中になったときの様子（縁の種類・はみ出し・接地の脚・下の脚・押している向きと縁の外向きの内積）
//   sweep(sites?, angs?, opt?) … 全部の組み合わせ
// opt: { secs = 4, gait = rig.gait, run = false }
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input;
  const r2 = (v) => +v.toFixed(2);
  const L = w.landmarks, A = L.logA, B = L.logB;
  // 場所：at（縁の上）・y（探し始める高さ）・dir（縁へ向かう向き、世界の x, z）
  const sites = {
    lowStep: { at: [10.2, -0.6], y: 9, dir: [-1, 0] },
    highCliff: { at: [15.9, -1.4], y: 11, dir: [0, -1] },
    slantRock: { at: [-14.2, 5.4], y: 4, dir: [0.6, -1] },
    log: { at: [(A[0] + B[0]) / 2, (A[2] + B[2]) / 2], y: A[1] + 1.2, dir: [0, 1] },
    plateau: { at: [2.0, 3.6], y: 8, dir: [-1, 0] },
  };
  const run = (name, angDeg = 0, opt = {}) => {
    const S = sites[name], secs = opt.secs ?? 4;
    if (opt.gait) a.rig.gait = opt.gait;
    a.rig.feet.reset();
    a.view.digFx.budgetMs = 1e9;
    a.freeze = true;
    c.teleport(S.at[0], S.at[1], w.contactSurfaceBelow(S.at[0], S.y, S.at[1]) + 0.02);
    const l = Math.hypot(S.dir[0], S.dir[1]);
    const t = (angDeg * Math.PI) / 180, ux = S.dir[0] / l, uz = S.dir[1] / l;
    const wx = ux * Math.cos(t) - uz * Math.sin(t), wz = ux * Math.sin(t) + uz * Math.cos(t);
    cam.mode = 'adventure';
    cam.adventure.yaw = Math.atan2(-wx, -wz);
    cam.placeBehind(c);
    a.freeze = false;
    inp.touchMove = { x: 0, y: 0 }; inp.touchJump = false; inp.touchRun = !!opt.run; a.dig = false;
    for (let i = 0; i < 30; i++) a.step(1);
    const ls0 = { ...c.ledgeStats }, y0 = c.y;
    let air = 0, fall = false, first = null, top = c.y, airRun = 0;
    const n = Math.round(secs * 60);
    for (let i = 0; i < n; i++) {
      inp.touchMove = __ct.axisFor(wx, wz);
      a.step(1);
      const gr = c.grounded || c.climbing;
      if (gr) { top = c.y; airRun = 0; } else {
        air++; airRun++;
        if (!first) {
          const F = a.rig.feet.support;
          first = { t: r2(i / 60), ledge: c.ledge ? { kind: c.ledge.kind, over: r2(c.ledge.over), holdT: r2(c.ledge.holdT), stepOff: c.ledge.stepOff, lowering: c.ledge.lowering, into: r2(wx * c.ledge.e[0] + wz * c.ledge.e[2]) } : null, planted: F.planted, down: F.down, face: F.face, fall: c.ledgeFall };
        }
        if (top - c.y > 0.25 && airRun > 4) fall = true;
      }
    }
    inp.touchMove = { x: 0, y: 0 }; inp.touchRun = false;
    for (let i = 0; i < 40; i++) a.step(1);
    const ls = {};
    for (const k of ['stepOffs', 'climbs', 'falls', 'steps']) ls[k] = c.ledgeStats[k] - ls0[k];
    return { site: name, ang: angDeg, gait: a.rig.gait, fall, air, dy: r2(c.y - y0), state: c.state, ledge: ls, first };
  };
  const sweep = async (names = Object.keys(sites), angs = [0, 35, 60, 80, 100], opt = {}) => {
    const out = [];
    for (const nm of names) for (const g of angs) {
      try { out.push(run(nm, g, opt)); } catch (e) { out.push({ site: nm, ang: g, error: String(e) }); }
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  };
  window.__cs = { sites, run, sweep };
})();
