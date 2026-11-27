// 第 10 段階：砂を一度に多く盛る・持てる量の上限をなくす・救済、の検証（変更前のページでも動く：新しい関数は無ければ飛ばす）。
// 開発用ページ（?nosave）で climb_helpers.js（__ct）のあとに fetch + eval。window.__sf：
//   net(box?)    … 掘った・盛った範囲の砂の体積の差（格子 0.12。取り除いた分は負。見た目の版を全部当たり判定へ入れてから測る）
//   crater(secs) … スタート地点の東で、照準を左右・下へ振りながらその場で掘る（2 か所）→ 手持ち・得た量・捨てた量・穴の体積
//   refill(o)    … 同じ所で盛る向きに切り替え、照準を振りながら押し続けて穴を埋める（o.topUp = 手持ちを毎秒 4 へ戻す＝変更前の量の上限の影響を除く、
//                  o.tap = 1 回ずつたたく）。穴の体積の 90% を戻すまでの秒・回数・残り
//   redig()      … 盛った所を掘り直す → 戻った砂
//   rescue()     … 手持ちを 0 にして（以前の上限で捨てた状態の再現）地形から見直す → 戻った量・かかったフレーム
//   all()        … crater → refill → redig → rescue
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input, fx = a.view.digFx, dig = w.dig;
  const r2 = (v) => +v.toFixed(2), r3 = (v) => +v.toFixed(3);
  const steps = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.step(1); } };
  const X0 = w.spawn.x + 3.2, Z0 = w.spawn.z - 1.5, H = Math.PI / 2;
  const box = { x0: X0 - 1.2, x1: X0 + 4.2, z0: Z0 - 2.6, z1: Z0 + 2.6 };
  const net = (B = box) => {
    fx.flushAll();
    const h = 0.12;
    let d = 0;
    for (let i = Math.ceil(B.x0 / h); i * h <= B.x1; i++) for (let k = Math.ceil(B.z0 / h); k * h <= B.z1; k++) {
      const x = i * h, z = k * h, g = w.groundAt(x, z), ny = w.groundNormal(x, z)[1];
      for (let j = Math.ceil((g - 6) / h); j * h <= g + 2.2; j++) {
        const y = j * h, base = (y - g) * ny;
        const s0 = base < 0, s1 = dig.cut(base, x, y, z, 'live') < 0;
        if (s0 !== s1) d += s1 ? 1 : -1;
      }
    }
    return d * h * h * h;
  };
  const go = (x, z) => {
    a.freeze = true;
    c.teleport(x, z);
    c.heading = H;
    cam.mode = 'adventure';
    cam.placeBehind(c);
    a.freeze = false;
    inp.touchMove = { x: 0, y: 0 }; a.dig = false; a.digAim = null;
    steps(20);
  };
  // 照準を左右に振る（0.8 秒で一往復）
  let SW = { amp: 0.75, hz: 1.25 };
  const sweep = (i, y) => ({ x: SW.amp * Math.sin((i / 60) * Math.PI * 2 * SW.hz), y });
  const crater = (secs = 5) => {
    fx.budgetMs = 1e9;
    c.tool = 'dig'; c.sandHeld = 0;
    const s0 = { ...c.sandStats };
    const v0 = net();
    for (const dx of [0, 1.1]) {
      go(X0 + dx, Z0);
      a.dig = true;
      steps(Math.round(secs * 60), (i) => { a.digAim = sweep(i, -0.55); });
      a.dig = false; a.digAim = null; steps(8); dig.measureStep(Infinity);
    }
    const hole = net() - v0;
    return { held: r3(c.sandHeld), gained: r3(c.sandStats.gained - s0.gained), overflow: r3((c.sandStats.overflow ?? 0) - (s0.overflow ?? 0)), hole: r3(hole) };
  };
  let holeVol = 0;
  const refill = (o = {}) => {
    const v0 = net();
    holeVol = holeVol || -v0;
    const sw0 = SW;
    SW = { amp: o.amp ?? 0.45, hz: o.hz ?? 0.35 };
    c.tool = 'fill';
    go(X0 - (o.back ?? 1.4), Z0);
    const p0 = c.sandStats.places, f0 = c.sandStats.placeFails, sp0 = c.sandStats.spent;
    let t = 0, presses = 0, done = false, emptyT = 0, adv = 0;
    const whyN = {};
    const tally = () => { const y = c.digAim.fillWhy; if (c.digAim.active && y) whyN[y] = (whyN[y] || 0) + 1; };
    const tMax = o.tMax ?? 45;
    const target = v0 + 0.9 * holeVol;
    while (t < tMax) {
      if (o.topUp) c.sandHeld = Math.max(c.sandHeld, 4);
      if (o.tap) {
        presses++;
        a.dig = true; a.digAim = sweep(presses * 9, o.aimY ?? -0.2);
        steps(4, tally); a.dig = false; steps(8); t += 12 / 60;
      } else {
        if (t === 0) presses = 1;
        a.dig = true;
        const pf = c.sandStats.placeFails, pp = c.sandStats.places;
        steps(30, (i) => { a.digAim = sweep(Math.round(t * 60) + i, o.aimY ?? -0.2); tally(); if (o.advance && adv > 0) { inp.touchMove = __ct.axisFor(1, 0); adv--; } else inp.touchMove = { x: 0, y: 0 }; });
        // （届く範囲が埋まった：少し前へ進みながら盛る。遊ぶ人と同じ）
        if (o.advance && c.sandStats.placeFails - pf > c.sandStats.places - pp) adv = 18;
        t += 0.5;
      }
      if (c.sandHeld < 0.02) emptyT += o.tap ? 0.2 : 0.5;
      if (Math.round(t * 10) % 10 === 0) {
        a.dig = false; steps(4); dig.measureStep(Infinity);
        if (net() >= target) { done = true; break; }
        if (emptyT > 3 && !o.topUp) break;
      }
    }
    a.dig = false; a.digAim = null; inp.touchMove = { x: 0, y: 0 }; steps(8); dig.measureStep(Infinity);
    const v1 = net();
    SW = sw0;
    return { done, secs: r2(t), presses, strokes: c.sandStats.places - p0, fails: c.sandStats.placeFails - f0, restored: r3((v1 - v0) / Math.max(holeVol, 1e-6)), spent: r3(c.sandStats.spent - sp0), left: r3(c.sandHeld), emptyStop: emptyT > 3, inSolid: r3(w.contactSolid(c.x, c.y + c.radius, c.z) - c.radius), fills: dig.fillCount, why: whyN };
  };
  const redig = (o = {}) => {
    c.tool = 'dig';
    const h0 = c.sandHeld, v0 = net();
    go(X0 - (o.back ?? 1.4), Z0);
    a.dig = true;
    steps(180, (i) => { a.digAim = sweep(i, -0.4); });
    a.dig = false; a.digAim = null; steps(8); dig.measureStep(Infinity);
    return { gained: r3(c.sandHeld - h0), removed: r3(v0 - net()) };
  };
  const rescue = () => {
    if (!c.auditSand) return { skipped: 'no auditSand (変更前)' };
    const expect = -net({ x0: -60, x1: 60, z0: -60, z1: 60 });
    c.sandHeld = 0;
    const r0 = c.sandStats.rescued;
    c.auditSand(true);
    let n = 0;
    while (dig.auditing && n < 6000) { a.step(1); n++; }
    return { frames: n, rescued: r3(c.sandStats.rescued - r0), held: r3(c.sandHeld), expectByGrid: r3(expect), auditMs: r2(dig.stats.auditMs ?? 0), perFrameMs: r2(c.sandStats.auditMs ?? 0) };
  };
  // 平らな砂の上で、照準を動かさずに secs 秒押し続けて盛る（手持ちは毎フレーム 4 以上：変更前の量の上限の影響を除く）→ 盛った量・砂山の高さと幅
  const mound = (secs = 5, o = {}) => {
    fx.budgetMs = 1e9;
    c.tool = 'fill';
    const mx = -8, mz = 0.5;
    go(mx, mz);
    const s0 = c.sandStats.spent, p0 = c.sandStats.places, f0 = c.sandStats.placeFails;
    const top = (x, z) => w.contactSurfaceBelow(x, 9, z);
    const before = new Map();
    for (let dx = 0.2; dx <= 2.4; dx += 0.1) for (let dz = -1.4; dz <= 1.4; dz += 0.1) before.set(dx.toFixed(1) + ',' + dz.toFixed(1), top(c.x + dx, c.z + dz));
    a.dig = true;
    steps(Math.round(secs * 60), (i) => { c.sandHeld = Math.max(c.sandHeld, 4); a.digAim = o.amp ? { x: o.amp * Math.sin((i / 60) * Math.PI * 2 * 0.35), y: 0 } : null; });
    a.dig = false; a.digAim = null; steps(8); dig.measureStep(Infinity); fx.flushAll();
    // 高さ：体の前（+x）0〜2.4 の帯（横 ±1.4）の、元の地面からの最大の高さと、高さ 0.15 以上の幅（横）
    let hMax = 0, wide = 0;
    for (let dx = 0.2; dx <= 2.4; dx += 0.1) {
      let n = 0;
      for (let dz = -1.4; dz <= 1.4; dz += 0.1) {
        const x = c.x + dx, z = c.z + dz;
        const hh = top(x, z) - before.get(dx.toFixed(1) + ',' + dz.toFixed(1));
        hMax = Math.max(hMax, hh);
        if (hh > 0.15) n++;
      }
      wide = Math.max(wide, n * 0.1);
    }
    return { secs, placed: r3(c.sandStats.spent - s0), perSec: r3((c.sandStats.spent - s0) / secs), strokes: c.sandStats.places - p0, fails: c.sandStats.placeFails - f0, height: r2(hMax), width: r2(wide), inSolid: r3(w.contactSolid(c.x, c.y + c.radius, c.z) - c.radius) };
  };
  // 1 回だけたたく（小さな所を埋める）→ 盛った量・砂山の半径
  const tap = () => {
    c.tool = 'fill';
    go(-8, 0.5);
    c.sandHeld = Math.max(c.sandHeld, 4);
    const s0 = c.sandStats.spent;
    const n0 = dig.count;
    a.dig = true; steps(8); a.dig = false; steps(30); dig.measureStep(Infinity);
    const P = dig.prims[dig.prims.length - 1];
    return { placed: r3(c.sandStats.spent - s0), r: P && dig.count > n0 ? r2(P.r) : null, prims: dig.count - n0, why: c.digAim.fillWhy };
  };
  const all = async (o = {}) => {
    const out = {};
    out.crater = crater(o.secs ?? 5);
    await new Promise((r) => setTimeout(r, 0));
    out.refill = refill(o);
    await new Promise((r) => setTimeout(r, 0));
    out.redig = redig();
    out.rescue = rescue();
    return out;
  };
  window.__sf = { net, crater, refill, redig, rescue, all, box, mound, tap };
})();
