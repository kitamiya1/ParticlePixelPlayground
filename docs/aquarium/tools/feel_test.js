// 第 6 段階（iPhone の確認から：操作感の改善）の検証（開発用ページ ?nosave で fetch + eval。climb_helpers.js（__ct）を先に読み込む）。
// window.__ft：
//   plantPull(kind, o) … 種類 kind（0 テープ状の葉 / 1 有茎草 / 2 シダ / 3 葉の広い草 / 4 汀線の草）の植物を挟み、
//     「引く 1 秒 → 止まる 0.6 秒（引き戻されるか）→ 離す 2.5 秒（跳ね返り）」を o.cycles 回くり返す。各回：
//     tension（張力 / 握る力の最大）・bend（曲がりの最大）・pullSpeed（引いている間の速さ。何も挟まない歩きとの比）・
//     dragBack（止まっている間に植物の方へ引き戻された距離）・overshoot（離した後、反対側へ振れた量 / 引いた曲がり）・
//     swings（離した後 2.5 秒で振れた回数）・broke（抜けた・ちぎれた）
//   plantYank(kind) … ダッシュで 2.5 秒強く引く：滑ったか（slips）・抜けた / ちぎれたか（切れずに滑るのが正しい）
//   plantTwist(kind, high) … 挟んで引きながら「掘る」（a.dig）を押す：結果（cut / uproot / weak）・抜けた / ちぎれたか・
//     かけら（挟んでいる・離れて漂う）の数・円盤の数（消えた円盤が無いか）
//   feetStill(place, o) … 場所で歩く → 止まる 3 秒 を o.reps 回：止まっている間の踏み替え（settle / idle）・足場が見つからなかった回数・
//     急ぎの踏み替え・足先と面の距離（平均・最大）・止まってから 0.6 秒以降の踏み替えの回数（ふつうは 0）
//   feetWalk(place, o) … 歩く・ダッシュ・方向転換：1 秒あたりの踏み替え・踏み替えの時間・足先の滑り・伸びの最大・急ぎ
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, inp = a.input;
  const r2 = (v) => +(+v).toFixed(2), r3 = (v) => +(+v).toFixed(3);
  const step = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.freeze = false; a.step(1); } };
  const world = (wx, wz) => { inp.touchMove = __ct.axisFor(wx, wz); };
  const stick = (x, y) => { inp.touchMove = { x, y }; };
  const KIND = ['テープ状の葉', '有茎草', 'シダ', '葉の広い草', '汀線の草'];

  /** 種類 kind の植物（水中・高さがあり、まわりが空いている：+x 側 0.3 にカニを置ける） */
  const findPlant = (kind, skip = new Set()) => {
    const T = a.plantField.table;
    let best = -1, bd = 1e9;
    for (let i = 0; i < T.count; i++) {
      if (T.kind[i] !== kind || a.plantField.removed[i] || skip.has(i)) continue;
      const x = T.root[i * 3] + 0.3, y = T.root[i * 3 + 1], z = T.root[i * 3 + 2];
      if (w.regionAt(x, y + 0.2, z) !== 'tank' || w.contactSolid(x, y + 0.3, z) < 0.2) continue;
      // （汀線の草は岸の斜面に生える：引く側の空きは見ない）
      if (kind !== 4 && (w.contactSolid(x + 1.2, y + 0.3, z) < 0.2 || w.contactSolid(x + 0.6, y + 0.3, z) < 0.2)) continue;
      // ほかの植物から離れている（挟むときに隣の草を挟まない）。カニを置く側（+x）も空いている
      let near = 0;
      for (let j = 0; j < T.count && near < 2; j++) {
        if (j === i || a.plantField.removed[j] || (kind === 4 && T.kind[j] === 4)) continue;
        const dx = T.root[j * 3] - T.root[i * 3], dz = T.root[j * 3 + 2] - T.root[i * 3 + 2];
        if (Math.hypot(dx, dz) < 0.3 || (dx > 0 && dx < 0.8 && Math.abs(dz) < 0.3)) near++;
      }
      if (near) continue;
      const d = Math.hypot(T.root[i * 3] + 10, T.root[i * 3 + 2] + 6.5);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  /** 植物 i の +x 側に植物の方を向いて置き、茎を挟む（high = 高い所） */
  const grabPlant = (i, high) => {
    const T = a.plantField.table, G = a.grab, PG = a.plantGrabR;
    a.hold = false; a.dig = false;
    G.release();
    step(3);
    const rx = T.root[i * 3], ry = T.root[i * 3 + 1], rz = T.root[i * 3 + 2], H = T.height[i];
    a.freeze = true;
    // 太い株（シダ・葉の広い草）は少し近くへ
    c.teleport(rx + 0.3 + [0.05, 0.07, 0.28, 0.2, 0.03][T.kind[i]] * 0.4, rz, ry + 0.05);
    c.heading = -Math.PI / 2;
    a.camera.adventure.yaw = Math.PI / 2 + 0.6;
    a.freeze = false;
    step(20);
    const gy = high ? Math.min(ry + H * 0.6, c.y + 0.6) : ry + 0.08;
    const aimY = Math.max(-1, Math.min(1, (gy - c.y - 0.33) / 0.12));
    a.hold = true;
    step(25, () => { a.rig.armAim.x = 0; a.rig.armAim.y = aimY; });
    // （密に生える汀線の草は、となりの同じ種類の草を挟んでもよい）
    return G.holdingCreature === PG && (PG.i === i || a.plantField.table.kind[PG.i] === a.plantField.table.kind[i]) ? PG.i : -1;
  };
  /** 何も挟まない歩きの速さ（比べる基準） */
  let base = 0;
  const baseSpeed = () => {
    if (base) return base;
    a.goto('spawn');
    step(20);
    const x0 = c.x, z0 = c.z;
    step(60, () => world(1, 0));
    stick(0, 0);
    base = Math.hypot(c.x - x0, c.z - z0);
    return base;
  };

  const plantPull = (kind = 0, o = {}) => {
    const cycles = o.cycles ?? 3, high = o.high ?? true;
    const b0 = baseSpeed();
    a.plantField.setMode('dyn');
    const i = findPlant(kind);
    if (i < 0) return { kind: KIND[kind], error: '植物が無い' };
    const PG = a.plantGrabR, F = a.plantField;
    const st0 = { ...PG.stats };
    const out = [];
    for (let k = 0; k < cycles; k++) {
      const gi = grabPlant(i, high);
      if (gi < 0) { out.push({ error: '挟めない' }); break; }
      let tension = 0, bend = 0;
      const x0 = c.x;
      step(60, () => { world(1, 0); tension = Math.max(tension, PG.tension); bend = Math.max(bend, F.bendOf(gi)[0]); });
      const pullSpeed = (c.x - x0) / b0;
      // 止まる：植物に引き戻される
      stick(0, 0);
      const x1 = c.x;
      step(36, () => { tension = Math.max(tension, PG.tension); });
      const dragBack = x1 - c.x;
      const held = a.grab.holdingCreature === PG;
      // 離す：反対側（−x）へ振れて、何度か揺れ戻る
      const b1 = F.bendOf(gi)[0];
      a.hold = false;
      let minB = 0, swings = 0, sgn = Math.sign(b1);
      step(150, () => {
        const bx = F.bendOf(gi)[0];
        minB = Math.min(minB, bx);
        if (Math.abs(bx) > 0.01 && Math.sign(bx) !== sgn) { swings++; sgn = Math.sign(bx); }
      });
      out.push({ tension: r2(tension), bend: r2(bend), pullSpeed: r2(pullSpeed), dragBack: r3(dragBack), heldAfterStop: held, overshoot: b1 > 0.02 ? r2(-minB / b1) : null, swings });
    }
    return {
      kind: KIND[kind], plant: i, height: r2(a.plantField.table.height[i]), cycles: out,
      broke: PG.stats.uproots - st0.uproots + PG.stats.cuts - st0.cuts, slips: PG.stats.slips - st0.slips, removed: !!F.removed[i],
    };
  };

  const plantYank = (kind = 0, o = {}) => {
    a.plantField.setMode('dyn');
    const i = findPlant(kind);
    if (i < 0) return { kind: KIND[kind], error: '植物が無い' };
    const PG = a.plantGrabR, st0 = { ...PG.stats };
    if (grabPlant(i, o.high ?? true) < 0) return { kind: KIND[kind], error: '挟めない' };
    let tension = 0, slipAt = null, warn = 0;
    inp.touchRun = true;
    step(150, (t) => {
      world(1, 0);
      tension = Math.max(tension, PG.tension);
      warn = Math.max(warn, a.grab.warn);
      if (slipAt === null && PG.stats.slips > st0.slips) slipAt = r2(t / 60);
    });
    inp.touchRun = false;
    stick(0, 0);
    a.hold = false;
    step(20);
    return { kind: KIND[kind], tensionMax: r2(tension), warnMax: r2(warn), slipAt, slips: PG.stats.slips - st0.slips, broke: PG.stats.uproots - st0.uproots + PG.stats.cuts - st0.cuts, removed: !!a.plantField.removed[i] };
  };

  const plantTwist = (kind = 0, high = true, o = {}) => {
    a.plantField.setMode('dyn');
    const skip = new Set(o.skip ?? []);
    const i = findPlant(kind, skip);
    if (i < 0) return { kind: KIND[kind], error: '植物が無い' };
    const PG = a.plantGrabR, W = a.weeds;
    const st0 = { ...PG.stats }, ws0 = { ...W.stats };
    const gi = grabPlant(i, high);
    if (gi < 0) return { kind: KIND[kind], error: '挟めない' };
    // 円盤の数（ちぎる高さより上・抜くなら全部。かけらの円盤の数と比べる：消えた円盤が無いか）
    const discs = a.plantField.discsOf(gi).length;
    // 引く（o.pull 秒）→ 引いたまま「掘る」
    step(Math.round((o.pull ?? 0.7) * 60), () => world(1, 0));
    const tension = PG.tension, need = PG.uprootNeed, cutsHere = PG.cutsHere;
    let result = null;
    const r0 = PG.stats.weak;
    a.dig = true;
    step(30, () => world(o.keepPull === false ? 0 : 1, 0));
    a.dig = false;
    stick(0, 0);
    result = PG.stats.cuts > st0.cuts ? 'cut' : PG.stats.uproots > st0.uproots ? 'uproot' : PG.stats.weak > r0 ? 'weak' : 'none';
    const held = a.grab.holding?.kind === 'weed' ? a.grab.holding : null;
    const left = a.plantField.removed[gi] ? 0 : a.plantField.discsOf(gi).length;
    // 離す：かけらが沈んでいく（消えない）
    a.hold = false;
    step(90);
    const n = W.stats.spawned - ws0.spawned;
    const pieces = n ? W.list.slice(-n).map((x) => ({ held: x.prop.held, y: r2(x.prop.p[1]), dying: x.die >= 0, n: x.mesh.geometry.instanceCount ?? x.mesh.geometry.getAttribute('iPos')?.count })) : [];
    return { kind: KIND[kind], plant: gi, high, cutsHere, tension: r2(tension), need, result, removed: !!a.plantField.removed[gi], heldPiece: !!held, spawned: n, drifting: W.stats.drifting - ws0.drifting, discs, left, pieceDiscs: pieces.reduce((s, p) => s + (p.n ?? 0), 0), pieces };
  };

  // ---------------- 接地 IK ----------------
  const L = w.landmarks, sp = w.spawn;
  const feetPlaces = {
    '平地': { at: [sp.x, sp.z], dir: [1, 0] },
    '砂山の縁': { at: [sp.x + 1.2, sp.z], dir: [-1, 0], prep: 'mound' },
    '細い岩（洞窟の床）': { at: [-12.6, -1.45], y: 2.4, dir: [1, 0.1] },
    '段差（滝の上の崖）': { at: [14.5, L.tunnelIn[2] + 2.5], y: L.tunnelIn[1] + 3, dir: [-1, 0] },
    '洞窟の天井': { at: [-11.8, -1.45], y: 2.4, dir: [0, 1], ceiling: true },
    '掘削トンネル': { at: [-4.6, 8.3], dir: [1, 0], heading: Math.PI / 2, prep: 'tunnel' },
  };
  let mound = false, dug = false;
  const prep = (S) => {
    if (S.prep === 'mound' && !mound) {
      c.sandHeld = 4; c.tool = 'fill'; c.heading = Math.PI / 2;
      a.dig = true; a.digAim = { x: 0, y: -0.3 };
      step(140);
      a.dig = false; a.digAim = null; c.tool = 'dig';
      a.view.digFx.flushAll();
      mound = true;
    }
    if (S.prep === 'tunnel' && !dug && window.__ceil) { __ceil.digTunnel(Math.PI / 2, 5)(); dug = true; }
  };
  const place = (name, gait) => {
    const S = feetPlaces[name];
    a.view.digFx.budgetMs = 1e9;
    a.rig.gait = gait;
    a.rig.feet.reset();
    a.hold = false; a.grab.release();
    a.freeze = true;
    c.teleport(S.at[0], S.at[1], S.y !== undefined ? w.contactSurfaceBelow(S.at[0], S.y, S.at[1]) + 0.02 : undefined);
    if (S.heading !== undefined) c.heading = S.heading;
    a.camera.mode = 'adventure';
    a.freeze = false;
    stick(0, 0); inp.touchJump = false; inp.touchRun = false; a.dig = false; a.digAim = null;
    step(30);
    prep(S);
    return S;
  };
  /** 天井へ：洞窟の床から跳んで天井につかまる（__ceil があれば、その手順） */
  const toCeiling = () => {
    // 洞窟の床から奥の壁へ歩き続けると、壁を登って天井へ回り込む（foot_ik_test の「洞窟の床・壁・天井」と同じ）
    for (let k = 0; k < 360 && !(c.climbing && c.climbN[1] < -0.5); k++) step(1, () => world(0, 1));
    step(20, () => world(0, 1));
    return c.climbing && c.climbN[1] < -0.3;
  };
  // 足場が見つからなかった回数：変更前の版には数えが無いので、探す処理を包んで数える（どちらの版でも同じ数え方）
  const F0 = a.rig.feet;
  if (!F0.__wrapped) {
    const orig = F0.probe.bind(F0);
    F0.__fails = 0;
    F0.probe = (...args) => { const r = orig(...args); if (!r.ok) F0.__fails++; return r; };
    F0.__wrapped = true;
  }
  const snapStats = () => ({ ...a.rig.feet.stats, fails: a.rig.feet.__fails, settleSteps: a.rig.feet.stats.settleSteps ?? 0, idleSteps: a.rig.feet.stats.idleSteps ?? 0, probeFail: a.rig.feet.__fails });
  const delta = (s0, s1) => { const o = {}; for (const k in s1) o[k] = s1[k] - s0[k]; return o; };

  const feetStill = (name, o = {}) => {
    const gait = o.gait ?? 'ik', reps = o.reps ?? 3;
    const S = place(name, gait);
    if (S.ceiling && !toCeiling()) return { place: name, error: '天井につかまれない', state: c.state };
    const F = a.rig.feet;
    const res = { place: name, gait, reps, settle: 0, idle: 0, late: 0, probeFail: 0, emergency: 0, gapAvg: 0, gapMax: 0, still: [] };
    let gS = 0, gN = 0, gM = 0;
    for (let r = 0; r < reps; r++) {
      // 歩く 0.8 秒（向きを少しずつ変える）→ 止まる 3 秒
      const ang = (r % 2 ? 1 : -1) * 0.5;
      const dx = S.dir[0] * Math.cos(ang) - S.dir[1] * Math.sin(ang), dz = S.dir[0] * Math.sin(ang) + S.dir[1] * Math.cos(ang);
      step(48, () => world(r % 2 ? -dx : dx, r % 2 ? -dz : dz));
      stick(0, 0);
      const s0 = snapStats();
      // 止まった：接地して速さ 0.15 未満が 0.6 秒続いた後の踏み替え（late。着地・段差の乗り越えの途中は数えない）
      let late = 0, stillF = 0, prevSteps = F.stats.steps, stillFrames = 0;
      step(180, () => {
        const still = c.speed < 0.15 && (c.grounded || c.climbing);
        stillF = still ? stillF + 1 : 0;
        if (stillF > 36) { late += F.stats.steps - prevSteps; stillFrames++; }
        prevSteps = F.stats.steps;
        // 足先と面の距離（接地している脚）
        for (const f of F.feet) if (f.valid && !f.swing) { const g = Math.abs(w.contactSolid(f.pos[0], f.pos[1], f.pos[2])); gS += g; gN++; gM = Math.max(gM, g); }
      });
      res.stillSec = r2((res.stillSec ?? 0) + stillFrames / 60);
      const d = delta(s0, snapStats());
      res.settle += d.settleSteps; res.idle += d.idleSteps; res.late += late; res.probeFail += d.probeFail; res.emergency += d.emergency;
      res.still.push({ steps: d.steps, late, fail: d.probeFail, state: c.state });
    }
    res.gapAvg = gN ? r3(gS / gN) : null;
    res.gapMax = r3(gM);
    a.rig.gait = 'ik';
    return res;
  };

  const feetWalk = (name, o = {}) => {
    const gait = o.gait ?? 'ik';
    const S = place(name, gait);
    if (S.ceiling && !toCeiling()) return { place: name, error: '天井につかまれない', state: c.state };
    const F = a.rig.feet;
    const out = { place: name, gait };
    const phase = (key, frames, fn) => {
      const s0 = snapStats();
      let slide = 0, stretch = 0, n = 0, durS = 0, durN = 0;
      const prev = F.feet.map((f) => [...f.pos]), was = F.feet.map((f) => f.valid && !f.swing);
      step(frames, (t) => {
        fn(t);
        F.feet.forEach((f, k) => {
          const pl = f.valid && !f.swing;
          if (pl && was[k]) slide = Math.max(slide, Math.hypot(f.pos[0] - prev[k][0], f.pos[1] - prev[k][1], f.pos[2] - prev[k][2]));
          if (f.swing && f.swing.t < 0.05) { durS += f.swing.dur; durN++; }
          prev[k] = [...f.pos]; was[k] = pl;
        });
        stretch = Math.max(stretch, F.support.maxStretch);
        n++;
      });
      const d = delta(s0, snapStats());
      out[key] = { stepsPerSec: r2(d.steps / (frames / 60)), swingDur: durN ? r3(durS / durN) : null, slide: r3(slide), stretch: r2(stretch), emergency: d.emergency, probeFail: d.probeFail, speed: r2(c.speed) };
    };
    phase('walk', 120, () => world(S.dir[0], S.dir[1]));
    inp.touchRun = true;
    phase('dash', 90, () => world(S.dir[0], S.dir[1]));
    inp.touchRun = false;
    phase('turn', 90, (t) => world(Math.cos(t * 0.06) * S.dir[0] - Math.sin(t * 0.06) * S.dir[1], Math.sin(t * 0.06) * S.dir[0] + Math.cos(t * 0.06) * S.dir[1]));
    stick(0, 0);
    phase('stop', 120, () => {});
    a.rig.gait = 'ik';
    return out;
  };

  /**
   * 微妙な足場（斜面・岩や流木の縁・段差のそば）で長く静止：水槽の中の n か所（同じ乱数の種で、どちらの版でも同じ所）に
   * 置いて 1.5 秒待ち、そこから sec 秒の踏み替えの回数・宙に浮いた足先（接地していない脚・足先の所が面から 0.03 以上離れている）
   * の脚 × フレームの割合・接地している足先と面の距離
   */
  const feetSpots = (o = {}) => {
    const n = o.n ?? 12, sec = o.sec ?? 5, gait = o.gait ?? 'ik';
    let seed = o.seed ?? 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const T = window.__aqua.world, tank = a.world.tankBox ?? null;
    const spots = [];
    for (let k = 0; k < 4000 && spots.length < n; k++) {
      const x = -17 + rnd() * 34, z = -9 + rnd() * 18;
      const y = w.contactSurfaceBelow(x, 12, z);
      if (!Number.isFinite(y) || w.regionAt(x, y + 0.3, z) !== 'tank') continue;
      const nn = w.contactNormal(x, y - 0.01, z), nl = Math.hypot(...nn) || 1, ny = nn[1] / nl;
      // 斜面・縁：面の向きが 25〜50°、または 0.35 以内で高さが 0.12 以上変わる
      let dh = 0;
      for (const [ox, oz] of [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]]) dh = Math.max(dh, Math.abs(w.contactSurfaceBelow(x + ox, y + 0.5, z + oz) - y));
      if (!((ny < 0.9 && ny > 0.64) || (dh > 0.12 && dh < 0.4))) continue;
      spots.push([x, z, y]);
    }
    const F = a.rig.feet;
    a.rig.gait = gait;
    const out = { gait, spots: spots.length, steps: 0, perSpot: [], floatRatio: 0, gapAvg: 0, gapMax: 0, fails: 0, emergency: 0 };
    let fl = 0, fn = 0, gS = 0, gN = 0, gM = 0;
    // フレームの時間：iPhone のように 1/60〜1/30 秒で揺らす（o.jitter）
    const stepJ = (k, fn) => { for (let i = 0; i < k; i++) { fn?.(i); a.freeze = false; a.step(1, o.jitter ? 1 / 60 + rnd() * (1 / 30 - 1 / 60) : undefined); } };
    for (const [x, z, y] of spots) {
      a.hold = false; a.grab.release(); F.reset();
      // 0.9 離れた所から歩いて来て止まる（歩いた後の脚のずれのまま静止する）
      const ang = rnd() * Math.PI * 2, sx = x - Math.cos(ang) * 0.9, sz = z - Math.sin(ang) * 0.9;
      a.freeze = true; c.teleport(sx, sz, w.contactSurfaceBelow(sx, y + 0.6, sz) + 0.02); a.freeze = false;
      stepJ(20);
      for (let i = 0; i < 80 && Math.hypot(c.x - x, c.z - z) > 0.12; i++) stepJ(1, () => world(x - c.x, z - c.z));
      stick(0, 0);
      stepJ(90);
      const s0 = snapStats();
      stepJ(Math.round(sec * 60), () => {
        if (!(c.grounded || c.climbing)) return;
        for (const f of F.feet) {
          if (f.swing) continue;
          const g = w.contactSolid(f.pos[0], f.pos[1], f.pos[2]);
          fn++;
          if (!f.valid || g > 0.03) fl++;
          if (f.valid) { gS += Math.abs(g); gN++; gM = Math.max(gM, Math.abs(g)); }
        }
      });
      const d = delta(s0, snapStats());
      out.steps += d.steps;
      out.fails += d.fails;
      out.emergency += d.emergency;
      out.perSpot.push(d.steps);
    }
    out.stepsPerSec = r2(out.steps / (spots.length * sec));
    out.floatRatio = fn ? r3(fl / fn) : null;
    out.gapAvg = gN ? r3(gS / gN) : null;
    out.gapMax = r3(gM);
    a.rig.gait = 'ik';
    return out;
  };

  window.__ft = { feetSpots, plantPull, plantYank, plantTwist, findPlant, grabPlant, feetStill, feetWalk, feetPlaces };
})();
