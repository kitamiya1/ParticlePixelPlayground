// 第 3 段階（ゲームパッド・左右のハサミ・効果音・抜けた瞬間の演出）の検証（開発用ページ ?nosave で
// fetch(url).then(r => r.text()).then(eval)。tug_helpers.js・claw_aim_test.js を先に読む）。
// ゲームパッドは本物をつなげないので、navigator.getGamepads を置き換えた模擬のパッド（standard の配列）で確かめる。
// window.__pa：
//   pad()    … 接続の知らせ・左スティックで移動・遊び（0.1 は 0）・A ジャンプ・B ダッシュ・RT 右ハサミ・LT 左ハサミ（ヒステリシス）・
//              右スティックで腕・LB + 右スティックでカメラ・十字キーでカメラ・Y 道具・切断で全部離す
//   twoClaws() … 右と左のハサミで別々の小石を同時に挟む（同じ物は挟まない）・離す
//   leftTug()  … 左のハサミで巣穴の触角を挟み、引っ張りの案内・音が動く
//   audio()    … 最初の操作の前は AudioContext を作らない・操作で作る・音量 / 消音を覚える・各効果音が例外なく鳴る
//   pop()      … 引っこ抜いた瞬間：「スポン！」の文字・時間の間・音・宙返り（体の起こし具合が 1 回転）
(() => {
  const a = window.__aqua, c = a.crab, G = a.grab, GL = a.grabL, inp = a.input;
  const r3 = (v) => +(+v).toFixed(3);
  const step = (n) => { a.freeze = false; a.step(n); };
  // 模擬のパッド
  const btn = () => Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const fake = { index: 0, id: '模擬のパッド (standard)', connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: btn() };
  let attached = false;
  const attach = () => {
    navigator.getGamepads = () => (attached ? [fake] : []);
  };
  const connect = () => {
    attached = true;
    attach();
    const ev = new Event('gamepadconnected');
    ev.gamepad = fake;
    window.dispatchEvent(ev);
  };
  const disconnect = () => {
    attached = false;
    const ev = new Event('gamepaddisconnected');
    ev.gamepad = fake;
    window.dispatchEvent(ev);
  };
  const press = (i, v = 1) => { fake.buttons[i] = { pressed: v > 0.5, touched: v > 0, value: v }; };
  const release = (i) => press(i, 0);
  const axes = (lx, ly, rx, ry) => { fake.axes = [lx, ly, rx, ry]; };
  const resetPad = () => { fake.axes = [0, 0, 0, 0]; fake.buttons = btn(); };
  const toastText = () => document.getElementById('aqua-toast').textContent;
  const axisFor = (wx, wz) => {
    const yaw = a.camera.yaw, l = Math.hypot(wx, wz) || 1;
    wx /= l; wz /= l;
    return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
  };

  const pa = {
    pad() {
      const out = {};
      a.hold = false; a.holdL = false; G.release(); GL.release();
      c.teleport(-6.2, 7.0); c.heading = Math.PI / 2; step(20);
      connect();
      step(2);
      out.connect = { toast: toastText(), connected: a.pad.connected, id: a.pad.id };
      // 遊び：0.1 は動かない
      axes(0.1, -0.1, 0, 0); step(5);
      out.dead = { ...inp.padMove };
      // 左スティック前（y = −1）で 0.5 秒
      const p0 = [c.x, c.z];
      axes(0, -1, 0, 0); step(30);
      out.move = { pad: { ...inp.padMove }, moved: r3(Math.hypot(c.x - p0[0], c.z - p0[1])) };
      axes(0, 0, 0, 0);
      // B ダッシュ
      press(1); axes(1, 0, 0, 0); step(20); out.run = { run: inp.isRunning(), speed: r3(c.speed) }; release(1); axes(0, 0, 0, 0); step(20);
      // A ジャンプ
      const y0 = c.y; press(0); step(8); out.jump = r3(c.y - y0); release(0); step(60);
      // トリガー：右 0.3（まだ閉じない）→ 0.5（閉じる）→ 0.25（閉じたまま）→ 0.1（開く）
      const trig = [];
      for (const v of [0.3, 0.5, 0.25, 0.1]) { press(7, v); step(3); trig.push([v, a.pad.clawR, G.state]); }
      out.rightTrigger = trig;
      release(7); step(10);
      press(6, 1); step(10); out.leftTrigger = { clawL: a.pad.clawL, state: GL.state, rigOn: a.rig.gripL.on }; release(6); step(10);
      // 右スティック：腕の向き（右へ）
      const before = [...a.rig.anchor];
      axes(0, 0, 1, 0); step(25);
      out.armAim = { aim: inp.armAim(), anchorMoved: r3(Math.hypot(a.rig.anchor[0] - before[0], a.rig.anchor[2] - before[2])), raised: G.rigGrip().on };
      // LB + 右スティック：カメラ
      const yaw0 = a.camera.yaw;
      press(4); axes(0, 0, 1, 0); step(20); out.camLB = { dyaw: r3(a.camera.yaw - yaw0), armAimExtra: inp.armAimExtra };
      release(4); axes(0, 0, 0, 0); step(5);
      const yaw1 = a.camera.yaw; press(15); step(20); release(15); out.dpad = r3(a.camera.yaw - yaw1);
      // Y：掘る ↔ 盛る
      const tool0 = c.tool; press(3); step(2); release(3); step(2); out.toolY = [tool0, c.tool]; press(3); step(2); release(3); step(2);
      // 切断：押している物をすべて離す
      press(7, 1); axes(0.8, 0, 0, 0); step(10);
      const held = { clawR: a.pad.clawR, move: { ...inp.padMove } };
      disconnect(); step(5);
      out.disconnect = { before: held, after: { connected: a.pad.connected, clawR: a.pad.clawR, move: { ...inp.padMove }, grab: G.state }, toast: toastText() };
      resetPad();
      out.ok = out.connect.connected && out.dead.x === 0 && out.move.moved > 0.4 && out.run.run && out.jump > 0.05
        && trig[0][1] === false && trig[1][1] === true && trig[2][1] === true && trig[3][1] === false && out.leftTrigger.clawL && out.leftTrigger.state !== 'idle'
        && out.armAim.anchorMoved > 0.08 && Math.abs(out.camLB.dyaw) > 0.1 && out.camLB.armAimExtra === null && Math.abs(out.dpad) > 0.1 && out.toolY[0] !== out.toolY[1]
        && !out.disconnect.after.connected && !out.disconnect.after.clawR && out.disconnect.after.move.x === 0 && out.disconnect.after.grab === 'idle';
      return out;
    },
    twoClaws() {
      // 2 つの小石を、右の鋏の構え・左の鋏の構えの下へ置いて、両方の鋏で挟む
      a.hold = false; a.holdL = false; G.release(); GL.release();
      const P = a.props.props;
      const pr = P.find((q) => q.id === 'pebble2'), pl = P.find((q) => q.id === 'pebble3');
      c.teleport(-6.2, 7.0); c.heading = Math.PI / 2; step(30);
      const place = (q, at) => { q.p.splice(0, 3, at[0], a.world.contactSurfaceBelow(at[0], at[1] + 0.5, at[2]) + q.semi[1] + 0.01, at[2]); q.v.fill(0); q.wake(); };
      // 2 つの構えは近い（約 0.15）ので、外側へ少しずらして置く（小石どうしが押し合わない）
      const R = a.rig.anchor, L = a.rig.anchorL;
      const lx = L[0] - R[0], lz = L[2] - R[2], ll = Math.hypot(lx, lz) || 1;
      place(pr, [R[0] - (lx / ll) * 0.05, R[1], R[2] - (lz / ll) * 0.05]);
      place(pl, [L[0] + (lx / ll) * 0.05, L[1], L[2] + (lz / ll) * 0.05]);
      step(30);
      a.hold = true; a.holdL = true;
      step(30);
      const res = { right: G.holding?.id ?? null, left: GL.holding?.id ?? null, rightState: G.state, leftState: GL.state, leftReachErr: r3(a.rig.reachErrL) };
      // 持ったまま横歩き 0.7 秒
      const pl0 = [...pl.p], pr0 = [...pr.p];
      for (let i = 0; i < 40; i++) { inp.touchMove = { x: 1, y: 0 }; step(1); }
      inp.touchMove = { x: 0, y: 0 };
      res.carried = { right: r3(Math.hypot(pr.p[0] - pr0[0], pr.p[2] - pr0[2])), left: r3(Math.hypot(pl.p[0] - pl0[0], pl.p[2] - pl0[2])) };
      res.chip = document.getElementById('h-grab').textContent;
      a.hold = false; a.holdL = false; step(20);
      res.released = { right: G.state, left: GL.state, heldFlags: [pr.held, pl.held] };
      res.ok = res.right === 'pebble2' && res.left === 'pebble3' && res.carried.right > 0.3 && res.carried.left > 0.3 && res.released.right === 'idle' && res.released.left === 'idle';
      return res;
    },
    leftTug() {
      __tug.reset();
      a.hold = false; a.holdL = false; G.release(); GL.release();
      // 左の鋏の構えが触角の所に来るように置く（右の __tug.approach を左の鋏の分だけ横へずらす）
      __tug.approach(0.47);
      const T = a.buddy.tug;
      const g = T.nearest([...a.rig.anchorL]) ?? T.nearest([...a.rig.anchor]);
      const dx = g.p[0] - a.rig.anchorL[0], dz = g.p[2] - a.rig.anchorL[2];
      c.teleport(c.x + dx, c.z + dz); step(10);
      a.holdL = true;
      let k = 0;
      for (; k < 40 && GL.holdingCreature !== T; k++) step(1);
      const held = GL.holdingCreature === T;
      // 後ろへ下がって 1 秒
      const [bx, , bz] = a.buddy.burrow;
      const away = [c.x - bx, c.z - bz];
      for (let i = 0; i < 60; i++) { inp.touchMove = axisFor(away[0], away[1]); step(1); }
      inp.touchMove = { x: 0, y: 0 };
      const cue = document.getElementById('tug-cue').classList.contains('show');
      const r = { held, frames: k, cue, load: r3(GL.load), ext: r3(T.ext ?? 0), audioScrape: !!a.audio.ctx };
      a.holdL = false; step(10);
      r.ok = held && cue;
      return r;
    },
    audio() {
      const A = a.audio;
      const r = { ctxBefore: A.ctx ? A.ctx.state : null };
      A.unlock();
      r.ctxAfter = A.ctx ? A.ctx.state : null;
      const plays0 = A.stats.plays;
      let err = null;
      try {
        A.setTug({ load: 0.8, rub: 1, extV: 0.05, env: 0.6 });
        A.setTug({ load: 1.1, rub: 2, extV: 0.1, env: 1 });
        A.grunt(0.8); A.pop(1); A.bubble(); A.slip(); A.click(true); A.click(false);
        A.setTug(null);
      } catch (e) { err = String(e); }
      r.err = err;
      r.plays = A.stats.plays - plays0;
      const v0 = A.prefs.volume;
      A.setVolume(0.3); A.setMuted(true);
      r.saved = JSON.parse(localStorage.getItem('ppp-aquarium:audio'));
      r.button = a.audioMenu.button.textContent;
      A.setMuted(false); A.setVolume(v0);
      r.ok = !err && r.saved.muted === true && Math.abs(r.saved.volume - 0.3) < 1e-6 && r.button === '🔇';
      return r;
    },
    pop() {
      // 賢く引いて抜く（tug_helpers の smart）。抜けた瞬間の演出を記録する
      __tug.reset();
      const A = a.audio;
      const plays0 = A.stats.plays;
      const B = a.buddy;
      let popped = null, minPitch = 0, maxPitchDrop = 0, word = false, wordAt = null;
      const t0 = performance.now();
      const res = __tug.smart ? null : 'no smart';
      if (res) return { ok: false, why: res };
      // smart は抜けるまで進める。進めている途中の様子を見るため、毎フレームの記録を差し込む
      const orig = a.step;
      let frame = 0, p0 = null;
      a.step = (n, dt) => {
        for (let i = 0; i < n; i++) {
          orig(1, dt);
          frame++;
          if (!popped && B.state === 'flying') { popped = frame; p0 = B.pitch; }
          if (popped && B.state === 'flying') { minPitch = Math.min(minPitch, B.pitch); maxPitchDrop = Math.max(maxPitchDrop, (p0 ?? 0) - B.pitch); }
          if (!word && document.getElementById('pop-word').classList.contains('show')) { word = true; wordAt = frame; }
        }
      };
      __tug.approach(0.47);
      __tug.grab();
      try { __tug.smart(12); } finally { a.step = orig; }
      // 着地まで進める
      for (let i = 0; i < 120 && B.state === 'flying'; i++) step(1);
      return { ok: popped !== null && word && maxPitchDrop > 5.5, poppedFrame: popped, wordFrame: wordAt, pitchTurned: r3(maxPitchDrop), sounds: A.stats.plays - plays0, landed: B.state, found: B.found, ms: Math.round(performance.now() - t0) };
    },
  };
  window.__pa = pa;
})();
