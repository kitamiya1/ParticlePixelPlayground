// ゴカイ（AquaWorm）の検証の道具（開発用ページで fetch(url).then(r => r.text()).then(eval) で読み込む）。
// window.__worm：
//   pick(i)                … 調べる個体（既定 0）
//   frame(ang, dist, h)    … 冒険カメラを個体の口（外なら頭）へ向ける（ang = 口から見たカメラの方位、ラジアン）
//   approach(d, ang)       … 口から d・方位 ang の所にカニを置いて口へ向け、顔を出させる（alert にして出るまで待つ）
//   grab()                 … 挟む（__aqua.hold）。挟めたか・どこを挟んだか
//   grabAt(node)           … 自動検証用：節 node の所を直接挟んだことにする（胴体の途中・抜けた後の体）
//   run(sec, drive, opt)   … sec 秒進める。drive(t, s) → { x, z, run }（世界の向きの移動）・'release'・'grab'・null（止まる）。
//                            毎フレームの記録（抜けた・滑った・最大の伸び・節の飛び・固体の中の節・発散・カニのめり込み）を返す
//   back(sec, run) / side(sec) / pump(sec, on, off) / smart(sec) … tug_helpers と同じ引き方
//   bodyCheck()            … いまの体（固体の中の節・節の間の伸びの最大・速さの最大）
(() => {
  const a = window.__aqua, c = a.crab, G = a.grab, wd = a.world, cam = a.camera, inp = a.input, S = a.worms;
  const r3 = (v) => +(+v).toFixed(3);
  let W = S.worms[0];
  const axisFor = (wx, wz) => {
    const yaw = cam.yaw, l = Math.hypot(wx, wz) || 1;
    wx /= l; wz /= l;
    return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
  };
  const step = (n) => { a.freeze = false; a.step(n); a.freeze = true; };
  const anchor = () => (W.nb > 0 ? W.mouth : [W.x[0], W.x[1], W.x[2]]);
  /** 外の節のうち固体の中（半径の半分より深い）の数。口の近くは穴なので除く */
  const insideCount = () => {
    let n = 0;
    const m = W.nb > 0 ? W.mouth : null;
    for (let i = 0; i < W.N; i++) {
      if (W.isBuried(i)) continue;
      const x = W.x[i * 3], y = W.x[i * 3 + 1], z = W.x[i * 3 + 2];
      if (m && Math.hypot(x - m[0], y - m[1], z - m[2]) < 0.09 + W.rad[i]) continue;
      if (wd.contactSolid(x, y, z) < -W.rad[i] * 0.5) n++;
    }
    return n;
  };
  const worm = {
    pick(i = 0) { W = S.worms[i]; return { id: W.id, N: W.N, len: r3(W.length), life: W.life, nb: W.nb }; },
    get w() { return W; },
    frame(ang = 0.9, zoom = null, h = null) {
      const p = anchor();
      cam.focus = [p[0], p[1] + 0.08, p[2]];
      cam.adventure.yaw = ang;
      if (zoom !== null) cam.adventure.zoom = zoom;
      if (h !== null) cam.adventure.pitch = h;
      return p.map(r3);
    },
    /**
     * 撮影用：止めた状態（freeze）で、カメラを点 at（既定 = 体の中ほど）から方位 ang・距離 dist・高さ h の所に置いて向ける
     * （次の描画からその構図。進めるとゲームのカメラに戻る）
     */
    look(ang = 0.8, dist = 1.4, h = 0.6, at = null) {
      a.freeze = true;
      // 外に出ている節とカニの中ほど（高さは地面から少し上）
      let sx = c.x, sz = c.z, n = 1;
      for (let i = 0; i < W.N; i++) if (!W.isBuried(i)) { sx += W.x[i * 3]; sz += W.x[i * 3 + 2]; n++; }
      sx /= n; sz /= n;
      const p = at ?? [sx, wd.surfaceBelow(sx, c.y + 0.6, sz) + 0.12, sz];
      cam.pose.pos.splice(0, 3, p[0] + Math.sin(ang) * dist, p[1] + h, p[2] + Math.cos(ang) * dist);
      cam.pose.target.splice(0, 3, p[0], p[1], p[2]);
      return p.map(r3);
    },
    /** 個体を住みかの砂の中へ戻す（鋏は離す）。feel = 手応えの設定を変える */
    reset(feel = null) {
      a.hold = false;
      G.release();
      a.grabL.release();
      step(2);
      if (feel) S.setFeel(feel);
      W.placeBuried(W.home);
      W.drainEvents();
      step(2);
      return { life: W.life, nb: W.nb, feel: S.feel };
    },
    approach(d = 0.62, ang = 0) {
      a.hold = false;
      step(2);
      const m = anchor();
      c.teleport(m[0] + Math.sin(ang) * d, m[2] + Math.cos(ang) * d);
      c.heading = Math.atan2(m[0] - c.x, m[2] - c.z);
      cam.placeBehind(c);
      step(10);
      c.heading = Math.atan2(m[0] - c.x, m[2] - c.z);
      // 顔を出させる（隠れていたら待たずに）
      if (W.nb > 0 && W.life !== 'dig') {
        W.life = 'alert';
        W.lifeT = 30;
      }
      for (let k = 0; k < 120 && W.nb >= W.N - 2; k++) step(2);
      step(20);
      return { crab: [r3(c.x), r3(c.z)], dist: r3(Math.hypot(c.x - m[0], c.z - m[2])), life: W.life, nb: W.nb, out: r3(W.outLen()), grabbable: W.grabbable(), hint: G.hint === W };
    },
    grab() {
      a.hold = true;
      step(40);
      return { state: G.state, held: W.held, node: r3(W.gS + W.gF), anchored: W.anchored, reachErr: r3(a.rig.reachErr) };
    },
    grabAt(node) {
      a.hold = true;
      const i = Math.min(W.N - 2, Math.floor(node)), f = node - i;
      G.release();
      G.state = 'holding';
      G.creature = W;
      G.close = 1;
      W.gS = i;
      W.gF = f;
      W.onGrab();
      return { node, held: W.held };
    },
    bodyCheck() {
      let ms = 0, mv = 0;
      for (let i = 0; i < W.N - 1; i++) if (!W.isBuried(i) || !W.isBuried(i + 1)) ms = Math.max(ms, W.strain[i]);
      for (let i = 0; i < W.N; i++) mv = Math.max(mv, Math.hypot(W.v[i * 3], W.v[i * 3 + 1], W.v[i * 3 + 2]));
      return { inside: insideCount(), maxStrain: r3(ms), maxV: r3(mv), life: W.life, nb: W.nb };
    },
    run(sec, drive, opt = {}) {
      const n = Math.round(sec * 60);
      const rec = { frames: n, popped: false, popAt: null, slips: 0, maxExt: W.ext, maxLoad: 0, maxOver: 0, maxWarn: 0, maxStrain: 0, maxNodeJump: 0, insideFrames: 0, maxInside: 0, crabInside: 0, maxV: 0, diverge0: W.stats.diverge, tugs0: W.stats.tugs, rests0: W.stats.rests, keepOutMin: Infinity, maxMouthT: 0, samples: [], stages: {} };
      const prev = Float64Array.from(W.x);
      const s0 = { ...G.stats };
      const pops0 = W.stats.pops;
      for (let i = 0; i < n; i++) {
        const t = i / 60;
        const mv = drive ? drive(t, { ext: W.ext, env: W.env, warn: G.warn, load: G.load, restT: W.restT, held: W.held, anchored: W.anchored }) : null;
        if (mv === 'release') a.hold = false;
        else if (mv === 'grab') a.hold = true;
        const m = mv && typeof mv === 'object' ? mv : null;
        inp.touchMove = m ? axisFor(m.x, m.z) : { x: 0, y: 0 };
        inp.touchRun = !!(m && m.run);
        const anch = W.anchored, mo = W.nb > 0 ? W.mouth : null;
        step(1);
        if (W.stats.pops > pops0 && !rec.popped) { rec.popped = true; rec.popAt = r3(t); }
        rec.maxExt = Math.max(rec.maxExt, W.ext);
        rec.maxLoad = Math.max(rec.maxLoad, G.load);
        rec.maxOver = Math.max(rec.maxOver, G.over);
        rec.maxWarn = Math.max(rec.maxWarn, G.warn);
        rec.maxMouthT = Math.max(rec.maxMouthT, W.mouthT);
        rec.stages[W.stage] = (rec.stages[W.stage] ?? 0) + 1;
        // 節の 1 フレームの移動（瞬間移動）：外にいた節だけ
        for (let k = 0; k < W.N; k++) {
          if (W.isBuried(k)) continue;
          const d = Math.hypot(W.x[k * 3] - prev[k * 3], W.x[k * 3 + 1] - prev[k * 3 + 1], W.x[k * 3 + 2] - prev[k * 3 + 2]);
          if (!(anch && !W.anchored)) rec.maxNodeJump = Math.max(rec.maxNodeJump, d);
        }
        prev.set(W.x);
        const bc = worm.bodyCheck();
        rec.maxStrain = Math.max(rec.maxStrain, bc.maxStrain);
        rec.maxV = Math.max(rec.maxV, bc.maxV);
        if (bc.inside) rec.insideFrames++;
        rec.maxInside = Math.max(rec.maxInside, bc.inside);
        if (wd.contactSolid(c.x, c.y + c.radius, c.z) < c.radius * 0.7) rec.crabInside++;
        if (W.held && mo) rec.keepOutMin = Math.min(rec.keepOutMin, Math.hypot(c.x - mo[0], c.z - mo[2]));
        if (opt.sample && i % opt.sample === 0) rec.samples.push([r3(t), r3(W.ext), r3(W.mouthT), r3(W.hold), r3(G.load), r3(G.warn), W.nb, r3(bc.maxStrain), W.stage, r3(W.env)]);
        if (opt.until && opt.until()) { rec.frames = i + 1; break; }
      }
      inp.touchMove = { x: 0, y: 0 };
      inp.touchRun = false;
      rec.slips = G.stats.creatureSlips - s0.creatureSlips;
      rec.tugs = W.stats.tugs - rec.tugs0;
      rec.rests = W.stats.rests - rec.rests0;
      rec.diverge = W.stats.diverge - rec.diverge0;
      delete rec.tugs0; delete rec.rests0; delete rec.diverge0;
      rec.keepOutMin = r3(rec.keepOutMin);
      for (const k of ['maxExt', 'maxLoad', 'maxOver', 'maxWarn', 'maxStrain', 'maxNodeJump', 'maxV', 'maxMouthT']) rec[k] = r3(rec[k]);
      rec.end = { ext: r3(W.ext), held: W.held, nb: W.nb, life: W.life, found: W.found, crab: [r3(c.x), r3(c.y), r3(c.z)], tumbles: c.tumbles };
      return rec;
    },
    awayDir() {
      const m = anchor();
      const dx = c.x - m[0], dz = c.z - m[2], l = Math.hypot(dx, dz) || 1;
      return [dx / l, dz / l];
    },
    back(sec, run = false, opt = {}) { return worm.run(sec, () => { const [x, z] = worm.awayDir(); return { x, z, run }; }, opt); },
    side(sec, opt = {}) { return worm.run(sec, () => { const [x, z] = worm.awayDir(); return { x: -z, z: x }; }, opt); },
    pump(sec, on = 0.8, off = 0.6, opt = {}) { return worm.run(sec, (t) => { if (t % (on + off) > on) return null; const [x, z] = worm.awayDir(); return { x, z }; }, opt); },
    smart(sec, opt = {}) { return worm.run(sec, (t, s) => { if (s.env > 0.4 || s.warn > 0.2) return null; const [x, z] = worm.awayDir(); return { x, z }; }, opt); },
  };
  window.__worm = worm;
})();
