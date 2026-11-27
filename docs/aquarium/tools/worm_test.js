// ゴカイの自動検証（worm_helpers.js の後に読み込む）。window.__wormTest(feels, only, runs) → 遊び方ごとの結果。
// 1/60 秒刻みで進める（実時間ではない）。?nosave で開く。
// 遊び方：still（挟んだまま動かない）・walk（まっすぐ後ろへ歩く）・dash（走って引く）・diag（斜め 50° 後ろ）・side（口のまわりを横へ）・
//   smart（暴れている・滑りそうな間は止まる）・pump（下がる/止まるを繰り返す）・regrab（途中で離して挟み直す）・
//   mid（途中で胴体の口に近い所を挟み直して引く）
// window.__wormCases：rock（岩の近くの巣穴から岩越しに引く）・digAround（巣穴のまわりを掘る）・fillOver（口の上に砂を盛る）・
//   carry（抜いた後に運んで離す）・multi（3 匹を同時に外で暮らさせる）
(() => {
  const a = window.__aqua, W = window.__worm, G = a.grab, c = a.crab, wd = a.world, S = a.worms;
  const r3 = (v) => +(+v).toFixed(3);
  const step = (n) => { a.freeze = false; a.step(n); a.freeze = true; };
  const pick = (r) => ({ popped: r.popped, popAt: r.popAt, slips: r.slips, maxExt: r.maxExt, maxWarn: r.maxWarn, maxStrain: r.maxStrain, maxNodeJump: r.maxNodeJump, insideFrames: r.insideFrames, maxV: r.maxV, tugs: r.tugs, rests: r.rests, diverge: r.diverge, crabInside: r.crabInside, keepOutMin: r.keepOutMin, endExt: r.end.ext, tumbles: r.end.tumbles });
  const prep = (feel) => {
    W.reset(feel);
    for (const d of [0.52, 0.47, 0.42]) {
      W.approach(d, 0.4);
      if (W.grab().held) return true;
      a.hold = false;
      step(20);
    }
    return false;
  };
  /** ext まで引き出して離し（0.5 秒）、挟むを押したまま口の方へ寄って挟み直し、また引く */
  const regrabAt = (ext) => {
    const r1 = W.back(8, false, { until: () => W.w.ext >= ext });
    const e0 = W.w.ext;
    const r2 = W.run(0.5, () => 'release');
    const e1 = W.w.ext;
    a.hold = true;
    // 体が鋏の前（体の中心から 0.4 以内）に来たら止まって待つ（体を踏み越えない）
    const r3_ = W.run(1.8, () => {
      const n = W.w.nearest([c.x, c.y + c.radius, c.z]);
      if (n && n.d < 0.4) return null;
      const [x, z] = W.awayDir();
      return { x: -x, z: -z };
    }, { until: () => W.w.held });
    const regrabbed = W.w.held, node = r3(W.w.gS + W.w.gF);
    const r4 = regrabbed ? W.back(12) : r3_;
    return { ...pick(r4), extAtRelease: r3(e0), extAfter: r3(e1), regrabbed, node, slips: r1.slips + r4.slips, insideFrames: r1.insideFrames + r2.insideFrames + r3_.insideFrames + r4.insideFrames };
  };
  const rot = (x, z, ang) => [x * Math.cos(ang) - z * Math.sin(ang), x * Math.sin(ang) + z * Math.cos(ang)];
  const plays = {
    still: () => W.run(5, () => null),
    walk: () => W.back(12),
    dash: () => W.back(6, true),
    diag: () => W.run(12, () => { const [x, z] = W.awayDir(); const [rx, rz] = rot(x, z, 0.87); return { x: rx, z: rz }; }),
    side: () => W.side(8),
    smart: () => W.smart(14),
    pump: () => W.pump(14),
    regrab: () => regrabAt(0.42),
    // 胴体の途中：半分ほど引き出してから、口に近い外の節（胴体の途中）の所へカニを寄せ、そこを直接挟んだことにして引く
    mid: () => {
      W.back(8, false, { until: () => W.w.ext >= 0.55 });
      const w = W.w;
      // 離して、口の方へ 0.25 寄る（体の途中が鋏の前に来る）。頭から 3 節目より後ろの外の節のうち、構えた鋏の先にいちばん近い所を挟む
      a.hold = false;
      W.run(0.25, () => { const [x, z] = W.awayDir(); return { x: -x, z: -z }; });
      const an = a.rig.anchor;
      let k = 3, best = Infinity;
      for (let i = 3; i < w.N - 1; i++) {
        if (w.isBuried(i + 1)) break;
        const d = Math.hypot(w.x[i * 3] - an[0], w.x[i * 3 + 1] - an[1], w.x[i * 3 + 2] - an[2]);
        if (d < best) { best = d; k = i; }
      }
      W.grabAt(k + 0.5);
      W.run(0.3, () => null);
      const r = W.back(12);
      return { ...pick(r), node: k + 0.5, nodeOf: w.N, clawDist: r3(best) };
    },
  };
  window.__wormTest = (feels = ['std'], only = null, runs = 2) => {
    const out = {};
    for (const feel of feels) {
      for (const [name, fn] of Object.entries(plays)) {
        if (only && !only.includes(name)) continue;
        const rows = [];
        for (let k = 0; k < runs; k++) {
          if (!prep(feel)) { rows.push({ grabbed: false }); continue; }
          const r = fn();
          rows.push(r.end ? pick(r) : r);
        }
        out[`${feel}:${name}`] = rows;
      }
    }
    a.hold = false;
    return out;
  };

  // ---------------- 場面 ----------------
  const inside = () => W.bodyCheck().inside;
  window.__wormCases = {
    /**
     * 石の隙間（岩・流木の根元）から：開いた側から近づいて挟み、口のまわりを横へ回って体を岩の縁にこすらせてから引き抜き、
     * 抜いた体を岩の方へ引きずる
     */
    rock() {
      const w = W.w;
      W.reset();
      const m = w.mouth;
      const d0 = wd.hardSolid(m[0], m[1] + 0.03, m[2]);
      const ang = W.openYaw() + Math.PI;
      let grabbed = false, used = null;
      for (const da of [0.4, -0.4, 0.9, -0.9]) {
        for (const dd of [0.52, 0.45]) {
          W.approach(dd, da);
          if (W.grab().held) { grabbed = true; used = r3(da); break; }
          a.hold = false; step(20);
        }
        if (grabbed) break;
      }
      if (!grabbed) return { mouth: m.map(r3), grabbed };
      const r1 = W.side(3);
      const r = W.back(12);
      // 抜いた体を岩の方へ引きずる
      const r2 = W.run(3, () => ({ x: Math.sin(ang), z: Math.cos(ang) }));
      return { mouth: m.map(r3), rockDist: r3(d0), approach: used, sideInside: r1.insideFrames, ...pick(r), dragToRock: { insideFrames: r2.insideFrames, maxInside: r2.maxInside, maxNodeJump: r2.maxNodeJump } };
    },
    /** 隠れている巣穴の口のまわりをカニが掘る（2026-11-28：石の隙間なので巣は壊れない） */
    digAround() {
      W.reset();
      const w = W.w, m = w.mouth;
      a.hold = false;
      const oy = W.openYaw();
      c.teleport(m[0] + Math.sin(oy) * 0.55, m[2] + Math.cos(oy) * 0.55);
      c.heading = Math.atan2(m[0] - c.x, m[2] - c.z);
      step(10);
      w.life = 'hidden'; w.lifeT = 99;
      const ev = [];
      let inMax = 0, frames = 0;
      c.tool = 'dig';
      // （石の隙間の巣は掘っても壊れない：3 秒掘り続けて、隠れたまま・体が自由にならないことを確かめる）
      for (let i = 0; i < 180; i++) {
        a.dig = true;
        a.digAim = { x: 0, y: -0.7 };
        c.heading = Math.atan2(m[0] - c.x, m[2] - c.z);
        step(1);
        frames++;
        for (const e of w.events) ev.push(e.kind);
        inMax = Math.max(inMax, inside());
      }
      a.dig = false; a.digAim = null;
      const r = W.run(4, () => null);
      return { frames, holes: wd.dig.count, nb: w.nb, life: w.life, events: [...new Set(ev)], insideMax: Math.max(inMax, r.maxInside), maxNodeJump: r.maxNodeJump, end: r.end };
    },
    /** 口の上に砂を盛る（巣穴が上へ延び、また顔を出せる） */
    fillOver() {
      W.reset();
      const w = W.w, m0 = w.mouth;
      a.hold = false;
      const oy = W.openYaw();
      c.teleport(m0[0] + Math.sin(oy) * 0.6, m0[2] + Math.cos(oy) * 0.6);
      c.heading = Math.atan2(m0[0] - c.x, m0[2] - c.z);
      step(10);
      c.tool = 'fill'; c.sandHeld = 4;
      for (let i = 0; i < 90; i++) { a.dig = true; a.digAim = { x: 0, y: -0.5 }; c.heading = Math.atan2(m0[0] - c.x, m0[2] - c.z); step(1); }
      a.dig = false; a.digAim = null; c.tool = 'dig';
      step(30);
      const m1 = w.mouth;
      c.teleport(m0[0] + Math.sin(oy) * 2.5, m0[2] + Math.cos(oy) * 2.5);
      w.life = 'hidden'; w.lifeT = 0.1;
      const r = W.run(6, () => null);
      return { fills: wd.dig.fillCount, mouthRise: r3(m1[1] - m0[1]), life: w.life, nb: w.nb, out: r3(w.outLen()), insideFrames: r.insideFrames };
    },
    /** 抜いた後：挟んだまま歩いて運び、持ち上げ、離して落とす */
    carry() {
      if (!prep('std')) return { grabbed: false };
      const r0 = W.back(12, false, { until: () => !W.w.anchored });
      if (W.w.anchored) return { popped: false };
      step(60);
      const w = W.w;
      const r1 = W.run(3, () => ({ x: 1, z: 0.3 }));
      const gp = w.gripPoint();
      const lag = Math.hypot(gp[0] - a.rig.pinch[0], gp[1] - a.rig.pinch[1], gp[2] - a.rig.pinch[2]);
      const r2 = W.run(2, () => ({ x: -0.3, z: 1, run: true }));
      a.hold = false;
      const r3_ = W.run(4, () => null);
      return { popAt: r0.popAt, carryInside: r1.insideFrames + r2.insideFrames, carryLag: r3(lag), carrySlips: r1.slips + r2.slips, dropInside: r3_.insideFrames, landedTouch: Array.from(w.touch).filter(Boolean).length, maxNodeJump: Math.max(r1.maxNodeJump, r2.maxNodeJump, r3_.maxNodeJump), life: w.life };
    },
    /** 3 匹を同時に外へ出して暮らさせる（這う・探す・潜る）。体の処理時間も測る */
    multi(sec = 20) {
      a.hold = false; G.release(); step(2);
      c.teleport(S.worms[0].home[0] + 6, S.worms[0].home[2] - 4);
      for (const w of S.worms) { if (!w.placeBuried(w.home)) continue; w.life = 'forage'; w.outTarget = 99; }
      const t0 = S.worms.map((w) => ({ ms: w.stats.stepMs, n: w.stats.steps }));
      const rec = S.worms.map(() => ({ insideFrames: 0, lives: new Set(), maxJump: 0 }));
      const prev = S.worms.map((w) => Float64Array.from(w.x));
      for (let i = 0; i < sec * 60; i++) {
        step(1);
        S.worms.forEach((w, k) => {
          const save = W.w; W.pick(k); const ins = W.bodyCheck().inside; W.pick(S.worms.indexOf(save));
          if (ins) rec[k].insideFrames++;
          rec[k].lives.add(w.life);
          if (w.nb === 0) for (let j = 0; j < w.N; j++) rec[k].maxJump = Math.max(rec[k].maxJump, Math.hypot(w.x[j * 3] - prev[k][j * 3], w.x[j * 3 + 1] - prev[k][j * 3 + 1], w.x[j * 3 + 2] - prev[k][j * 3 + 2]));
          prev[k].set(w.x);
        });
      }
      return S.worms.map((w, k) => ({ id: w.id, lives: [...rec[k].lives], insideFrames: rec[k].insideFrames, maxJump: r3(rec[k].maxJump), msPerFrame: r3((w.stats.stepMs - t0[k].ms) / Math.max(1, w.stats.steps - t0[k].n)), digs: w.stats.digs, diverge: w.stats.diverge, end: w.life }));
    },
  };
})();
