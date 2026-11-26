// 第 5 段階の撮影（Playwright。fetch + eval して page を渡す）。O = { host, dir, tag, w, h, touch }
// 水草を挟んで引く（しなる → ちぎれる → かけらを運ぶ → 離して漂う）、エビを挟む、小石を挟んで泳ぐ、を順に撮る。
// catch_test.js（__ct5）・grab_helpers.js・climb_helpers.js を読み込む。画像は O.dir/<tag>-<n>-<名前>.jpg
async (page, O = {}) => {
  const host = O.host ?? 'http://localhost:5173';
  const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, hasTouch: !!O.touch, isMobile: !!O.touch });
  const p = await ctx.newPage();
  await p.goto(`${host}/aquarium.html?nosave&${Date.now()}`, { timeout: 120000 });
  await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  await p.evaluate(async (h) => {
    window.__aqua.help?.close?.();
    document.getElementById('help')?.classList.remove('show');
    for (const f of ['grab_helpers.js', 'climb_helpers.js', 'catch_test.js']) await fetch(h + '/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
  }, host);
  const tag = O.tag ?? 'pc';
  let n = 0;
  const out = [];
  const shot = async (name) => {
    await p.evaluate(() => (window.__aqua.freeze = true));
    await p.waitForTimeout(150);
    await p.screenshot({ path: `${O.dir}/${tag}-${++n}-${name}.jpg`, type: 'jpeg', quality: 80 });
    await p.evaluate(() => (window.__aqua.freeze = false));
  };
  // 水草：森のテープ状の葉の高い所を挟んで引く
  const info = await p.evaluate(() => {
    const a = window.__aqua, c = a.crab, T = a.plantField.table, i = __ct5.findPlant(0);
    const rx = T.root[i * 3], ry = T.root[i * 3 + 1], rz = T.root[i * 3 + 2];
    a.freeze = true;
    c.teleport(rx + 0.3, rz, ry + 0.05);
    c.heading = -Math.PI / 2;
    a.camera.adventure.yaw = Math.PI / 2 + 0.9;
    a.camera.adventure.pitch = 0.25;
    a.camera.adventure.zoom = 2.2;
    a.freeze = false;
    for (let k = 0; k < 20; k++) a.step(1);
    a.hold = true;
    for (let k = 0; k < 25; k++) { a.rig.armAim.y = 1; a.step(1); }
    return { held: a.grab.held?.name ?? null };
  });
  out.push('plant grab ' + JSON.stringify(info));
  await shot('plant-grab');
  const pull = async (frames) => p.evaluate((frames) => { const a = window.__aqua; for (let k = 0; k < frames; k++) { a.input.touchMove = __ct.axisFor(1, 0); a.step(1); } a.input.touchMove = { x: 0, y: 0 }; return { held: a.grab.held?.name ?? null, kind: a.grab.holding?.kind ?? 'creature', tension: +a.plantGrabR.stats.maxTension.toFixed(1) }; }, frames);
  out.push('pull ' + JSON.stringify(await pull(4)));
  await shot('plant-bend');
  out.push('pull ' + JSON.stringify(await pull(40)));
  await shot('plant-cut-carry');
  out.push('carry ' + JSON.stringify(await pull(50)));
  await shot('piece-carried');
  await p.evaluate(() => { const a = window.__aqua; a.hold = false; for (let k = 0; k < 90; k++) a.step(1); });
  await shot('piece-drifting');
  // エビ：住みかのエビの正面へ置いて挟む
  const sh = await p.evaluate(() => {
    const a = window.__aqua, c = a.crab;
    // 挟めるまで住みかを順に試す（近くに景色の小石があると、そちらを挟むことがある）
    for (const b of a.life.shrimp) {
      a.hold = false;
      a.grab.release();
      for (let k = 0; k < 5; k++) a.step(1);
      a.freeze = true;
      const hx = Math.sin(b.heading), hz = Math.cos(b.heading);
      c.teleport(b.x - hx * 0.32, b.z - hz * 0.32, b.y + 0.1);
      c.heading = Math.atan2(hx, hz);
      a.camera.adventure.zoom = 1.8;
      a.camera.adventure.pitch = 0.3;
      a.camera.placeBehind(c);
      a.camera.adventure.yaw = c.heading + Math.PI + 0.8;
      a.freeze = false;
      a.hold = true;
      for (let k = 0; k < 10; k++) { a.rig.armAim.y = -0.6; a.step(1); }
      if (a.grab.holdingCreature === a.lifeGrabR) {
        for (let k = 0; k < 25; k++) a.step(1);
        return { held: a.grab.held?.name ?? null, kicks: a.lifeGrabR.stats.kicks };
      }
    }
    return { held: null };
  });  out.push('shrimp ' + JSON.stringify(sh));
  await shot('shrimp-caught');
  await p.evaluate(() => { const a = window.__aqua; a.hold = false; a.step(20); });
  await ctx.close();
  return out.join('\n');
}
