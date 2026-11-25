// スマホ入力の再現テスト（Playwright + CDP Input.dispatchTouchEvent = 実ブラウザのタッチ入力）。
// 各シナリオのあとに Input / TouchControls の状態と、数フレーム進めたときのカニ・カメラの動きを調べる。
async (page) => {
  // 設定（開発サーバーの touch_config.json { host }。基準のビルドと比べるときに host を替える）
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/touch_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  await cfgPage.close();
  const out = [];
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  // 指を離した通知（pointerup / pointercancel）を、ページのどの処理より先に握りつぶす仕掛け（WebKit の取りこぼしの模擬）
  await ctx.addInitScript(() => {
    window.__dropN = 0;
    const f = (e) => { if (e.pointerType === 'touch' && window.__dropN > 0) { window.__dropN--; e.stopImmediatePropagation(); } };
    window.addEventListener('pointerup', f, true);
    window.addEventListener('pointercancel', f, true);
  });
  const p = await ctx.newPage();
  const logs = [];
  p.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  p.on('pageerror', (e) => logs.push(String(e)));
  await p.goto((O.host ?? 'http://localhost:5173') + '/aquarium.html?nosave&' + Date.now());
  await p.waitForFunction(() => window.__aqua, null, { timeout: 120000 });
  const cdp = await ctx.newCDPSession(p);
  // 注意：touchEnd / touchCancel に渡す点は「離す指」（空なら全部）。touchStart / touchMove は押している全部の指
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) });
  const rect = async (sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
  const stick = await rect('#touch-ui .stick');
  const jump = await rect('#touch-ui .jump');
  const dig = await rect('#touch-ui .dig');
  const run = await rect('#touch-ui .run');
  const view = [200, 420];
  // ゲームは止めて（freeze）、入力だけを見る。検査ではループを 10 フレーム進めて動きを測る
  await p.evaluate(() => { const a = window.__aqua; a.freeze = true; a.goto('spawn'); });
  const state = (label) => p.evaluate((label) => {
    const a = window.__aqua, i = a.input;
    const s = { label, move: [+i.touchMove.x.toFixed(2), +i.touchMove.y.toFixed(2)], run: i.touchRun, jump: i.touchJump, dig: i.touchDig, viewTouches: i.touches ? i.touches.size : i.viewTouchCount, knob: document.querySelector('#touch-ui .knob').style.transform || '-', stickActive: document.querySelector('#touch-ui .stick').classList.contains('active') };
    // 指を離した状態で 10 フレーム進めて、カニが歩くか・カメラが回るか
    a.freeze = false;
    const c = a.crab, cam = a.camera;
    const x0 = c.x, z0 = c.z, yaw0 = cam.adventure.yaw, pitch0 = cam.adventure.pitch, zoom0 = cam.adventure.zoom;
    a.step(10, 1 / 60);
    s.walked = +Math.hypot(c.x - x0, c.z - z0).toFixed(3);
    s.yawMoved = +(cam.adventure.yaw - yaw0).toFixed(4);
    s.pitchMoved = +(cam.adventure.pitch - pitch0).toFixed(4);
    s.zoomMoved = +(cam.adventure.zoom - zoom0).toFixed(4);
    a.freeze = true;
    return s;
  }, label);
  const clean = (s) => !s.move[0] && !s.move[1] && !s.run && !s.jump && !s.dig && !s.viewTouches && !s.stickActive && s.walked < 0.01 && Math.abs(s.yawMoved) < 1e-4 && Math.abs(s.zoomMoved) < 1e-4;
  const record = async (label) => { await p.waitForTimeout(150); const s = await state(label); s.ok = clean(s); out.push(s); };
  // 指で 1 回の操作を「確実に」終わらせる（前のシナリオの残りを消す）
  const reset = async () => { await touch('touchCancel', []).catch(() => {}); await p.evaluate(() => { window.__aqua.input.consume(); }); };
  // ある pointerId の pointerup / pointercancel をページに届かなくする（WebKit で指を離した通知が失われる現象の模擬）
  const dropNextEnd = (n = 1) => p.evaluate((n) => { window.__dropN = n; }, n);
  const dropOff = () => p.evaluate(() => { window.__dropN = 0; });

  // 1. スティック：押す → 動かす → 離す（通常）
  await touch('touchStart', [[stick[0], stick[1], 1]]);
  await touch('touchMove', [[stick[0], stick[1] - 40, 1]]);
  out.push({ label: '1. スティック押下中', move: await p.evaluate(() => ({ ...window.__aqua.input.touchMove })) });
  await touch('touchEnd', []);
  await record('1. スティック 通常の終了');

  // 2. スティック中に画面ドラッグ（カメラ）→ スティックを先に離す → 画面の指を離す
  await touch('touchStart', [[stick[0], stick[1], 1]]);
  await touch('touchMove', [[stick[0] + 30, stick[1] - 30, 1]]);
  await touch('touchStart', [[stick[0] + 30, stick[1] - 30, 1], [view[0], view[1], 2]]);
  await touch('touchMove', [[stick[0] + 30, stick[1] - 30, 1], [view[0] + 40, view[1], 2]]);
  await touch('touchEnd', [[stick[0] + 30, stick[1] - 30, 1]]);
  out.push({ label: '2a. スティックだけ離した（画面の指は残る）', move: await p.evaluate(() => ({ ...window.__aqua.input.touchMove })), viewTouches: await p.evaluate(() => window.__aqua.input.viewTouchCount) });
  await touch('touchMove', [[view[0] + 60, view[1] + 10, 2]]);
  await touch('touchEnd', []);
  await record('2. スティック + カメラドラッグ（スティックを先に離す）');

  // 3. スティック + 掘る + ジャンプ → 逆順で離す
  await touch('touchStart', [[stick[0], stick[1], 1]]);
  await touch('touchMove', [[stick[0], stick[1] - 45, 1]]);
  await touch('touchStart', [[stick[0], stick[1] - 45, 1], [dig[0], dig[1], 2]]);
  await touch('touchStart', [[stick[0], stick[1] - 45, 1], [dig[0], dig[1], 2], [jump[0], jump[1], 3]]);
  out.push({ label: '3. 3 本指 押下中', st: await p.evaluate(() => { const i = window.__aqua.input; return { move: { ...i.touchMove }, dig: i.touchDig, jump: i.touchJump }; }) });
  await touch('touchEnd', [[jump[0], jump[1], 3]]);
  await touch('touchEnd', [[dig[0], dig[1], 2]]);
  out.push({ label: '3a. ジャンプ・掘るを離した（スティックは残る）', st: await p.evaluate(() => { const i = window.__aqua.input; return { move: { ...i.touchMove }, dig: i.touchDig, jump: i.touchJump }; }) });
  await touch('touchEnd', []);
  await record('3. スティック + 掘る + ジャンプ（逆順で離す）');

  // 4. 3 本指の途中で取り消し（着信・システムのジェスチャー）
  await touch('touchStart', [[stick[0], stick[1], 1]]);
  await touch('touchMove', [[stick[0] - 40, stick[1], 1]]);
  await touch('touchStart', [[stick[0] - 40, stick[1], 1], [run[0], run[1], 2]]);
  await touch('touchStart', [[stick[0] - 40, stick[1], 1], [run[0], run[1], 2], [view[0], view[1], 3]]);
  await touch('touchCancel', []);
  await record('4. 3 本指の途中で touchcancel');

  // 5. スティックの指を画面の端（外）まで動かして離す
  await touch('touchStart', [[stick[0], stick[1], 1]]);
  await touch('touchMove', [[stick[0] - 50, stick[1] + 20, 1]]);
  await touch('touchMove', [[0, 843, 1]]);
  await touch('touchMove', [[-30, 900, 1]]);
  await touch('touchEnd', []);
  await record('5. スティックを画面の端の外まで動かして離す');

  // 6. スティックの pointerup が失われる（WebKit の取りこぼしの模擬）→ 何もしない
  await dropNextEnd(1);
  await touch('touchStart', [[stick[0], stick[1], 1]]);
  await touch('touchMove', [[stick[0], stick[1] - 45, 1]]);
  await touch('touchEnd', []);
  await dropOff();
  await record('6. スティックの指を離した通知が失われた');
  // 6b. そのあともう一度スティックを操作できるか
  await touch('touchStart', [[stick[0], stick[1], 4]]);
  await touch('touchMove', [[stick[0] + 45, stick[1], 4]]);
  out.push({ label: '6b. 失われたあと再操作（押下中）', move: await p.evaluate(() => ({ ...window.__aqua.input.touchMove })) });
  await touch('touchEnd', []);
  await record('6c. 再操作のあと離す');
  await reset();

  // 7. 画面の指の pointerup が失われる → 次の 1 本指ドラッグがピンチ扱いになるか
  await dropNextEnd(1);
  await touch('touchStart', [[view[0], view[1], 5]]);
  await touch('touchMove', [[view[0] + 20, view[1], 5]]);
  await touch('touchEnd', []);
  await dropOff();
  await record('7. 画面ドラッグの指を離した通知が失われた');
  await p.evaluate(() => window.__aqua.input.consume());
  const yaw0 = await p.evaluate(() => window.__aqua.camera.adventure.yaw);
  const z0 = await p.evaluate(() => window.__aqua.camera.adventure.zoom);
  // （ループは止めていても毎フレーム consume するので、測る間だけ consume を止める）
  await p.evaluate(() => { const i = window.__aqua.input; i.__consume = i.consume; i.consume = () => {}; });
  await touch('touchStart', [[view[0], view[1] - 100, 6]]);
  for (let k = 1; k <= 5; k++) await touch('touchMove', [[view[0] + k * 20, view[1] - 100, 6]]);
  await p.evaluate(() => { const a = window.__aqua, i = a.input; i.consume = i.__consume; a.freeze = false; a.step(1, 1 / 60); a.freeze = true; });
  await touch('touchEnd', []);
  out.push({ label: '7b. 次の 1 本指ドラッグで視点が回るか', yawDelta: +(await p.evaluate(() => window.__aqua.camera.adventure.yaw) - yaw0).toFixed(3), zoomDelta: +(await p.evaluate(() => window.__aqua.camera.adventure.zoom) - z0).toFixed(3) });
  await record('7c. 終了後');
  await reset();

  // 8. ボタンの捕捉が失われ（lostpointercapture）、指がボタンの外で離れる
  await touch('touchStart', [[dig[0], dig[1], 7]]);
  await p.evaluate(() => { const b = document.querySelector('#touch-ui .dig'); for (let id = 0; id < 50; id++) { try { if (b.hasPointerCapture(id)) b.releasePointerCapture(id); } catch {} } });
  await touch('touchMove', [[view[0], view[1], 7]]);
  await touch('touchEnd', []);
  await record('8. 掘るボタンの捕捉が外れて、ボタンの外で指を離す');
  await reset();

  // 9. スティックの捕捉が外れ、画面の上で離す
  await touch('touchStart', [[stick[0], stick[1], 8]]);
  await touch('touchMove', [[stick[0], stick[1] - 45, 8]]);
  await p.evaluate(() => { const s = document.querySelector('#touch-ui .stick'); for (let id = 0; id < 50; id++) { try { if (s.hasPointerCapture(id)) s.releasePointerCapture(id); } catch {} } });
  await touch('touchMove', [[view[0], view[1], 8]]);
  await touch('touchEnd', []);
  await record('9. スティックの捕捉が外れて、画面の上で指を離す');
  await reset();

  // 10. ページが隠れる（visibilitychange / pagehide / blur）間に押していた
  await touch('touchStart', [[stick[0], stick[1], 9]]);
  await touch('touchMove', [[stick[0], stick[1] - 45, 9]]);
  await touch('touchStart', [[stick[0], stick[1] - 45, 9], [jump[0], jump[1], 10]]);
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await record('10. 押したままページが隠れた（その後 指の通知は来ない）');
  await p.evaluate(() => { delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await reset();

  // 11. 開始・終了の順序が入れ替わる（合成イベント：up が先・down が後、同じ id の down が 2 回）
  await p.evaluate(() => {
    const s = document.querySelector('#touch-ui .stick');
    const r = s.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ev = (type, id, x, y, el) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1 }));
    ev('pointerup', 31, cx, cy, s);
    ev('pointerdown', 31, cx, cy, s);
    ev('pointermove', 31, cx, cy - 45, s);
    ev('pointerdown', 31, cx, cy - 45, s);
    ev('pointerdown', 32, cx, cy, s);
    ev('pointerup', 31, cx, cy, s);
    ev('pointerup', 32, cx, cy, s);
  });
  await record('11. 合成：up が先、同じ id の down が 2 回、別の指が重なる');
  await reset();

  // 12. 2 本指ピンチの片方が取り消し → 残りの指でふつうに回せるか
  await touch('touchStart', [[150, 400, 11]]);
  await touch('touchStart', [[150, 400, 11], [250, 400, 12]]);
  await touch('touchMove', [[130, 400, 11], [270, 400, 12]]);
  await touch('touchEnd', [[130, 400, 11]]);
  await p.evaluate(() => { const i = window.__aqua.input; i.__consume = i.consume; i.consume = () => {}; i.dragDX = 0; i.wheel = 0; });
  await touch('touchMove', [[300, 400, 12]]);
  await p.waitForTimeout(100); // pointermove は次のフレームにまとめて届く
  out.push({ label: '12a. 残りの 1 本でドラッグ（回転になるか）', st: await p.evaluate(() => { const i = window.__aqua.input; const r = { dragDX: i.dragDX, wheel: +i.wheel.toFixed(2), viewTouches: i.viewTouchCount }; i.consume = i.__consume; i.consume(); return r; }) });
  await touch('touchEnd', []);
  await record('12. ピンチ → 片方を離す → 残りでドラッグ → 離す');

  // 13. スティックの指を離した通知が失われ、そのとき掘るボタンの指はまだ押している（一部だけ失われる）
  await touch('touchStart', [[stick[0], stick[1], 13]]);
  await touch('touchMove', [[stick[0], stick[1] - 45, 13]]);
  await touch('touchStart', [[stick[0], stick[1] - 45, 13], [dig[0], dig[1], 14]]);
  await dropNextEnd(1);
  await touch('touchEnd', [[stick[0], stick[1] - 45, 13]]);
  await dropOff();
  await p.waitForTimeout(150);
  out.push({ label: '13a. スティックだけ失われ、掘るは押したまま', st: await p.evaluate(() => { const i = window.__aqua.input; return { move: { ...i.touchMove }, dig: i.touchDig }; }) });
  await touch('touchEnd', []);
  await record('13b. 掘るの指も離す');

  // 14. マウスで視点をドラッグ中に、ウィンドウの外でボタンを離した（mouseup が届かない）→ ボタンを押さずに動かす
  await p.mouse.move(200, 300);
  await p.mouse.down();
  await p.mouse.move(240, 300, { steps: 4 });
  await p.evaluate(() => { const v = document.getElementById('view'); v.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 260, clientY: 300, buttons: 0, bubbles: true })); });
  await p.evaluate(() => { const i = window.__aqua.input; i.__consume = i.consume; i.consume = () => {}; i.dragDX = 0; });
  await p.evaluate(() => { const v = document.getElementById('view'); for (let k = 0; k < 5; k++) v.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 300 + k * 20, clientY: 300, buttons: 0, bubbles: true })); });
  out.push({ label: '14. マウスのボタンを離した通知が無いまま動かした', dragDX: await p.evaluate(() => { const i = window.__aqua.input; const d = i.dragDX; i.consume = i.__consume; i.consume(); return d; }), active: await p.evaluate(() => window.__aqua.input.activePointers ?? null) });
  await p.mouse.up();

  out.push({ recovered: await p.evaluate(() => window.__aqua.input.recovered ?? null), errors: logs });
  await ctx.close();
  // 結果を 1 行ずつにまとめる（ok = 指を離したあと入力が残らず、カニが歩かず、視点が動かない）
  return out.map((r) => r.ok === undefined ? JSON.stringify(r) : `${r.ok ? 'OK ' : 'NG '} ${r.label} | move=${r.move} run=${r.run} jump=${r.jump} dig=${r.dig} 画面の指=${r.viewTouches} 歩いた=${r.walked} 視点=${r.yawMoved}/${r.zoomMoved}`).join(' // ');
}
