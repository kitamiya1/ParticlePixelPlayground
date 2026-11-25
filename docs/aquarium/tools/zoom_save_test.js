// ページの拡大の知らせ（AquaViewport.ts）の「保存して読み込み直す」「進捗を書き出す」と、保存の説明が実際の保存の状態と
// 一致するかの検証（Playwright + CDP。Chromium のスマホの模擬：390×844・タッチ）。
// ページの拡大は Emulation.setPageScaleFactor（2.2 倍）で作る。読み込み直したかは window.__mark が消えたかで見る。
// 1. 保存済み → 保存して読み込み直す（読み込み直す）
// 2. 未保存の変化あり → 保存してから読み込み直す（読み込み直した後に、その変化が残っている）
// 3. 保存に失敗（保存先の書き込みを失敗させる）→ 読み込み直さない・書き出し・もう一度押すと読み込み直す
// 4. 保存が終わらない（書き込みが返らない）→ 8 秒で諦めて読み込み直さない
// 5. 別のタブと競合 → 読み込み直さない・このタブの進捗を書き出し・もう一度押すと読み込み直す
// 6. ?nosave → 保存しないと出す・読み込み直さない・もう一度押すと読み込み直す
// 使い方：browser_run_code_unsafe で fetch(...).then(eval)。globalThis.__over = { dir, tag, shots } で保存先・画像名の頭を指定
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: null, tag: 'save', shots: true }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js?' + Date.now())).text())(O);
  const out = [];
  const errors = [];
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, acceptDownloads: true });
  const open = async (q) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${O.host}/aquarium.html?${q}&${Date.now()}`);
    await boot(p);
    return p;
  };
  const boot = async (p) => {
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 120000 });
    await p.waitForTimeout(300);
    await p.evaluate(() => { window.__mark = 1; });
  };
  const zoom = async (p) => {
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.2 });
    await p.waitForFunction(() => document.getElementById('zoom-fix')?.classList.contains('show'), null, { timeout: 5000 });
    await p.waitForTimeout(200);
  };
  const st = (p, label) => p.evaluate((label) => {
    const n = document.getElementById('zoom-fix'), a = window.__aqua;
    const sv = n.querySelector('[data-k="save"]'), rb = n.querySelector('[data-k="reload"]');
    return { label, alive: window.__mark === 1, shown: n.classList.contains('show'), kind: sv.dataset.state, text: sv.textContent, reload: rb.textContent, danger: rb.classList.contains('danger'), saver: a.save.saver.state, guard: { ...a.viewport.stats } };
  }, label);
  // 押して、読み込み直したか（load が来たか）を返す
  const tapReload = async (p, ms = 2500) => {
    const loaded = p.waitForEvent('load', { timeout: ms }).then(() => true, () => false);
    await p.locator('#zoom-fix [data-k="reload"]').tap();
    const r = await loaded;
    if (r) await boot(p);
    return r;
  };
  const tapExport = async (p) => {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), p.locator('#zoom-fix [data-k="export"]').tap()]);
    let text = '';
    for await (const c of await dl.createReadStream()) text += c;
    let format = null;
    try { format = JSON.parse(text).format; } catch { /* 下で失敗として出る */ }
    return { file: dl.suggestedFilename(), bytes: text.length, format };
  };
  const shot = async (p, name) => { if (O.shots && O.dir) await p.screenshot({ path: await shotPath(`${O.dir}/${O.tag}_${name}.jpg`), type: 'jpeg', quality: 80 }); };

  // ---- 1. 保存済み ----
  let p = await open('zs1');
  // 起動直後の発見（初めての場所）の保存まで終わらせてから
  await p.waitForTimeout(2500);
  await p.evaluate(async () => { await window.__aqua.save.saver.flush(); });
  await zoom(p);
  out.push(await st(p, '1. 保存済み'));
  await shot(p, 'saved');
  out.push({ label: '1. 押した', reloaded: await tapReload(p) });
  await p.close();

  // ---- 2. 未保存の変化あり → 保存してから読み込み直す ----
  p = await open('zs2');
  const pos2 = await p.evaluate(() => {
    const a = window.__aqua;
    a.crab.teleport(a.world.spawn.x + 2.5, a.world.spawn.z + 1.0);
    a.save.saver.markDirty();
    return { x: +a.crab.x.toFixed(2), z: +a.crab.z.toFixed(2) };
  });
  await zoom(p);
  out.push(await st(p, '2. 未保存の変化あり'));
  await shot(p, 'pending');
  const r2 = await tapReload(p);
  const after2 = await p.evaluate(() => ({ x: +window.__aqua.crab.x.toFixed(2), z: +window.__aqua.crab.z.toFixed(2) }));
  out.push({ label: '2. 押した', reloaded: r2, before: pos2, after: after2, kept: Math.hypot(after2.x - pos2.x, after2.z - pos2.z) < 0.6 });
  await p.close();

  // ---- 3. 保存に失敗 ----
  p = await open('zs3');
  await p.evaluate(() => {
    const a = window.__aqua;
    a.save.store.be.commit = async () => { throw new Error('テスト：保存先へ書けない'); };
    a.crab.teleport(a.world.spawn.x - 2, a.world.spawn.z);
    a.save.saver.markDirty();
  });
  await zoom(p);
  out.push(await st(p, '3. 失敗の前（未保存）'));
  out.push({ label: '3. 1 回目を押した', reloaded: await tapReload(p) });
  out.push(await st(p, '3. 1 回目の後'));
  await shot(p, 'error_held');
  out.push({ label: '3. 書き出す', ...(await tapExport(p)) });
  out.push(await st(p, '3. 書き出した後'));
  out.push({ label: '3. 2 回目を押した（保存せずに読み込み直す）', reloaded: await tapReload(p) });
  out.push({ label: '3. 読み込み直した後', restore: await p.evaluate(() => ({ fromJournal: window.__aqua.save.store.info.fromJournal })) });
  await p.close();

  // ---- 4. 保存が終わらない ----
  p = await open('zs4');
  await p.evaluate(() => {
    const a = window.__aqua;
    a.save.store.be.commit = () => new Promise(() => {});
    a.save.saver.markDirty();
  });
  await zoom(p);
  const t4 = Date.now();
  out.push({ label: '4. 押した（書き込みが返らない）', reloaded: await tapReload(p, 10500), ms: Date.now() - t4 });
  out.push(await st(p, '4. 待った後'));
  await p.close();

  // ---- 5. 別のタブと競合 ----
  p = await open('zs5');
  const other = await open('zs5b');
  await other.evaluate(async () => { const a = window.__aqua; a.crab.teleport(a.world.spawn.x + 1, a.world.spawn.z + 2); await a.save.saver.flush(); });
  await p.waitForFunction(() => !!window.__aqua.save.store.conflict, null, { timeout: 5000 });
  await zoom(p);
  out.push(await st(p, '5. 競合'));
  out.push({ label: '5. 1 回目を押した', reloaded: await tapReload(p) });
  out.push(await st(p, '5. 1 回目の後'));
  await shot(p, 'conflict_held');
  out.push({ label: '5. 書き出す', ...(await tapExport(p)) });
  out.push({ label: '5. 2 回目を押した', reloaded: await tapReload(p) });
  await other.close();
  await p.close();

  // ---- 6. ?nosave ----
  p = await open('nosave');
  await zoom(p);
  out.push(await st(p, '6. ?nosave'));
  out.push({ label: '6. 1 回目を押した', reloaded: await tapReload(p) });
  out.push(await st(p, '6. 1 回目の後'));
  await shot(p, 'nosave_held');
  out.push({ label: '6. 2 回目を押した', reloaded: await tapReload(p) });
  await p.close();

  out.push({ errors });
  await ctx.close();
  return out.map((r) => JSON.stringify(r)).join('\n');
}
