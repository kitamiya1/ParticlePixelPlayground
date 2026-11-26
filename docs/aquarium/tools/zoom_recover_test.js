// ページの拡大からの復旧と小さな HUD の検証（Playwright + CDP。Chromium のスマホの模擬で、iOS Safari そのものではない）。
// - Emulation.setPageScaleFactor でページが拡大された状態を作る（模擬の間はスクリプトから倍率を戻せない = iPhone で
//   「元に戻す」が効かなかった状態に近い）
// - 確かめる：知らせ・ゲームの画面の置き直し（ボタンが見えている範囲の中）・スティックが効く・「元に戻す」が失敗を成功と
//   出さない・「このまま遊ぶ」と「直す」・「保存して開き直す」（URL を新しく開く・開き直した後の結果）・「新しいタブで開く」
//   （このタブは保存をやめる）・診断の記録・HUD の小さな表示と詳細の欄（縦・横・読み込み直し）
// 使い方：browser_run_code_unsafe で fetch(...).then(eval)。globalThis.__over = { dir, tag } で画像の保存先
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: null, tag: 'zr', shots: true }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch(`${O.host}/docs/aquarium/tools/out_guard.js`)).text())(O);
  const out = [];
  const logs = [];
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const watch = (p) => {
    p.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
    p.on('pageerror', (e) => logs.push(String(e)));
  };
  const ready = async (p) => {
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 120000 });
    await p.waitForTimeout(500);
  };
  const open = async (p, q = 'nosave') => {
    await p.goto(`${O.host}/aquarium.html?${q}&t=${Date.now()}`);
    await ready(p);
  };
  const shot = async (p, name) => { if (O.shots && O.dir) await p.screenshot({ path: await shotPath(`${O.dir}/${O.tag}_${name}.jpg`), type: 'jpeg', quality: 80 }); };
  const m = (p) => p.evaluate(() => {
    const a = window.__aqua, v = window.visualViewport;
    const R = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width) return null; return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
    const inVisual = (r) => !!r && r[0] >= v.offsetLeft - 1 && r[1] >= v.offsetTop - 1 && r[2] <= v.offsetLeft + v.width + 1 && r[3] <= v.offsetTop + v.height + 1;
    const z = document.getElementById('zoom-fix');
    const btns = ['stick', 'jump', 'dig', 'grab', 'run', 'cam'].map((k) => [k, inVisual(R(`#touch-ui .${k}`))]);
    return {
      scale: +v.scale.toFixed(3), vv: [Math.round(v.width), Math.round(v.height), Math.round(v.offsetLeft), Math.round(v.offsetTop)],
      pinned: document.documentElement.classList.contains('aqua-pinned'), pointerScale: a.input.pointerScale,
      notice: z.classList.contains('show') ? 'modal' : z.classList.contains('chip-only') ? 'chip' : 'none',
      res: z.querySelector('[data-k="res"]').textContent, sv: z.querySelector('[data-k="save"]').textContent.slice(0, 60),
      btnsVisible: btns.filter(([, ok]) => ok).length + '/' + btns.length, hud: R('#hud'), menu: R('#menu'), inVisualHud: inVisual(R('#hud')),
      canvas: [document.getElementById('view').clientWidth, document.getElementById('view').clientHeight],
      stats: { ...a.viewport.stats }, log: a.viewport.logText().split('\n').filter((l) => !l.startsWith('  ')).slice(0, 4),
    };
  });
  const check = (name, ok, info) => out.push({ name, ok: !!ok, info });

  // ===== 1. HUD：縦・横の小さな表示と詳細の欄（覚える） =====
  const p = await ctx.newPage();
  watch(p);
  await p.goto(`${O.host}/aquarium.html?nosave&t=${Date.now()}`);
  await ready(p);
  await p.evaluate(() => { localStorage.removeItem('ppp-aquarium:hud'); localStorage.removeItem('ppp-aquarium:vplog'); localStorage.setItem('ppp-aquarium:help', 'closed'); });
  await open(p);
  const hud0 = await p.evaluate(() => { const r = document.getElementById('hud').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), detail: document.getElementById('hud-detail').classList.contains('show'), text: document.getElementById('hud').innerText.replace(/\n/g, ' | ') }; });
  check('縦：HUD は小さい（高さ 40 px 以下・詳細は閉じている）', hud0.h <= 40 && !hud0.detail, hud0);
  await shot(p, 'portrait_compact');
  await p.tap('#hud .hud-more');
  await p.waitForTimeout(300);
  const det = await p.evaluate(() => { const d = document.getElementById('hud-detail'); const r = d.getBoundingClientRect(); const st = document.querySelector('#touch-ui .stick').getBoundingClientRect(); return { show: d.classList.contains('show'), bottom: Math.round(r.bottom), stickTop: Math.round(st.top), text: d.innerText.slice(0, 160), ls: localStorage.getItem('ppp-aquarium:hud') }; });
  check('縦：詳細の欄が開き、スティックに掛からない・覚える', det.show && det.bottom <= det.stickTop && det.ls === 'detail', det);
  await shot(p, 'portrait_detail');
  await p.reload();
  await ready(p);
  const det2 = await p.evaluate(() => document.getElementById('hud-detail').classList.contains('show'));
  check('読み込み直しても詳細の欄が開いたまま', det2, det2);
  await p.setViewportSize({ width: 844, height: 390 });
  await p.waitForTimeout(800);
  const detL = await p.evaluate(() => { const d = document.getElementById('hud-detail').getBoundingClientRect(); const st = document.querySelector('#touch-ui .stick').getBoundingClientRect(); return { bottom: Math.round(d.bottom), h: Math.round(d.height), stickTop: Math.round(st.top) }; });
  check('横：詳細の欄がスティックに掛からない', detL.bottom <= detL.stickTop + 1, detL);
  await shot(p, 'landscape_detail');
  await p.tap('#hud-detail .hd-close');
  await p.waitForTimeout(300);
  const hudL = await p.evaluate(() => { const r = document.getElementById('hud').getBoundingClientRect(); const mr = document.getElementById('menu').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), menuLeft: Math.round(mr.left), detail: document.getElementById('hud-detail').classList.contains('show'), ls: localStorage.getItem('ppp-aquarium:hud') }; });
  check('横：×で閉じ、HUD は 1 行・右上のメニューと重ならない', !hudL.detail && hudL.h <= 40 && hudL.right < hudL.menuLeft && hudL.ls === 'compact', hudL);
  await shot(p, 'landscape_compact');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(600);

  // ===== 2. 拡大：知らせ・置き直し・スティック =====
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.2 });
  await p.waitForTimeout(1200);
  const z1 = await m(p);
  check('拡大 2.2：知らせが出て、ゲームの画面を置き直す（ボタンが見えている範囲の中）', z1.notice === 'modal' && z1.pinned && z1.btnsVisible === '6/6' && z1.inVisualHud, z1);
  await shot(p, 'zoomed_notice');
  // 元に戻す：iPhone で効かなかった状態を作る（viewport の設定の書き換えを効かなくする。Chromium では書き換えで倍率が戻るため）。
  // 失敗を失敗と出すか
  await p.evaluate(() => {
    const mt = document.querySelector('meta[name="viewport"]');
    Object.defineProperty(mt, 'content', { configurable: true, get: () => mt.getAttribute('content'), set: () => {} });
    document.querySelector('#zoom-fix [data-k="reset"]').click();
  });
  await p.waitForTimeout(1800);
  const z2 = await m(p);
  check('元に戻す：戻らなければ ✗ と出し、知らせを消さない', z2.notice === 'modal' && z2.res.startsWith('✗') && z2.stats.resetOk === 0, z2);
  await shot(p, 'reset_failed');
  // このまま遊ぶ → 小さな「直す」。スティックが効く（指の座標の倍率を直している）
  await p.evaluate(() => document.querySelector('#zoom-fix [data-k="keep"]').click());
  await p.waitForTimeout(400);
  const sr = await p.evaluate(() => { const r = document.querySelector('#touch-ui .stick').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width]; });
  // setPageScaleFactor の模擬では、CDP のタッチの座標はレイアウトの座標で届く（試して確かめた）。
  // 画面の上で指を 60 px 動かす = レイアウトでは 60 / 倍率
  const k = z1.scale;
  const before = await p.evaluate(() => ({ x: __aqua.crab.x, z: __aqua.crab.z }));
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2] ?? 1, radiusX: 4, radiusY: 4, force: 1 })) });
  await touch('touchStart', [[sr[0], sr[1]]]);
  await touch('touchMove', [[sr[0], sr[1] - 30 / k]]);
  await touch('touchMove', [[sr[0], sr[1] - 60 / k]]);
  await p.waitForTimeout(100);
  const stickVal = await p.evaluate(() => ({ ...__aqua.input.touchMove }));
  await p.waitForTimeout(700);
  await touch('touchEnd', []);
  const after = await p.evaluate(() => ({ x: __aqua.crab.x, z: __aqua.crab.z }));
  const z3 = await m(p);
  check('このまま遊ぶ：小さな「直す」だけ残し、スティックを 60 px 倒すと最大（約 1）まで効いてカニが動く', z3.notice === 'chip' && stickVal.y > 0.9 && Math.hypot(after.x - before.x, after.z - before.z) > 0.2, { stickVal, moved: Math.hypot(after.x - before.x, after.z - before.z).toFixed(2), notice: z3.notice });
  await shot(p, 'zoomed_keep_playing');
  await p.evaluate(() => document.querySelector('#zoom-fix .chip').click());
  await p.waitForTimeout(300);
  check('「直す」で知らせが戻る', (await m(p)).notice === 'modal', null);

  // ===== 3. 保存して開き直す（?nosave：1 回目は開き直さない → 2 回目で開き直す。URL を新しく開く） =====
  await p.evaluate(() => document.querySelector('#zoom-fix [data-k="reopen"]').click());
  await p.waitForTimeout(400);
  const z4 = await m(p);
  check('?nosave：1 回目は開き直さず、理由を出す', z4.res.startsWith('このタブは保存していません') && z4.notice === 'modal', z4.res);
  const nav = p.waitForEvent('framenavigated', { timeout: 10000 }).catch(() => null);
  await p.evaluate(() => document.querySelector('#zoom-fix [data-k="reopen"]').click());
  await nav;
  await ready(p);
  await p.waitForTimeout(1200);
  const z5 = await m(p);
  const url5 = p.url();
  // Chromium では新しく開くと模擬の倍率が 1 に戻る。測った倍率と、知らせ・記録の結果が合っているか
  const okAfter = z5.scale <= 1.02;
  check('開き直した後：URL の印を消し、測った倍率どおりに結果を記録する（正常なら知らせなし／残れば ✗）',
    !url5.includes('reopen=') && z5.log[0]?.includes(okAfter ? '開き直した後：正常' : '開き直した後：拡大が残る') && (okAfter ? z5.notice === 'none' : z5.res.startsWith('✗')), { url: url5, scale: z5.scale, res: z5.res, log: z5.log });
  await shot(p, 'after_reopen');
  // 開き直した先でもう一度拡大 → 開き直しても拡大が残る場合（iPhone で起こりうる）の表示を作る
  const cdpB = await ctx.newCDPSession(p);
  await cdpB.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.2 });
  await p.waitForTimeout(1200);
  check('開き直した先でも拡大を検出して知らせる', (await m(p)).notice === 'modal', null);
  // 拡大が解けた：知らせを消して「戻りました」・記録
  await cdpB.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await p.waitForTimeout(900);
  const z6 = await m(p);
  check('倍率が戻ったら知らせを消し、置き直しをやめる', z6.notice === 'none' && !z6.pinned && z6.pointerScale === 1 && z6.log.some((l) => l.includes('拡大が終わった')), z6);
  await shot(p, 'restored');

  // ===== 4. 保存あり：保存して新しいタブで開く（このタブは保存をやめる） =====
  const p2 = await ctx.newPage();
  watch(p2);
  await open(p2, 'zoomrecover');
  await p2.evaluate(async () => { const a = __aqua; a.crab.teleport(a.world.spawn.x + 1.2, a.world.spawn.z + 0.5); await a.save.saver.flush(); a.crab.teleport(a.world.spawn.x - 1.4, a.world.spawn.z + 0.9); a.save.saver.markDirty(); });
  const cdp2 = await ctx.newCDPSession(p2);
  await cdp2.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.0 });
  await p2.waitForTimeout(1200);
  const want = await p2.evaluate(() => ({ x: +__aqua.crab.x.toFixed(2), z: +__aqua.crab.z.toFixed(2) }));
  const popup = ctx.waitForEvent('page', { timeout: 10000 });
  await p2.evaluate(() => document.querySelector('#zoom-fix [data-k="tab"]').click());
  const p3 = await popup;
  watch(p3);
  await p3.waitForURL(/aquarium\.html/, { timeout: 15000 });
  await ready(p3);
  await p3.waitForTimeout(1200);
  const old = await p2.evaluate(() => ({ suspended: __aqua.save.saver.suspended, handed: document.getElementById('zoom-fix').classList.contains('handed'), msg: document.querySelector('#zoom-fix [data-k="msg"]').textContent }));
  const got = await p3.evaluate(() => ({ x: +__aqua.crab.x.toFixed(2), z: +__aqua.crab.z.toFixed(2), url: location.href, log: __aqua.viewport.logText().split('\n').filter((l) => !l.startsWith('  ')).slice(0, 3) }));
  check('新しいタブ：保存してから開き、未保存だった位置が新しいタブに残る・前のタブは保存をやめる', old.suspended && old.handed && Math.abs(got.x - want.x) < 0.05 && Math.abs(got.z - want.z) < 0.05, { want, got, old });
  await shot(p2, 'handed_off');
  await p3.close();
  await p2.evaluate(async () => { await new Promise((r) => { const q = indexedDB.deleteDatabase('ppp-aquarium'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); });
  await p2.close();
  await ctx.close();
  return { pass: out.filter((o) => o.ok).length + '/' + out.length, out, logs: logs.slice(0, 10) };
}
