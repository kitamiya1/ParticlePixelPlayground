// 予備の保存先（localStorage）から IndexedDB への引き継ぎの検証（Playwright。browser_run_code_unsafe の filename で実行）。
// IndexedDB を開けなかった起動は、URL に noidb を付けたページで作る（init script で window.indexedDB を消す → SaveStore は localStorage へ落ちる）。
// 場面ごとに新しいブラウザの文脈を作るので、開発用のブラウザの保存データには触れない。
// globalThis.__over = { host, only: ['F1', ...] } で上書きできる。
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', only: null }, globalThis.__over ?? {});
  const browser = page.context().browser();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const helpers = async (p) => p.evaluate(async () => {
    await fetch('/docs/aquarium/tools/save_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
    window.__aqua.freeze = true;
  });
  const open = async (ctx, noidb = false) => {
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(`${O.host}/aquarium.html?${noidb ? 'noidb&' : ''}${Date.now()}`);
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    await helpers(p);
    p.errs = errs;
    return p;
  };
  const newCtx = async () => {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 400 }, acceptDownloads: true });
    await ctx.addInitScript(() => {
      if (location.search.includes('noidb')) Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    });
    return ctx;
  };
  // 保存先の中身の要約（IndexedDB と localStorage）
  const peek = (p) => p.evaluate(() => new Promise((res) => {
    const sum = (v) => (v === undefined ? null : typeof v !== 'object' || v === null ? { bad: String(v).slice(0, 12) } : { rev: v.rev ?? null, id: (v.saveId ?? '').slice(0, 8), prims: v.tanks?.home?.dig?.prims ? v.tanks.home.dig.prims.length / 8 : null, savedAt: v.savedAt });
    const ls = { current: localStorage.getItem('ppp-aquarium:current') !== null, backup: localStorage.getItem('ppp-aquarium:backup') !== null };
    if (typeof indexedDB === 'undefined') return res({ ls });
    const o = indexedDB.open('ppp-aquarium', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('saves');
    o.onsuccess = () => {
      const st = o.result.transaction('saves', 'readonly').objectStore('saves');
      const g1 = st.get('current'), g2 = st.get('backup'), g3 = st.getAllKeys();
      g3.onsuccess = () => {
        const keys = g3.result.map(String);
        o.result.close();
        res({ ls, current: sum(g1.result), backup: sum(g2.result), alt: keys.filter((k) => k.startsWith('alt-')).length, corrupt: keys.filter((k) => k.startsWith('corrupt-')).length });
      };
    };
  }));
  const dig = (p, x, z, sec = 2) => p.evaluate(([x, z, sec]) => { __sv.digSites([{ at: [x, z], heading: Math.PI / 2, sec, move: true }]); return __aqua.world.dig.count; }, [x, z, sec]);
  const flush = (p) => p.evaluate(async () => __aqua.save.saver.flush());
  const st = (p) => p.evaluate(() => {
    const S = __aqua.save;
    return { kind: S.store.kind, loaded: S.loaded.status, prims: __aqua.world.dig.count, fallback: S.store.info.fallback, alt: !!S.store.info.alt, conflict: !!S.store.conflict,
      note: document.querySelector('#save-panel [data-k=note]').textContent.slice(0, 60),
      altBtn: !document.querySelector('#save-panel [data-k=altswap]').hidden };
  });
  const reloaded = async (p, act) => {
    await p.evaluate(() => { window.__mark = 1; });
    await act();
    for (let i = 0; i < 600; i++) {
      await wait(300);
      try {
        if (await p.evaluate(() => !!window.__aqua && !window.__mark)) break;
      } catch {
        /* 読み込み中 */
      }
    }
    await helpers(p);
  };
  const out = {};
  const run = async (name, fn) => {
    if (O.only && !O.only.includes(name)) return;
    const ctx = await newCtx();
    try {
      out[name] = await fn(ctx);
    } catch (e) {
      out[name] = { error: String(e).slice(0, 300) };
    }
    await ctx.close();
  };

  // F1：IndexedDB が空。localStorage へ落ちた起動で掘って保存 → 次の起動（IndexedDB が開ける）で引き継ぐ・localStorage を消す・もう一度開いても同じ
  await run('F1', async (ctx) => {
    const a = await open(ctx, true);
    const s0 = await st(a);
    const n = await dig(a, -4.6, 8.3);
    await flush(a);
    const lsBefore = await peek(a);
    await a.close();
    const b = await open(ctx);
    const s1 = await st(b);
    const after = await peek(b);
    await b.close();
    const c = await open(ctx);
    const s2 = await st(c);
    await c.close();
    return { fallbackBoot: s0, dug: n, lsBefore, adopted: s1, stores: after, nextBoot: s2,
      ok: s0.kind === 'localStorage' && s1.kind === 'indexeddb' && s1.fallback?.result === 'imported' && s1.prims === n && !after.ls.current && !after.ls.backup && after.current?.prims === n && s2.prims === n && s2.fallback === null && !s2.alt };
  });

  // F2：両方に別の進捗。IndexedDB = A（先）、localStorage = B（後）→ 新しい B で再開し A を残す。切り替え → A で再開・B が残る。書き出し → 消える
  await run('F2', async (ctx) => {
    const a = await open(ctx);
    const nA = await dig(a, -4.6, 8.3, 3);
    await flush(a);
    await a.close();
    const b = await open(ctx, true);
    const sB = await st(b);
    const nB = await dig(b, 2.0, 6.0, 1);
    await flush(b);
    await b.close();
    const c = await open(ctx);
    const s1 = await st(c);
    const stores1 = await peek(c);
    // 切り替え（画面のボタン）
    await c.evaluate(() => __aqua.save.menu.toggle(true));
    await reloaded(c, () => c.evaluate(() => document.querySelector('#save-panel [data-k=altswap]').click()));
    const s2 = await st(c);
    const stores2 = await peek(c);
    // 書き出し（画面のボタン）→ ダウンロード → もう一方は消える
    await c.evaluate(() => __aqua.save.menu.toggle(true));
    const dl = c.waitForEvent('download', { timeout: 15000 });
    await c.evaluate(() => document.querySelector('#save-panel [data-k=altexport]').click());
    const file = await dl;
    const fileName = file.suggestedFilename();
    const text = await (await file.createReadStream()).toArray().then((ch) => Buffer.concat(ch).toString('utf8'));
    await wait(500);
    const s3 = await st(c);
    const exportedPrims = JSON.parse(text).tanks?.home?.dig?.prims?.f64 ? Buffer.from(JSON.parse(text).tanks.home.dig.prims.f64, 'base64').length / 64 : null;
    await c.close();
    return { nA, lsBoot: sB, nB, adopted: s1, stores1, swapped: s2, stores2, exported: { fileName, prims: exportedPrims }, afterExport: s3,
      ok: sB.kind === 'localStorage' && sB.prims === 0 && s1.fallback?.result === 'kept' && s1.fallback?.chosen === 'localStorage' && s1.prims === nB && s1.alt && s1.altBtn
        && !stores1.ls.current && stores1.alt === 1 && s2.prims === nA && s2.alt && stores2.alt === 1 && exportedPrims === nB && !s3.alt && !s3.altBtn };
  });

  // F3：両方に別の進捗で、IndexedDB の方が新しい（localStorage は以前の版の不具合で残った古い進捗に見立てる）→ IndexedDB のまま再開し、localStorage の分を alt へ
  await run('F3', async (ctx) => {
    const a = await open(ctx);
    const nA = await dig(a, -4.6, 8.3, 3);
    await flush(a);
    await a.close();
    const b = await open(ctx, true);
    const nB = await dig(b, 2.0, 6.0, 1);
    await flush(b);
    await b.evaluate(() => { const k = 'ppp-aquarium:current'; const d = JSON.parse(localStorage.getItem(k)); d.savedAt = 1000; localStorage.setItem(k, JSON.stringify(d)); });
    await b.close();
    const c = await open(ctx);
    const s1 = await st(c);
    const stores = await peek(c);
    const altPrims = await c.evaluate(async () => { const t = await __aqua.save.store.altText(); return t ? atob(JSON.parse(t).tanks.home.dig.prims.f64).length / 64 : null; });
    await c.close();
    return { nA, nB, adopted: s1, stores, altPrims,
      ok: s1.fallback?.result === 'kept' && s1.fallback?.chosen === 'indexeddb' && s1.prims === nA && s1.alt && stores.alt === 1 && !stores.ls.current && stores.current?.prims === nA && altPrims === nB };
  });

  // F4：localStorage の current が壊れていて backup も無い：IndexedDB の進捗で再開し、localStorage には触れない
  await run('F4', async (ctx) => {
    const a = await open(ctx);
    const nA = await dig(a, -4.6, 8.3, 2);
    await flush(a);
    await a.evaluate(() => localStorage.setItem('ppp-aquarium:current', '{"broken'));
    await a.close();
    const b = await open(ctx);
    const s1 = await st(b);
    const stores = await peek(b);
    await b.close();
    return { nA, boot: s1, stores, ok: s1.prims === nA && s1.fallback === null && !s1.alt && stores.ls.current && stores.current?.prims === nA && stores.alt === 0 };
  });

  // F5：IndexedDB が空で、localStorage の current が壊れ backup が正常：backup を引き継ぎ、壊れた current は IndexedDB の隔離へ写してから消す
  await run('F5', async (ctx) => {
    const a = await open(ctx, true);
    const nB = await dig(a, 2.0, 6.0, 1);
    await flush(a);
    await a.evaluate(() => {
      localStorage.setItem('ppp-aquarium:backup', localStorage.getItem('ppp-aquarium:current'));
      localStorage.setItem('ppp-aquarium:current', 'garbage');
    });
    await a.close();
    const b = await open(ctx);
    const s1 = await st(b);
    const stores = await peek(b);
    await b.close();
    return { nB, boot: s1, stores, ok: s1.fallback?.result === 'imported' && s1.prims === nB && stores.corrupt === 1 && !stores.ls.current && !stores.ls.backup };
  });

  // F6：引き継ぐ途中でほかのタブが current を進めた（比べて書く）：引き継がず、localStorage の分を残す
  await run('F6', async (ctx) => {
    const a = await open(ctx, true);
    await dig(a, 2.0, 6.0, 1);
    await flush(a);
    await a.close();
    // 引き継ぎの読みと書きの間に別のタブの保存が入ったことにする：IndexedDB の get('current') の直後に current を書き換える
    await ctx.addInitScript(() => {
      if (!location.search.includes('race')) return;
      // 別のタブに見立てた接続を先に開いておき、読んだ直後に（同期で）その接続の書き込みを始める（こちらの書き込みより先に並ぶ）
      let other = null;
      const o = indexedDB.open('ppp-aquarium', 1);
      o.onupgradeneeded = () => { if (!o.result.objectStoreNames.contains('saves')) o.result.createObjectStore('saves'); };
      o.onsuccess = () => { other = o.result; };
      const P = IDBObjectStore.prototype, get0 = P.get;
      let once = false;
      P.get = function (k) {
        const r = get0.call(this, k);
        if (k === 'current' && !once && this.transaction.mode === 'readonly') {
          once = true;
          r.addEventListener('success', () => {
            window.__raced = !!other;
            if (other) other.transaction('saves', 'readwrite').objectStore('saves').put({ format: 'x', saveId: 'other-tab' }, 'current');
          });
        }
        return r;
      };
    });
    const p = await ctx.newPage();
    await p.goto(`${O.host}/aquarium.html?race&${Date.now()}`);
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    await helpers(p);
    const s1 = await st(p);
    const stores = await peek(p);
    const raced = await p.evaluate(() => window.__raced);
    await p.close();
    return { raced, boot: s1, stores, ok: raced && s1.fallback === null && stores.ls.current };
  });
  return out;
}
