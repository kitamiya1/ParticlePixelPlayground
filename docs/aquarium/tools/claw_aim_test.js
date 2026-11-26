// 第 2 段階（ハサミの狙いやすさ・景色の小石・岩をつかむ）の検証（開発用ページ ?nosave で fetch(url).then(r => r.text()).then(eval)）。
// window.__ca：
//   decor()   … 景色の小さな小石を挟む → 物理の物になる・頂点が動く → 運んで離す → 遠くへ行くと景色へ戻る（頂点は動いた所のまま）
//   heavy()   … 景色の大きな石を挟む：持ち上がらない・カニの速さが落ちる
//   fixed()   … 岩の面で「挟む」：岩をつかむ（動かない）→ 離れようとしても引き戻される → 強く引くと外れる
//   assist()  … 斜め前 0.55 の小石：押していない間は向きを変えない・挟まない。押すと向き直して挟む
//   antenna(d)… 巣穴の触角を、物より遠く（d）から挟めるか（tug_helpers.js の __tug を先に読む）
//   aim()     … 腕の向き（armAimExtra）で構えた鋏の先が右・上・下へずれる
// どれも { ok, ... } を返す
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, G = a.grab, D = a.decor, inp = a.input, rig = a.rig;
  const r3 = (v) => +(+v).toFixed(3);
  const step = (n) => { a.freeze = false; a.step(n); };
  const axisFor = (wx, wz) => {
    const yaw = a.camera.yaw, l = Math.hypot(wx, wz) || 1;
    wx /= l; wz /= l;
    return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
  };
  const walk = (wx, wz, frames) => { for (let i = 0; i < frames; i++) { inp.touchMove = axisFor(wx, wz); step(1); } inp.touchMove = { x: 0, y: 0 }; };
  const clear = () => { a.hold = false; inp.armAimExtra = null; inp.touchMove = { x: 0, y: 0 }; G.release(); step(3); };
  /** カニを heading へ向け、構えた鋏の先が点 p の上に来る所へ置く */
  const approachPoint = (p, heading, lift = 0) => {
    clear();
    c.teleport(p[0] - Math.sin(heading) * 0.6, p[2] - Math.cos(heading) * 0.6);
    c.heading = heading;
    step(20);
    for (let i = 0; i < 3; i++) {
      c.teleport(c.x + p[0] - rig.anchor[0], c.z + p[2] - rig.anchor[2]);
      c.heading = heading;
      step(15);
    }
    a.camera.placeBehind(c);
    step(3);
    return Math.hypot(rig.anchor[0] - p[0], rig.anchor[2] - p[2]) + lift * 0;
  };
  /** 景色の物のうち、条件に合い、まわりが開けた物の番号 */
  const findDecor = (want) => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < D.count; i++) {
      const it = D.item(i);
      if (it.active || it.gone || !want(it)) continue;
      const p = it.prop.p;
      if (w.regionAt(p[0], p[1], p[2]) !== 'tank' || w.waterLevelAt(p[0], p[1], p[2]) < p[1] + 0.3) continue;
      // 上が開けていて、岩・流木から離れている（カニが近づける）
      if (w.contactSolid(p[0], p[1] + 0.45, p[2]) < 0.3 || w.climbSolid(p[0], p[1] + 0.25, p[2]) < 0.2) continue;
      // ほかの景色の物から離れている（挟む物を取り違えない）
      let crowded = false;
      for (let k = 0; k < D.count && !crowded; k++) if (k !== i) { const q = D.item(k).prop.p; if (Math.hypot(q[0] - p[0], q[2] - p[2]) < 0.45) crowded = true; }
      if (crowded) continue;
      const d = Math.hypot(p[0] + 4, p[2] - 5);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const vtx = (geo, v) => { const P = geo.getAttribute('position'); return [P.getX(v), P.getY(v), P.getZ(v)]; };

  const ca = {
    decor() {
      const i = findDecor((it) => it.prop.mass < 0.3 && it.name === '小石');
      const it = D.item(i), pr = it.prop, p0 = [...pr.p];
      const geo = a.view.decorGeo.pebbles;
      const vBefore = vtx(geo, it.v0);
      approachPoint(pr.p, Math.PI / 2);
      a.hold = true;
      step(25);
      const held = G.holding === pr, active = D.item(i).active;
      // 運ぶ（横歩き 1 秒）→ 離す
      walk(0, 1, 60);
      const moved = Math.hypot(pr.p[0] - p0[0], pr.p[2] - p0[2]);
      a.hold = false;
      step(120);
      const rest = [...pr.p];
      // 景色の頂点が物の位置へ動いている（最初の頂点の、物の中心からの距離が大きさ程度・元の位置から動いた）
      const first = vtx(geo, it.v0);
      const vertNear = Math.hypot(first[0] - pr.p[0], first[1] - pr.p[1], first[2] - pr.p[2]);
      const vertMoved = Math.hypot(first[0] - vBefore[0], first[2] - vBefore[2]);
      // 遠くへ離れる → 景色へ戻る（頂点は置いた所のまま）
      walk(-1, 0, 150);
      step(30);
      const demoted = !D.item(i).active;
      const after = vtx(geo, it.v0);
      const stays = Math.hypot(after[0] - first[0], after[1] - first[1], after[2] - first[2]) < 1e-4;
      return { ok: held && active && moved > 0.3 && vertNear < pr.rb * 1.6 && vertMoved > 0.3 && demoted && stays, i, name: it.name, mass: r3(pr.mass), held, active, moved: r3(moved), rest: rest.map(r3), vertNear: r3(vertNear), vertMoved: r3(vertMoved), demoted, vertsStayed: stays, stats: { ...D.stats } };
    },
    heavy() {
      const i = findDecor((it) => it.prop.mass > 1.6);
      if (i < 0) return { ok: false, why: 'no heavy decor' };
      const it = D.item(i), pr = it.prop, p0 = [...pr.p];
      approachPoint(pr.p, Math.PI / 2);
      // 同じ所で、挟まずに歩いた速さ
      const x0 = c.x;
      walk(0, 1, 40);
      const free = Math.abs(c.x - x0) + Math.abs(c.z - 0);
      approachPoint(pr.p, Math.PI / 2);
      a.hold = true;
      step(25);
      const held = G.holding === pr;
      const cz0 = c.z, cx0 = c.x;
      let maxStrain = 0;
      for (let k = 0; k < 40; k++) { inp.touchMove = axisFor(0, 1); step(1); maxStrain = Math.max(maxStrain, G.strain); }
      inp.touchMove = { x: 0, y: 0 };
      const crabMoved = Math.hypot(c.x - cx0, c.z - cz0);
      const lift = pr.p[1] - p0[1];
      clear();
      return { ok: held && lift < 0.1 && maxStrain > 0.6, name: it.name, mass: r3(pr.mass), held, lift: r3(lift), crabMoved: r3(crabMoved), maxStrain: r3(maxStrain), freeRef: r3(free) };
    },
    fixed() {
      // 岩の縦の面（法線が水平）を探す
      let site = null;
      for (let gx = -13; gx < 6 && !site; gx += 0.23) for (let gz = -8; gz < 8 && !site; gz += 0.29) {
        const y0 = w.contactSurfaceBelow(gx, 6, gz) + 0.3;
        if (w.waterLevelAt(gx, y0, gz) < y0 + 0.3) continue;
        const d = w.climbSolid(gx, y0, gz);
        if (d < 0.1 || d > 0.45) continue;
        const n = w.climbNormal(gx, y0, gz);
        if (Math.abs(n[1]) > 0.25) continue;
        const p = [gx - n[0] * d, y0 - n[1] * d, gz - n[2] * d];
        if (w.surfaceMaterial(p[0] - n[0] * 0.02, p[1], p[2] - n[2] * 0.02) !== 'rock') continue;
        const hl = Math.hypot(n[0], n[2]);
        // 面の前 1.2 まで開けている（カニが立てて、離れる向きへ歩ける）
        let open = true;
        for (const k of [0.45, 0.8, 1.2]) { const fx = p[0] + (n[0] / hl) * k, fz = p[2] + (n[2] / hl) * k; if (w.contactSolid(fx, w.contactSurfaceBelow(fx, 6, fz) + 0.3, fz) < 0.26 || Math.abs(w.contactSurfaceBelow(fx, 6, fz) - (y0 - 0.3)) > 0.25) open = false; }
        if (!open) continue;
        // 近くに挟める物が無い（狙いの補助がそちらへ向かない）
        for (let k = 0; k < D.count && open; k++) { const q = D.item(k).prop.p; if (Math.hypot(q[0] - p[0], q[2] - p[2]) < 1.1) open = false; }
        for (const q of a.props.props) if (Math.hypot(q.p[0] - p[0], q.p[2] - p[2]) < 1.1) open = false;
        if (!open) continue;
        site = { p, n: [n[0] / hl, 0, n[2] / hl] };
      }
      if (!site) return { ok: false, why: 'no rock face' };
      const heading = Math.atan2(-site.n[0], -site.n[2]);
      approachPoint([site.p[0] + site.n[0] * 0.08, site.p[1], site.p[2] + site.n[2] * 0.08], heading);
      a.hold = true;
      step(20);
      const held = G.holdingCreature === G.fixed;
      const name = G.fixed.name;
      const x0 = c.x, z0 = c.z;
      // 離れる向きへ歩く 1.0 秒
      let slipAt = null;
      for (let k = 0; k < 150; k++) {
        inp.touchMove = axisFor(site.n[0], site.n[2]);
        step(1);
        if (k === 59) var away1 = Math.hypot(c.x - x0, c.z - z0);
        if (!slipAt && G.state !== 'holding') slipAt = k;
      }
      // まだつかんでいれば、走って（ダッシュ）離れる：強く引くと外れる
      let runSlip = null;
      if (G.state === 'holding') {
        for (let k = 0; k < 180 && runSlip === null; k++) { inp.touchMove = axisFor(site.n[0], site.n[2]); inp.touchRun = true; step(1); if (G.state !== 'holding') runSlip = k; }
        inp.touchRun = false;
      }
      inp.touchMove = { x: 0, y: 0 };
      const ev = G.stats;
      clear();
      // 比べる：挟まずに 1 秒歩いた距離
      approachPoint([site.p[0] + site.n[0] * 0.08, site.p[1], site.p[2] + site.n[2] * 0.08], heading);
      const fx0 = c.x, fz0 = c.z;
      walk(site.n[0], site.n[2], 60);
      const freeAway = Math.hypot(c.x - fx0, c.z - fz0);
      return { ok: held && away1 < freeAway * 0.5, site: site.p.map(r3), name, held, away1s: r3(away1), freeAway1s: r3(freeAway), walkSlipFrame: slipAt, runSlipFrame: runSlip, slips: ev.slips };
    },
    assist() {
      const pr = a.props.props.find((p) => p.id === 'pebble2');
      // 景色の小石・ほかの物から 1.2 以上離れた砂の上へ置き直す（いちばん近い物を取り違えない）
      let spot = null;
      for (let gx = -12; gx < 7 && !spot; gx += 0.31) for (let gz = -7; gz < 9 && !spot; gz += 0.37) {
        const y = w.contactSurfaceBelow(gx, 6, gz);
        if (w.climbSolid(gx, y + 0.4, gz) < 0.35 || Math.abs(w.contactNormal(gx, y + 0.05, gz)[1]) < 0.9) continue;
        let clear2 = true;
        if (w.regionAt(gx, y + 0.3, gz) !== 'tank') clear2 = false;
        // 平らな砂（まわり 0.7 の高さの差 0.06 以下。坂の下の小石は鋏が届かない）
        for (let k = 0; k < 8 && clear2; k++) { const qa = (k * Math.PI) / 4, qx = gx + Math.cos(qa) * 0.7, qz = gz + Math.sin(qa) * 0.7; if (Math.abs(w.contactSurfaceBelow(qx, 6, qz) - y) > 0.06) clear2 = false; }
        for (let k = 0; k < D.count && clear2; k++) { const q = D.item(k).prop.p; if (Math.hypot(q[0] - gx, q[2] - gz) < 1.0) clear2 = false; }
        for (const q of a.props.props) if (q !== pr && Math.hypot(q.p[0] - gx, q.p[2] - gz) < 1.0) clear2 = false;
        const bw = a.buddy.burrow;
        if (Math.hypot(bw[0] - gx, bw[2] - gz) < 1.5) clear2 = false;
        if (clear2) spot = [gx, y, gz];
      }
      if (!spot) return { ok: false, why: 'no open spot' };
      clear();
      pr.p.splice(0, 3, spot[0], spot[1] + pr.semi[1] + 0.01, spot[2]);
      pr.v.fill(0); pr.wake();
      step(40);
      // 小石が体の前・右寄り 45°・0.55 にある所へ（鋏は届かない）
      const heading = 0.4;
      clear();
      const ang = heading - Math.PI / 4;
      c.teleport(pr.p[0] - Math.sin(ang) * 0.55, pr.p[2] - Math.cos(ang) * 0.55);
      c.heading = heading;
      step(20);
      const h0 = c.heading;
      step(40);
      const idle = { headingDrift: r3(Math.abs(c.heading - h0)), hint: !!G.hint, near: G.near ? G.near.target === pr : false, state: G.state };
      // 押す（閉じる）：その場で鋏の側を小石へ向ける（30 フレーム）。届かなければ、小石の方へ少し歩くと挟む（最大 1 秒）
      a.hold = true;
      let grabbedAt = null;
      for (let k = 0; k < 30; k++) { step(1); if (G.holding === pr) { grabbedAt = k; break; } }
      const turned = r3(Math.abs(c.heading - h0));
      const facing = r3(Math.cos(Math.atan2(pr.p[0] - c.x, pr.p[2] - c.z) - c.heading));
      let walked = 0;
      for (let k = 0; k < 60 && grabbedAt === null; k++) {
        inp.touchMove = axisFor(pr.p[0] - c.x, pr.p[2] - c.z);
        step(1);
        walked++;
        if (G.holding === pr) grabbedAt = 30 + k;
      }
      inp.touchMove = { x: 0, y: 0 };
      clear();
      // 押していない間は向きを変えず・挟まない。押すと向き直し（腕も向けて）挟む（届かなければ少し歩けば挟む）
      return { ok: idle.headingDrift < 0.02 && !idle.hint && idle.near && idle.state === 'idle' && turned > 0.1 && grabbedAt !== null, idle, turned, facingAfterTurn: facing, grabbedFrame: grabbedAt, walkedFrames: walked };
    },
    antenna(d = 0.53) {
      if (!window.__tug) return { ok: false, why: 'load tug_helpers.js' };
      __tug.reset();
      const ap = __tug.approach(d);
      a.hold = true;
      let k = 0;
      for (; k < 40; k++) { step(1); if (G.holdingCreature === a.buddy.tug) break; }
      const ok = G.holdingCreature === a.buddy.tug;
      clear();
      return { ok, d, frames: k, approach: ap };
    },
    aim() {
      clear();
      c.teleport(-4, 5);
      c.heading = Math.PI / 2;
      step(30);
      const loc = () => {
        const dx = rig.anchor[0] - c.x, dz = rig.anchor[2] - c.z;
        const f = [Math.sin(c.heading), Math.cos(c.heading)], r = [-Math.cos(c.heading), Math.sin(c.heading)];
        // r = 体の右（heading から −90°）
        return { right: r3(dx * r[0] + dz * r[1]), fwd: r3(dx * f[0] + dz * f[1]), up: r3(rig.anchor[1] - c.y) };
      };
      const base = loc();
      const res = { base };
      for (const [k, x, y] of [['right', 1, 0], ['left', -1, 0], ['up', 0, 1], ['down', 0, -1]]) {
        inp.armAimExtra = { x, y };
        step(25);
        res[k] = { ...loc(), raised: G.rigGrip().on };
      }
      inp.armAimExtra = null;
      step(20);
      const ok = res.right.right > base.right + 0.08 && res.left.right < base.right - 0.08 && res.up.up > base.up + 0.06 && res.down.up < base.up - 0.06 && res.right.raised;
      clear();
      return { ok, ...res };
    },
  };
  window.__ca = ca;
})();
