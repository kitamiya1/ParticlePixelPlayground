// ガラス際の掘削の負荷（Playwright。browser_run_code_unsafe で実行。設定は glass_perf_config.json。globalThis.__over で上書き）。
// ビルド（hosts）ごと・回（rounds）ごとに新しいページで、実時間のループのまま（freeze しない）次の場面を測る：
//   dig    ：ふつうの掘削（水槽の中ほどの砂地で、掘る向きへ進み続ける）
//   glass  ：ガラス際の掘削（ガラスへ向かって掘り、ガラスに沿って掘る）
//   observe：glass の後、ガラス越しのカメラで視点を回しながら見る（作り直しが終わった後の描画）
// 場面ごとに：フレームの間隔（中央値・P95・最大）・FPS・区画 1 つの作り直しの時間（ガラスに接する区画 / それ以外。平均・最大・数）・
// 1 フレームの作り直しの時間（digFx.stats.frameMs の P95・最大）。CPU を throttle 倍遅くし、スマホの画面（w × h、dsf 倍）で。
// rounds が 2 以上なら、ビルドの順番を回ごとに入れ替える（機械の負荷の揺れを平均する）。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/glass_perf_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  await cfgPage.close();
  const out = {};
  const rounds = O.rounds ?? 1;
  for (let r = 0; r < rounds; r++) {
    const hosts = r % 2 === 0 ? O.hosts : [...O.hosts].reverse();
    for (const host of hosts) {
      const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 390, height: O.h ?? 844 }, deviceScaleFactor: O.dsf ?? 3, hasTouch: true, isMobile: true });
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(String(e)));
      await p.goto(host + '/aquarium.html?' + Date.now());
      await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
      if (O.throttle > 1) {
        const cdp = await ctx.newCDPSession(p);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: O.throttle });
      }
      await p.evaluate(async () => {
        await fetch('http://localhost:5173/docs/aquarium/tools/climb_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
        const a = window.__aqua, w = a.world, fx = a.view.digFx;
        document.getElementById('help')?.classList.add('fade');
        const M = (a.__gp = { frames: [], dig: [], edge: [], inner: [], on: false, last: 0, dir: null, yawSpin: 0 });
        const b0 = fx.build.bind(fx);
        fx.build = (id) => {
          const t = performance.now();
          b0(id);
          if (!M.on) return;
          const i = id % w.dig.ncx, j = Math.floor(id / w.dig.ncx);
          (i === 0 || j === 0 || i === w.dig.ncx - 1 || j === w.dig.ncz - 1 ? M.edge : M.inner).push(performance.now() - t);
        };
        const loop = (t) => {
          if (M.on) {
            if (M.last) M.frames.push(t - M.last);
            M.dig.push(fx.stats.frameMs);
            if (M.dir) a.input.touchMove = window.__ct.axisFor(M.dir[0], M.dir[1]);
            if (M.yawSpin) a.camera.observe.yaw += M.yawSpin / 60;
          }
          M.last = t;
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      const res = {};
      const measure = async (name, setup, phases, arg) => {
        await p.evaluate(setup, arg);
        await p.waitForTimeout(600);
        await p.evaluate(() => { const M = window.__aqua.__gp; Object.assign(M, { frames: [], dig: [], edge: [], inner: [], on: true, last: 0 }); });
        for (const ph of phases) {
          await p.evaluate((ph) => { const a = window.__aqua, M = a.__gp; M.dir = ph.dir ?? null; if (!ph.dir) a.input.touchMove = { x: 0, y: 0 }; a.dig = !!ph.dig; M.yawSpin = ph.spin ?? 0; }, ph);
          await p.waitForTimeout(ph.t * 1000);
        }
        res[name] = await p.evaluate(() => {
          const a = window.__aqua, M = a.__gp;
          M.on = false; M.dir = null; a.dig = false; a.input.touchMove = { x: 0, y: 0 }; M.yawSpin = 0;
          const q = (l, k) => { const s = [...l].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * k))].toFixed(1) : 0; };
          const sm = (l) => ({ n: l.length, avg: +(l.reduce((x, y) => x + y, 0) / Math.max(1, l.length)).toFixed(2), max: +Math.max(0, ...l).toFixed(1) });
          const dur = M.frames.reduce((x, y) => x + y, 0);
          return { fps: +(M.frames.length / (dur / 1000)).toFixed(1), frameMed: q(M.frames, 0.5), frameP95: q(M.frames, 0.95), frameMax: q(M.frames, 1), digFrameP95: q(M.dig, 0.95), digFrameMax: q(M.dig, 1), edge: sm(M.edge), inner: sm(M.inner), prims: a.world.dig.count };
        });
      };
      for (const sc of O.scenes) {
        await measure(sc.name, (sc) => {
          const a = window.__aqua, c = a.crab;
          if (sc.at) { c.teleport(sc.at[0], sc.at[1]); c.heading = sc.heading ?? 0; a.camera.adventure.yaw = (sc.heading ?? 0) + Math.PI; }
          if (sc.mode === 'observe') { a.camera.mode = 'observe'; a.camera.faceNearestGlass?.(c); if (sc.zoom) a.camera.observe.zoom = sc.zoom; }
          else if (a.camera.mode !== 'adventure') a.camera.mode = 'adventure';
        }, sc.phases, sc);
      }
      res.errors = errs;
      (out[host] ??= []).push(res);
      await ctx.close();
    }
  }
  return out;
}
