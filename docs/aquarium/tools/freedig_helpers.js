// 自由方向の穴掘り・地下カメラの検証用の手助け（開発ページの中で fetch + eval して使う）。
//   await fetch('/docs/aquarium/tools/freedig_helpers.js').then((r) => r.text()).then(eval);
// window.__fd：
//   setup(x, z, heading)          … その地点へ置き、カメラを体の後ろへ（ゲームは止めたまま）
//   run(sec, dig, aim, move)      … 掘る（true/false）・照準 {x, y}・移動 {x, y} で sec 秒進める。カメラの位置の
//                                    1 フレームあたりの最大の動き（jump）と、注視の向きの最大の回り（turn, rad）を返す
//   snap(tag)                     … いまの状態（位置・深さ・地下の度合い・照準）を記録して返す
//   camStats()                    … いまのカメラ：壁までの最小距離・前方に見通せる距離・カニが画面に占める割合
//   sweep(n)                      … その場で視点を 1 周回して、カメラの跳ね・壁への近さ・見通しを測る
//   restore()                     … 移動入力の差し替えを戻す
(() => {
  const a = window.__aqua, c = a.crab, cam = a.camera, w = a.world, inp = a.input;
  if (!inp.__move) inp.__move = inp.moveAxis;
  let mv = { x: 0, y: 0 };
  inp.moveAxis = () => mv;
  const V = (p) => p.map((v) => +v.toFixed(3));
  const fd = {
    log: [],
    setup(x, z, heading) {
      a.freeze = true;
      c.teleport(x, z);
      c.heading = heading;
      cam.adventure.yaw = heading + Math.PI;
      cam.adventure.pitch = 0.3;
      cam.adventure.zoom = 3.2;
      cam.placeBehind(c);
      cam.adventure.yaw = heading + Math.PI;
      a.dig = false;
      a.digAim = null;
      mv = { x: 0, y: 0 };
      a.freeze = false;
      a.step(40);
      a.freeze = true;
      fd.log = [];
      return fd.snap('setup');
    },
    run(sec, dig, aim, move) {
      a.dig = dig;
      a.digAim = aim;
      mv = move ?? { x: 0, y: 0 };
      a.freeze = false;
      const n = Math.round(sec * 60);
      let jump = 0, turn = 0;
      let prev = [...cam.pose.pos], pf = dirOf();
      for (let i = 0; i < n; i++) {
        a.step(1);
        const p = cam.pose.pos, f = dirOf();
        jump = Math.max(jump, Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]));
        turn = Math.max(turn, Math.acos(Math.min(1, f[0] * pf[0] + f[1] * pf[1] + f[2] * pf[2])));
        prev = [...p];
        pf = f;
      }
      a.freeze = true;
      a.dig = false;
      a.digAim = null;
      mv = { x: 0, y: 0 };
      return { jump: +jump.toFixed(3), turn: +turn.toFixed(3) };
    },
    snap(tag) {
      const cy = c.y + c.radius;
      // （基準のビルドには無い値は既定値で読む）
      const s = { tag, pos: V([c.x, c.y, c.z]), depth: +(w.groundAt(c.x, c.z) - cy).toFixed(2), tunnel: +cam.tunnel.toFixed(2), fade: +(cam.crabFade ?? 0).toFixed(2),
        digPitch: +c.digPitch.toFixed(2), digYaw: +(c.digYaw ?? c.heading).toFixed(2), heading: +c.heading.toFixed(2), face: c.digAim.face ?? c.digAim.hit, hit: c.digAim.hit, mat: c.digAim.material,
        whiffs: c.digWhiffs ?? 0, strokes: c.digStrokes, prims: w.dig.count, state: c.state, camYaw: +cam.adventure.yaw.toFixed(2), ...fd.camStats() };
      fd.log.push(s);
      return s;
    },
    camStats() {
      const P = cam.pose.pos, T = cam.pose.target;
      const clear = w.cameraSolid(P[0], P[1], P[2], cam.region);
      const f = dirOf();
      // 前方の見通し：画面の中心の向きへ、最初に固体に当たるまで
      let t = 0;
      for (let i = 0; i < 80 && t < 12; i++) {
        const d = w.cameraSolid(P[0] + f[0] * t, P[1] + f[1] * t, P[2] + f[2] * t, cam.region);
        if (d < 0.01) break;
        t += Math.max(d * 0.9, 0.02);
      }
      // カニの大きさ（脚を広げた半径 0.45）が画面の縦に占める割合
      const dc = Math.hypot(P[0] - c.x, P[1] - (c.y + c.radius), P[2] - c.z);
      const fovR = (a.view.camera ? a.view.camera.fov : cam.pose.fov) * Math.PI / 180;
      const crabFrac = Math.min(1, (2 * Math.atan(0.45 / Math.max(dc, 0.01))) / fovR);
      return { camClear: +clear.toFixed(3), lookFree: +t.toFixed(2), camToCrab: +dc.toFixed(2), crabScreen: +crabFrac.toFixed(2), fov: +cam.pose.fov.toFixed(1), T: V(T) };
    },
    sweep(n = 120) {
      a.freeze = false;
      const y0 = cam.adventure.yaw;
      let jump = 0, minClear = 9, minFree = 99, sumFree = 0, sumCrab = 0, inSolid = 0;
      let prev = [...cam.pose.pos];
      for (let i = 0; i < n; i++) {
        cam.adventure.yaw = y0 + (i / n) * Math.PI * 2;
        a.step(1);
        const p = cam.pose.pos;
        jump = Math.max(jump, Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]));
        prev = [...p];
        const s = fd.camStats();
        minClear = Math.min(minClear, s.camClear);
        if (s.camClear < 0.05) inSolid++;
        minFree = Math.min(minFree, s.lookFree);
        sumFree += s.lookFree;
        sumCrab += s.crabScreen;
      }
      cam.adventure.yaw = y0;
      a.step(1);
      a.freeze = true;
      return { jump: +jump.toFixed(3), minClear: +minClear.toFixed(3), inSolid, minLookFree: +minFree.toFixed(2), avgLookFree: +(sumFree / n).toFixed(2), avgCrabScreen: +(sumCrab / n).toFixed(2) };
    },
    /** 床の高さの断面（カニの位置の前後を x 方向に。上から最初に当たる固体の高さ / 元の地表） */
    profile(x0 = c.x - 0.6, x1 = c.x + 0.9, z = c.z) {
      const out = [];
      for (let x = x0; x <= x1 + 1e-6; x += 0.1) {
        let y = 8;
        while (y > 0 && w.contactSolid(x, y, z) > 0.005) y -= 0.01;
        out.push(`${x.toFixed(1)}:${y.toFixed(2)}/${w.groundAt(x, z).toFixed(2)}`);
      }
      return out.join(' ');
    },
    /** 岸の斜面へ水平に 5 秒掘り、照準を上 0.75 にして 11 秒掘り進めて地表へ出て、3 秒歩く */
    exitTest(aimY = 0.75, upSecs = 11) {
      fd.setup(-4.6, 8.3, Math.PI / 2);
      const fwd = fd.run(5, true, { x: 0, y: 0 }, { x: 0, y: 1 });
      const sFwd = fd.snap('水平に 5 秒');
      const up = fd.run(upSecs, true, { x: 0, y: aimY }, { x: 0, y: 1 });
      const sUp = fd.snap(`斜め上（照準 ${aimY}）へ ${upSecs} 秒`);
      const walk = fd.run(3, false, null, { x: 0, y: 1 });
      const sWalk = fd.snap('歩いて 3 秒');
      return { fwd, up, walk, fallbacks: cam.blendFallback, log: [sFwd, sUp, sWalk].map((s) => ({ tag: s.tag, pos: s.pos, depth: s.depth, tunnel: s.tunnel, whiffs: `${s.whiffs}/${s.strokes}`, state: s.state, camClear: s.camClear, lookFree: s.lookFree, crabScreen: s.crabScreen })) };
    },
    /**
     * 曲がったトンネル：岸の斜面へ水平に 4 秒掘ってから、照準の左右を 0 → x1 へ secs 秒かけて少しずつずらしながら
     * スティックを前に倒したまま掘り進める。通った道（0.5 秒ごと）と、向きの変わり方・進んだ距離を返す
     */
    curveTest(x1 = 0.8, secs = 6) {
      fd.setup(-4.6, 8.3, Math.PI / 2);
      fd.run(4, true, { x: 0, y: 0 }, { x: 0, y: 1 });
      const s0 = fd.snap('まっすぐ 4 秒');
      const path = [[+c.x.toFixed(2), +c.z.toFixed(2)]];
      let jump = 0, turn = 0, len = 0, px = c.x, pz = c.z;
      const n = Math.round(secs / 0.5);
      for (let i = 1; i <= n; i++) {
        const r = fd.run(0.5, true, { x: (x1 * i) / n, y: 0 }, { x: 0, y: 1 });
        jump = Math.max(jump, r.jump);
        turn = Math.max(turn, r.turn);
        len += Math.hypot(c.x - px, c.z - pz);
        px = c.x;
        pz = c.z;
        path.push([+c.x.toFixed(2), +c.z.toFixed(2)]);
      }
      const s1 = fd.snap('曲げながら');
      return { start: { pos: s0.pos, heading: s0.heading }, end: { pos: s1.pos, heading: s1.heading, digYaw: s1.digYaw, tunnel: s1.tunnel, whiffs: `${s1.whiffs}/${s1.strokes}`, camClear: s1.camClear, lookFree: s1.lookFree }, turned: +(s0.heading - s1.heading).toFixed(2), travelled: +len.toFixed(2), jump, turn, path };
    },
    /**
     * 地上 ↔ 地下の出入り：岸の斜面へ水平に 5 秒掘った穴（区画は作り直して当たり判定に入れる）へ、地上から歩いて入り（4 秒）、
     * 中で視点を 1 周回し、後ろ向きに歩いて出る（4 秒）。それぞれのカメラの跳ね・向きの回り・地下の度合いを返す
     */
    entryTest() {
      fd.setup(-4.6, 8.3, Math.PI / 2);
      fd.run(5, true, { x: 0, y: 0 }, { x: 0, y: 1 });
      a.view.digFx.flushAll();
      fd.setup(-5.8, 8.3, Math.PI / 2);
      const walkIn = fd.run(4, false, null, { x: 0, y: 1 });
      const sIn = fd.snap('歩いて入る 4 秒');
      const sweep = fd.sweep(180);
      const walkOut = fd.run(4, false, null, { x: 0, y: -1 });
      const sOut = fd.snap('後ろへ歩いて出る 4 秒');
      return { walkIn, inside: { pos: sIn.pos, depth: sIn.depth, tunnel: sIn.tunnel, fade: sIn.fade, camClear: sIn.camClear, lookFree: sIn.lookFree, camToCrab: sIn.camToCrab, crabScreen: sIn.crabScreen }, sweep, walkOut, outside: { pos: sOut.pos, tunnel: sOut.tunnel, camToCrab: sOut.camToCrab } };
    },
    restore() {
      inp.moveAxis = inp.__move;
      a.freeze = false;
      a.dig = false;
      a.digAim = null;
    },
  };
  function dirOf() {
    const P = cam.pose.pos, T = cam.pose.target;
    const d = [T[0] - P[0], T[1] - P[1], T[2] - P[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  }
  window.__fd = fd;
})();
