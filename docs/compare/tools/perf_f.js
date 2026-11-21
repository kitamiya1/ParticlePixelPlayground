async (page) => {
  // 方式 F 画質改善の性能計測：設定ごとに、既存の比較ツール（ベンチマーク・ちらつき・隙間/重ね塗り）を F だけに絞って実行する。
  // - 設定は window.__defaults（起動直後の設定）+ 各条件の上書き。風 0。カメラは各視点の初期位置から（ベンチマークは回転し続ける）。
  // - ベンチマークは条件の順番を入れ替えながら REPS 回測り、GPU 時間の中央値も出す（実行ごとのぶれ対策）。
  // 結果は window.__perf に入れて返す。条件は window.__perfConfigs（[{ name, set }]）、視点は window.__perfViews。
  const REPS = 3;
  const run = (kind, methods) =>
    page.evaluate(async ({ kind, methods }) => {
      const p = window.__ppp;
      p.runTool(kind, methods);
      for (let i = 0; i < 3000 && !p.lastReport; i++) await new Promise((r) => setTimeout(r, 50));
      return p.lastReport;
    }, { kind, methods });
  const setup = (cfg, view) =>
    page.evaluate(async ({ cfg, view }) => {
      const p = window.__ppp;
      p.freeze = false;
      const help = document.getElementById('help');
      if (help) help.style.display = 'none';
      if (!window.__defaults) window.__defaults = JSON.parse(JSON.stringify(p.settings));
      Object.assign(p.settings, window.__defaults, { wind: 0, renderMethod: 'hybrid', viewMode: 'particles' }, cfg.set || {});
      const c = p.game.camera;
      const ch = p.game.character;
      c.yaw = 0.75; c.pitch = view.pitch ?? 0.6; c.zoom = view.zoom;
      c.target = { x: ch.x, y: ch.y + 0.6, z: ch.z };
      for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
    }, { cfg, view });
  const configs = await page.evaluate(() => window.__perfConfigs);
  const views = await page.evaluate(() => window.__perfViews);
  const out = { bench: [], flicker: [], gap: [] };
  for (let rep = 0; rep < REPS; rep++) {
    const order = rep % 2 ? [...configs].reverse() : configs;
    for (const view of views) for (const cfg of order) {
      await setup(cfg, view);
      const r = await run('benchmark', cfg.methods || ['hybrid']);
      for (const x of r?.results || []) out.bench.push({ rep, view: view.name, cfg: cfg.name, method: x.method, gpuMs: x.gpuMs, cpuMs: x.cpuMs, fps: x.fps, count: x.count, hybrid: x.hybrid });
    }
  }
  for (const view of views) for (const cfg of configs) {
    await setup(cfg, view);
    const f = await run('flicker', cfg.methods || ['hybrid']);
    for (const x of f?.results || []) out.flicker.push({ view: view.name, cfg: cfg.name, ...x });
    await setup(cfg, view);
    const g = await run('gap', cfg.methods || ['hybrid']);
    out.gap.push({ view: view.name, cfg: cfg.name, results: g?.results ?? g });
  }
  await page.evaluate((o) => { window.__perf = o; window.__ppp.freeze = false; }, out);
  return out;
}
