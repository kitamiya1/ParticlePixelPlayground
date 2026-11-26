// 各段階の保存・復元の簡単な確認（Playwright。fetch + eval して page を渡す）。新しい文脈（IndexedDB・localStorage は空）で
// 開き、掘る・移動する → 保存 → 読み込み直して、位置・掘った穴の数・手持ちの砂・カメラ・表示の設定（ppp-aquarium:ui）が
// 戻るかを調べる。O = { host }
async (page, O = {}) => {
  const host = O.host ?? 'http://localhost:5173';
  const ctx = await page.context().browser().newContext({ viewport: { width: 1000, height: 700 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  const open = async () => {
    await p.goto(`${host}/aquarium.html?${Date.now()}`);
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  };
  await open();
  const before = await p.evaluate(async () => {
    const A = window.__aqua;
    A.goto('burrow');
    A.freeze = false;
    A.dig = true;
    A.step(90);
    A.dig = false;
    A.step(30);
    // 表示の設定を変える（設定の欄の入力から）
    const sc = document.querySelector('#audio-panel [data-k="scale"]');
    const g = document.querySelector('#audio-panel [data-k="guides"]');
    if (g) { g.checked = true; g.dispatchEvent(new Event('change')); }
    if (sc) { sc.value = '90'; sc.dispatchEvent(new Event('input')); }
    const ok = await A.save.saver.flush();
    return { ok, x: +A.crab.x.toFixed(2), z: +A.crab.z.toFixed(2), prims: A.world.dig.count, sand: +A.crab.sandHeld.toFixed(3), cam: A.camera.mode, ui: localStorage.getItem('ppp-aquarium:ui') };
  });
  await open();
  const after = await p.evaluate(() => {
    const A = window.__aqua;
    return { status: A.save.loaded.status, x: +A.crab.x.toFixed(2), z: +A.crab.z.toFixed(2), prims: A.world.dig.count, sand: +A.crab.sandHeld.toFixed(3), cam: A.camera.mode,
      ui: localStorage.getItem('ppp-aquarium:ui'), guides: document.body.classList.contains('aqua-guides') };
  });
  await ctx.close();
  const ok = before.ok && after.status === 'ok' && Math.abs(before.x - after.x) < 0.05 && Math.abs(before.z - after.z) < 0.05 && before.prims === after.prims && before.prims > 0
    && Math.abs(before.sand - after.sand) < 1e-3 && before.cam === after.cam && before.ui === after.ui;
  return JSON.stringify({ ok, before, after, errs });
}
