// 引っこ抜き 2.0（鋏で挟んで引っ張る）の検証の道具（開発用ページで fetch(url).then(r => r.text()).then(eval) で読み込む）。
// window.__tug：
//   reset()                … 巣穴の生き物を穴の中へ戻す（?nosave で繰り返し試す。仲間になった後でも巣穴の状態へ戻す）
//   approach(d, side)      … 巣穴から d（体の中心まで）・横 side の所に置き、穴へ向ける（触角が見えるまで待つ）
//   grab()                 … 挟むを押す（__aqua.hold）。挟めたか・鋏の届き方を返す
//   run(sec, drive, opt)   … sec 秒進める。drive(t, s) → { x, z, run }（世界の向きの移動。null = 止まる）か 'release'。
//                             毎フレームの記録（引き出し量・張力・滑り・カニの位置・地形とのめり込み・ガラスの外）を返す
//   back(sec, run)         … 穴から離れる向きへ下がり続ける
//   side(sec)              … 穴のまわりを横へ動き続ける
//   pump(sec, on, off)     … 下がる（on 秒）→ 止まる（off 秒）を繰り返す
//   smart(sec)             … 暴れている間・滑りそうな間は止まり、それ以外は下がる（上手な人の遊び方）
(() => {
  const a = window.__aqua, c = a.crab, B = a.buddy, T = B.tug, G = a.grab, w = a.world, cam = a.camera, inp = a.input;
  const r3 = (v) => +(+v).toFixed(3);
  const axisFor = (wx, wz) => {
    const yaw = cam.yaw, l = Math.hypot(wx, wz) || 1;
    wx /= l; wz /= l;
    return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
  };
  const step = (n) => { a.freeze = false; a.step(n); a.freeze = true; };
  const tug = {
    reset() {
      a.hold = false;
      step(2);
      B.found = false;
      B.state = 'burrow';
      B.mode = 'free';
      T.popped = false;
      T.held = false;
      T.ext = 0;
      T.stamina = 1;
      T.u = T.restLen();
      T.dir.splice(0, 3, 0, 1, 0);
      T.drainEvents();
      B.drainEvents();
      step(2);
      return { found: B.found, ext: T.ext };
    },
    approach(d = 0.62, side = 0) {
      const [bx, , bz] = B.burrow;
      a.hold = false;
      c.teleport(bx + d, bz + side);
      c.heading = Math.atan2(bx - c.x, bz - c.z);
      cam.placeBehind(c);
      step(50);
      c.heading = Math.atan2(bx - c.x, bz - c.z);
      step(10);
      return { crab: [r3(c.x), r3(c.z)], dist: r3(Math.hypot(c.x - bx, c.z - bz)), peek: r3(T.peek), grabbable: T.grabbable(), hint: G.hint?.name ?? null, prompt: document.querySelector('#act-prompt')?.classList.contains('show') ? document.querySelector('#act-prompt .what').textContent : null };
    },
    grab() {
      a.hold = true;
      step(14);
      return { state: G.state, creature: G.holdingCreature?.name ?? null, held: T.held, examined: B.examined, reachErr: r3(a.rig.reachErr), pinchToGrip: r3(Math.hypot(a.rig.pinch[0] - T.p[0], a.rig.pinch[1] - T.p[1], a.rig.pinch[2] - T.p[2])) };
    },
    run(sec, drive, opt = {}) {
      const n = Math.round(sec * 60);
      const [bx, by, bz] = B.burrow;
      const rec = { frames: n, popped: false, popAt: null, slips: 0, releases: 0, maxExt: T.ext, minExt: T.ext, maxLoad: 0, maxOver: 0, maxWarn: 0, crabInside: 0, crabOutside: 0, buddyInside: 0, keepOutMin: Infinity, maxCrabJump: 0, maxJerk: 0, tugs: 0, rests: 0, stages: {}, samples: [] };
      let px = c.x, pz = c.z, pvx = 0, pvz = 0;
      const s0 = { ...G.stats }, t0 = { ...T.stats };
      for (let i = 0; i < n; i++) {
        const t = i / 60;
        const mv = drive ? drive(t, { ext: T.ext, env: T.env, warn: G.warn, load: G.load, restT: T.restT, held: T.held }) : null;
        if (mv === 'release') a.hold = false;
        else if (mv === 'grab') a.hold = true;
        const m = mv && typeof mv === 'object' ? mv : null;
        inp.touchMove = m ? axisFor(m.x, m.z) : { x: 0, y: 0 };
        inp.touchRun = !!(m && m.run);
        const wasFound = B.found;
        step(1);
        if (!wasFound && B.found && !rec.popped) { rec.popped = true; rec.popAt = r3(t); }
        rec.maxExt = Math.max(rec.maxExt, T.ext);
        rec.minExt = Math.min(rec.minExt, T.ext);
        rec.maxLoad = Math.max(rec.maxLoad, G.load);
        rec.maxOver = Math.max(rec.maxOver, G.over);
        rec.maxWarn = Math.max(rec.maxWarn, G.warn);
        rec.stages[T.stage] = (rec.stages[T.stage] ?? 0) + 1;
        if (w.contactSolid(c.x, c.y + c.radius, c.z) < c.radius * 0.7) rec.crabInside++;
        if (!w.insideTank(c.x, c.z, 0.05)) rec.crabOutside++;
        if (!B.found && T.held) rec.keepOutMin = Math.min(rec.keepOutMin, Math.hypot(c.x - bx, c.z - bz));
        if (B.found && w.contactSolid(B.x, B.y + 0.1, B.z) < 0) rec.buddyInside++;
        const vx = (c.x - px) * 60, vz = (c.z - pz) * 60;
        rec.maxCrabJump = Math.max(rec.maxCrabJump, Math.hypot(c.x - px, c.z - pz));
        if (i > 2) rec.maxJerk = Math.max(rec.maxJerk, Math.hypot(vx - pvx, vz - pvz) * 60);
        px = c.x; pz = c.z; pvx = vx; pvz = vz;
        if (opt.sample && i % opt.sample === 0) rec.samples.push([r3(t), r3(T.ext), r3(T.tension), r3(T.hold), r3(G.load), r3(G.warn), r3(Math.hypot(c.x - bx, c.z - bz)), r3(c.speed), T.stage, r3(T.env)]);
        if (!T.held && T.popped && !rec.popped) { rec.popped = true; rec.popAt = r3(t); }
        if (opt.until && opt.until()) { rec.frames = i + 1; break; }
      }
      inp.touchMove = { x: 0, y: 0 };
      inp.touchRun = false;
      rec.slips = G.stats.creatureSlips - s0.creatureSlips;
      rec.releases = G.stats.releases - s0.releases;
      rec.tugs = T.stats.tugs - t0.tugs;
      rec.rests = T.stats.rests - t0.rests;
      rec.keepOutMin = r3(rec.keepOutMin);
      for (const k of ['maxExt', 'minExt', 'maxLoad', 'maxOver', 'maxWarn', 'maxCrabJump', 'maxJerk']) rec[k] = r3(rec[k]);
      rec.end = { ext: r3(T.ext), held: T.held, found: B.found, buddyState: B.state, crab: [r3(c.x), r3(c.y), r3(c.z)], crabState: c.state, tumbles: c.tumbles };
      return rec;
    },
    awayDir() {
      const [bx, , bz] = B.burrow;
      const dx = c.x - bx, dz = c.z - bz, l = Math.hypot(dx, dz) || 1;
      return [dx / l, dz / l];
    },
    back(sec, run = false, opt = {}) {
      return tug.run(sec, () => { const [x, z] = tug.awayDir(); return { x, z, run }; }, opt);
    },
    side(sec, opt = {}) {
      return tug.run(sec, () => { const [x, z] = tug.awayDir(); return { x: -z, z: x }; }, opt);
    },
    pump(sec, on = 0.8, off = 0.6, opt = {}) {
      return tug.run(sec, (t) => { if (t % (on + off) > on) return null; const [x, z] = tug.awayDir(); return { x, z }; }, opt);
    },
    smart(sec, opt = {}) {
      return tug.run(sec, (t, s) => { if (s.env > 0.4 || s.warn > 0.2) return null; const [x, z] = tug.awayDir(); return { x, z }; }, opt);
    },
  };
  window.__tug = tug;
})();
