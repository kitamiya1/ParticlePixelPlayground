// 砂の回収・再配置（M2 第 2 段階）の自動検証。開発用ページ（?nosave）で climb_helpers.js（__ct）のあとに
// fetch(url).then(r => r.text()).then(eval) で読み込み、await __sand.all() → 項目ごとの結果。
// - gain：空振りで増えない・その場で掘り続けると増えなくなる・前へ掘り進めると増え続ける・容量で止まる（超えた分は捨てる）
// - mound：平らな砂に盛り続ける → 砂山の高さ・使った砂・カニが固体の中に入っていない
// - walk / climb：砂山へ歩いて登る・砂山の急な面へ張り付く
// - redig：盛った砂を掘り直すと砂が戻り、砂山が低くなる
// - tunnel：掘ったトンネルの中（床・突き当たり）へ盛る → 空洞が埋まる（先に掘った穴へ置ける）
// - glass / pipe：ガラス際・縦の管のそばには盛れない（理由）、ガラスの外へ砂がはみ出さない
// - buddy：仲間のそばには盛らない（仲間が固体の中に入らない）
// - mesh：見た目の三角形と当たり判定（砂の距離関数）の最初の面を光線で比べる（砂山・区画の境目をまたぐ砂山）
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input, fx = a.view.digFx, dig = w.dig;
  const r2 = (v) => +v.toFixed(2), r3 = (v) => +v.toFixed(3);
  const steps = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.step(1); } };
  const go = (x, z, heading, y) => {
    a.freeze = true;
    c.teleport(x, z, y);
    c.heading = heading;
    cam.mode = 'adventure';
    cam.placeBehind(c);
    a.freeze = false;
    inp.touchMove = { x: 0, y: 0 }; a.dig = false; a.digAim = null; inp.touchJump = false;
    steps(30);
  };
  const hold = (secs, aim, move) => {
    a.dig = true; a.digAim = aim ? { x: aim[0], y: aim[1] } : null;
    steps(Math.round(secs * 60), () => { if (move) inp.touchMove = __ct.axisFor(move[0], move[1]); });
    a.dig = false; a.digAim = null; inp.touchMove = { x: 0, y: 0 };
    steps(6);
    dig.measureStep(Infinity);
  };
  const height = (x, z) => w.contactSurfaceBelow(x, 9, z) - w.groundAt(x, z);
  const inSolid = () => r3(w.contactSolid(c.x, c.y + c.radius, c.z) - c.radius);

  const gain = () => {
    fx.budgetMs = 1e9;
    c.tool = 'dig'; c.sandHeld = 0;
    go(-6, 2, Math.PI / 2);
    const s0 = { ...c.sandStats };
    hold(1, [0, 1]);
    const whiff = r3(c.sandHeld);
    hold(1.5);
    const first = r3(c.sandHeld);
    hold(1.5);
    const again = r3(c.sandHeld - first);
    // 前へ掘り進める（6 秒）→ 容量まで
    hold(6, null, [1, 0]);
    fx.flushAll();
    return { whiff, inPlace: first, inPlaceAgain: again, forward: r3(c.sandHeld), cap: c.sandHeld >= 4 - 1e-6, overflow: r3(c.sandStats.overflow - s0.overflow), measureMs: r2(c.sandStats.maxMeasureMs) };
  };

  const mound = () => {
    c.tool = 'fill'; c.sandHeld = 4;
    go(-8, 0.5, Math.PI / 2);
    const g0 = c.sandHeld, p0 = c.sandStats.places;
    let worstIn = 1;
    a.dig = true;
    steps(360, () => { worstIn = Math.min(worstIn, w.contactSolid(c.x, c.y + c.radius, c.z) - c.radius); });
    a.dig = false; steps(6); dig.measureStep(Infinity); fx.flushAll(); steps(2);
    const prof = [];
    for (let d = 0.2; d <= 2.0; d += 0.2) prof.push(r2(height(c.x + d, c.z)));
    return { spent: r3(g0 - c.sandHeld), places: c.sandStats.places - p0, fills: dig.fillCount, maxHeight: Math.max(...prof), profile: prof, crabClear: r3(worstIn), why: c.digAim.fillWhy };
  };

  const walkClimb = () => {
    // 砂山へ歩いて登る（+x へ）→ 頂上の高さ
    const top = [c.x + 0.9, c.z];
    const y0 = c.y;
    steps(150, () => { inp.touchMove = __ct.axisFor(1, 0); });
    inp.touchMove = { x: 0, y: 0 }; steps(20);
    const walk = { maxRise: r2(c.y - y0), state: c.state, onSand: w.surfaceMaterial(c.x, c.y - 0.05, c.z) };
    return { walk, top };
  };

  const redig = () => {
    // 砂山の手前から砂山へ向かって掘る：砂が戻り、砂山が低くなる
    c.tool = 'dig';
    go(-8, 0.5, Math.PI / 2);
    const h0 = c.sandHeld, top0 = Math.max(...[0.6, 0.8, 1.0, 1.2].map((d) => height(c.x + d, c.z)));
    hold(2.5, [0, 0.2]);
    fx.flushAll(); steps(2);
    const top1 = Math.max(...[0.6, 0.8, 1.0, 1.2].map((d) => height(c.x + d, c.z)));
    return { regained: r3(c.sandHeld - h0), top0: r2(top0), top1: r2(top1) };
  };

  const tunnel = () => {
    // 岸の斜面の砂に水平のトンネルを掘ってから、突き当たりへ向かって盛る → 突き当たりの空洞が埋まる
    c.tool = 'dig'; c.sandHeld = 0;
    go(-4.6, 7.6, Math.PI / 2);
    hold(5, null, [1, 0]);
    fx.flushAll();
    const end = [c.x, c.y + c.radius, c.z];
    // 少し戻って（横歩きで体の向きが変わるので、掘った向きへ向け直して）、突き当たりの手前の床へ盛る
    steps(40, () => { inp.touchMove = __ct.axisFor(-1, 0); });
    inp.touchMove = { x: 0, y: 0 }; steps(10);
    c.heading = Math.PI / 2;
    c.tool = 'fill';
    const h0 = c.sandHeld, n0 = dig.count;
    // 盛る前：盛る所の空洞（前の空いている所）の値
    a.dig = true; a.digAim = { x: 0, y: -0.2 };
    let worst = 1;
    const placedIn = [];
    steps(300, () => {
      worst = Math.min(worst, w.contactSolid(c.x, c.y + c.radius, c.z) - c.radius);
      // 足した砂山の中心が、足す前は掘った空洞の中（砂の外）だったか
      while (dig.count > n0 + placedIn.length) {
        const p = dig.prims[n0 + placedIn.length];
        placedIn.push({ inCavity: dig.carve(p.a[0], p.a[1], p.a[2]) < 0, depth: r2(w.groundAt(p.a[0], p.a[2]) - p.a[1]) });
      }
    });
    a.dig = false; a.digAim = null; steps(6); dig.measureStep(Infinity); fx.flushAll(); steps(2);
    const added = dig.prims.slice(n0).filter((p) => p.fill);
    const solidNow = added.map((p) => r3(w.sandSolid(p.a[0], p.a[1], p.a[2])));
    return { depth: r2(w.groundAt(end[0], end[2]) - end[1]), spent: r3(h0 - c.sandHeld), fillsAdded: added.length, placedInCavity: placedIn.filter((q) => q.inCavity).length, belowGround: placedIn.map((q) => q.depth), solidNow, crabClear: r3(worst), why: c.digAim.fillWhy, end: end.map(r2) };
  };

  const glassPipe = () => {
    const out = {};
    c.tool = 'fill'; c.sandHeld = 4;
    // 手前のガラスへ向かって、ガラス際の砂へ盛る（z = 10 の手前。照準を少し下げてガラスの手前の砂を狙う）
    go(-6, 8.6, 0);
    a.dig = true; a.digAim = { x: 0, y: -0.45 }; steps(240); a.dig = false; a.digAim = null; steps(6); dig.measureStep(Infinity); fx.flushAll(); steps(2);
    let outside = 0;
    for (let x = -7; x <= -5; x += 0.1) for (let y = 0; y < 4; y += 0.1) if (w.sandSolid(x, y, 10.2) < 0 && y > w.groundAt(x, 10.2) + 0.02) outside++;
    out.glass = { why: c.digAim.fillWhy, fills: dig.fillCount, sandBeyondGlass: outside, height: r2(height(-6, 9.6)) };
    // 縦の管（排水管）へ向かって
    const col = w.stand.columns[0];
    go(col.x + col.r + 1.2, col.z, -Math.PI / 2);
    const f0 = dig.fillCount;
    a.dig = true; steps(120); a.dig = false; steps(6); dig.measureStep(Infinity);
    out.pipe = { why: c.digAim.fillWhy, fillsAdded: dig.fillCount - f0, distToPipe: r2(Math.hypot(c.x - col.x, c.z - col.z) - col.r) };
    return out;
  };

  const buddyCheck = () => {
    const b = a.buddy;
    // 仲間を前に置いて盛る（仲間の位置へ向かう）
    c.tool = 'fill'; c.sandHeld = 4;
    go(-3.5, 3.6, Math.PI / 2);
    const saved = { found: b.found, x: b.x, y: b.y, z: b.z };
    b.found = true; b.x = c.x + 0.95; b.z = c.z; b.y = w.groundAt(b.x, b.z);
    const f0 = dig.fillCount;
    a.freeze = false;
    a.dig = true; steps(120, () => { b.x = c.x + 0.95; b.z = c.z; b.y = w.groundAt(b.x, b.z); }); a.dig = false; steps(6); dig.measureStep(Infinity); fx.flushAll();
    const clear = r3(w.sandSolid(b.x, b.y + 0.15, b.z));
    Object.assign(b, saved);
    return { why: c.digAim.fillWhy, fillsAdded: dig.fillCount - f0, buddyClear: clear };
  };

  /**
   * 光線で見た目と当たり判定を比べる：中心 (x, z) のまわり ±R を、上から斜めに見下ろす光線（4 方向）で調べる。
   * 見た目 = 区画の三角形（掘った区画のメッシュ、無ければ高さ場の網）の最初の面、当たり判定 = 砂の距離関数（sandSolid）の最初の面。
   * 差が tol を超えた光線を数える（岩・流木の手前で当たる光線は除く：それらは別のメッシュ）
   */
  const meshCheck = (x0, z0, R = 1.4, step = 0.1, tol = 0.12) => {
    const terr = fx.d.terrain;
    const tri = (pos, idx, i0, i1, o, d, best) => {
      for (let i = i0; i < i1; i += 3) {
        const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
        if (ia === ib) continue;
        const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2];
        const e1x = pos[ib] - ax, e1y = pos[ib + 1] - ay, e1z = pos[ib + 2] - az;
        const e2x = pos[ic] - ax, e2y = pos[ic + 1] - ay, e2z = pos[ic + 2] - az;
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det, tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-4 && t < best.t) best.t = t;
      }
    };
    const castMesh = (o, d, maxT) => {
      const ids = new Set();
      for (let s = 0; s <= maxT; s += 0.25) {
        const x = o[0] + d[0] * s, z = o[2] + d[2] * s;
        for (const dx of [-0.3, 0, 0.3]) for (const dz of [-0.3, 0, 0.3]) ids.add(dig.chunkId(dig.ci(x + dx), dig.cj(z + dz)));
      }
      const best = { t: maxT };
      for (const id of ids) {
        const m = fx.meshes.get(id);
        if (m) tri(m.geometry.getAttribute('position').array, m.geometry.getIndex().array, 0, m.geometry.getIndex().count, o, d, best);
        else tri(terr.geo.getAttribute('position').array, terr.geo.getIndex().array, terr.chunks.start[id], terr.chunks.start[id] + terr.chunks.count[id], o, d, best);
      }
      return best.t;
    };
    const castSdf = (o, d, maxT, f) => {
      let t = 0;
      for (let i = 0; i < 400 && t < maxT; i++) {
        const v = f(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t);
        // 面をかすめただけ（接線）でなく、少し先で中へ入っているときだけ当たりにする（三角形も接線では当たらない）
        if (v < 0.002 && f(o[0] + d[0] * (t + 0.05), o[1] + d[1] * (t + 0.05), o[2] + d[2] * (t + 0.05)) < -0.01) return t;
        t += Math.max(v * 0.8, 0.01);
      }
      return Infinity;
    };
    const st = { rays: 0, bad: 0, skipped: 0, maxDiff: 0 };
    const ex = [];
    const dirs = [[0.5, -1, 0], [-0.5, -1, 0], [0, -1, 0.5], [0, -1, -0.5]].map((v) => { const l = Math.hypot(...v); return v.map((q) => q / l); });
    for (let x = x0 - R; x <= x0 + R + 1e-6; x += step) for (let z = z0 - R; z <= z0 + R + 1e-6; z += step) {
      for (const d of dirs) {
        const top = w.groundAt(x, z) + 2.5;
        const o = [x - d[0] * 2.5, top, z - d[2] * 2.5];
        const maxT = 5;
        const ts = castSdf(o, d, maxT, (px, py, pz) => w.sandSolid(px, py, pz));
        const tAll = castSdf(o, d, maxT, (px, py, pz) => w.solid(px, py, pz));
        if (tAll < ts - 0.05) { st.skipped++; continue; } // 岩・流木が手前
        if (!w.insideTank(o[0] + d[0] * ts, o[2] + d[2] * ts, 0.15)) { st.skipped++; continue; }
        const tm = castMesh(o, d, maxT);
        st.rays++;
        const diff = Math.abs(tm - ts);
        if (Number.isFinite(ts)) st.maxDiff = Math.max(st.maxDiff, Math.min(diff, 9));
        if (diff <= tol) continue;
        // 差があっても、面をかすめる光線（接線）では当たる位置が大きくずれる。食い違いとするのは：
        // 見た目の当たり（三角形）が当たり判定の面の上に無い（|砂の値| > tol / 2）か、2 つの当たりの間に深い砂（< −tol / 2）がある
        const at = (t) => w.sandSolid(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t);
        const onSurf = tm < maxT ? Math.abs(at(tm)) : Infinity;
        let deep = 0;
        const t0 = Math.min(ts, tm), t1 = Math.min(Math.max(ts, tm), maxT);
        for (let t = t0; t <= t1; t += 0.02) deep = Math.min(deep, at(t));
        if (onSurf <= tol / 2 && deep >= -tol / 2) { st.graze = (st.graze ?? 0) + 1; continue; }
        st.bad++;
        if (ex.length < 8) ex.push({ x: r2(x), z: r2(z), d: d.map(r2), sdf: r2(ts), mesh: r2(tm), onSurf: r3(onSurf), deep: r3(deep) });
      }
    }
    st.maxDiff = r3(st.maxDiff);
    return { ...st, examples: ex };
  };

  /** 区画の境目（x = 整数）をまたぐ砂山を盛って、境目の両側で比べる */
  const seam = () => {
    c.tool = 'fill'; c.sandHeld = 4;
    // 区画の境目 x = -11（TANK.minX = -18 から 7）。カニは境目の西 1.0 から東へ盛る
    go(-12.0, 1.5, Math.PI / 2);
    a.dig = true; steps(200); a.dig = false; steps(6); dig.measureStep(Infinity); fx.flushAll(); steps(2);
    return { fills: dig.fillCount, check: meshCheck(-11, 1.5, 0.8, 0.08) };
  };

  const all = async () => {
    const out = {};
    for (const [k, f] of [['gain', gain], ['mound', mound], ['walkClimb', walkClimb], ['redig', redig], ['tunnel', tunnel], ['glassPipe', glassPipe], ['buddy', buddyCheck], ['seam', seam]]) {
      try { out[k] = f(); } catch (e) { out[k] = { error: String(e) }; }
      await new Promise((r) => setTimeout(r, 0));
    }
    out.meshMound = meshCheck(-7.1, 0.5);
    out.meshTunnel = meshCheck(-2.5, 7.6, 1.6);
    out.counts = { prims: dig.count, fills: dig.fillCount, chunks: fx.stats.chunks };
    return out;
  };

  window.__sand = { all, gain, mound, walkClimb, redig, tunnel, glassPipe, buddy: buddyCheck, seam, meshCheck, go, hold, steps, height };
  return 'ok';
})();
