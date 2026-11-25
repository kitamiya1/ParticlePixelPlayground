// 性能の比較（Playwright。browser_run_code_unsafe で実行。設定は perf_config.json { hosts, w, h, dsf, touch, seconds }）。
// 各ビルド（hosts）で、同じ場所・同じ視点に置いてから実時間のループ（requestAnimationFrame）を seconds 秒まわし、
// フレームの間隔（中央値・95%）・FPS・描画の CPU 時間（view.render）・GPU 待ち（render 直後の gl.finish）・
// カメラ更新（camera.update）・掘った区画の作り直し（digFx の 1 フレームの時間）を測る。
// GPU 待ちを測るフレームは 4 フレームに 1 回だけ（finish は処理を止めるので、FPS には影響させない）。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/perf_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  await cfgPage.close();
  const out = {};
  for (const host of O.hosts) {
    const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, deviceScaleFactor: O.dsf ?? 1, hasTouch: !!O.touch, isMobile: !!O.touch });
    const p = await ctx.newPage();
    await p.goto(host + '/aquarium.html?' + Date.now());
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    if (O.throttle > 1) {
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: O.throttle });
    }
    await p.evaluate(() => {
      const a = window.__aqua;
      document.getElementById('help')?.classList.add('fade');
      const gl = a.view.renderer.getContext();
      const M = (a.__perf = { frames: [], cpu: [], gpu: [], cam: [], dig: [], k: 0, on: false, last: 0 });
      const r0 = a.view.render.bind(a.view);
      a.view.render = (...args) => {
        const t0 = performance.now();
        r0(...args);
        const t1 = performance.now();
        if (!M.on) return;
        M.cpu.push(t1 - t0);
        M.dig.push(a.view.digFx.stats.frameMs);
        if (++M.k % 4 === 0) {
          gl.finish();
          M.gpu.push(performance.now() - t1);
        }
        if (M.last) M.frames.push(t0 - M.last);
        M.last = t0;
      };
      const c0 = a.camera.update.bind(a.camera);
      a.camera.update = (...args) => {
        const t0 = performance.now();
        c0(...args);
        if (M.on) M.cam.push(performance.now() - t0);
      };
      a.__run = (n, fn) => { a.freeze = false; for (let i = 0; i < n; i++) { fn?.(i); a.step(1, 1 / 60); } };
    });
    const res = {};
    for (const s of O.scenes) {
      await p.evaluate((s) => {
        const a = window.__aqua, c = a.crab, M = a.__perf;
        M.on = false;
        if (s.dig) {
          c.teleport(s.dig.at[0], s.dig.at[1]);
          c.heading = s.dig.heading;
          a.__run(20);
          a.dig = true;
          a.__run(Math.round(s.dig.seconds * 60), () => { const yaw = a.camera.yaw, hd = s.dig.heading; a.input.touchMove = { x: Math.sin(hd) * Math.cos(yaw) - Math.cos(hd) * Math.sin(yaw), y: -Math.sin(hd) * Math.sin(yaw) - Math.cos(hd) * Math.cos(yaw) }; });
          a.dig = false;
          a.input.touchMove = { x: 0, y: 0 };
          a.view.digFx.flushAll();
        }
        if (s.goto) a.goto(s.goto);
        if (s.at) c.teleport(s.at[0], s.at[2], s.at[1]);
        if (s.heading !== undefined) c.heading = s.heading;
        a.__run(30);
        a.camera.placeBehind(c);
        const o = a.camera.adventure;
        o.yaw = c.heading + Math.PI + (s.yaw ?? 0.3);
        o.pitch = s.pitch ?? 0.3;
        o.zoom = 3.2;
        a.__run(60);
        a.freeze = false;
        a.input.touchMove = { x: 0, y: 0 };
        // 視点をゆっくり回し続ける（カメラの遮蔽処理が毎フレーム働く状態で測る）
        a.__spin = setInterval(() => { o.yaw += 0.02; }, 16);
        M.frames = []; M.cpu = []; M.gpu = []; M.cam = []; M.dig = []; M.last = 0; M.k = 0;
        M.on = true;
      }, s);
      await p.waitForTimeout((O.seconds ?? 4) * 1000);
      res[s.name] = await p.evaluate(() => {
        const a = window.__aqua, M = a.__perf;
        M.on = false;
        clearInterval(a.__spin);
        const q = (arr, f) => { if (!arr.length) return 0; const b = [...arr].sort((x, y) => x - y); return +b[Math.min(b.length - 1, Math.floor(b.length * f))].toFixed(2); };
        const avg = (arr) => +(arr.reduce((x, y) => x + y, 0) / Math.max(1, arr.length)).toFixed(3);
        return { fps: +(1000 / (M.frames.reduce((x, y) => x + y, 0) / Math.max(1, M.frames.length))).toFixed(1), frameMed: q(M.frames, 0.5), frameP95: q(M.frames, 0.95), cpuMed: q(M.cpu, 0.5), gpuWaitMed: q(M.gpu, 0.5), camAvg: avg(M.cam), camP95: q(M.cam, 0.95), digFrameMax: q(M.dig, 1), n: M.frames.length };
      });
    }
    out[host] = res;
    await ctx.close();
  }
  return out;
}
