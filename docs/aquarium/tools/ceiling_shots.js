// 天井歩きの画面（main と比べる）。Playwright の browser_run_code_unsafe で、fetch(url).then(eval) して (page) => … として呼ぶ。
// globalThis.__over = { hosts: { before: 'http://localhost:5174', after: 'http://localhost:5173' }, dir: '保存先' } で上書きできる
// （保存先は既定 docs/aquarium/ceiling-sand/shots の絶対パス。out_guard.js で、既にある画像の名前には書かない）。
// 場面ごとに：位置へ移し、押す向きへ押し続け（天井へ着いたら止める・最大 secs 秒）、離して 0.8 秒待ってから撮る。
async (page) => {
  const O = Object.assign({ hosts: { before: 'http://localhost:5174', after: 'http://localhost:5173' }, dir: 'D:/AI-Projects/ParticlePixelPlayground/docs/aquarium/ceiling-sand/shots' }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js')).text())(O);
  const scenes = [
    { id: 'cave', at: [-11.8, -1.45], y: 2.4, camYaw: -Math.PI / 2 + 0.6, pitch: 0.2, zoom: 3.5, push: [0, 1], secs: 3 },
    { id: 'log', log: true, camYaw: 0.5, pitch: 0.15, zoom: 2.5, secs: 2 },
    { id: 'tunnel', at: [-4.6, 8.3], camYaw: -Math.PI / 2, pitch: 0.3, zoom: 3, push: [0, -1], dig: [Math.PI / 2, 5], secs: 3 },
    { id: 'pillar', at: [-3.3, -4.6], camYaw: Math.PI + 0.5, pitch: 0.25, zoom: 3.5, push: [0, -1], secs: 1.0, noStop: true },
  ];
  const views = [
    { id: 'pc', viewport: { width: 1280, height: 720 } },
    { id: 'mobile', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  ];
  const out = [];
  for (const v of views) {
    for (const [tag, host] of Object.entries(O.hosts)) {
      const ctx = await page.context().browser().newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor ?? 1 });
      const p = await ctx.newPage();
      await p.goto(host + '/aquarium.html?nosave&' + Date.now());
      await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
      await p.evaluate(async () => {
        await fetch('http://localhost:5173/docs/aquarium/tools/climb_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
        localStorage.setItem('ppp-aquarium:help', 'closed');
        window.__aqua.help?.close?.();
      });
      for (const S of scenes) {
        const info = await p.evaluate((S) => {
          const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input;
          a.view.digFx.budgetMs = 1e9;
          let push = S.push, at = S.at, y = S.y, camYaw = S.camYaw;
          if (S.log) {
            const A = w.landmarks.logA, B = w.landmarks.logB, ax = Math.atan2(B[0] - A[0], B[2] - A[2]);
            at = [(A[0] + B[0]) / 2, (A[2] + B[2]) / 2];
            y = (A[1] + B[1]) / 2 - 0.3;
            push = [Math.cos(ax), -Math.sin(ax)];
            camYaw = ax + Math.PI + S.camYaw;
          }
          a.freeze = true;
          c.teleport(at[0], at[1], y !== undefined ? w.contactSurfaceBelow(at[0], y, at[1]) + 0.02 : undefined);
          cam.mode = 'adventure';
          cam.placeBehind(c);
          cam.adventure.yaw = camYaw; cam.adventure.pitch = S.pitch; cam.adventure.zoom = S.zoom;
          a.freeze = false;
          inp.touchMove = { x: 0, y: 0 };
          a.step(30);
          if (S.dig) {
            const [hd, secs] = S.dig, hx = Math.sin(hd), hz = Math.cos(hd);
            c.heading = hd; a.dig = true; a.digAim = { x: 0, y: 0 };
            for (let i = 0; i < secs * 60; i++) { inp.touchMove = __ct.axisFor(hx, hz); a.step(1); }
            a.dig = false; a.digAim = null; inp.touchMove = { x: 0, y: 0 }; a.step(10); a.view.digFx.flushAll();
            for (let i = 0; i < 50; i++) { inp.touchMove = __ct.axisFor(-hx, -hz); a.step(1); }
            inp.touchMove = { x: 0, y: 0 }; a.step(20);
            cam.adventure.yaw = camYaw;
          }
          let minNy = 1;
          for (let i = 0; i < S.secs * 60; i++) {
            inp.touchMove = __ct.axisFor(push[0], push[1]);
            a.step(1);
            if (c.climbing) minNy = Math.min(minNy, c.climbN[1]);
            if (!S.noStop && c.climbing && c.climbN[1] < -0.92) break;
          }
          inp.touchMove = { x: 0, y: 0 };
          a.step(48);
          a.freeze = true;
          return { state: c.state, ny: +(c.climbing ? c.climbN[1] : c.groundN[1]).toFixed(2), minNy: +minNy.toFixed(2), pos: [c.x, c.y + c.radius, c.z].map((v) => +v.toFixed(2)) };
        }, S);
        await p.waitForTimeout(400);
        const file = await shotPath(`${O.dir}/${v.id}-${S.id}-${tag}.jpg`);
        await p.screenshot({ path: file, type: 'jpeg', quality: 82 });
        await p.evaluate(() => { window.__aqua.freeze = false; });
        out.push({ file, ...info });
      }
      await ctx.close();
    }
  }
  return out;
}
