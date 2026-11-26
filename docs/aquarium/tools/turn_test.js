// 第 9 段階：自然な方向転換の比較（開発用ページ ?nosave で fetch + eval。climb_helpers.js（__ct）を先に読み込む）。window.__tn：
//   run(name, mode, opt?) … 場面（scenes）で同じ入力を与え、方式 mode ごとに次を返す（描いた足先 rig.tipW で測る：方式によらず同じ測り方）
//     A = 'cycle'（従来の歩行周期）・B = 'step'（接地 IK・接地主導、第 8 段階まで）・C = 'pivot'（踏ん張り旋回）・D = 'tcycle'（旋回中は歩行周期）
//     slipMax / slipSum … 接地している足先の 1 フレームの最大の動き・動きの合計（滑らない = 0）。slipF = 0.004 より動いたフレーム（脚 × フレーム）
//     steps / fast        … 踏み替え（足先が地面を離れた回数）・同じ脚が 0.15 秒未満で続けて踏み替えた回数（バタつき。歩きの周期は約 0.19 秒）
//     swingMs             … 1 回の踏み替えの平均の時間
//     stretch / overF     … 描く足先の、付け根からの長さ / 届く長さ の最大（1 を超えると脚が届いていない）・接地中に 1.05 を超えた脚 × フレーム
//     yawMax / yawTot     … 体の向きの回る速さの最大（°/秒）・回った角の合計（°）。turnT = 回った角の 90% に達するまでの時間（秒）
//     speed               … 平均の速さ（操作の軽快さ：B と比べて遅くなっていないか）
//     side                … 前側（第 1・2 脚）と後ろ側（第 3・4 脚）の踏み替えの回数・平均の歩幅（横歩きで曲がると、曲がる中心は体の前か後ろに来る：内側 / 外側の違い）
//     ms / msMax          … CrabRig.update（CrabFeet を含む）の 1 フレームの平均・最大の計算時間
//   opt.onFrame(i) … 毎フレーム（撮影用）
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input, rig = a.rig;
  const r1 = (v) => +v.toFixed(1), r2 = (v) => +v.toFixed(2), r3 = (v) => +v.toFixed(3);
  const deg = 180 / Math.PI;
  const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
  const sp = w.spawn;
  // 入力：t（秒）→ { ang: 世界の向き（atan2(x, z)）, mag, run }。h0 = 始めの体の向き、m0 = 始めの横歩きの向き（体を回さずに進める向き）
  const hold = (secs, f) => ({ secs, f });
  // 体の前へ押す（左右どちらへ回っても 90°）ときは、少しずらして回る向きを方式によらずそろえる（同点で向きが分かれない）
  const TIE = 0.2;
  const scenes = {
    'その場で90°': { at: [sp.x, sp.z], h0: 0.4, seq: (h0, m0) => [hold(0.3, () => null), hold(1.2, () => ({ ang: h0 + TIE, mag: 0.16 })), hold(0.8, () => null)] },
    'その場で180°': { at: [sp.x, sp.z], h0: 0.4, seq: (h0, m0) => [hold(0.3, () => null), hold(0.45, (t) => ({ ang: m0 + Math.PI * Math.min(1, t / 0.45), mag: 0.16 })), hold(1.0, () => ({ ang: m0 + Math.PI, mag: 0.16 })), hold(0.8, () => null)] },
    '左右に連続して方向転換': { at: [sp.x, sp.z], h0: 0.4, seq: (h0, m0) => [hold(0.2, () => null), hold(0.6, () => ({ ang: m0, mag: 1 })), hold(0.6, () => ({ ang: m0 + Math.PI / 2, mag: 1 })), hold(0.6, () => ({ ang: m0, mag: 1 })), hold(0.6, () => ({ ang: m0 + Math.PI / 2, mag: 1 })), hold(0.6, () => ({ ang: m0, mag: 1 })), hold(0.6, () => null)] },
    '歩きながらゆっくり曲がる': { at: [sp.x, sp.z], h0: 0.4, seq: (h0, m0) => [hold(0.2, () => null), hold(3.0, (t) => ({ ang: m0 + (50 / deg) * t, mag: 1 })), hold(0.6, () => null)] },
    'ダッシュしながら曲がる': { at: [sp.x, sp.z], h0: 0.4, seq: (h0, m0) => [hold(0.2, () => null), hold(2.0, (t) => ({ ang: m0 + (100 / deg) * t, mag: 1, run: true })), hold(0.6, () => null)] },
    '岩の上で方向転換': { at: [-12.6, -1.45], y: 2.4, h0: -Math.PI / 2, seq: (h0, m0) => [hold(0.3, () => null), hold(1.0, () => ({ ang: h0 + TIE, mag: 0.18 })), hold(0.45, (t) => ({ ang: h0 + TIE + Math.PI * Math.min(1, t / 0.45), mag: 0.18 })), hold(0.8, () => ({ ang: h0 + TIE + Math.PI, mag: 0.18 })), hold(0.8, () => null)] },
    '斜面で方向転換': { at: [-4.0, 8.3], h0: -Math.PI / 2, seq: (h0, m0) => [hold(0.3, () => null), hold(1.0, () => ({ ang: h0 + TIE, mag: 0.18 })), hold(0.45, (t) => ({ ang: h0 + TIE + Math.PI * Math.min(1, t / 0.45), mag: 0.18 })), hold(0.8, () => ({ ang: h0 + TIE + Math.PI, mag: 0.18 })), hold(0.8, () => null)] },
  };
  const MODES = { A: ['cycle', 'step'], B: ['lead', 'step'], C: ['lead', 'pivot'], D: ['lead', 'cycle'] };
  // 撮影用のカメラ：カニを向きを変えずに追う（方式によらず同じ構図。camera.update の後で上書き）
  let camLock = null;
  const camUpdate = cam.update.bind(cam);
  cam.update = (...args) => {
    camUpdate(...args);
    if (!camLock) return;
    const L = camLock, T = [c.x, c.y + 0.1, c.z];
    cam.pose.target = T;
    cam.pose.pos = [T[0] + Math.sin(L.yaw) * Math.cos(L.pitch) * L.dist, T[1] + Math.sin(L.pitch) * L.dist, T[2] + Math.cos(L.yaw) * Math.cos(L.pitch) * L.dist];
    cam.pose.fov = L.fov ?? 50;
  };
  // CrabRig.update の計算時間
  let rigMs = 0;
  const rigUpdate = rig.update.bind(rig);
  rig.update = (...args) => {
    const t0 = performance.now();
    rigUpdate(...args);
    rigMs = performance.now() - t0;
  };
  const steps = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.step(1); } };
  const setStick = (s) => {
    if (!s) { inp.touchMove = { x: 0, y: 0 }; inp.touchRun = false; return; }
    const ax = __ct.axisFor(Math.sin(s.ang), Math.cos(s.ang));
    inp.touchMove = { x: ax.x * s.mag, y: ax.y * s.mag };
    inp.touchRun = !!s.run;
  };
  const run = (name, mode, opt = {}) => {
    const S = scenes[name];
    const [gait, turn] = MODES[mode];
    a.view.digFx.budgetMs = 1e9;
    a.uiPrefs?.set?.({ gait, turn });
    rig.gait = gait;
    rig.turnStyle = turn;
    rig.feet.reset();
    a.freeze = true;
    c.teleport(S.at[0], S.at[1], S.y !== undefined ? w.contactSurfaceBelow(S.at[0], S.y, S.at[1]) + 0.02 : undefined);
    c.heading = S.h0;
    cam.mode = 'adventure';
    cam.adventure.yaw = S.h0 + Math.PI;
    cam.placeBehind(c);
    camLock = opt.cam ?? { yaw: S.h0 + 0.9, pitch: 0.82, dist: 1.55 };
    a.freeze = false;
    setStick(null); inp.touchJump = false; a.dig = false; a.digAim = null;
    // 落ち着くまで（同じ始めの姿勢から）
    steps(50, () => { c.heading = S.h0; });
    const h0 = c.heading, m0 = h0 + Math.PI / 2;
    const seq = S.seq(h0, m0);
    const F = rig.feet;
    const st0 = { skips: F.turnSkips };
    const r = { frames: 0, dsum: 0, slipMax: 0, slipSum: 0, slipF: 0, steps: 0, fast: 0, swingN: 0, swingF: 0, stretch: 0, overF: 0, yawMax: 0, yawTot: 0, ms: 0, msMax: 0, yawSeries: [] };
    const prevTip = rig.tipW.map((p) => [...p]);
    const contactOf = (k) => (rig.ikW > 0.5 && F ? !F.feet[k].swing && F.feet[k].valid : rig.cycleLift[k] < 0.004);
    const was = rig.tipW.map((_, k) => contactOf(k));
    const lastLift = new Array(8).fill(-9), liftPos = rig.tipW.map(() => null), airF = new Array(8).fill(0);
    const side = { front: { steps: 0, len: 0 }, rear: { steps: 0, len: 0 } };
    let px = c.x, py = c.y, pz = c.z, ph = c.heading, t = 0, i = 0;
    for (const seg of seq) {
      const n = Math.round(seg.secs * 60);
      for (let j = 0; j < n; j++) {
        setStick(seg.f(j / 60));
        a.step(1);
        t += 1 / 60;
        r.frames++;
        r.dsum += Math.hypot(c.x - px, c.y - py, c.z - pz);
        px = c.x; py = c.y; pz = c.z;
        const dy = wrap(c.heading - ph);
        ph = c.heading;
        r.yawMax = Math.max(r.yawMax, Math.abs(dy) * 60 * deg);
        r.yawTot += Math.abs(dy) * deg;
        r.yawSeries.push(r.yawTot);
        r.ms += rigMs;
        r.msMax = Math.max(r.msMax, rigMs);
        for (let k = 0; k < 8; k++) {
          const P = rig.tipW[k], on = contactOf(k);
          if (on && was[k]) {
            const d = Math.hypot(P[0] - prevTip[k][0], P[1] - prevTip[k][1], P[2] - prevTip[k][2]);
            r.slipMax = Math.max(r.slipMax, d);
            r.slipSum += d;
            if (d > 0.004) r.slipF++;
          }
          if (!on && was[k]) {
            r.steps++;
            if (t - lastLift[k] < 0.15) r.fast++;
            lastLift[k] = t;
            liftPos[k] = [...P];
            airF[k] = 0;
          }
          if (!on) airF[k]++;
          if (on && !was[k] && liftPos[k]) {
            r.swingN++;
            r.swingF += airF[k];
            const sd = side[k % 4 < 2 ? 'front' : 'rear'];
            sd.steps++;
            sd.len += Math.hypot(P[0] - liftPos[k][0], P[2] - liftPos[k][2]);
            liftPos[k] = null;
          }
          was[k] = on;
          prevTip[k][0] = P[0]; prevTip[k][1] = P[1]; prevTip[k][2] = P[2];
          if (c.grounded || c.climbing) {
            r.stretch = Math.max(r.stretch, rig.legStretch[k]);
            if (on && rig.legStretch[k] > 1.05) r.overF++;
          }
        }
        opt.onFrame?.(i++);
      }
    }
    setStick(null);
    camLock = null;
    // 回り始め（回った角が 1° を超えた）から 90% までの時間
    const k0 = r.yawSeries.findIndex((v) => v > 1);
    const k90 = k0 < 0 ? -1 : r.yawSeries.findIndex((v) => v >= r.yawTot * 0.9) - k0;
    return {
      scene: name, mode,
      slipMax: r3(r.slipMax), slipSum: r3(r.slipSum), slipF: r.slipF,
      steps: r.steps, fast: r.fast, swingMs: r.swingN ? Math.round((r.swingF / r.swingN) * 1000 / 60) : null,
      stretch: r2(r.stretch), overF: r.overF,
      yawMax: Math.round(r.yawMax), yawTot: Math.round(r.yawTot), turnT: k90 >= 0 ? r2(k90 / 60) : null,
      speed: r2((r.dsum / r.frames) * 60),
      side: { front: [side.front.steps, side.front.steps ? r3(side.front.len / side.front.steps) : 0], rear: [side.rear.steps, side.rear.steps ? r3(side.rear.len / side.rear.steps) : 0] },
      skips: F.turnSkips - st0.skips,
      ms: r3(r.ms / r.frames), msMax: r3(r.msMax),
      state: c.state,
    };
  };
  const all = async (modes = ['A', 'B', 'C', 'D'], names = Object.keys(scenes)) => {
    const out = [];
    for (const name of names) for (const m of modes) {
      try { out.push(run(name, m)); } catch (e) { out.push({ scene: name, mode: m, error: String(e) }); }
      await new Promise((res) => setTimeout(res, 0));
    }
    a.uiPrefs?.set?.({ gait: 'lead', turn: 'step' });
    return out;
  };
  window.__tn = { scenes, MODES, run, all, setCam: (L) => { camLock = L; } };
  return 'ok';
})();
