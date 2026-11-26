// 砂の回収・再配置の画面（main と比べる）。Playwright の browser_run_code_unsafe で fetch(url).then(eval) して (page) => … として呼ぶ。
// globalThis.__over = { hosts: { before: 'http://localhost:5174', after: 'http://localhost:5173' }, dir: '保存先（絶対パス）' } で上書き。
// 場面（before = main は盛れないので、同じ所を掘るだけ / 何もしないで撮る）：
//   aim    … 盛るに切り替えて砂を狙っている（黄緑の輪・左上の「砂」の量・盛れる表示）。スマホは「盛る」の切り替えとボタン
//   mound  … 砂の広場に盛り続けた砂山（カニは砂山の手前）
//   climb  … 砂山の上に登ったカニ
//   tunnel … 掘ったトンネルの突き当たりを盛った砂で埋め戻した所（トンネルの中から）
//   glass  … ガラス際まで掘った巣穴の先を盛った砂で埋め戻し、ガラス越しに断面を見る
//   ng     … 縦の管のそばを狙う（赤い輪・盛れない理由）
async (page) => {
  const O = Object.assign({ hosts: { before: 'http://localhost:5174', after: 'http://localhost:5173' }, dir: 'D:/AI-Projects/ParticlePixelPlayground/docs/aquarium/ceiling-sand/shots' }, globalThis.__over ?? {});
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js')).text())(O);
  const views = [
    { id: 'pc', viewport: { width: 1280, height: 720 } },
    { id: 'mobile', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  ];
  const scenes = ['aim', 'mound', 'climb', 'tunnel', 'glass', 'ng'];
  const out = [];
  for (const v of views) {
    for (const [tag, host] of Object.entries(O.hosts)) {
      const ctx = await page.context().browser().newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor ?? 1 });
      const p = await ctx.newPage();
      await p.addInitScript(() => localStorage.setItem('ppp-aquarium:help', 'closed'));
      await p.goto(host + '/aquarium.html?nosave&' + Date.now());
      await p.waitForFunction(() => window.__aqua && window.__aqua.camera, null, { timeout: 180000 });
      await p.evaluate(async () => {
        await fetch('http://localhost:5173/docs/aquarium/tools/climb_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
      });
      for (const sc of scenes) {
        const info = await p.evaluate((sc) => {
          const a = window.__aqua, c = a.crab, w = a.world, cam = a.camera, inp = a.input, fx = a.view.digFx;
          const canFill = c.tool !== undefined;
          fx.budgetMs = 1e9;
          a.freeze = false;
          const steps = (n, fn) => { for (let i = 0; i < n; i++) { fn?.(i); a.step(1); } };
          const go = (x, z, h, yaw, pitch = 0.3, zoom = 3.2) => {
            a.freeze = true; c.teleport(x, z); c.heading = h; cam.mode = 'adventure'; cam.placeBehind(c);
            cam.adventure.yaw = yaw ?? h + Math.PI + 0.45; cam.adventure.pitch = pitch; cam.adventure.zoom = zoom;
            a.freeze = false; inp.touchMove = { x: 0, y: 0 }; steps(30); c.heading = h;
          };
          const setTool = (t) => { if (canFill && c.tool !== t) document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG' })), document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyG' })); if (canFill) c.tool = t; };
          const hold = (secs, aim, move) => {
            a.dig = true; a.digAim = aim ? { x: aim[0], y: aim[1] } : null;
            steps(Math.round(secs * 60), () => { if (move) inp.touchMove = __ct.axisFor(move[0], move[1]); });
            a.dig = false; a.digAim = null; inp.touchMove = { x: 0, y: 0 }; steps(6);
          };
          const fill = (secs, aim) => { if (!canFill) return; setTool('fill'); c.sandHeld = Math.max(c.sandHeld, 3.5); hold(secs, aim); setTool('dig'); };
          let keepDig = false;
          if (sc === 'aim') {
            go(-3.0, 1.5, Math.PI / 2, Math.PI / 2 + Math.PI + 0.6, 0.35, 3.0);
            if (canFill) { c.sandHeld = 2.6; setTool('fill'); }
            a.dig = true; steps(4); keepDig = true; // 照準を出したまま撮る（盛る前の 1 回目のかき出しの間に撮る）
          } else if (sc === 'mound') {
            go(-8, 0.5, Math.PI / 2);
            fill(6);
            steps(30);
          } else if (sc === 'climb') {
            go(-8.4, 0.5, Math.PI / 2, Math.PI / 2 + Math.PI + 0.9, 0.35, 3.4);
            steps(36, () => { inp.touchMove = __ct.axisFor(1, 0); });
            inp.touchMove = { x: 0, y: 0 }; steps(30);
          } else if (sc === 'tunnel') {
            go(-4.6, 7.6, Math.PI / 2);
            hold(5, null, [1, 0]);
            fx.flushAll();
            steps(40, () => { inp.touchMove = __ct.axisFor(-1, 0); });
            inp.touchMove = { x: 0, y: 0 }; steps(10);
            c.heading = Math.PI / 2;
            fill(3, [0, -0.2]);
            fx.flushAll();
            steps(75, () => { inp.touchMove = __ct.axisFor(-1, 0); });
            inp.touchMove = { x: 0, y: 0 }; steps(10);
            cam.adventure.yaw = -Math.PI / 2 + 0.25; cam.adventure.pitch = 0.45; cam.adventure.zoom = 2.2;
            steps(60);
          } else if (sc === 'glass') {
            go(-12.5, 7.2, 0);
            hold(6, null, [0, 1]);
            fx.flushAll();
            cam.placeBehind(c); steps(5);
            steps(45, () => { inp.touchMove = __ct.axisFor(0, -1); });
            inp.touchMove = { x: 0, y: 0 }; steps(10);
            c.heading = 0;
            fill(4, [0, -0.15]);
            fx.flushAll();
            steps(30, () => { inp.touchMove = __ct.axisFor(0, -1); });
            inp.touchMove = { x: 0, y: 0 }; steps(10);
            cam.mode = 'observe'; cam.faceNearestGlass(c);
            cam.observe.zoom = Math.min(cam.observe.zoom, 4.5);
            steps(40);
          } else if (sc === 'ng') {
            const col = w.stand.columns[0];
            go(col.x + col.r + 1.1, col.z, -Math.PI / 2, -Math.PI / 2 + Math.PI + 0.7, 0.35, 3.0);
            if (canFill) { c.sandHeld = 2.6; setTool('fill'); }
            a.dig = true; steps(4); keepDig = true;
          }
          a.freeze = true;
          if (keepDig) a.dig = false;
          return { state: c.state, fills: canFill ? w.dig.prims.filter((q) => q.fill).length : 0, sand: canFill ? +c.sandHeld.toFixed(2) : null, why: c.digAim.fillWhy ?? null, tool: c.tool ?? 'dig', pos: [c.x, c.y + c.radius, c.z].map((q) => +q.toFixed(2)) };
        }, sc);
        await p.waitForTimeout(350);
        const file = await shotPath(`${O.dir}/${v.id}-sand-${sc}-${tag}.jpg`);
        await p.screenshot({ path: file, type: 'jpeg', quality: 82 });
        await p.evaluate(() => { window.__aqua.freeze = false; });
        out.push({ file: file.split('/').pop(), ...info });
      }
      await ctx.close();
    }
  }
  return out;
}
