// ページ自体の拡大（ブラウザのピンチ・ダブルタップ）と、ゲーム内カメラのズームを分けて測る検証
// （Playwright + CDP。Chromium のスマホの模擬：390×844・タッチ・isMobile。iOS Safari の WebKit そのものではない）。
// - Input.synthesizePinchGesture：ブラウザのピンチ（touch-action に従う。許された所ではページが拡大する）
// - Input.dispatchTouchEvent：指の押す・動かす・離す（ダブルタップ・3 本指）
// - Emulation.setPageScaleFactor：ページが拡大されてしまった状態を作る（症状の再現と、復旧の案内の確認）
// 各段階で visualViewport（scale・幅・高さ・offset）、innerWidth/Height、レイアウトの幅（clientWidth）、Canvas の実寸と
// 描画の画素数、操作ボタンの getBoundingClientRect、ゲーム内カメラの zoom を記録する。
// ?nosave で開く。最初に同じブラウザの中で通常のセーブを 1 つ作り、最後にそれが変わっていないかを確かめる。
// 使い方：browser_run_code_unsafe で fetch(...).then(eval)。globalThis.__over = { dir, tag, shots } で保存先・画像名の頭を指定
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: null, tag: 'run', shots: true }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js')).text())(O);
  const out = [];
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const logs = [];
  const open = async (p, q = 'nosave') => {
    await p.goto(`${O.host}/aquarium.html?${q}&${Date.now()}`);
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 120000 });
    await p.waitForTimeout(400);
  };

  // ---- 通常のセーブを 1 つ作る（?nosave 無し）→ 控えを取る ----
  const p0 = await ctx.newPage();
  await open(p0, 'zoomtest-normal');
  await p0.evaluate(async () => { const a = window.__aqua; a.crab.teleport(a.world.spawn.x + 1.5, a.world.spawn.z); await a.save.saver.flush(); });
  const readSave = (p) => p.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ppp-aquarium', 1);
    r.onsuccess = () => {
      const db = r.result;
      const st = db.transaction('saves', 'readonly').objectStore('saves');
      const all = st.getAll(), keys = st.getAllKeys();
      all.onsuccess = () => keys.onsuccess = () => res({ keys: keys.result.map(String), sig: JSON.stringify(all.result.map((d) => d && typeof d === 'object' ? [d.rev, d.savedAt, d.saveId, d.player && d.player.x] : d)), ls: Object.keys(localStorage).filter((k) => k.startsWith('ppp-aquarium:journal')).sort() });
      if (keys.readyState === 'done') keys.onsuccess();
    };
    r.onerror = () => res({ error: String(r.error) });
  }));
  // 閉じるときの保存（pagehide）まで終わらせてから、ゲームでないページで控えを取る
  await p0.close({ runBeforeUnload: true });
  const pq = await ctx.newPage();
  await pq.goto(`${O.host}/docs/aquarium/roadmap.md?${Date.now()}`);
  await pq.waitForTimeout(500);
  const save0 = await readSave(pq);
  await pq.close();

  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  p.on('pageerror', (e) => logs.push(String(e)));
  await open(p);
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) });
  const pinch = (x, y, scaleFactor) => cdp.send('Input.synthesizePinchGesture', { x, y, scaleFactor, relativeSpeed: 600, gestureSourceType: 'touch' }).catch((e) => ({ err: String(e) }));
  const m = (label) => p.evaluate((label) => {
    const a = window.__aqua, v = window.visualViewport, c = document.getElementById('view');
    const R = (s) => { const e = document.querySelector(s); if (!e || !e.offsetParent && getComputedStyle(e).position !== 'fixed') return null; const r = e.getBoundingClientRect(); if (!r.width) return null; return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
    const cr = c.getBoundingClientRect();
    const orb = a.camera[a.camera.mode];
    const el = document.getElementById('zoom-fix');
    return {
      label, scale: +v.scale.toFixed(3), vv: [Math.round(v.width), Math.round(v.height), Math.round(v.offsetLeft), Math.round(v.offsetTop)],
      inner: [window.innerWidth, window.innerHeight], layout: [document.documentElement.clientWidth, document.documentElement.clientHeight], scroll: [Math.round(scrollX), Math.round(scrollY)],
      canvas: [Math.round(cr.width), Math.round(cr.height), c.width, c.height], cam: `${a.camera.mode}:${orb.zoom.toFixed(2)}`,
      stick: R('#touch-ui .stick'), jump: R('#touch-ui .jump'), dig: R('#touch-ui .dig'), camBtn: R('#touch-ui .cam'), menu: R('#menu'), help: R('#help'),
      zoomFix: el ? el.classList.contains('show') : null, pointers: a.input.activePointers, viewTouches: a.input.viewTouchCount,
      guard: a.viewport ? { ...a.viewport.stats } : null,
    };
  }, label);
  const shot = async (name) => { if (O.shots && O.dir) await p.screenshot({ path: await shotPath(`${O.dir}/${O.tag}_${name}.jpg`), type: 'jpeg', quality: 80 }); };
  const rect = (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? [r.left + r.width / 2, r.top + r.height / 2] : null; }, sel);
  const settle = () => p.waitForTimeout(350);
  const resetScale = () => cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});

  out.push(await m('0. 起動直後（縦）'));
  await shot('portrait_start');

  // A. 画面（Canvas）の上で 2 本指ピンチ（広げる）：ページは拡大せず、カメラだけ寄るはず
  out.push({ label: 'A. Canvas でピンチ（広げる 2 倍）', r: await pinch(200, 300, 2) });
  await settle();
  out.push(await m('A. 後'));
  out.push({ label: 'A2. Canvas でピンチ（つまむ 0.5 倍）', r: await pinch(200, 300, 0.5) });
  await settle();
  out.push(await m('A2. 後'));
  await resetScale();

  // B. ダブルタップ（Canvas・左上の表示・説明の上）
  const dtap = async (x, y, id) => { for (let k = 0; k < 2; k++) { await touch('touchStart', [[x, y, id + k]]); await touch('touchEnd', []); await p.waitForTimeout(80); } };
  await dtap(200, 420, 100);
  await settle();
  out.push(await m('B1. Canvas でダブルタップ'));
  await dtap(60, 60, 110);
  await settle();
  out.push(await m('B2. 左上の表示でダブルタップ'));
  const helpC = await rect('#help');
  if (helpC) { await dtap(helpC[0], helpC[1], 120); await settle(); out.push(await m('B3. 説明の上でダブルタップ')); }
  await resetScale();

  // C. 説明の上でピンチ（説明が見えていれば）
  if (helpC) { out.push({ label: 'C. 説明の上でピンチ', r: await pinch(helpC[0], helpC[1], 2) }); await settle(); out.push(await m('C. 後')); await resetScale(); }

  // D. セーブのパネルを開いて、その上でピンチ（パネルは中でスクロールする要素）
  const saveBtn = await rect('#menu .menu-btn.save');
  await touch('touchStart', [[saveBtn[0], saveBtn[1], 130]]);
  await touch('touchEnd', []);
  await settle();
  const panelC = await rect('#save-panel');
  out.push({ label: 'D. セーブのパネル', open: !!panelC });
  if (panelC) {
    out.push({ label: 'D. パネルの上でピンチ（広げる）', r: await pinch(panelC[0], panelC[1], 2) });
    await settle();
    out.push(await m('D. 後'));
    await shot('save_panel_pinch');
    await dtap(panelC[0], panelC[1] + 40, 140);
    await settle();
    out.push(await m('D2. パネルの上でダブルタップ'));
  }
  await resetScale();
  await settle();
  await p.evaluate(() => window.__aqua.save.menu.toggle(false));

  // E. 3 本指で広げる（Canvas の上）
  await touch('touchStart', [[150, 380, 150]]);
  await touch('touchStart', [[150, 380, 150], [250, 380, 151]]);
  await touch('touchStart', [[150, 380, 150], [250, 380, 151], [200, 480, 152]]);
  for (let k = 1; k <= 6; k++) await touch('touchMove', [[150 - k * 10, 380 - k * 10, 150], [250 + k * 10, 380 - k * 10, 151], [200, 480 + k * 12, 152]]);
  await touch('touchEnd', []);
  await settle();
  out.push(await m('E. 3 本指で広げて離す'));

  // F. ページが拡大されてしまった状態（症状）。Canvas の上でつまんで戻せるか
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.2 });
  await p.waitForTimeout(800);
  out.push(await m('F. ページが 2.2 倍に拡大された状態'));
  await shot('zoomed_symptom');
  out.push({ label: 'F2. Canvas の中央でつまむ（0.4 倍）', r: await pinch(100, 200, 0.4) });
  await p.waitForTimeout(800);
  out.push(await m('F2. 後'));
  await shot('zoomed_after_pinch');
  // 案内の「元に戻す」（あれば）
  const fixShown = await p.evaluate(() => { const e = document.getElementById('zoom-fix'); return !!e && e.classList.contains('show'); });
  if (fixShown) {
    // 知らせを出している間は、知らせの上のピンチを止めない（さらに広げて倍率が変わるか。Emulation の倍率の上書きが効いている間は変わらないこともある）
    out.push({ label: 'F2b. 知らせの上で広げる（1.3 倍）', r: await pinch(88, 250, 1.3) });
    await p.waitForTimeout(600);
    out.push(await m('F2b. 後'));
    await p.locator('#zoom-fix [data-k="reset"]').tap();
    await p.waitForTimeout(900);
    out.push(await m('F3. 案内の「元に戻す」を押した後'));
    await shot('zoomfix_after_reset');
  }
  await resetScale();
  await p.waitForTimeout(500);
  out.push(await m('F4. 倍率 1 に戻った後'));

  // G. 画面の回転（横 → 縦）
  await p.setViewportSize({ width: 844, height: 390 });
  await p.waitForTimeout(900);
  out.push(await m('G. 横画面'));
  await shot('landscape');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(900);
  out.push(await m('G2. 縦画面へ戻す'));

  // H. ページの非表示と復帰（スティックを押したまま）
  const st = await rect('#touch-ui .stick');
  await touch('touchStart', [[st[0], st[1], 170]]);
  await touch('touchMove', [[st[0], st[1] - 40, 170]]);
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await p.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await touch('touchCancel', []).catch(() => {});
  await settle();
  out.push(await m('H. 隠れて戻った後'));
  out.push({ label: 'H. スティック', move: await p.evaluate(() => ({ ...window.__aqua.input.touchMove })) });

  await p.close();
  // ---- 通常のセーブが変わっていないか ----
  const p1 = await ctx.newPage();
  await p1.goto(`${O.host}/docs/aquarium/roadmap.md?${Date.now()}`);
  const save1 = await readSave(p1);
  out.push({ label: 'S. 通常のセーブ（?nosave の検証の前後）', same: save0.sig === save1.sig && JSON.stringify(save0.keys) === JSON.stringify(save1.keys) && JSON.stringify(save0.ls) === JSON.stringify(save1.ls), before: save0, after: save1 });
  out.push({ errors: logs });
  await ctx.close();
  return out.map((r) => JSON.stringify(r)).join('\n');
}
