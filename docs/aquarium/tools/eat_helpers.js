// 食事（AquaEat）の検証の道具（開発用ページ ?nosave で fetch(url).then(r => r.text()).then(eval) で読み込む）。window.__eat：
//   setup(kind, side)   … 種類 kind（plant / algae / shrimp / fish / worm / pebble / buddy）の食べ物を、鋏 side（'R' / 'L'）に挟ませる。
//                          plant = 有茎草の高い所を挟んで「掘る」でちぎる、algae = 苔の付いた水中の岩・流木をつかむ、shrimp / fish = 正面に置いて挟む、
//                          worm = 抜いた後の体（ゴカイ 0 をカニの前に横たえて頭の近くを挟む）、pebble = 景色の小石ではなく挟める小石、
//                          buddy = 巣穴のスナモグリの触角（仲間になる前：踏ん張っている）
//   eat(sec, o)         … 「掘る」を押したまま sec 秒（o.move = 世界の向きへ歩く [x, z]、o.jump = ジャンプを押す、o.run = 走る）。
//                          1 口の数・得た栄養・残り・口元へ運んだ重みの最大・顎脚の開きの最大・食べ物と口の距離の最小・滑り・離した数を返す
//   stop(frames)        … 「掘る」を離して進める（中断）
//   release(frames)     … 挟むボタンを離す（食べかけを落とす / 逃がす）
//   state()             … いまの食事の状態
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, inp = a.input, E = a.eat;
  const r2 = (v) => +(+v).toFixed(2), r3 = (v) => +(+v).toFixed(3);
  let side = 'R';
  const G = () => (side === 'R' ? a.grab : a.grabL);
  const claw = () => (side === 'R' ? a.rig : a.rig.left);
  const setHold = (on) => {
    if (side === 'R') a.hold = on;
    else a.holdL = on;
  };
  const step = (n, fn) => {
    for (let i = 0; i < n; i++) {
      fn?.(i);
      a.freeze = false;
      a.step(1);
    }
    a.freeze = true;
  };
  const axisFor = (wx, wz) => {
    const yaw = a.camera.yaw, l = Math.hypot(wx, wz) || 1;
    wx /= l;
    wz /= l;
    return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
  };
  /** 鋏の構えの先が p に来るようにカニを動かす（向きは heading のまま） */
  const alignTo = (p, heading) => {
    for (let k = 0; k < 3; k++) {
      const an = claw().anchor;
      const x = c.x + (p[0] - an[0]), z = c.z + (p[2] - an[2]);
      // （岩・流木の上へ乗らない：いまの高さから下の面へ）
      c.teleport(x, z, w.contactSurfaceBelow(x, c.y + 0.3, z) + 0.02);
      c.heading = heading;
      step(12);
    }
  };
  const held = () => G().held;
  const state = () => {
    const f = E.food;
    return {
      phase: E.phase, side: E.side, food: f ? f.name : null, left: f ? r3(f.left) : null, feedW: r2(E.feedW), nutrition: r2(E.nutrition.total),
      grab: G().state, held: held()?.name ?? null, crab: c.state,
    };
  };
  const reset = () => {
    a.dig = false;
    a.hold = a.holdL = false;
    E.reset();
    a.grab.release();
    a.grabL.release();
    inp.touchMove = { x: 0, y: 0 };
    inp.touchRun = inp.touchJump = false;
    step(4);
  };
  const setups = {
    pebble() {
      const pr = a.props.props.find((p) => p.kind === 'pebble' && !p.food);
      const h = -Math.PI / 2;
      c.teleport(pr.p[0] + 0.6, pr.p[2]);
      c.heading = h;
      step(20);
      alignTo(pr.p, h);
      setHold(true);
      step(25);
      return held()?.name ?? null;
    },
    plant() {
      // 左の鋏は小さく構えが低いので、茎の高い所（ちぎれる所）へ届きにくい：右でちぎって落としたかけらを、左で拾う
      if (side === 'L') {
        side = 'R';
        const got = this.plant();
        const pr = a.grab.holding;
        side = 'L';
        if (!got || !pr) return null;
        a.hold = false;
        step(150);
        const h = c.heading;
        alignTo(pr.p, h);
        a.holdL = true;
        for (let k = 0; k < 60 && a.grabL.holding !== pr; k++) step(1, () => (a.rig.armAim.y = -1));
        step(10);
        return a.grabL.holding === pr ? pr.name : null;
      }
      a.plantField.setMode('dyn');
      const T = a.plantField.table;
      let best = -1, bd = 1e9;
      for (let i = 0; i < T.count; i++) {
        // （まだちぎっていない有茎草）
        if (T.kind[i] !== 1 || a.plantField.removed[i] || T.height[i] < 0.5 || a.plantField.cutH[i] < T.height[i] * 0.95) continue;
        const d = Math.hypot(T.root[i * 3] + 2.6, T.root[i * 3 + 2] - 1.8);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      const rx = T.root[best * 3], ry = T.root[best * 3 + 1], rz = T.root[best * 3 + 2];
      c.teleport(rx + 0.3, rz, ry + 0.05);
      c.heading = -Math.PI / 2;
      a.camera.adventure.yaw = Math.PI / 2 + 0.6;
      step(20);
      // 使う鋏の構えの先を茎の所へ（左の鋏は体の左なので、右と同じ置き方では届かない）
      if (side === 'L') alignTo([rx + 0.06, ry, rz], -Math.PI / 2);
      const gy = Math.min(ry + T.height[best] * 0.55, c.y + 0.6);
      const aimY = Math.max(-1, Math.min(1, (gy - c.y - 0.33) / 0.12));
      setHold(true);
      const PG = side === 'R' ? a.plantGrabR : a.plantGrabL;
      // 挟み終えるまで（空振りの後の挟み直しを含めて 1.5 秒まで）
      for (let k = 0; k < 90 && !(PG.holding && k > 10); k++) step(1, () => {
        a.rig.armAim.x = 0;
        a.rig.armAim.y = aimY;
      });
      // 「掘る」を押して、ちぎる（0.14 秒）→ かけらを挟む → 離す
      a.dig = true;
      step(30);
      a.dig = false;
      step(4);
      return held()?.name ?? null;
    },
    algae() {
      // 苔（藻）の円盤が多い所で、カニが横から届く所：面が横を向き、そこの高さが鋏の構えの高さ（足もとから 0.2〜0.45）
      const A = a.algae, pos = a.plantSet.pos;
      let best = null;
      for (const cell of A.cells.values()) {
        const i = cell[0];
        const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
        if (!w.insideTank(p[0], p[2], 1)) continue;
        const n = w.climbNormal(p[0], p[1], p[2]);
        const hl = Math.hypot(n[0], n[2]);
        if (n[1] < -0.3 || hl < 0.15) continue;
        const sx = p[0] + (n[0] / hl) * 0.55, sz = p[2] + (n[2] / hl) * 0.55;
        const g = w.contactSurfaceBelow(sx, p[1] + 0.2, sz);
        const dh = p[1] - g;
        if (dh < 0.22 || dh > 0.42) continue;
        if (w.contactSolid(sx, g + 0.3, sz) < 0.25) continue;
        const k = A.near(p).length;
        if (k < 14) continue;
        const d = Math.hypot(p[0] + 4, p[2] - 5);
        if (!best || d < best.d) best = { p, n: [n[0] / hl, n[2] / hl], d, k, sx, sz };
      }
      if (!best) return null;
      const h = Math.atan2(-best.n[0], -best.n[1]);
      c.teleport(best.sx, best.sz, w.contactSurfaceBelow(best.sx, best.p[1] + 0.2, best.sz) + 0.02);
      c.heading = h;
      step(20);
      alignTo(best.p, h);
      a.camera.adventure.yaw = h + Math.PI - 0.7;
      setHold(true);
      step(25);
      this.algaeAt = best;
      return G().holdingCreature === G().fixed ? `${G().fixed.name}（藻 ${best.k}）` : held()?.name ?? null;
    },
    critter(kind) {
      const L = a.life, LG = side === 'R' ? a.lifeGrabR : a.lifeGrabL;
      const list = kind === 'shrimp' ? L.shrimp : L.fish;
      for (let t = 0; t < list.length; t++) {
        const b = list[t];
        if (b.eat || L.caught.has(b)) continue;
        reset();
        a.freeze = true;
        const hx = Math.sin(b.heading || 0), hz = Math.cos(b.heading || 0);
        c.teleport(b.x - hx * 0.32, b.z - hz * 0.32, kind === 'fish' ? b.y - 0.35 : b.y + 0.1);
        c.heading = Math.atan2(hx, hz);
        if (side === 'L') {
          // 左の鋏の構えの先を生き物の所へ（1 フレームだけ進めて構えを測る）
          a.freeze = false;
          a.step(1);
          const an = claw().anchor;
          c.teleport(c.x + (b.x - an[0]) * 0.8, c.z + (b.z - an[2]) * 0.8, c.y);
          c.heading = Math.atan2(hx, hz);
        }
        a.freeze = false;
        const aimY = Math.max(-1, Math.min(1, (b.y - c.y - 0.33) / 0.12));
        setHold(true);
        step(10, () => (a.rig.armAim.y = aimY));
        if (G().holdingCreature === LG) {
          step(20);
          if (G().holdingCreature === LG) return LG.held ? LG.name : null;
        }
      }
      return null;
    },
    shrimp() {
      return this.critter('shrimp');
    },
    fish() {
      return this.critter('fish');
    },
    worm() {
      const W = a.worms.worms.find((x) => !x.gone && x.life !== 'dead') ?? a.worms.worms[0];
      const h = c.heading;
      const fx = Math.sin(h), fz = Math.cos(h);
      // カニの前 0.45 に、頭をカニの方へ向けて横たえる
      W.layFree(c.x + fx * 0.45, c.y + 0.3, c.z + fz * 0.45, h + Math.PI);
      W.found = true;
      step(20);
      // 頭に近い節（2）を直接挟んだことにする（worm_helpers の grabAt と同じ）
      setHold(true);
      const g = G();
      g.release();
      g.state = 'holding';
      g.creature = W;
      g.close = 1;
      W.gS = 2;
      W.gF = 0.3;
      W.onGrab();
      step(20);
      this.W = W;
      return g.holdingCreature === W ? W.name : null;
    },
    buddy() {
      const B = a.buddy;
      a.goto('burrow');
      step(30);
      // 顔を出すまで待って挟む
      for (let k = 0; k < 40 && !B.tug.grabbable(); k++) step(10);
      const n = B.tug.nearest([c.x, c.y + 0.3, c.z]);
      if (!n) return null;
      const h = Math.atan2(B.burrow[0] - c.x, B.burrow[2] - c.z);
      alignTo(n.p, h);
      setHold(true);
      step(25);
      return G().holdingCreature === B.tug ? 'スナモグリ（巣穴）' : held()?.name ?? null;
    },
  };
  const eat = (sec = 1, o = {}) => {
    const n0 = E.nutrition.total, b0 = E.stats.bites, sl0 = a.grab.stats.slips + a.grabL.stats.slips, rel0 = a.grab.stats.releases + a.grabL.stats.releases;
    const mp = [0, 0, 0];
    const rec = { feedMax: 0, mouthMax: 0, palpMax: 0, minFoodMouth: Infinity, assistMax: 0, reachMax: 0, phases: {}, left: [] };
    const x0 = c.x, z0 = c.z;
    a.dig = true;
    step(Math.round(sec * 60), (i) => {
      if (o.move) inp.touchMove = axisFor(o.move[0], o.move[1]);
      inp.touchJump = !!o.jump && i % 50 < 20;
      inp.touchRun = !!o.run;
      rec.feedMax = Math.max(rec.feedMax, E.feedW);
      rec.mouthMax = Math.max(rec.mouthMax, a.rig.feed.mouth);
      rec.palpMax = Math.max(rec.palpMax, a.rig.feed.palp);
      rec.assistMax = Math.max(rec.assistMax, E.assist);
      rec.reachMax = Math.max(rec.reachMax, (side === 'R' ? a.rig.reachErr : a.rig.reachErrL) * (E.phase === 'chew' ? 1 : 0));
      rec.phases[E.phase] = (rec.phases[E.phase] ?? 0) + 1;
      if (E.food && E.feedW > 0.9) {
        a.rig.mouthPoint(mp, 0);
        const p = E.food.at();
        rec.minFoodMouth = Math.min(rec.minFoodMouth, Math.hypot(p[0] - mp[0], p[1] - mp[1], p[2] - mp[2]));
      }
      if (i % 30 === 29 && E.food) rec.left.push(r2(E.food.left));
    });
    a.dig = false;
    inp.touchMove = { x: 0, y: 0 };
    inp.touchJump = inp.touchRun = false;
    return {
      ...state(), bites: E.stats.bites - b0, gain: r2(E.nutrition.total - n0), feedMax: r2(rec.feedMax), mouthMax: r2(rec.mouthMax), palpMax: r2(rec.palpMax),
      assistMax: r2(rec.assistMax), minFoodMouth: r3(rec.minFoodMouth), reachMax: r3(rec.reachMax), slips: a.grab.stats.slips + a.grabL.stats.slips - sl0,
      releases: a.grab.stats.releases + a.grabL.stats.releases - rel0, moved: r2(Math.hypot(c.x - x0, c.z - z0)), phases: rec.phases, leftTrace: rec.left,
    };
  };
  const api = {
    reset,
    state,
    setup(kind, s = 'R') {
      side = s;
      reset();
      const r = setups[kind]?.call(setups) ?? null;
      return { kind, side, held: r, ...state() };
    },
    eat,
    stop(frames = 30) {
      a.dig = false;
      step(frames);
      return state();
    },
    release(frames = 30) {
      a.dig = false;
      setHold(false);
      step(frames);
      return state();
    },
    get side() {
      return side;
    },
    setups,
  };
  window.__eat = api;
  return Object.keys(api);
})();
