// 挟む（AquaGrab）の検証の道具（開発用ページで fetch(url).then(r => r.text()).then(eval) で読み込む。?nosave で開く）。
// window.__gr：
//   reset()                    … 離して、挟める物をすべて置いた所へ戻す
//   approach(id, heading, d)   … カニを heading へ向け、構えた鋏の先（anchor）が物 id の真上に来る所へ置く（d = 前後のずらし）
//   hold(on, frames)           … 「挟む」を押す / 離して frames 進める。状態を返す
//   walk(wx, wz, sec, o)       … ワールドの向き (wx, wz) へ sec 秒歩く（o.run = 走る、o.jump = ジャンプを押す）。
//                                0.25 秒ごとの記録（カニの速さ・物の遅れ・地面からの高さ・鋏と物の表面の距離・ばねの伸び・状態）と、
//                                全体の最大値（物の 1 フレームの移動・めり込み・鋏と物のずれ）を返す
//   settle(sec)                … 進めて、物がすべて眠るまでの時間・めり込みの最大を返す
//   jitter(sec)                … 挟んだまま止まって、物の位置のぶれ（1 フレームの移動の最大・標準偏差）を返す
//   clearance(pr)              … 物の楕円体の最も奥の点の、地形・ガラスまでの距離（負 = めり込み）
//   view(dyaw, zoom, pitch)    … 冒険カメラをカニの向きから dyaw ずらした所へ（撮影用）
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input, G = a.grab, P = a.props;
  const r3 = (v) => +(+v).toFixed(3);
  const step = (n) => { a.freeze = false; a.step(n); a.freeze = true; };
  const axisFor = (wx, wz) => {
    const yaw = cam.yaw, l = Math.hypot(wx, wz) || 1;
    wx /= l; wz /= l;
    return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
  };
  const byId = (id) => P.props.find((p) => p.id === id);
  // 楕円体の、法線の逆向きの最も奥の点の距離
  const clearance = (pr) => {
    const n = w.contactNormal(pr.p[0], pr.p[1], pr.p[2]);
    let best = Infinity;
    // 法線の逆と、真下・横 4 方向の支点（どれか 1 つでもめり込んでいれば負）
    for (const d of [[-n[0], -n[1], -n[2]], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      // 物の座標へ回して楕円体の支点
      const q = pr.q, inv = [-q[0], -q[1], -q[2], q[3]];
      const rot = (qq, x, y, z) => {
        const [qx, qy, qz, qw] = qq;
        const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
        return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
      };
      const l = rot(inv, d[0], d[1], d[2]);
      const [sa, sb, sc] = pr.semi;
      const k = 1 / Math.hypot(sa * l[0], sb * l[1], sc * l[2]);
      const o = rot(q, sa * sa * l[0] * k, sb * sb * l[1] * k, sc * sc * l[2] * k);
      best = Math.min(best, w.contactSolid(pr.p[0] + o[0], pr.p[1] + o[1], pr.p[2] + o[2]));
    }
    return best;
  };
  const state = () => {
    const pr = G.holding;
    return {
      grab: G.state, held: pr?.id ?? null, close: r3(G.close), stretch: r3(G.stretch),
      contact: pr ? r3(P.surfaceDist(pr, ...a.rig.pinch)) : null,
      reachErr: r3(a.rig.reachErr), crab: c.state, hint: G.hint?.id ?? null,
    };
  };
  const gr = {
    clearance,
    state,
    reset() {
      a.hold = false;
      G.release();
      for (const p of P.props) P.reset(p);
      inp.touchMove = { x: 0, y: 0 };
      step(2);
      return true;
    },
    approach(id, heading = Math.PI / 2, d = 0) {
      const pr = byId(id);
      a.hold = false;
      c.teleport(pr.p[0] - Math.sin(heading) * 0.6, pr.p[2] - Math.cos(heading) * 0.6);
      c.heading = heading;
      step(20);
      for (let i = 0; i < 3; i++) {
        const ox = pr.p[0] - a.rig.anchor[0] + Math.sin(heading) * d, oz = pr.p[2] - a.rig.anchor[2] + Math.cos(heading) * d;
        c.teleport(c.x + ox, c.z + oz);
        c.heading = heading;
        step(15);
      }
      cam.placeBehind(c);
      step(5);
      return { ...state(), anchorToProp: r3(P.surfaceDist(pr, ...a.rig.anchor)) };
    },
    hold(on = true, frames = 20) {
      a.hold = on;
      step(frames);
      return state();
    },
    walk(wx, wz, sec = 1, o = {}) {
      const pr = G.holding;
      const n = Math.round(sec * 60);
      const rec = [];
      const max = { propStep: 0, pen: Infinity, contactErr: 0, stretch: 0 };
      let last = pr ? [...pr.p] : null;
      const x0 = c.x, z0 = c.z;
      for (let i = 0; i < n; i++) {
        inp.touchMove = wx || wz ? axisFor(wx, wz) : { x: 0, y: 0 };
        inp.touchRun = !!o.run;
        inp.touchJump = !!o.jump;
        step(1);
        const h = G.holding;
        if (h && last) {
          max.propStep = Math.max(max.propStep, Math.hypot(h.p[0] - last[0], h.p[1] - last[1], h.p[2] - last[2]));
          last = [...h.p];
          max.contactErr = Math.max(max.contactErr, Math.abs(P.surfaceDist(h, ...a.rig.pinch)));
          max.stretch = Math.max(max.stretch, G.stretch);
        }
        for (const p of P.props) if (p.awake) max.pen = Math.min(max.pen, clearance(p));
        if (i % 15 === 14) {
          rec.push({
            t: r3((i + 1) / 60), sp: r3(c.speed), st: G.state, crab: c.state,
            lag: h ? r3(Math.hypot(h.p[0] - a.rig.anchor[0], h.p[1] - a.rig.anchor[1], h.p[2] - a.rig.anchor[2])) : null,
            hGround: h ? r3(h.p[1] - h.semi[1] - w.contactSurfaceBelow(h.p[0], h.p[1], h.p[2])) : null,
            stretch: r3(G.stretch),
          });
        }
      }
      inp.touchMove = { x: 0, y: 0 };
      inp.touchRun = inp.touchJump = false;
      return { dist: r3(Math.hypot(c.x - x0, c.z - z0)), avgSpeed: r3(Math.hypot(c.x - x0, c.z - z0) / sec), rec, max: { propStep: r3(max.propStep), pen: r3(max.pen), contactErr: r3(max.contactErr), stretch: r3(max.stretch) }, end: state() };
    },
    settle(sec = 4) {
      let pen = Infinity, t = 0;
      for (let i = 0; i < sec * 60; i++) {
        step(1);
        for (const p of P.props) if (p.awake) pen = Math.min(pen, clearance(p));
        if (P.props.every((p) => !p.awake)) {
          t = (i + 1) / 60;
          break;
        }
      }
      return { sleptAfter: t || null, pen: r3(pen), awake: P.props.filter((p) => p.awake).map((p) => p.id) };
    },
    jitter(sec = 2) {
      const pr = G.holding;
      if (!pr) return null;
      step(30);
      const xs = [];
      let maxStep = 0, last = [...pr.p];
      for (let i = 0; i < sec * 60; i++) {
        step(1);
        maxStep = Math.max(maxStep, Math.hypot(pr.p[0] - last[0], pr.p[1] - last[1], pr.p[2] - last[2]));
        last = [...pr.p];
        xs.push([...pr.p]);
      }
      const m = [0, 1, 2].map((k) => xs.reduce((s, v) => s + v[k], 0) / xs.length);
      const sd = Math.sqrt(xs.reduce((s, v) => s + (v[0] - m[0]) ** 2 + (v[1] - m[1]) ** 2 + (v[2] - m[2]) ** 2, 0) / xs.length);
      return { maxStep: r3(maxStep), sd: +sd.toFixed(5) };
    },
    view(dyaw = -0.6, zoom = 2.4, pitch = 0.3) {
      cam.adventure.yaw = c.heading + dyaw;
      cam.adventure.zoom = zoom;
      cam.adventure.pitch = pitch;
      step(45);
      return true;
    },
    byId,
  };
  window.__gr = gr;
  return Object.keys(gr);
})();
