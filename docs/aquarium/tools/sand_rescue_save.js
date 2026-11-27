// 第 10 段階：古い版（持てる砂の上限 4）で作った保存データを新しい版で読み、失われた砂が戻るか・地形が同じか（Playwright。fetch + eval して page と O を渡す）。
// O = { oldHost（変更前 = main の版）, newHost（この版）, tools }
// 1. 古い版：新しい保存（IndexedDB は空）で、スタート地点の東を掘る（手持ちは 4 で止まり、超えた分は捨てる）→ 少し盛る → 保存 → 保存データを取り出す
// 2. 新しい版：同じ保存データを IndexedDB へ入れ、歩き方の設定も古い既定（lead・gaitV なし）にして開く →
//    読み込めたか・空洞の数・地形の指紋（空洞のまわりの距離関数の和）・読み込み直後の手持ち・見直し（救済）の後の手持ち・地形から数えた量・歩き方
async (page, O = {}) => {
  const tools = O.tools ?? 'http://localhost:5173';
  const oldHost = O.oldHost ?? 'http://localhost:5174', newHost = O.newHost ?? 'http://localhost:5173';
  const boot = async (p, url) => {
    await p.goto(url);
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  };
  const idbAll = () => new Promise((res, rej) => {
    const o = indexedDB.open('ppp-aquarium', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('saves');
    o.onsuccess = () => {
      const tx = o.result.transaction('saves', 'readonly'), st = tx.objectStore('saves'), out = {};
      const rq = st.openCursor();
      rq.onsuccess = () => { const cur = rq.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } };
      tx.oncomplete = () => { o.result.close(); res(out); };
      tx.onerror = () => rej(tx.error);
    };
    o.onerror = () => rej(o.error);
  });
  // 地形の指紋：空洞・砂山のまわりの格子点の距離関数の和
  const fp = () => {
    const w = window.__aqua.world, d = w.dig;
    let s = 0;
    for (const p of d.prims) for (const k of [-0.3, 0, 0.3]) s += w.sandSolid(p.a[0] + k, p.a[1], p.a[2] - k);
    return +s.toFixed(4);
  };
  // 1. 古い版
  const ctxO = await page.context().browser().newContext({ viewport: { width: 900, height: 600 } });
  const pO = await ctxO.newPage();
  await boot(pO, `${oldHost}/aquarium.html?${Date.now()}`);
  const old = await pO.evaluate(async ([h, fpSrc]) => {
    for (const f of ['climb_helpers.js', 'sand_fill_test.js']) await fetch(h + '/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
    const A = window.__aqua;
    const cr = __sf.crater(4);
    // 少し盛る
    A.crab.tool = 'fill';
    A.dig = true; A.step(60); A.dig = false; A.step(20); A.world.dig.measureStep(Infinity);
    A.crab.tool = 'dig';
    const ok = await A.save.saver.flush();
    return { ok, crater: cr, held: +A.crab.sandHeld.toFixed(3), prims: A.world.dig.count, fp: eval(fpSrc)() };
  }, [tools, `(${fp})`]);
  const rec = await pO.evaluate(`(${idbAll})()`);
  await ctxO.close();
  // 2. 新しい版
  const ctxN = await page.context().browser().newContext({ viewport: { width: 900, height: 600 } });
  const pN = await ctxN.newPage();
  const errs = [];
  pN.on('pageerror', (e) => errs.push(String(e)));
  await pN.goto(`${newHost}/aquarium.html?nosave&${Date.now()}`);
  await pN.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  await pN.evaluate(([r]) => new Promise((res, rej) => {
    // 歩き方の設定：古い既定（lead、gaitV なし）
    localStorage.setItem('ppp-aquarium:ui', JSON.stringify({ btnScale: 0.75, btnAlpha: 0.25, guides: false, camStyle: 'tps', gait: 'lead', plants: 'dyn', footDiag: false, labels: false }));
    const o = indexedDB.open('ppp-aquarium', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('saves');
    o.onsuccess = () => {
      const tx = o.result.transaction('saves', 'readwrite'), st = tx.objectStore('saves');
      st.clear();
      for (const [k, v] of Object.entries(r)) st.put(v, k);
      tx.oncomplete = () => { o.result.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  }), [rec]);
  await boot(pN, `${newHost}/aquarium.html?${Date.now()}`);
  const neu = await pN.evaluate(([fpSrc]) => {
    const A = window.__aqua, c = A.crab, d = A.world.dig;
    const held0 = +c.sandHeld.toFixed(3);
    const auditing0 = d.auditing;
    let n = 0;
    while (d.auditing && n < 2000) { A.step(1); n++; }
    // 地形から数え直した量（手元にあるはずの量）
    let v = 0; A.world.startSandAudit((x) => (v = x)); while (d.auditing) d.auditStep(1e9);
    return { status: A.save.loaded.status, prims: d.count, fp: eval(fpSrc)(), heldAtLoad: held0, auditingAtLoad: auditing0, framesToRescue: n, heldAfter: +c.sandHeld.toFixed(3), rescued: +c.sandStats.rescued.toFixed(3), expect: +(-v).toFixed(3), toast: document.getElementById('aqua-toast')?.textContent ?? '', gait: A.rig.gait, ui: localStorage.getItem('ppp-aquarium:ui') };
  }, [`(${fp})`]);
  await ctxN.close();
  const ok = old.ok && neu.status === 'ok' && neu.prims === old.prims && Math.abs(neu.fp - old.fp) < 1e-3 && Math.abs(neu.heldAfter - neu.expect) < 0.05 && neu.gait === 'hybrid' && errs.length === 0;
  return JSON.stringify({ ok, old, neu, errs });
}
