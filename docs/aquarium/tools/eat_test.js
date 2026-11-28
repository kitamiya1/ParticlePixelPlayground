// 食事（AquaEat）の場面の検証（開発用ページ ?nosave で fetch + eval。先に eat_helpers.js（__eat）を読み込む）。window.__eatTest：
//   matrix(sec)   … 左右の鋏 × 種類（藻・水草・エビ・小魚・ゴカイ・小石）：挟めたか・1 口の数・得た栄養・食べ終えたか・鋏と食べ物のずれの最大・滑り
//   resume()      … エビを 2 秒食べて中断（残りを記録）→ 0.5 秒待つ → 続きから食べ切る：残りが中断の前後で同じか・栄養の合計が 1 匹分か
//   dropPick()    … 小魚を 2.5 秒食べて落とす → 底に沈んで横たわる → 拾い直して食べ切る
//   release()     … エビを捕まえて食べずに離す（逃げる）／運び始めて 1 口目の前にやめて離す（生きたまま逃げる）
//   companion()   … 巣穴のスナモグリ（踏ん張っている）・仲間になったスナモグリ・companion の印を付けたゴカイ：食べない（運ばない）・体はそのまま
//   move()        … ゴカイを食べながら歩く・走る・跳ぶ：落とさない・滑らない・歩く速さ（食べていないときとの比）
//   all()         … すべて
(() => {
  const a = window.__aqua, c = a.crab, E = window.__eat, ES = a.eat, inp = a.input;
  const r2 = (v) => +(+v).toFixed(2), r3 = (v) => +(+v).toFixed(3);
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
  const matrix = (sec = 10) => {
    const out = {};
    for (const sd of ['R', 'L']) for (const k of ['algae', 'plant', 'shrimp', 'fish', 'worm', 'pebble']) {
      let s = E.setup(k, sd);
      // 小魚は逃げることがあるので 3 回まで
      for (let t = 0; t < 2 && !s.held; t++) s = E.setup(k, sd);
      if (!s.held) {
        out[`${sd}:${k}`] = { held: null };
        continue;
      }
      const f0 = ES.stats.finished;
      const e = E.eat(k === 'pebble' ? 1.5 : sec);
      out[`${sd}:${k}`] = { held: s.held, bites: e.bites, gain: e.gain, finished: ES.stats.finished - f0, tasted: (e.phases.taste ?? 0) > 0, reachMax: e.reachMax, minFoodMouth: e.minFoodMouth === Infinity ? null : e.minFoodMouth, slips: e.slips, mouthMax: e.mouthMax, assistMax: e.assistMax };
    }
    return out;
  };
  const resume = () => {
    const s = E.setup('shrimp', 'R');
    if (!s.held) return { held: null };
    const n0 = ES.nutrition.total;
    const e1 = E.eat(2.0);
    const leftStop = e1.left;
    E.stop(30);
    const food = ES.food ?? null;
    const leftWait = a.lifeGrabR.held?.c.eat?.left ?? null;
    const stillHeld = a.grab.holdingCreature === a.lifeGrabR;
    const r0 = ES.stats.resumes;
    const e2 = E.eat(8);
    return { held: s.held, leftStop, leftWait: leftWait === null ? null : r3(leftWait), stillHeldWhileStopped: stillHeld, phaseWhileStopped: food ? 'back' : ES.phase, resumes: ES.stats.resumes - r0, bites: e1.bites + e2.bites, gain: r2(ES.nutrition.total - n0), full: 12, finished: e2.phase === 'idle' && !a.lifeGrabR.held };
  };
  const dropPick = () => {
    let s = E.setup('fish', 'L');
    for (let t = 0; t < 2 && !s.held; t++) s = E.setup('fish', 'L');
    const b = a.lifeGrabL.held?.c;
    if (!s.held || !b) return { held: null };
    const e1 = E.eat(2.5);
    const left1 = r3(b.eat.left);
    E.release(10);
    // 沈む
    const y0 = b.y;
    step(150);
    const floor = a.world.surfaceBelow(b.x, b.y + 0.3, b.z);
    const lying = { sank: r2(y0 - b.y), aboveFloor: r3(b.y - floor), left: r3(b.eat.left), gone: b.eat.gone, caught: a.life.caught.has(b) };
    // 拾い直す：左の鋏の構えの先を食べかけの所へ
    a.freeze = true;
    c.teleport(b.x - Math.sin(c.heading) * 0.35, b.z - Math.cos(c.heading) * 0.35);
    step(15);
    for (let k = 0; k < 3; k++) {
      const an = a.rig.left.anchor;
      c.teleport(c.x + (b.x - an[0]), c.z + (b.z - an[2]));
      step(10);
    }
    // 腕を食べかけの高さへ向けて挟む（空振りしたら挟み直しを待つ：1.5 秒まで）
    const aimY = Math.max(-1, Math.min(1, (b.y - c.y - 0.33) / 0.12));
    a.holdL = true;
    for (let k = 0; k < 90 && a.lifeGrabL.held?.c !== b; k++) step(1, () => (a.rig.armAim.y = aimY));
    const repicked = a.lifeGrabL.held?.c === b;
    const e2 = repicked ? E.eat(8) : null;
    a.holdL = false;
    step(10);
    return { held: s.held, firstBites: e1.bites, left1, lying, repicked, secondBites: e2?.bites ?? 0, gone: !!b.eat?.gone };
  };
  const release = () => {
    const out = {};
    // 1. 捕まえて、食べずに離す
    let s = E.setup('shrimp', 'R');
    if (s.held) {
      const b = a.lifeGrabR.held.c;
      E.release(5);
      out.plain = { eaten: !!b.eat, state: b.state, caught: a.life.caught.has(b) };
    }
    // 2. 運び始めて（0.25 秒）1 口目の前にやめて離す
    s = E.setup('shrimp', 'R');
    if (s.held) {
      const b = a.lifeGrabR.held.c;
      const e = E.eat(0.25);
      E.release(5);
      out.beforeBite = { bites: e.bites, eaten: !!b.eat, state: b.state, caught: a.life.caught.has(b) };
    }
    return out;
  };
  const companion = () => {
    const out = {};
    // 1. 巣穴のスナモグリ（仲間になる前：踏ん張っている）
    const s = E.setup('buddy', 'R');
    const B = a.buddy;
    if (s.held) {
      const ext0 = B.tug.ext;
      const e = E.eat(1.2);
      out.burrow = { held: s.held, phases: e.phases, bites: e.bites, gain: e.gain, feedMax: e.feedMax, stillHeld: a.grab.holdingCreature === B.tug, ext: r3(B.tug.ext - ext0) };
    } else out.burrow = { held: null };
    E.reset();
    // 2. 仲間になったスナモグリ（ふだんは挟めない。挟んだことにして、食べる対象の判定と動きを確かめる）
    const found0 = B.found;
    B.found = true;
    const G = a.grab;
    G.release();
    G.state = 'holding';
    G.creature = B.tug;
    // （時間は進めない：仲間になった後の触角は鋏で引く物ではないので、判定だけ。運ばない「確かめる」動きは 1. と同じ）
    const t = a.eatClaws()[0].target;
    out.companion = { target: t && t.kind === 'refuse' ? t.why : t?.kind ?? null, bring: t?.bring ?? null, name: t?.name ?? null };
    G.state = 'idle';
    G.creature = null;
    B.found = found0;
    E.reset();
    // 3. companion の印を付けたゴカイ（将来の仲間の宣言の仕組み）
    const s3 = E.setup('worm', 'R');
    const W = E.setups.W;
    if (s3.held && W) {
      W.companion = true;
      const b0 = ES.stats.bites;
      const e = E.eat(1.5);
      out.markedWorm = { target: a.eatClaws()[0].target?.why ?? null, bites: ES.stats.bites - b0, feedMax: e.feedMax, left: W.left, life: W.life };
      delete W.companion;
      E.release(5);
    }
    return out;
  };
  const move = () => {
    const out = {};
    // 何も挟まない歩きの速さ（基準）
    E.reset();
    a.goto('spawn');
    step(30);
    const sp = (sec, o = {}) => {
      const x0 = c.x, z0 = c.z;
      inp.touchRun = !!o.run;
      step(Math.round(sec * 60), (i) => {
        inp.touchMove = axisFor(o.dir?.[0] ?? 1, o.dir?.[1] ?? 0);
        inp.touchJump = !!o.jump && i % 50 < 20;
      });
      inp.touchMove = { x: 0, y: 0 };
      inp.touchRun = inp.touchJump = false;
      return Math.hypot(c.x - x0, c.z - z0) / sec;
    };
    const base = sp(1.2);
    out.base = r2(base);
    const s = E.setup('worm', 'R');
    if (!s.held) return { ...out, held: null };
    // 食べながら歩く・走る・跳ぶ（「掘る」を押したまま）
    const sl0 = a.grab.stats.slips, rel0 = a.grab.stats.releases;
    a.dig = true;
    step(40);
    const walk = sp(1.2);
    const run = sp(1.0, { run: true, dir: [0, 1] });
    const jump = sp(1.6, { jump: true, dir: [-1, 0] });
    const stillEating = ES.eating;
    a.dig = false;
    step(20);
    out.eating = { walk: r2(walk), ratio: r2(walk / base), run: r2(run), jump: r2(jump), slips: a.grab.stats.slips - sl0, releases: a.grab.stats.releases - rel0, stillHeld: a.grab.holdingCreature === E.setups.W, stillEating, left: r3(E.setups.W.left) };
    E.release(10);
    return out;
  };
  const all = () => ({ matrix: matrix(), resume: resume(), dropPick: dropPick(), release: release(), companion: companion(), move: move(), nutrition: ES.nutrition.toSave(), stats: { ...ES.stats } });
  window.__eatTest = { matrix, resume, dropPick, release, companion, move, all };
  return Object.keys(window.__eatTest);
})();
