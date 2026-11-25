// スナモグリの引っこ抜き〜同行の画面を撮る（Playwright。browser_run_code_unsafe の filename で実行）。
// globalThis.__over = { dir: 'docs/aquarium/<報告>', host? } で保存先を決める（out_guard.js：既にある画像の名前は使わない）。
// PC（960×600）とスマホの縦持ち（390×844、タッチ）で、同じ流れを __aqua.step で進めて撮る：
//   01 近づくと触角が見える → 02 調べる → 03 引っ張っている途中 → 04 抜けた瞬間 → 05 仲間になった → 06 同行で走る
async (page) => {
  const O = Object.assign({ host: 'http://localhost:5173', dir: null }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js?' + Date.now())).text())(O);
  const out = [];
  for (const dev of [{ tag: 'pc', viewport: { width: 960, height: 600 } }, { tag: 'mobile', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]) {
    const ctx = await page.context().browser().newContext({ viewport: dev.viewport, deviceScaleFactor: dev.deviceScaleFactor ?? 1, isMobile: !!dev.isMobile, hasTouch: !!dev.hasTouch });
    const p = await ctx.newPage();
    await p.goto(O.host + '/aquarium.html?' + Date.now());
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    await p.evaluate(async () => {
      await fetch('http://localhost:5173/docs/aquarium/tools/buddy_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
      document.getElementById('help').style.display = 'none';
      window.__aqua.freeze = true;
    });
    const shot = async (name, fn) => {
      const info = await p.evaluate(fn);
      await p.waitForTimeout(150);
      if (O.dir) await p.screenshot({ path: await shotPath(`${O.dir}/${dev.tag}-${name}.png`) });
      out.push({ dev: dev.tag, name, info });
    };
    // カメラ：カニの斜め後ろの上から、カニと巣穴が両方入る向き
    const cam = `const a = __aqua, c = a.crab, B = a.buddy; const camSet = (off, z, pi) => { a.camera.adventure.yaw = c.heading + Math.PI + off; a.camera.adventure.zoom = z; a.camera.adventure.pitch = pi; };`;
    await shot('01-peek', new Function(`${cam} c.teleport(B.burrow[0] + 1.5, B.burrow[2] - 0.2); c.heading = Math.atan2(B.burrow[0] - c.x, B.burrow[2] - c.z); a.camera.placeBehind(c); camSet(0.55, 1.8, 0.4); a.freeze = false; a.step(90); a.freeze = true; return { peek: +B.peek.toFixed(2) };`));
    await shot('02-examine', new Function(`${cam} c.teleport(B.burrow[0] + 0.85, B.burrow[2] - 0.15); c.heading = Math.atan2(B.burrow[0] - c.x, B.burrow[2] - c.z); camSet(0.8, 1.8, 0.4); a.freeze = false; a.step(40); a.act = true; a.step(3); a.act = false; a.step(20); a.freeze = true; return { examined: B.examined };`));
    await shot('03-pulling', new Function(`${cam} a.freeze = false; a.act = true; a.step(22); a.freeze = true; return { pull: +B.pull.toFixed(2), crab: c.state };`));
    await shot('04-pop', new Function(`${cam} a.freeze = false; let f = 0; while (B.state !== 'flying' && f < 120) { a.step(1); f++; } a.step(16); a.act = false; a.freeze = true; return { popFrames: f, state: B.state };`));
    await shot('05-joined', new Function(`${cam} a.freeze = false; let g = 0; while (B.state === 'flying' && g < 200) { a.step(1); g++; } a.step(30); { const dx = c.x - B.x, dz = c.z - B.z, l = Math.hypot(dx, dz) || 1; c.teleport(B.x + dx / l * 0.9, B.z + dz / l * 0.9); } c.heading = Math.atan2(B.x - c.x, B.z - c.z); camSet(1.25, 1.7, 0.35); a.step(30); a.freeze = true; return { found: B.found, flight: g, dist: +Math.hypot(B.x - c.x, B.z - c.z).toFixed(2) };`));
    await shot('06-follow', new Function(`${cam} a.toggleBuddy(); const r = __bd.route([[-6.5, 7.6], [-4.5, 6.4]], 2.4, false); c.heading = Math.atan2(B.x - c.x, B.z - c.z); camSet(1.2, 2.2, 0.4); a.freeze = false; a.step(12); a.freeze = true; return { mode: B.mode, dist: +Math.hypot(B.x - c.x, B.z - c.z).toFixed(2), inside: r.inside };`));
    await ctx.close();
  }
  return out;
}
