// 壁登りの自動検証（Playwright。browser_run_code_unsafe の filename で実行。設定は climb_config.json）。
// { host, reclimb: [掘る場所…], reclimbOpts: { flat, aim, walk }, scenes: { 名前: climb_helpers の run のシナリオ } }
// 場所・場面ごとに新しいページを開き（前の穴が残らないように）、climb_helpers.js を読み込んで実行する。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/climb_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  await cfgPage.close();
  const ctx = await page.context().browser().newContext({ viewport: { width: 640, height: 400 } });
  const open = async () => {
    const p = await ctx.newPage();
    await p.goto(O.host + '/aquarium.html?' + Date.now());
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    await p.evaluate(async () => {
      await fetch('http://localhost:5173/docs/aquarium/tools/climb_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
    });
    return p;
  };
  const out = { reclimb: [], scenes: {} };
  for (const s of O.reclimb ?? []) {
    const p = await open();
    const r = await p.evaluate(([s, o]) => window.__ct.tunnelReclimb({ ...s, ...o }), [s, O.reclimbOpts ?? {}]);
    delete r.tr;
    out.reclimb.push(r);
    await p.close();
  }
  out.lateral = [];
  for (const s of O.lateral ?? []) {
    const p = await open();
    out.lateral.push(await p.evaluate((s) => window.__ct.tunnelLateral(s), s));
    await p.close();
  }
  for (const [name, sc] of Object.entries(O.scenes ?? {})) {
    const p = await open();
    const r = await p.evaluate((sc) => {
      const r = window.__ct.run(sc);
      const ys = r.trace.map((e) => e.p[1]);
      return { grabs: r.stats.grabs ?? null, mantles: r.stats.mantles ?? null, startY: ys[0], maxY: Math.max(...ys), end: r.end, state: r.state, climbMats: [...new Set(r.trace.filter((e) => e.cl).map((e) => e.mat))], climbNy: r.climbNy, camJump: r.camJump, camJumpAt: r.camJumpAt, hiddenFrac: r.hiddenFrac, blockers: r.blockers, still: r.trace.filter((e) => e.t >= (sc.stillFrom ?? 1e9) && e.t <= (sc.stillTo ?? -1)).map((e) => e.p), path: sc.detail ? r.trace.filter((e, i) => i % 2 === 1).map((e) => `${e.t} ${e.p.join(',')} ${e.st}`) : undefined };
    }, sc);
    out.scenes[name] = r;
    await p.close();
  }
  await ctx.close();
  return out;
}
