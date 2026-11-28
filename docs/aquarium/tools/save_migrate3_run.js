// 保存形式の版 2 → 3（栄養・食べられた生き物）の移行テスト（Playwright の browser_run_code_unsafe の filename で実行）。
// globalThis.__over = { v2: 'http://localhost:5174'（main = 版 2）, v3: 'http://localhost:5173'（このブランチ）} で上書き。
// 1. 版 2 のページで掘る・盛る・訪れる・仲間を同行にして、版 2 の保存データ（IndexedDB の形）と書き出しファイル・指紋を作る（save_migrate_test.js の makeV1）
// 2. 版 3 のページ（?nosave なし・新しい文脈）の IndexedDB の current に版 2 のデータを置いて読み込み直す
//    → 読み込みの状態・版・指紋の一致（掘った穴・区画の三角形・当たり判定・仲間・訪れた場所・カニの位置）・栄養 0・食べられた生き物なし
// 3. 版 2 の書き出しファイルを、初期状態から読み込み → 読み込み直し → 1 の指紋と一致
// 4. 版 3 で食べる（エビの食べかけ・ゴカイ 1 匹）→ 書き出す → 初期状態から読み込み → 読み込み直し → 栄養・食べかけが同じ
async (page) => {
  const O = Object.assign({ v2: 'http://localhost:5174', v3: 'http://localhost:5173' }, globalThis.__over ?? {});
  const browser = page.context().browser();
  const boot = async (p, url) => {
    await p.goto(`${url}/aquarium.html?${Date.now()}`, { timeout: 120000 });
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 240000 });
    await p.evaluate(async (h) => {
      for (const f of ['save_migrate_test.js', 'eat_helpers.js']) {
        const r = await fetch(`${h}/docs/aquarium/tools/${f}?${Date.now()}`);
        if (r.ok && !(r.headers.get('content-type') ?? '').startsWith('text/html')) eval(await r.text());
      }
      window.__aqua.help?.close?.();
    }, url);
  };
  const out = {};
  // 1. 版 2
  const c2 = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const p2 = await c2.newPage();
  await boot(p2, O.v2);
  const v2 = await p2.evaluate(() => window.__mg.makeV1());
  out.v2 = { version: v2.version, stride: v2.stride, prims: v2.fp.prims, fills: v2.fp.fills, worms: v2.raw.buddies.filter((b) => b.species === 'gokai').length };
  await c2.close();
  // 2. 版 3：IndexedDB に版 2 のデータ
  const c3 = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const p3 = await c3.newPage();
  const errs = [];
  p3.on('pageerror', (e) => errs.push(String(e)));
  // （消した直後は、そのページの接続が閉じるまで消去が終わらない：読み込み直してから書く）
  const wipe = async () => {
    await p3.evaluate(() => window.__mg.wipe());
    await boot(p3, O.v3);
  };
  await boot(p3, O.v3);
  await wipe();
  await p3.evaluate((raw) => window.__mg.putCurrent(raw), v2.raw);
  await boot(p3, O.v3);
  out.idb = await p3.evaluate((fp) => {
    const A = window.__aqua, L = A.save.loaded;
    return { status: L.status, version: L.data?.version, nutrition: A.eat.nutrition.total, critters: L.data?.tanks.home.food.critters.length, cmp: window.__mg.compare(fp) };
  }, v2.fp);
  // 3. 版 2 の書き出しファイル
  await wipe();
  out.file = await p3.evaluate((file) => window.__mg.importFile(file), v2.file);
  await boot(p3, O.v3);
  out.fileReload = await p3.evaluate((fp) => ({ status: window.__aqua.save.loaded.status, version: window.__aqua.save.loaded.data?.version, cmp: window.__mg.compare(fp) }), v2.fp);
  // 4. 版 3 で食べる → 書き出す → 初期状態から読み込み
  const ate = await p3.evaluate(async () => {
    const A = window.__aqua, E = window.__eat;
    A.save.saver.suspended = false;
    let s = E.setup('shrimp', 'R');
    for (let t = 0; t < 2 && !s.held; t++) s = E.setup('shrimp', 'R');
    E.eat(2.2);
    E.release(90);
    E.setup('worm', 'R');
    E.eat(14);
    const text = await window.__mg.exportText();
    return { text, nutrition: +A.eat.nutrition.total.toFixed(4), critters: A.life.eatenList().map((e) => `${e.kind}${e.i}:${e.left.toFixed(3)}:${e.gone}`), gone: A.worms.worms.filter((w) => w.gone).map((w) => w.id) };
  });
  await wipe();
  out.v3file = await p3.evaluate((text) => window.__mg.importFile(text), ate.text);
  await boot(p3, O.v3);
  out.v3reload = await p3.evaluate((B) => {
    const A = window.__aqua;
    const crit = A.life.eatenList().map((e) => `${e.kind}${e.i}:${e.left.toFixed(3)}:${e.gone}`);
    const gone = A.worms.worms.filter((w) => w.gone).map((w) => w.id);
    return { status: A.save.loaded.status, version: A.save.loaded.data?.version, nutrition: +A.eat.nutrition.total.toFixed(4), same: +A.eat.nutrition.total.toFixed(4) === B.nutrition && JSON.stringify(crit) === JSON.stringify(B.critters) && JSON.stringify(gone) === JSON.stringify(B.gone), critters: crit, gone };
  }, { nutrition: ate.nutrition, critters: ate.critters, gone: ate.gone });
  out.before = { nutrition: ate.nutrition, critters: ate.critters, gone: ate.gone };
  out.errors = errs;
  await c3.close();
  return JSON.stringify(out);
}
