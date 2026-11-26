// 保存形式の移行テスト（Playwright の browser_run_code_unsafe で fetch(url).then(eval) して (page) => … として呼ぶ）。
// globalThis.__over = { v1: 'http://localhost:5174'（main = 版 1）, v2: 'http://localhost:5173'（このブランチ）} で上書き。
// 1. 版 1 のページで掘る・訪れる・仲間を同行にして、版 1 の保存データ（IndexedDB の形）と書き出しファイル・指紋を作る
// 2. 版 2 のページ（?nosave なし。自前の新しいブラウザの文脈）で IndexedDB の current に版 1 のデータを置いて読み込み直す
//    → 読み込みの状態・指紋の一致（掘った穴の形・区画の三角形・当たり判定・仲間・訪れた場所・カニの位置）・手持ちの砂 0・道具「掘る」
// 3. 版 2 で 掘る → 盛る → その砂を掘る → また盛る（層 4 つ）→ 保存 → 読み込み直し → 指紋の一致（順序の復元）
// 4. 3 を書き出しファイルにして、初期状態から読み込み → 読み込み直し → 指紋の一致
// 5. 版 1 の書き出しファイルを、初期状態から読み込み → 読み込み直し → 1 の指紋と一致
async (page) => {
  const O = Object.assign({ v1: 'http://localhost:5174', v2: 'http://localhost:5173' }, globalThis.__over ?? {});
  const tool = 'http://localhost:5173/docs/aquarium/tools/save_migrate_test.js';
  const ctx = await page.context().browser().newContext({ viewport: { width: 800, height: 500 } });
  const ready = async (p) => {
    await p.waitForFunction(() => window.__aqua && window.__aqua.save, null, { timeout: 180000 });
    await p.evaluate(async (u) => { await fetch(u + '?' + Date.now()).then((r) => r.text()).then(eval); }, tool);
  };
  const out = {};
  // 1. 版 1
  const p1 = await ctx.newPage();
  await p1.goto(O.v1 + '/aquarium.html?nosave&' + Date.now());
  await ready(p1);
  const v1 = await p1.evaluate(() => window.__mg.makeV1());
  out.v1 = { version: v1.version, stride: v1.stride, prims: v1.fp.prims, chunks: v1.fp.chunks, buddy: v1.fp.buddy, visited: v1.fp.visited.length };
  await p1.close();
  // 2. 版 2 の IndexedDB に版 1 のデータ
  const p2 = await ctx.newPage();
  await p2.goto(O.v2 + '/aquarium.html?' + Date.now());
  await ready(p2);
  await p2.evaluate(async () => { await window.__mg.wipe(); });
  await p2.reload();
  await ready(p2);
  await p2.evaluate(async (raw) => window.__mg.putCurrent(raw), v1.raw);
  await p2.reload();
  await ready(p2);
  out.idbMigrate = await p2.evaluate((fp) => ({ load: window.__aqua.save.loaded.status, restore: window.__aqua.save.restore, cmp: window.__mg.compare(fp) }), v1.fp);
  // 3. 版 2：掘る → 盛る → 盛った砂を掘る → また盛る、保存して読み込み直し
  out.order = await p2.evaluate(async () => {
    const a = window.__aqua, c = a.crab, w = a.world, fx = a.view.digFx;
    fx.budgetMs = 1e9;
    const go = (x, z, h) => { a.freeze = true; c.teleport(x, z); c.heading = h; a.camera.placeBehind(c); a.freeze = false; a.input.touchMove = { x: 0, y: 0 }; a.step(30); c.heading = h; };
    const hold = (tool, sec, aimY) => { c.tool = tool; a.dig = true; a.digAim = { x: 0, y: aimY ?? 0 }; a.step(Math.round(sec * 60)); a.dig = false; a.digAim = null; a.step(10); };
    go(-7.5, 1.0, Math.PI / 2);
    hold('dig', 1.5);            // 層 1：掘る
    c.sandHeld = Math.max(c.sandHeld, 2);
    hold('fill', 2.0, -0.4);     // 層 2：掘った穴へ盛る
    hold('dig', 1.0, -0.2);      // 層 3：盛った砂を掘る
    hold('fill', 1.5, -0.2);     // 層 4：また盛る
    fx.flushAll();
    const layers = new Set(w.dig.prims.map((p) => p.layer)).size;
    const fp = window.__mg.fingerprint();
    window.__fp2 = fp;
    a.save.saver.suspended = false;
    const ok = await a.save.saver.flush();
    return { ok, layers, prims: fp.prims, fills: fp.fills, sand: fp.sand, tool: fp.tool, fp };
  });
  const fp2 = out.order.fp;
  delete out.order.fp;
  await p2.reload();
  await ready(p2);
  out.orderReload = await p2.evaluate((fp) => ({ load: window.__aqua.save.loaded.status, version: window.__aqua.save.loaded.data?.version, cmp: window.__mg.compare(fp) }), fp2);
  // 4. 書き出し → 初期状態 → 読み込み
  const text = await p2.evaluate(() => window.__mg.exportText());
  out.file = { bytes: text.length, version: JSON.parse(text).version };
  await p2.evaluate(async () => { await window.__mg.wipe(); });
  await p2.reload();
  await ready(p2);
  out.file.emptyAfterWipe = await p2.evaluate(() => window.__aqua.save.loaded.status);
  out.file.import = await p2.evaluate(async (t) => window.__mg.importFile(t), text);
  await p2.reload();
  await ready(p2);
  out.file.reload = await p2.evaluate((fp) => ({ load: window.__aqua.save.loaded.status, cmp: window.__mg.compare(fp) }), fp2);
  // 5. 版 1 の書き出しファイル
  await p2.evaluate(async () => { await window.__mg.wipe(); });
  await p2.reload();
  await ready(p2);
  out.v1File = { import: await p2.evaluate(async (t) => window.__mg.importFile(t), v1.file) };
  await p2.reload();
  await ready(p2);
  out.v1File.reload = await p2.evaluate((fp) => ({ load: window.__aqua.save.loaded.status, cmp: window.__mg.compare(fp) }), v1.fp);
  await p2.evaluate(async () => { await window.__mg.wipe(); });
  await ctx.close();
  return out;
}
