// 積み木・物理パズルの検証エリア（AquaBlocks / PropSystem.stepBox）の検証（開発用ページ ?nosave で fetch(url).then(r => r.text()).then(eval)）。window.__blocks：
//   settle()            … 並べたまま 8 秒：動いた量の最大・眠ったか
//   tower(n, o)         … 積み木を n 段に置いて 10 秒（o.yaw = 段ごとのずれの角・o.dx = 段ごとの横のずれ）：崩れたか・上の段の高さ・最大の速さ・めり込み
//   overhang(dx)        … 2 段目を dx ずらして置く（重心が下の箱の外なら倒れる）：落ちたか
//   bridge()            … 石の台 2 つの上に細長い棒を渡す：棒が台に載ったまま止まるか
//   footing()           … 平たい石の上にカニを歩かせる（カニの当たり判定に箱が入る）：カニが石の上に乗ったか
//   all()               … すべて
(() => {
  const a = window.__aqua, P = a.props;
  const r3 = (v) => +(+v).toFixed(3);
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      a.freeze = false;
      a.step(1, 1 / 60);
    }
    a.freeze = true;
  };
  const floor = () => P.props.find((p) => p.fixed);
  const top = () => floor().p[1] + floor().semi[1];
  const kinds = (k) => a.blocks.filter((b) => b.kind === k);
  const reset = () => {
    a.resetBlocks();
    run(90);
  };
  const qy = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const settle = () => {
    reset();
    const p0 = a.blocks.map((b) => [...b.p]);
    run(480);
    const moved = Math.max(...a.blocks.map((b, i) => Math.hypot(b.p[0] - p0[i][0], b.p[1] - p0[i][1], b.p[2] - p0[i][2])));
    return { moved: r3(moved), asleep: a.blocks.every((b) => !b.awake), deep: P.stats.deep };
  };
  const tower = (n, o = {}) => {
    reset();
    const B = kinds('block'), F = floor(), T = top();
    const cx = F.p[0] - 0.15, cz = F.p[2] + 0.25;
    P.stats.maxSpeed = 0;
    const d0 = P.stats.deep;
    // （o.seq：1 段ずつ、下の段が止まってから載せる。ハサミで積むときと同じ順）
    for (let i = 0; i < n; i++) {
      const below = i > 0 ? B[i - 1].p[1] + 0.1015 : T + 0.051;
      P.place(B[i], [cx + (o.dx ?? 0) * (i % 2 ? 1 : -1), o.seq ? below : T + 0.051 + i * 0.1015, cz], qy((o.yaw ?? 0) * i));
      if (o.seq) run(90);
    }
    run(600);
    const ys = B.slice(0, n).map((b) => r3(b.p[1] - T));
    // （段ごとに当たりの皮 2 mm ずつ高くなる）
    const standing = ys.every((y, i) => Math.abs(y - (0.05 + i * 0.1)) < 0.01 + 0.003 * i);
    return { n, standing, topY: ys[n - 1], ys, maxV: r3(P.stats.maxSpeed), deep: P.stats.deep - d0, asleep: B.slice(0, n).every((b) => !b.awake) };
  };
  const overhang = (dx) => {
    reset();
    const B = kinds('block'), F = floor(), T = top();
    const cx = F.p[0] + 0.3, cz = F.p[2] - 0.2;
    P.place(B[0], [cx, T + 0.051, cz], [0, 0, 0, 1]);
    P.place(B[1], [cx + dx, T + 0.153, cz], [0, 0, 0, 1]);
    run(360);
    return { dx, fell: B[1].p[1] - T < 0.1, y: r3(B[1].p[1] - T), tilt: r3(2 * Math.acos(Math.min(1, Math.abs(B[1].q[3])))) };
  };
  const bridge = () => {
    reset();
    const [p1, p2] = kinds('pillar'), [rod] = kinds('rod');
    const T = top();
    // 台は置いた所（中心の間 0.52、内側の間 0.37）。棒は台の上面の少し上へ、台をまたぐ向きで
    const x = (p1.p[0] + p2.p[0]) / 2, z = (p1.p[2] + p2.p[2]) / 2, y = p1.p[1] + p1.semi[1] + rod.semi[1] + 0.006;
    P.place(rod, [x, y, z], [0, 0, 0, 1]);
    run(480);
    const onTop = Math.abs(rod.p[1] - y) < 0.01;
    return { onTop, y: r3(rod.p[1] - T), pillarsMoved: r3(Math.hypot(p1.p[0] - p1.home[0], p1.p[2] - p1.home[2]) + Math.hypot(p2.p[0] - p2.home[0], p2.p[2] - p2.home[2])), tilt: r3(2 * Math.acos(Math.min(1, Math.abs(rod.q[3])))) };
  };
  const footing = () => {
    reset();
    const [s] = kinds('slab'), c = a.crab;
    // 平たい石を床の中央へ（カニが乗っても動かない：重さ 0.5。カニの体は上から押さない）
    const F = floor(), T = top();
    P.place(s, [F.p[0], T + s.semi[1] + 0.002, F.p[2] - 0.6], [0, 0, 0, 1]);
    run(60);
    c.teleport(F.p[0], F.p[2] - 0.6, T + 0.4);
    run(120);
    const onSlab = Math.abs(c.y - (T + 2 * s.semi[1])) < 0.03;
    return { onSlab, crabY: r3(c.y - T), slabMoved: r3(Math.hypot(s.p[0] - F.p[0], s.p[2] - (F.p[2] - 0.6))) };
  };
  const all = () => ({ settle: settle(), towers: [3, 4, 5, 6].map((n) => tower(n)), towersYaw: [3, 5].map((n) => tower(n, { yaw: 0.25, dx: 0.008 })), overhang: [0.03, 0.07].map(overhang), bridge: bridge(), footing: footing() });
  window.__blocks = { settle, tower, overhang, bridge, footing, all, run, reset };
})();
