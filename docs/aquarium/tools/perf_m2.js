// M2（天井歩き・砂の回収と再配置）の性能の比較（Playwright。browser_run_code_unsafe で fetch(url).then(eval) して (page) => …）。
// globalThis.__over = { hosts: [...]（交互に並べる：機械の負荷の揺れを打ち消す）, w, h, dsf, touch, throttle, seconds }。
// 実時間のループ（requestAnimationFrame）のまま、掘りながら進む（全ビルド）・砂を盛り続ける（盛れるビルドだけ）・天井を歩く（同）を
// seconds 秒ずつ行い、フレームの間隔（中央値・95%・最大）、区画の作り直し（1 区画の平均・最大・回数）、
// かき出し 1 回の時間（空洞の更新）・取り除いた / 足した砂の量を測る時間（M2 だけ）、三角形の数、JS のヒープ（Chromium の performance.memory）
async (page) => {
  const O = Object.assign({ hosts: ['http://localhost:5174', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5173'], w: 390, h: 844, dsf: 3, touch: true, throttle: 4, seconds: 6 }, globalThis.__over ?? {});
  const out = [];
  for (const host of O.hosts) {
    const ctx = await page.context().browser().newContext({ viewport: { width: O.w, height: O.h }, deviceScaleFactor: O.dsf, hasTouch: !!O.touch, isMobile: !!O.touch });
    const p = await ctx.newPage();
    await p.goto(host + '/aquarium.html?nosave&' + Date.now());
    await p.waitForFunction(() => window.__aqua && window.__aqua.camera, null, { timeout: 180000 });
    await p.evaluate(async () => { await fetch('http://localhost:5173/docs/aquarium/tools/climb_helpers.js?' + Date.now()).then((r) => r.text()).then(eval); });
    if (O.throttle > 1) {
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: O.throttle });
    }
    const run = (kind) => p.evaluate(([kind, secs]) => new Promise((res) => {
      const a = window.__aqua, c = a.crab, w = a.world, fx = a.view.digFx, inp = a.input;
      const m2 = c.tool !== undefined;
      if (!m2 && kind !== 'dig') return res(null);
      const s0 = { ...fx.stats }, d0 = { ...w.dig.stats };
      const place = (x, z, h) => { a.freeze = true; c.teleport(x, z); c.heading = h; a.camera.mode = 'adventure'; a.camera.placeBehind(c); a.freeze = false; inp.touchMove = { x: 0, y: 0 }; };
      let dir = null;
      if (kind === 'dig') { place(-4.6, 8.3, Math.PI / 2); dir = [1, 0]; if (m2) c.tool = 'dig'; }
      if (kind === 'fill') { place(-6, 2, Math.PI / 2); c.tool = 'fill'; c.sandHeld = 4; dir = [0.35, 0.25]; }
      if (kind === 'ceil') {
        // 洞窟のトンネルで天井へ回り込み、天井を前後に歩く
        place(-11.8, -1.45, 0);
        a.freeze = true; c.teleport(-11.8, -1.45, w.contactSurfaceBelow(-11.8, 2.4, -1.45) + 0.02); a.camera.placeBehind(c); a.freeze = false;
        a.camera.adventure.yaw = -Math.PI / 2;
      }
      const frames = [];
      let last = 0, t0 = 0, n = 0, maxMeasure = 0;
      const tick = (now) => {
        if (!t0) t0 = now;
        if (last) frames.push(now - last);
        last = now;
        n++;
        if (kind === 'ceil') {
          const t = (now - t0) / 1000;
          // 洞窟の横の壁へ押し続けて天井へ回り込み（ceiling_test と同じ）、天井の上で前後に歩く
          inp.touchMove = t < 1.5 ? __ct.axisFor(0, 1) : { x: 0, y: Math.sin(t * 1.3) > 0 ? 1 : -1 };
        } else {
          a.dig = n > 10;
          inp.touchMove = __ct.axisFor(dir[0], dir[1]);
        }
        if (m2) maxMeasure = Math.max(maxMeasure, c.sandStats.measureMs);
        if (now - t0 < secs * 1000) requestAnimationFrame(tick);
        else {
          a.dig = false; inp.touchMove = { x: 0, y: 0 };
          frames.sort((x, y) => x - y);
          const q = (f) => +frames[Math.min(frames.length - 1, Math.floor(frames.length * f))].toFixed(1);
          const rb = fx.stats.rebuilds - s0.rebuilds, rbMs = fx.stats.totalMs - s0.totalMs;
          const strokes = w.dig.stats.carves - d0.carves;
          res({
            frames: frames.length, med: q(0.5), p95: q(0.95), max: q(0.999),
            rebuilds: rb, chunkAvgMs: rb ? +(rbMs / rb).toFixed(2) : 0, chunkMaxMs: +fx.stats.maxMs.toFixed(1),
            strokes, strokeAvgMs: strokes ? +((w.dig.stats.carveMs - d0.carveMs) / strokes).toFixed(3) : 0,
            fills: m2 ? w.dig.stats.fills - d0.fills : null, measureMaxMs: m2 ? +maxMeasure.toFixed(2) : null,
            ceilT: m2 ? +c.ceilStats.invertedT.toFixed(2) : null,
            tris: a.view.stats.tris, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
          });
        }
      };
      requestAnimationFrame(tick);
    }), [kind, O.seconds]);
    const r = { host, dig: await run('dig'), fill: await run('fill'), ceil: await run('ceil') };
    out.push(r);
    await ctx.close();
  }
  return out;
}
