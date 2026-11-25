// 仲間（スナモグリ）の検証の道具（開発用ページで fetch(url).then(r => r.text()).then(eval) で読み込む）。
// window.__bd：
//   approach(d)          … 巣穴から d の所に置き、穴へ向ける
//   pullFlow()           … 調べる → 押したまま（引っ張らない）→ 離して長押し → 途中（0.3 秒）で離して中断 → もう一度長押しで抜く。
//                           各段の状態と、抜けるまでの時間（フレーム）・着地までの時間を返す
//   watch(sec, drive)    … sec 秒進めながら、毎フレーム仲間を調べる：固体の中（contactSolid < 0）・ガラスの外・水の外・
//                           1 フレームの移動の最大・カニからの距離の最大 / 平均・状態の数。drive(t) でカニの移動入力 { x, z }（ワールドの向き）
//   route(points, sec)   … カニを points（[x, z] の並び）へ順に歩かせ（走る）、watch と同じ記録を返す
(() => {
  const a = window.__aqua, c = a.crab, B = a.buddy, w = a.world, cam = a.camera, inp = a.input;
  const r3 = (v) => +v.toFixed(3);
  const axisFor = (wx, wz) => {
    const yaw = cam.yaw, l = Math.hypot(wx, wz) || 1;
    wx /= l; wz /= l;
    return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
  };
  const step = (n) => { a.freeze = false; a.step(n); a.freeze = true; };
  const bd = {
    approach(d = 0.85) {
      const [bx, , bz] = B.burrow;
      c.teleport(bx + d, bz - 0.15);
      c.heading = Math.atan2(bx - c.x, bz - c.z);
      cam.placeBehind(c);
      a.act = false;
      step(40);
      return { crab: [r3(c.x), r3(c.z)], state: c.state, prompt: document.querySelector('#act-prompt .what')?.textContent ?? null };
    },
    pullFlow() {
      const out = {};
      const st = () => ({ bs: B.state, examined: B.examined, pull: r3(B.pull), crab: c.state, prompt: document.querySelector('#act-prompt')?.classList.contains('show') ? document.querySelector('#act-prompt .what').textContent : null });
      out.start = st();
      a.act = true; step(2); out.afterExamine = st();
      step(20); out.heldNoRelease = st();
      a.act = false; step(3);
      // 中断：0.3 秒引っ張って離す
      a.act = true; step(18); out.midPull = st();
      a.act = false; step(1); out.cancelled = st();
      step(30); out.afterCancel = st();
      // 抜く：押し続けて何フレームで抜けるか
      a.act = true;
      let f = 0;
      while (B.state !== 'flying' && f < 200) { step(1); f++; }
      out.popFrames = f;
      out.popSec = r3(f / 60);
      const crabV = [r3(c.vx), r3(c.vy), r3(c.vz)];
      a.act = false;
      let g = 0;
      while (B.state === 'flying' && g < 400) { step(1); g++; }
      out.flightSec = r3(g / 60);
      out.landed = { state: B.state, found: B.found, pos: [r3(B.x), r3(B.y), r3(B.z)], distToCrab: r3(Math.hypot(B.x - c.x, B.z - c.z)), crabKick: crabV };
      out.stats = { ...B.stats };
      return out;
    },
    /** 毎フレームの記録（仲間の体の検査） */
    watch(sec, drive) {
      const n = Math.round(sec * 60);
      const rec = { frames: n, inside: 0, outsideGlass: 0, dry: 0, maxJump: 0, maxDist: 0, sumDist: 0, states: {}, warps0: B.stats.warps, minClear: Infinity };
      let px = B.x, py = B.y, pz = B.z;
      for (let i = 0; i < n; i++) {
        const mv = drive ? drive(i / 60) : null;
        inp.touchMove = mv ? axisFor(mv.x, mv.z) : { x: 0, y: 0 };
        inp.touchRun = !!(mv && mv.run);
        step(1);
        const clear = w.contactSolid(B.x, B.y + 0.1, B.z);
        rec.minClear = Math.min(rec.minClear, clear);
        if (clear < 0) rec.inside++;
        if (!w.insideTank(B.x, B.z, 0.2)) rec.outsideGlass++;
        if (B.y > 5.5 - 0.2) rec.dry++;
        rec.maxJump = Math.max(rec.maxJump, Math.hypot(B.x - px, B.y - py, B.z - pz));
        px = B.x; py = B.y; pz = B.z;
        const d = Math.hypot(B.x - c.x, B.z - c.z);
        rec.maxDist = Math.max(rec.maxDist, d);
        rec.sumDist += d;
        rec.states[B.state] = (rec.states[B.state] ?? 0) + 1;
      }
      inp.touchMove = { x: 0, y: 0 };
      inp.touchRun = false;
      rec.avgDist = r3(rec.sumDist / n);
      delete rec.sumDist;
      rec.maxDist = r3(rec.maxDist);
      rec.maxJump = r3(rec.maxJump);
      rec.minClear = r3(rec.minClear);
      rec.warps = B.stats.warps - rec.warps0;
      delete rec.warps0;
      rec.end = { buddy: [r3(B.x), r3(B.y), r3(B.z)], crab: [r3(c.x), r3(c.y), r3(c.z)], mode: B.mode };
      return rec;
    },
    route(points, sec, run = true) {
      let k = 0;
      return bd.watch(sec, () => {
        while (k < points.length && Math.hypot(points[k][0] - c.x, points[k][1] - c.z) < 0.35) k++;
        if (k >= points.length) return null;
        return { x: points[k][0] - c.x, z: points[k][1] - c.z, run };
      });
    },
  };
  window.__bd = bd;
})();
