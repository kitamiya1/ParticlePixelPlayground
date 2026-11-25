// 複数タブの保存の競合・閉じる直前の控え・保存の失敗の検証（Playwright。browser_run_code_unsafe の filename で実行）。
// 1 つのブラウザの文脈（= 同じ IndexedDB / localStorage）でページを 2 つ開き、別々のタブとして扱う。
// 場面ごとに新しい文脈を作るので、開発用のブラウザの保存データには触れない。
// globalThis.__over = { host, only: ['A', ...] } で上書きできる。
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', only: null }, globalThis.__over ?? {});
  const browser = page.context().browser();
  const open = async (ctx) => {
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(O.host + '/aquarium.html?' + Date.now());
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    await p.evaluate(async () => {
      await fetch('/docs/aquarium/tools/save_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
      window.__aqua.freeze = true;
    });
    p.errs = errs;
    return p;
  };
  // ページの中：保存先の current / backup の要約
  const peek = (p) => p.evaluate(() => new Promise((res) => {
    const o = indexedDB.open('ppp-aquarium', 1);
    o.onsuccess = () => {
      const st = o.result.transaction('saves', 'readonly').objectStore('saves');
      const out = {};
      const sum = (v) => (v === undefined ? null : typeof v !== 'object' || v === null ? { bad: String(v).slice(0, 20) } : { rev: v.rev ?? null, id: (v.saveId ?? '').slice(0, 8), prims: v.tanks?.home?.dig?.prims ? v.tanks.home.dig.prims.length / 7 : null });
      const g1 = st.get('current'), g2 = st.get('backup'), g3 = st.getAllKeys();
      g3.onsuccess = () => {
        out.current = sum(g1.result);
        out.backup = sum(g2.result);
        out.keys = g3.result.map(String).filter((k) => !k.startsWith('corrupt')).concat(g3.result.some((k) => String(k).startsWith('corrupt')) ? ['corrupt-*'] : []);
        out.journal = Object.keys(localStorage).filter((k) => k.startsWith('ppp-aquarium:journal:')).length;
        out.orphan = !!localStorage.getItem('ppp-aquarium:journal-orphan');
        o.result.close();
        res(out);
      };
    };
  }));
  // ページの中：少し掘る（空洞の数が増える）・今すぐ保存
  const dig = (p, x = -4.6, z = 8.3, sec = 2) => p.evaluate(([x, z, sec]) => { __sv.digSites([{ at: [x, z], heading: Math.PI / 2, sec, move: true }]); return __aqua.world.dig.count; }, [x, z, sec]);
  const flush = (p) => p.evaluate(async () => { const s = __aqua.save.saver; s.suspended = !!__aqua.save.store.conflict; const ok = await s.flush(); return { ok, state: s.state, conflict: __aqua.save.store.conflict, rev: __aqua.save.store.knownRev }; });
  const st = (p) => p.evaluate(() => { const S = __aqua.save; return { state: S.saver.state, conflict: S.store.conflict, alert: document.getElementById('save-alert').classList.contains('show'), btn: document.querySelector('#menu .save').dataset.state, prims: __aqua.world.dig.count, loaded: S.loaded.status, fromJournal: S.store.info.fromJournal, orphan: S.store.info.orphan, note: document.querySelector('#save-panel [data-k=note]').textContent.slice(0, 40) }; });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 操作でページが読み込み直されるのを待つ（読み込み直す前に印を付け、印の無い新しいページの準備ができるまで）
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
    await p.evaluate(async () => { await fetch('/docs/aquarium/tools/save_helpers.js?' + Date.now()).then((r) => r.text()).then(eval); window.__aqua.freeze = true; });
  };
  const out = {};
  const run = async (name, fn) => {
    if (O.only && !O.only.includes(name)) return;
    const ctx = await browser.newContext({ viewport: { width: 640, height: 400 }, acceptDownloads: true });
    try {
      out[name] = await fn(ctx);
    } catch (e) {
      out[name] = { error: String(e).slice(0, 300) };
    }
    await ctx.close();
  };

  // A：通常の自動保存。両方のタブが同じデータを読んだあと、タブ 1 が保存 → タブ 2 は知らせで競合になり、保存しない
  await run('A', async (ctx) => {
    const t1 = await open(ctx);
    await dig(t1);
    await flush(t1);
    const t2 = await open(ctx);
    const t3 = await open(ctx);
    // タブ 3 は BroadcastChannel を受け取れない（古いブラウザ等）ことにする：書くときの比較だけで競合に気付く
    await t3.evaluate(() => { __aqua.save.store.channel?.close(); __aqua.save.store.channel = null; });
    const before = await peek(t1);
    await dig(t1, -9, 8.6);
    const s1 = await flush(t1);
    await wait(300);
    const t2BeforeWrite = await st(t2);
    await dig(t3, -12, 7);
    const s3 = await flush(t3);
    const after = await peek(t1);
    // 競合したタブの進捗を書き出す
    const dl = t2.waitForEvent('download');
    await t2.click('#save-alert [data-k="aexport"]');
    const d = await dl;
    const fn = d.suggestedFilename();
    return { before, t1save: s1, t2: t2BeforeWrite, t3write: { ok: s3.ok, conflictVia: s3.conflict?.via }, after, export: fn, errs: [...t1.errs, ...t2.errs, ...t3.errs] };
  });

  // B：保存データが無い状態で 2 つ開く → 先に保存した方が残り、後の方は競合
  await run('B', async (ctx) => {
    const t1 = await open(ctx);
    const t2 = await open(ctx);
    await t2.evaluate(() => { __aqua.save.store.channel?.close(); __aqua.save.store.channel = null; });
    await dig(t1);
    const s1 = await flush(t1);
    await dig(t2, -9, 8.6, 3);
    const s2 = await flush(t2);
    return { t1: s1.ok, t2: { ok: s2.ok, conflict: s2.conflict }, store: await peek(t1) };
  });

  // C：ファイルの読み込み（タブ 1）→ タブ 2 は競合。読み込み前の current は backup に残る
  await run('C', async (ctx) => {
    const t1 = await open(ctx);
    await dig(t1);
    await flush(t1);
    const t2 = await open(ctx);
    const before = await peek(t1);
    const file = await t1.evaluate(async () => { const m = await import('/src/aquarium/AquaSave.ts'); const d = __aqua.save.gather(); d.tanks.home.dig.prims = new Float64Array(0); d.progress.visited = ['cave']; return m.encodeSaveFile(d); });
    await reloaded(t1, () => t1.setInputFiles('#save-panel input[type=file]', { name: 'import.json', mimeType: 'application/json', buffer: Buffer.from(file) }));
    await wait(300);
    const t2s = await st(t2);
    const s2 = await t2.evaluate(async () => { __aqua.save.saver.suspended = false; return __aqua.save.saver.flush(); });
    const after = await peek(t2);
    const t1s = await st(t1);
    return { before, afterImport: { t1prims: t1s.prims, t1loaded: t1s.loaded }, t2: { conflict: t2s.conflict, alert: t2s.alert, writeOk: s2 }, store: after };
  });

  // D：初期状態に戻す（タブ 1）→ タブ 2 は競合（消されたことを知る）。タブ 2 が古い進捗で current を作り直さない
  await run('D', async (ctx) => {
    const t1 = await open(ctx);
    await dig(t1);
    await flush(t1);
    const t2 = await open(ctx);
    await t1.click('#menu .save');
    await t1.click('#save-panel [data-k="reset"]');
    await wait(400);
    await reloaded(t1, () => t1.click('#save-panel [data-k="yes"]'));
    await wait(300);
    const t2s = await st(t2);
    const s2 = await t2.evaluate(async () => { __aqua.save.saver.suspended = false; return __aqua.save.saver.flush(); });
    return { t2: { conflict: t2s.conflict, writeOk: s2 }, store: await peek(t1), t1loaded: (await st(t1)).loaded };
  });

  // E：壊れた current から 2 つのタブが backup で再開 → 先に保存した方が壊れた current を置き換え、後の方は競合。backup は残る
  await run('E', async (ctx) => {
    const t1 = await open(ctx);
    await dig(t1);
    await flush(t1);
    await dig(t1, -9, 8.6);
    await flush(t1);
    await t1.evaluate(() => __sv.corrupt('garbage'));
    const t2 = await open(ctx);
    const t3 = await open(ctx);
    const before = await peek(t2);
    const loaded = [(await st(t2)).loaded, (await st(t3)).loaded];
    await t3.evaluate(() => { __aqua.save.store.channel?.close(); __aqua.save.store.channel = null; });
    const s2 = await flush(t2);
    const s3 = await flush(t3);
    return { loaded, before, t2: s2.ok, t3: { ok: s3.ok, conflict: s3.conflict?.via }, after: await peek(t2) };
  });

  // F：閉じる直前の控え。IndexedDB への書き込みが終わらないままページが止まった（書き込みを止めて閉じる）→ 次に開くと控えから再開
  await run('F', async (ctx) => {
    const t1 = await open(ctx);
    await dig(t1);
    await flush(t1);
    const saved = await peek(t1);
    const n = await dig(t1, -9, 8.6);
    // 書き込みが終わらない（ページが止められた）ことにする
    await t1.evaluate(() => { const be = __aqua.save.store.be; be.commit = () => new Promise(() => {}); __aqua.save.saver.onHide(); });
    const mid = await peek(t1);
    await t1.close();
    const t2 = await open(ctx);
    const s = await st(t2);
    await t2.evaluate(() => { __aqua.freeze = false; __aqua.step(60); __aqua.freeze = true; });
    await wait(500);
    const afterAutosave = await peek(t2);
    // もう一度開き直す：控えは消えていて、使わなかった進捗にもならない
    await t2.close();
    const t3 = await open(ctx);
    const s3 = await st(t3);
    return { saved, dugPrims: n, beforeReopen: mid, reopened: { prims: s.prims, fromJournal: s.fromJournal, note: s.note }, afterAutosave, reopen2: { prims: s3.prims, fromJournal: s3.fromJournal, orphan: s3.orphan, store: await peek(t3) } };
  });

  // G：控えがあるが、その後に別のタブが保存した → 控えは使わず、書き出せるように残す
  await run('G', async (ctx) => {
    const t1 = await open(ctx);
    await dig(t1);
    await flush(t1);
    const t2 = await open(ctx);
    await dig(t1, -9, 8.6);
    await t1.evaluate(() => { const be = __aqua.save.store.be; be.commit = () => new Promise(() => {}); __aqua.save.saver.onHide(); });
    await t1.close();
    // タブ 2 は知らせ（控えは IndexedDB に書いていないので届かない）を受けずに保存する
    await dig(t2, -12, 7, 3);
    const s2 = await flush(t2);
    await t2.close();
    const t3 = await open(ctx);
    const s = await st(t3);
    const dl = t3.waitForEvent('download');
    await t3.click('#menu .save');
    await t3.click('#save-panel [data-k="orphan"]');
    const d = await dl;
    return { t2save: s2.ok, reopened: { prims: s.prims, fromJournal: s.fromJournal, orphan: s.orphan, note: s.note }, orphanFile: d.suggestedFilename(), store: await peek(t3) };
  });

  // H：保存の失敗（書き込みが例外）→ 状態「保存できていません」と知らせ、直れば自動で書き直す
  await run('H', async (ctx) => {
    const t1 = await open(ctx);
    await dig(t1);
    const r = await t1.evaluate(async () => {
      const S = __aqua.save, be = S.store.be, orig = be.commit.bind(be);
      be.commit = () => Promise.reject(new Error('QuotaExceededError（試験）'));
      const toast = () => document.getElementById('aqua-toast').textContent;
      const ok1 = await S.saver.flush();
      const st1 = { ok: ok1, state: S.saver.state, btn: document.querySelector('#menu .save').dataset.state, toast: toast() };
      be.commit = orig;
      // 間を空けて自動で書き直す（ゲームの時間を進める）
      __aqua.freeze = false;
      for (let i = 0; i < 60 * 12 && S.saver.state !== 'saved'; i++) __aqua.step(1);
      __aqua.freeze = true;
      await new Promise((r) => setTimeout(r, 300));
      return { failed: st1, recovered: { state: S.saver.state, saves: S.saver.stats.saves } };
    });
    return { ...r, store: await peek(t1) };
  });
  return out;
}
