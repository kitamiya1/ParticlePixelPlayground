// 引っこ抜き 2.0 の自動検証（開発用ページで tug_helpers.js の後に fetch(url).then(r => r.text()).then(eval) で読み込む）。
// window.__tugTest(runs)：遊び方ごとに runs 回ずつ、巣穴の前で触角を挟んでから引っ張り、抜けた時間・滑った回数・
// 引き出した量・めり込み・ガラスの外などをまとめて返す（?nosave で。毎回 __tug.reset() で巣穴へ戻す）。
//   holdOnly …… 挟んだまま動かない（長押しだけ）。抜けてはいけない
//   backWalk …… 穴から離れる向きへ歩いて下がり続ける
//   backRun  …… 走って下がり続ける（急に強く引く）
//   side     …… 穴のまわりを横へ動き続ける
//   smart    …… 暴れている・滑りそうな間は止まり、それ以外は下がる
//   releaseRegrab …… 途中（引き出し 0.4 くらい）で離し、0.5 秒後に挟み直して最後まで引く
(() => {
  const a = window.__aqua, B = a.buddy, T = B.tug, tug = window.__tug;
  const until = { until: () => B.found || (!T.held && !T.popped) };
  const sum = (rs) => {
    const ok = rs.filter((r) => r.popped);
    const avg = (k) => (ok.length ? +(ok.reduce((s, r) => s + r[k], 0) / ok.length).toFixed(2) : null);
    return {
      popped: `${ok.length}/${rs.length}`,
      popAt: avg('popAt'),
      popAtAll: rs.map((r) => r.popAt),
      slips: rs.reduce((s, r) => s + r.slips, 0),
      maxExt: Math.max(...rs.map((r) => r.maxExt)),
      maxWarn: Math.max(...rs.map((r) => r.maxWarn)),
      tugs: rs.reduce((s, r) => s + r.tugs, 0),
      rests: rs.reduce((s, r) => s + r.rests, 0),
      crabInside: rs.reduce((s, r) => s + r.crabInside, 0),
      crabOutside: rs.reduce((s, r) => s + r.crabOutside, 0),
      buddyInside: rs.reduce((s, r) => s + r.buddyInside, 0),
      keepOutMin: Math.min(...rs.map((r) => r.keepOutMin)),
      maxCrabJump: Math.max(...rs.map((r) => r.maxCrabJump)),
    };
  };
  const one = (fn) => {
    tug.reset();
    tug.approach(0.47, 0);
    const g = tug.grab();
    const r = fn();
    r.grabbed = g.held;
    a.hold = false;
    a.freeze = false;
    a.step(150);
    a.freeze = true;
    return r;
  };
  // only = 試す遊び方の名前の並び（省略 = 全部。1 回の呼び出しが長くなりすぎないよう分けて呼べる）
  window.__tugTest = (runs = 3, only = null) => {
    const out = {};
    const plans = {
      holdOnly: () => tug.run(10, null, until),
      backWalk: () => tug.back(20, false, until),
      backRun: () => tug.back(20, true, until),
      side: () => tug.side(10, until),
      // 斜め後ろ（離れる向きから 50°）：まっすぐより遅い（体が穴の縁にこすれる）
      diagonal: () => tug.run(20, () => { const [x, z] = tug.awayDir(); const c = Math.cos(0.87), s = Math.sin(0.87); return { x: x * c - z * s, z: x * s + z * c }; }, until),
      smart: () => tug.smart(20, until),
      // 上手な遊び方：暴れている・滑りそうな間は止まり、力が抜けた間・最後は走って一気に引く
      skilled: () => tug.run(20, (t, s) => { if (s.env > 0.4 || s.warn > 0.2) return null; const [x, z] = tug.awayDir(); return { x, z, run: s.restT > 0 || s.ext > 0.88 }; }, until),
      releaseRegrab: () => {
        const r1 = tug.back(10, false, { until: () => T.ext > 0.4 || !T.held });
        const ext1 = T.ext;
        a.hold = false;
        tug.run(0.5, null);
        const ext2 = T.ext;
        // 穴へ近づきながら挟むを押したまま（届いたら挟む）
        a.hold = true;
        const r3 = tug.run(1.5, () => { const [x, z] = tug.awayDir(); return { x: -x * 0.6, z: -z * 0.6 }; }, { until: () => T.held });
        const regrabbed = T.held;
        const ext3 = T.ext;
        const r4 = tug.back(20, false, until);
        r4.detail = { ext1: +ext1.toFixed(3), afterRelease: +ext2.toFixed(3), regrabbed, regrabSec: +(r3.frames / 60).toFixed(2), extAtRegrab: +ext3.toFixed(3), slipsBefore: r1.slips };
        r4.popAt = r4.popAt !== null ? +(r4.popAt + r1.frames / 60 + 0.5 + r3.frames / 60).toFixed(2) : null;
        return r4;
      },
    };
    for (const [k, fn] of Object.entries(plans)) {
      if (only && !only.includes(k)) continue;
      const rs = [];
      for (let i = 0; i < runs; i++) rs.push(one(fn));
      out[k] = sum(rs);
      out[k].grabbed = rs.every((r) => r.grabbed);
      if (k === 'releaseRegrab') out[k].detail = rs.map((r) => r.detail);
    }
    return out;
  };
})();
