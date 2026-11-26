// 第 5 段階：石の軽量化と環境との相互作用 の検証（開発用ページ ?nosave で fetch + eval。grab_helpers.js（__gr）・
// climb_helpers.js（__ct）を先に読み込む）。公開版（変更前）でも carry() は動く（重さの比較）。window.__ct5：
//   carry()  … 小石・貝殻・重い石を挟んで歩く（1.5 秒）：平均の速さ（何も挟まない歩きとの比）、重い石が持ち上がるか（水中）、
//              挟んだまま跳ぶ・泳ぐ（遊泳になったか・落とさなかったか）
//   plant(kind, high, sec) … 種類 kind（0 テープ状の葉 / 1 有茎草 / 2 シダ / 4 汀線の草）の植物の近くへ置き、茎を挟んで（high = 高い所）
//              後ろへ sec 秒引く：挟めたか・張力の最大・抜けた / ちぎれた・かけらを挟んだまま運べたか・離したかけらの沈み方
//   life(kind, n) … エビ / 小魚の n 回：近くへ置いて挟む → 1.5 秒持つ：挟めた回数・逃れた回数・暴れの回数・めり込み
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, inp = a.input;
  const r2 = (v) => +(+v).toFixed(2), r3 = (v) => +(+v).toFixed(3);
  const step = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.freeze = false; a.step(1); } };
  const world = (wx, wz) => { inp.touchMove = __ct.axisFor(wx, wz); };
  const stick = (x, y) => { inp.touchMove = { x, y }; };
  const speedOf = (sec, wx, wz, o = {}) => {
    const x0 = c.x, z0 = c.z;
    inp.touchRun = !!o.run;
    step(Math.round(sec * 60), () => world(wx, wz));
    inp.touchRun = false;
    stick(0, 0);
    return Math.hypot(c.x - x0, c.z - z0) / sec;
  };
  const carry = () => {
    const out = {};
    __gr.reset(); __gr.settle(1);
    // 何も挟まない
    __gr.approach('pebble4', -Math.PI / 2);
    a.freeze = false;
    const base = speedOf(1.5, 1, 0);
    out.base = r2(base);
    for (const id of ['pebble3', 'shell1', 'stone5']) {
      __gr.reset(); __gr.settle(1);
      if (!__gr.byId(id)) { out[id] = 'なし'; continue; }
      __gr.approach(id, -Math.PI / 2);
      __gr.hold(true, 30);
      a.freeze = false;
      const held = a.grab.held?.id ?? null;
      const sl0 = a.grab.stats.slips + a.grab.stats.releases;
      const sp = speedOf(1.5, 1, 0);
      const pr = __gr.byId(id);
      const hGround = pr ? r3(pr.p[1] - pr.semi[1] - w.contactSurfaceBelow(pr.p[0], pr.p[1], pr.p[2])) : null;
      // 跳ぶ・泳ぐ（ジャンプを長押し）
      inp.touchJump = true;
      step(50, () => world(1, 0));
      const swim = c.state;
      inp.touchJump = false;
      step(40);
      const still = a.grab.held?.id ?? null;
      out[id] = { held, speed: r2(sp), ratio: r2(sp / base), hGround, swim, stillHeldAfterJump: still === held, dropped: a.grab.stats.slips + a.grab.stats.releases - sl0, strain: r2(a.grab.strain) };
      __gr.hold(false, 20);
    }
    return out;
  };
  /** 種類 kind の、いまの場所から近い植物（水中・根元が砂の上） */
  const findPlant = (kind) => {
    const T = a.plantField.table;
    let best = -1, bd = 1e9;
    for (let i = 0; i < T.count; i++) {
      if (T.kind[i] !== kind || a.plantField.removed[i]) continue;
      const d = Math.hypot(T.root[i * 3] + 10, T.root[i * 3 + 2] + 6.5) + (T.height[i] < 0.5 ? 2 : 0);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const plant = (kind = 0, high = false, sec = 2.2) => {
    a.plantField.setMode('dyn');
    a.grab.release();
    const T = a.plantField.table, i = findPlant(kind);
    if (i < 0) return { kind, error: '植物が無い' };
    const rx = T.root[i * 3], ry = T.root[i * 3 + 1], rz = T.root[i * 3 + 2], H = T.height[i];
    // 植物の +x 側 0.32 に、植物の方（−x）を向いて置く。構えた鋏の先の高さへ腕を向ける
    a.freeze = true;
    c.teleport(rx + 0.3, rz, ry + 0.05);
    c.heading = -Math.PI / 2;
    a.camera.adventure.yaw = Math.PI / 2 + 0.6;
    a.freeze = false;
    step(20);
    const gy = high ? Math.min(ry + H * 0.55, c.y + 0.6) : ry + 0.1;
    const aim = { x: 0, y: Math.max(-1, Math.min(1, (gy - c.y - 0.33) / 0.12)) };
    const G = a.grab, PG = a.plantGrabR;
    const st0 = { ...PG.stats };
    a.hold = true;
    step(25, () => { a.rig.armAim.x = 0; a.rig.armAim.y = aim.y; });
    const grabbed = G.holdingCreature === PG ? PG.name : G.held?.name ?? null;
    // 後ろへ引く（+x）
    let tension = 0, popped = false, pieceHeld = null;
    step(Math.round(sec * 60), () => {
      world(1, 0);
      tension = Math.max(tension, PG.stats.maxTension);
      if (!popped && (PG.stats.uproots > st0.uproots || PG.stats.cuts > st0.cuts)) popped = true;
    });
    stick(0, 0);
    if (G.holding?.kind === 'weed') pieceHeld = G.holding.name;
    // かけらを持って歩けるか
    let carried = null;
    if (pieceHeld) {
      const pr = G.holding, x0 = pr.p[0];
      step(60, () => world(1, 0.4));
      stick(0, 0);
      carried = r2(Math.hypot(pr.p[0] - x0, 0));
    }
    a.hold = false;
    step(5);
    // 離したかけら：2 秒の沈み方・漂い方
    let drift = null;
    const last = a.weeds.list[a.weeds.list.length - 1];
    if (pieceHeld && last) {
      const p0 = [...last.prop.p];
      step(120);
      drift = { sank: r2(p0[1] - last.prop.p[1]), moved: r2(Math.hypot(last.prop.p[0] - p0[0], last.prop.p[2] - p0[2])), settled: !last.prop.awake };
    }
    return {
      kind: ['テープ状の葉', '有茎草', 'シダ', '葉の広い草', '汀線の草'][kind], high, grabbed, tensionMax: r2(tension),
      uprooted: PG.stats.uproots - st0.uproots, cut: PG.stats.cuts - st0.cuts, slips: PG.stats.slips - st0.slips, pieceHeld, carried, drift,
      removed: !!a.plantField.removed[i],
    };
  };
  const life = (kind = 'shrimp', n = 6) => {
    const L = a.life, LG = a.lifeGrabR, G = a.grab;
    const st0 = { ...LG.stats };
    let caught = 0, embed = 0, kicks0 = LG.stats.kicks;
    for (let t = 0; t < n; t++) {
      a.grab.release();
      a.hold = false;
      const list = kind === 'shrimp' ? L.shrimp : L.fish;
      const b = list[t % list.length];
      // 生き物の正面 0.3 に置く（逃げる前に挟めるか。閉じる間 0.13 秒）
      a.freeze = true;
      const hx = Math.sin(b.heading || 0), hz = Math.cos(b.heading || 0);
      c.teleport(b.x - hx * 0.32, b.z - hz * 0.32, kind === 'fish' ? b.y - 0.35 : b.y + 0.1);
      c.heading = Math.atan2(hx, hz);
      a.freeze = false;
      const aimY = Math.max(-1, Math.min(1, (b.y - c.y - 0.33) / 0.12));
      a.hold = true;
      step(10, () => { a.rig.armAim.y = aimY; });
      if (G.holdingCreature === LG) caught++;
      step(90, () => {
        const h = LG.held;
        if (h && w.contactSolid(h.c.x, h.c.y + 0.04, h.c.z) < 0.02) embed++;
      });
      a.hold = false;
      step(20);
    }
    return { kind, tries: n, caught, escapes: LG.stats.escapes - st0.escapes, released: LG.stats.releases - st0.releases, kicks: LG.stats.kicks - kicks0, embedFrames: embed, stillCaught: L.caught.size };
  };
  window.__ct5 = { carry, plant, life, findPlant };
})();
