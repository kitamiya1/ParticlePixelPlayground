// ハサミ集中モードの「腕の動かし方」3 種（surface = 面に沿う・ground = 床に沿う＋高さ・screen = 画面に沿う）を同じ課題で比べる
// （開発用ページ ?nosave で fetch + eval。先に focus_helpers.js（__focus）を読み込む）。window.__schemeCompare.all() → 表。
//
// 操作する人の代わり（bot）：行きたい世界の点への差を、その方式の入力（スティック左右・前後・高さ）へ直して入れる。
//   surface：スティックだけ（高さは自動）。高さを決めて置くときだけ高さの入力
//   ground ：スティック + 高さ。高さは「進む先 6 cm までの面のいちばん高い所 + 浮かせる高さ」（先を見て上げる、上手な人）
//   screen ：画面の右・上・奥の 3 つの入力の組み合わせ（3 × 3 を解く）。高さは ground と同じ目標
// 測るもの：かかったフレーム・入力の軸を何本同時に使ったか（2 本以上・3 本のフレーム数）・止まった回数（進まない 10 フレーム）・
//   面からの高さのずれ（行き来の間）・課題ができたか
// 課題：
//   over()   … 右の鋏で積み木 1 個を越えて向こう側の床まで（手前 7 cm → 向こう 7 cm）
//   place()  … 右の鋏で積み木を挟んで隣の積み木の上へ置く
//   reach()  … 左右の鋏で、床の 4 点を順に触る（届く範囲の端も含む）
(() => {
  const a = window.__aqua, X = window.__focus, F = a.focus;
  const r3 = (v) => +(+v).toFixed(3);
  const SPEED = 0.34;
  const S = (s) => (s === 'R' ? F.R : F.L);
  const G = (s) => (s === 'R' ? a.grab : a.grabL);
  const hov = (s) => F.hover(G(s));
  const skip = (s) => [a.grab.holding, a.grabL.holding];
  const floorAt = (s, x, y, z) => F.floorBelow([x, y, z], skip(s));
  let stat = null;
  const newStat = () => ({ frames: 0, axes2: 0, axes3: 0, stalls: 0, hSum: 0, hN: 0, hMin: 1, hMax: 0 });
  /** 世界の差 D（x, y, z）→ 入力 { mx, my, lift } */
  const toInput = (s, D, wantY) => {
    const yaw = a.camera.yaw;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    if (F.scheme !== 'screen') {
      const mx = D[0] * rx + D[2] * rz, my = D[0] * fx + D[2] * fz;
      const lift = wantY ? D[1] / 0.8 : 0;
      return { mx, my, lift };
    }
    const P = a.camera.pose.pos, T = a.camera.pose.target;
    let ex = T[0] - P[0], ey = T[1] - P[1], ez = T[2] - P[2];
    const el = Math.hypot(ex, ey, ez) || 1;
    ex /= el; ey /= el; ez /= el;
    let qx = -ez, qz = ex;
    const ql = Math.hypot(qx, qz) || 1;
    qx /= ql; qz /= ql;
    const ux = -qz * ey, uy = qz * ex - qx * ez, uz = qx * ey;
    // 列 = 右 q・上 u・奥 f×0.8（lift）
    const A = [[qx, ux, fx * 0.8], [0, uy, 0], [qz, uz, fz * 0.8]];
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const d0 = det(A);
    const col = (j) => A.map((row, i) => row.map((v, k) => (k === j ? D[i] : v)));
    return { mx: det(col(0)) / d0, my: det(col(1)) / d0, lift: det(col(2)) / d0 };
  };
  /**
   * 鋏 s を世界の点 (x, z) へ。y を決めない（hover）なら、面からの浮きを保つ。
   * surface は自動。ground・screen は先 6 cm の面のいちばん高い所 + 浮き（上手な人が先を見て上げる）
   */
  const go = (s, x, z, o = {}) => {
    const T = S(s);
    let f = 0, still = 0, last = [...T.p];
    for (; f < (o.max ?? 400); f++) {
      const dx = x - T.p[0], dz = z - T.p[2], d = Math.hypot(dx, dz);
      let wantY = o.y;
      // （挟みに行く：行き先の床の上・面に沿うと同じ高さ。途中の物は越えない＝横から挟む）
      if (o.atFloor && F.scheme !== 'surface') wantY = floorAt(s, x, T.p[1], z) + hov(s) + 0.02;
      if (wantY === undefined && F.scheme !== 'surface') {
        let hi = floorAt(s, T.p[0], T.p[1], T.p[2]);
        for (let k = 1; k <= 6 && d > 1e-4; k++) hi = Math.max(hi, floorAt(s, T.p[0] + (dx / d) * 0.01 * k, T.p[1], T.p[2] + (dz / d) * 0.01 * k));
        wantY = hi + hov(s) + 0.005;
      }
      const dy = wantY === undefined ? 0 : wantY - T.p[1];
      if (d < (o.tol ?? 0.008) && Math.abs(dy) < 0.008) break;
      // 速さの比（残りの距離に比例・最大 1）
      const D = [dx, dy, dz], dl = Math.hypot(...D);
      const inp = toInput(s, D, wantY !== undefined);
      const m = Math.max(Math.abs(inp.mx), Math.abs(inp.my), Math.abs(inp.lift), 1e-6);
      const k = Math.min(1, dl / 0.05) / m;
      const c = { mx: inp.mx * k, my: inp.my * k, lift: inp.lift * k };
      for (const key of ['mx', 'my', 'lift']) if (Math.abs(c[key]) < 0.04) c[key] = 0;
      X.ctl(s, c);
      X.run(1);
      // 記録
      const n = ['mx', 'my', 'lift'].filter((key) => c[key] !== 0).length;
      stat.frames++;
      if (n >= 2) stat.axes2++;
      if (n >= 3) stat.axes3++;
      const moved = Math.hypot(T.p[0] - last[0], T.p[1] - last[1], T.p[2] - last[2]);
      last = [...T.p];
      still = moved < 0.0003 && dl > 0.02 ? still + 1 : 0;
      if (still === 10) stat.stalls++;
      if (o.y === undefined && !G(s).holding) {
        // 鋏の先の、真下の面からの高さ（低すぎ = 当たる・高すぎ = 狙いにくい）
        const h = T.p[1] - floorAt(s, T.p[0], T.p[1], T.p[2]);
        stat.hSum += h;
        stat.hN++;
        stat.hMin = Math.min(stat.hMin, h);
        stat.hMax = Math.max(stat.hMax, h);
      }
    }
    X.ctl(s, { mx: 0, my: 0, lift: 0 });
    return { err: r3(Math.hypot(x - T.p[0], z - T.p[2])), frames: f };
  };
  const wait = (n) => {
    X.run(n);
    stat.frames += n;
  };
  const summary = (extra) => ({
    frames: stat.frames, sec: r3(stat.frames / 60), axes2: stat.axes2, axes3: stat.axes3, stalls: stat.stalls,
    clearMean: stat.hN ? r3(stat.hSum / stat.hN) : null, clearMin: stat.hN ? r3(stat.hMin) : null, clearMax: stat.hN ? r3(stat.hMax) : null, ...extra,
  });
  const flat = (p, q) => {
    const dx = q[0] - p[0], dz = q[2] - p[2], l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const over = (scheme) => {
    X.setup({ scheme });
    stat = newStat();
    // 右の鋏の前の積み木（[2]）を、体の側から外側へ横切る
    const B = X.blocks('block')[2], b0 = [...B.p];
    const c = a.crab, out = [-Math.cos(c.heading), Math.sin(c.heading)];
    go('R', B.p[0] - out[0] * 0.08, B.p[2] - out[1] * 0.08);
    const r = go('R', B.p[0] + out[0] * 0.08, B.p[2] + out[1] * 0.08);
    return summary({ ok: r.err < 0.02, err: r.err, blockPushed: r3(Math.hypot(B.p[0] - b0[0], B.p[2] - b0[2])) });
  };
  const place = (scheme) => {
    X.setup({ scheme });
    stat = newStat();
    // 右の鋏の前の積み木（[2]）を、その外側（右）に寄せて置いた積み木（[3]）の上へ（どちらも右の腕の届く所）
    const B = X.blocks('block'), pr = B[2], base = B[3], T = S('R');
    const cl = a.crab, rout = [-Math.cos(cl.heading), Math.sin(cl.heading)];
    // （右へ 12 cm。腕を伸ばしきる所：届かなければカニが少し寄る）
    a.props.place(base, [pr.p[0] + rout[0] * 0.12, pr.p[1], pr.p[2] + rout[1] * 0.12], pr.q);
    wait(40);
    const base0 = [...base.p];
    // 物の手前（カニの側）の外へ寄せて閉じる
    const c = a.crab, dx = pr.p[0] - c.x, dz = pr.p[2] - c.z, l = Math.hypot(dx, dz) || 1, off = pr.semi[0] + 0.015;
    X.ctl('R', { close: 0 });
    // （まず 4 cm 手前の床の高さへ下ろし、その高さのまま横から寄せる：上から寄せると物の角の上で止まる）
    go('R', pr.p[0] - (dx / l) * (off + 0.04), pr.p[2] - (dz / l) * (off + 0.04), { tol: 0.01, atFloor: true });
    go('R', pr.p[0] - (dx / l) * off, pr.p[2] - (dz / l) * off, { tol: 0.015, y: F.scheme === 'surface' ? undefined : T.p[1] });
    X.ctl('R', { close: 1 });
    wait(40);
    const held = G('R').holding === pr;
    if (!held) return summary({ ok: false, why: 'grab failed', state: G('R').state });
    // 持ち上げる：物の下の端を base の上 3 cm へ
    const topY = base.p[1] + base.semi[1];
    const clawFor = (bottom) => T.p[1] + (bottom - (pr.p[1] - pr.semi[1]));
    go('R', T.p[0], T.p[2], { y: clawFor(topY + 0.03), tol: 0.01 });
    // 物の中心を base の真上へ（毎回、物の今の位置から）
    for (let k = 0; k < 4; k++) {
      go('R', T.p[0] + base.p[0] - pr.p[0], T.p[2] + base.p[2] - pr.p[2], { y: clawFor(topY + 0.03), tol: 0.004, max: 160 });
      wait(10);
      if (Math.hypot(pr.p[0] - base.p[0], pr.p[2] - base.p[2]) < 0.012) break;
    }
    // 下げる（触れるまで）
    for (let k = 0; k < 40 && !pr.contact; k++) go('R', T.p[0] + base.p[0] - pr.p[0], T.p[2] + base.p[2] - pr.p[2], { y: T.p[1] - 0.006, tol: 0.004, max: 8 });
    wait(15);
    X.ctl('R', { close: 0 });
    wait(90);
    const gap = pr.p[1] - pr.semi[1] - (base.p[1] + base.semi[1]);
    const off2 = Math.hypot(pr.p[0] - base.p[0], pr.p[2] - base.p[2]);
    return summary({ ok: Math.abs(gap) < 0.012 && off2 < base.semi[0], gap: r3(gap), off: r3(off2), basePushed: r3(Math.hypot(base.p[0] - base0[0], base.p[2] - base0[2])) });
  };
  const reach = (scheme) => {
    X.setup({ scheme });
    stat = newStat();
    const c = a.crab, h = c.heading, fw = [Math.sin(h), Math.cos(h)], rt = [-Math.cos(h), Math.sin(h)];
    // カニから見た前・右（heading 0 = +z が前・右 = −x）。左右それぞれ 4 点（届く範囲の端に近い所も）
    const pts = { R: [[0.32, 0.08], [0.42, 0.15], [0.36, 0.22], [0.38, 0.03]], L: [[0.32, -0.06], [0.4, -0.12], [0.36, -0.18], [0.33, -0.02]] };
    const errs = [];
    for (const s of ['R', 'L']) {
      for (const [f, r] of pts[s]) {
        const sgn = s === 'R' ? 1 : 1;
        const x = c.x + fw[0] * f + rt[0] * r * sgn, z = c.z + fw[1] * f + rt[1] * r * sgn;
        errs.push(go(s, x, z, { max: 240 }).err);
      }
    }
    return summary({ ok: errs.every((e) => e < 0.03), errs, crabMoved: r3(Math.hypot(a.crab.x - c.x, a.crab.z - c.z)) });
  };
  const all = () => {
    const out = {};
    for (const scheme of ['surface', 'ground', 'screen']) out[scheme] = { over: over(scheme), place: place(scheme), reach: reach(scheme) };
    X.release();
    a.uiPrefs.set({ focusScheme: 'surface' });
    a.setFocus(false);
    return out;
  };
  window.__schemeCompare = { over, place, reach, all, go, toInput };
})();
