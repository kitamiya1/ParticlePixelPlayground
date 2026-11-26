// 保存形式の版 1 → 2 の移行・掘る / 盛るの順序の復元の検証（開発用ページで fetch(url).then(r => r.text()).then(eval)）。
// window.__mg：
//   fingerprint()     … いまの地形の指紋（保存の並びの幅に依らない）：編集の数・種類・形の和、区画ごとの三角形の数・頂点の和、
//                        隠した高さ場・植物・小石、編集のまわりの当たり判定（solid）の値の和、カニの位置、手持ちの砂・道具、
//                        仲間（見つけた・同行・位置）、訪れた場所・進み具合
//   makeV1()          … （main = 版 1 のページで）掘る・場所を訪れる・仲間を同行にして、保存データ（gather）と指紋を返す。
//                        raw = IndexedDB に入れる形（空洞は数の配列。構造化複製の代わり）、file = 版 1 の書き出しファイルの文字列
//   putCurrent(raw)   … IndexedDB の current に raw を置く（空洞の配列は Float64Array に直す。版 1 のページが書いたのと同じ形）
//   importFile(text)  … メニューの「読み込み」と同じ道（decodeSaveFile → validateSave → SaveStore.replace）。読み込み直しは呼ぶ側
//   wipe()            … IndexedDB の ppp-aquarium を消す
(() => {
  const a = window.__aqua, c = a.crab, w = a.world, dig = w.dig, fx = a.view.digFx;
  const r6 = (v) => +v.toFixed(6);
  const step = (n) => { a.freeze = false; a.step(n); };
  const idbPut = (key, value) => new Promise((res, rej) => {
    const o = indexedDB.open('ppp-aquarium', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('saves');
    o.onsuccess = () => {
      const tx = o.result.transaction('saves', 'readwrite');
      tx.objectStore('saves').put(value, key);
      tx.oncomplete = () => { o.result.close(); res('ok'); };
      tx.onerror = () => rej(tx.error);
    };
    o.onerror = () => rej(o.error);
  });
  const mg = {
    fingerprint() {
      fx.flushAll();
      let ps = 0;
      dig.prims.forEach((p, i) => { ps += (p.a[0] + 2 * p.a[1] + 3 * p.a[2] + 4 * p.b[0] + 5 * p.b[1] + 6 * p.b[2] + 7 * p.r) * ((i % 5) + 1) + (p.fill ?? 0) * (i + 1); });
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
      let solidSum = 0, solidN = 0;
      const every = Math.max(1, Math.floor(dig.prims.length / 300));
      for (let i = 0; i < dig.prims.length; i += every) {
        const p = dig.prims[i];
        for (const q of [p.a, p.b]) for (const [dx, dy, dz] of [[0, 0, 0], [0.3, 0, 0], [-0.3, 0, 0], [0, 0.3, 0], [0, -0.3, 0], [0, 0, 0.3], [0, 0, -0.3]]) {
          solidSum += w.solid(q[0] + dx, q[1] + dy, q[2] + dz);
          solidN++;
        }
      }
      const b = a.buddy;
      return {
        prims: dig.count, fills: dig.prims.filter((p) => p.fill).length, primSum: r6(ps), uncommitted: dig.uncommitted,
        chunks: chunks.length, triSum, posSum: r6(posSum), chunkTris: chunks,
        hiddenTris: fx.stats.hiddenTris, hiddenPlants: fx.stats.hiddenPlants, hiddenPebbles: fx.stats.hiddenPebbles,
        solidSum: r6(solidSum), solidN,
        crab: [r6(c.x), r6(c.y), r6(c.z)], sand: r6(c.sandHeld ?? 0), tool: c.tool ?? 'dig',
        buddy: { found: b.found, mode: b.mode, examined: b.examined, pos: [b.x, b.y, b.z].map((v) => +v.toFixed(3)) },
        visited: [...a.tracker.visited].sort(),
      };
    },
    compare(before) {
      const now = mg.fingerprint();
      const diff = {};
      for (const k of Object.keys(before)) {
        if (k === 'crab') {
          const d = Math.hypot(before.crab[0] - now.crab[0], before.crab[1] - now.crab[1], before.crab[2] - now.crab[2]);
          if (d > 0.05) diff.crab = { before: before.crab, now: now.crab, d };
          continue;
        }
        if (k === 'buddy') {
          const B = before.buddy, N = now.buddy;
          if (B.found !== N.found || B.mode !== N.mode || B.examined !== N.examined) diff.buddy = { before: B, now: N };
          continue;
        }
        if (JSON.stringify(before[k]) !== JSON.stringify(now[k])) diff[k] = k === 'chunkTris' ? 'differs' : { before: before[k], now: now[k] };
      }
      return { same: Object.keys(diff).length === 0, diff, now: { prims: now.prims, fills: now.fills, chunks: now.chunks, triSum: now.triSum, sand: now.sand, tool: now.tool, buddy: now.buddy } };
    },
    /** 版 1 のページ（main）で：掘る・訪れる・仲間を同行に。保存データと指紋 */
    makeV1() {
      fx.budgetMs = 1e9;
      const sites = [
        { at: [-4.6, 8.3], heading: Math.PI / 2, sec: 5, move: true },
        { at: [-14, 9.0], heading: 0, sec: 4, move: true },
        { at: [9.0, -3.5], heading: 0, sec: 3, move: true },
      ];
      const inp = a.input, mv0 = inp.moveAxis;
      for (const s of sites) {
        c.teleport(s.at[0], s.at[1]); c.heading = s.heading; a.camera.placeBehind(c); step(30); c.heading = s.heading;
        a.dig = true; a.digAim = { x: 0, y: 0 };
        inp.moveAxis = () => { const hd = c.digYaw ?? c.heading, yaw = a.camera.yaw, wx = Math.sin(hd), wz = Math.cos(hd); return { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: -wx * Math.sin(yaw) - wz * Math.cos(yaw) }; };
        step(Math.round(s.sec * 60));
        a.dig = false; a.digAim = null; inp.moveAxis = mv0; step(20);
      }
      // 訪れた場所・仲間（見つけて同行）
      for (const sp of a.spots.slice(0, 4)) a.tracker.visited.add(sp.id);
      const b = a.buddy;
      b.examined = true; b.found = true; b.mode = 'follow';
      c.teleport(-6, 3); a.camera.placeBehind(c); step(60);
      a.freeze = true;
      const d = a.save.gather();
      const fp = mg.fingerprint();
      // IndexedDB に入れる形を、JSON で運べるよう空洞だけ配列に
      const raw = { ...d, rev: 1, saveId: 'v1-test', tanks: Object.fromEntries(Object.entries(d.tanks).map(([k, t]) => [k, { ...t, dig: { prims: Array.from(t.dig.prims) } }])) };
      // 版 1 の書き出しファイル（空洞は base64 のリトルエンディアンの倍精度）
      const enc = (arr) => {
        const dv = new DataView(new ArrayBuffer(arr.length * 8));
        arr.forEach((v, i) => dv.setFloat64(i * 8, v, true));
        const u = new Uint8Array(dv.buffer);
        let s = '';
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
        return btoa(s);
      };
      const file = JSON.stringify({ ...d, tanks: Object.fromEntries(Object.entries(d.tanks).map(([k, t]) => [k, { dig: { prims: { f64: enc(Array.from(t.dig.prims)) } } }])) });
      return { version: d.version, stride: d.tanks.home.dig.prims.length / dig.count, fp, raw, file };
    },
    async putCurrent(raw) {
      a.save.saver.suspended = true;
      const v = { ...raw, tanks: Object.fromEntries(Object.entries(raw.tanks).map(([k, t]) => [k, { ...t, dig: { prims: Float64Array.from(t.dig.prims) } }])) };
      return idbPut('current', v);
    },
    async importFile(text) {
      const S = await import('/src/aquarium/AquaSave.ts');
      const r = S.validateSave(S.decodeSaveFile(text), a.save.ctx);
      if (!r.ok) return { ok: false, error: r.error };
      a.save.saver.suspended = true;
      const ok = await a.save.store.replace(r.data);
      return { ok, version: r.data.version, prims: r.data.tanks.home.dig.prims.length / 8, sand: r.data.player.sand, tool: r.data.player.tool, warnings: r.warnings };
    },
    async exportText() {
      const S = await import('/src/aquarium/AquaSave.ts');
      return S.encodeSaveFile(a.save.gather());
    },
    async wipe() {
      a.save.saver.suspended = true;
      await new Promise((res) => { const d = indexedDB.deleteDatabase('ppp-aquarium'); d.onsuccess = d.onerror = d.onblocked = () => res(); });
      return 'wiped';
    },
  };
  window.__mg = mg;
  return 'ok';
})();
