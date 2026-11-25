// セーブ・復元の検証の道具（開発用ページで fetch(url).then(r => r.text()).then(eval) で読み込む）。
// window.__sv：
//   wipe()                 … 保存データ（IndexedDB の ppp-aquarium）を消す（次に読み込み直すと初期状態）
//   digSites(list)         … 場所ごとに掘る（[{ at: [x, z], heading, sec, aim? , move? }]。ゲームのループと同じ __aqua.step）
//   digMany(n)             … 砂の広場〜岸辺を格子状に歩き回って n 個ほどの空洞を作る（大量の掘削）
//   fingerprint()          … いまの地形の指紋：空洞の数・数の和、区画ごとの三角形の数と頂点の和、隠した高さ場の三角形・植物・小石、
//                             空洞のまわりの当たり判定（solid）の値の和、カニの位置
//   record(tag)            … 指紋を localStorage（ppp-test-fp:<tag>）に置き、すぐ保存する
//   compare(tag)           … 読み込み直した後の指紋と比べる（違う所を返す）
//   corrupt(kind)          … IndexedDB の current を壊す（'garbage' | 'nan' | 'version' | 'prims'）
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, dig = w.dig, fx = a.view.digFx;
  const r6 = (v) => +v.toFixed(6);
  const idb = (fn) => new Promise((res, rej) => {
    const o = indexedDB.open('ppp-aquarium', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('saves');
    o.onsuccess = () => {
      const tx = o.result.transaction('saves', 'readwrite');
      const st = tx.objectStore('saves');
      let out;
      Promise.resolve(fn(st)).then((v) => (out = v));
      tx.oncomplete = () => { o.result.close(); res(out); };
      tx.onerror = () => rej(tx.error);
    };
    o.onerror = () => rej(o.error);
  });
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const step = (n) => { a.freeze = false; a.step(n); a.freeze = true; };
  const sv = {
    async wipe() {
      a.save.saver.suspended = true;
      await new Promise((res) => { const d = indexedDB.deleteDatabase('ppp-aquarium'); d.onsuccess = d.onerror = d.onblocked = () => res(); });
      return 'wiped';
    },
    digSites(list) {
      const inp = a.input;
      const mv0 = inp.moveAxis;
      const out = [];
      for (const s of list) {
        c.teleport(s.at[0], s.at[1]);
        c.heading = s.heading;
        a.camera.placeBehind(c);
        step(30);
        c.heading = s.heading;
        a.dig = true;
        a.digAim = s.aim ?? { x: 0, y: 0 };
        // 掘る向きへ進む（スティックを体の正面へ）
        inp.moveAxis = () => {
          if (!s.move) return { x: 0, y: 0 };
          const hd = c.digYaw ?? c.heading, yaw = a.camera.yaw, wx = Math.sin(hd), wz = Math.cos(hd);
          return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) };
        };
        step(Math.round(s.sec * 60));
        a.dig = false;
        a.digAim = null;
        inp.moveAxis = mv0;
        step(20);
        out.push({ at: s.at, end: [r6(c.x), r6(c.y), r6(c.z)], prims: dig.count });
      }
      return out;
    },
    digMany(n) {
      // 岸辺の斜面と広場を行き来しながら掘る（同じ所を掘り続けると太らせるだけになるので、少しずつ場所を変える）
      const t0 = performance.now();
      let k = 0;
      while (dig.count < n && k < 4000) {
        const x = -14 + (k % 23) * 1.2, z = 5.2 + (Math.floor(k / 23) % 4) * 1.1;
        c.teleport(x, z);
        c.heading = (k * 1.7) % (Math.PI * 2);
        step(4);
        a.dig = true;
        a.digAim = { x: Math.sin(k) * 0.6, y: Math.cos(k * 0.7) * 0.5 };
        step(24);
        a.dig = false;
        a.digAim = null;
        k++;
      }
      const t1 = performance.now();
      fx.flushAll();
      return { prims: dig.count, iterations: k, digMs: Math.round(t1 - t0), flushMs: Math.round(performance.now() - t1) };
    },
    fingerprint() {
      fx.flushAll();
      const P = dig.exportPrims();
      let ps = 0;
      for (let i = 0; i < P.length; i++) ps += P[i] * ((i % 7) + 1);
      const chunks = [];
      let triSum = 0, posSum = 0;
      for (const [id, m] of [...fx.meshes.entries()].sort((x, y) => x[0] - y[0])) {
        const pos = m.geometry.getAttribute('position').array;
        let s = 0;
        for (let i = 0; i < pos.length; i += 7) s += pos[i];
        const tris = (m.geometry.getIndex()?.count ?? pos.length / 3) / 3;
        triSum += tris;
        posSum += s;
        chunks.push([id, tris]);
      }
      // 空洞のまわりの当たり判定（空洞の両端と、その上下左右 0.3）
      let solidSum = 0, solidN = 0;
      for (let i = 0; i < P.length; i += 7 * Math.max(1, Math.floor(P.length / 7 / 400))) {
        for (const o of [0, 3]) for (const [dx, dy, dz] of [[0, 0, 0], [0.3, 0, 0], [-0.3, 0, 0], [0, 0.3, 0], [0, -0.3, 0], [0, 0, 0.3], [0, 0, -0.3]]) {
          solidSum += w.solid(P[i + o] + dx, P[i + o + 1] + dy, P[i + o + 2] + dz);
          solidN++;
        }
      }
      return {
        prims: dig.count, primSum: r6(ps), uncommitted: dig.uncommitted,
        chunks: chunks.length, triSum, posSum: r6(posSum), chunkTris: chunks,
        hiddenTris: fx.stats.hiddenTris, hiddenPlants: fx.stats.hiddenPlants, hiddenPebbles: fx.stats.hiddenPebbles,
        solidSum: r6(solidSum), solidN,
        crab: [r6(c.x), r6(c.y), r6(c.z)], visited: [...a.tracker.visited].sort(),
      };
    },
    async record(tag) {
      const fp = sv.fingerprint();
      localStorage.setItem('ppp-test-fp:' + tag, JSON.stringify(fp));
      a.save.saver.suspended = false;
      const ok = await a.save.saver.flush();
      return { ok, prims: fp.prims, chunks: fp.chunks, triSum: fp.triSum, bytes: a.save.store.stats.lastBytes, writeMs: +a.save.store.stats.lastWriteMs.toFixed(1), gatherMs: +a.save.saver.stats.gatherMs.toFixed(2) };
    },
    compare(tag) {
      const before = JSON.parse(localStorage.getItem('ppp-test-fp:' + tag) ?? 'null');
      const now = sv.fingerprint();
      if (!before) return { error: 'no record' };
      const diff = {};
      for (const k of Object.keys(before)) {
        const x = JSON.stringify(before[k]), y = JSON.stringify(now[k]);
        if (k === 'crab') {
          const d = Math.hypot(before.crab[0] - now.crab[0], before.crab[1] - now.crab[1], before.crab[2] - now.crab[2]);
          if (d > 0.05) diff.crab = { before: before.crab, now: now.crab, d };
          continue;
        }
        if (x !== y) diff[k] = k === 'chunkTris' ? 'differs' : { before: before[k], now: now[k] };
      }
      return { same: Object.keys(diff).length === 0, diff, prims: now.prims, chunks: now.chunks, triSum: now.triSum, restore: a.save.restore };
    },
    async corrupt(kind) {
      a.save.saver.suspended = true;
      return idb(async (st) => {
        const cur = await req(st.get('current'));
        let v;
        if (kind === 'garbage') v = 'not a save';
        else if (kind === 'nan') v = { ...cur, player: { ...cur.player, x: NaN } };
        else if (kind === 'version') v = { ...cur, version: 99 };
        else if (kind === 'prims') {
          const p = new Float32Array(cur.tanks.home.dig.prims);
          p[3] = 1e6;
          v = { ...cur, tanks: { home: { dig: { prims: p } } } };
        } else v = cur;
        st.put(v, 'current');
        return kind;
      });
    },
    async keys() {
      return idb((st) => req(st.getAllKeys()));
    },
  };
  window.__sv = sv;
})();
